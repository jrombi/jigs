import { configuredJobPrefix, validateDeploymentVersion } from "../../config/deployment-version.ts";
import { currentFactoryContext } from "../../config/factory-context.ts";
import { JigsError } from "../../errors.ts";
import { FACTORY_ENVIRONMENT } from "../../providers/credentials.ts";
import type { DeploymentOwner } from "../../service/deployments/drain.ts";
import type { DeploymentView } from "../../service/deployments/store.ts";
import type { RegistrySql } from "../../steps/runtime/registry.ts";
import { detail, formatTable, hint, layout, note } from "../output.ts";
import { cancelRun } from "./cancel.ts";
import { age } from "./run-list.ts";

// The versions of this factory as the registry records them, read from the
// World's database directly: the service may be draining, or not running at all.

export interface DeploymentsDeps {
  out: (line: string) => void;
  connect?: (url: string) => RegistrySql;
  now?: () => Date;
}

// Dynamic, like `resources`: the CLI bundle must not inline the registry's
// Postgres client into every verb.
const loadRegistryModules = async () => ({
  ...(await import("../../steps/runtime/registry.ts")),
  ...(await import("../../service/deployments/store.ts")),
  ...(await import("../../service/deployments/drain.ts")),
});

type RegistryModules = Awaited<ReturnType<typeof loadRegistryModules>>;

interface RegistryAccess {
  sql: RegistrySql;
  factory: string;
  jobPrefix: string;
  registry: RegistryModules;
}

async function withRegistry<T>(
  deps: DeploymentsDeps,
  action: (access: RegistryAccess) => Promise<T>,
): Promise<T> {
  const ctx = currentFactoryContext();
  const url = ctx.env("WORKFLOW_POSTGRES_URL");
  if (url === undefined) {
    throw new JigsError(
      "WORKFLOW_POSTGRES_URL is not set",
      `set it to this factory's World in ${FACTORY_ENVIRONMENT}`,
    );
  }
  const registry = await loadRegistryModules();
  const sql = connectToRegistry(url, deps, registry);
  try {
    // A pipeline may make a version current before any copy has booted and
    // created the tables; the migration is idempotent.
    if (deps.connect === undefined) await registry.ensureRegistry(sql);
    return await action({ sql, factory: ctx.slug, jobPrefix: configuredJobPrefix(ctx), registry });
  } finally {
    await sql.$client.end();
  }
}

function connectToRegistry(
  url: string,
  deps: DeploymentsDeps,
  registry: RegistryModules,
): RegistrySql {
  if (deps.connect !== undefined) return deps.connect(url);
  return registry.connectRegistry(url, { max: 1 });
}

const clockOf = (deps: DeploymentsDeps) => deps.now ?? (() => new Date());

/** `jigs deployments`: every version with its role, when it started and the runs it owns. */
export async function listDeployments(
  deps: DeploymentsDeps,
  options: { json?: boolean } = {},
): Promise<DeploymentView[]> {
  const now = clockOf(deps);
  const views = await withRegistry(deps, ({ sql, factory, jobPrefix, registry }) =>
    registry.listDeployments(sql, factory, jobPrefix, now()),
  );
  if (options.json === true) {
    deps.out(JSON.stringify({ deployments: views }, null, 2));
    return views;
  }
  if (views.length === 0) {
    deps.out("no versions have run yet");
    return views;
  }
  const table = formatTable(
    ["VERSION", "ROLE", "STARTED", "SEEN", "RUNS", "PROCESS"],
    views.map((view) => [
      view.version,
      view.role,
      `${age(view.startedAt, now())} ago`,
      lastSeenLabel(view, now()),
      String(view.runs),
      processLabel(view),
    ]),
  );
  for (const line of layout(table, ...listingHints(views))) deps.out(line);
  return views;
}

function lastSeenLabel(view: DeploymentView, now: Date): string {
  if (view.lastSeenAt === null) return "never";
  return `${age(view.lastSeenAt, now)} ago`;
}

function processLabel(view: DeploymentView): string {
  if (!view.running || view.pid === null) return "none";
  if (view.host === null) return `pid ${view.pid}`;
  return `pid ${view.pid} on ${view.host}`;
}

function listingHints(views: DeploymentView[]): string[][] {
  const hints: string[][] = [];
  const currentWithoutProcess = views.find((view) => view.role === "current" && !view.running);
  if (currentWithoutProcess !== undefined) {
    const { version } = currentWithoutProcess;
    hints.push([
      `version ${version} is current but has no running process: no copy is the factory until it runs again`,
    ]);
  }
  if (views.some((view) => view.role === "gone" && view.runs === 0)) {
    hints.push(
      hint("remove the versions with no process and no runs:", "pnpm exec jigs deployments prune"),
    );
  }
  return hints;
}

/**
 * `jigs deployments current <version>`: make a version the factory. A version with no running
 * process is refused unless `force`, since the one current now would drain and leave no factory.
 */
export async function makeCurrent(
  version: string,
  deps: DeploymentsDeps,
  options: { force?: boolean } = {},
): Promise<void> {
  validateDeploymentVersion(version, configuredJobPrefix(currentFactoryContext()));
  const now = clockOf(deps);
  const previous = await withRegistry(deps, async ({ sql, factory, registry }) => {
    if (options.force !== true) {
      const running = await registry.deploymentRunning(sql, factory, version, now());
      if (!running) throw notRunning(version);
    }
    return registry.makeDeploymentCurrent(sql, factory, version);
  });
  deps.out(`version ${version} is now current ${detail(whatWasCurrent(previous, version))}`);
  if (previous !== null && previous !== version) {
    deps.out(
      note(
        `version ${previous} drains: it finishes the runs it started and exits once it owns none`,
      ),
    );
  }
}

function notRunning(version: string): JigsError {
  return new JigsError(
    `version ${version} has no running process`,
    `start a copy with JIGS_DEPLOYMENT_VERSION=${version} first, then make it current; --force makes it current anyway`,
  );
}

function whatWasCurrent(previous: string | null, version: string): string {
  if (previous === null) return "no version was current";
  if (previous === version) return "already was";
  return `was ${previous}`;
}

export interface PruneDeps extends DeploymentsDeps {
  /** Where `--cancel-runs` cancels a run: the current version's service. */
  serviceUrl: string;
  cancel?: (runId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** How long `--cancel-runs` waits for cancelled runs to end before it prunes. */
  cancelWaitMs?: number;
}

/** How long `--cancel-runs` waits, by default, for the runs it cancelled to end. */
export const CANCEL_WAIT_MS = 30_000;
const CANCEL_POLL_MS = 500;

interface CancelFailure {
  runId: string;
  reason: string;
}

/**
 * `jigs deployments prune`: forget versions with no process and no runs. A version with no
 * process that still owns runs is kept, since its runs finish only on it, unless `cancelRuns`
 * cancels them first.
 */
export async function pruneDeployments(
  deps: PruneDeps,
  options: { cancelRuns?: boolean } = {},
): Promise<string[]> {
  const now = clockOf(deps);
  const { removed, kept, failures } = await withRegistry(deps, async (access) => {
    let cancelFailures: CancelFailure[] = [];
    if (options.cancelRuns === true) {
      cancelFailures = await cancelAbandonedRuns(access, deps, now());
    }
    const { sql, factory, jobPrefix, registry } = access;
    const prunedVersions = await registry.pruneDeployments(sql, factory, jobPrefix, now());
    const stillAbandoned = await abandonedVersions(access, now());
    return { removed: prunedVersions, kept: stillAbandoned, failures: cancelFailures };
  });
  for (const version of removed) deps.out(`removed version ${version}`);
  for (const failure of failures)
    deps.out(`could not cancel run ${failure.runId}: ${failure.reason}`);
  for (const view of kept)
    deps.out(`kept version ${view.version}: it has no process and owns ${view.runs} live run(s)`);
  if (kept.length > 0) {
    for (const line of keptHint(options.cancelRuns === true)) deps.out(line);
  } else if (removed.length === 0 && failures.length === 0) {
    deps.out("nothing to prune: every version is current or running");
  }
  return removed;
}

function keptHint(cancelledRuns: boolean): string[] {
  if (cancelledRuns) {
    return hint(
      "its runs have not ended yet; prune again once they have:",
      "pnpm exec jigs deployments prune --cancel-runs",
    );
  }
  return hint(
    "start that version again to finish its runs, or cancel them and prune it:",
    "pnpm exec jigs deployments prune --cancel-runs",
  );
}

// A version with no process whose runs only it can finish.
async function abandonedVersions(access: RegistryAccess, now: Date): Promise<DeploymentView[]> {
  const { sql, factory, jobPrefix, registry } = access;
  const views = await registry.listDeployments(sql, factory, jobPrefix, now);
  return views.filter((view) => view.role === "gone" && view.runs > 0);
}

async function cancelAbandonedRuns(
  access: RegistryAccess,
  deps: PruneDeps,
  now: Date,
): Promise<CancelFailure[]> {
  const cancel = deps.cancel ?? cancelThroughService(deps);
  const owners = (await abandonedVersions(access, now)).map(
    (view): DeploymentOwner => ({ version: view.version, jobPrefix: access.jobPrefix }),
  );
  const failures: CancelFailure[] = [];
  for (const owner of owners) {
    for (const runId of await access.registry.liveRunIds(access.sql, owner)) {
      const failure = await tryCancel(cancel, runId);
      if (failure !== undefined) failures.push(failure);
    }
  }
  // The cancel request returns before the World records the run as ended.
  await untilOwnersHaveNoLiveRuns(access, owners, deps);
  return failures;
}

function cancelThroughService(deps: PruneDeps): (runId: string) => Promise<void> {
  return async (runId) => {
    await cancelRun(runId, { out: deps.out, serviceUrl: deps.serviceUrl, force: true });
  };
}

async function tryCancel(
  cancel: (runId: string) => Promise<void>,
  runId: string,
): Promise<CancelFailure | undefined> {
  try {
    await cancel(runId);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { runId, reason };
  }
}

async function untilOwnersHaveNoLiveRuns(
  access: RegistryAccess,
  owners: DeploymentOwner[],
  deps: PruneDeps,
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const polls = Math.ceil((deps.cancelWaitMs ?? CANCEL_WAIT_MS) / CANCEL_POLL_MS);
  for (let poll = 0; poll < polls; poll += 1) {
    if (!(await anyOwnsLiveRuns(access, owners))) return;
    await sleep(CANCEL_POLL_MS);
  }
}

async function anyOwnsLiveRuns(
  access: RegistryAccess,
  owners: DeploymentOwner[],
): Promise<boolean> {
  for (const owner of owners) {
    if ((await access.registry.ownedRunCount(access.sql, owner)) > 0) return true;
  }
  return false;
}
