// What a draining deployment version still owns, and the cap on how long it
// may keep it (ADR 0019). A run stays on the version that started it until it
// ends: the SDK seeds a run's replay with its deployment, and the World runs a
// run only on that deployment's worker.

import { sql } from "drizzle-orm";
import { deploymentJobPrefix, deploymentTasks } from "../../config/deployment-version.ts";
import type { RegistrySql } from "../../steps/runtime/registry.ts";
import type { DrainReport } from "../role.ts";
import { drainingSince, LIVE_RUN } from "./store.ts";

/** A deployment version within the factory's World. */
export interface DeploymentOwner {
  version: string;
  /** The base job prefix every version of the factory shares. */
  jobPrefix: string;
}

// The World stamps each run with its deployment's job prefix, which, unlike the
// deployment id alone, is also distinct between factories sharing a database.
const ownedBy = (owner: DeploymentOwner) =>
  sql`r.job_prefix = ${deploymentJobPrefix(owner.jobPrefix, owner.version)}`;

/** The live runs `owner` started, oldest first. */
export async function liveRunIds(db: RegistrySql, owner: DeploymentOwner): Promise<string[]> {
  const { rows } = await db.execute<{ runId: string }>(sql`
    select r.id as "runId" from "workflow"."workflow_runs" r
    where ${ownedBy(owner)} and ${LIVE_RUN}
    order by r.created_at
  `);
  return rows.map((row) => row.runId);
}

/** How many live runs `owner` started. */
export async function ownedRunCount(db: RegistrySql, owner: DeploymentOwner): Promise<number> {
  const { rows } = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from "workflow"."workflow_runs" r where ${ownedBy(owner)} and ${LIVE_RUN}`,
  );
  return rows[0]?.count ?? 0;
}

/**
 * Jobs on `owner`'s tasks that can still do work: due now or being worked on, with attempts left.
 */
export async function queuedJobCount(db: RegistrySql, owner: DeploymentOwner): Promise<number> {
  const tasks = deploymentTasks(owner.jobPrefix, owner.version);
  // An ended run leaves its timers (a sleep's wake-up, up to a day out) and Graphile keeps a job
  // with no attempts left; a job due later matters only while its run is live, as ownedRunCount counts.
  const { rows } = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from graphile_worker.jobs j
    where j.task_identifier = any(${sql.param(tasks)}::text[])
      and j.attempts < j.max_attempts
      and (j.locked_at is not null or j.run_at <= now())
  `);
  return rows[0]?.count ?? 0;
}

const DAY_MS = 86_400_000;

/** Whether a version that stopped being current at `since` has drained for `maxDays` or longer. */
export function drainCapPassed(since: Date | null, maxDays: number, now: Date): boolean {
  return since !== null && now.getTime() - since.getTime() >= maxDays * DAY_MS;
}

export interface DrainDeps {
  db: RegistrySql;
  factory: string;
  owner: DeploymentOwner;
  /** The factory's `deployments.maxDrainDays`. */
  maxDrainDays: number;
  /** Cancel one run the way `jigs cancel` does. */
  cancel: (runId: string) => Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
}

/** One drain pass: cancel what outlived the cap, then report what the version still owns. */
export async function drainPass(deps: DrainDeps): Promise<DrainReport> {
  if (await outlivedDrainCap(deps)) await cancelOwnedRuns(deps);
  return {
    owned: await ownedRunCount(deps.db, deps.owner),
    queued: await queuedJobCount(deps.db, deps.owner),
  };
}

async function outlivedDrainCap(deps: DrainDeps): Promise<boolean> {
  const since = await drainingSince(deps.db, deps.factory, deps.owner.version);
  return drainCapPassed(since, deps.maxDrainDays, deps.now?.() ?? new Date());
}

async function cancelOwnedRuns(deps: DrainDeps): Promise<void> {
  const { version } = deps.owner;
  for (const runId of await liveRunIds(deps.db, deps.owner)) {
    try {
      await deps.cancel(runId);
      deps.log(
        `[service] run ${runId} cancelled: version ${version} has drained for ${deps.maxDrainDays} day(s), the factory's limit`,
      );
    } catch (error) {
      // A run can end between the listing and the cancel; the next pass retries any other failure.
      deps.log(`[service] could not cancel run ${runId}: ${String(error)}`);
    }
  }
}
