import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as vscode from "vscode";

const extensionId = "prole-coder.prole-coder-vscode";
const TEST_CHAT_MESSAGE_COMMAND = "prole-coder.test.chatMessage";
const TEST_CHAT_STATE_COMMAND = "prole-coder.test.chatState";
const CONTRIBUTED_COMMANDS = [
  "prole-coder.openChat",
  "prole-coder.openSettings",
  "prole-coder.configureDeepSeekApiKey",
  "prole-coder.clearDeepSeekApiKey",
  "prole-coder.showProviderStatus",
  "prole-coder.selectDeepSeekModel",
  "prole-coder.generateCommitMessage",
  "prole-coder.generatePrDescription",
] as const;

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(extensionId);

  assert.ok(extension, `${extensionId} should be installed in the test host`);
  await extension.activate();
  assert.equal(extension.isActive, true);
  assert.equal(contributesProleChatParticipant(extension.packageJSON), true);
  assert.equal(vscode.workspace.isTrusted, true);
  assert.equal(vscode.workspace.getConfiguration("prole-coder.rpc").get("autoStart"), false);

  await vscode.commands.executeCommand("workbench.view.extension.prole-coder");
  await vscode.commands.executeCommand("prole-coder.chat.focus");

  const commands = await vscode.commands.getCommands(true);
  for (const command of CONTRIBUTED_COMMANDS) {
    assert.equal(commands.includes(command), true);
  }
  assert.equal(commands.includes(TEST_CHAT_MESSAGE_COMMAND), true);
  assert.equal(commands.includes(TEST_CHAT_STATE_COMMAND), true);
  await vscode.commands.executeCommand("prole-coder.openChat");

  await exerciseChatSendTurnDiagnosticsAndApproval();
  await exerciseChatCancel();
  await exerciseRunListAndResume();
}

async function exerciseChatSendTurnDiagnosticsAndApproval(): Promise<void> {
  const diagnostics = vscode.languages.createDiagnosticCollection("prole-coder-e2e");
  try {
    const workspace = workspaceFolder();
    const fileUri = vscode.Uri.joinPath(workspace.uri, "src", "broken.ts");
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspace.uri, "src"));
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from("const broken = true;\n", "utf8"));
    diagnostics.set(fileUri, [
      new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 5),
        "fixture diagnostic from extension-host test",
        vscode.DiagnosticSeverity.Error,
      ),
    ]);

    await postChatMessage({
      type: "submitTurn",
      message: "integration approval flow",
      mode: "edit",
    });

    const state = await waitFor("completed approval-backed chat turn", async () => {
      const current = await chatState();
      return current.submission.status === "completed" &&
        current.submission.runId === "run-approval-1"
        ? current
        : undefined;
    });
    assert.equal(state.context.status, "ready");
    assert.equal(state.timeline.latestRunId, "run-approval-1");
    assert.ok(state.timeline.items.some((item) => item.type === "tool.approvalRequired"));
    assert.ok(state.timeline.items.some((item) => item.type === "tool.approvalResolved"));

    const sendTurn = await waitFor("logged sendTurn with diagnostics", async () =>
      logEntry((entry) => entry.method === "agent.sendTurn" && entry.params?.message === "integration approval flow"),
    );
    assert.equal(sendTurn.params?.mode, "edit");
    assert.ok(
      Array.isArray(sendTurn.params?.attachments) &&
        sendTurn.params.attachments.some(
          (attachment: Record<string, unknown>) =>
            attachment["kind"] === "diagnostic" &&
            attachment["path"] === "src/broken.ts" &&
            String(attachment["text"]).includes("fixture diagnostic"),
        ),
    );

    const approve = await waitFor("logged approval response", async () =>
      logEntry((entry) => entry.method === "agent.approve" && entry.params?.approvalId === "approval-approval-1"),
    );
    assert.equal(approve.params?.persist, "never");
  } finally {
    diagnostics.dispose();
  }
}

async function exerciseChatCancel(): Promise<void> {
  await postChatMessage({
    type: "submitTurn",
    message: "integration cancel flow",
    mode: "edit",
  });

  const running = await waitFor("running cancelable chat turn", async () => {
    const current = await chatState();
    return current.submission.status === "running" && current.submission.runId === "run-cancel-1"
      ? current
      : undefined;
  });
  assert.equal(running.submission.busy, true);

  await postChatMessage({
    type: "cancelTurn",
    runId: "run-cancel-1",
  });

  const canceled = await waitFor("canceled chat turn", async () => {
    const current = await chatState();
    return current.submission.status === "canceled" &&
      current.submission.runId === "run-cancel-1" &&
      current.timeline.items.some((item) => item.type === "run.canceled")
      ? current
      : undefined;
  });
  assert.equal(canceled.submission.busy, false);
  assert.ok(canceled.timeline.items.some((item) => item.type === "run.canceled"));

  const cancel = await waitFor("logged cancel request", async () =>
    logEntry((entry) => entry.method === "agent.cancel" && entry.params?.runId === "run-cancel-1"),
  );
  assert.equal(cancel.params?.reason, "canceled in VS Code");
}

async function exerciseRunListAndResume(): Promise<void> {
  await postChatMessage({
    type: "refreshRuns",
  });

  const listed = await waitFor("run list containing historical fixture run", async () => {
    const current = await chatState();
    return current.runs.status === "ready" &&
      current.runs.runs.some((run) => run.runId === "run-history-1")
      ? current
      : undefined;
  });
  assert.ok(listed.runs.runs.length >= 1);

  await postChatMessage({
    type: "resumeRun",
    runId: "run-history-1",
  });

  const resumed = await waitFor("resumed historical fixture run", async () => {
    const current = await chatState();
    return current.runs.selectedRunId === "run-history-1" &&
      current.timeline.latestRunId === "run-history-1" &&
      current.timeline.items.some((item) => item.type === "run.completed")
      ? current
      : undefined;
  });
  assert.equal(resumed.submission.status, "idle");

  await waitFor("logged resume request", async () =>
    logEntry((entry) => entry.method === "agent.resume" && entry.params?.runId === "run-history-1"),
  );
}

async function postChatMessage(message: unknown): Promise<void> {
  await vscode.commands.executeCommand(TEST_CHAT_MESSAGE_COMMAND, message);
}

async function chatState(): Promise<ChatState> {
  return await vscode.commands.executeCommand<ChatState>(TEST_CHAT_STATE_COMMAND);
}

async function waitFor<T>(
  label: string,
  predicate: () => Promise<T | undefined>,
  timeoutMs = 5000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const result = await predicate();
    if (result !== undefined) {
      return result;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await delay(25);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function logEntry(predicate: (entry: RpcFixtureLogEntry) => boolean): Promise<RpcFixtureLogEntry | undefined> {
  const logPath = process.env["PROLE_CODER_VSCODE_TEST_RPC_LOG"];
  assert.ok(logPath, "PROLE_CODER_VSCODE_TEST_RPC_LOG must be set");
  const raw = await readFile(logPath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  for (const line of raw.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }
    const entry = JSON.parse(line) as RpcFixtureLogEntry;
    if (predicate(entry)) {
      return entry;
    }
  }
  return undefined;
}

function workspaceFolder(): vscode.WorkspaceFolder {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, "integration test requires a workspace folder");
  return workspace;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function contributesProleChatParticipant(packageJson: unknown): boolean {
  if (!isRecord(packageJson)) {
    return false;
  }
  const contributes = packageJson["contributes"];
  if (!isRecord(contributes)) {
    return false;
  }
  const chatParticipants = contributes["chatParticipants"];
  return (
    Array.isArray(chatParticipants) &&
    chatParticipants.some(
      (participant) =>
        isRecord(participant) &&
        participant["id"] === "prole-coder.chatParticipant" &&
        participant["name"] === "prole",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ChatState {
  readonly timeline: {
    readonly latestRunId?: string;
    readonly items: ReadonlyArray<{
      readonly type: string;
    }>;
  };
  readonly submission: {
    readonly busy: boolean;
    readonly status: string;
    readonly runId?: string;
  };
  readonly runs: {
    readonly status: string;
    readonly selectedRunId?: string;
    readonly runs: ReadonlyArray<{
      readonly runId: string;
    }>;
  };
  readonly context: {
    readonly status: string;
  };
}

interface RpcFixtureLogEntry {
  readonly method?: string;
  readonly params?: {
    readonly message?: string;
    readonly mode?: string;
    readonly approvalId?: string;
    readonly persist?: string;
    readonly runId?: string;
    readonly reason?: string;
    readonly attachments?: ReadonlyArray<Record<string, unknown>>;
  };
}
