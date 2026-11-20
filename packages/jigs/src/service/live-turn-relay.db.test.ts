// The relay between copies on a real registry: a message left for a turn,
// announced over NOTIFY, taken by the copy that holds the turn, and withdrawn
// when none does within the grace.
import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect } from "vitest";
import {
  databaseUrl,
  dbTest,
  dropDatabaseOnceIdle,
  postgresAdminUrl,
} from "../db-test-fixtures.ts";
import type { LiveTurn } from "../steps/agents/shared/live-turns.ts";
import { connectRegistry, ensureRegistry, type RegistrySql } from "../steps/runtime/registry.ts";
import {
  awaitTaken,
  leaveLiveTurnMessage,
  startLiveTurnRelay,
  takeLiveTurnMessages,
} from "./live-turn-relay.ts";
import { createRegistryListener, type ListenerClient } from "./registry-listener.ts";

const database = `jigs_relay_${crypto.randomUUID().replaceAll("-", "")}`;
const url = databaseUrl(database).toString();
const admin = new Pool({ connectionString: postgresAdminUrl.toString(), max: 1 });
let db: RegistrySql;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  db = connectRegistry(url, { max: 2 });
  await ensureRegistry(db);
});
afterAll(async () => {
  await db.$client.end();
  await dropDatabaseOnceIdle(admin, database);
  await admin.end();
});

const TOKEN = "linear:session:acme:session-1";
const message = { uuid: "a1", author: "Ada", text: "and the tests?" };
const turn = () => {
  const injected: unknown[] = [];
  let stops = 0;
  const live: LiveTurn = {
    inject: (m) => {
      injected.push(m);
      return true;
    },
    stop: () => {
      stops += 1;
    },
  };
  return { live, injected, stops: () => stops };
};

dbTest("a message nobody takes within the grace is withdrawn", async () => {
  const id = await leaveLiveTurnMessage(db, "factory-a", TOKEN, { kind: "inject", message });
  expect(await awaitTaken(db, id, { graceMs: 300 })).toBe(false);
  expect(await takeLiveTurnMessages(db, "factory-a", TOKEN, turn().live)).toBe(0);
});

dbTest(
  "a message the turn's copy takes is injected or stops the turn, once, and reports taken",
  async () => {
    const held = turn();
    const reply = await leaveLiveTurnMessage(db, "factory-a", TOKEN, { kind: "inject", message });
    const stop = await leaveLiveTurnMessage(db, "factory-a", TOKEN, { kind: "stop" });
    await leaveLiveTurnMessage(db, "factory-b", TOKEN, { kind: "stop" });

    expect(await takeLiveTurnMessages(db, "factory-a", TOKEN, held.live)).toBe(2);
    expect(held.injected).toEqual([message]);
    expect(held.stops()).toBe(1);
    expect(await takeLiveTurnMessages(db, "factory-a", TOKEN, held.live)).toBe(0);
    expect(await awaitTaken(db, reply, { graceMs: 300 })).toBe(true);
    expect(await awaitTaken(db, stop, { graceMs: 300 })).toBe(true);
  },
);

dbTest(
  "the copy holding the turn hears the notification and takes the message before the sender's grace ends",
  async () => {
    const held = turn();
    const listener = createRegistryListener({
      connect: () => new Client({ connectionString: url }) as unknown as ListenerClient,
      log: () => {},
    });
    const relay = startLiveTurnRelay({
      listener,
      db: () => db,
      factory: "factory-a",
      liveTurn: (token) => (token === TOKEN ? held.live : undefined),
      liveTurnTokens: () => [TOKEN],
      log: () => {},
    });
    try {
      // The subscription has connected once the catch-up scan has run.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const id = await leaveLiveTurnMessage(db, "factory-a", TOKEN, { kind: "inject", message });
      expect(await awaitTaken(db, id, { graceMs: 5_000 })).toBe(true);
      expect(held.injected).toEqual([message]);
    } finally {
      relay.stop();
      await listener.close();
    }
  },
);
