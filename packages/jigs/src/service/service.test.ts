import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { currentFactoryContext } from "../config/factory-context.ts";
import { inTestFactory } from "../test-fixtures.ts";
import type { Factory } from "../workflow/factory.ts";
import {
  deploymentBasePrefix,
  deploymentVersion,
  resetRoleState,
  setDeploymentVersion,
} from "./role-state.ts";
import { listenOnServicePort, pinDeploymentVersion, startService } from "./service.ts";
import { runAsOnlyCopy, runAsVersion } from "./versioned.ts";

vi.mock("./boot.ts", () => ({ startWorld: vi.fn(async () => {}) }));
vi.mock("./versioned.ts", () => ({
  runAsVersion: vi.fn(async () => {}),
  runAsOnlyCopy: vi.fn(async () => {}),
}));

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("jigs.factory-context")];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetRoleState();
});
inTestFactory({
  hub: { url: "https://hub.example.test" },
});

test("the service runs on the configuration it was built with, whatever jigs.config.ts says now", () => {
  const { root } = currentFactoryContext();
  startService({ workflows: {} } as unknown as Factory, {
    hub: { url: "https://hub.example.test" },
    github: { operator: "built" },
    workflows: {},
  });
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    "export default { hub: { url: 'https://hub.example.test' }, github: { operator: 'edited' }, workflows: {} };\n",
  );

  expect(currentFactoryContext().config.github.operator).toBe("built");
});

test("the role runs only the active triggers and schedules; each inactive one is logged", () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
  const source = { kind: "fake.pages", params: {} };
  const on = { active: true, workflow: "w", source };
  const nightly = { active: true, workflow: "w", cron: "0 3 * * *", inputs: {} };
  const factory = {
    workflows: {},
    schedules: { nightly, quiet: { ...nightly, active: false } },
    triggers: { pages: on, off: { ...on, active: false } },
  } as unknown as Factory;
  startService(factory, { hub: { url: "https://hub.example.test" }, workflows: {} });
  const [whole, live] = vi.mocked(runAsOnlyCopy).mock.lastCall ?? [];
  expect(whole).toBe(factory);
  expect(live?.schedules).toEqual({ nightly });
  expect(live?.triggers).toEqual({ pages: on });
  expect(lines).toEqual(["[schedule] quiet inactive", "[trigger] off inactive"]);
});

test("a copy with a deployment version runs as that version; one without is the only copy", () => {
  const factory = { workflows: {} } as unknown as Factory;
  const config = { hub: { url: "https://hub.example.test" }, workflows: {} };
  vi.mocked(runAsOnlyCopy).mockClear();
  vi.mocked(runAsVersion).mockClear();
  startService(factory, config);
  expect(runAsOnlyCopy).toHaveBeenCalledOnce();
  expect(runAsVersion).not.toHaveBeenCalled();

  setDeploymentVersion("v1", "workflow_");
  startService(factory, config);
  expect(runAsVersion).toHaveBeenCalledOnce();
});

test("the service pins the World's deployment to JIGS_DEPLOYMENT_VERSION", () => {
  vi.stubEnv("JIGS_DEPLOYMENT_VERSION", "2026.11.18-a1b2");
  vi.stubEnv("WORKFLOW_POSTGRES_DEPLOYMENT_ID", "");
  vi.stubEnv("WORKFLOW_POSTGRES_JOB_PREFIX", "acme_");

  pinDeploymentVersion();

  expect(process.env.WORKFLOW_POSTGRES_DEPLOYMENT_ID).toBe("2026.11.18-a1b2");
  expect(deploymentVersion()).toBe("2026.11.18-a1b2");
  expect(deploymentBasePrefix()).toBe("acme_");
});

test("a service without a version leaves the World unpinned", () => {
  vi.stubEnv("JIGS_DEPLOYMENT_VERSION", "");
  vi.stubEnv("WORKFLOW_POSTGRES_DEPLOYMENT_ID", "");

  pinDeploymentVersion();

  expect(process.env.WORKFLOW_POSTGRES_DEPLOYMENT_ID).toBe("");
  expect(deploymentVersion()).toBeUndefined();
});

test("a service whose World deployment is not its version exits saying so", () => {
  vi.stubEnv("JIGS_DEPLOYMENT_VERSION", "v2");
  vi.stubEnv("WORKFLOW_POSTGRES_DEPLOYMENT_ID", "v1");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

  pinDeploymentVersion();

  expect(exit).toHaveBeenCalledWith(1);
  expect(error.mock.calls[0]?.[0]).toContain('WORKFLOW_POSTGRES_DEPLOYMENT_ID is set to "v1"');
});

test.each([["bad/version", "not a usable deployment version"]])(
  "a service whose version is %j exits saying so",
  (version, message) => {
    vi.stubEnv("JIGS_DEPLOYMENT_VERSION", version);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    pinDeploymentVersion();

    expect(error.mock.calls[0]?.[0]).toMatch(/^\[service\] /);
    expect(error.mock.calls[0]?.[0]).toContain(message);
    expect(exit).toHaveBeenCalledWith(1);
  },
);

test("the service listens on JIGS_SERVICE_PORT and its queue delivers there", () => {
  vi.stubEnv("JIGS_SERVICE_PORT", "7001");
  vi.stubEnv("JIGS_DASHBOARD_PORT", "7002");
  vi.stubEnv("PORT", "3000");
  vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "http://localhost:3000");

  listenOnServicePort();

  expect(process.env.PORT).toBe("7001");
  expect(process.env.WORKFLOW_LOCAL_BASE_URL).toBe("http://localhost:7001");
});

test.each(["JIGS_SERVICE_PORT", "JIGS_DASHBOARD_PORT"])(
  "a service without %s exits naming it",
  (name) => {
    vi.stubEnv("JIGS_SERVICE_PORT", "7001");
    vi.stubEnv("JIGS_DASHBOARD_PORT", "7002");
    vi.stubEnv(name, "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    listenOnServicePort();

    expect(error).toHaveBeenCalledWith(`[service] ${name} is not set`);
    expect(exit).toHaveBeenCalledWith(1);
  },
);
