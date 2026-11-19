// Which role this copy plays (ADR 0019): the current version is the factory;
// any other version drains, handing its parked runs to the current one, and
// exits once it owns nothing. The role follows the registry's current version,
// read at boot, on every notification and on a slow poll behind them.

import type { ServiceRole } from "./role-state.ts";

/** What runs only while this copy is the current version. */
export interface RoleParts {
  stop(): Promise<void>;
}

export interface DrainReport {
  /** Live runs still pinned to this version. */
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
  /** One pass of the role's housekeeping: a draining copy hands its parked runs over, a current one adopts. */
  housekeep: (role: ServiceRole, current: string | null) => Promise<DrainReport>;
  onRole?: (role: ServiceRole, current: string | null) => void;
  exit: (reason: string) => void;
  setTimer: (fire: () => void, ms: number) => () => void;
  log: (line: string) => void;
  pollMs?: number;
  housekeepMs?: number;
}

/** How often the current version is re-read without a notification. */
export const ROLE_POLL_MS = 5_000;
/** How often a copy hands over or adopts runs. */
export const HOUSEKEEP_MS = 30_000;

export interface RoleController {
  /** Re-read the current version now and act on a change. */
  refresh(): Promise<void>;
  /** One housekeeping pass now. */
  housekeep(): Promise<void>;
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
  let housekeeping: Promise<void> | undefined;
  let cancelPoll = () => {};
  let cancelHousekeep = () => {};

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
      if (!stopped) void housekeep();
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

  async function runHousekeeping(): Promise<void> {
    if (role === undefined || stopped) return;
    const report = await deps.housekeep(role, current);
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

  function housekeep(): Promise<void> {
    housekeeping ??= runHousekeeping()
      .catch((error: unknown) => {
        deps.log(`[service] housekeeping failed: ${String(error)}`);
      })
      .finally(() => {
        housekeeping = undefined;
      });
    return housekeeping;
  }

  const pollAgain = () => {
    if (stopped) return;
    cancelPoll = deps.setTimer(() => void refresh().then(pollAgain), deps.pollMs ?? ROLE_POLL_MS);
  };
  const housekeepAgain = () => {
    if (stopped) return;
    cancelHousekeep = deps.setTimer(
      () => void housekeep().then(housekeepAgain),
      deps.housekeepMs ?? HOUSEKEEP_MS,
    );
  };

  const unsubscribe = deps.subscribe(() => void refresh());
  void refresh().then(() => {
    pollAgain();
    housekeepAgain();
  });

  return {
    refresh,
    housekeep,
    role: () => role,
    async stop() {
      stopped = true;
      cancelPoll();
      cancelHousekeep();
      unsubscribe();
      await refreshing;
      await housekeeping;
      const running = parts;
      parts = undefined;
      await running?.stop();
    },
  };
}
