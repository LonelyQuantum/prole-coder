import assert from "node:assert/strict";
import test from "node:test";

import {
  RUN_LIST_LIMIT,
  failedRunList,
  idleRunList,
  isRefreshRunsMessage,
  deleteRunIdFromMessage,
  loadingRunList,
  readyRunList,
  resumeRunIdFromMessage,
} from "../src/runHistory.js";

test("run history snapshots keep previous runs while loading and failed", () => {
  const ready = readyRunList({ runs: [runSummary("run_1"), runSummary("run_2")] }, "run_2");

  assert.deepEqual(loadingRunList(ready, "Refreshing runs..."), {
    status: "loading",
    runs: [runSummary("run_1"), runSummary("run_2")],
    selectedRunId: "run_2",
    message: "Refreshing runs...",
  });
  assert.deepEqual(failedRunList("Failed to load runs.", ready), {
    status: "failed",
    runs: [runSummary("run_1"), runSummary("run_2")],
    selectedRunId: "run_2",
    message: "Failed to load runs.",
  });
});

test("run history ready snapshots only keep a selected run that still exists", () => {
  assert.deepEqual(readyRunList({ runs: [runSummary("run_1")] }, "run_1"), {
    status: "ready",
    runs: [runSummary("run_1")],
    selectedRunId: "run_1",
  });
  assert.deepEqual(readyRunList({ runs: [runSummary("run_1")] }, "missing"), {
    status: "ready",
    runs: [runSummary("run_1")],
  });
});

test("run history leaves result limiting to the RPC server", () => {
  const runs = Array.from({ length: RUN_LIST_LIMIT + 1 }, (_, index) => runSummary(`run_${index}`));

  assert.equal(readyRunList({ runs }).runs.length, RUN_LIST_LIMIT + 1);
});

test("run history parses refresh, resume, and delete webview messages defensively", () => {
  assert.equal(RUN_LIST_LIMIT, 20);
  assert.equal(isRefreshRunsMessage({ type: "refreshRuns" }), true);
  assert.equal(isRefreshRunsMessage({ type: "refreshRuns", runId: "run_1" }), true);
  assert.equal(isRefreshRunsMessage({ type: "resumeRun" }), false);
  assert.equal(resumeRunIdFromMessage({ type: "resumeRun", runId: " run_1 " }), "run_1");
  assert.equal(resumeRunIdFromMessage({ type: "resumeRun", runId: " " }), undefined);
  assert.equal(resumeRunIdFromMessage({ type: "resumeRun", runId: 1 }), undefined);
  assert.equal(deleteRunIdFromMessage({ type: "deleteRun", runId: " run_1 " }), "run_1");
  assert.equal(deleteRunIdFromMessage({ type: "deleteRun", runId: " " }), undefined);
  assert.equal(deleteRunIdFromMessage({ type: "deleteRun", runId: 1 }), undefined);
  assert.equal(resumeRunIdFromMessage(idleRunList()), undefined);
  assert.equal(deleteRunIdFromMessage(idleRunList()), undefined);
});

function runSummary(runId: string) {
  return {
    runId,
    title: `Run ${runId}`,
    status: "completed" as const,
    startedAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:01.000Z",
    completedAt: "1970-01-01T00:00:01.000Z",
    lastSeq: 4,
    eventCount: 4,
  };
}
