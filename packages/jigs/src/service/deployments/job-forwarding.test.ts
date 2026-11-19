import { expect, test, vi } from "vitest";
import { GRAPHILE_JOBS_CHANNEL, startJobForwarding } from "./job-forwarding.ts";

function harness(forward = vi.fn(async () => 0)) {
  const handlers = new Map<string, { handler: () => void; onConnect?: () => void }>();
  const timers: Array<() => void> = [];
  const lines: string[] = [];
  const forwarding = startJobForwarding({
    listener: {
      subscribe: (channel, handler, options) => {
        handlers.set(channel, { handler: () => handler(""), onConnect: options?.onConnect });
        return () => handlers.delete(channel);
      },
    },
    forward,
    setTimer: (fire) => {
      timers.push(fire);
      return () => timers.splice(timers.indexOf(fire), 1);
    },
    log: (line) => lines.push(line),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { forwarding, forward, handlers, timers, lines, settle };
}

test("a Graphile job notification, a reconnect and the poll each forward once", async () => {
  const { forward, handlers, timers, settle } = harness();
  const subscription = handlers.get(GRAPHILE_JOBS_CHANNEL);
  subscription?.handler();
  await settle();
  subscription?.onConnect?.();
  await settle();
  timers[0]?.();
  await settle();
  expect(forward).toHaveBeenCalledTimes(3);
});

test("notifications during a pass coalesce into one more pass", async () => {
  let finish = () => {};
  const forward = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        finish = () => resolve(0);
      }),
  );
  const { handlers, settle } = harness(forward);
  const notify = () => handlers.get(GRAPHILE_JOBS_CHANNEL)?.handler();
  notify();
  notify();
  notify();
  expect(forward).toHaveBeenCalledTimes(1);
  finish();
  await settle();
  expect(forward).toHaveBeenCalledTimes(2);
});

test("a failed pass is logged, and stopping unsubscribes and ends the poll", async () => {
  const { forwarding, handlers, timers, lines, settle } = harness(
    vi.fn(async () => {
      throw new Error("connection reset");
    }),
  );
  handlers.get(GRAPHILE_JOBS_CHANNEL)?.handler();
  await settle();
  expect(lines).toEqual(["[service] could not forward jobs: Error: connection reset"]);
  await forwarding.stop();
  expect(handlers.size).toBe(0);
  expect(timers).toHaveLength(0);
});
