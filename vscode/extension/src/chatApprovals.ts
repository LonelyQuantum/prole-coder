import {
  APPROVAL_REJECTED_REASON,
  type ApprovalPromptDecision,
  type ApprovalPromptHunk,
  type ApprovalPromptRequest,
} from "./commands";

export interface ChatApprovalSnapshot {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly risk: string;
  readonly title: string;
  readonly detail: string;
  readonly persistable: boolean;
  readonly command?: string;
  readonly cwd?: string;
  readonly outputSummary?: string;
  readonly paths?: readonly string[];
  readonly riskReasons?: readonly string[];
  readonly hunks?: readonly ChatApprovalHunkSnapshot[];
}

export interface ChatApprovalHunkSnapshot extends ApprovalPromptHunk {}

export function chatApprovalSnapshotFromRequest(
  request: ApprovalPromptRequest,
): ChatApprovalSnapshot {
  return {
    approvalId: request.approvalId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    risk: request.risk,
    title: request.title,
    detail: request.detail,
    persistable: request.persistable,
    ...(request.command === undefined ? {} : { command: request.command }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.outputSummary === undefined ? {} : { outputSummary: request.outputSummary }),
    ...(request.paths === undefined ? {} : { paths: request.paths }),
    ...(request.riskReasons === undefined ? {} : { riskReasons: request.riskReasons }),
    ...(request.hunks === undefined
      ? {}
      : {
          hunks: request.hunks.map((hunk) => ({ ...hunk })),
        }),
  };
}

export function approvalDecisionFromWebviewMessage(
  message: unknown,
  request: ApprovalPromptRequest,
): ApprovalPromptDecision | undefined {
  if (!isRecord(message) || message["type"] !== "approvalDecision") {
    return undefined;
  }

  if (message["approvalId"] !== request.approvalId) {
    return undefined;
  }

  if (message["decision"] === "reject") {
    return {
      kind: "reject",
      approvalId: request.approvalId,
      reason: APPROVAL_REJECTED_REASON,
    };
  }

  if (message["decision"] !== "approve") {
    return undefined;
  }

  const approvedHunks = approvedHunkIdsFromMessage(message["approvedHunks"], request);
  if (approvedHunks !== undefined && approvedHunks.length === 0) {
    return {
      kind: "reject",
      approvalId: request.approvalId,
      reason: "no patch hunks selected in VS Code",
    };
  }

  const allHunkCount = request.hunks?.length ?? 0;
  const partialHunks =
    approvedHunks !== undefined && approvedHunks.length > 0 && approvedHunks.length < allHunkCount
      ? {
          hunks: {
            approved: approvedHunks,
          },
        }
      : {};

  return {
    kind: "approve",
    approvalId: request.approvalId,
    persist: "never",
    ...partialHunks,
  };
}

function approvedHunkIdsFromMessage(
  value: unknown,
  request: ApprovalPromptRequest,
): readonly string[] | undefined {
  if (!Array.isArray(value) || request.hunks === undefined || request.hunks.length === 0) {
    return undefined;
  }

  const knownHunks = new Set(request.hunks.map((hunk) => hunk.id));
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !knownHunks.has(entry) || seen.has(entry)) {
      continue;
    }

    seen.add(entry);
    selected.push(entry);
  }

  return selected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
