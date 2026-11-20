// A copy's deployment version (ADR 0019): the World's deployment id, so the
// Graphile tasks its queue worker claims and the deployment every run it
// starts finishes on. Hosted copies set it in their environment; a copy
// without one, such as the one `jigs up` runs, is the factory's only copy.

import { JigsError } from "../errors.ts";
import type { FactoryContext } from "./factory-context.ts";

/** The environment variable a copy's deployment version comes from. */
export const DEPLOYMENT_VERSION_VARIABLE = "JIGS_DEPLOYMENT_VERSION";

/** The World's deployment id, which jigs sets from the deployment version. */
export const WORLD_DEPLOYMENT_VARIABLE = "WORKFLOW_POSTGRES_DEPLOYMENT_ID";

/** The World's variable for the base of its Graphile task names. */
export const WORLD_JOB_PREFIX_VARIABLE = "WORKFLOW_POSTGRES_JOB_PREFIX";

// world-postgres's own rules: letters, digits, `.`, `-`, `_` and `@`; not its
// reserved unpinned id; and short enough that every Graphile name it builds
// from the version fits in 128 characters.
const VERSION_SHAPE = /^[A-Za-z0-9._@-]+$/;
/** The deployment id the World records on a run started by a copy with no version. */
export const UNPINNED_DEPLOYMENT_ID = "postgres";
const MAX_JOB_PREFIX_LENGTH = 128 - "flows:".length - "wrun_".length - 26 - ":executor".length;
export const DEFAULT_JOB_PREFIX = "workflow_";

/** The version unchanged, or a `JigsError` saying why the World would refuse it. */
export function validateDeploymentVersion(
  version: string,
  jobPrefix: string = DEFAULT_JOB_PREFIX,
): string {
  const reason = whyVersionIsUnusable(version, MAX_JOB_PREFIX_LENGTH - jobPrefix.length - 1);
  if (reason !== undefined) {
    throw new JigsError(
      `${DEPLOYMENT_VERSION_VARIABLE} ${JSON.stringify(version)} is not a usable deployment version: ${reason}`,
      "use an image tag or a short build identifier made of letters, digits, '.', '-' and '_'",
    );
  }
  return version;
}

function whyVersionIsUnusable(version: string, maxLength: number): string | undefined {
  if (version === "") return "it is empty";
  if (!VERSION_SHAPE.test(version)) return "it may only use letters, digits, '.', '-', '_' and '@'";
  if (version === UNPINNED_DEPLOYMENT_ID)
    return `"${UNPINNED_DEPLOYMENT_ID}" is reserved by the World`;
  if (version.length > maxLength) return `it is longer than ${maxLength} characters`;
  return undefined;
}

/**
 * This copy's deployment version from its environment, validated against the World's job prefix,
 * or undefined for a copy with none.
 */
export function configuredDeploymentVersion(ctx: FactoryContext): string | undefined {
  const version = ctx.env(DEPLOYMENT_VERSION_VARIABLE);
  const worldDeployment = ctx.env(WORLD_DEPLOYMENT_VARIABLE);
  if (worldDeployment !== undefined && worldDeployment !== version) {
    throw new JigsError(
      `${WORLD_DEPLOYMENT_VARIABLE} is set to ${JSON.stringify(worldDeployment)}`,
      `remove it and set ${DEPLOYMENT_VERSION_VARIABLE} instead: jigs sets the World's deployment from the version, and only a versioned copy drains`,
    );
  }
  if (version === undefined) return undefined;
  return validateDeploymentVersion(version, configuredJobPrefix(ctx));
}

/** The base the factory's versions build their Graphile task names from. */
export function configuredJobPrefix(ctx: FactoryContext): string {
  return ctx.env(WORLD_JOB_PREFIX_VARIABLE) ?? DEFAULT_JOB_PREFIX;
}

/** The `job_prefix` the World stamps on a version's runs. */
export function deploymentJobPrefix(jobPrefix: string, version: string): string {
  return `${jobPrefix}${version}_`;
}

/** The Graphile tasks a version's queue worker claims: its flows task and its executor lane. */
export function deploymentTasks(jobPrefix: string, version: string): string[] {
  const flows = `${deploymentJobPrefix(jobPrefix, version)}flows`;
  return [flows, `${flows}_executor`];
}
