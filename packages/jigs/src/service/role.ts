// Which role this copy plays (ADR 0019): the current version is the factory;
// any other version drains, finishing the runs it started, and exits once it
// owns nothing. The role follows the registry's current version,
// read at boot, on every notification and on a slow poll behind them.

import type { ServiceRole } from "./role-state.ts";

/** What runs only while this copy is the current version. */
export interface RoleParts {
  stop(): Promise<void>;
}

export interface DrainReport {
  /** Live runs this version started and still drives. */
  owned: number;
  /** Jobs still waiting or locked on this version's task. */
  queued: number;
}

export interface RoleControllerDeps {
  version: string;
  currentVersion: () => Promise<string | null>;
  /** Whether this version has ever been current: only then does draining to nothing mean retiring. */
  wasEverCurrent: () => Promise<boolean>;
  /** Called on each notification that the current version changed; returns how to unsubscribe. */
  subscribe: (fire: () => void) => () => void;
  startFull: () => Promise<RoleParts>;
  /** One pass of draining: what this version still owns, after cancelling what outlived its cap. */
  drain: () => Promise<DrainReport>;
  onRole?: (role: ServiceRole, current: string | null) => void;
  exit: (reason: string) => void;
  setTimer: (fire: () => void, ms: number) => () => void;
  log: (line: string) => void;
  pollMs?: number;
  drainMs?: number;
}

/** How often the current version is re-read without a notification. */
export const ROLE_POLL_MS = 5_000;
/** How often a draining copy checks whether it owns anything still. */
export const DRAIN_MS = 30_000;

export interface RoleController {
  /** Re-read the current version now and act on a change. */
  refresh(): Promise<void>;
  /** One drain pass now, when draining. */
  drain(): Promise<void>;
  role(): ServiceRole | undefined;
  stop(): Promise<void>;
}

export function startRoleController(deps: RoleControllerDeps): RoleController {
  let role: ServiceRole | undefined;
  let current: string | null = null;
  let parts: RoleParts | undefined;
  let stopped = false;
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;
  let draining: Promise<void> | undefined;
  let cancelPoll = () => {};
  let cancelDrain = () => {};

  const roleFor = (currentVersion: string | null): ServiceRole =>
    currentVersion === deps.version ? "current" : "draining";

  async function takeRole(next: ServiceRole): Promise<void> {
    if (next === "current") {
      deps.log(`[service] version ${deps.version} is current`);
      parts = await deps.startFull();
      return;
    }
    deps.log(
      `[service] version ${deps.version} is draining${current === null ? "; no version is current" : `; version ${current} is current`}`,
    );
    const running = parts;
    parts = undefined;
    await running?.stop();
  }

  async function readRole(): Promise<void> {
    const seen = await deps.currentVersion();
    if (stopped) return;
    const next = roleFor(seen);
    const changed = next !== role || seen !== current;
    current = seen;
    if (!changed) return;
    const switched = next !== role;
    role = next;
    deps.onRole?.(role, current);
    if (switched) {
      await takeRole(next);
      if (!stopped) void drain();
    }
  }

  function refresh(): Promise<void> {
    if (refreshing !== undefined) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = readRole()
      .catch((error: unknown) => {
        deps.log(`[service] could not read the current version: ${String(error)}`);
      })
      .finally(() => {
        refreshing = undefined;
        if (refreshAgain && !stopped) {
          refreshAgain = false;
          void refresh();
        }
      });
    return refreshing;
  }

  async function drainPass(): Promise<void> {
    if (role !== "draining" || stopped) return;
    const report = await deps.drain();
    if (stopped || role !== "draining") return;
    if (report.owned > 0 || report.queued > 0) {
      deps.log(
        `[service] version ${deps.version} draining: ${report.owned} run(s) owned, ${report.queued} job(s) queued`,
      );
      return;
    }
    // A version that was never current is a copy someone started on purpose,
    // such as a smoke test, and is theirs to stop.
    if (!(await deps.wasEverCurrent())) return;
    deps.log(`[service] version ${deps.version} drained, exiting`);
    stopped = true;
    deps.exit(`version ${deps.version} drained`);
  }

  function drain(): Promise<void> {
    draining ??= drainPass()
      .catch((error: unknown) => {
        deps.log(`[service] drain check failed: ${String(error)}`);
      })
      .finally(() => {
        draining = undefined;
      });
    return draining;
  }

  const pollAgain = () => {
    if (stopped) return;
    cancelPoll = deps.setTimer(() => void refresh().then(pollAgain), deps.pollMs ?? ROLE_POLL_MS);
  };
  const drainAgain = () => {
    if (stopped) return;
    cancelDrain = deps.setTimer(() => void drain().then(drainAgain), deps.drainMs ?? DRAIN_MS);
  };

  const unsubscribe = deps.subscribe(() => void refresh());
  void refresh().then(() => {
    pollAgain();
    drainAgain();
  });

  return {
    refresh,
    drain,
    role: () => role,
    async stop() {
      stopped = true;
      cancelPoll();
      cancelDrain();
      unsubscribe();
      await refreshing;
      await draining;
      const running = parts;
      parts = undefined;
      await running?.stop();
    },
  };
}
