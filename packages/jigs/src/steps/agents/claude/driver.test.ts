import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import {
  inTestFactory,
  removeTmpDir,
  testFactoryContext,
  useTestFactory,
} from "../../../test-fixtures.ts";
import { type ClaudeCredential, harnesses } from "../../../workflow/agents/harness-config.ts";
import { buildAgentRequest, buildAskAgentRequest } from "../../../workflow/agents/plan.ts";
import type { RunRequest } from "../shared/types.ts";
import { BEDROCK_ENV } from "./credential.ts";
import { claudeDriver, createClaudeDriver } from "./driver.ts";
import { fakeClaudeQuery } from "./test-fixtures.ts";

inTestFactory();

beforeEach(() => {
  vi.stubEnv("JIGS_CLAUDE_EXECUTABLE", "/fake/claude");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const assistant = (error?: string) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "working" }] },
    ...(error === undefined ? {} : { error }),
  }) as unknown as SDKMessage;
const maxTurns = {
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  errors: ["Reached maximum number of turns (2)"],
  session_id: "s-1",
} as unknown as SDKMessage;

const ask = (messages: SDKMessage[]) =>
  createClaudeDriver({
    query: fakeClaudeQuery(() => messages),
    openStepStream: () => undefined,
  }).ask?.(buildAskAgentRequest({ harness: harnesses.claude({ model: "haiku" }), prompt: "hi" }), {
    metadata: { workflowRunId: "wrun_errors" },
    deps: {} as never,
    env: {},
  });

const claudeWith = (credential?: ClaudeCredential) =>
  harnesses.claude({ model: "haiku", ...(credential === undefined ? {} : { credential }) });

// The names a step hands Claude Code for each way of paying; values stay in the service.
test("the allowlist adds exactly the credential's variables", () => {
  const driver = createClaudeDriver({ factoryCredential: () => undefined });
  const names = (credential?: ClaudeCredential) =>
    [...driver.envAllowlist({ harness: claudeWith(credential), cwd: "/w" })].sort();
  expect(names()).toEqual(["CLAUDE_CONFIG_DIR"]);
  expect(names({ kind: "api-key" })).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]);
  expect(names({ kind: "api-key", apiKeyEnv: "TEAM_KEY" })).toEqual([
    "CLAUDE_CONFIG_DIR",
    "TEAM_KEY",
  ]);
  expect(names({ kind: "bedrock" })).toEqual(["CLAUDE_CONFIG_DIR", ...BEDROCK_ENV].sort());
});

const factoryWith = (credential?: ClaudeCredential) =>
  testFactoryContext({
    config: credential === undefined ? {} : { harnesses: { claude: { credential } } },
  });

test("the allowlist names the factory's default credential's variables, unless the harness sets its own", () => {
  const driver = createClaudeDriver({ factoryCredential: () => ({ kind: "bedrock" }) });
  const names = (credential?: ClaudeCredential) =>
    [...driver.envAllowlist({ harness: claudeWith(credential), cwd: "/w" })].sort();
  expect(names()).toEqual(["CLAUDE_CONFIG_DIR", ...BEDROCK_ENV].sort());
  expect(names({ kind: "api-key", apiKeyEnv: "TEAM_KEY" })).toEqual([
    "CLAUDE_CONFIG_DIR",
    "TEAM_KEY",
  ]);
});

test("the driver reads the default from the factory's jigs.config.ts", () => {
  const parent = useTestFactory({ harnesses: { claude: { credential: { kind: "api-key" } } } });
  onTestFinished(() => removeTmpDir(parent));
  expect([...claudeDriver.envAllowlist({ harness: claudeWith(), cwd: "/w" })].sort()).toEqual([
    "ANTHROPIC_API_KEY",
    "CLAUDE_CONFIG_DIR",
  ]);
});

test("the login check follows the descriptor's credential, and the CLI check stays per installation", () => {
  const ids = (credential?: ClaudeCredential) =>
    claudeDriver.credentialChecks?.(claudeWith(credential), factoryWith()).map((check) => check.id);
  expect(claudeDriver.installationChecks().map((check) => check.id)).toEqual([
    "harness.claude-cli",
  ]);
  expect(ids()).toEqual(["harness.claude-auth"]);
  expect(ids({ kind: "api-key" })).toEqual(["harness.claude-api-key-anthropic-api-key"]);
  expect(ids({ kind: "api-key", apiKeyEnv: "TEAM_KEY" })).toEqual([
    "harness.claude-api-key-team-key",
  ]);
  expect(ids({ kind: "bedrock" })).toEqual(["harness.claude-bedrock"]);
});

test("the login check follows the factory's default credential unless the harness sets its own", () => {
  const ids = (harness?: ClaudeCredential, factory?: ClaudeCredential) =>
    claudeDriver
      .credentialChecks?.(claudeWith(harness), factoryWith(factory))
      .map((check) => check.id);
  expect(ids(undefined, { kind: "api-key" })).toEqual(["harness.claude-api-key-anthropic-api-key"]);
  expect(ids({ kind: "bedrock" }, { kind: "api-key" })).toEqual(["harness.claude-bedrock"]);
  expect(ids(undefined, undefined)).toEqual(["harness.claude-auth"]);
});

// What the step built from the allowlist, as the driver receives it.
const stepEnv = {
  PATH: "/usr/bin",
  CLAUDE_CONFIG_DIR: "/home/tester/.claude-work",
  TEAM_KEY: "sk-ant-team",
  AWS_PROFILE: "factory",
  AWS_REGION: "us-east-1",
};

async function envHandedToClaude(
  credential: ClaudeCredential | undefined,
  inWorktree: boolean,
  factoryCredential?: ClaudeCredential,
) {
  const query = fakeClaudeQuery();
  const driver = createClaudeDriver({
    query,
    transcript: async () => new Set(),
    openStepStream: () => undefined,
    factoryCredential: () => factoryCredential,
  });
  const context = { metadata: { workflowRunId: "wrun_env" }, deps: {} as never, env: stepEnv };
  if (inWorktree) {
    await driver.run?.(
      buildAgentRequest({ harness: claudeWith(credential), cwd: "/w", prompt: "go" }) as RunRequest,
      context,
    );
  } else {
    await driver.ask?.(
      buildAskAgentRequest({ harness: claudeWith(credential), prompt: "go" }),
      context,
    );
  }
  return query.calls[0]?.options.env;
}

test.each([true, false])(
  "Claude Code gets the step environment as is for the subscription login (worktree: %s)",
  async (inWorktree) => {
    expect(await envHandedToClaude(undefined, inWorktree)).toEqual(stepEnv);
  },
);

test.each([true, false])(
  "an api-key credential moves the named variable to ANTHROPIC_API_KEY (worktree: %s)",
  async (inWorktree) => {
    const { TEAM_KEY: _moved, ...rest } = stepEnv;
    expect(await envHandedToClaude({ kind: "api-key", apiKeyEnv: "TEAM_KEY" }, inWorktree)).toEqual(
      { ...rest, ANTHROPIC_API_KEY: "sk-ant-team" },
    );
  },
);

test("an api-key credential reading ANTHROPIC_API_KEY itself passes the environment through", async () => {
  const query = fakeClaudeQuery();
  const driver = createClaudeDriver({ query, openStepStream: () => undefined });
  await driver.ask?.(
    buildAskAgentRequest({ harness: claudeWith({ kind: "api-key" }), prompt: "go" }),
    {
      metadata: { workflowRunId: "wrun_env" },
      deps: {} as never,
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant" },
    },
  );
  expect(query.calls[0]?.options.env).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant" });
});

test.each([true, false])(
  "a bedrock credential switches Claude Code to Bedrock over the AWS variables (worktree: %s)",
  async (inWorktree) => {
    expect(await envHandedToClaude({ kind: "bedrock" }, inWorktree)).toEqual({
      ...stepEnv,
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
  },
);

test.each([true, false])(
  "a harness without a credential runs on the factory's default (worktree: %s)",
  async (inWorktree) => {
    expect(await envHandedToClaude(undefined, inWorktree, { kind: "bedrock" })).toEqual({
      ...stepEnv,
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
  },
);

test.each([true, false])(
  "a harness's own credential wins over the factory's default (worktree: %s)",
  async (inWorktree) => {
    const { TEAM_KEY: _moved, ...rest } = stepEnv;
    expect(
      await envHandedToClaude({ kind: "api-key", apiKeyEnv: "TEAM_KEY" }, inWorktree, {
        kind: "bedrock",
      }),
    ).toEqual({ ...rest, ANTHROPIC_API_KEY: "sk-ant-team" });
  },
);

test("an error result names the error of the last assistant message only", async () => {
  await expect(ask([assistant("rate_limit"), assistant(), maxTurns])).rejects.toThrow(
    /^Claude Code failed: Reached maximum number of turns \(2\)$/,
  );
  await expect(ask([assistant(), assistant("rate_limit"), maxTurns])).rejects.toThrow(
    "Claude Code failed (rate_limit): Reached maximum number of turns (2)",
  );
});
