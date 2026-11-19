// Moving a parked run from one deployment version to another (ADR 0019). A
// run keeps the deployment it started on, its home: the SDK seeds a run's
// replay with it, so changing it makes every replay diverge. What moves is the
// owner, the World's `job_prefix`: the version whose worker drives the run and
// recovers it on boot. Messages still address the home's task, so the owner
// forwards them to its own (see `forwardOwnedJobs`).

import { sql } from "drizzle-orm";
import { deploymentJobPrefix, deploymentTasks } from "../../config/deployment-version.ts";
import type { RegistrySql } from "../../steps/runtime/registry.ts";
import { publishedIds } from "./store.ts";

/** A live run with nothing executing or queued for it. */
export interface ParkedRun {
  runId: string;
  workflowId: string;
  stepIds: string[];
  specVersion: number | null;
}

/** The runs a version's worker drives, or a copy with no version's when `version` is null. */
export interface RunOwner {
  version: string | null;
  jobPrefix: string;
}

const LIVE = sql`r.status in ('pending', 'running')`;

const ownerPrefix = (owner: RunOwner) =>
  owner.version === null ? owner.jobPrefix : deploymentJobPrefix(owner.jobPrefix, owner.version);

// The World recovers a run with no prefix (one older than the column) into
// every copy, so it belongs to whichever copy has no version.
const ownedBy = (owner: RunOwner) =>
  owner.version === null
    ? sql`(r.job_prefix = ${owner.jobPrefix} or r.job_prefix is null)`
    : sql`r.job_prefix = ${ownerPrefix(owner)}`;

// Graphile stores the message body base64-encoded in the job payload, and the
// run id is ASCII inside it, whichever way the transport serialized the body.
const jobNamesRun = (job: string, runId: unknown) =>
  sql`position(convert_to(${runId}, 'UTF8') in decode(${sql.raw(job)}.payload->>'data', 'base64')) > 0`;

// A job on any task counts: a run's messages land on its home's task, whoever owns it.
const parked = sql`
  not exists (select 1 from "workflow"."workflow_steps" a where a.run_id = r.id and a.status = 'running')
  and not exists (select 1 from "workflow"."workflow_run_delivery_leases" l where l.run_id = r.id)
  and not exists (select 1 from graphile_worker._private_jobs b where ${jobNamesRun("b", sql`r.id`)})`;

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
    where ${ownedBy(owner)} and ${LIVE} and ${parked}
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
 * Make `to` the owner of one run, provided it is still parked and still `from`'s. One statement,
 * so the check and the change see one snapshot. True when the run moved.
 */
export async function moveRun(
  db: RegistrySql,
  run: Pick<ParkedRun, "runId">,
  from: RunOwner,
  to: { version: string; jobPrefix: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    update "workflow"."workflow_runs" r
    set job_prefix = ${deploymentJobPrefix(to.jobPrefix, to.version)}
    where r.id = ${run.runId} and ${ownedBy(from)} and ${LIVE} and ${parked}
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
  log: (line: string) => void;
}

export interface HandOverReport {
  moved: string[];
  /** Runs the target build cannot run, with what it lacks. */
  stranded: Array<{ runId: string; missing: string[] }>;
}

/**
 * Hand every parked run of `from` to the version `to`, skipping runs whose IDs `to`'s build has
 * not published.
 */
export async function handOverParkedRuns(
  deps: HandOverDeps,
  from: RunOwner,
  to: string,
): Promise<HandOverReport> {
  const report: HandOverReport = { moved: [], stranded: [] };
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
        and ${jobNamesRun("j", runId)}
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
      set job_prefix = ${deploymentJobPrefix(to.jobPrefix, to.version)}
      where r.id = ${run.runId} and ${ownedBy(from)} and ${LIVE}
    `);
    return result.rowCount === 1;
  });
}

/**
 * Adopt every live run of `from`, a version with no process or no version at all, into `to`,
 * with the same published-ID check as a hand-over.
 */
export async function adoptRuns(
  deps: HandOverDeps,
  from: RunOwner,
  to: string,
): Promise<HandOverReport> {
  const report: HandOverReport = { moved: [], stranded: [] };
  const runs = await liveRuns(deps.db, from);
  if (runs.length === 0) return report;
  const ids = await publishedIds(deps.db, deps.factory, to);
  if (ids === null) return report;
  const built = new Set(ids);
  for (const run of runs) {
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

/**
 * Move every waiting job for a run `owner` drives from another version's flows task to its own,
 * and return how many moved. A message for a run goes to its sender's task, which need not be the
 * owner's; a job some worker already locked is left to that worker.
 */
export async function forwardOwnedJobs(db: RegistrySql, owner: RunOwner): Promise<number> {
  const [ownFlows] = deploymentTasks(owner.jobPrefix, owner.version);
  await db.execute(
    sql`insert into graphile_worker._private_tasks (identifier) values (${ownFlows}) on conflict do nothing`,
  );
  const result = await db.execute(sql`
    update graphile_worker._private_jobs j
    set task_id = target.id, updated_at = now()
    from graphile_worker._private_tasks target, graphile_worker._private_tasks source
    where target.identifier = ${ownFlows}
      and j.task_id = source.id and source.identifier <> ${ownFlows}
      and starts_with(source.identifier, ${owner.jobPrefix}) and right(source.identifier, 5) = 'flows'
      and j.locked_at is null
      and exists (
        select 1 from "workflow"."workflow_runs" r
        where ${ownedBy(owner)} and ${LIVE} and ${jobNamesRun("j", sql`r.id`)}
      )
  `);
  return result.rowCount ?? 0;
}
