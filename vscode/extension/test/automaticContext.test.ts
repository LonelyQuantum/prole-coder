import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticContextAttachmentFromMessages,
  automaticContextAttachmentFromTimeline,
  isAutomaticContextAttachment,
  mergeTurnAttachments,
} from "../src/automaticContext.js";

test("automatic context attachment compacts older messages and preserves recent entries", () => {
  const attachment = automaticContextAttachmentFromMessages(
    [
      { role: "user", text: "first user request\nwith detail" },
      { role: "assistant", text: "first assistant response" },
      { role: "user", text: "latest request" },
      { role: "assistant", text: "latest response" },
    ],
    { recentMessages: 2, maxChars: 2000 },
  );

  assert.ok(attachment);
  assert.equal(attachment.kind, "explicit_content");
  assert.ok(isAutomaticContextAttachment(attachment));
  assert.ok(attachment.text?.includes("Compacted entries: 2"));
  assert.ok(attachment.text?.includes("User:\nlatest request"));
  assert.ok(attachment.text?.includes("Assistant:\nlatest response"));
});

test("automatic context attachment respects its character budget", () => {
  const attachment = automaticContextAttachmentFromMessages(
    [
      { role: "user", text: "x".repeat(200) },
      { role: "assistant", text: "y".repeat(200) },
    ],
    { maxChars: 120, recentMessages: 2 },
  );

  assert.ok(attachment?.text);
  assert.equal(attachment.text.length <= 120, true);
  assert.ok(attachment.text.includes("automatic context clipped"));
});

test("automatic context attachment returns undefined for empty history", () => {
  assert.equal(automaticContextAttachmentFromMessages([]), undefined);
  assert.equal(
    automaticContextAttachmentFromMessages([{ role: "user", text: "   " }]),
    undefined,
  );
});

test("automatic context can be built from sidebar timeline snapshots", () => {
  const attachment = automaticContextAttachmentFromTimeline({
    eventCount: 3,
    latestRunId: "run_1",
    items: [
      {
        id: "1",
        seq: 1,
        lastSeq: 1,
        time: "1970-01-01T00:00:00.000Z",
        type: "turn.started",
        runId: "run_1",
        kind: "turn",
        tone: "running",
        title: "Turn started",
        body: "Fix README",
      },
      {
        id: "2",
        seq: 2,
        lastSeq: 2,
        time: "1970-01-01T00:00:01.000Z",
        type: "assistant.delta",
        runId: "run_1",
        kind: "assistant",
        tone: "neutral",
        title: "Assistant",
        body: "README updated.",
      },
    ],
  });

  assert.ok(attachment?.text?.includes("Fix README"));
  assert.ok(attachment?.text?.includes("README updated."));
});

test("automatic context caps oversized sidebar timeline messages before compression", () => {
  const attachment = automaticContextAttachmentFromTimeline(
    {
      eventCount: 1,
      latestRunId: "run_1",
      items: [
        {
          id: "1",
          seq: 1,
          lastSeq: 1,
          time: "1970-01-01T00:00:00.000Z",
          type: "assistant.delta",
          runId: "run_1",
          kind: "assistant",
          tone: "neutral",
          title: "Assistant",
          body: "a".repeat(12_000),
        },
      ],
    },
    { maxChars: 20_000, recentMessages: 1 },
  );

  assert.ok(attachment?.text);
  assert.equal(attachment.text.length < 9_000, true);
  assert.ok(attachment.text.includes("automatic context clipped"));
});

test("mergeTurnAttachments reserves one slot for automatic context", () => {
  const automaticContext = automaticContextAttachmentFromMessages([
    { role: "user", text: "previous" },
  ]);
  const attachments = Array.from({ length: 32 }, (_, index) => ({
    kind: "explicit_content" as const,
    text: `manual ${index}`,
  }));

  const merged = mergeTurnAttachments(automaticContext, attachments);

  assert.equal(merged.length, 32);
  assert.equal(merged[0], automaticContext);
  assert.equal(merged[31]?.text, "manual 30");
});
