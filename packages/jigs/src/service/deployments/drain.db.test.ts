// A real run on the Postgres World of version v1: owned by v1 alone, kept by
// v1 once v2 is current, and cancelled by v1 once it has drained past the cap.
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
import { cancelRun } from "../runs.ts";
import { drainPass, liveRunIds, ownedRunCount, queuedJobCount } from "./drain.ts";
import { makeDeploymentCurrent } from "./store.ts";

const database = `jigs_drain_${crypto.randomUUID().replaceAll("-", "")}`;
const url = databaseUrl(database).toString();
const admin = new Pool({ connectionString: postgresAdminUrl.toString(), max: 1 });
// Every delivery is acknowledged unread: the run only has to exist and stay live.
const server = createServer(async (req, res) => {
  await req.toArray();
  res.writeHead(200, { "content-type": "application/json" }).end("{}");
});

const FACTORY = "factory-a";
const WORKFLOW = "workflow//./workflows/respond//respond";
const PREFIX = "workflow_";
const v1 = { version: "v1", jobPrefix: PREFIX };
const v2 = { version: "v2", jobPrefix: PREFIX };
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
  world = createWorld({ connectionString: url, queueConcurrency: 1, deploymentId: "v1" });
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
    await db.$client.query<{ deployment_id: string; job_prefix: string; status: string }>(
      'select deployment_id, job_prefix, status from "workflow"."workflow_runs" where id = $1',
      [runId],
    )
  ).rows[0];

const untilNothingQueued = async () => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await queuedJobCount(db, v1)) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("v1's start delivery was never taken");
};

const drainDeps = (now: Date, cancelled: string[], lines: string[]) => ({
  db,
  factory: FACTORY,
  owner: v1,
  maxDrainDays: 14,
  cancel: async (runId: string) => {
    cancelled.push(runId);
    await cancelRun(runId);
  },
  log: (line: string) => lines.push(line),
  now: () => now,
});

let runId: string;

dbTest("a run v1's World starts is pinned to v1 and owned by v1 alone", async () => {
  const run = await start({ workflowId: WORKFLOW }, [{ page: "P1", triggerId: "manual" }]);
  runId = run.runId;
  expect(await runRow(runId)).toMatchObject({ deployment_id: "v1", job_prefix: "workflow_v1_" });

  await untilNothingQueued();
  expect(await ownedRunCount(db, v1)).toBe(1);
  expect(await liveRunIds(db, v1)).toEqual([runId]);
  expect(await ownedRunCount(db, v2)).toBe(0);
});

dbTest("within the cap, a draining v1 keeps its run and reports it", async () => {
  await makeDeploymentCurrent(db, FACTORY, "v1");
  await makeDeploymentCurrent(db, FACTORY, "v2");
  const cancelled: string[] = [];
  const report = await drainPass(drainDeps(new Date(), cancelled, []));
  expect(report).toEqual({ owned: 1, queued: 0 });
  expect(cancelled).toEqual([]);
});

dbTest("past the cap, v1 cancels its run, logs it and owns nothing", async () => {
  const later = new Date(Date.now() + 15 * 86_400_000);
  const cancelled: string[] = [];
  const lines: string[] = [];
  await drainPass(drainDeps(later, cancelled, lines));
  expect(cancelled).toEqual([runId]);
  expect(lines).toEqual([
    `[service] run ${runId} cancelled: version v1 has drained for 14 day(s), the factory's limit`,
  ]);
  expect((await runRow(runId))?.status).toBe("cancelled");
  expect(await ownedRunCount(db, v1)).toBe(0);
});

// v2 has no worker here, so its jobs stay exactly as added.
const addV2Job = (key: string, runAt: Date) =>
  db.$client.query(
    `select graphile_worker.add_job('workflow_v2_flows', '{}'::json, run_at => $1::timestamptz, job_key => $2)`,
    [runAt.toISOString(), key],
  );

const useUpAttempts = (key: string) =>
  db.$client.query(
    "update graphile_worker._private_jobs set attempts = max_attempts where key = $1",
    [key],
  );

const removeJob = (key: string) =>
  db.$client.query("delete from graphile_worker._private_jobs where key = $1", [key]);

const lockOnLastAttempt = (key: string) =>
  db.$client.query(
    "update graphile_worker._private_jobs set attempts = max_attempts, locked_at = now(), locked_by = 'test' where key = $1",
    [key],
  );

dbTest("a job running its last attempt holds a drain", async () => {
  await addV2Job("v2-last-attempt", new Date());
  await lockOnLastAttempt("v2-last-attempt");
  expect(await queuedJobCount(db, v2)).toBe(1);
  await removeJob("v2-last-attempt");
});

dbTest("a timer due later and a job with no attempts left do not hold a drain", async () => {
  await addV2Job("v2-sleep-wake-up", new Date(Date.now() + 86_400_000));
  await addV2Job("v2-dead", new Date());
  await useUpAttempts("v2-dead");
  expect(await queuedJobCount(db, v2)).toBe(0);

  await addV2Job("v2-due", new Date());
  expect(await queuedJobCount(db, v2)).toBe(1);
});
