// One Postgres LISTEN connection per service, shared by everything that waits
// on a NOTIFY from another copy or a CLI command: a version made current, a
// live-turn message left for a turn running here (ADR 0019).

import { Client } from "pg";
import { currentFactoryContext } from "../config/factory-context.ts";

export type NotificationHandler = (payload: string) => void;

export interface Subscription {
  /** Fires after every connect and reconnect, so a subscriber can catch up on what it missed. */
  onConnect?: () => void;
}

export interface RegistryListener {
  subscribe(channel: string, handler: NotificationHandler, options?: Subscription): () => void;
  close(): Promise<void>;
}

export interface RegistryListenerDeps {
  connect?: () => ListenerClient;
  reconnectMs?: number;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** The part of a pg Client the listener uses, so tests can stand one in. */
export interface ListenerClient {
  connect(): Promise<void>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on(
    event: "notification",
    handler: (message: { channel: string; payload?: string }) => void,
  ): void;
  on(event: "error" | "end", handler: (error?: Error) => void): void;
}

const RECONNECT_MS = 5_000;

export function createRegistryListener(deps: RegistryListenerDeps = {}): RegistryListener {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const subscriptions = new Map<
    string,
    Set<{ handler: NotificationHandler; options: Subscription }>
  >();
  let client: ListenerClient | undefined;
  let connecting: Promise<void> | undefined;
  let closed = false;
  let reconnect: NodeJS.Timeout | undefined;

  const dispatch = (message: { channel: string; payload?: string }) => {
    for (const { handler } of subscriptions.get(message.channel) ?? []) {
      try {
        handler(message.payload ?? "");
      } catch (err) {
        error(`[registry] a ${message.channel} notification handler failed: ${String(err)}`);
      }
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnect !== undefined) return;
    reconnect = setTimeout(() => {
      reconnect = undefined;
      void ensureConnected();
    }, deps.reconnectMs ?? RECONNECT_MS);
    reconnect.unref?.();
  };

  const lost = (why: string) => {
    if (client === undefined) return;
    client = undefined;
    if (closed) return;
    error(`[registry] the notification connection ${why}; reconnecting`);
    scheduleReconnect();
  };

  async function connect(): Promise<void> {
    const next = (deps.connect ?? pgListenerClient)();
    next.on("error", (err) => lost(`failed: ${err?.message ?? "unknown error"}`));
    next.on("end", () => lost("ended"));
    next.on("notification", dispatch);
    await next.connect();
    for (const channel of subscriptions.keys()) await next.query(`listen ${quote(channel)}`);
    client = next;
    for (const set of subscriptions.values()) for (const { options } of set) options.onConnect?.();
  }

  function ensureConnected(): Promise<void> {
    if (closed || client !== undefined) return Promise.resolve();
    connecting ??= connect()
      .catch((err: unknown) => {
        error(`[registry] could not open the notification connection: ${String(err)}`);
        scheduleReconnect();
      })
      .finally(() => {
        connecting = undefined;
      });
    return connecting;
  }

  return {
    subscribe(channel, handler, options = {}) {
      const entry = { handler, options };
      const set = subscriptions.get(channel) ?? new Set();
      const first = set.size === 0;
      set.add(entry);
      subscriptions.set(channel, set);
      if (client !== undefined && first) {
        void client.query(`listen ${quote(channel)}`).catch((err: unknown) => {
          error(`[registry] could not listen on ${channel}: ${String(err)}`);
        });
      }
      void ensureConnected().then(() => {
        if (client !== undefined && !first) options.onConnect?.();
      });
      return () => {
        set.delete(entry);
      };
    },
    async close() {
      closed = true;
      if (reconnect !== undefined) clearTimeout(reconnect);
      await connecting;
      const open = client;
      client = undefined;
      if (open === undefined) return;
      await open.end().catch(() => undefined);
      log("[registry] notification connection closed");
    },
  };
}

// Channel names are identifiers; quoting keeps a slug with a hyphen valid.
const quote = (channel: string) => `"${channel.replaceAll('"', '""')}"`;

function pgListenerClient(): ListenerClient {
  const url = currentFactoryContext().env("WORKFLOW_POSTGRES_URL");
  if (url === undefined) throw new Error("WORKFLOW_POSTGRES_URL is not set");
  return new Client({ connectionString: url }) as unknown as ListenerClient;
}

// One per process, opened on the first subscription and closed by the service's shutdown.
let shared: RegistryListener | undefined;

/** The service's notification connection. */
export function registryListener(): RegistryListener {
  shared ??= createRegistryListener();
  return shared;
}
