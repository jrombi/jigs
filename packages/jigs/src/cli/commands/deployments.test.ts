import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DeploymentView } from "../../service/deployments/store.ts";
import type { RegistrySql } from "../../steps/runtime/registry.ts";
import { removeTmpDir, useTestFactory } from "../../test-fixtures.ts";
import { layoutProblems } from "../output-layout.ts";
import { listDeployments, makeCurrent, pruneDeployments } from "./deployments.ts";

const store = vi.hoisted(() => ({
  listDeployments: vi.fn(),
  makeDeploymentCurrent: vi.fn(),
  pruneDeployments: vi.fn(),
}));
vi.mock("../../service/deployments/store.ts", () => store);
const drain = vi.hoisted(() => ({ liveRunIds: vi.fn() }));
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
  store.pruneDeployments.mockReset();
  drain.liveRunIds.mockReset();
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
  runs: 0,
  ...fields,
});

test("lists every version with its role, age, runs and process, and points at prune when a version is gone", async () => {
  store.listDeployments.mockResolvedValue([
    view({ version: "v2", runs: 3 }),
    view({ version: "v1", role: "draining", pid: 4100, runs: 1, madeCurrentAt: null }),
    view({ version: "v0", role: "gone", lastSeenAt: null, pid: null, host: null }),
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

const pruneDeps = (cancel = vi.fn(async () => {})) => ({
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

test("prune --cancel-runs cancels a gone version's runs, then forgets it", async () => {
  store.listDeployments.mockResolvedValue([
    view({ version: "v1", role: "draining", runs: 1 }),
    view({ version: "v0", role: "gone", runs: 2 }),
  ]);
  drain.liveRunIds.mockResolvedValue(["wrun_a", "wrun_b"]);
  store.pruneDeployments.mockResolvedValue(["v0"]);
  const cancel = vi.fn(async () => {});

  await pruneDeployments(pruneDeps(cancel), { cancelRuns: true });

  expect(drain.liveRunIds).toHaveBeenCalledWith(expect.anything(), {
    version: "v0",
    jobPrefix: "workflow_",
  });
  expect(cancel.mock.calls).toEqual([["wrun_a"], ["wrun_b"]]);
  expect(lines).toEqual(["removed version v0"]);
});

test("without WORKFLOW_POSTGRES_URL the command says which variable to set", async () => {
  vi.stubEnv("WORKFLOW_POSTGRES_URL", "");
  await expect(listDeployments(deps())).rejects.toThrow("WORKFLOW_POSTGRES_URL is not set");
});
