import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROBE_TIMEOUT_MS } from "../../../checks/catalog.ts";
import type { Check, CheckResult } from "../../../checks/check.ts";
import { variableSet } from "../../../checks/secrets.ts";
import { processEnv } from "../../../config/factory-context.ts";
import { FACTORY_ENVIRONMENT, RESTART_SERVICE } from "../../../providers/credentials.ts";
import type { ClaudeCredential } from "../../../workflow/agents/harness-config.ts";
import { factoryAgentEnv, harnessEnv } from "../shared/env.ts";
import { resolveClaudeExecutable } from "../shared/executables.ts";
import {
  BEDROCK_CREDENTIAL_SOURCE_ENV,
  BEDROCK_SWITCH_ENV,
  claudeApiKeyVariable,
  claudeCredentialEnv,
  claudeCredentialVariables,
} from "./credential.ts";
import { CLAUDE_ENV } from "./process.ts";

const execFileAsync = promisify(execFile);

export interface ClaudeAuthDeps {
  exec?: (
    file: string,
    args: string[],
    options: { env: Record<string, string>; timeout: number },
  ) => Promise<{ stdout: string }>;
  env?: NodeJS.ProcessEnv;
  factoryEnv?: () => readonly string[];
}

type ClaudeAuthStatus = {
  loggedIn?: unknown;
  authMethod?: unknown;
  apiKeySource?: unknown;
  apiProvider?: unknown;
};

type AuthProbe =
  | { ok: true; status: ClaudeAuthStatus }
  | { ok: false; reason: string; repair: string };

type ApiKeyCredential = ClaudeCredential & { kind: "api-key" };

// The environment a step gives Claude Code for this credential, so the probe
// sees the same login the step will.
function probeEnv(credential: ClaudeCredential | undefined, deps: ClaudeAuthDeps) {
  const env = deps.env ?? processEnv();
  const names = [
    ...CLAUDE_ENV,
    ...claudeCredentialVariables(credential),
    ...(deps.factoryEnv ?? factoryAgentEnv)(),
  ];
  return claudeCredentialEnv(credential, harnessEnv(names, env));
}

// Heuristic, never a model call: `claude auth status --json` under the
// step's environment. The CLI itself is harnessRuntimeCheck's business.
async function probeAuthStatus(
  credential: ClaudeCredential | undefined,
  deps: ClaudeAuthDeps,
): Promise<AuthProbe> {
  const exec = deps.exec ?? execFileAsync;
  const env = deps.env ?? processEnv();
  let executable: string;
  try {
    executable = resolveClaudeExecutable(env);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      repair: `install the Claude Code CLI, or set JIGS_CLAUDE_EXECUTABLE in ${FACTORY_ENVIRONMENT}, then: \`${RESTART_SERVICE}\``,
    };
  }

  let stdout: string;
  try {
    ({ stdout } = await exec(executable, ["auth", "status", "--json"], {
      env: probeEnv(credential, deps),
      timeout: PROBE_TIMEOUT_MS,
    }));
  } catch (err) {
    return {
      ok: false,
      reason: `\`${executable} auth status --json\` failed: ${err}`,
      repair: "run: `claude auth login`",
    };
  }

  try {
    return { ok: true, status: JSON.parse(stdout) as ClaudeAuthStatus };
  } catch {
    // Fail closed: an answer we cannot read is not evidence of a login.
    return {
      ok: false,
      reason: `\`claude auth status --json\` did not answer JSON: ${stdout.slice(0, 200)}`,
      repair: "update the Claude Code CLI, since jigs could not read its auth status JSON",
    };
  }
}

function subscriptionResult(status: ClaudeAuthStatus): CheckResult {
  if (status.loggedIn !== true) {
    return {
      ok: false,
      reason: "the Claude Code CLI is not logged in",
      repair: "run: `claude auth login`",
    };
  }
  // Exit code is not a signal: the CLI reports an API-key override at
  // exit 0 while still saying authMethod claude.ai, so apiKeySource is
  // the field that actually catches it.
  if (status.apiKeySource != null) {
    return {
      ok: false,
      reason: `the Claude Code CLI is using an API key from ${String(status.apiKeySource)} instead of the subscription login`,
      repair: `remove ${String(status.apiKeySource)} from ${FACTORY_ENVIRONMENT} (and from the shell you start the service from), or set \`credential: { kind: "api-key" }\` on the harness or under harnesses.claude in jigs.config.ts, then: \`${RESTART_SERVICE}\``,
    };
  }
  if (status.authMethod !== "claude.ai") {
    return {
      ok: false,
      reason: `the Claude Code CLI reports authMethod ${JSON.stringify(status.authMethod)}, not "claude.ai"`,
      repair: "log in with the subscription account: `claude auth login`",
    };
  }
  return { ok: true };
}

/** A login probe only: the subscription login a Claude harness without a credential uses. */
export function claudeAuthCheck(deps: ClaudeAuthDeps = {}): Check {
  return {
    id: "harness.claude-auth",
    label: "Claude subscription login",
    run: async (): Promise<CheckResult> => {
      const probe = await probeAuthStatus(undefined, deps);
      return probe.ok ? subscriptionResult(probe.status) : probe;
    },
  };
}

// Newer CLIs report apiKeySource "none" where older ones leave it out.
const hasApiKey = (status: ClaudeAuthStatus) =>
  status.apiKeySource != null && status.apiKeySource !== "none";

function apiKeyResult(variable: string, status: ClaudeAuthStatus): CheckResult {
  if (status.loggedIn !== true || !hasApiKey(status)) {
    return {
      ok: false,
      reason: `the Claude Code CLI did not take the API key from ${variable} (authMethod ${JSON.stringify(status.authMethod)})`,
      repair: `set ${variable} to an Anthropic API key in ${FACTORY_ENVIRONMENT}, then: \`${RESTART_SERVICE}\``,
    };
  }
  return { ok: true, detail: `API key from ${variable}` };
}

const checkIdSegment = (variable: string) => variable.toLowerCase().replaceAll("_", "-");

/** The API key an `api-key` credential names is set, and the CLI runs on it. */
export function claudeApiKeyCheck(credential: ApiKeyCredential, deps: ClaudeAuthDeps = {}): Check {
  const variable = claudeApiKeyVariable(credential);
  return {
    id: `harness.claude-api-key-${checkIdSegment(variable)}`,
    label: `Claude Code API key (${variable})`,
    run: async (): Promise<CheckResult> => {
      const env = deps.env ?? processEnv();
      const present = variableSet(variable, env[variable]);
      if (!present.ok) return present;
      const probe = await probeAuthStatus(credential, deps);
      return probe.ok ? apiKeyResult(variable, probe.status) : probe;
    },
  };
}

function bedrockCredentialSources(env: NodeJS.ProcessEnv): string[] {
  return BEDROCK_CREDENTIAL_SOURCE_ENV.filter((name) => (env[name] ?? "").trim() !== "");
}

function bedrockResult(sources: string[], status: ClaudeAuthStatus): CheckResult {
  if (status.loggedIn !== true || status.apiProvider !== "bedrock") {
    return {
      ok: false,
      reason: `the Claude Code CLI reports apiProvider ${JSON.stringify(status.apiProvider)}, not "bedrock", with ${BEDROCK_SWITCH_ENV}=1`,
      repair: "update the Claude Code CLI to one that supports Amazon Bedrock",
    };
  }
  return { ok: true, detail: `AWS credentials from ${sources.join(", ")}` };
}

/**
 * An AWS credential source for a `bedrock` credential is set, and the CLI switches to Bedrock
 * under it. Never calls Bedrock: a wrong key or region fails the agent's first call.
 */
export function claudeBedrockCheck(deps: ClaudeAuthDeps = {}): Check {
  const credential: ClaudeCredential = { kind: "bedrock" };
  return {
    id: "harness.claude-bedrock",
    label: "Claude Code Bedrock credentials",
    run: async (): Promise<CheckResult> => {
      const sources = bedrockCredentialSources(deps.env ?? processEnv());
      if (sources.length === 0) {
        return {
          ok: false,
          reason: "no AWS credential source for Bedrock is set in the service's environment",
          repair: `set AWS_PROFILE, or AWS_ACCESS_KEY_ID with AWS_SECRET_ACCESS_KEY, or AWS_BEARER_TOKEN_BEDROCK in ${FACTORY_ENVIRONMENT}, with AWS_REGION, then: \`${RESTART_SERVICE}\``,
        };
      }
      const probe = await probeAuthStatus(credential, deps);
      return probe.ok ? bedrockResult(sources, probe.status) : probe;
    },
  };
}

/** The check for how a Claude harness pays: its credential, or the subscription login. */
export function claudeCredentialCheck(
  credential: ClaudeCredential | undefined,
  deps: ClaudeAuthDeps = {},
): Check {
  switch (credential?.kind) {
    case undefined:
      return claudeAuthCheck(deps);
    case "api-key":
      return claudeApiKeyCheck(credential, deps);
    case "bedrock":
      return claudeBedrockCheck(deps);
  }
}
