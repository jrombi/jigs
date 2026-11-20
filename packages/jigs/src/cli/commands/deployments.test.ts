import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DeploymentView } from "../../service/deployments/store.ts";
import type { RegistrySql } from "../../steps/runtime/registry.ts";
import { removeTmpDir, useTestFactory } from "../../test-fixtures.ts";
import { layoutProblems } from "../output-layout.ts";
import { listDeployments, makeCurrent, pruneDeployments } from "./deployments.ts";

const store = vi.hoisted(() => ({
  listDeployments: vi.fn(),
  makeDeploymentCurrent: vi.fn(),
  deploymentRunning: vi.fn(),
  pruneDeployments: vi.fn(),
}));
vi.mock("../../service/deployments/store.ts", () => store);
const drain = vi.hoisted(() => ({ liveRunIds: vi.fn(), ownedRunCount: vi.fn() }));
vi.mock("../../service/deployments/drain.ts", () => drain);

const NOW = new Date("2026-11-18T12:00:00.000Z");
let parent: string;
let lines: string[];
let ended: number;

beforeEach(() => {
  parent = useTestFactory();
  vi.stubEnv("WORKFLOW_POSTGRES_URL", "postgres://jigs:jigs@localhost:5555/jigs");
  lines = [];
  ended = 0;
  store.listDeployments.mockReset();
  store.makeDeploymentCurrent.mockReset();
  store.deploymentRunning.mockReset().mockResolvedValue(true);
  store.pruneDeployments.mockReset();
  drain.liveRunIds.mockReset();
  drain.ownedRunCount.mockReset().mockResolvedValue(0);
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(parent);
  expect(layoutProblems(lines)).toEqual([]);
});

const connect = () =>
  ({
    $client: {
      end: async () => {
        ended += 1;
      },
    },
  }) as unknown as RegistrySql;
const deps = () => ({ out: (line: string) => lines.push(line), connect, now: () => NOW });

const view = (fields: Partial<DeploymentView>): DeploymentView => ({
  version: "v1",
  role: "current",
  startedAt: "2026-11-18T11:00:00.000Z",
  lastSeenAt: "2026-11-18T11:59:50.000Z",
  madeCurrentAt: "2026-11-18T11:00:00.000Z",
  supersededAt: null,
  pid: 4242,
  host: "box",
  running: true,
  runs: 0,
  ...fields,
});

test("lists every version with its role, age, runs and process, and points at prune when a version is gone", async () => {
  store.listDeployments.mockResolvedValue([
    view({ version: "v2", runs: 3 }),
    view({ version: "v1", role: "draining", pid: 4100, runs: 1, madeCurrentAt: null }),
    view({ version: "v0", role: "gone", lastSeenAt: null, pid: 4000, running: false }),
  ]);

  await listDeployments(deps());

  expect(lines).toEqual([
    "VERSION  ROLE      STARTED  SEEN     RUNS  PROCESS",
    "v2       current   1h ago   10s ago  3     pid 4242 on box",
    "v1       draining  1h ago   10s ago  1     pid 4100 on box",
    "v0       gone      1h ago   never    0     none",
    "",
    "remove the versions with no process and no runs:",
    "  pnpm exec jigs deployments prune",
  ]);
  expect(ended).toBe(1);
});

test("a current version with no running process says so", async () => {
  store.listDeployments.mockResolvedValue([
    view({ version: "v2", running: false, lastSeenAt: "2026-11-18T11:00:00.000Z" }),
  ]);

  await listDeployments(deps());

  expect(lines).toEqual([
    "VERSION  ROLE     STARTED  SEEN    RUNS  PROCESS",
    "v2       current  1h ago   1h ago  0     none",
    "",
    "version v2 is current but has no running process: no copy is the factory until it runs again",
  ]);
});

test("--json prints the views as they are", async () => {
  store.listDeployments.mockResolvedValue([view({})]);
  await listDeployments(deps(), { json: true });
  expect(JSON.parse(lines.join("\n"))).toEqual({ deployments: [view({})] });
});

test("an empty registry says no version has run", async () => {
  store.listDeployments.mockResolvedValue([]);
  await listDeployments(deps());
  expect(lines).toEqual(["no versions have run yet"]);
});

test("current validates the version, writes it and names the one it replaced", async () => {
  store.makeDeploymentCurrent.mockResolvedValue("v1");

  await makeCurrent("v2", deps());

  expect(store.makeDeploymentCurrent).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(String),
    "v2",
  );
  expect(lines).toEqual([
    "version v2 is now current (was v1)",
    "version v1 drains: it finishes the runs it started and exits once it owns none",
  ]);
  await expect(makeCurrent("not/ok", deps())).rejects.toThrow("not a usable deployment version");
});

test("current refuses a version with no running process unless forced", async () => {
  store.deploymentRunning.mockResolvedValue(false);
  store.makeDeploymentCurrent.mockResolvedValue("v2");

  await expect(makeCurrent("v1", deps())).rejects.toThrow("version v1 has no running process");
  expect(store.makeDeploymentCurrent).not.toHaveBeenCalled();

  await makeCurrent("v1", deps(), { force: true });
  expect(store.makeDeploymentCurrent).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(String),
    "v1",
  );
});

test("current validates the version against the factory's configured job prefix", async () => {
  vi.stubEnv("WORKFLOW_POSTGRES_JOB_PREFIX", "x".repeat(70));
  await expect(makeCurrent("v1-much-too-long", deps())).rejects.toThrow("is longer than");
});

const pruneDeps = (cancel = vi.fn(async (_runId: string) => {})) => ({
  ...deps(),
  serviceUrl: "http://localhost:1",
  cancel,
});

test("prune reports each version removed, or that there was nothing to remove", async () => {
  store.listDeployments.mockResolvedValue([]);
  store.pruneDeployments.mockResolvedValueOnce(["v0"]).mockResolvedValueOnce([]);
  await pruneDeployments(pruneDeps());
  await pruneDeployments(pruneDeps());
  expect(lines).toEqual([
    "removed version v0",
    "nothing to prune: every version is current or running",
  ]);
});

test("prune keeps a version with no process that still owns runs, and says how to finish them", async () => {
  store.listDeployments.mockResolvedValue([view({ version: "v0", role: "gone", runs: 2 })]);
  store.pruneDeployments.mockResolvedValue([]);
  const cancel = vi.fn(async () => {});

  await pruneDeployments(pruneDeps(cancel));

  expect(cancel).not.toHaveBeenCalled();
  expect(lines).toEqual([
    "kept version v0: it has no process and owns 2 live run(s)",
    "start that version again to finish its runs, or cancel them and prune it:",
    "  pnpm exec jigs deployments prune --cancel-runs",
  ]);
});

const noSleep = async () => {};

test("prune --cancel-runs cancels a gone version's runs, waits for them to end, then forgets it", async () => {
  const abandoned = view({ version: "v0", role: "gone", runs: 2, running: false });
  store.listDeployments
    .mockResolvedValueOnce([view({ version: "v1", role: "draining", runs: 1 }), abandoned])
    .mockResolvedValue([]);
  drain.liveRunIds.mockResolvedValue(["wrun_a", "wrun_b"]);
  drain.ownedRunCount.mockResolvedValueOnce(2).mockResolvedValue(0);
  store.pruneDeployments.mockResolvedValue(["v0"]);
  const cancel = vi.fn(async () => {});

  await pruneDeployments({ ...pruneDeps(cancel), sleep: noSleep }, { cancelRuns: true });

  expect(drain.liveRunIds).toHaveBeenCalledWith(expect.anything(), {
    version: "v0",
    jobPrefix: "workflow_",
  });
  expect(cancel.mock.calls).toEqual([["wrun_a"], ["wrun_b"]]);
  expect(drain.ownedRunCount).toHaveBeenCalledTimes(2);
  expect(lines).toEqual(["removed version v0"]);
});

test("prune --cancel-runs reports a run it could not cancel and a version whose runs have not ended", async () => {
  const abandoned = view({ version: "v0", role: "gone", runs: 2, running: false });
  store.listDeployments.mockResolvedValue([abandoned]);
  drain.liveRunIds.mockResolvedValue(["wrun_a", "wrun_b"]);
  drain.ownedRunCount.mockResolvedValue(1);
  store.pruneDeployments.mockResolvedValue([]);
  const cancel = vi.fn(async (runId: string) => {
    if (runId === "wrun_b") throw new Error("cancel failed: HTTP 500");
  });

  await pruneDeployments(
    { ...pruneDeps(cancel), sleep: noSleep, cancelWaitMs: 1_000 },
    { cancelRuns: true },
  );

  expect(drain.ownedRunCount).toHaveBeenCalledTimes(2);
  expect(lines).toEqual([
    "could not cancel run wrun_b: cancel failed: HTTP 500",
    "kept version v0: it has no process and owns 2 live run(s)",
    "its runs have not ended yet; prune again once they have:",
    "  pnpm exec jigs deployments prune --cancel-runs",
  ]);
});

test("without WORKFLOW_POSTGRES_URL the command says which variable to set", async () => {
  vi.stubEnv("WORKFLOW_POSTGRES_URL", "");
  await expect(listDeployments(deps())).rejects.toThrow("WORKFLOW_POSTGRES_URL is not set");
});
