import assert from "node:assert/strict";
import test from "node:test";

import { createOutputLogger, formatLogLine } from "../src/logging.js";

test("formatLogLine includes timestamp, level, and full message", () => {
  assert.equal(
    formatLogLine(
      "error",
      "Failed to send turn: DeepSeek provider configuration failed.",
      new Date("2026-05-31T00:00:00.000Z"),
    ),
    "[2026-05-31T00:00:00.000Z] ERROR Failed to send turn: DeepSeek provider configuration failed.",
  );
});

test("createOutputLogger appends all log levels to the output sink", () => {
  const lines: string[] = [];
  const logger = createOutputLogger(
    {
      appendLine(value) {
        lines.push(value);
      },
    },
    () => new Date("2026-05-31T00:00:00.000Z"),
  );

  logger.info("RPC initialized.");
  logger.warn("RPC stderr preview.");
  logger.error("Failed to load runs.");

  assert.deepEqual(lines, [
    "[2026-05-31T00:00:00.000Z] INFO RPC initialized.",
    "[2026-05-31T00:00:00.000Z] WARN RPC stderr preview.",
    "[2026-05-31T00:00:00.000Z] ERROR Failed to load runs.",
  ]);
});
