import { afterEach, expect, test, vi } from "vitest";
import { createRegistryListener, type ListenerClient } from "./registry-listener.ts";

function fakeClient() {
  const handlers = new Map<string, Array<(arg?: unknown) => void>>();
  const queries: string[] = [];
  const client: ListenerClient & { emit: (event: string, arg?: unknown) => void } = {
    connect: vi.fn(async () => {}),
    query: vi.fn(async (text: string) => {
      queries.push(text);
    }),
    end: vi.fn(async () => {}),
    on: ((event: string, handler: (arg?: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }) as ListenerClient["on"],
    emit: (event, arg) => {
      for (const handler of handlers.get(event) ?? []) handler(arg);
    },
  };
  return { client, queries };
}

afterEach(() => {
  vi.useRealTimers();
});

test("the first subscription opens the connection and listens; a notification reaches its channel's handlers", async () => {
  const fake = fakeClient();
  const listener = createRegistryListener({ connect: () => fake.client, log: () => {} });
  const seen: string[] = [];
  const connected = vi.fn();

  listener.subscribe("jigs_deployments", (payload) => seen.push(payload), { onConnect: connected });
  await vi.waitFor(() => expect(fake.queries).toEqual(['listen "jigs_deployments"']));
  expect(connected).toHaveBeenCalledOnce();

  fake.client.emit("notification", { channel: "jigs_deployments", payload: "acme" });
  fake.client.emit("notification", { channel: "other", payload: "ignored" });
  expect(seen).toEqual(["acme"]);

  await listener.close();
  expect(fake.client.end).toHaveBeenCalledOnce();
});

test("a lost connection is reopened, with every channel listened to again", async () => {
  const clients = [fakeClient(), fakeClient()];
  let opened = 0;
  const errors: string[] = [];
  const listener = createRegistryListener({
    connect: () => clients[opened++]?.client as ListenerClient,
    reconnectMs: 1,
    log: () => {},
    error: (line) => errors.push(line),
  });
  const connected = vi.fn();
  listener.subscribe("jigs_live_turns", () => {}, { onConnect: connected });
  await vi.waitFor(() => expect(clients[0]?.queries).toHaveLength(1));

  clients[0]?.client.emit("end");

  await vi.waitFor(() => expect(clients[1]?.queries).toEqual(['listen "jigs_live_turns"']));
  expect(connected).toHaveBeenCalledTimes(2);
  expect(errors[0]).toContain("reconnecting");
  await listener.close();
});
