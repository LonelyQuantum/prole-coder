import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_RUN_MODES,
  DEFAULT_CHAT_MODE,
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

test("chat input rejects empty messages and invalid modes", () => {
  assert.deepEqual(parseChatTurnSubmission({ message: "  ", mode: "edit" }), {
    ok: false,
    error: "Enter a message before sending.",
  });
  assert.deepEqual(parseChatTurnSubmission({ message: "hello", mode: "invalid" }), {
    ok: false,
    error: "Choose a valid run mode.",
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
});
