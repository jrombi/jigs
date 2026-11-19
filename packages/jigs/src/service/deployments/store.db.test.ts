// The versions table on a real registry: boot, heartbeat, current, the
// notification `current` sends, the listing with owned runs, and prune.
import { execFileSync } from "node:child_process";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect } from "vitest";
import {
  databaseUrl,
  dbTest,
  dropDatabaseOnceIdle,
  postgresAdminUrl,
} from "../../db-test-fixtures.ts";
import { connectRegistry, ensureRegistry, type RegistrySql } from "../../steps/runtime/registry.ts";
import {
  currentDeployment,
  DEPLOYMENTS_CHANNEL,
  listDeployments,
  makeDeploymentCurrent,
  pruneDeployments,
  publishedIds,
  recordDeploymentBoot,
  touchDeployment,
  wasEverCurrent,
} from "./store.ts";

const database = `jigs_deployments_${crypto.randomUUID().replaceAll("-", "")}`;
const url = databaseUrl(database).toString();
const admin = new Pool({ connectionString: postgresAdminUrl.toString(), max: 1 });
let db: RegistrySql;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  // The listing counts runs in the World's own table.
  execFileSync("node_modules/.bin/bootstrap", [], {
    env: { ...process.env, WORKFLOW_POSTGRES_URL: url },
    stdio: "ignore",
  });
  db = connectRegistry(url, { max: 2 });
  await ensureRegistry(db);
});
afterAll(async () => {
  await db.$client.end();
  await dropDatabaseOnceIdle(admin, database);
  await admin.end();
});

const FACTORY = "factory-a";
const process_ = { pid: 4242, host: "box", ids: ["workflow//./workflows/a//a"] };

async function insertRun(id: string, deploymentId: string, status = "running") {
  await db.$client.query(
    `insert into "workflow"."workflow_runs" (id, name, status, deployment_id, created_at, updated_at)
     values ($1, 'workflow//./workflows/a//a', $2, $3, now(), now())`,
    [id, status, deploymentId],
  );
}

dbTest(
  "a booted version is listed as gone until made current, seen by its heartbeat, with its IDs published",
  async () => {
    await recordDeploymentBoot(db, FACTORY, "v1", process_);
    expect(await currentDeployment(db, FACTORY)).toBeNull();
    expect(await publishedIds(db, FACTORY, "v1")).toEqual(process_.ids);
    expect(await publishedIds(db, FACTORY, "v9")).toBeNull();

    const [listed] = await listDeployments(db, FACTORY);
    expect(listed).toMatchObject({
      version: "v1",
      role: "draining",
      pid: 4242,
      host: "box",
      runs: 0,
    });

    const later = new Date(Date.now() + 2 * 60_000);
    expect((await listDeployments(db, FACTORY, later))[0]?.role).toBe("gone");
    await touchDeployment(db, FACTORY, "v1");
    expect((await listDeployments(db, FACTORY))[0]?.role).toBe("draining");
  },
);

dbTest(
  "making a version current replaces the previous one, notifies the factory's channel and is remembered",
  async () => {
    const listener = new Client({ connectionString: url });
    await listener.connect();
    await listener.query(`listen "${DEPLOYMENTS_CHANNEL}"`);
    const notified = new Promise<string | undefined>((resolve) =>
      listener.once("notification", (message) => resolve(message.payload)),
    );
    try {
      expect(await makeDeploymentCurrent(db, FACTORY, "v1")).toBeNull();
      expect(await notified).toBe(FACTORY);
      expect(await currentDeployment(db, FACTORY)).toBe("v1");

      // A version made current before any copy of it booted gets its row here.
      expect(await makeDeploymentCurrent(db, FACTORY, "v2")).toBe("v1");
      expect(await currentDeployment(db, FACTORY)).toBe("v2");
      expect(await wasEverCurrent(db, FACTORY, "v1")).toBe(true);
      expect(await wasEverCurrent(db, FACTORY, "v2")).toBe(true);
      await recordDeploymentBoot(db, FACTORY, "v3", process_);
      expect(await wasEverCurrent(db, FACTORY, "v3")).toBe(false);
      expect(await currentDeployment(db, "factory-b")).toBeNull();
    } finally {
      await listener.end();
    }
  },
);

dbTest("the listing counts the live runs the World pins to each version", async () => {
  await insertRun("wrun_01STORE000000000000000000A", "v1");
  await insertRun("wrun_01STORE000000000000000000B", "v1", "pending");
  await insertRun("wrun_01STORE000000000000000000C", "v1", "completed");
  await insertRun("wrun_01STORE000000000000000000D", "v2");
  const byVersion = new Map(
    (await listDeployments(db, FACTORY)).map((view) => [view.version, view]),
  );
  expect(byVersion.get("v1")?.runs).toBe(2);
  expect(byVersion.get("v2")).toMatchObject({ role: "current", runs: 1 });
  expect(byVersion.get("v3")?.runs).toBe(0);
});

dbTest(
  "prune removes only versions that are gone and own nothing, never the current one",
  async () => {
    const later = new Date(Date.now() + 2 * 60_000);
    // v1: gone but owns runs. v2: current. v3: gone, owns nothing.
    expect(await pruneDeployments(db, FACTORY, later)).toEqual(["v3"]);
    expect((await listDeployments(db, FACTORY)).map((view) => view.version).sort()).toEqual([
      "v1",
      "v2",
    ]);
  },
);
