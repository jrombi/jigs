import { expect, test, vi } from "vitest";
import { type RoleControllerDeps, startRoleController } from "./role.ts";

function harness(
  overrides: Partial<RoleControllerDeps> = {},
  initialCurrent: string | null = null,
) {
  let current: string | null = initialCurrent;
  let everCurrent = false;
  const timers: Array<{ fire: () => void; ms: number }> = [];
  const lines: string[] = [];
  const exits: string[] = [];
  const started: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  let fire: (() => void) | undefined;
  const housekeep = vi.fn(async () => ({ owned: 0, queued: 0 }));
  const deps: RoleControllerDeps = {
    version: "v1",
    currentVersion: async () => current,
    wasEverCurrent: async () => everCurrent,
    subscribe: (handler) => {
      fire = handler;
      return () => {
        fire = undefined;
      };
    },
    startFull: async () => {
      const parts = { stop: vi.fn(async () => {}) };
      started.push(parts);
      return parts;
    },
    housekeep,
    exit: (reason) => exits.push(reason),
    setTimer: (callback, ms) => {
      const timer = { fire: callback, ms };
      timers.push(timer);
      return () => {
        timers.splice(timers.indexOf(timer), 1);
      };
    },
    log: (line) => lines.push(line),
    ...overrides,
  };
  const controller = startRoleController(deps);
  return {
    controller,
    lines,
    exits,
    started,
    timers,
    housekeep,
    setCurrent: (version: string | null) => {
      current = version;
    },
    markEverCurrent: () => {
      everCurrent = true;
    },
    notify: () => fire?.(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a copy whose version is current runs the full role and houses-keeps at once", async () => {
  const h = harness();
  h.setCurrent("v1");
  await h.controller.refresh();
  await settle();

  expect(h.controller.role()).toBe("current");
  expect(h.started).toHaveLength(1);
  expect(h.housekeep).toHaveBeenCalledWith("current", "v1");
  expect(h.lines).toContain("[service] version v1 is current");
});

test("a copy that boots behind another version starts draining, and takes the full role when made current", async () => {
  const h = harness({}, "v0");
  await h.controller.refresh();

  expect(h.controller.role()).toBe("draining");
  expect(h.started).toHaveLength(0);
  expect(h.lines).toContain("[service] version v1 is draining; version v0 is current");

  h.setCurrent("v1");
  h.notify();
  await vi.waitFor(() => expect(h.controller.role()).toBe("current"));
  expect(h.started).toHaveLength(1);
});

test("a current copy superseded by another version stops its full role and drains", async () => {
  const h = harness();
  h.setCurrent("v1");
  await h.controller.refresh();
  h.markEverCurrent();
  h.housekeep.mockResolvedValue({ owned: 2, queued: 0 });

  h.setCurrent("v2");
  await h.controller.refresh();
  await settle();

  expect(h.started[0]?.stop).toHaveBeenCalledOnce();
  expect(h.controller.role()).toBe("draining");
  expect(h.housekeep).toHaveBeenLastCalledWith("draining", "v2");
  expect(h.lines).toContain("[service] version v1 draining: 2 run(s) owned, 0 job(s) queued");
  expect(h.exits).toEqual([]);
});

test("a draining copy that was current and owns nothing exits", async () => {
  const h = harness();
  h.setCurrent("v2");
  h.markEverCurrent();
  await h.controller.refresh();
  await settle();

  expect(h.lines).toContain("[service] version v1 drained, exiting");
  expect(h.exits).toEqual(["version v1 drained"]);
});

test("a draining copy that was never current stays up, for whoever started it", async () => {
  const h = harness();
  h.setCurrent("v2");
  await h.controller.refresh();
  await settle();

  expect(h.exits).toEqual([]);
  expect(h.lines).not.toContain("[service] version v1 drained, exiting");
});

test("the current version is re-read on a poll, and housekeeping runs on its own timer", async () => {
  const h = harness({ pollMs: 5_000, housekeepMs: 30_000 });
  h.setCurrent("v1");
  await h.controller.refresh();
  await vi.waitFor(() =>
    expect(h.timers.map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([5_000, 30_000]),
  );

  h.setCurrent("v2");
  h.timers.find((timer) => timer.ms === 5_000)?.fire();
  await vi.waitFor(() => expect(h.controller.role()).toBe("draining"));

  const before = h.housekeep.mock.calls.length;
  h.timers.find((timer) => timer.ms === 30_000)?.fire();
  await vi.waitFor(() => expect(h.housekeep.mock.calls.length).toBeGreaterThan(before));
});

test("stopping the controller stops the full role and cancels its timers", async () => {
  const h = harness();
  h.setCurrent("v1");
  await h.controller.refresh();
  await settle();

  await h.controller.stop();

  expect(h.started[0]?.stop).toHaveBeenCalledOnce();
  expect(h.timers).toEqual([]);
});
