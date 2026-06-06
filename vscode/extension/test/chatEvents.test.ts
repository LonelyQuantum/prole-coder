import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatEventTimeline,
  createTimelineItem,
  isWorkLogItem,
  presentTimelineItems,
} from "../src/chatEvents.js";
import type { AgentEventEnvelope } from "../src/rpcServer.js";

test("chat timeline merges assistant delta events for the same turn", () => {
  const timeline = new ChatEventTimeline();

  timeline.append(agentEvent(1, "assistant.delta", { text: "hello " }));
  const snapshot = timeline.append(agentEvent(2, "assistant.delta", { text: "world" }));

  assert.equal(snapshot.eventCount, 2);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0]?.kind, "assistant");
  assert.equal(snapshot.items[0]?.body, "hello world");
  assert.equal(snapshot.items[0]?.seq, 1);
  assert.equal(snapshot.items[0]?.lastSeq, 2);
});

test("chat timeline keeps assistant delta events for different turns separate", () => {
  const timeline = new ChatEventTimeline();

  timeline.append(agentEvent(1, "assistant.delta", { text: "first" }, { turnId: "turn_1" }));
  const snapshot = timeline.append(agentEvent(2, "assistant.delta", { text: "second" }, { turnId: "turn_2" }));

  assert.equal(snapshot.items.length, 2);
  assert.deepEqual(
    snapshot.items.map((item) => item.body),
    ["first", "second"],
  );
});

test("chat timeline presents user and DeepSeek messages while folding work events", () => {
  const timeline = new ChatEventTimeline();

  timeline.append(agentEvent(1, "run.started", { mode: "ask" }));
  timeline.append(agentEvent(2, "turn.started", { userTask: "Read the code" }));
  timeline.append(agentEvent(3, "context.built", { inputTokens: 123 }));
  timeline.append(agentEvent(4, "assistant.delta", { text: "I read it." }));
  timeline.append(agentEvent(5, "tool.requested", { name: "read_file" }));
  const snapshot = timeline.append(agentEvent(6, "run.completed", { summary: "I read it." }));

  assert.deepEqual(
    snapshot.visibleItems?.map((item) => item.title),
    ["You", "DeepSeek"],
  );
  assert.deepEqual(
    snapshot.workItems?.map((item) => item.type),
    ["run.started", "context.built", "tool.requested", "run.completed"],
  );
  assert.equal(snapshot.items.find((item) => item.type === "turn.started")?.kind, "user");
});

test("chat timeline hides superseded user messages while retaining audit items", () => {
  const timeline = new ChatEventTimeline();

  timeline.append(agentEvent(1, "turn.started", { userTask: "old request" }));
  const snapshot = timeline.append(
    agentEvent(
      2,
      "turn.started",
      {
        userTask: "edited request",
        supersedes: {
          messageId: "run_1:1",
          turnId: "turn_1",
        },
      },
      { turnId: "turn_2" },
    ),
  );

  assert.deepEqual(
    snapshot.items.map((item) => item.body),
    ["old request", "edited request"],
  );
  assert.deepEqual(snapshot.supersededItemIds, ["run_1:1"]);
  assert.deepEqual(
    snapshot.visibleItems?.map((item) => item.body),
    ["edited request"],
  );
});

test("chat timeline only applies supersedes metadata from turn started events", () => {
  const timeline = new ChatEventTimeline();

  timeline.append(agentEvent(1, "turn.started", { userTask: "old request" }));
  const snapshot = timeline.append(
    agentEvent(2, "provider.completed", {
      supersedes: {
        messageId: "run_1:1",
      },
    }),
  );

  assert.equal(snapshot.supersededItemIds, undefined);
  assert.deepEqual(
    snapshot.visibleItems?.map((item) => item.body),
    ["old request"],
  );
});

test("chat timeline keeps completed summary visible when no assistant message exists", () => {
  const completed = createTimelineItem(agentEvent(1, "run.completed", { summary: "done" }));
  const presentation = presentTimelineItems([completed]);

  assert.deepEqual(
    presentation.visibleItems.map((item) => item.type),
    ["run.completed"],
  );
  assert.equal(presentation.workItems.length, 0);
});

test("chat timeline keeps failure and cancellation visible outside work log", () => {
  const failure = createTimelineItem(agentEvent(1, "run.failed", { message: "boom" }));
  const canceled = createTimelineItem(agentEvent(2, "run.canceled", { reason: "stop" }));
  const presentation = presentTimelineItems([failure, canceled]);

  assert.equal(isWorkLogItem(failure, true), false);
  assert.equal(isWorkLogItem(canceled, true), false);
  assert.deepEqual(
    presentation.visibleItems.map((item) => item.type),
    ["run.failed", "run.canceled"],
  );
  assert.equal(presentation.workItems.length, 0);
});

test("chat timeline renders tool lifecycle and terminal events", () => {
  const timeline = new ChatEventTimeline();

  timeline.append(
    agentEvent(1, "tool.requested", {
      name: "shell",
      risk: "network",
      riskReasons: ["dependency install/update"],
    }),
  );
  timeline.append(agentEvent(2, "tool.started", { name: "shell", toolCallId: "call_1" }));
  timeline.append(
    agentEvent(3, "tool.completed", {
      name: "shell",
      status: "ok",
      summary: "tests passed",
    }),
  );
  const snapshot = timeline.append(
    agentEvent(4, "run.completed", {
      summary: "done",
      changedFiles: ["README.md"],
    }),
  );

  assert.deepEqual(
    snapshot.items.map((item) => item.title),
    ["Tool requested: shell", "Tool started: shell", "Tool completed: shell", "Run completed"],
  );
  assert.equal(snapshot.items[2]?.tone, "success");
  assert.equal(snapshot.items[2]?.defaultCollapsed, true);
  assert.equal(snapshot.items[3]?.kind, "terminal");
  assert.equal(snapshot.items[3]?.defaultCollapsed, undefined);
  assert.equal(snapshot.latestStatus, "Completed");
});

test("chat timeline renders approval and failure events with warning or danger tones", () => {
  const approval = createTimelineItem(
    agentEvent(1, "tool.approvalRequired", {
      toolName: "apply_patch",
      risk: "write",
      title: "Apply patch",
      detail: "Modify README.md",
      paths: ["README.md"],
      riskReasons: ["file deletion"],
    }),
  );
  const failure = createTimelineItem(
    agentEvent(2, "run.failed", {
      code: "E_INVALID_TOOL_ARGUMENTS",
      message: "invalid tool call",
      diagnosticFile: "C:\\workspace\\.prole-coder\\runs\\run_1\\diagnostics\\invalid-tool-arguments-call_1.json",
    }),
  );

  assert.equal(approval.kind, "approval");
  assert.equal(approval.tone, "warning");
  assert.ok(approval.body?.includes("Paths: README.md"));
  assert.ok(approval.body?.includes("Reasons: file deletion"));
  assert.equal(failure.kind, "terminal");
  assert.equal(failure.tone, "danger");
  assert.ok(failure.body?.includes("invalid tool call"));
  assert.ok(failure.body?.includes("Diagnostic file:"));
});

test("chat timeline trims old items while preserving event count", () => {
  const timeline = new ChatEventTimeline({ maxItems: 2 });

  timeline.append(agentEvent(1, "run.started", { mode: "ask" }));
  timeline.append(agentEvent(2, "turn.started", { userTask: "hello" }));
  const snapshot = timeline.append(agentEvent(3, "run.completed", { summary: "done" }));

  assert.equal(snapshot.eventCount, 3);
  assert.deepEqual(
    snapshot.items.map((item) => item.seq),
    [2, 3],
  );
});

test("chat timeline rebuilds assistant indexes after trimming old items", () => {
  const timeline = new ChatEventTimeline({ maxItems: 1 });

  timeline.append(agentEvent(1, "assistant.delta", { text: "old" }));
  timeline.append(agentEvent(2, "run.started", { mode: "ask" }));
  const snapshot = timeline.append(agentEvent(3, "assistant.delta", { text: "new" }));

  assert.equal(snapshot.eventCount, 3);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0]?.seq, 3);
  assert.equal(snapshot.items[0]?.body, "new");
});

test("chat timeline renders raw unknown events with compact payloads", () => {
  const item = createTimelineItem(
    agentEvent(1, "custom.event", {
      message: "unmapped",
    }),
  );

  assert.equal(item.kind, "raw");
  assert.equal(item.title, "custom.event");
  assert.equal(item.defaultCollapsed, true);
  assert.ok(item.body?.includes("unmapped"));
});

test("chat timeline omits empty bodies when event payload has no display fields", () => {
  const item = createTimelineItem(agentEvent(1, "run.started", {}));

  assert.equal(item.kind, "run");
  assert.equal(item.body, undefined);
});

function agentEvent(
  seq: number,
  type: string,
  payload: unknown,
  options: { readonly runId?: string; readonly turnId?: string } = {},
): AgentEventEnvelope {
  return {
    seq,
    time: "1970-01-01T00:00:00.000Z",
    type,
    runId: options.runId ?? "run_1",
    turnId: options.turnId ?? "turn_1",
    payload,
  };
}
