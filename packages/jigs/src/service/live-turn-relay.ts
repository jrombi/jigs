// A reply or a stop for a live turn that runs in another copy (ADR 0019). The
// copy that received the event leaves it here and notifies; the copy holding
// the turn takes it, injects or stops exactly as the local path does, and
// marks it taken. The sender waits a short grace for that mark before it
// treats the run as not listening.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { bigserial, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { type LiveTurn, liveTurn, liveTurnTokens } from "../steps/agents/shared/live-turns.ts";
import type { RegistrySql } from "../steps/runtime/registry.ts";
import type { ConversationMessage } from "../workflow/agents/conversation.ts";
import type { RegistryListener } from "./registry-listener.ts";

export const liveTurnMessages = pgTable(
  "jigs_live_turn_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    factory: text("factory").notNull(),
    token: text("token").notNull(),
    kind: text("kind").$type<"inject" | "stop">().notNull(),
    payload: jsonb("payload").$type<ConversationMessage>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    takenAt: timestamp("taken_at", { withTimezone: true }),
  },
  (table) => [index("jigs_live_turn_messages_token").on(table.factory, table.token)],
);

/** The Postgres channel a relayed message is announced on; the payload is the turn's token. */
export const LIVE_TURNS_CHANNEL = "jigs_live_turns";

/** How long the sender waits for another copy to take the message. */
export const RELAY_GRACE_MS = 5_000;
const RELAY_POLL_MS = 250;

export type RelayedMessage = { kind: "inject"; message: ConversationMessage } | { kind: "stop" };

/** Leave `relayed` for whichever copy holds the live turn `token`, and announce it. Returns the row's id. */
export async function leaveLiveTurnMessage(
  db: RegistrySql,
  factory: string,
  token: string,
  relayed: RelayedMessage,
): Promise<number> {
  const [row] = await db
    .insert(liveTurnMessages)
    .values({
      factory,
      token,
      kind: relayed.kind,
      payload: relayed.kind === "inject" ? relayed.message : null,
    })
    .returning({ id: liveTurnMessages.id });
  if (row === undefined) throw new Error("the live turn message was not recorded");
  await db.execute(sql`select pg_notify(${LIVE_TURNS_CHANNEL}, ${token})`);
  return row.id;
}

/**
 * Whether message `id` was taken within the grace. One that was not is withdrawn, so a copy
 * cannot take it later, after the person has been told the run is not listening.
 */
export async function awaitTaken(
  db: RegistrySql,
  id: number,
  options: { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.graceMs ?? RELAY_GRACE_MS);
  while (Date.now() < deadline) {
    if (await taken(db, id)) return true;
    await sleep(RELAY_POLL_MS);
  }
  const withdrawn = await db
    .delete(liveTurnMessages)
    .where(and(eq(liveTurnMessages.id, id), isNull(liveTurnMessages.takenAt)))
    .returning({ id: liveTurnMessages.id });
  return withdrawn.length === 0;
}

async function taken(db: RegistrySql, id: number): Promise<boolean> {
  const rows = await db
    .select({ takenAt: liveTurnMessages.takenAt })
    .from(liveTurnMessages)
    .where(eq(liveTurnMessages.id, id));
  return rows[0]?.takenAt != null;
}

/** Take every untaken message for `token` into `turn`, oldest first. Returns how many it took. */
export async function takeLiveTurnMessages(
  db: RegistrySql,
  factory: string,
  token: string,
  turn: LiveTurn,
): Promise<number> {
  const waiting = await db
    .select()
    .from(liveTurnMessages)
    .where(
      and(
        eq(liveTurnMessages.factory, factory),
        eq(liveTurnMessages.token, token),
        isNull(liveTurnMessages.takenAt),
      ),
    )
    .orderBy(asc(liveTurnMessages.id));
  let took = 0;
  for (const row of waiting) {
    const claimed = await db
      .update(liveTurnMessages)
      .set({ takenAt: sql`now()` })
      .where(and(eq(liveTurnMessages.id, row.id), isNull(liveTurnMessages.takenAt)))
      .returning({ id: liveTurnMessages.id });
    if (claimed.length === 0) continue;
    if (row.kind === "stop") turn.stop();
    else if (row.payload !== null) turn.inject(row.payload);
    took += 1;
  }
  return took;
}

export interface LiveTurnRelayDeps {
  listener: RegistryListener;
  db: () => RegistrySql;
  factory: string;
  liveTurn?: typeof liveTurn;
  liveTurnTokens?: typeof liveTurnTokens;
  log?: (line: string) => void;
}

/** Start taking relayed messages for the live turns of this copy, until stopped. */
export function startLiveTurnRelay(deps: LiveTurnRelayDeps): { stop: () => void } {
  const log = deps.log ?? ((line: string) => console.log(line));
  const held = deps.liveTurn ?? liveTurn;
  const take = async (token: string) => {
    const turn = held(token);
    if (turn === undefined) return;
    try {
      const took = await takeLiveTurnMessages(deps.db(), deps.factory, token, turn);
      if (took > 0) log(`[events] took ${took} relayed message(s) for ${token}`);
    } catch (error) {
      console.error(`[events] could not take relayed messages for ${token}: ${String(error)}`);
    }
  };
  const unsubscribe = deps.listener.subscribe(LIVE_TURNS_CHANNEL, (token) => void take(token), {
    // Whatever was announced while the connection was down waits in the table.
    onConnect: () => {
      for (const token of (deps.liveTurnTokens ?? liveTurnTokens)()) void take(token);
    },
  });
  return { stop: unsubscribe };
}
