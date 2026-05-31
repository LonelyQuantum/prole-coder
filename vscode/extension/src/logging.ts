export type ProleLogLevel = "error" | "info" | "warn";

export interface ProleLogger {
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface OutputAppender {
  appendLine(value: string): unknown;
}

export function createOutputLogger(
  output: OutputAppender,
  now: () => Date = () => new Date(),
): ProleLogger {
  return {
    error(message) {
      output.appendLine(formatLogLine("error", message, now()));
    },
    info(message) {
      output.appendLine(formatLogLine("info", message, now()));
    },
    warn(message) {
      output.appendLine(formatLogLine("warn", message, now()));
    },
  };
}

export function formatLogLine(level: ProleLogLevel, message: string, time: Date): string {
  return `[${time.toISOString()}] ${level.toUpperCase()} ${message}`;
}
