import type { ProleLogger } from "./logging";
import type { MessageRedactor } from "./redaction";
import { passthroughRedactor } from "./redaction";

export interface ExtensionNotifier {
  info(message: string): unknown;
  warn(message: string): unknown;
  error(message: string): unknown;
}

export interface ToastMessenger {
  showInformationMessage(message: string): unknown;
  showWarningMessage(message: string): unknown;
}

export function createExtensionNotifier(
  logger: ProleLogger,
  window: ToastMessenger,
  redactor: MessageRedactor = passthroughRedactor,
): ExtensionNotifier {
  return {
    info(message) {
      const redacted = redactor.redact(message);
      logger.info(redacted);
      return window.showInformationMessage(redacted);
    },
    warn(message) {
      const redacted = redactor.redact(message);
      logger.warn(redacted);
      return window.showWarningMessage(redacted);
    },
    error(message) {
      const redacted = redactor.redact(message);
      logger.error(redacted);
      return window.showWarningMessage(redacted);
    },
  };
}
