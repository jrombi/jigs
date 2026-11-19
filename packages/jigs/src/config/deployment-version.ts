// A copy's deployment version: the World's deployment id for the runs the
// copy starts, and the Graphile task its queue worker claims (ADR 0019). Hosted copies set it in
// their environment; `jigs up` sets it from the built bundle's hash.

import { JigsError } from "../errors.ts";
import type { FactoryContext } from "./factory-context.ts";

/** The environment variable a copy's deployment version comes from. */
export const DEPLOYMENT_VERSION_VARIABLE = "JIGS_DEPLOYMENT_VERSION";

/** The World's own variable, which jigs sets from the version; a factory never sets it. */
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
  const maxLength = MAX_JOB_PREFIX_LENGTH - jobPrefix.length - 1;
  const reason =
    version === ""
      ? "it is empty"
      : !VERSION_SHAPE.test(version)
        ? "it may only use letters, digits, '.', '-', '_' and '@'"
        : version === UNPINNED_DEPLOYMENT_ID
          ? `"${UNPINNED_DEPLOYMENT_ID}" is reserved by the World`
          : version.length > maxLength
            ? `it is longer than ${maxLength} characters`
            : undefined;
  if (reason !== undefined) {
    throw new JigsError(
      `${DEPLOYMENT_VERSION_VARIABLE} ${JSON.stringify(version)} is not a usable deployment version: ${reason}`,
      "use an image tag or a short build identifier made of letters, digits, '.', '-' and '_'",
    );
  }
  return version;
}

/** This copy's deployment version from its environment, validated against the World's job prefix. */
export function configuredDeploymentVersion(ctx: FactoryContext): string {
  const version = ctx.env(DEPLOYMENT_VERSION_VARIABLE);
  if (version === undefined) {
    throw new JigsError(
      `${DEPLOYMENT_VERSION_VARIABLE} is not set`,
      "`jigs up` sets it for the service it starts\na copy started another way, such as a container, sets it in its environment to the version it runs, such as its image tag",
    );
  }
  return validateDeploymentVersion(version, configuredJobPrefix(ctx));
}

/** The base the World builds its Graphile task names from in this factory. */
export function configuredJobPrefix(ctx: FactoryContext): string {
  return ctx.env(WORLD_JOB_PREFIX_VARIABLE) ?? DEFAULT_JOB_PREFIX;
}

/** The `job_prefix` the World stamps on a version's runs. */
export function deploymentJobPrefix(jobPrefix: string, version: string): string {
  return `${jobPrefix}${version}_`;
}

/**
 * The Graphile tasks a version's queue worker claims: its flows task and its executor lane. Null
 * names the unpinned task, where the runs of a copy with no version are.
 */
export function deploymentTasks(jobPrefix: string, version: string | null): string[] {
  const prefix = version === null ? jobPrefix : deploymentJobPrefix(jobPrefix, version);
  const flows = `${prefix}flows`;
  return [flows, `${flows}_executor`];
}
