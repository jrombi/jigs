import { z } from "zod";
import { JigsError } from "../errors.ts";
import type { ClaudeCredential } from "./harness-config.ts";

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name, never a value");

// Shared by the harness option and the factory-wide default in jigs.config.ts.
export const claudeCredentialSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("api-key"), apiKeyEnv: envName.optional() }),
    z.strictObject({ kind: z.literal("bedrock") }),
  ],
  { error: 'must be { kind: "api-key", apiKeyEnv? } or { kind: "bedrock" }' },
) satisfies z.ZodType<ClaudeCredential>;

/** Reject a Claude credential the drivers cannot forward, when the workflow module loads. */
export function assertClaudeCredential(credential: unknown): void {
  if (credential === undefined) return;
  const parsed = claudeCredentialSchema.safeParse(credential);
  if (parsed.success) return;
  const problems = parsed.error.issues
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")} ${issue.message}`,
    )
    .join("; ");
  throw new JigsError(
    `Claude harness credential is invalid: ${problems}`,
    'use { kind: "api-key", apiKeyEnv? } or { kind: "bedrock" }, or leave credential out for the factory\'s default',
  );
}
