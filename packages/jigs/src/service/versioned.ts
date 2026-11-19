// Run this copy as a deployment version (ADR 0019): record its boot, keep its
// heartbeat, follow the current version into the current or the draining role,
// and relay live-turn messages between copies.

import { hostname } from "node:os";
import { currentFactoryContext, type FactoryContext } from "../config/factory-context.ts";
import { hubConnection } from "../providers/hub.ts";
import { registrySql } from "../steps/runtime/registry.ts";
import type { Factory } from "../workflow/factory.ts";
import { startAutomaticRelease } from "./automatic-release.ts";
import { builtIds } from "./built-ids.ts";
import { startDashboard } from "./dashboard.ts";
import {
  adoptRuns,
  forwardOwnedJobs,
  handOverParkedRuns,
  ownedRunCount,
  queuedJobCount,
} from "./deployments/hand-over.ts";
import { startJobForwarding } from "./deployments/job-forwarding.ts";
import {
  currentDeployment,
  DEPLOYMENTS_CHANNEL,
  HEARTBEAT_MS,
  listDeployments,
  recordDeploymentBoot,
  touchDeployment,
  wasEverCurrent,
} from "./deployments/store.ts";
import { pushEvent, startTriggers, withdrawInactive } from "./event-triggers/runner.ts";
import { startHubClient } from "./hub-client.ts";
import { startLiveTurnRelay } from "./live-turn-relay.ts";
import { whenReady } from "./readiness.ts";
import { registryListener } from "./registry-listener.ts";
import { type RoleParts, startRoleController } from "./role.ts";
import {
  deploymentBasePrefix,
  deploymentVersion,
  type ServiceRole,
  setServiceRole,
} from "./role-state.ts";
import { startSchedules } from "./schedules.ts";
import { beginShutdown, onShutdown } from "./shutdown.ts";

const setTimer = (fire: () => void, ms: number) => {
  const timer = setTimeout(fire, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Once the World is ready, take this copy's role and keep it. `live` is the factory with only
 * its active triggers and schedules.
 */
export async function runAsVersion(factory: Factory, live: Factory): Promise<void> {
  await whenReady();
  const ctx = currentFactoryContext();
  const version = deploymentVersion();
  const jobPrefix = deploymentBasePrefix();
  if (version === undefined || jobPrefix === undefined)
    throw new Error("the deployment version was not pinned before boot");
  const db = registrySql();
  const { slug } = ctx;
  await recordDeploymentBoot(db, slug, version, {
    pid: process.pid,
    host: hostname(),
    ids: builtIds(factory),
  });
  const heartbeat = setInterval(() => {
    touchDeployment(db, slug, version).catch((error: unknown) => {
      console.error(`[service] heartbeat failed: ${String(error)}`);
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  onShutdown(() => clearInterval(heartbeat), { phase: "quiesce" });

  const listener = registryListener();
  onShutdown(() => listener.close());
  const relay = startLiveTurnRelay({ listener, db: registrySql, factory: slug });
  onShutdown(() => relay.stop(), { phase: "quiesce" });

  const own = { version, jobPrefix };
  const forwarding = startJobForwarding({
    listener,
    forward: () => forwardOwnedJobs(db, own),
    setTimer,
    log: console.log,
  });
  onShutdown(() => forwarding.stop(), { phase: "quiesce" });

  const controller = startRoleController({
    version,
    currentVersion: () => currentDeployment(db, slug),
    wasEverCurrent: () => wasEverCurrent(db, slug, version),
    subscribe: (fire) =>
      listener.subscribe(DEPLOYMENTS_CHANNEL, (payload) => {
        if (payload === slug) fire();
      }),
    startFull: () => startFullRole(factory, live, ctx),
    housekeep: async (role, current) => {
      const deps = { db, factory: slug, jobPrefix, log: console.log };
      if (role === "current") {
        await adoptAbandonedRuns(deps, version);
        return { owned: 0, queued: 0 };
      }
      if (current !== null) await handOverParkedRuns(deps, own, current);
      return { owned: await ownedRunCount(db, own), queued: await queuedJobCount(db, own) };
    },
    onRole: (role, current) => setServiceRole(role, current),
    exit: (reason) => beginShutdown(reason),
    setTimer,
    log: console.log,
  });
  onShutdown(() => controller.stop(), { phase: "quiesce" });
}

// A run of a version whose process is gone, or of a copy that had no version,
// would otherwise wait for a worker that never comes.
async function adoptAbandonedRuns(
  deps: Parameters<typeof adoptRuns>[0],
  version: string,
): Promise<void> {
  const gone = (await listDeployments(deps.db, deps.factory, deps.jobPrefix)).filter(
    (view) => view.role === "gone" && view.runs > 0,
  );
  for (const view of gone)
    await adoptRuns(deps, { version: view.version, jobPrefix: deps.jobPrefix }, version);
  await adoptRuns(deps, { version: null, jobPrefix: deps.jobPrefix }, version);
}

// Everything only the factory does: hearing the hub, firing triggers and
// schedules, releasing, and answering on the dashboard. Started on becoming
// current, stopped on ceasing to be.
async function startFullRole(
  factory: Factory,
  live: Factory,
  ctx: FactoryContext,
): Promise<RoleParts> {
  const inactive = Object.keys(factory.triggers ?? {}).filter(
    (name) => live.triggers?.[name] === undefined,
  );
  void withdrawInactive(inactive);
  const schedules = startSchedules(live);
  const triggers = startTriggers(live);
  const release = startAutomaticRelease(factory);
  const dashboard = await startDashboard();
  const hub = hubConnection(ctx);
  const client =
    hub === undefined
      ? undefined
      : startHubClient({ ...hub, route: { context: ctx, push: pushEvent } });
  return {
    async stop() {
      // The hub first, so no event is admitted into triggers that are stopping.
      await client?.stop();
      await triggers.stop();
      for (const job of schedules) job.stop();
      await release.stop();
      await dashboard.close();
    },
  };
}

export type { ServiceRole };
