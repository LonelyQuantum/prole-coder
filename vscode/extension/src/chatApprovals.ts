import {
  APPROVAL_REJECTED_REASON,
  type ApprovalPromptDecision,
  type ApprovalPromptHunk,
  type ApprovalPromptRequest,
} from "./commands";

const APPROVAL_DISPLAY_TEXT_LIMIT = 1200;
const APPROVAL_TRUNCATED_NOTICE = "\n[truncated for sidebar; see Output or run logs for full text]";

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
    title: truncateDisplayText(request.title),
    detail: approvalDetailForSnapshot(request),
    persistable: request.persistable,
    ...(request.command === undefined ? {} : { command: truncateDisplayText(request.command) }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.outputSummary === undefined
      ? {}
      : { outputSummary: truncateDisplayText(request.outputSummary) }),
    ...(request.paths === undefined ? {} : { paths: request.paths }),
    ...(request.riskReasons === undefined ? {} : { riskReasons: request.riskReasons }),
    ...(request.hunks === undefined
      ? {}
      : {
          hunks: request.hunks.map((hunk) => ({ ...hunk })),
        }),
  };
}

function approvalDetailForSnapshot(request: ApprovalPromptRequest): string {
  if (isDuplicatedCommandDetail(request.detail, request.command)) {
    return "";
  }

  return truncateDisplayText(request.detail);
}

function isDuplicatedCommandDetail(detail: string, command: string | undefined): boolean {
  if (command === undefined || command.length === 0) {
    return false;
  }

  const match = detail.trim().match(/^Execute `([\s\S]*)`$/);
  return match?.[1] === command;
}

function truncateDisplayText(value: string): string {
  if (value.length <= APPROVAL_DISPLAY_TEXT_LIMIT) {
    return value;
  }

  const sliceLength = Math.max(0, APPROVAL_DISPLAY_TEXT_LIMIT - APPROVAL_TRUNCATED_NOTICE.length);
  return `${value.slice(0, sliceLength)}${APPROVAL_TRUNCATED_NOTICE}`;
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
