import type { ListRunsResult, RunSummary } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

export const RUN_LIST_LIMIT = 20;

export type RunListStatus = "idle" | "loading" | "ready" | "failed";

export interface RunListSnapshot {
  readonly status: RunListStatus;
  readonly runs: readonly RunSummary[];
  readonly selectedRunId?: string;
  readonly message?: string;
}

export interface RefreshRunsMessage {
  readonly type: "refreshRuns";
}

export interface ResumeRunMessage {
  readonly type: "resumeRun";
  readonly runId: string;
}

export interface DeleteRunMessage {
  readonly type: "deleteRun";
  readonly runId: string;
}

export function idleRunList(): RunListSnapshot {
  return {
    status: "idle",
    runs: [],
  };
}

export function loadingRunList(
  previous: RunListSnapshot = idleRunList(),
  message = "Loading runs...",
): RunListSnapshot {
  return {
    status: "loading",
    runs: previous.runs,
    ...(previous.selectedRunId === undefined ? {} : { selectedRunId: previous.selectedRunId }),
    message,
  };
}

export function readyRunList(
  result: ListRunsResult,
  selectedRunId?: string,
  message?: string,
): RunListSnapshot {
  const runs = [...result.runs];
  const selected = selectedRunId !== undefined && runs.some((run) => run.runId === selectedRunId)
    ? selectedRunId
    : undefined;
  return {
    status: "ready",
    runs,
    ...(selected === undefined ? {} : { selectedRunId: selected }),
    ...(message === undefined ? {} : { message }),
  };
}

export function failedRunList(
  message: string,
  previous: RunListSnapshot = idleRunList(),
): RunListSnapshot {
  return {
    status: "failed",
    runs: previous.runs,
    ...(previous.selectedRunId === undefined ? {} : { selectedRunId: previous.selectedRunId }),
    message,
  };
}

export function isRefreshRunsMessage(message: unknown): message is RefreshRunsMessage {
  return isRecord(message) && message["type"] === "refreshRuns";
}

export function resumeRunIdFromMessage(message: unknown): string | undefined {
  if (!isRecord(message) || message["type"] !== "resumeRun") {
    return undefined;
  }

  const runId = message["runId"];
  if (typeof runId !== "string") {
    return undefined;
  }

  const trimmed = runId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function deleteRunIdFromMessage(message: unknown): string | undefined {
  if (!isRecord(message) || message["type"] !== "deleteRun") {
    return undefined;
  }

  const runId = message["runId"];
  if (typeof runId !== "string") {
    return undefined;
  }

  const trimmed = runId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
