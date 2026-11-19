// A real run on the Postgres World of version v1, parked, handed to another
// version, and a wake sent by another process forwarded to the new owner's
// task; then adopted from a version with no process, queued job and all.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWorld } from "@workflow/world-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect } from "vitest";
import { start } from "workflow/api";
import { setWorld } from "workflow/runtime";
import {
  databaseUrl,
  dbTest,
  dropDatabaseOnceIdle,
  postgresAdminUrl,
} from "../../db-test-fixtures.ts";
import { connectRegistry, ensureRegistry, type RegistrySql } from "../../steps/runtime/registry.ts";
import {
  adoptRun,
  adoptRuns,
  forwardOwnedJobs,
  handOverParkedRuns,
  moveRun,
  ownedRunCount,
  parkedRuns,
  queuedJobCount,
} from "./hand-over.ts";
import { recordDeploymentBoot } from "./store.ts";

const database = `jigs_handover_${crypto.randomUUID().replaceAll("-", "")}`;
const url = databaseUrl(database).toString();
const admin = new Pool({ connectionString: postgresAdminUrl.toString(), max: 1 });
// Every delivery is acknowledged unread: the run only has to exist and park.
const server = createServer(async (req, res) => {
  await req.toArray();
  res.writeHead(200, { "content-type": "application/json" }).end("{}");
});

const WORKFLOW = "workflow//./workflows/respond//respond";
const PREFIX = "workflow_";
const v1 = { version: "v1", jobPrefix: PREFIX };
const v2 = { version: "v2", jobPrefix: PREFIX };
const v3 = { version: "v3", jobPrefix: PREFIX };
let world: ReturnType<typeof createWorld>;
let db: RegistrySql;
let oldBaseUrl: string | undefined;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  execFileSync("node_modules/.bin/bootstrap", [], {
    env: { ...process.env, WORKFLOW_POSTGRES_URL: url },
    stdio: "ignore",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  oldBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  world = createWorld({ connectionString: url, queueConcurrency: 1, jobPrefix: "workflow_v1_" });
  setWorld(world);
  await world.start();
  db = connectRegistry(url, { max: 2 });
  await ensureRegistry(db);
});

afterAll(async () => {
  await world?.close?.();
  setWorld(undefined);
  await db?.$client.end();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  if (oldBaseUrl === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL;
  else process.env.WORKFLOW_LOCAL_BASE_URL = oldBaseUrl;
  await dropDatabaseOnceIdle(admin, database);
  await admin.end();
});

const runRow = async (runId: string) =>
  (
    await db.$client.query<{ deployment_id: string; job_prefix: string }>(
      'select deployment_id, job_prefix from "workflow"."workflow_runs" where id = $1',
      [runId],
    )
  ).rows[0];

const jobsFor = async (runId: string) =>
  (
    await db.$client.query<{ task: string; locked_by: string | null }>(
      `select j.task_identifier as task, j.locked_by from graphile_worker.jobs j
       join graphile_worker._private_jobs b on b.id = j.id
       where position($1 in convert_from(decode(b.payload->>'data', 'base64'), 'UTF8')) > 0
       order by j.id`,
      [runId],
    )
  ).rows;

const untilParked = async (runId: string) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await parkedRuns(db, v1)).some((run) => run.runId === runId)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${runId} never parked`);
};

let runId: string;

dbTest(
  "a run v1's World starts is owned by v1 and parked once its start delivery is acknowledged",
  async () => {
    const run = await start({ workflowId: WORKFLOW }, [{ page: "P1", triggerId: "manual" }]);
    runId = run.runId;
    expect(await runRow(runId)).toEqual({ deployment_id: "postgres", job_prefix: "workflow_v1_" });

    await untilParked(runId);
    expect(await ownedRunCount(db, v1)).toBe(1);
    expect(await parkedRuns(db, v1)).toMatchObject([{ runId, workflowId: WORKFLOW, stepIds: [] }]);
  },
);

dbTest(
  "a run driven by a delivery lease is not parked, and is again once the lease is released",
  async () => {
    // A live lease owner: an unlocked job with attempts left. Any job will do for the check.
    const { rows } = await db.$client.query<{ id: string }>(
      `select (graphile_worker.add_job('jigs_test_lease_owner', '{}'::json)).id as id`,
    );
    const jobId = rows[0]?.id;
    await db.$client.query(
      'insert into "workflow"."workflow_run_delivery_leases" (run_id, owner_job_id) values ($1, $2)',
      [runId, jobId],
    );
    try {
      expect(await parkedRuns(db, v1)).toEqual([]);
      expect(await moveRun(db, { runId }, v1, v2)).toBe(false);
    } finally {
      await db.$client.query(
        'delete from "workflow"."workflow_run_delivery_leases" where run_id = $1',
        [runId],
      );
      await db.$client.query("select graphile_worker.complete_jobs(array[$1::bigint])", [jobId]);
    }
    expect(await parkedRuns(db, v1)).toHaveLength(1);
  },
);

dbTest(
  "the hand-over waits for the target's published IDs and skips runs the target lacks",
  async () => {
    const lines: string[] = [];
    const deps = { db, factory: "factory-a", jobPrefix: PREFIX, log: (l: string) => lines.push(l) };

    expect(await handOverParkedRuns(deps, v1, "v2")).toEqual({ moved: [], stranded: [] });
    expect(lines[0]).toContain("has not published its IDs yet");

    await recordDeploymentBoot(db, "factory-a", "v2", {
      pid: 1,
      host: "h",
      ids: ["workflow//./workflows/other//other"],
    });
    expect((await handOverParkedRuns(deps, v1, "v2")).stranded).toEqual([
      { runId, missing: [WORKFLOW] },
    ]);

    expect(await runRow(runId)).toMatchObject({ job_prefix: "workflow_v1_" });
  },
);

dbTest(
  "a handed-over run keeps its deployment, and a wake for it is forwarded to the new owner's task",
  async () => {
    await recordDeploymentBoot(db, "factory-a", "v2", { pid: 1, host: "h", ids: [WORKFLOW] });
    const deps = { db, factory: "factory-a", jobPrefix: PREFIX, log: () => {} };
    expect((await handOverParkedRuns(deps, v1, "v2")).moved).toEqual([runId]);
    // The SDK seeds a run's replay with its deployment, so only the owner changes.
    expect(await runRow(runId)).toEqual({ deployment_id: "postgres", job_prefix: "workflow_v2_" });
    expect(await ownedRunCount(db, v1)).toBe(0);
    expect(await ownedRunCount(db, v2)).toBe(1);

    // A wake sent by a process with no version, such as a script resuming a hook.
    await db.$client.query(
      `select graphile_worker.add_job('workflow_flows',
         json_build_object('data', encode(convert_to($1, 'UTF8'), 'base64')))`,
      [JSON.stringify({ runId })],
    );
    expect(await jobsFor(runId)).toEqual([{ task: "workflow_flows", locked_by: null }]);
    expect(await forwardOwnedJobs(db, v1)).toBe(0);
    expect(await forwardOwnedJobs(db, v2)).toBe(1);
    expect(await jobsFor(runId)).toEqual([{ task: "workflow_v2_flows", locked_by: null }]);
    expect(await queuedJobCount(db, v2)).toBe(1);
    expect(await queuedJobCount(db, v1)).toBe(0);
    // Not parked any more: a job waits for it.
    expect(await parkedRuns(db, v2)).toEqual([]);
  },
);

dbTest(
  "adopting a run from a version with no process moves its queued jobs to the new task, unlocked",
  async () => {
    await db.$client.query(
      "update graphile_worker._private_jobs set locked_at = now(), locked_by = 'dead-worker'",
    );
    expect(await adoptRun(db, { runId }, v2, v3)).toBe(true);
    expect(await runRow(runId)).toEqual({ deployment_id: "postgres", job_prefix: "workflow_v3_" });
    expect(await jobsFor(runId)).toEqual([{ task: "workflow_v3_flows", locked_by: null }]);
    expect(await queuedJobCount(db, v3)).toBe(1);
    expect(await adoptRun(db, { runId }, v2, v3)).toBe(false);
  },
);

dbTest("runs of a copy with no version are adopted too", async () => {
  await db.$client.query(`update "workflow"."workflow_runs" set job_prefix = null where id = $1`, [
    runId,
  ]);
  await recordDeploymentBoot(db, "factory-a", "v3", { pid: 1, host: "h", ids: [WORKFLOW] });
  const report = await adoptRuns(
    { db, factory: "factory-a", jobPrefix: PREFIX, log: () => {} },
    { version: null, jobPrefix: PREFIX },
    "v3",
  );
  expect(report.moved).toEqual([runId]);
  expect(await runRow(runId)).toEqual({ deployment_id: "postgres", job_prefix: "workflow_v3_" });
});
