import { expect, test } from "vitest";
import { z } from "zod";
import { defineWorkflow, workflowVersioning } from "./factory.ts";

const inputs = z.object({});
const workflow = async () => undefined;

test("a workflow follows the current version unless it asks to stay pinned", () => {
  expect(workflowVersioning(defineWorkflow({ inputs, workflow }))).toBe("auto-upgrade");
  expect(workflowVersioning(defineWorkflow({ inputs, workflow, versioning: "pinned" }))).toBe(
    "pinned",
  );
});

test("a versioning that is neither word is refused where the workflow is defined", () => {
  expect(() =>
    defineWorkflow({ inputs, workflow, versioning: "sticky" as unknown as "pinned" }),
  ).toThrow('versioning must be "auto-upgrade" or "pinned", not "sticky"');
});
