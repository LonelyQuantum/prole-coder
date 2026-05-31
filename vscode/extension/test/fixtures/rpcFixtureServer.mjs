#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const logPath = process.argv[2];
if (typeof logPath !== "string" || logPath.length === 0) {
  throw new Error("Usage: node rpcFixtureServer.mjs <log-path>");
}

fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, "");

let seq = 1;
const pendingApprovals = new Map();
const runs = new Map();

const historyRun = {
  runId: "run-history-1",
  title: "Historical fixture run",
  status: "completed",
  startedAt: "2026-05-30T00:00:00.000Z",
  updatedAt: "2026-05-30T00:00:01.000Z",
  completedAt: "2026-05-30T00:00:01.000Z",
  lastSeq: 2,
  eventCount: 2,
  mode: "edit",
  summary: "Historical fixture summary",
  changedFiles: ["fixture/history.txt"],
  verificationStatus: "passed",
};
runs.set(historyRun.runId, historyRun);

const reader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

reader.on("line", (line) => {
  if (line.trim().length === 0) {
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    log({ kind: "parse-error", message: String(error) });
    return;
  }

  log({
    kind: "request",
    id: request.id,
    method: request.method,
    params: request.params,
  });
  handleRequest(request);
});

reader.on("close", () => {
  process.exit(0);
});

function handleRequest(request) {
  switch (request.method) {
    case "agent.initialize":
      respond(request.id, initializeResult());
      return;
    case "agent.listRuns":
      respond(request.id, {
        runs: listRuns(request.params?.limit),
      });
      return;
    case "agent.sendTurn":
      handleSendTurn(request);
      return;
    case "agent.approve":
      handleApprove(request);
      return;
    case "agent.cancel":
      handleCancel(request);
      return;
    case "agent.resume":
      handleResume(request);
      return;
    default:
      respondError(request.id, -32601, `Unknown method: ${request.method}`);
  }
}

function handleSendTurn(request) {
  const params = record(request.params);
  const message = typeof params?.message === "string" ? params.message : "";
  const runId = message.includes("cancel") ? "run-cancel-1" : "run-approval-1";
  const turnId = message.includes("cancel") ? "turn-cancel-1" : "turn-approval-1";
  const now = new Date().toISOString();
  runs.set(runId, {
    runId,
    title: message || "Untitled fixture run",
    status: "running",
    startedAt: now,
    updatedAt: now,
    lastSeq: seq,
    eventCount: 0,
    mode: params?.mode === "ask" || params?.mode === "plan" || params?.mode === "review" ? params.mode : "edit",
  });

  respond(request.id, {
    runId,
    turnId,
    accepted: true,
  });

  setTimeout(() => {
    emitEvent(runId, turnId, "run.started", {
      mode: params?.mode ?? "edit",
      workspaceRoot: process.cwd(),
    });
    emitEvent(runId, turnId, "turn.started", {
      userTask: message,
    });
    emitContextBuilt(runId, turnId);

    if (message.includes("cancel")) {
      updateRun(runId, { lastSeq: seq - 1, eventCount: 3 });
      return;
    }

    const approvalId = "approval-approval-1";
    const toolCallId = "tool-approval-1";
    pendingApprovals.set(approvalId, { runId, turnId, toolCallId });
    emitEvent(runId, turnId, "tool.approvalRequired", {
      approvalId,
      toolCallId,
      toolName: "shell",
      risk: "exec",
      title: "Run fixture verification",
      detail: "Fixture approval used by VS Code integration tests.",
      command: "echo fixture",
      cwd: process.cwd(),
      outputSummary: "no previous output",
      paths: ["fixture.txt"],
      riskReasons: ["executes a command"],
      persistable: true,
    });
    updateRun(runId, { lastSeq: seq - 1, eventCount: 4 });
  }, 10);
}

function handleApprove(request) {
  const approvalId = request.params?.approvalId;
  respond(request.id, {
    approvalId,
    state: "approved",
    persist: request.params?.persist ?? "never",
  });

  const pending = pendingApprovals.get(approvalId);
  if (pending === undefined) {
    return;
  }
  pendingApprovals.delete(approvalId);

  setTimeout(() => {
    emitEvent(pending.runId, pending.turnId, "tool.approvalResolved", {
      approvalId,
      toolCallId: pending.toolCallId,
      toolName: "shell",
      decision: "approved",
    });
    emitEvent(pending.runId, pending.turnId, "tool.completed", {
      toolCallId: pending.toolCallId,
      name: "shell",
      status: "ok",
      summary: "Fixture command approved.",
      result: {
        status: "ok",
        summary: "Fixture command approved.",
      },
    });
    emitEvent(pending.runId, pending.turnId, "assistant.delta", {
      text: "Fixture approval flow completed.",
      stream: true,
    });
    emitEvent(pending.runId, pending.turnId, "run.completed", {
      summary: "Fixture run completed.",
      changedFiles: [],
      verificationStatus: "passed",
    });
    updateRun(pending.runId, {
      status: "completed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      lastSeq: seq - 1,
      eventCount: 8,
      summary: "Fixture run completed.",
      changedFiles: [],
      verificationStatus: "passed",
    });
  }, 10);
}

function handleCancel(request) {
  const runId = request.params?.runId;
  const reason = request.params?.reason ?? "canceled by test";
  respond(request.id, {
    runId,
    state: "canceled",
    reason,
  });
  emitEvent(runId, "turn-cancel-1", "run.canceled", {
    code: "E_RUN_CANCELED",
    reason,
  });
  updateRun(runId, {
    status: "canceled",
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    lastSeq: seq - 1,
    eventCount: 4,
    summary: reason,
  });
}

function handleResume(request) {
  const runId = request.params?.runId;
  if (!runs.has(runId)) {
    respondError(request.id, -32003, `Run not found: ${runId}`);
    return;
  }

  respond(request.id, {
    runId,
    nextSeq: 3,
    replayStarted: true,
  });
  setTimeout(() => {
    emitEvent(runId, "turn-history-1", "assistant.delta", {
      text: "Historical replayed response.",
      stream: false,
    });
    emitEvent(runId, "turn-history-1", "run.completed", {
      summary: "Historical fixture summary",
      changedFiles: ["fixture/history.txt"],
      verificationStatus: "passed",
    });
  }, 10);
}

function emitContextBuilt(runId, turnId) {
  emitEvent(runId, turnId, "context.built", {
    inputTokens: 120,
    maxInputTokens: 1000,
    stablePrefixTokens: 40,
    dynamicPreludeTokens: 30,
    turnSuffixTokens: 50,
    stablePrefixBudgetTokens: 300,
    stablePrefixBudgetRatioPpm: 300000,
    stablePrefixHash: "sha256:fixturestableprefix",
    cacheHitTokens: 0,
    cacheMissTokens: 120,
    sections: [
      { placement: "stable_prefix", itemCount: 1 },
      { placement: "dynamic_prelude", itemCount: 1 },
      { placement: "turn_suffix", itemCount: 2 },
    ],
    includedSources: [
      {
        kind: "diagnostic",
        path: "src/broken.ts",
        tokens: 20,
        required: false,
        reason: "workspace diagnostics",
      },
    ],
    omittedSources: [],
    estimator: {
      name: "fixture",
      exact: false,
      description: "Fixture estimator",
    },
    manifest: {
      manifestHash: "sha256:fixturemanifest",
      maxEntries: 500,
      totalDiscoveredFiles: 1,
      includedFiles: 1,
      omitted: [],
    },
  });
}

function emitEvent(runId, turnId, type, payload) {
  const event = {
    seq,
    time: new Date().toISOString(),
    type,
    runId,
    turnId,
    payload,
  };
  seq += 1;
  send({
    jsonrpc: "2.0",
    method: "agent.event",
    params: event,
  });
  log({ kind: "event", event });
}

function initializeResult() {
  return {
    protocolVersion: "0.1.0",
    server: {
      name: "prole-coder-vscode-fixture",
      version: "0.1.0",
    },
    capabilities: {
      protocolVersion: "0.1.0",
      supportsRunResume: true,
      supportsPatchApproval: true,
      supportsPersistentApprovals: true,
      supportsEventBatching: true,
      supportedRiskLevels: ["read", "write", "exec", "network", "destructive"],
      provider: {
        provider: "fixture",
        defaultModel: "fixture-model",
        models: [
          {
            id: "fixture-model",
            displayName: "Fixture Model",
            contextWindowTokens: 1000,
            maxOutputTokens: 128,
            supportsThinking: false,
            supportsToolCalls: true,
            supportsToolChoice: true,
            supportsFim: true,
            supportsStreaming: true,
            reportsCacheUsage: true,
          },
        ],
      },
    },
    stateDir: path.join(process.cwd(), ".prole-coder-fixture"),
  };
}

function listRuns(limit) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : 20;
  return [...runs.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, max);
}

function updateRun(runId, patch) {
  const current = runs.get(runId);
  if (current === undefined) {
    return;
  }
  runs.set(runId, {
    ...current,
    ...patch,
  });
}

function respond(id, result) {
  send({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function respondError(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(entry) {
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
