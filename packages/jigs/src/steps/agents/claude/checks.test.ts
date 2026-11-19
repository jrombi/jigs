import { expect, test } from "vitest";
import type { CheckResult } from "../../../checks/check.ts";
import { doctorChecks, preflightChecks } from "../../../checks/index.ts";
import { testFactoryContext } from "../../../test-fixtures.ts";
import { type ClaudeCredential, harnesses } from "../../../workflow/agents/harness-config.ts";
import { claudeCredentialCheck } from "./checks.ts";

// Verbatim `claude auth status --json` output (2.1.326) with ANTHROPIC_API_KEY
// exported, and with CLAUDE_CODE_USE_BEDROCK=1.
const API_KEY = {
  loggedIn: true,
  authMethod: "api_key",
  apiProvider: "firstParty",
  analyticsDisabled: false,
  loginExpiresAt: null,
  apiKeySource: "ANTHROPIC_API_KEY",
};
const BEDROCK = {
  loggedIn: true,
  authMethod: "third_party",
  apiProvider: "bedrock",
  analyticsDisabled: true,
  loginExpiresAt: null,
};
const SUBSCRIPTION = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "team",
};

const service = {
  JIGS_CLAUDE_EXECUTABLE: "/usr/bin/claude",
  PATH: "/usr/bin",
  CLAUDE_CONFIG_DIR: "/home/tester/.claude-work",
  SYNTHETIC_DATABASE_URL: "postgres://user:secret@db/app",
};

type Probe = { env: Record<string, string>; result: CheckResult };

async function check(
  credential: Parameters<typeof claudeCredentialCheck>[0],
  env: Record<string, string>,
  answer: unknown,
): Promise<Probe> {
  let probed: Record<string, string> = {};
  const result = await claudeCredentialCheck(credential, {
    env,
    factoryEnv: () => [],
    exec: async (_file, _args, options) => {
      probed = options.env;
      return { stdout: JSON.stringify(answer) };
    },
  }).run();
  return { env: probed, result };
}

const names = (env: Record<string, string>) => Object.keys(env).sort();

test("without a credential the subscription login is checked as before", async () => {
  const { env, result } = await check(undefined, service, SUBSCRIPTION);
  expect(result).toEqual({ ok: true });
  expect(names(env)).toEqual(["CLAUDE_CONFIG_DIR", "PATH"]);
});

test("the subscription repair offers the api-key credential when a key overrides the login", async () => {
  const { result } = await check(undefined, service, API_KEY);
  expect(result).toMatchObject({
    ok: false,
    repair: expect.stringContaining('credential: { kind: "api-key" }'),
  });
});

test("an api-key credential fails before probing when its variable is unset or empty", async () => {
  for (const env of [service, { ...service, TEAM_KEY: "" }]) {
    let probed = false;
    const result = await claudeCredentialCheck(
      { kind: "api-key", apiKeyEnv: "TEAM_KEY" },
      {
        env,
        factoryEnv: () => [],
        exec: async () => {
          probed = true;
          return { stdout: "{}" };
        },
      },
    ).run();
    expect(result).toEqual({
      ok: false,
      reason: "TEAM_KEY is not set in the service's environment",
      repair:
        "set TEAM_KEY in this copy's environment, then: `pnpm exec jigs up --restart-service`",
    });
    expect(probed).toBe(false);
  }
});

test("an api-key credential probes the CLI with the key where the SDK reads it, and passes on an API key", async () => {
  const { env, result } = await check(
    { kind: "api-key", apiKeyEnv: "TEAM_KEY" },
    { ...service, TEAM_KEY: "sk-ant-team" },
    API_KEY,
  );
  expect(names(env)).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "PATH"]);
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-team");
  expect(result).toEqual({ ok: true, detail: "API key from TEAM_KEY" });
});

test("an api-key credential fails when the CLI still reports the subscription login or no key", async () => {
  for (const answer of [SUBSCRIPTION, { ...API_KEY, apiKeySource: "none" }, { loggedIn: false }]) {
    const { result } = await check(
      { kind: "api-key" },
      { ...service, ANTHROPIC_API_KEY: "sk-ant" },
      answer,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("did not take the API key from ANTHROPIC_API_KEY"),
      repair: expect.stringContaining("set ANTHROPIC_API_KEY to an Anthropic API key"),
    });
  }
});

test("a bedrock credential fails before probing when no AWS credential source is set", async () => {
  let probed = false;
  const result = await claudeCredentialCheck(
    { kind: "bedrock" },
    {
      env: { ...service, AWS_REGION: "us-east-1", AWS_SECRET_ACCESS_KEY: "half-a-key" },
      factoryEnv: () => [],
      exec: async () => {
        probed = true;
        return { stdout: JSON.stringify(BEDROCK) };
      },
    },
  ).run();
  expect(result).toMatchObject({
    ok: false,
    reason: "no AWS credential source for Bedrock is set in the service's environment",
    repair: expect.stringContaining("AWS_PROFILE"),
  });
  expect(probed).toBe(false);
});

test("a bedrock credential probes the CLI switched to Bedrock over the AWS variables only", async () => {
  const { env, result } = await check(
    { kind: "bedrock" },
    {
      ...service,
      AWS_PROFILE: "factory",
      AWS_REGION: "us-east-1",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc",
      AWS_ACCESS_KEY_ID: "",
    },
    BEDROCK,
  );
  expect(names(env)).toEqual([
    "AWS_ACCESS_KEY_ID",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_PROFILE",
    "AWS_REGION",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CONFIG_DIR",
    "PATH",
  ]);
  expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  expect(result).toEqual({
    ok: true,
    detail: "AWS credentials from AWS_PROFILE, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  });
});

test("a bedrock credential fails when the CLI does not switch to Bedrock", async () => {
  const { result } = await check(
    { kind: "bedrock" },
    { ...service, AWS_BEARER_TOKEN_BEDROCK: "token" },
    SUBSCRIPTION,
  );
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining('apiProvider "firstParty", not "bedrock"'),
  });
});

test("every credential mode fails closed on output that is not JSON", async () => {
  for (const credential of [
    undefined,
    { kind: "api-key" } as const,
    { kind: "bedrock" } as const,
  ]) {
    const result = await claudeCredentialCheck(credential, {
      env: { ...service, ANTHROPIC_API_KEY: "sk-ant", AWS_PROFILE: "factory" },
      factoryEnv: () => [],
      exec: async () => ({ stdout: "claude: command needs an update" }),
    }).run();
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("did not answer JSON"),
    });
  }
});

// Preflight and doctor plan the check for the credential the step will run on.
const claudeCheckIds = (harness: ClaudeCredential | undefined, factory?: ClaudeCredential) => {
  const agents = {
    builder: harnesses.claude({
      model: "opus",
      ...(harness === undefined ? {} : { credential: harness }),
    }),
  };
  const ctx = testFactoryContext({
    config: factory === undefined ? {} : { harnesses: { claude: { credential: factory } } },
  });
  const claudeIds = (checks: { id: string }[]) =>
    checks
      .map((check) => check.id)
      .filter((id) => id.startsWith("harness.claude-") && id !== "harness.claude-cli");
  return {
    preflight: claudeIds(preflightChecks({ agents }, undefined, ctx)),
    doctor: claudeIds(doctorChecks({ build: { requires: { agents } } }, {}, ctx)),
  };
};

test("preflight and doctor check the factory's default credential for a harness without its own", () => {
  const ids = ["harness.claude-api-key-team-key"];
  expect(claudeCheckIds(undefined, { kind: "api-key", apiKeyEnv: "TEAM_KEY" })).toEqual({
    preflight: ids,
    doctor: ids,
  });
});

test("preflight and doctor check the harness's own credential over the factory's default", () => {
  const ids = ["harness.claude-bedrock"];
  expect(claudeCheckIds({ kind: "bedrock" }, { kind: "api-key" })).toEqual({
    preflight: ids,
    doctor: ids,
  });
});

test("preflight and doctor check the subscription login without any credential", () => {
  const ids = ["harness.claude-auth"];
  expect(claudeCheckIds(undefined)).toEqual({ preflight: ids, doctor: ids });
});
