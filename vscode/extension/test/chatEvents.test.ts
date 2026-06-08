import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatEventTimeline,
  createTimelineItem,
  isPersistentTimelineItem,
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

test("chat timeline splits assistant messages across tool work and inserts compact activity summaries", () => {
  const timeline = new ChatEventTimeline();

  timeline.append(agentEvent(1, "turn.started", { userTask: "Fix the project" }));
  timeline.append(agentEvent(2, "assistant.delta", { text: "I will inspect the code." }));
  timeline.append(agentEvent(3, "tool.completed", { name: "read_file", status: "ok", summary: "Read README.md." }));
  timeline.append(
    agentEvent(4, "tool.completed", {
      name: "shell",
      status: "ok",
      summary: "tests failed",
    }),
  );
  timeline.append(
    agentEvent(5, "tool.completed", {
      name: "apply_patch",
      result: {
        files: ["src/lib.rs", "README.md"],
      },
      status: "ok",
      summary: "applied patch",
    }),
  );
  const snapshot = timeline.append(agentEvent(6, "assistant.delta", { text: "Done." }));

  assert.deepEqual(
    snapshot.items.map((item) => item.title),
    ["You", "DeepSeek", "Tool completed: read_file", "Tool completed: shell", "Tool completed: apply_patch", "DeepSeek"],
  );
  assert.deepEqual(
    snapshot.visibleItems?.map((item) => item.title),
    ["You", "DeepSeek", "Activity", "DeepSeek"],
  );
  assert.equal(snapshot.visibleItems?.[2]?.body, "Modified 2 files, ran 1 command.");
});

test("chat timeline keeps steer messages before later assistant segments", () => {
  const timeline = new ChatEventTimeline();

  timeline.append(agentEvent(1, "assistant.delta", { text: "Working." }));
  timeline.append(agentEvent(2, "tool.completed", { name: "shell", status: "ok", summary: "tests passed" }));
  timeline.append(agentEvent(3, "turn.steered", { steerId: "steer_1", message: "Please summarize in Chinese." }));
  const snapshot = timeline.append(agentEvent(4, "assistant.delta", { text: "好的。" }));

  assert.deepEqual(
    snapshot.visibleItems?.map((item) => item.title),
    ["DeepSeek", "Activity", "You", "DeepSeek"],
  );
  assert.deepEqual(
    snapshot.visibleItems?.map((item) => item.body),
    ["Working.", "Modified 0 files, ran 1 command.", "Please summarize in Chinese.", "好的。"],
  );
  assert.equal(snapshot.visibleItems?.[2]?.steerId, "steer_1");
});

test("chat timeline groups completed intermediate assistant and activity items", () => {
  const timeline = new ChatEventTimeline();

  timeline.append(agentEvent(1, "turn.started", { userTask: "Fix everything" }));
  timeline.append(agentEvent(2, "assistant.delta", { text: "I will inspect." }));
  timeline.append(agentEvent(3, "tool.completed", { name: "shell", status: "ok", summary: "tests failed" }));
  timeline.append(agentEvent(4, "turn.steered", { steerId: "steer_1", message: "Use Chinese." }));
  timeline.append(agentEvent(5, "assistant.delta", { text: "I will continue." }));
  timeline.append(
    agentEvent(6, "tool.completed", {
      name: "apply_patch",
      result: {
        files: ["src/lib.rs"],
      },
      status: "ok",
      summary: "patched",
    }),
  );
  timeline.append(agentEvent(7, "assistant.delta", { text: "最终总结。" }));
  const snapshot = timeline.append(agentEvent(8, "run.completed", { summary: "最终总结。" }));

  assert.deepEqual(
    snapshot.visibleItems?.map((item) => item.title),
    ["You", "Earlier activity", "You", "Earlier activity", "DeepSeek"],
  );
  assert.equal(snapshot.visibleItems?.[1]?.type, "run.intermediate");
  assert.equal(snapshot.visibleItems?.[1]?.defaultCollapsed, true);
  assert.equal(snapshot.visibleItems?.[1]?.body, "Collapsed 2 timeline items.\nStarts with: I will inspect.");
  assert.deepEqual(
    snapshot.visibleItems?.[1]?.children?.map((item) => item.title),
    ["DeepSeek", "Activity"],
  );
  assert.equal(snapshot.visibleItems?.[2]?.body, "Use Chinese.");
  assert.equal(snapshot.visibleItems?.[2]?.steerId, "steer_1");
  assert.deepEqual(
    snapshot.visibleItems?.[3]?.children?.map((item) => item.body),
    ["I will continue.", "Modified 1 file, ran 0 commands."],
  );
  assert.equal(snapshot.visibleItems?.[4]?.defaultCollapsed, undefined);
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

test("chat timeline annotates work events with command and changed file counts", () => {
  const shell = createTimelineItem(
    agentEvent(1, "tool.completed", {
      name: "shell",
      status: "failed",
      summary: "command failed",
    }),
  );
  const patch = createTimelineItem(
    agentEvent(2, "tool.completed", {
      name: "apply_patch",
      result: {
        files: ["src/lib.rs", "README.md"],
      },
      status: "ok",
      summary: "applied patch",
    }),
  );
  const failedPatch = createTimelineItem(
    agentEvent(3, "tool.completed", {
      name: "apply_patch",
      result: {
        files: ["ignored.md"],
      },
      status: "failed",
      summary: "patch failed",
    }),
  );
  assert.equal(shell.commandCount, 1);
  assert.equal(shell.changedFileCount, undefined);
  assert.equal(patch.commandCount, undefined);
  assert.equal(patch.changedFileCount, 2);
  assert.equal(failedPatch.changedFileCount, undefined);
});

test("chat timeline renders provider retry events as collapsed work log items", () => {
  const item = createTimelineItem(
    agentEvent(1, "provider.retrying", {
      iteration: 4,
      reason: "transient_stream_error",
      timeoutMs: 60000,
      retriesRemaining: 1,
      partialContentChars: 128,
      message: "connection reset",
    }),
  );

  assert.equal(item.kind, "provider");
  assert.equal(item.tone, "warning");
  assert.equal(item.title, "Provider retrying");
  assert.equal(item.defaultCollapsed, true);
  assert.ok(item.body?.includes("Timeout: 60000ms"));
  assert.ok(item.body?.includes("Retries remaining: 1"));
  assert.ok(item.body?.includes("Partial content: 128 chars"));
  assert.equal(isWorkLogItem(item, true), true);
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

test("chat timeline truncates long approval commands for sidebar rendering", () => {
  const command = `Set-Content -Path script.py -Value '${"print(1)\\n".repeat(400)}'`;
  const item = createTimelineItem(
    agentEvent(1, "tool.approvalRequired", {
      toolName: "shell",
      risk: "exec",
      title: "Run shell command",
      command,
    }),
  );

  assert.ok(item.body);
  assert.ok(item.body.length < command.length);
  assert.ok(item.body.includes("[truncated for sidebar"));
  assert.equal(item.body.includes("print(1)\\n".repeat(300)), false);
});

test("chat timeline trims old process items while preserving persistent messages", () => {
  const timeline = new ChatEventTimeline({ maxItems: 1 });

  timeline.append(agentEvent(1, "run.started", { mode: "ask" }));
  timeline.append(agentEvent(2, "turn.started", { userTask: "hello" }));
  timeline.append(agentEvent(3, "assistant.delta", { text: "working" }));
  timeline.append(agentEvent(4, "context.built", { inputTokens: 123 }));
  const snapshot = timeline.append(agentEvent(5, "run.completed", { summary: "done" }));

  assert.equal(snapshot.eventCount, 5);
  assert.deepEqual(
    snapshot.items.map((item) => item.seq),
    [2, 3, 4, 5],
  );
  assert.deepEqual(
    snapshot.items.map((item) => isPersistentTimelineItem(item)),
    [true, true, false, true],
  );
  assert.equal(snapshot.hiddenProcessItemCount, 1);
  assert.equal(snapshot.oldestLoadedSeq, 1);
});

test("chat timeline can reveal hidden process items from loaded run events", () => {
  const timeline = new ChatEventTimeline({ maxItems: 1 });

  timeline.append(agentEvent(1, "run.started", { mode: "ask" }));
  timeline.append(agentEvent(2, "turn.started", { userTask: "hello" }));
  timeline.append(agentEvent(3, "assistant.delta", { text: "working" }));
  timeline.append(agentEvent(4, "context.built", { inputTokens: 123 }));
  timeline.append(agentEvent(5, "run.completed", { summary: "done" }));
  const snapshot = timeline.revealHiddenProcessItems();

  assert.deepEqual(
    snapshot.items.map((item) => item.seq),
    [1, 2, 3, 4, 5],
  );
  assert.equal(snapshot.hiddenProcessItemCount, undefined);
});

test("chat timeline prepends older run log events before current items", () => {
  const timeline = new ChatEventTimeline({ maxItems: 10 });

  timeline.append(agentEvent(3, "assistant.delta", { text: "later" }));
  timeline.append(agentEvent(4, "run.completed", { summary: "done" }));
  const snapshot = timeline.prepend([
    agentEvent(1, "turn.started", { userTask: "hello" }),
    agentEvent(2, "context.built", { inputTokens: 123 }),
  ]);

  assert.deepEqual(
    snapshot.items.map((item) => item.seq),
    [1, 2, 3, 4],
  );
  assert.equal(snapshot.oldestLoadedSeq, 1);
});

test("chat timeline keeps assistant segment boundaries after trimming process items", () => {
  const timeline = new ChatEventTimeline({ maxItems: 1 });

  timeline.append(agentEvent(1, "assistant.delta", { text: "old" }));
  timeline.append(agentEvent(2, "tool.completed", { name: "shell", status: "ok", summary: "tests passed" }));
  timeline.append(agentEvent(3, "context.built", { inputTokens: 123 }));
  const snapshot = timeline.append(agentEvent(4, "assistant.delta", { text: "new" }));

  assert.equal(snapshot.eventCount, 4);
  assert.deepEqual(
    snapshot.items.map((item) => item.seq),
    [1, 3, 4],
  );
  assert.deepEqual(
    snapshot.items.filter((item) => item.kind === "assistant").map((item) => item.body),
    ["old", "new"],
  );
});

test("chat timeline keeps long run conversation boundaries after process trimming", () => {
  const timeline = new ChatEventTimeline({ maxItems: 3 });

  timeline.append(agentEvent(1, "turn.started", { userTask: "Initial request" }));
  timeline.append(agentEvent(2, "assistant.delta", { text: "I will inspect." }));
  for (let seq = 3; seq < 12; seq += 1) {
    timeline.append(agentEvent(seq, "tool.completed", { name: "read_file", status: "ok", summary: `Read ${seq}.` }));
  }
  timeline.append(agentEvent(12, "turn.steered", { steerId: "steer_1", message: "Use Chinese." }));
  timeline.append(agentEvent(13, "assistant.delta", { text: "I will continue." }));
  timeline.append(
    agentEvent(14, "tool.completed", {
      name: "apply_patch",
      result: {
        files: ["src/lib.rs"],
      },
      status: "ok",
      summary: "patched",
    }),
  );
  timeline.append(agentEvent(15, "assistant.delta", { text: "Final summary." }));
  const snapshot = timeline.append(agentEvent(16, "run.completed", { summary: "Final summary." }));

  assert.deepEqual(
    snapshot.items.filter((item) => item.kind === "user").map((item) => item.body),
    ["Initial request", "Use Chinese."],
  );
  assert.deepEqual(
    snapshot.visibleItems?.filter((item) => item.kind === "user").map((item) => item.body),
    ["Initial request", "Use Chinese."],
  );
  assert.deepEqual(
    snapshot.visibleItems?.map((item) => item.title),
    ["You", "Earlier activity", "You", "Earlier activity", "DeepSeek"],
  );
  assert.deepEqual(
    snapshot.visibleItems?.[1]?.children?.map((item) => item.title),
    ["DeepSeek"],
  );
  assert.deepEqual(
    snapshot.visibleItems?.[3]?.children?.map((item) => item.title),
    ["DeepSeek", "Activity"],
  );
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
