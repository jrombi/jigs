import type { ClaudeCredential } from "../../../workflow/agents/harness-config.ts";

/** Where the Claude Agent SDK reads an Anthropic API key. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
/** Switches the Claude Agent SDK to Amazon Bedrock. */
export const BEDROCK_SWITCH_ENV = "CLAUDE_CODE_USE_BEDROCK";

// How the AWS SDK finds credentials on the hosts a factory runs on: static
// keys, a profile and its files, an ECS or Fargate task's credential endpoint,
// an EKS pod's web identity, or a Bedrock bearer token.
export const BEDROCK_CREDENTIAL_SOURCE_ENV: readonly string[] = [
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
];

// The variables that complete a credential source above, or pick the region.
const BEDROCK_SUPPORTING_ENV: readonly string[] = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_ROLE_ARN",
];

/** Every AWS variable a Bedrock credential passes through to Claude Code. */
export const BEDROCK_ENV: readonly string[] = [
  ...BEDROCK_CREDENTIAL_SOURCE_ENV,
  ...BEDROCK_SUPPORTING_ENV,
];

/** The service variable an `api-key` credential reads. */
export function claudeApiKeyVariable(credential: ClaudeCredential & { kind: "api-key" }): string {
  return credential.apiKeyEnv ?? ANTHROPIC_API_KEY_ENV;
}

/** The service variables the credential needs in the agent's environment. */
export function claudeCredentialVariables(credential: ClaudeCredential | undefined): string[] {
  switch (credential?.kind) {
    case undefined:
      return [];
    case "api-key":
      return [claudeApiKeyVariable(credential)];
    case "bedrock":
      return [...BEDROCK_ENV];
  }
}

function forwardApiKey(
  credential: ClaudeCredential & { kind: "api-key" },
  env: Record<string, string>,
): Record<string, string> {
  const source = claudeApiKeyVariable(credential);
  const value = env[source];
  if (source === ANTHROPIC_API_KEY_ENV || value === undefined) return env;
  const { [source]: _moved, ...rest } = env;
  return { ...rest, [ANTHROPIC_API_KEY_ENV]: value };
}

/**
 * The environment Claude Code runs under for the credential: the step's environment with the
 * API key moved to where the SDK reads it, or with Bedrock switched on. Unchanged for the
 * subscription login.
 */
export function claudeCredentialEnv(
  credential: ClaudeCredential | undefined,
  env: Record<string, string>,
): Record<string, string> {
  switch (credential?.kind) {
    case undefined:
      return env;
    case "api-key":
      return forwardApiKey(credential, env);
    case "bedrock":
      return { ...env, [BEDROCK_SWITCH_ENV]: "1" };
  }
}
