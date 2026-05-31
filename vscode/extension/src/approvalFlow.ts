import type {
  ApprovalPersistence,
  ApproveParams,
  ApproveResult,
  RejectParams,
  RejectResult,
  RiskLevel,
  ToolApprovalRequiredPayload,
  ToolName,
} from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

import {
  type ApprovalPromptDecision,
  type ApprovalPromptRequest,
  type ApprovalWindowMessenger,
  requestApproval,
} from "./commands";
import type { AgentEventEnvelope, DisposableLike } from "./rpcServer";

const APPROVAL_EVENT_TYPE = "tool.approvalRequired";
const MAX_REMEMBERED_APPROVALS = 100;

const RISK_LOOKUP = {
  read: true,
  write: true,
  exec: true,
  network: true,
  destructive: true,
} as const satisfies Record<RiskLevel, true>;

const TOOL_NAME_LOOKUP = {
  workspace_manifest: true,
  read_file: true,
  search: true,
  apply_patch: true,
  shell: true,
  git_status: true,
  git_diff: true,
  lsp_diagnostics: true,
  plan_update: true,
} as const satisfies Record<ToolName, true>;

export interface ApprovalRpcClient {
  onEvent(handler: (event: AgentEventEnvelope) => void): DisposableLike;
  approve(params: ApproveParams): Promise<ApproveResult>;
  reject(params: RejectParams): Promise<RejectResult>;
}

export interface ApprovalNotifier {
  warn(message: string): unknown;
}

export type ApprovalRequester = (
  window: ApprovalWindowMessenger,
  request: ApprovalPromptRequest,
) => Promise<ApprovalPromptDecision>;

export interface ApprovalPreviewer {
  prepareApproval(event: AgentEventEnvelope, request: ApprovalPromptRequest): Promise<unknown>;
}

export class ApprovalEventController implements DisposableLike {
  private readonly activeApprovalKeys = new Set<string>();
  private readonly rememberedApprovalKeys = new Set<string>();
  private readonly rememberedApprovalOrder: string[] = [];
  private readonly approvalSubscription: DisposableLike;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly rpcClient: ApprovalRpcClient,
    private readonly window: ApprovalWindowMessenger,
    private readonly notifier: ApprovalNotifier,
    private readonly requester: ApprovalRequester = requestApproval,
    private readonly previewer?: ApprovalPreviewer,
  ) {
    this.approvalSubscription = rpcClient.onEvent((event) => {
      this.handleEvent(event);
    });
  }

  dispose(): void {
    this.approvalSubscription.dispose();
  }

  whenIdle(): Promise<void> {
    return this.queue.catch(() => undefined);
  }

  private handleEvent(event: AgentEventEnvelope): void {
    if (event.type !== APPROVAL_EVENT_TYPE) {
      return;
    }

    const request = approvalPromptRequestFromEvent(event);
    if (request === undefined) {
      this.notifier.warn("prole-coder received a malformed approval request from the RPC server.");
      return;
    }

    const approvalKey = approvalEventKey(event.runId, request.approvalId);
    if (this.activeApprovalKeys.has(approvalKey) || this.hasRemembered(approvalKey)) {
      return;
    }

    this.activeApprovalKeys.add(approvalKey);
    this.remember(approvalKey);
    this.queue = this.queue
      .catch(() => undefined)
      .then(() => this.promptAndResolve(event, request))
      .finally(() => {
        this.activeApprovalKeys.delete(approvalKey);
      });
  }

  private async promptAndResolve(event: AgentEventEnvelope, request: ApprovalPromptRequest): Promise<void> {
    if (this.previewer !== undefined) {
      try {
        await this.previewer.prepareApproval(event, request);
      } catch (error) {
        this.notifier.warn(`prole-coder approval preview failed: ${errorMessage(error)}`);
      }
    }

    try {
      const decision = await this.requester(this.window, request);
      await this.sendDecision(decision);
    } catch (error) {
      this.notifier.warn(`prole-coder approval request failed: ${errorMessage(error)}`);
    }
  }

  private sendDecision(decision: ApprovalPromptDecision): Promise<ApproveResult | RejectResult> {
    if (decision.kind === "approve") {
      return this.rpcClient.approve({
        approvalId: decision.approvalId,
        persist: approvalPersist(decision.persist),
        ...(decision.hunks === undefined ? {} : { hunks: decision.hunks }),
      });
    }

    return this.rpcClient.reject({
      approvalId: decision.approvalId,
      reason: decision.reason,
    });
  }

  private hasRemembered(approvalKey: string): boolean {
    return this.rememberedApprovalKeys.has(approvalKey);
  }

  private remember(approvalKey: string): void {
    this.rememberedApprovalKeys.add(approvalKey);
    this.rememberedApprovalOrder.push(approvalKey);
    while (this.rememberedApprovalOrder.length > MAX_REMEMBERED_APPROVALS) {
      const oldest = this.rememberedApprovalOrder.shift();
      if (oldest !== undefined) {
        this.rememberedApprovalKeys.delete(oldest);
      }
    }
  }
}

export function approvalPromptRequestFromEvent(
  event: AgentEventEnvelope,
): ApprovalPromptRequest | undefined {
  if (event.type !== APPROVAL_EVENT_TYPE || !isApprovalPayload(event.payload)) {
    return undefined;
  }

  return {
    approvalId: event.payload.approvalId,
    toolCallId: event.payload.toolCallId,
    toolName: event.payload.toolName,
    risk: event.payload.risk,
    title: event.payload.title,
    detail: event.payload.detail,
    persistable: event.payload.persistable,
    ...(event.payload.command === undefined ? {} : { command: event.payload.command }),
    ...(event.payload.cwd === undefined ? {} : { cwd: event.payload.cwd }),
    ...(event.payload.outputSummary === undefined
      ? {}
      : { outputSummary: event.payload.outputSummary }),
    ...(event.payload.paths === undefined ? {} : { paths: event.payload.paths }),
    ...(event.payload.hunks === undefined
      ? {}
      : {
          hunks: event.payload.hunks.map((hunk) => ({
            id: hunk.id,
            filePath: hunk.filePath,
            hunkIndex: hunk.hunkIndex,
            oldStart: hunk.oldStart,
            oldCount: hunk.oldCount,
            newStart: hunk.newStart,
            newCount: hunk.newCount,
            ...(hunk.section === undefined ? {} : { section: hunk.section }),
          })),
        }),
    ...(event.payload.riskReasons === undefined ? {} : { riskReasons: event.payload.riskReasons }),
  };
}

function isApprovalPayload(value: unknown): value is ToolApprovalRequiredPayload {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value["approvalId"]) &&
    isNonEmptyString(value["toolCallId"]) &&
    isToolName(value["toolName"]) &&
    isRiskLevel(value["risk"]) &&
    isNonEmptyString(value["title"]) &&
    isNonEmptyString(value["detail"]) &&
    typeof value["persistable"] === "boolean" &&
    optionalString(value["command"]) &&
    optionalString(value["cwd"]) &&
    optionalString(value["outputSummary"]) &&
    optionalStringArray(value["paths"]) &&
    optionalApprovalHunks(value["hunks"]) &&
    optionalStringArray(value["riskReasons"])
  );
}

function optionalApprovalHunks(value: unknown): boolean {
  // Mirrors the shared protocol PatchApprovalHunk shape; update both sides when the wire shape changes.
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every(
    (hunk) =>
      isRecord(hunk) &&
      isNonEmptyString(hunk["id"]) &&
      isNonEmptyString(hunk["filePath"]) &&
      Number.isInteger(hunk["fileIndex"]) &&
      Number.isInteger(hunk["hunkIndex"]) &&
      Number.isInteger(hunk["oldStart"]) &&
      Number.isInteger(hunk["oldCount"]) &&
      Number.isInteger(hunk["newStart"]) &&
      Number.isInteger(hunk["newCount"]) &&
      optionalString(hunk["section"]),
  );
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RISK_LOOKUP, value);
}

function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TOOL_NAME_LOOKUP, value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function approvalPersist(persist: ApprovalPersistence): ApprovalPersistence {
  return persist;
}

function approvalEventKey(runId: string, approvalId: string): string {
  return `${runId}:${approvalId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
