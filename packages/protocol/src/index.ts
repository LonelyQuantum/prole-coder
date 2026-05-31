export const protocolVersion = "0.1.0" as const;
export const jsonRpcVersion = "2.0" as const;
export const agentEventMethod = "agent.event" as const;
export const agentEventBatchMethod = "agent.eventBatch" as const;
export const agentInitializeMethod = "agent.initialize" as const;
export const agentSendTurnMethod = "agent.sendTurn" as const;
export const agentResumeMethod = "agent.resume" as const;
export const agentApproveMethod = "agent.approve" as const;
export const agentRejectMethod = "agent.reject" as const;
export const agentCancelMethod = "agent.cancel" as const;
export const agentListRunsMethod = "agent.listRuns" as const;
export const agentPreviewFimMethod = "agent.previewFim" as const;

export interface ProtocolErrorDefinition {
  readonly code: number;
  readonly name: string;
}

export const jsonRpcErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export const rpcErrorCodes = {
  unsupportedProtocol: -32001,
  workspaceUntrusted: -32002,
  runNotFound: -32003,
  runAlreadyActive: -32004,
  invalidToolArguments: -32010,
  approvalNotFound: -32011,
  approvalDenied: -32012,
  contextBudgetExceeded: -32020,
  providerError: -32030,
  toolExecutionFailed: -32040,
  runCanceled: -32050,
  internalInvariant: -32060,
} as const;

export const protocolErrorDefinitions = [
  { code: jsonRpcErrorCodes.parseError, name: "Parse error" },
  { code: jsonRpcErrorCodes.invalidRequest, name: "Invalid Request" },
  { code: jsonRpcErrorCodes.methodNotFound, name: "Method not found" },
  { code: jsonRpcErrorCodes.invalidParams, name: "Invalid params" },
  { code: jsonRpcErrorCodes.internalError, name: "Internal error" },
  { code: rpcErrorCodes.unsupportedProtocol, name: "E_UNSUPPORTED_PROTOCOL" },
  { code: rpcErrorCodes.workspaceUntrusted, name: "E_WORKSPACE_UNTRUSTED" },
  { code: rpcErrorCodes.runNotFound, name: "E_RUN_NOT_FOUND" },
  { code: rpcErrorCodes.runAlreadyActive, name: "E_RUN_ALREADY_ACTIVE" },
  { code: rpcErrorCodes.invalidToolArguments, name: "E_INVALID_TOOL_ARGUMENTS" },
  { code: rpcErrorCodes.approvalNotFound, name: "E_APPROVAL_NOT_FOUND" },
  { code: rpcErrorCodes.approvalDenied, name: "E_APPROVAL_DENIED" },
  { code: rpcErrorCodes.contextBudgetExceeded, name: "E_CONTEXT_BUDGET_EXCEEDED" },
  { code: rpcErrorCodes.providerError, name: "E_PROVIDER_ERROR" },
  { code: rpcErrorCodes.toolExecutionFailed, name: "E_TOOL_EXECUTION_FAILED" },
  { code: rpcErrorCodes.runCanceled, name: "E_RUN_CANCELED" },
  { code: rpcErrorCodes.internalInvariant, name: "E_INTERNAL_INVARIANT" },
] as const satisfies readonly ProtocolErrorDefinition[];

export const riskLevels = ["read", "write", "exec", "network", "destructive"] as const;
export type RiskLevel = (typeof riskLevels)[number];
export type ApprovalRisk = RiskLevel;

export const providerCapabilityFeatures = [
  "thinking",
  "toolCalls",
  "toolChoice",
  "fim",
  "streaming",
  "cacheUsage",
] as const;
export type ProviderCapabilityFeature = (typeof providerCapabilityFeatures)[number];

export interface ProviderModelCapabilities {
  readonly id: string;
  readonly displayName?: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsThinking: boolean;
  readonly supportsToolCalls: boolean;
  readonly supportsToolChoice: boolean;
  readonly supportsFim: boolean;
  readonly supportsStreaming: boolean;
  readonly reportsCacheUsage: boolean;
}

export interface ProviderCapabilities {
  readonly provider: string;
  readonly defaultModel: string;
  readonly models: readonly ProviderModelCapabilities[];
}

export const approvalRequirements = ["none", "required", "always_required"] as const;
export type ApprovalRequirement = (typeof approvalRequirements)[number];

export const riskDefaultApproval = {
  read: "none",
  write: "required",
  exec: "required",
  network: "required",
  destructive: "always_required",
} as const satisfies Record<RiskLevel, ApprovalRequirement>;

export const approvalPersistences = ["never", "session", "workspace"] as const;
export type ApprovalPersistence = (typeof approvalPersistences)[number];

export const approvalStates = [
  "pending",
  "approved",
  "executing",
  "completed",
  "failed",
  "rejected",
  "canceled",
  "expired",
] as const;
export type ApprovalState = (typeof approvalStates)[number];

export const approvalStateTransitions: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ["approved", "rejected", "canceled", "expired"],
  approved: ["executing"],
  executing: ["completed", "failed"],
  completed: [],
  failed: [],
  rejected: [],
  canceled: [],
  expired: [],
};

export function canTransitionApprovalState(from: ApprovalState, to: ApprovalState): boolean {
  return approvalStateTransitions[from].includes(to);
}

export function isApprovalRequired(risk: RiskLevel): boolean {
  return riskDefaultApproval[risk] !== "none";
}

export type JsonSchema = Readonly<Record<string, unknown>>;

export const toolImplementationStatuses = ["schema_only", "executor_implemented"] as const;
export type ToolImplementationStatus = (typeof toolImplementationStatuses)[number];

export const toolNames = [
  "workspace_manifest",
  "read_file",
  "search",
  "apply_patch",
  "shell",
  "git_status",
  "git_diff",
  "lsp_diagnostics",
  "plan_update",
] as const;
export type ToolName = (typeof toolNames)[number];

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly risk: RiskLevel;
  readonly approval: ApprovalRequirement;
  readonly implementationStatus: ToolImplementationStatus;
  readonly argumentSchema: JsonSchema;
  readonly resultSchema: JsonSchema;
}

const statusResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    summary: { type: "string" },
    errorCode: { type: "string" },
  },
} as const satisfies JsonSchema;

const workspaceManifestResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "manifestHash", "summaryMarkdown", "manifest"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    summary: { type: "string" },
    errorCode: { type: "string" },
    manifestHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    summaryMarkdown: { type: "string" },
    manifest: {
      type: "object",
      additionalProperties: true,
      required: [
        "manifestVersion",
        "manifestHash",
        "maxEntries",
        "totalDiscoveredFiles",
        "includedFiles",
        "entries",
        "omitted",
      ],
      properties: {
        manifestVersion: { type: "integer", minimum: 1 },
        manifestHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        workspaceRoot: { type: "string" },
        scanRoot: { type: "string" },
        maxEntries: { type: "integer", minimum: 1 },
        totalDiscoveredFiles: { type: "integer", minimum: 0 },
        includedFiles: { type: "integer", minimum: 0 },
        totalSizeBytes: { type: "integer", minimum: 0 },
        entries: { type: "array", items: { type: "object" } },
        omitted: { type: "array", items: { type: "object" } },
      },
    },
  },
} as const satisfies JsonSchema;

const readFileResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "path", "content", "lineCount", "sha256", "sizeBytes"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    summary: { type: "string" },
    errorCode: { type: "string" },
    path: { type: "string" },
    content: { type: "string" },
    lineCount: { type: "integer", minimum: 0 },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    sizeBytes: { type: "integer", minimum: 0 },
  },
} as const satisfies JsonSchema;

export const toolDefinitions = [
  {
    name: "workspace_manifest",
    description: "生成 workspace manifest。",
    risk: "read",
    approval: "none",
    implementationStatus: "executor_implemented",
    argumentSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", minLength: 1 },
        respectGitignore: { type: "boolean" },
        maxEntries: { type: "integer", minimum: 1 },
      },
    },
    resultSchema: workspaceManifestResultSchema,
  },
  {
    name: "read_file",
    description: "读取 workspace 内 UTF-8 文本文件。",
    risk: "read",
    approval: "none",
    implementationStatus: "executor_implemented",
    argumentSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", minLength: 1 },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
    },
    resultSchema: readFileResultSchema,
  },
  {
    name: "search",
    description: "使用 ripgrep 搜索 workspace 文本。",
    risk: "read",
    approval: "none",
    implementationStatus: "executor_implemented",
    argumentSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1 },
        paths: { type: "array", items: { type: "string" } },
        caseSensitive: { type: "boolean" },
        maxResults: { type: "integer", minimum: 1 },
      },
    },
    resultSchema: statusResultSchema,
  },
  {
    name: "apply_patch",
    description: "应用统一 diff patch。",
    risk: "write",
    approval: "required",
    implementationStatus: "executor_implemented",
    argumentSchema: {
      type: "object",
      additionalProperties: false,
      required: ["unifiedDiff", "expectedFiles"],
      properties: {
        unifiedDiff: { type: "string", minLength: 1 },
        expectedFiles: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
      },
    },
    resultSchema: statusResultSchema,
  },
  {
    name: "shell",
    description: "执行非交互式 shell 命令。",
    risk: "exec",
    approval: "required",
    implementationStatus: "executor_implemented",
    argumentSchema: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { type: "string", minLength: 1 },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1 },
      },
    },
    resultSchema: statusResultSchema,
  },
  {
    name: "git_status",
    description: "读取 git status。",
    risk: "read",
    approval: "none",
    implementationStatus: "executor_implemented",
    argumentSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        porcelain: { type: "boolean" },
      },
    },
    resultSchema: statusResultSchema,
  },
  {
    name: "git_diff",
    description: "读取 git diff。",
    risk: "read",
    approval: "none",
    implementationStatus: "executor_implemented",
    argumentSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        staged: { type: "boolean" },
        paths: { type: "array", items: { type: "string" } },
      },
    },
    resultSchema: statusResultSchema,
  },
  {
    name: "lsp_diagnostics",
    description: "读取语言服务器或编辑器 diagnostics。",
    risk: "read",
    approval: "none",
    implementationStatus: "schema_only",
    argumentSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        paths: { type: "array", items: { type: "string" } },
      },
    },
    resultSchema: statusResultSchema,
  },
  {
    name: "plan_update",
    description: "更新当前计划。",
    risk: "read",
    approval: "none",
    implementationStatus: "schema_only",
    argumentSchema: {
      type: "object",
      additionalProperties: false,
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "status"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "failed", "canceled"],
              },
              detail: { type: "string" },
            },
          },
        },
      },
    },
    resultSchema: statusResultSchema,
  },
] as const satisfies readonly ToolDefinition[];

export function findToolDefinition(name: string): ToolDefinition | undefined {
  return toolDefinitions.find((tool) => tool.name === name);
}

export type FrontendKind = "cli" | "tui" | "vscode";

export interface ClientInfo {
  readonly name: string;
  readonly version: string;
  readonly frontend: FrontendKind;
}

export interface AgentInitializeParams {
  readonly protocolVersion: typeof protocolVersion;
  readonly client: ClientInfo;
  readonly workspaceRoot: string;
  readonly workspaceTrusted: boolean;
}

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface ServerCapabilities {
  readonly protocolVersion: typeof protocolVersion;
  readonly supportsRunResume: boolean;
  readonly supportsPatchApproval: boolean;
  readonly supportsPersistentApprovals: boolean;
  readonly supportsEventBatching: boolean;
  readonly supportedRiskLevels: readonly RiskLevel[];
  readonly provider: ProviderCapabilities;
}

export interface AgentInitializeResult {
  readonly protocolVersion: typeof protocolVersion;
  readonly server: ServerInfo;
  readonly capabilities: ServerCapabilities;
  readonly stateDir: string;
}

export type RpcRunMode = "plan" | "edit" | "review" | "ask";

export interface TextRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface TurnAttachment {
  readonly kind: "file" | "selection" | "explicit_content" | "diagnostic";
  readonly path?: string;
  readonly range?: TextRange;
  readonly text?: string;
}

export interface SendTurnParams {
  readonly runId?: string;
  readonly message: string;
  readonly mode: RpcRunMode;
  readonly attachments?: readonly TurnAttachment[];
}

export interface SendTurnResult {
  readonly runId: string;
  readonly turnId: string;
  readonly accepted: true;
}

export interface ResumeParams {
  readonly runId: string;
  readonly replayFromSeq?: number;
}

export interface ResumeResult {
  readonly runId: string;
  readonly nextSeq: number;
  readonly replayStarted: boolean;
}

export type RunSummaryStatus = "running" | "completed" | "failed" | "canceled";

export interface ListRunsParams {
  readonly limit?: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly title: string;
  readonly status: RunSummaryStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly lastSeq: number;
  readonly eventCount: number;
  readonly mode?: RpcRunMode;
  readonly summary?: string;
  readonly changedFiles?: readonly string[];
  readonly verificationStatus?: "passed" | "failed" | "skipped";
}

export interface ListRunsResult {
  readonly runs: readonly RunSummary[];
}

export interface ApproveParams {
  readonly approvalId: string;
  readonly persist?: ApprovalPersistence;
  readonly hunks?: {
    readonly approved: readonly string[];
  };
}

export interface ApproveResult {
  readonly approvalId: string;
  readonly state: "approved";
  readonly persist: ApprovalPersistence;
  readonly hunks?: {
    readonly approved: readonly string[];
  };
}

export interface RejectParams {
  readonly approvalId: string;
  readonly reason?: string;
}

export interface RejectResult {
  readonly approvalId: string;
  readonly state: "rejected";
  readonly reason?: string;
}

export interface CancelParams {
  readonly runId: string;
  readonly reason?: string;
}

export interface CancelResult {
  readonly runId: string;
  readonly state: "canceled";
  readonly reason?: string;
}

export interface FimPreviewParams {
  readonly prefix: string;
  readonly suffix?: string;
  readonly path?: string;
  readonly languageId?: string;
  readonly model?: string;
  readonly maxTokens?: number;
}

export interface FimPreviewResult {
  readonly text: string;
  readonly model: string;
  readonly finishReason?: string;
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly risk: RiskLevel;
  readonly title: string;
  readonly detail: string;
  readonly toolCallId: string;
  readonly toolName: ToolName;
  readonly command?: string;
  readonly cwd?: string;
  readonly outputSummary?: string;
  readonly paths?: readonly string[];
  readonly hunks?: readonly PatchApprovalHunk[];
  readonly riskReasons?: readonly string[];
  readonly persistable: boolean;
}

// Keep vscode/extension/src/approvalFlow.ts optionalApprovalHunks in sync with this wire shape.
export interface PatchApprovalHunk {
  readonly id: string;
  readonly filePath: string;
  readonly fileIndex: number;
  readonly hunkIndex: number;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly section?: string;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<TParams = unknown> {
  readonly jsonrpc: typeof jsonRpcVersion;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcResponse<TResult = unknown> {
  readonly jsonrpc: typeof jsonRpcVersion;
  readonly id: JsonRpcId;
  readonly result: TResult;
}

export interface JsonRpcErrorObject<TData = unknown> {
  readonly code: number;
  readonly message: string;
  readonly data?: TData;
}

export interface JsonRpcErrorResponse<TData = unknown> {
  readonly jsonrpc: typeof jsonRpcVersion;
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject<TData>;
}

export interface JsonRpcNotification<TParams = unknown> {
  readonly jsonrpc: typeof jsonRpcVersion;
  readonly method: string;
  readonly params: TParams;
}

export interface AgentEventEnvelope<TPayload = unknown> {
  readonly seq: number;
  readonly time: string;
  readonly type: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly payload: TPayload;
}

export interface RunLogTruncation {
  readonly path: string;
  readonly reason: "max_string_bytes" | "max_array_items";
  readonly original: number;
  readonly stored: number;
}

export interface RunLogPayloadMetadata {
  readonly runLogTruncation?: readonly RunLogTruncation[];
}

export interface AssistantDeltaPayload {
  readonly text: string;
  readonly iteration?: number;
  readonly stream?: boolean;
}

export interface ProviderUsagePayload {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly promptCacheHitTokens?: number;
  readonly promptCacheMissTokens?: number;
  readonly reasoningTokens?: number;
}

export interface ProviderStreamingPayload {
  readonly chunkCount: number;
  readonly toolCallDeltaCount: number;
}

export interface ProviderCompletedPayload extends RunLogPayloadMetadata {
  readonly iteration: number;
  readonly model: string;
  readonly durationMs: number;
  readonly finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error";
  readonly usage?: ProviderUsagePayload;
  readonly streaming?: ProviderStreamingPayload;
}

export interface ProviderRequestedPayload {
  readonly iteration: number;
  readonly messageCount: number;
  readonly reasoningState: Readonly<Record<string, unknown>>;
}

export type ToolExecutionStatus = "ok" | "failed";

export interface ToolCompletedPayload extends RunLogPayloadMetadata {
  readonly toolCallId: string;
  readonly name: ToolName;
  readonly status: ToolExecutionStatus;
  readonly summary: string;
  readonly result: Readonly<Record<string, unknown>>;
}

export type VerificationStatus = "passed" | "failed" | "skipped";

export interface RunCompletedPayload {
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly verificationStatus: VerificationStatus;
}

export interface ToolApprovalRequiredPayload {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: ToolName;
  readonly risk: RiskLevel;
  readonly title: string;
  readonly detail: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly outputSummary?: string;
  readonly paths?: readonly string[];
  readonly hunks?: readonly PatchApprovalHunk[];
  readonly riskReasons?: readonly string[];
  readonly persistable: boolean;
}

export interface ToolApprovalResolvedPayload {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: ToolName;
  readonly decision: "approved" | "rejected" | "canceled" | "expired";
  readonly reason?: string;
  readonly hunks?:
    | {
        readonly scope: "all";
      }
    | {
        readonly scope: "selected";
        readonly approved: readonly string[];
      };
}

export type AgentEventNotification<TPayload = unknown> = JsonRpcNotification<
  AgentEventEnvelope<TPayload>
> & {
  readonly method: typeof agentEventMethod;
};

export interface AgentEventBatchParams<TPayload = unknown> {
  readonly events: readonly AgentEventEnvelope<TPayload>[];
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly count: number;
}

export type AgentEventBatchNotification<TPayload = unknown> = JsonRpcNotification<
  AgentEventBatchParams<TPayload>
> & {
  readonly method: typeof agentEventBatchMethod;
};

export type AgentEvent =
  | {
      readonly type: "delta";
      readonly text: string;
    }
  | {
      readonly type: "approvalRequired";
      readonly request: ApprovalRequest;
    }
  | {
      readonly type: "done";
    };
