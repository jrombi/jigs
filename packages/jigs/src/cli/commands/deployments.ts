import { validateDeploymentVersion } from "../../config/deployment-version.ts";
import { currentFactoryContext } from "../../config/factory-context.ts";
import { JigsError } from "../../errors.ts";
import { FACTORY_ENVIRONMENT } from "../../providers/credentials.ts";
import type { DeploymentView } from "../../service/deployments/store.ts";
import type { RegistrySql } from "../../steps/runtime/registry.ts";
import { detail, formatTable, hint, layout, note } from "../output.ts";
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
const modules = async () => ({
  ...(await import("../../steps/runtime/registry.ts")),
  ...(await import("../../service/deployments/store.ts")),
});

async function withRegistry<T>(
  deps: DeploymentsDeps,
  action: (sql: RegistrySql, factory: string, m: Awaited<ReturnType<typeof modules>>) => Promise<T>,
): Promise<T> {
  const ctx = currentFactoryContext();
  const url = ctx.env("WORKFLOW_POSTGRES_URL");
  if (url === undefined) {
    throw new JigsError(
      "WORKFLOW_POSTGRES_URL is not set",
      `set it to this factory's World in ${FACTORY_ENVIRONMENT}`,
    );
  }
  const m = await modules();
  const sql = (deps.connect ?? ((value) => m.connectRegistry(value, { max: 1 })))(url);
  try {
    // A pipeline may make a version current before any copy has booted and
    // created the tables; the migration is idempotent.
    if (deps.connect === undefined) await m.ensureRegistry(sql);
    return await action(sql, ctx.slug, m);
  } finally {
    await sql.$client.end();
  }
}

/** `jigs deployments`: every version with its role, when it started and the runs it owns. */
export async function listDeployments(
  deps: DeploymentsDeps,
  options: { json?: boolean } = {},
): Promise<DeploymentView[]> {
  const now = deps.now ?? (() => new Date());
  const views = await withRegistry(deps, (sql, factory, m) =>
    m.listDeployments(sql, factory, now()),
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
      view.lastSeenAt === null ? "never" : `${age(view.lastSeenAt, now())} ago`,
      String(view.runs),
      view.pid === null ? "none" : `pid ${view.pid}${view.host === null ? "" : ` on ${view.host}`}`,
    ]),
  );
  const stale = views.some((view) => view.role === "gone" && view.runs === 0);
  for (const line of layout(
    table,
    stale
      ? hint("remove the versions with no process and no runs:", "pnpm exec jigs deployments prune")
      : [],
  ))
    deps.out(line);
  return views;
}

/** `jigs deployments current <version>`: make a version the factory. */
export async function makeCurrent(version: string, deps: DeploymentsDeps): Promise<void> {
  validateDeploymentVersion(version);
  const previous = await withRegistry(deps, (sql, factory, m) =>
    m.makeDeploymentCurrent(sql, factory, version),
  );
  const was =
    previous === null
      ? detail("no version was current")
      : previous === version
        ? detail("already was")
        : detail(`was ${previous}`);
  deps.out(`version ${version} is now current ${was}`);
  if (previous !== null && previous !== version)
    deps.out(
      note(`version ${previous} drains: it hands its parked runs over and exits once it owns none`),
    );
}

/** `jigs deployments prune`: forget versions with no process and no runs. */
export async function pruneDeployments(deps: DeploymentsDeps): Promise<string[]> {
  const now = deps.now ?? (() => new Date());
  const removed = await withRegistry(deps, (sql, factory, m) =>
    m.pruneDeployments(sql, factory, now()),
  );
  if (removed.length === 0)
    deps.out("nothing to prune: every version is current, running or owns runs");
  for (const version of removed) deps.out(`removed version ${version}`);
  return removed;
}
