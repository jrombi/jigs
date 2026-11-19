// Moving a parked run from one deployment version to another (ADR 0019): a
// run with no step executing, no delivery driving it and no job queued on its
// version's task loses nothing by changing owner, and its next wake then lands
// on the new owner's task.

import { sql } from "drizzle-orm";
import {
  deploymentJobPrefix,
  deploymentTasks,
  UNPINNED_DEPLOYMENT_ID,
} from "../../config/deployment-version.ts";
import type { RegistrySql } from "../../steps/runtime/registry.ts";
import { publishedIds } from "./store.ts";

/** A live run with nothing executing or queued for it. */
export interface ParkedRun {
  runId: string;
  workflowId: string;
  stepIds: string[];
  specVersion: number | null;
}

/** The runs the World pins to `version`, or to no version when `version` is null. */
export interface RunOwner {
  version: string | null;
  jobPrefix: string;
}

const LIVE = sql`r.status in ('pending', 'running')`;

// The World records a run of a copy with no version under its reserved unpinned id.
const ownedBy = (owner: RunOwner) =>
  sql`r.deployment_id = ${owner.version ?? UNPINNED_DEPLOYMENT_ID}`;

// Graphile stores the message body base64-encoded in the job payload, and the
// run id is ASCII inside it, whichever way the transport serialized the body.
const parked = (owner: RunOwner) => sql`
  not exists (select 1 from "workflow"."workflow_steps" a where a.run_id = r.id and a.status = 'running')
  and not exists (select 1 from "workflow"."workflow_run_delivery_leases" l where l.run_id = r.id)
  and not exists (
    select 1 from graphile_worker.jobs j
    join graphile_worker._private_jobs b on b.id = j.id
    where j.task_identifier = any(${sql.param(deploymentTasks(owner.jobPrefix, owner.version))}::text[])
      and position(r.id in convert_from(decode(b.payload->>'data', 'base64'), 'UTF8')) > 0
  )`;

/** Every parked run `owner` holds, oldest first. */
export async function parkedRuns(db: RegistrySql, owner: RunOwner): Promise<ParkedRun[]> {
  const { rows } = await db.execute<{
    runId: string;
    workflowId: string;
    stepIds: string[];
    specVersion: number | null;
  }>(sql`
    select r.id as "runId", r.name as "workflowId", r.spec_version as "specVersion",
      array_remove(array_agg(distinct s.step_name), null) as "stepIds"
    from "workflow"."workflow_runs" r
    left join "workflow"."workflow_steps" s on s.run_id = r.id
    where ${ownedBy(owner)} and ${LIVE} and ${parked(owner)}
    group by r.id
    order by r.created_at
  `);
  return rows;
}

/** Live runs `owner` holds, parked or not. */
export async function ownedRunCount(db: RegistrySql, owner: RunOwner): Promise<number> {
  const { rows } = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from "workflow"."workflow_runs" r where ${ownedBy(owner)} and ${LIVE}`,
  );
  return rows[0]?.count ?? 0;
}

/** Jobs waiting or locked on `owner`'s tasks, whichever run they are for. */
export async function queuedJobCount(db: RegistrySql, owner: RunOwner): Promise<number> {
  const { rows } = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from graphile_worker.jobs j
    where j.task_identifier = any(${sql.param(deploymentTasks(owner.jobPrefix, owner.version))}::text[])
  `);
  return rows[0]?.count ?? 0;
}

/**
 * Re-point one run at `to`, provided it is still parked and still `from`'s. One statement, so
 * the check and the change see one snapshot. True when the run moved.
 */
export async function moveRun(
  db: RegistrySql,
  run: Pick<ParkedRun, "runId">,
  from: RunOwner,
  to: { version: string; jobPrefix: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    update "workflow"."workflow_runs" r
    set deployment_id = ${to.version}, job_prefix = ${deploymentJobPrefix(to.jobPrefix, to.version)}
    where r.id = ${run.runId} and ${ownedBy(from)} and ${LIVE} and ${parked(from)}
  `);
  return result.rowCount === 1;
}

/** Which of a run's workflow and step IDs a build lacks. Only factory-local IDs: the SDK's own are its contract. */
export function missingIds(
  run: Pick<ParkedRun, "workflowId" | "stepIds">,
  built: ReadonlySet<string>,
): string[] {
  return [run.workflowId, ...run.stepIds].filter(
    (id) => /^(?:step|workflow)\/\/\.\//.test(id) && !built.has(id),
  );
}

export interface HandOverDeps {
  db: RegistrySql;
  factory: string;
  jobPrefix: string;
  /** Whether the run's workflow keeps its runs on the version that started them. */
  pinned: (workflowId: string) => boolean;
  log: (line: string) => void;
}

export interface HandOverReport {
  moved: string[];
  pinned: string[];
  /** Runs the target build cannot run, with what it lacks. */
  stranded: Array<{ runId: string; missing: string[] }>;
}

/**
 * Hand every parked run of `from` to the version `to`, skipping pinned workflows and runs whose
 * IDs `to`'s build has not published.
 */
export async function handOverParkedRuns(
  deps: HandOverDeps,
  from: RunOwner,
  to: string,
): Promise<HandOverReport> {
  const report: HandOverReport = { moved: [], pinned: [], stranded: [] };
  const runs = await parkedRuns(deps.db, from);
  if (runs.length === 0) return report;
  const ids = await publishedIds(deps.db, deps.factory, to);
  if (ids === null) {
    deps.log(
      `[service] version ${to} has not published its IDs yet; ${runs.length} parked run(s) stay on ${describe(from)}`,
    );
    return report;
  }
  const built = new Set(ids);
  for (const run of runs) {
    if (deps.pinned(run.workflowId)) {
      report.pinned.push(run.runId);
      continue;
    }
    const missing = missingIds(run, built);
    if (missing.length > 0) {
      report.stranded.push({ runId: run.runId, missing });
      deps.log(
        `[service] run ${run.runId} stays on ${describe(from)}: version ${to} lacks ${missing.join(", ")}`,
      );
      continue;
    }
    if (!(await moveRun(deps.db, run, from, { version: to, jobPrefix: deps.jobPrefix }))) continue;
    report.moved.push(run.runId);
    deps.log(`[service] run ${run.runId} handed over from ${describe(from)} to version ${to}`);
  }
  return report;
}

const describe = (owner: RunOwner) =>
  owner.version === null ? "no version" : `version ${owner.version}`;

/** Every live run `owner` holds, parked or not. */
export async function liveRuns(db: RegistrySql, owner: RunOwner): Promise<ParkedRun[]> {
  const { rows } = await db.execute<{
    runId: string;
    workflowId: string;
    stepIds: string[];
    specVersion: number | null;
  }>(sql`
    select r.id as "runId", r.name as "workflowId", r.spec_version as "specVersion",
      array_remove(array_agg(distinct s.step_name), null) as "stepIds"
    from "workflow"."workflow_runs" r
    left join "workflow"."workflow_steps" s on s.run_id = r.id
    where ${ownedBy(owner)} and ${LIVE}
    group by r.id
    order by r.created_at
  `);
  return rows;
}

// A version with no process never consumes its task again, so a job left
// there is moved to the new owner's task, unlocked, as the delivery it was:
// the SDK then redelivers it there, the way it recovers any crashed worker's
// job. Graphile's private tables are the only place a job's task can change;
// the insert mirrors add_job's own registration of a task.
async function moveQueuedJobs(
  db: RegistrySql,
  runId: string,
  from: RunOwner,
  to: { version: string; jobPrefix: string },
): Promise<void> {
  const fromTasks = deploymentTasks(from.jobPrefix, from.version);
  const toTasks = deploymentTasks(to.jobPrefix, to.version);
  for (const [index, fromTask] of fromTasks.entries()) {
    const toTask = toTasks[index];
    await db.execute(
      sql`insert into graphile_worker._private_tasks (identifier) values (${toTask}) on conflict do nothing`,
    );
    await db.execute(sql`
      update graphile_worker._private_jobs j
      set task_id = target.id, locked_at = null, locked_by = null, updated_at = now()
      from graphile_worker._private_tasks target, graphile_worker._private_tasks source
      where target.identifier = ${toTask} and source.identifier = ${fromTask}
        and j.task_id = source.id
        and position(${runId} in convert_from(decode(j.payload->>'data', 'base64'), 'UTF8')) > 0
    `);
  }
}

/**
 * Take over one run of an owner whose process is gone, its queued jobs with it. Nothing of the
 * owner's can be executing, so the run is not required to be parked. True when the run moved.
 */
export async function adoptRun(
  db: RegistrySql,
  run: Pick<ParkedRun, "runId">,
  from: RunOwner,
  to: { version: string; jobPrefix: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const locked = tx as unknown as RegistrySql;
    await moveQueuedJobs(locked, run.runId, from, to);
    const result = await locked.execute(sql`
      update "workflow"."workflow_runs" r
      set deployment_id = ${to.version}, job_prefix = ${deploymentJobPrefix(to.jobPrefix, to.version)}
      where r.id = ${run.runId} and ${ownedBy(from)} and ${LIVE}
    `);
    return result.rowCount === 1;
  });
}

/**
 * Adopt every live run of `from`, a version with no process or no version at all, into `to`,
 * with the same pinned-workflow and published-ID checks as a hand-over.
 */
export async function adoptRuns(
  deps: HandOverDeps,
  from: RunOwner,
  to: string,
): Promise<HandOverReport> {
  const report: HandOverReport = { moved: [], pinned: [], stranded: [] };
  const runs = await liveRuns(deps.db, from);
  if (runs.length === 0) return report;
  const ids = await publishedIds(deps.db, deps.factory, to);
  if (ids === null) return report;
  const built = new Set(ids);
  for (const run of runs) {
    if (deps.pinned(run.workflowId)) {
      report.pinned.push(run.runId);
      continue;
    }
    const missing = missingIds(run, built);
    if (missing.length > 0) {
      report.stranded.push({ runId: run.runId, missing });
      deps.log(
        `[service] run ${run.runId} stays on ${describe(from)}: version ${to} lacks ${missing.join(", ")}`,
      );
      continue;
    }
    if (!(await adoptRun(deps.db, run, from, { version: to, jobPrefix: deps.jobPrefix }))) continue;
    report.moved.push(run.runId);
    deps.log(`[service] run ${run.runId} adopted from ${describe(from)} by version ${to}`);
  }
  return report;
}
