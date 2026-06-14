import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionNotifier } from "../src/notifier.js";
import { MutableSecretRedactor } from "../src/redaction.js";

test("extension notifier redacts secret values before logging and showing toasts", () => {
  const logger = new FakeLogger();
  const window = new FakeWindow();
  const redactor = new MutableSecretRedactor();
  redactor.update(["fixture-secret"]);

  const notifier = createExtensionNotifier(logger, window, redactor);
  notifier.info("using fixture-secret");
  notifier.warn("warn fixture-secret");
  notifier.error("error fixture-secret");

  assert.deepEqual(logger.infos, ["using [redacted]"]);
  assert.deepEqual(logger.warnings, ["warn [redacted]"]);
  assert.deepEqual(logger.errors, ["error [redacted]"]);
  assert.deepEqual(window.infos, ["using [redacted]"]);
  assert.deepEqual(window.warnings, ["warn [redacted]", "error [redacted]"]);
});

class FakeLogger {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  info(message: string): void {
    this.infos.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}

class FakeWindow {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];

  showInformationMessage(message: string): void {
    this.infos.push(message);
  }

  showWarningMessage(message: string): void {
    this.warnings.push(message);
  }
}
