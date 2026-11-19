/**
 * Host a factory: its HTTP routes, and the long-running work that starts and settles its runs.
 *
 * @packageDocumentation
 */

import {
  configuredDeploymentVersion,
  configuredJobPrefix,
  WORLD_DEPLOYMENT_VARIABLE,
} from "../config/deployment-version.ts";
import { resolveService } from "../config/factory-config.ts";
import { currentFactoryContext, seedFactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import type { Factory, FactoryDefinition } from "../workflow/factory.ts";
import { parseFactoryConfig } from "../workflow/factory-schema.ts";
import { activeFactory } from "./active.ts";
import { startWorld } from "./boot.ts";
import { deploymentVersion, setDeploymentVersion } from "./role-state.ts";
import { runAsOnlyCopy, runAsVersion } from "./versioned.ts";

export { type AppDeps, createApp } from "./app.ts";
/** @internal */
export { automaticReleaseAction, reconcileAutomaticRelease } from "./automatic-release.ts";

/**
 * Point Nitro and the World at `JIGS_SERVICE_PORT`, or exit naming a missing port variable. Call
 * it at the top level of the service's Nitro plugin, after the factory configuration has loaded
 * its environment and before Nitro reads `PORT` to listen.
 */
export function listenOnServicePort(): void {
  try {
    const { port, serviceUrl } = resolveService(currentFactoryContext());
    // biome-ignore lint/style/noProcessEnv: Nitro's own listen port, derived from the factory's
    process.env.PORT = String(port);
    // Pins every queue worker, the dashboard's included, to this service's own workflow routes.
    // Left unset the World guesses a port the process listens on, and a job delivered to the
    // dashboard's port dies after three 404s.
    // biome-ignore lint/style/noProcessEnv: the SDK's own setting, derived from the factory's
    process.env.WORKFLOW_LOCAL_BASE_URL = serviceUrl;
  } catch (err) {
    if (!(err instanceof JigsError)) throw err;
    console.error(`[service] ${err.message}`);
    process.exit(1);
  }
}

/**
 * Pin the World to this copy's deployment version, `JIGS_DEPLOYMENT_VERSION`, when it has one, or
 * exit naming what is wrong with it. Call it at the top level of the service's Nitro plugin,
 * beside {@link listenOnServicePort}, before the World module is created.
 */
export function pinDeploymentVersion(): void {
  try {
    const ctx = currentFactoryContext();
    const version = configuredDeploymentVersion(ctx);
    if (version === undefined) return;
    // biome-ignore lint/style/noProcessEnv: the SDK's own setting, derived from the factory's
    process.env[WORLD_DEPLOYMENT_VARIABLE] = version;
    setDeploymentVersion(version, configuredJobPrefix(ctx));
  } catch (err) {
    if (!(err instanceof JigsError)) throw err;
    console.error(`[service] ${err.message}${err.hint === undefined ? "" : `\n${err.hint}`}`);
    process.exit(1);
  }
}

/**
 * Start everything the service runs beside its routes: the World behind its startup checks, then
 * the dashboard, schedules, event triggers, automatic release and the hub client. A copy with a
 * deployment version runs those only while its version is current, and drains otherwise. Call it
 * once, from the service's Nitro plugin, with the factory configuration the service was built
 * from.
 */
export function startService(factory: Factory, config: FactoryDefinition): void {
  seedFactoryContext(parseFactoryConfig(config));
  const live = activeFactory(factory);
  logInactive(factory, live);
  // Neither is awaited, the way Nitro runs separate plugins: the role waits
  // on the World's readiness itself.
  void startWorld(live);
  const run = deploymentVersion() === undefined ? runAsOnlyCopy : runAsVersion;
  void run(factory, live).catch((error: unknown) => {
    console.error(`[service] could not start the factory: ${String(error)}`);
    process.exit(1);
  });
}

function logInactive(factory: Factory, live: Factory): void {
  for (const name of Object.keys(factory.schedules ?? {}))
    if (live.schedules?.[name] === undefined) console.log(`[schedule] ${name} inactive`);
  for (const name of Object.keys(factory.triggers ?? {}))
    if (live.triggers?.[name] === undefined) console.log(`[trigger] ${name} inactive`);
}
