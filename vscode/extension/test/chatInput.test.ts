import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_RUN_MODES,
  DEFAULT_CHAT_MODE,
  inferChatRunMode,
  isRpcRunMode,
  parseChatTurnSubmission,
  sendTurnParams,
} from "../src/chatInput.js";

test("chat input accepts trimmed messages with valid run modes", () => {
  const parsed = parseChatTurnSubmission({
    message: "  update docs  ",
    mode: "edit",
  });

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value, {
      message: "update docs",
      mode: "edit",
    });
    assert.deepEqual(sendTurnParams(parsed.value), {
      message: "update docs",
      mode: "edit",
    });
  }
});

test("chat input infers run mode when the sidebar omits the hidden selector value", () => {
  const samples: Array<readonly [string, string]> = [
    ["why does this fail?", "ask"],
    ["is this task complete?", "ask"],
    ["should I add more tests?", "ask"],
    ["制定一个开发计划", "plan"],
    ["修复测试失败", "edit"],
    ["fix the bug where the app crashes", "edit"],
    ["review the current changes", "review"],
    ["继续处理这个任务", "edit"],
  ];

  for (const [message, mode] of samples) {
    const parsed = parseChatTurnSubmission({ message });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.mode, mode);
      assert.equal(sendTurnParams(parsed.value).mode, mode);
    }
  }
});

test("chat input strips explicit run mode prefixes before sending", () => {
  const slash = parseChatTurnSubmission({ message: "  /ask explain the logs  " });
  assert.equal(slash.ok, true);
  if (slash.ok) {
    assert.deepEqual(slash.value, {
      message: "explain the logs",
      mode: "ask",
    });
  }

  const label = parseChatTurnSubmission({ message: "plan: split the backlog", mode: "edit" });
  assert.equal(label.ok, true);
  if (label.ok) {
    assert.deepEqual(label.value, {
      message: "split the backlog",
      mode: "plan",
    });
  }
});

test("chat input forwards edit resend supersede metadata", () => {
  const parsed = parseChatTurnSubmission({
    message: "  updated request  ",
    mode: "edit",
    supersedes: {
      messageId: "  run_1:2  ",
      turnId: "  turn_1  ",
    },
  });

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(sendTurnParams(parsed.value), {
      message: "updated request",
      mode: "edit",
      supersedes: {
        messageId: "run_1:2",
        turnId: "turn_1",
      },
    });
  }
});

test("chat input rejects empty messages and invalid modes", () => {
  assert.deepEqual(parseChatTurnSubmission({ message: "  ", mode: "edit" }), {
    ok: false,
    error: "Enter a message before sending.",
  });
  assert.deepEqual(parseChatTurnSubmission({ message: "hello", mode: "invalid" }), {
    ok: false,
    error: "Choose a valid run mode.",
  });
  assert.deepEqual(parseChatTurnSubmission({ message: "hello", mode: "edit", supersedes: {} }), {
    ok: false,
    error: "Invalid edit resend metadata.",
  });
  assert.deepEqual(parseChatTurnSubmission({ message: "/review", mode: "edit" }), {
    ok: false,
    error: "Enter a message after the run mode prefix.",
  });
});

test("chat input forwards diagnostic attachments into sendTurn params", () => {
  assert.deepEqual(
    sendTurnParams(
      {
        message: "fix diagnostics",
        mode: "edit",
      },
      [
        {
          kind: "diagnostic",
          path: "src/lib.rs",
          text: "Severity: error\nMessage: unused import",
        },
      ],
    ),
    {
      message: "fix diagnostics",
      mode: "edit",
      attachments: [
        {
          kind: "diagnostic",
          path: "src/lib.rs",
          text: "Severity: error\nMessage: unused import",
        },
      ],
    },
  );
});

test("chat input exposes protocol run modes and default mode", () => {
  assert.equal(DEFAULT_CHAT_MODE, "edit");
  assert.deepEqual([...CHAT_RUN_MODES], ["edit", "ask", "plan", "review"]);
  assert.equal(isRpcRunMode("ask"), true);
  assert.equal(isRpcRunMode("debug"), false);
  assert.equal(inferChatRunMode("Can you explain this file?"), "ask");
  assert.equal(inferChatRunMode("代码审查一下当前改动"), "review");
});
