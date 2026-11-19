// The workflow and step IDs this copy's build can run, which it publishes so
// another version can check a run fits before handing it over (ADR 0019).

import type { Factory } from "../workflow/factory.ts";

// Where the SDK's compiler registers every step of the server bundle.
const REGISTERED_STEPS = Symbol.for("@workflow/core//registeredSteps");

/** Every workflow and step ID the running bundle has, sorted. */
export function builtIds(factory: Pick<Factory, "workflows">): string[] {
  const workflows = Object.values(factory.workflows).flatMap((entry) => {
    const id = (entry.workflow as { workflowId?: string }).workflowId;
    return id === undefined ? [] : [id];
  });
  const steps = (globalThis as { [REGISTERED_STEPS]?: Map<string, unknown> })[REGISTERED_STEPS];
  return [...new Set([...workflows, ...(steps?.keys() ?? [])])].sort();
}
