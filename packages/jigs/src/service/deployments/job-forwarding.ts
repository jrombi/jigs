// Keeping a version's handed-over runs moving (ADR 0019). Their messages land
// on the task of the version they started on; this copy moves them to its own
// task as soon as Graphile announces a new job, and on a slow poll behind that.

import type { RegistryListener } from "../registry-listener.ts";

/** Graphile Worker's own channel: every `add_job` notifies it. */
export const GRAPHILE_JOBS_CHANNEL = "jobs:insert";
/** How often jobs are forwarded without a notification. */
export const FORWARD_POLL_MS = 5_000;

export interface JobForwardingDeps {
  listener: Pick<RegistryListener, "subscribe">;
  /** One forwarding pass; returns how many jobs moved. */
  forward: () => Promise<number>;
  setTimer: (fire: () => void, ms: number) => () => void;
  log: (line: string) => void;
  pollMs?: number;
}

export interface JobForwarding {
  stop(): Promise<void>;
}

export function startJobForwarding(deps: JobForwardingDeps): JobForwarding {
  let stopped = false;
  let running: Promise<void> | undefined;
  let again = false;
  let cancelPoll = () => {};

  function forwardSoon(): void {
    if (stopped) return;
    if (running !== undefined) {
      again = true;
      return;
    }
    running = deps
      .forward()
      .then(() => undefined)
      .catch((error: unknown) => deps.log(`[service] could not forward jobs: ${String(error)}`))
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          forwardSoon();
        }
      });
  }

  const pollAgain = () => {
    if (stopped) return;
    cancelPoll = deps.setTimer(() => {
      forwardSoon();
      pollAgain();
    }, deps.pollMs ?? FORWARD_POLL_MS);
  };

  const unsubscribe = deps.listener.subscribe(GRAPHILE_JOBS_CHANNEL, forwardSoon, {
    onConnect: forwardSoon,
  });
  pollAgain();

  return {
    async stop() {
      stopped = true;
      cancelPoll();
      unsubscribe();
      await running;
    },
  };
}
