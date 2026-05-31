import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  agentEventMethod,
  agentInitializeMethod,
  agentSendTurnMethod,
  agentResumeMethod,
  agentApproveMethod,
  agentRejectMethod,
  agentCancelMethod,
  agentListRunsMethod,
  agentEventBatchMethod,
  agentPreviewFimMethod,
  type ApprovalRequest,
  type ApproveParams,
  type ApproveResult,
  type CancelParams,
  type CancelResult,
  type AgentEventBatchParams,
  type FimPreviewParams,
  type FimPreviewResult,
  type ListRunsParams,
  type ListRunsResult,
  type ProviderCapabilities,
  type ProviderCompletedPayload,
  type ProviderRequestedPayload,
  type RunCompletedPayload,
  type RunLogPayloadMetadata,
  type RunSummary,
  type RejectParams,
  type RejectResult,
  type ServerCapabilities,
  type ToolCompletedPayload,
  type ToolApprovalRequiredPayload,
  type ToolApprovalResolvedPayload,
  type TurnAttachment,
  approvalStateTransitions,
  canTransitionApprovalState,
  jsonRpcVersion,
  findToolDefinition,
  isApprovalRequired,
  protocolErrorDefinitions,
  protocolVersion,
  riskDefaultApproval,
  riskLevels,
  toolDefinitions,
  toolNames,
} from "../src/index.js";

interface ToolRegistryFixture {
  readonly version: string;
  readonly riskLevels: readonly string[];
  readonly riskDefaultApproval: Readonly<Record<string, string>>;
  readonly tools: readonly ToolRegistryTool[];
}

interface ToolRegistryTool {
  readonly name: string;
  readonly risk: string;
  readonly approval: string;
  readonly status: string;
}

interface EventPayloadFixture {
  readonly version: string;
  readonly events: readonly EventPayloadFixtureEntry[];
}

interface EventPayloadFixtureEntry {
  readonly type: string;
  readonly payloadName: string;
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, string>>;
}

const toolRegistryFixture = JSON.parse(
  readFileSync(
    new URL("../../../../docs/protocol/tool-registry.v1.json", import.meta.url),
    "utf8",
  ),
) as ToolRegistryFixture;
const eventPayloadFixture = JSON.parse(
  readFileSync(
    new URL("../../../../docs/protocol/event-payloads.v1.json", import.meta.url),
    "utf8",
  ),
) as EventPayloadFixture;
const jsonRpcProtocolDocument = readFileSync(
  new URL("../../../../docs/json-rpc-protocol.md", import.meta.url),
  "utf8",
);

test("risk defaults stay aligned with approval requirement helper", () => {
  assert.deepEqual(riskDefaultApproval, {
    read: "none",
    write: "required",
    exec: "required",
    network: "required",
    destructive: "always_required",
  });

  for (const risk of riskLevels) {
    assert.equal(isApprovalRequired(risk), riskDefaultApproval[risk] !== "none");
  }
});

test("approval state transitions allow only documented next states", () => {
  assert.equal(canTransitionApprovalState("pending", "approved"), true);
  assert.equal(canTransitionApprovalState("pending", "rejected"), true);
  assert.equal(canTransitionApprovalState("approved", "executing"), true);
  assert.equal(canTransitionApprovalState("executing", "completed"), true);
  assert.equal(canTransitionApprovalState("executing", "failed"), true);

  assert.equal(canTransitionApprovalState("completed", "executing"), false);
  assert.equal(canTransitionApprovalState("rejected", "approved"), false);

  for (const terminal of ["completed", "failed", "rejected", "canceled", "expired"] as const) {
    assert.deepEqual(approvalStateTransitions[terminal], []);
  }
});

test("JSON-RPC method constants match protocol document", () => {
  assert.equal(jsonRpcVersion, "2.0");
  assert.equal(agentInitializeMethod, "agent.initialize");
  assert.equal(agentSendTurnMethod, "agent.sendTurn");
  assert.equal(agentResumeMethod, "agent.resume");
  assert.equal(agentApproveMethod, "agent.approve");
  assert.equal(agentRejectMethod, "agent.reject");
  assert.equal(agentCancelMethod, "agent.cancel");
  assert.equal(agentListRunsMethod, "agent.listRuns");
  assert.equal(agentPreviewFimMethod, "agent.previewFim");
  assert.equal(agentEventMethod, "agent.event");
  assert.equal(agentEventBatchMethod, "agent.eventBatch");
});

test("server capabilities expose provider model capabilities", () => {
  const provider = {
    provider: "deepseek",
    defaultModel: "deepseek-v4-pro",
    models: [
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 393_216,
        supportsThinking: true,
        supportsToolCalls: true,
        supportsToolChoice: false,
        supportsFim: true,
        supportsStreaming: true,
        reportsCacheUsage: true,
      },
    ],
  } satisfies ProviderCapabilities;
  const capabilities = {
    protocolVersion,
    supportsRunResume: true,
    supportsPatchApproval: true,
    supportsPersistentApprovals: true,
    supportsEventBatching: true,
    supportedRiskLevels: riskLevels,
    provider,
  } satisfies ServerCapabilities;

  assert.equal(capabilities.provider.defaultModel, "deepseek-v4-pro");
  assert.equal(capabilities.provider.models[0]?.supportsFim, true);
  assert.equal(capabilities.supportsEventBatching, true);
});

test("protocol error code registry matches protocol document", () => {
  const codes = new Set<number>();
  const names = new Set<string>();

  for (const definition of protocolErrorDefinitions) {
    const displayName = definition.name.startsWith("E_")
      ? `\`${definition.name}\``
      : definition.name;
    const rowPrefix = `| ${definition.code} | ${displayName} |`;

    assert.equal(codes.has(definition.code), false, `duplicate error code ${definition.code}`);
    assert.equal(names.has(definition.name), false, `duplicate error name ${definition.name}`);
    assert.equal(
      jsonRpcProtocolDocument.includes(rowPrefix),
      true,
      `missing protocol document row starting with ${rowPrefix}`,
    );
    codes.add(definition.code);
    names.add(definition.name);
  }
});

test("approval request and decision params use stable protocol fields", () => {
  const request = {
    approvalId: "approval_1",
    toolCallId: "call_1",
    toolName: "apply_patch",
    risk: "write",
    title: "Apply patch",
    detail: "Modify README.md",
    cwd: ".",
    outputSummary: "previous command output was truncated",
    paths: ["README.md"],
    hunks: [
      {
        id: "README.md#1:old1+3:new1+3",
        filePath: "README.md",
        fileIndex: 0,
        hunkIndex: 0,
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 3,
      },
    ],
    riskReasons: ["dependency install/update"],
    persistable: false,
  } satisfies ApprovalRequest;
  const requiredPayload = {
    approvalId: request.approvalId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    risk: request.risk,
    title: request.title,
    detail: request.detail,
    cwd: request.cwd,
    outputSummary: request.outputSummary,
    paths: request.paths,
    hunks: request.hunks,
    riskReasons: request.riskReasons,
    persistable: request.persistable,
  } satisfies ToolApprovalRequiredPayload;
  const resolvedPayload = {
    approvalId: request.approvalId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    decision: "approved",
    hunks: {
      scope: "selected",
      approved: ["README.md#1:old1+3:new1+3"],
    },
  } satisfies ToolApprovalResolvedPayload;
  const approve = {
    approvalId: request.approvalId,
    persist: "never",
    hunks: {
      approved: ["README.md#1:old1+3:new1+3"],
    },
  } satisfies ApproveParams;
  const approveResult = {
    approvalId: request.approvalId,
    state: "approved",
    persist: "never",
    hunks: approve.hunks,
  } satisfies ApproveResult;
  const reject = {
    approvalId: request.approvalId,
    reason: "not now",
  } satisfies RejectParams;
  const rejectResult = {
    approvalId: request.approvalId,
    state: "rejected",
    reason: "not now",
  } satisfies RejectResult;
  const cancel = {
    runId: "run_1",
    reason: "user canceled",
  } satisfies CancelParams;
  const cancelResult = {
    runId: cancel.runId,
    state: "canceled",
    reason: cancel.reason,
  } satisfies CancelResult;
  const fimPreview = {
    prefix: "fn main() {",
    suffix: "}",
    path: "src/main.rs",
    languageId: "rust",
    model: "deepseek-v4-pro",
    maxTokens: 32,
  } satisfies FimPreviewParams;
  const fimPreviewResult = {
    text: " println!(\"hi\");",
    model: "deepseek-v4-pro",
    finishReason: "stop",
  } satisfies FimPreviewResult;
  const expiredPayload = {
    approvalId: request.approvalId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    decision: "expired",
    reason: "approval timed out",
  } satisfies ToolApprovalResolvedPayload;

  assert.equal(approve.approvalId, "approval_1");
  assert.equal(requiredPayload.toolName, "apply_patch");
  assert.equal(requiredPayload.hunks?.[0]?.id, "README.md#1:old1+3:new1+3");
  assert.equal(resolvedPayload.decision, "approved");
  assert.equal(approve.hunks?.approved[0], "README.md#1:old1+3:new1+3");
  assert.equal(approveResult.state, "approved");
  assert.equal(reject.reason, rejectResult.reason);
  assert.equal(cancelResult.state, "canceled");
  assert.equal(fimPreview.languageId, "rust");
  assert.equal(fimPreviewResult.finishReason, "stop");
  assert.equal(expiredPayload.decision, "expired");
});

test("run summary params and results use stable protocol fields", () => {
  const params = {
    limit: 20,
  } satisfies ListRunsParams;
  const summary = {
    runId: "run_1",
    title: "Fix README",
    status: "completed",
    startedAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:02.000Z",
    completedAt: "1970-01-01T00:00:02.000Z",
    lastSeq: 8,
    eventCount: 8,
    mode: "edit",
    summary: "Updated README.",
    changedFiles: ["README.md"],
    verificationStatus: "passed",
  } satisfies RunSummary;
  const result = {
    runs: [summary],
  } satisfies ListRunsResult;

  assert.equal(params.limit, 20);
  assert.equal(result.runs[0]?.runId, "run_1");
  assert.equal(result.runs[0]?.status, "completed");
  assert.equal(result.runs[0]?.lastSeq, 8);
});

test("attachments and provider completed payload use phase 2c and 2d fields", () => {
  const attachments = [
    {
      kind: "file",
      path: "README.md",
    },
    {
      kind: "selection",
      path: "src/lib.rs",
      range: {
        startLine: 1,
        startColumn: 1,
        endLine: 3,
        endColumn: 1,
      },
      text: "pub fn demo() {}",
    },
    {
      kind: "explicit_content",
      text: "acceptance criteria",
    },
    {
      kind: "diagnostic",
      path: "src/lib.rs",
      range: {
        startLine: 2,
        startColumn: 5,
        endLine: 2,
        endColumn: 9,
      },
      text: "warning: unused function",
    },
  ] satisfies readonly TurnAttachment[];
  const providerCompleted = {
    iteration: 1,
    model: "deepseek-v4-pro",
    durationMs: 42,
    finishReason: "stop",
    usage: {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      promptCacheHitTokens: 64,
      promptCacheMissTokens: 36,
      reasoningTokens: 8,
    },
    streaming: {
      chunkCount: 3,
      toolCallDeltaCount: 1,
    },
    runLogTruncation: [
      {
        path: "$.usage.raw",
        reason: "max_string_bytes",
        original: 20000,
        stored: 16384,
      },
    ],
  } satisfies ProviderCompletedPayload;
  const metadata = {
    runLogTruncation: providerCompleted.runLogTruncation,
  } satisfies RunLogPayloadMetadata;

  assert.equal(attachments[2]?.kind, "explicit_content");
  assert.equal(providerCompleted.usage.promptCacheHitTokens, 64);
  assert.equal(providerCompleted.streaming.toolCallDeltaCount, 1);
  assert.equal(metadata.runLogTruncation?.[0]?.reason, "max_string_bytes");
});

test("event payload fixture stays aligned with shared protocol types", () => {
  const providerRequested = {
    iteration: 1,
    messageCount: 4,
    reasoningState: {
      status: "active",
    },
  } satisfies ProviderRequestedPayload;
  const toolCompleted = {
    toolCallId: "call_1",
    name: "shell",
    status: "ok",
    summary: "Command completed.",
    result: {
      exitCode: 0,
    },
  } satisfies ToolCompletedPayload;
  const runCompleted = {
    summary: "Updated the workspace.",
    changedFiles: ["README.md"],
    verificationStatus: "passed",
  } satisfies RunCompletedPayload;
  const toolApprovalRequired = {
    approvalId: "approval_1",
    toolCallId: "call_patch",
    toolName: "apply_patch",
    risk: "write",
    title: "Apply patch",
    detail: "Modify README.md",
    paths: ["README.md"],
    hunks: [
      {
        id: "README.md#1:old1+3:new1+3",
        filePath: "README.md",
        fileIndex: 0,
        hunkIndex: 0,
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 3,
      },
    ],
    persistable: true,
  } satisfies ToolApprovalRequiredPayload;
  const toolApprovalResolved = {
    approvalId: "approval_1",
    toolCallId: "call_patch",
    toolName: "apply_patch",
    decision: "approved",
    hunks: {
      scope: "selected",
      approved: ["README.md#1:old1+3:new1+3"],
    },
  } satisfies ToolApprovalResolvedPayload;
  const samples = {
    "provider.requested": providerRequested,
    "tool.completed": toolCompleted,
    "run.completed": runCompleted,
    "tool.approvalRequired": toolApprovalRequired,
    "tool.approvalResolved": toolApprovalResolved,
  } as const;

  assert.equal(eventPayloadFixture.version, protocolVersion);
  assert.deepEqual(eventPayloadFixture.events.map((event) => event.type), [
    "provider.requested",
    "tool.completed",
    "run.completed",
    "tool.approvalRequired",
    "tool.approvalResolved",
  ]);

  for (const event of eventPayloadFixture.events) {
    const sample = samples[event.type as keyof typeof samples] as Record<string, unknown>;
    assert.ok(sample, `missing sample for ${event.type}`);
    for (const field of event.required) {
      assert.equal(field in sample, true, `${event.type} must include ${field}`);
    }
  }
});

test("event batch notification payload preserves event ordering metadata", () => {
  const batch = {
    events: [
      {
        seq: 10,
        time: "1970-01-01T00:00:00.000Z",
        type: "assistant.delta",
        runId: "run_1",
        turnId: "turn_1",
        payload: { text: "hello" },
      },
      {
        seq: 11,
        time: "1970-01-01T00:00:00.001Z",
        type: "assistant.delta",
        runId: "run_1",
        turnId: "turn_1",
        payload: { text: " world" },
      },
    ],
    firstSeq: 10,
    lastSeq: 11,
    count: 2,
  } satisfies AgentEventBatchParams;

  assert.equal(batch.events[0]?.seq, batch.firstSeq);
  assert.equal(batch.events[1]?.seq, batch.lastSeq);
  assert.equal(batch.events.length, batch.count);
});

test("tool registry contains every declared tool exactly once", () => {
  const registeredNames = toolDefinitions.map((tool) => tool.name);

  assert.deepEqual([...registeredNames].sort(), [...toolNames].sort());
  assert.equal(new Set(registeredNames).size, toolNames.length);

  for (const name of toolNames) {
    assert.equal(findToolDefinition(name)?.name, name);
  }
  assert.equal(findToolDefinition("missing"), undefined);
});

test("tool registry stays aligned with shared protocol fixture", () => {
  assert.equal(toolRegistryFixture.version, protocolVersion);
  assert.deepEqual(toolRegistryFixture.riskLevels, [...riskLevels]);
  assert.deepEqual(toolRegistryFixture.riskDefaultApproval, riskDefaultApproval);
  assert.deepEqual(
    sortedTools(toolRegistryFixture.tools),
    sortedTools(toolDefinitions.map((tool) => ({
      name: tool.name,
      risk: tool.risk,
      approval: tool.approval,
      status: tool.implementationStatus,
    }))),
  );
});

function sortedTools(tools: readonly ToolRegistryTool[]): ToolRegistryTool[] {
  const names = new Set<string>();

  for (const tool of tools) {
    assert.equal(names.has(tool.name), false, `tool ${tool.name} must be declared only once`);
    names.add(tool.name);
  }

  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

test("tool approval defaults match risk defaults", () => {
  for (const tool of toolDefinitions) {
    assert.equal(
      tool.approval,
      riskDefaultApproval[tool.risk],
      `${tool.name} approval should match its static risk`,
    );
  }
});

test("mutating and executing tools require approval", () => {
  assert.equal(findToolDefinition("apply_patch")?.risk, "write");
  assert.equal(findToolDefinition("apply_patch")?.approval, "required");
  assert.equal(findToolDefinition("shell")?.risk, "exec");
  assert.equal(findToolDefinition("shell")?.approval, "required");
});

test("tool schemas are explicit object schemas", () => {
  for (const tool of toolDefinitions) {
    assert.equal(tool.argumentSchema.type, "object", `${tool.name} arguments must be an object`);
    assert.equal(tool.resultSchema.type, "object", `${tool.name} result must be an object`);
  }
});

test("read_file result schema exposes file summary metadata", () => {
  const readFile = findToolDefinition("read_file");

  assert.ok(readFile);
  assert.deepEqual(readFile.resultSchema.required, [
    "status",
    "summary",
    "path",
    "content",
    "lineCount",
    "sha256",
    "sizeBytes",
  ]);
  assert.equal(
    (readFile.resultSchema.properties as Record<string, { pattern?: string }>).sha256?.pattern,
    "^[0-9a-f]{64}$",
  );
  assert.equal(
    (readFile.resultSchema.properties as Record<string, { minimum?: number }>).sizeBytes?.minimum,
    0,
  );
});

test("workspace_manifest is executable and exposes manifest metadata schema", () => {
  const workspaceManifest = findToolDefinition("workspace_manifest");

  assert.ok(workspaceManifest);
  assert.equal(workspaceManifest.implementationStatus, "executor_implemented");
  assert.deepEqual(workspaceManifest.resultSchema.required, [
    "status",
    "summary",
    "manifestHash",
    "summaryMarkdown",
    "manifest",
  ]);
  assert.equal(
    (workspaceManifest.resultSchema.properties as Record<string, { pattern?: string }>)
      .manifestHash?.pattern,
    "^sha256:[0-9a-f]{64}$",
  );
});
