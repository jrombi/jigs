// The versions a factory has run and which one is current (ADR 0019). A row
// is one deployment version; `current` marks the one that is the factory,
// written only by `jigs deployments current`.

import { and, eq, sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { RegistrySql } from "../../steps/runtime/registry.ts";

// Keyed by factory like jigs_resources: several factories may share one database.
export const deployments = pgTable(
  "jigs_deployments",
  {
    factory: text("factory").notNull(),
    version: text("version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    // Refreshed by the running copy's heartbeat; null while no copy of the version has run.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    pid: integer("pid"),
    host: text("host"),
    // Every workflow and step ID the version's build has, so another version
    // can check a run fits before handing it over. Null until the copy boots.
    ids: jsonb("ids").$type<string[]>(),
    current: boolean("current").notNull().default(false),
    madeCurrentAt: timestamp("made_current_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.factory, table.version] })],
);

export type DeploymentRow = typeof deployments.$inferSelect;

/** The Postgres channel `jigs deployments current` notifies on; the payload is the factory slug. */
export const DEPLOYMENTS_CHANNEL = "jigs_deployments";

/** How long after its last heartbeat a version's process still counts as running. */
export const LIVE_WINDOW_MS = 60_000;

/** How often a running copy refreshes its heartbeat. */
export const HEARTBEAT_MS = 15_000;

export interface DeploymentProcess {
  pid: number;
  host: string;
  ids: string[];
}

/** A copy of `version` has booted: start its clock, its heartbeat and publish its IDs. */
export async function recordDeploymentBoot(
  db: RegistrySql,
  factory: string,
  version: string,
  process: DeploymentProcess,
): Promise<void> {
  const seen = { lastSeenAt: sql`now()`, pid: process.pid, host: process.host, ids: process.ids };
  await db
    .insert(deployments)
    .values({ factory, version, ...seen })
    .onConflictDoUpdate({
      target: [deployments.factory, deployments.version],
      set: { ...seen, startedAt: sql`now()`, updatedAt: sql`now()` },
    });
}

/** Refresh a running copy's heartbeat. */
export async function touchDeployment(
  db: RegistrySql,
  factory: string,
  version: string,
): Promise<void> {
  await db
    .update(deployments)
    .set({ lastSeenAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(deployments.factory, factory), eq(deployments.version, version)));
}

/** The factory's current version, or null while none has been made current. */
export async function currentDeployment(db: RegistrySql, factory: string): Promise<string | null> {
  const rows = await db
    .select({ version: deployments.version })
    .from(deployments)
    .where(and(eq(deployments.factory, factory), eq(deployments.current, true)));
  return rows[0]?.version ?? null;
}

/**
 * Make `version` the factory's current version, creating its row when no copy of it has booted
 * yet, and tell every listening copy. Returns the version that was current before, if any.
 */
export async function makeDeploymentCurrent(
  db: RegistrySql,
  factory: string,
  version: string,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const previous = await currentDeployment(tx as unknown as RegistrySql, factory);
    await tx
      .update(deployments)
      .set({ current: false, updatedAt: sql`now()` })
      .where(and(eq(deployments.factory, factory), eq(deployments.current, true)));
    await tx
      .insert(deployments)
      .values({ factory, version, current: true, madeCurrentAt: sql`now()` })
      .onConflictDoUpdate({
        target: [deployments.factory, deployments.version],
        set: { current: true, madeCurrentAt: sql`now()`, updatedAt: sql`now()` },
      });
    await tx.execute(sql`select pg_notify(${DEPLOYMENTS_CHANNEL}, ${factory})`);
    return previous;
  });
}

/** Whether `version` has ever been the factory's current version. */
export async function wasEverCurrent(
  db: RegistrySql,
  factory: string,
  version: string,
): Promise<boolean> {
  const rows = await db
    .select({ madeCurrentAt: deployments.madeCurrentAt })
    .from(deployments)
    .where(and(eq(deployments.factory, factory), eq(deployments.version, version)));
  return rows[0]?.madeCurrentAt != null;
}

/** The IDs the version's build published at boot, or null when no copy of it has booted. */
export async function publishedIds(
  db: RegistrySql,
  factory: string,
  version: string,
): Promise<string[] | null> {
  const rows = await db
    .select({ ids: deployments.ids })
    .from(deployments)
    .where(and(eq(deployments.factory, factory), eq(deployments.version, version)));
  return rows[0]?.ids ?? null;
}

export type DeploymentRole = "current" | "draining" | "gone";

/** One version as `jigs deployments` and `GET /api/deployments` show it. */
export interface DeploymentView {
  version: string;
  role: DeploymentRole;
  startedAt: string;
  lastSeenAt: string | null;
  madeCurrentAt: string | null;
  pid: number | null;
  host: string | null;
  /** The live runs the World pins to this version. */
  runs: number;
}

/** Whether a heartbeat this old still counts as a running process. */
export function seenRecently(lastSeenAt: Date | null, now: Date): boolean {
  return lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() < LIVE_WINDOW_MS;
}

export function roleOf(
  row: Pick<DeploymentRow, "current" | "lastSeenAt">,
  now: Date,
): DeploymentRole {
  if (row.current) return "current";
  return seenRecently(row.lastSeenAt, now) ? "draining" : "gone";
}

/** Every version the factory has run, newest start first, with the runs each still owns. */
export async function listDeployments(
  db: RegistrySql,
  factory: string,
  now: Date = new Date(),
): Promise<DeploymentView[]> {
  const rows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.factory, factory))
    .orderBy(sql`${deployments.startedAt} desc`);
  const owned = await ownedRunCounts(db);
  return rows.map((row) => ({
    version: row.version,
    role: roleOf(row, now),
    startedAt: row.startedAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    madeCurrentAt: row.madeCurrentAt?.toISOString() ?? null,
    pid: row.pid,
    host: row.host,
    runs: owned.get(row.version) ?? 0,
  }));
}

// The World's own table: a run's `deployment_id` is the version that owns it.
async function ownedRunCounts(db: RegistrySql): Promise<Map<string, number>> {
  const { rows } = await db.execute<{ version: string; runs: number }>(sql`
    select deployment_id as version, count(*)::int as runs
    from "workflow"."workflow_runs"
    where status in ('pending', 'running') and deployment_id is not null
    group by deployment_id
  `);
  return new Map(rows.map((row) => [row.version, row.runs]));
}

/** Remove every version that is not current, owns no run and has no running process. */
export async function pruneDeployments(
  db: RegistrySql,
  factory: string,
  now: Date = new Date(),
): Promise<string[]> {
  const listed = await listDeployments(db, factory, now);
  const removable = listed.filter((view) => view.role === "gone" && view.runs === 0);
  for (const view of removable) {
    await db
      .delete(deployments)
      .where(and(eq(deployments.factory, factory), eq(deployments.version, view.version)));
  }
  return removable.map((view) => view.version);
}
