import assert from "node:assert/strict";
import test from "node:test";

import { reduceEvents } from "../src/timelineReducer.js";

function event(type, payload = {}, overrides = {}) {
  return {
    type,
    runId: "run_1",
    turnId: "turn_1",
    payload,
    ...overrides
  };
}

test("assistant deltas merge for the same turn", () => {
  const state = reduceEvents([
    event("turn.started", { message: "hello" }),
    event("assistant.delta", { text: "Hi" }),
    event("assistant.delta", { text: " there" })
  ]);

  assert.deepEqual(
    state.items.filter((item) => item.kind === "assistant"),
    [{ kind: "assistant", runId: "run_1", turnId: "turn_1", text: "Hi there" }]
  );
});

test("assistant deltas stay separate across turns", () => {
  const state = reduceEvents([
    event("assistant.delta", { text: "first" }, { turnId: "turn_1" }),
    event("assistant.delta", { text: "second" }, { turnId: "turn_2" })
  ]);

  assert.equal(state.items.filter((item) => item.kind === "assistant").length, 2);
});

test("approval completion resolves the pending approval item", () => {
  const state = reduceEvents([
    event("approval.requested", { approvalId: "approval_1", command: "write file" }),
    event("approval.completed", { approvalId: "approval_1", decision: "approved" })
  ]);

  assert.deepEqual(state.items, [
    { kind: "approval", id: "approval_1", status: "approved", command: "write file" }
  ]);
});

test("terminal events clear active run and preserve status", () => {
  const state = reduceEvents([
    event("turn.started", { message: "hello" }),
    event("run.completed", { summary: "done" })
  ]);

  assert.equal(state.activeRunId, undefined);
  assert.deepEqual(state.items.at(-1), { kind: "terminal", status: "completed", runId: "run_1" });
});

test("unknown events are preserved as system items", () => {
  const state = reduceEvents([event("provider.completed", { model: "synthetic-model" })]);

  assert.deepEqual(state.items, [{ kind: "system", text: "provider.completed" }]);
});
