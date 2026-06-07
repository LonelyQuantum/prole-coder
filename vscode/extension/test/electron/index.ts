import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as vscode from "vscode";

const extensionId = "prole-coder.prole-coder-vscode";
const TEST_CHAT_MESSAGE_COMMAND = "prole-coder.test.chatMessage";
const TEST_CHAT_STATE_COMMAND = "prole-coder.test.chatState";
const TEST_CHAT_PROBE_COMMAND = "prole-coder.test.chatProbe";
const SEND_LABEL = "Send message";
const STOP_LABEL = "Stop current turn";
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
  assert.equal(commands.includes(TEST_CHAT_PROBE_COMMAND), true);
  await vscode.commands.executeCommand("prole-coder.openChat");

  await exerciseChatSendTurnDiagnosticsAndApproval();
  await exerciseChatCancel();
  await exerciseRunListAndResume();
  await exerciseChatKeyboardSubmit();
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

    const approvalReady = await waitFor("inline approval card in chat webview", async () => {
      const current = await chatState();
      return current.approval?.approvalId === "approval-run-approval-1-turn-1" &&
        current.submission.runId === "run-approval-1"
        ? current
        : undefined;
    });
    assert.equal(approvalReady.context.status, "ready");
    assert.equal(approvalReady.timeline.latestRunId, "run-approval-1");
    assert.ok(approvalReady.timeline.items.some((item) => item.type === "tool.approvalRequired"));

    const approvalProbe = await chatProbeSnapshot();
    assert.equal(approvalProbe.conversationActive, true);
    assert.equal(approvalProbe.runsHidden, true);
    assert.equal(approvalProbe.contextHidden, true);
    assert.equal(approvalProbe.approvalVisible, true);
    assert.equal(approvalProbe.workLogVisible, true);
    assert.equal(approvalProbe.workLogOpen, false);
    assert.match(approvalProbe.workLogTitle, /^Working: /);
    assert.deepEqual(approvalProbe.providerActions, [
      "Configure DeepSeek API key",
      "Select DeepSeek model",
    ]);
    assert.equal(approvalProbe.settingsActionVisible, true);
    assert.ok(approvalProbe.visibleItemTitles.includes("You"));
    assert.ok(!approvalProbe.visibleItemTitles.includes("Approval required: shell"));

    await chatProbe({ type: "click", selector: ".approval-action.approve" });

    const state = await waitFor("completed approval-backed chat turn", async () => {
      const current = await chatState();
      return current.submission.status === "completed" &&
        current.submission.runId === "run-approval-1" &&
        current.timeline.items.some((item) => item.type === "tool.approvalResolved")
        ? current
        : undefined;
    });
    assert.equal(state.context.status, "ready");
    assert.ok(state.timeline.items.some((item) => item.type === "tool.approvalResolved"));
    const completedProbe = await chatProbeSnapshot();
    assert.equal(completedProbe.approvalVisible, false);
    assert.equal(completedProbe.workLogVisible, false);
    assert.equal(completedProbe.workLogOpen, false);
    assert.ok(completedProbe.visibleItemTitles.includes("You"));
    assert.ok(completedProbe.visibleItemTitles.includes("DeepSeek"));
    assert.ok(completedProbe.markdownBlockCount >= 2);
    assert.ok(completedProbe.markdownCodeBlocks.includes("ok"));
    assert.ok(completedProbe.markdownLinks.includes("https://example.com/docs"));
    assert.ok(completedProbe.markdownTables >= 1);

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
      logEntry((entry) => entry.method === "agent.approve" && entry.params?.approvalId === "approval-run-approval-1-turn-1"),
    );
    assert.equal(approve.params?.persist, "never");
  } finally {
    diagnostics.dispose();
  }
}

async function exerciseChatCancel(): Promise<void> {
  await postChatMessage({
    type: "showRuns",
  });

  await chatProbe({ type: "setPrompt", value: "integration cancel flow" });
  const sendingProbe = await chatProbe({ type: "click", selector: "#send" });
  assert.equal(sendingProbe.snapshot.sendLabel, STOP_LABEL);
  assert.equal(sendingProbe.snapshot.sendTitle, STOP_LABEL);
  assert.equal(sendingProbe.snapshot.sendIsStop, true);
  assert.deepEqual(sendingProbe.snapshot.sendVisibleIcons, ["stop"]);
  assert.equal(sendingProbe.snapshot.sendDisabled, false);
  assert.equal(sendingProbe.snapshot.modeHidden, true);
  assert.equal(sendingProbe.snapshot.cancelDisabled, true);
  await chatProbe({ type: "click", selector: "#send" });

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
  const resumedProbe = await chatProbeSnapshot();
  assert.equal(resumedProbe.conversationActive, true);
  assert.ok(resumedProbe.visibleItemTitles.includes("DeepSeek"));
  assert.ok(resumedProbe.markdownTables >= 1);
  assert.ok(resumedProbe.markdownHorizontalRules >= 1);
  assert.ok(resumedProbe.markdownInlineCodes.includes("parseAmount"));
  assert.ok(resumedProbe.markdownInlineCodes.includes("src/ledger.js"));
  assert.ok(resumedProbe.markdownText.includes("代码库检查总结"));

  await waitFor("logged resume request", async () =>
    logEntry((entry) => entry.method === "agent.resume" && entry.params?.runId === "run-history-1"),
  );

  await postChatMessage({
    type: "submitTurn",
    message: "integration resume follow up",
    mode: "edit",
  });

  await waitFor("inline approval for resumed run follow-up", async () => {
    const current = await chatState();
    return current.approval?.approvalId === "approval-run-history-1-turn-3" ? current : undefined;
  });
  await chatProbe({ type: "click", selector: ".approval-action.approve" });

  const continued = await waitFor("completed resumed run follow-up turn", async () => {
    const current = await chatState();
    return current.submission.status === "completed" &&
      current.submission.runId === "run-history-1" &&
      current.timeline.items.some((item) => item.turnId === "turn-3" && item.type === "run.completed")
      ? current
      : undefined;
  });
  assert.equal(continued.runs.selectedRunId, "run-history-1");

  const resumedSendTurn = await waitFor("logged resumed sendTurn with runId", async () =>
    logEntry(
      (entry) =>
        entry.method === "agent.sendTurn" &&
        entry.params?.message === "integration resume follow up" &&
        entry.params?.runId === "run-history-1",
    ),
  );
  assert.equal(resumedSendTurn.params?.mode, "edit");

  await chatProbe({ type: "click", selector: "#show-runs" });
  const runsProbe = await waitFor("runs visible after conversation back", async () => {
    const snapshot = await chatProbeSnapshot();
    return snapshot.conversationActive === false && snapshot.runIds.includes("run-history-1")
      ? snapshot
      : undefined;
  });
  assert.equal(runsProbe.runsHidden, false);

  await chatProbe({ type: "click", selector: '.run-entry-row[data-run-id="run-history-1"] .run-delete' });
  const deleteProbe = await chatProbeSnapshot();
  assert.equal(deleteProbe.runDeleteConfirmVisible, true);

  await chatProbe({ type: "click", selector: '.run-entry-row[data-run-id="run-history-1"] .confirm-delete' });

  const deleted = await waitFor("run deleted through inline webview confirmation", async () => {
    const current = await chatState();
    return current.runs.status === "ready" && current.runs.runs.every((run) => run.runId !== "run-history-1")
      ? current
      : undefined;
  });
  assert.equal(deleted.runs.selectedRunId, undefined);

  await waitFor("logged delete run request", async () =>
    logEntry((entry) => entry.method === "agent.deleteRun" && entry.params?.runId === "run-history-1"),
  );
}

async function exerciseChatKeyboardSubmit(): Promise<void> {
  await postChatMessage({
    type: "showRuns",
  });
  await chatProbe({ type: "setPrompt", value: "keyboard integration turn" });

  const shifted = await chatProbe({ type: "keydown", key: "Enter", shiftKey: true });
  assert.equal(shifted.defaultPrevented, false);

  const composing = await chatProbe({ type: "keydown", key: "Enter", isComposing: true });
  assert.equal(composing.defaultPrevented, true);
  assert.equal(composing.snapshot.promptValue, "keyboard integration turn");

  const submitted = await chatProbe({ type: "keydown", key: "Enter" });
  assert.equal(submitted.defaultPrevented, true);
  assert.equal(submitted.snapshot.sendLabel, STOP_LABEL);
  assert.deepEqual(submitted.snapshot.sendVisibleIcons, ["stop"]);
  assert.equal(submitted.snapshot.sendDisabled, false);
  assert.equal(submitted.snapshot.modeHidden, true);

  const sentTurn = await waitFor("logged keyboard sendTurn", async () =>
    logEntry((entry) => entry.method === "agent.sendTurn" && entry.params?.message === "keyboard integration turn"),
  );
  assert.equal(sentTurn.params?.message, "keyboard integration turn");
  const turnStarted = await waitFor("logged keyboard turn start", async () =>
    logEntry(
      (entry) =>
        entry.kind === "event" &&
        entry.event?.type === "turn.started" &&
        entry.event.payload?.userTask === "keyboard integration turn",
    ),
  );
  const sentRunId = turnStarted.event?.runId;
  const sentTurnId = turnStarted.event?.turnId;
  assert.ok(typeof sentRunId === "string");
  assert.ok(typeof sentTurnId === "string");
  const approvalRequired = await waitFor("logged keyboard approval request", async () =>
    logEntry(
      (entry) =>
        entry.kind === "event" &&
        entry.event?.type === "tool.approvalRequired" &&
        entry.event.runId === sentRunId &&
        entry.event.turnId === sentTurnId &&
        typeof entry.event.payload?.approvalId === "string",
    ),
  );
  const expectedApprovalId = approvalRequired.event?.payload?.approvalId;
  assert.ok(typeof expectedApprovalId === "string");

  await waitFor("keyboard-submitted turn waiting for approval", async () => {
    const current = await chatState();
    return current.approval?.approvalId === expectedApprovalId ? current : undefined;
  });
  await chatProbe({ type: "click", selector: ".approval-action.approve" });

  await waitFor("keyboard-submitted turn completed", async () => {
    const current = await chatState();
    return current.submission.status === "completed" &&
      current.timeline.items.some((item) => item.type === "run.completed")
      ? current
      : undefined;
  });

  await waitFor("logged keyboard turn approval", async () =>
    logEntry((entry) => entry.method === "agent.approve" && entry.params?.approvalId === expectedApprovalId),
  );

  const editable = await chatProbeSnapshot();
  assert.equal(editable.sendLabel, SEND_LABEL);
  assert.equal(editable.sendTitle, SEND_LABEL);
  assert.equal(editable.sendIsStop, false);
  assert.deepEqual(editable.sendVisibleIcons, ["submit"]);
  assert.equal(editable.modeHidden, true);
  assert.ok(editable.messageEditLabels.includes("Edit and resend message"));
  assert.ok(editable.messageEditDisabled.every((disabled) => disabled === false));

  const editProbe = await chatProbe({ type: "click", selector: ".item.user .message-edit" });
  assert.equal(editProbe.snapshot.promptValue, "keyboard integration turn");

  await chatProbe({ type: "setPrompt", value: "keyboard integration turn edited" });
  await chatProbe({ type: "click", selector: "#send" });

  const editedSendTurn = await waitFor("logged edited resend", async () =>
    logEntry((entry) => entry.method === "agent.sendTurn" && entry.params?.message === "keyboard integration turn edited"),
  );
  assert.equal(editedSendTurn.params?.runId, sentRunId);
  assert.equal(editedSendTurn.params?.supersedes?.turnId, sentTurnId);
  assert.match(String(editedSendTurn.params?.supersedes?.messageId), new RegExp(`^${sentRunId}:`));

  const editedApproval = await waitFor("inline approval for edited resend", async () => {
    const current = await chatState();
    return current.approval?.approvalId !== undefined && current.approval.approvalId !== expectedApprovalId
      ? current
      : undefined;
  });
  const editedApprovalId = editedApproval.approval?.approvalId;
  assert.ok(typeof editedApprovalId === "string");

  await chatProbe({ type: "click", selector: ".approval-action.approve" });

  await waitFor("edited resend completed", async () => {
    const current = await chatState();
    return current.submission.status === "completed" &&
      current.timeline.items.some((item) => item.type === "run.completed" && item.turnId !== sentTurnId)
      ? current
      : undefined;
  });

  await waitFor("logged edited turn approval", async () =>
    logEntry((entry) => entry.method === "agent.approve" && entry.params?.approvalId === editedApprovalId),
  );
  const editedProbe = await chatProbeSnapshot();
  assert.ok(editedProbe.userMessages.includes("keyboard integration turn edited"));
  assert.ok(!editedProbe.userMessages.includes("keyboard integration turn"));
  assert.ok(editedProbe.supersededUserItemIds.some((id) => id.includes(sentRunId)));
}

async function postChatMessage(message: unknown): Promise<void> {
  await vscode.commands.executeCommand(TEST_CHAT_MESSAGE_COMMAND, message);
}

async function chatState(): Promise<ChatState> {
  return await vscode.commands.executeCommand<ChatState>(TEST_CHAT_STATE_COMMAND);
}

async function chatProbe(action: Record<string, unknown>): Promise<WebviewProbeSnapshotResult> {
  return await vscode.commands.executeCommand<WebviewProbeSnapshotResult>(TEST_CHAT_PROBE_COMMAND, action);
}

async function chatProbeSnapshot(): Promise<WebviewProbeSnapshot> {
  const result = await chatProbe({ type: "snapshot" });
  return result.snapshot;
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
      readonly turnId?: string;
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
  readonly approval?: {
    readonly approvalId: string;
  };
}

interface RpcFixtureLogEntry {
  readonly kind?: string;
  readonly method?: string;
  readonly params?: {
    readonly message?: string;
    readonly mode?: string;
    readonly approvalId?: string;
    readonly persist?: string;
    readonly runId?: string;
    readonly reason?: string;
    readonly attachments?: ReadonlyArray<Record<string, unknown>>;
    readonly supersedes?: {
      readonly messageId?: string;
      readonly turnId?: string;
    };
  };
  readonly event?: {
    readonly type?: string;
    readonly runId?: string;
    readonly turnId?: string;
    readonly payload?: {
      readonly approvalId?: string;
      readonly userTask?: string;
    };
  };
}

interface WebviewProbeSnapshotResult {
  readonly clicked?: boolean;
  readonly defaultPrevented?: boolean;
  readonly value?: string;
  readonly snapshot: WebviewProbeSnapshot;
}

interface WebviewProbeSnapshot {
  readonly conversationActive: boolean;
  readonly statusHidden: boolean;
  readonly runsHidden: boolean;
  readonly contextHidden: boolean;
  readonly approvalVisible: boolean;
  readonly approvalTitle: string;
  readonly approvalActionLabels: readonly string[];
  readonly runDeleteConfirmVisible: boolean;
  readonly runIds: readonly string[];
  readonly visibleItemTitles: readonly string[];
  readonly visibleItemTypes: readonly string[];
  readonly userMessages: readonly string[];
  readonly markdownBlockCount: number;
  readonly markdownCodeBlocks: readonly string[];
  readonly markdownInlineCodes: readonly string[];
  readonly markdownLinks: readonly string[];
  readonly markdownTables: number;
  readonly markdownHorizontalRules: number;
  readonly markdownText: string;
  readonly workLogVisible: boolean;
  readonly workLogOpen: boolean;
  readonly workLogTitle: string;
  readonly workLogTypes: readonly string[];
  readonly workLogSegmentSummaries?: readonly string[];
  readonly promptValue: string;
  readonly sendLabel: string;
  readonly sendTitle: string;
  readonly sendIsStop: boolean;
  readonly sendVisibleIcons: readonly string[];
  readonly sendDisabled: boolean;
  readonly modeHidden: boolean;
  readonly cancelDisabled: boolean;
  readonly messageEditButtons: readonly string[];
  readonly messageEditLabels: readonly string[];
  readonly messageEditDisabled: readonly boolean[];
  readonly supersededUserItemIds: readonly string[];
  readonly providerActions: readonly string[];
  readonly settingsActionVisible: boolean;
}
