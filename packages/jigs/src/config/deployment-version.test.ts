import { expect, test } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import {
  configuredDeploymentVersion,
  deploymentJobPrefix,
  deploymentTasks,
  validateDeploymentVersion,
} from "./deployment-version.ts";

test("an image tag or a bundle hash is a usable version", () => {
  expect(validateDeploymentVersion("2026.11.18-a1b2c3")).toBe("2026.11.18-a1b2c3");
  expect(validateDeploymentVersion("sha256@abc_def")).toBe("sha256@abc_def");
});

test.each([
  ["", "it is empty"],
  ["v1/2", "letters, digits"],
  ["postgres", "reserved"],
  ["x".repeat(80), "longer than 72 characters"],
])("%j is refused: %s", (version, reason) => {
  expect(() => validateDeploymentVersion(version)).toThrow(reason);
});

test("a longer job prefix leaves less room for the version", () => {
  expect(() => validateDeploymentVersion("x".repeat(78), "acme_")).toThrow(
    "longer than 76 characters",
  );
  expect(validateDeploymentVersion("x".repeat(76), "acme_")).toHaveLength(76);
});

test("the version comes from JIGS_DEPLOYMENT_VERSION, and its absence names the variable", () => {
  expect(
    configuredDeploymentVersion(testFactoryContext({ env: { JIGS_DEPLOYMENT_VERSION: "v7" } })),
  ).toBe("v7");
  expect(() => configuredDeploymentVersion(testFactoryContext({ env: {} }))).toThrow(
    "JIGS_DEPLOYMENT_VERSION is not set",
  );
});

test("a version's job prefix and tasks follow the World's naming", () => {
  expect(deploymentJobPrefix("workflow_", "v7")).toBe("workflow_v7_");
  expect(deploymentTasks("workflow_", "v7")).toEqual([
    "workflow_v7_flows",
    "workflow_v7_flows_executor",
  ]);
  expect(deploymentTasks("workflow_", null)).toEqual(["workflow_flows", "workflow_flows_executor"]);
});
