import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

import type {
  CancelParams,
  CancelResult,
  DeleteRunParams,
  DeleteRunResult,
  ListRunsParams,
  ListRunsResult,
  ResumeParams,
  ResumeResult,
  SendTurnParams,
  SendTurnResult,
} from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

import {
  automaticContextAttachmentFromTimeline,
  mergeTurnAttachments,
} from "./automaticContext";
import {
  approvalDecisionFromWebviewMessage,
  chatApprovalSnapshotFromRequest,
  type ChatApprovalSnapshot,
} from "./chatApprovals";
import { CHAT_RUN_MODES, DEFAULT_CHAT_MODE, parseChatTurnSubmission, sendTurnParams } from "./chatInput";
import { ChatEventTimeline, type ChatTimelineSnapshot } from "./chatEvents";
import { OPEN_SETTINGS_COMMAND, type ApprovalPromptDecision, type ApprovalPromptRequest } from "./commands";
import {
  contextVizFromEvent,
  emptyContextViz,
  type ContextVizSnapshot,
} from "./contextViz";
import { diagnosticAttachmentsFromProblems } from "./diagnostics";
import type { ProleLogger } from "./logging";
import {
  isConfigureDeepSeekApiKeyAction,
  providerConfigurationActionFromError,
  providerConfigurationActionFromPayload,
  type ProviderConfigurationAction,
} from "./providerConfigurationUx";
import {
  CONFIGURE_DEEPSEEK_API_KEY_COMMAND,
  SELECT_DEEPSEEK_MODEL_COMMAND,
} from "./providerSecretCommands";
import type { MessageRedactor } from "./redaction";
import type { AgentEventEnvelope, DisposableLike } from "./rpcServer";
import {
  RUN_LIST_LIMIT,
  deletedRunList,
  failedRunList,
  idleRunList,
  isRefreshRunsMessage,
  deleteRunIdFromMessage,
  loadingRunList,
  readyRunList,
  resumeRunIdFromMessage,
  type RunListSnapshot,
} from "./runHistory";
import { safeScriptJson } from "./webviewSerialization";

export const CHAT_VIEW_ID = "prole-coder.chat";

export interface ChatRpcEventSource {
  onEvent(handler: (event: AgentEventEnvelope) => void): DisposableLike;
}

export interface ChatTurnSender {
  sendTurn(params: SendTurnParams): Promise<SendTurnResult>;
}

export interface ChatCancelClient {
  cancel(params: CancelParams): Promise<CancelResult>;
}

export interface ChatRunHistoryClient {
  listRuns(params?: ListRunsParams): Promise<ListRunsResult>;
  resume(params: ResumeParams): Promise<ResumeResult>;
  deleteRun(params: DeleteRunParams): Promise<DeleteRunResult>;
}

export type ChatRpcClient = ChatRpcEventSource & ChatTurnSender & ChatCancelClient & ChatRunHistoryClient;

interface SnapshotWebviewMessage {
  readonly type: "snapshot";
  readonly snapshot: ChatTimelineSnapshot;
}

interface SubmissionWebviewMessage {
  readonly type: "submission";
  readonly submission: ChatSubmissionSnapshot;
}

interface RunsWebviewMessage {
  readonly type: "runs";
  readonly runs: RunListSnapshot;
}

interface ContextWebviewMessage {
  readonly type: "context";
  readonly context: ContextVizSnapshot;
}

interface ApprovalWebviewMessage {
  readonly type: "approval";
  readonly approval?: ChatApprovalSnapshot;
}

type ExtensionToWebviewMessage =
  | SnapshotWebviewMessage
  | SubmissionWebviewMessage
  | RunsWebviewMessage
  | ContextWebviewMessage
  | ApprovalWebviewMessage
  | TestProbeWebviewMessage;

interface TestProbeWebviewMessage {
  readonly type: "testProbe";
  readonly id: string;
  readonly action: unknown;
}

interface TestProbeResultWebviewMessage {
  readonly type: "testProbeResult";
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

type ChatSubmissionStatus = "idle" | "sending" | "running" | "completed" | "failed" | "canceled";
type TerminalSubmissionStatus = Extract<ChatSubmissionStatus, "completed" | "failed" | "canceled">;

export interface ChatSubmissionAction {
  readonly type: ProviderConfigurationAction["type"];
  readonly label: string;
}

export interface ChatSubmissionSnapshot {
  readonly busy: boolean;
  readonly status: ChatSubmissionStatus;
  readonly message: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly error?: string;
  readonly canceling?: boolean;
  readonly action?: ChatSubmissionAction;
}

interface TerminalRunState {
  readonly status: TerminalSubmissionStatus;
  readonly message: string;
  readonly error?: string;
  readonly action?: ChatSubmissionAction;
}

export interface ChatViewTestState {
  readonly timeline: ChatTimelineSnapshot;
  readonly submission: ChatSubmissionSnapshot;
  readonly runs: RunListSnapshot;
  readonly context: ContextVizSnapshot;
  readonly approval?: ChatApprovalSnapshot;
}

interface PendingApprovalState {
  readonly request: ApprovalPromptRequest;
  resolve(decision: ApprovalPromptDecision): void;
}

interface PendingTestProbe {
  readonly timeout: ReturnType<typeof setTimeout>;
  resolve(result: unknown): void;
  reject(error: Error): void;
}

export class ProleChatViewProvider implements vscode.WebviewViewProvider, DisposableLike {
  private readonly timeline = new ChatEventTimeline();
  private readonly terminalRuns = new Map<string, TerminalRunState>();
  private readonly rpcClient: ChatRpcClient | undefined;
  private submission: ChatSubmissionSnapshot = idleSubmission();
  private runList: RunListSnapshot = idleRunList();
  private contextViz: ContextVizSnapshot = emptyContextViz();
  private activeConversationRunId: string | undefined;
  private pendingApproval: PendingApprovalState | undefined;
  private readonly pendingTestProbes = new Map<string, PendingTestProbe>();
  private rpcSubscription: DisposableLike | undefined;
  private viewMessageSubscription: DisposableLike | undefined;
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    rpcClient?: ChatRpcClient,
    private readonly workspaceRoot?: string,
    private readonly logger?: ProleLogger,
    private readonly redactor?: MessageRedactor,
  ) {
    this.rpcClient = rpcClient;
    this.rpcSubscription = rpcClient?.onEvent((event) => {
      this.logger?.info(this.redact(formatAgentEventLog(event)));
      this.timeline.append(event);
      const contextViz = contextVizFromEvent(event);
      if (contextViz !== undefined) {
        this.contextViz = contextViz;
      }
      const terminal = this.updateSubmissionForEvent(event);
      if (terminal) {
        this.rejectPendingApproval("run ended before approval was resolved");
      }
      this.postSnapshot();
      if (contextViz !== undefined) {
        this.postContext();
      }
      this.postSubmission();
      if (terminal && this.view !== undefined) {
        void this.refreshRuns("Refreshing runs...");
      }
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    this.viewMessageSubscription?.dispose();
    this.viewMessageSubscription = webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleWebviewMessage(message);
    });
    webviewView.webview.html = renderChatViewHtml(
      webviewView.webview,
      this.timeline.snapshot(),
      this.submission,
      this.runList,
      this.contextViz,
      this.pendingApprovalSnapshot(),
    );
    this.postSnapshot();
    this.postSubmission();
    this.postRuns();
    this.postContext();
    this.postApproval();
    void this.refreshRuns();
  }

  openChatView(): Thenable<unknown> {
    return vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
  }

  testHandleWebviewMessage(message: unknown): Promise<void> {
    return this.handleWebviewMessage(message);
  }

  testState(): ChatViewTestState {
    const approval = this.pendingApprovalSnapshot();
    return {
      timeline: this.timeline.snapshot(),
      submission: this.submission,
      runs: this.runList,
      context: this.contextViz,
      ...(approval === undefined ? {} : { approval }),
    };
  }

  async testProbeWebview(action: unknown): Promise<unknown> {
    if (this.view === undefined) {
      throw new Error("chat webview is not available");
    }

    const id = randomUUID();
    const message: TestProbeWebviewMessage = {
      type: "testProbe",
      id,
      action,
    };

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingTestProbes.delete(id);
        reject(new Error(`timed out waiting for chat webview test probe ${id}`));
      }, 2000);
      this.pendingTestProbes.set(id, { timeout, resolve, reject });
      void this.view?.webview.postMessage(message).then((delivered) => {
        if (!delivered) {
          this.rejectTestProbe(id, new Error("chat webview did not accept the test probe message"));
        }
      });
    });
  }

  isIdle(): boolean {
    return !this.submission.busy;
  }

  dispose(): void {
    this.rejectPendingApproval("approval view disposed");
    this.rejectPendingTestProbes("chat view disposed");
    this.rpcSubscription?.dispose();
    this.viewMessageSubscription?.dispose();
    this.rpcSubscription = undefined;
    this.viewMessageSubscription = undefined;
  }

  requestApproval(request: ApprovalPromptRequest): Promise<ApprovalPromptDecision> {
    this.rejectPendingApproval("superseded by a newer approval request");
    void this.openChatView();

    return new Promise((resolve) => {
      this.pendingApproval = {
        request,
        resolve,
      };
      this.postApproval();
    });
  }

  private async handleWebviewMessage(message: unknown): Promise<void> {
    const testProbeResult = testProbeResultFromMessage(message);
    if (testProbeResult !== undefined) {
      this.resolveTestProbe(testProbeResult);
      return;
    }

    if (isRefreshRunsMessage(message)) {
      await this.refreshRuns();
      return;
    }

    if (isShowRunsMessage(message)) {
      this.showRuns();
      return;
    }

    const approvalDecision =
      this.pendingApproval === undefined
        ? undefined
        : approvalDecisionFromWebviewMessage(message, this.pendingApproval.request);
    if (approvalDecision !== undefined) {
      this.resolvePendingApproval(approvalDecision);
      return;
    }

    const resumeRunId = resumeRunIdFromMessage(message);
    if (resumeRunId !== undefined) {
      await this.resumeRun(resumeRunId);
      return;
    }

    const deleteRunId = deleteRunIdFromMessage(message);
    if (deleteRunId !== undefined) {
      await this.deleteRun(deleteRunId);
      return;
    }

    const cancelRunId = cancelRunIdFromMessage(message);
    if (cancelRunId !== undefined) {
      await this.cancelTurn(cancelRunId);
      return;
    }

    if (isConfigureDeepSeekApiKeyMessage(message)) {
      await this.configureDeepSeekApiKey();
      return;
    }

    if (isSelectDeepSeekModelMessage(message)) {
      await this.selectDeepSeekModel();
      return;
    }

    if (isOpenSettingsMessage(message)) {
      await this.openSettings();
      return;
    }

    if (!isRecord(message) || message["type"] !== "submitTurn") {
      return;
    }

    const parsed = parseChatTurnSubmission(message);
    if (!parsed.ok) {
      this.setSubmission({
        ...idleSubmission(),
        status: "failed",
        message: parsed.error,
        error: parsed.error,
      });
      return;
    }

    if (this.rpcClient === undefined) {
      this.setSubmission({
        ...idleSubmission(),
        status: "failed",
        message: "Open a trusted workspace before sending a turn.",
        error: "No trusted workspace is available.",
      });
      return;
    }

    if (this.submission.busy) {
      this.setSubmission({
        ...this.submission,
        message: "A turn is already running.",
      });
      return;
    }

    this.setSubmission({
      busy: true,
      status: "sending",
      message: "Sending turn...",
    });
    this.setContextViz(emptyContextViz());

    try {
      const automaticContext = automaticContextAttachmentFromTimeline(this.timeline.snapshot());
      const attachments = mergeTurnAttachments(
        automaticContext,
        this.collectDiagnosticAttachments(),
      );
      const activeRunId = this.activeConversationRunId;
      if (activeRunId !== undefined) {
        this.terminalRuns.delete(activeRunId);
      }
      const params = sendTurnParams(parsed.value, attachments);
      const result = await this.rpcClient.sendTurn(
        activeRunId === undefined ? params : { ...params, runId: activeRunId },
      );
      this.activeConversationRunId = result.runId;
      void this.refreshRuns("Refreshing runs...");
      const terminal = this.terminalRuns.get(result.runId);
      this.setSubmission(
        terminal === undefined
          ? {
              busy: true,
              status: "running",
              message: "Agent turn running.",
              runId: result.runId,
              turnId: result.turnId,
            }
          : terminalSubmission(result.runId, result.turnId, terminal),
      );
    } catch (error) {
      const messageText = `Failed to send turn: ${errorMessage(error)}`;
      const redacted = this.redact(messageText);
      const action = chatSubmissionActionFromProviderAction(
        providerConfigurationActionFromError(error),
      );
      this.logger?.error(redacted);
      this.setSubmission({
        ...idleSubmission(),
        status: "failed",
        message: redacted,
        error: redacted,
        ...(action === undefined ? {} : { action }),
      });
      if (isConfigureDeepSeekApiKeyAction(action)) {
        await this.configureDeepSeekApiKey();
      }
    }
  }

  private postSnapshot(): void {
    const message: ExtensionToWebviewMessage = {
      type: "snapshot",
      snapshot: this.timeline.snapshot(),
    };
    void this.view?.webview.postMessage(message);
  }

  private postSubmission(): void {
    const message: ExtensionToWebviewMessage = {
      type: "submission",
      submission: this.submission,
    };
    void this.view?.webview.postMessage(message);
  }

  private postRuns(): void {
    const message: ExtensionToWebviewMessage = {
      type: "runs",
      runs: this.runList,
    };
    void this.view?.webview.postMessage(message);
  }

  private postContext(): void {
    const message: ExtensionToWebviewMessage = {
      type: "context",
      context: this.contextViz,
    };
    void this.view?.webview.postMessage(message);
  }

  private postApproval(): void {
    const approval = this.pendingApprovalSnapshot();
    const message: ExtensionToWebviewMessage = {
      type: "approval",
      ...(approval === undefined ? {} : { approval }),
    };
    void this.view?.webview.postMessage(message);
  }

  private setSubmission(submission: ChatSubmissionSnapshot): void {
    this.submission = submission;
    this.postSubmission();
  }

  private setRunList(runList: RunListSnapshot): void {
    this.runList = runList;
    this.postRuns();
  }

  private setContextViz(contextViz: ContextVizSnapshot): void {
    this.contextViz = contextViz;
    this.postContext();
  }

  private pendingApprovalSnapshot(): ChatApprovalSnapshot | undefined {
    return this.pendingApproval === undefined
      ? undefined
      : chatApprovalSnapshotFromRequest(this.pendingApproval.request);
  }

  private async refreshRuns(message = "Loading runs..."): Promise<void> {
    if (this.rpcClient === undefined) {
      this.setRunList(
        failedRunList("Open a trusted workspace before loading runs.", this.runList),
      );
      return;
    }

    this.setRunList(loadingRunList(this.runList, message));
    try {
      const result = await this.rpcClient.listRuns({ limit: RUN_LIST_LIMIT });
      this.setRunList(readyRunList(result, this.activeConversationRunId ?? this.runList.selectedRunId));
    } catch (error) {
      const messageText = `Failed to load runs: ${errorMessage(error)}`;
      const redacted = this.redact(messageText);
      this.logger?.error(redacted);
      this.setRunList(failedRunList(redacted, this.runList));
    }
  }

  private async resumeRun(runId: string): Promise<void> {
    if (this.rpcClient === undefined) {
      this.setRunList(
        failedRunList("Open a trusted workspace before replaying a run.", this.runList),
      );
      return;
    }

    if (this.submission.busy) {
      this.setRunList(failedRunList("A turn is already running.", this.runList));
      return;
    }

    this.timeline.clear();
    this.postSnapshot();
    this.setSubmission(idleSubmission());
    this.setContextViz(emptyContextViz());
    this.setRunList(loadingRunList(this.runList, "Replaying run..."));
    try {
      const result = await this.rpcClient.resume({ runId });
      this.activeConversationRunId = result.runId;
      const message = result.replayStarted
        ? `Replaying ${result.runId} through seq ${result.nextSeq - 1}.`
        : `No events to replay for ${result.runId}.`;
      this.setRunList(readyRunList({ runs: this.runList.runs }, result.runId, message));
    } catch (error) {
      const messageText = `Failed to resume run: ${errorMessage(error)}`;
      const redacted = this.redact(messageText);
      this.logger?.error(redacted);
      this.setRunList(failedRunList(redacted, this.runList));
    }
  }

  private async deleteRun(runId: string): Promise<void> {
    if (this.rpcClient === undefined) {
      this.setRunList(
        failedRunList("Open a trusted workspace before deleting a run.", this.runList),
      );
      return;
    }

    if (this.submission.busy) {
      this.setRunList(failedRunList("A turn is already running.", this.runList));
      return;
    }

    this.setRunList(loadingRunList(this.runList, "Deleting run..."));
    try {
      const result = await this.rpcClient.deleteRun({ runId });
      if (this.activeConversationRunId === result.runId) {
        this.activeConversationRunId = undefined;
        this.timeline.clear();
        this.terminalRuns.delete(result.runId);
        this.setSubmission(idleSubmission());
        this.setContextViz(emptyContextViz());
        this.postSnapshot();
      }
      this.setRunList(deletedRunList(this.runList, result.runId, `Deleted ${result.runId}.`));
      void this.refreshRuns("Refreshing runs...");
    } catch (error) {
      const messageText = `Failed to delete run: ${errorMessage(error)}`;
      const redacted = this.redact(messageText);
      this.logger?.error(redacted);
      this.setRunList(failedRunList(redacted, this.runList));
    }
  }

  private showRuns(): void {
    if (this.submission.busy) {
      return;
    }

    this.activeConversationRunId = undefined;
    this.timeline.clear();
    this.setSubmission(idleSubmission());
    this.setContextViz(emptyContextViz());
    this.postSnapshot();
    this.setRunList({
      status: this.runList.status,
      runs: this.runList.runs,
      ...(this.runList.message === undefined ? {} : { message: this.runList.message }),
    });
  }

  private async cancelTurn(runId: string): Promise<void> {
    if (this.rpcClient === undefined) {
      this.setSubmission({
        ...this.submission,
        busy: false,
        status: "failed",
        message: "Open a trusted workspace before canceling a turn.",
        error: "No trusted workspace is available.",
      });
      return;
    }

    if (!this.submission.busy || this.submission.runId !== runId || this.submission.canceling) {
      return;
    }

    this.setSubmission({
      ...this.submission,
      message: "Cancel requested...",
      canceling: true,
    });

    try {
      const result = await this.rpcClient.cancel({
        runId,
        reason: "canceled in VS Code",
      });
      void this.refreshRuns("Refreshing runs...");
      this.setSubmission({
        busy: false,
        status: "canceled",
        message: result.reason ?? "Run canceled.",
        runId: result.runId,
        ...(this.submission.turnId === undefined ? {} : { turnId: this.submission.turnId }),
      });
    } catch (error) {
      const messageText = `Failed to cancel turn: ${errorMessage(error)}`;
      const redacted = this.redact(messageText);
      this.logger?.error(redacted);
      this.setSubmission({
        ...this.submission,
        message: redacted,
        error: redacted,
        canceling: false,
      });
    }
  }

  private collectDiagnosticAttachments(): NonNullable<SendTurnParams["attachments"]> {
    if (this.workspaceRoot === undefined) {
      return [];
    }

    const problems = vscode.languages.getDiagnostics().map(([uri, diagnostics]) => ({
      uri: {
        fsPath: uri.fsPath,
      },
      diagnostics,
    }));

    return diagnosticAttachmentsFromProblems(problems, this.workspaceRoot);
  }

  private updateSubmissionForEvent(event: AgentEventEnvelope): boolean {
    const terminal = terminalRunState(event);
    if (terminal === undefined) {
      return false;
    }

    this.rememberTerminalRun(event.runId, terminal);
    if (this.submission.runId === undefined || event.runId !== this.submission.runId) {
      return false;
    }

    this.submission = terminalSubmission(event.runId, this.submission.turnId, terminal);
    return true;
  }

  private rememberTerminalRun(runId: string, terminal: TerminalRunState): void {
    this.terminalRuns.set(runId, terminal);
    while (this.terminalRuns.size > 50) {
      const oldest = this.terminalRuns.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.terminalRuns.delete(oldest);
    }
  }

  private resolvePendingApproval(decision: ApprovalPromptDecision): void {
    if (
      this.pendingApproval === undefined ||
      this.pendingApproval.request.approvalId !== decision.approvalId
    ) {
      return;
    }

    const pending = this.pendingApproval;
    this.pendingApproval = undefined;
    this.postApproval();
    pending.resolve(decision);
  }

  private rejectPendingApproval(reason: string): void {
    if (this.pendingApproval === undefined) {
      return;
    }

    const pending = this.pendingApproval;
    this.pendingApproval = undefined;
    this.postApproval();
    pending.resolve({
      kind: "reject",
      approvalId: pending.request.approvalId,
      reason,
    });
  }

  private resolveTestProbe(message: TestProbeResultWebviewMessage): void {
    const pending = this.pendingTestProbes.get(message.id);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingTestProbes.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error ?? "chat webview test probe failed"));
    }
  }

  private rejectTestProbe(id: string, error: Error): void {
    const pending = this.pendingTestProbes.get(id);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingTestProbes.delete(id);
    pending.reject(error);
  }

  private rejectPendingTestProbes(reason: string): void {
    for (const [id, pending] of this.pendingTestProbes) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.pendingTestProbes.delete(id);
    }
  }

  private redact(message: string): string {
    return this.redactor?.redact(message) ?? message;
  }

  private async configureDeepSeekApiKey(): Promise<void> {
    await vscode.commands.executeCommand(CONFIGURE_DEEPSEEK_API_KEY_COMMAND);
  }

  private async selectDeepSeekModel(): Promise<void> {
    await vscode.commands.executeCommand(SELECT_DEEPSEEK_MODEL_COMMAND);
  }

  private async openSettings(): Promise<void> {
    await vscode.commands.executeCommand(OPEN_SETTINGS_COMMAND);
  }
}

function renderChatViewHtml(
  webview: vscode.Webview,
  snapshot: ChatTimelineSnapshot,
  submission: ChatSubmissionSnapshot,
  runList: RunListSnapshot,
  contextViz: ContextVizSnapshot,
  approval: ChatApprovalSnapshot | undefined,
): string {
  const nonce = nonceValue();
  const initialSnapshot = safeScriptJson(snapshot);
  const initialSubmission = safeScriptJson(submission);
  const initialRuns = safeScriptJson(runList);
  const initialContext = safeScriptJson(contextViz);
  const initialApproval = safeScriptJson(approval);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
    }

    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    .shell {
      display: flex;
      min-height: 100vh;
      flex-direction: column;
    }

    .shell.conversation-active .status,
    .shell.conversation-active .runs,
    .shell.conversation-active .context-viz {
      display: none;
    }

    .conversation-bar {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-sideBarSectionHeader-background);
    }

    .shell.conversation-active .conversation-bar {
      display: flex;
    }

    .conversation-back {
      width: 26px;
      height: 26px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 1px solid transparent;
      border-radius: 3px;
      cursor: pointer;
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    .conversation-back:hover:enabled {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .conversation-back:disabled {
      opacity: 0.55;
      cursor: default;
    }

    .conversation-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .status {
      display: grid;
      gap: 2px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-sideBarSectionHeader-background);
    }

    .status-title {
      font-weight: 600;
    }

    .status-subtitle {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .runs {
      display: grid;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-sideBar-background);
    }

    .runs-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    .runs-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .refresh-runs {
      flex: 0 0 auto;
      height: 24px;
      padding: 0 8px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 0;
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    .refresh-runs:hover:enabled {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .refresh-runs:disabled {
      opacity: 0.65;
    }

    .run-message {
      min-height: 16px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .run-message.failed {
      color: var(--vscode-editorError-foreground);
    }

    .run-list {
      display: grid;
      gap: 4px;
      max-height: 180px;
      overflow: auto;
    }

    .run-entry-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 28px;
      align-items: stretch;
      gap: 4px;
    }

    .run-entry {
      display: grid;
      gap: 2px;
      width: 100%;
      min-height: 48px;
      box-sizing: border-box;
      padding: 6px 7px;
      color: var(--vscode-foreground);
      background: transparent;
      border: 1px solid transparent;
      border-left: 3px solid var(--vscode-editorWidget-border);
      font: var(--vscode-font-size) var(--vscode-font-family);
      text-align: left;
    }

    .run-delete {
      width: 28px;
      min-height: 48px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 1px solid transparent;
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    .run-delete:hover:enabled {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .run-delete:disabled {
      opacity: 0.55;
    }

    .run-delete-confirm {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 6px;
      padding: 6px 7px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-editorWidget-border);
      font-size: 12px;
    }

    .run-delete-confirm span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .run-delete-confirm button {
      min-width: 52px;
      height: 24px;
      border: 1px solid transparent;
      border-radius: 3px;
      cursor: pointer;
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    .run-delete-confirm .confirm-delete {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .run-delete-confirm .confirm-cancel {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    .run-delete-confirm .confirm-delete:hover,
    .run-delete-confirm .confirm-cancel:hover {
      filter: brightness(1.08);
    }

    .run-entry:hover:enabled,
    .run-entry.selected {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-list-focusOutline, var(--vscode-editorWidget-border));
    }

    .run-entry:disabled {
      opacity: 0.7;
    }

    .run-entry.running {
      border-left-color: var(--vscode-progressBar-background);
    }

    .run-entry.completed {
      border-left-color: var(--vscode-testing-iconPassed);
    }

    .run-entry.failed {
      border-left-color: var(--vscode-editorError-foreground);
    }

    .run-entry.canceled {
      border-left-color: var(--vscode-editorWarning-foreground);
    }

    .run-entry-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      line-height: 1.3;
    }

    .run-entry-meta {
      display: flex;
      gap: 6px;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.3;
    }

    .run-entry-meta span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .context-viz {
      display: grid;
      gap: 7px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-sideBar-background);
    }

    .context-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    .context-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .context-total {
      flex: 0 1 auto;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }

    .context-body {
      display: grid;
      gap: 7px;
    }

    .context-token-bar {
      display: flex;
      width: 100%;
      height: 10px;
      overflow: hidden;
      background: var(--vscode-editorWidget-border);
    }

    .context-token-segment {
      min-width: 2px;
    }

    .context-token-segment.stable-prefix {
      background: var(--vscode-charts-blue, #3794ff);
    }

    .context-token-segment.dynamic-prelude {
      background: var(--vscode-charts-green, #89d185);
    }

    .context-token-segment.turn-suffix {
      background: var(--vscode-charts-yellow, #cca700);
    }

    .context-segments,
    .context-metrics,
    .context-sources,
    .context-manifest {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .context-row,
    .context-source-row,
    .context-metric-row,
    .context-manifest-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: baseline;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
    }

    .context-row strong,
    .context-source-row strong,
    .context-metric-row strong,
    .context-manifest-row strong {
      min-width: 0;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }

    .context-value {
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .context-source-reason {
      grid-column: 1 / -1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .context-source-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
    }

    .context-tab {
      height: 24px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 1px solid transparent;
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    .context-tab.active {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .context-tab:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .events {
      display: grid;
      gap: 8px;
      flex: 1;
      align-content: start;
      min-height: 0;
      padding: 10px;
      overflow: auto;
    }

    .empty {
      padding: 20px 12px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }

    .item {
      display: grid;
      gap: 6px;
      padding: 8px;
      border: 1px solid var(--vscode-editorWidget-border);
      border-left-width: 3px;
      background: var(--vscode-editorWidget-background);
    }

    .item.user,
    .item.assistant {
      border-radius: 6px;
    }

    .item.user {
      margin-left: 24px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border-color: transparent;
    }

    .item.assistant {
      background: var(--vscode-input-background);
    }

    .item.user .meta,
    .item.assistant .meta {
      display: none;
    }

    .item.user .title,
    .item.assistant .title {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .item.work-log {
      background: transparent;
      border-style: dashed;
      opacity: 0.9;
    }

    details.item > summary {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 6px;
      cursor: pointer;
      list-style-position: inside;
    }

    details.item > summary .meta,
    details.item > summary .title {
      min-width: 0;
    }

    details.item > summary .meta {
      grid-column: 1 / -1;
    }

    details.item > summary .title {
      grid-column: 1 / -1;
    }

    .item.running {
      border-left-color: var(--vscode-progressBar-background);
    }

    .item.success {
      border-left-color: var(--vscode-testing-iconPassed);
    }

    .item.warning {
      border-left-color: var(--vscode-editorWarning-foreground);
    }

    .item.danger {
      border-left-color: var(--vscode-editorError-foreground);
    }

    .meta {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      min-width: 0;
    }

    .seq {
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
    }

    .type {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .title {
      font-weight: 600;
      line-height: 1.35;
    }

    .body {
      white-space: pre-wrap;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }

    details.item:not([open]) > .body {
      display: none;
    }

    .work-log-body {
      display: grid;
      gap: 0;
    }

    .work-log-row {
      display: grid;
      gap: 3px;
      padding: 6px 0;
      border-top: 1px solid var(--vscode-editorWidget-border);
    }

    .work-log-row:first-child {
      border-top: 0;
      padding-top: 0;
    }

    .work-log-row-meta {
      display: flex;
      gap: 6px;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .work-log-row-title {
      min-width: 0;
      overflow-wrap: anywhere;
      font-weight: 600;
    }

    .work-log-row-body {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.35;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .approval-host {
      display: none;
      padding: 8px 10px 0;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-sideBar-background);
    }

    .approval-host.active {
      display: grid;
    }

    .approval-card {
      display: grid;
      gap: 8px;
      padding: 8px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-left: 3px solid var(--vscode-editorWarning-foreground);
    }

    .approval-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .approval-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .approval-risk {
      flex: 0 0 auto;
      color: var(--vscode-editorWarning-foreground);
      font-size: 11px;
    }

    .approval-detail,
    .approval-meta,
    .approval-output {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .approval-hunks {
      display: grid;
      gap: 4px;
      max-height: 150px;
      overflow: auto;
    }

    .approval-hunk {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: start;
      gap: 6px;
      color: var(--vscode-foreground);
      font-size: 12px;
      line-height: 1.35;
    }

    .approval-hunk span {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .approval-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
    }

    .approval-action {
      min-width: 64px;
      height: 26px;
      border: 1px solid transparent;
      border-radius: 3px;
      cursor: pointer;
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    .approval-action.approve {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .approval-action.reject {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    .approval-action:hover:enabled {
      filter: brightness(1.08);
    }

    .approval-action:disabled {
      opacity: 0.55;
      cursor: default;
    }

    .composer {
      display: grid;
      gap: 8px;
      padding: 10px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-sideBar-background);
    }

    .prompt {
      box-sizing: border-box;
      width: 100%;
      min-height: 72px;
      max-height: 180px;
      resize: vertical;
      padding: 7px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      font: var(--vscode-font-size) var(--vscode-font-family);
      line-height: 1.4;
    }

    .prompt:focus,
    .mode:focus,
    .send:focus,
    .cancel:focus,
    .provider-action:focus,
    .conversation-back:focus,
    .refresh-runs:focus,
    .run-entry:focus,
    .run-delete:focus,
    .run-delete-confirm button:focus,
    .approval-action:focus,
    .approval-hunk input:focus,
    .context-tab:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .composer-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
    }

    .mode {
      min-width: 92px;
      height: 28px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border, transparent);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    .send,
    .cancel {
      flex: 0 0 auto;
      min-width: 64px;
      height: 28px;
      padding: 0 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      font: var(--vscode-font-size) var(--vscode-font-family);
      font-weight: 600;
    }

    .send:hover:enabled {
      background: var(--vscode-button-hoverBackground);
    }

    .cancel {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font-weight: 500;
    }

    .provider-action {
      flex: 0 0 auto;
      min-width: 58px;
      height: 28px;
      padding: 0 8px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 0;
      font: var(--vscode-font-size) var(--vscode-font-family);
      font-weight: 500;
    }

    .cancel:hover:enabled {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .provider-action:hover:enabled {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .send:disabled,
    .cancel:disabled,
    .prompt:disabled,
    .mode:disabled {
      opacity: 0.65;
    }

    .submission {
      min-width: 0;
      flex: 1 1 100%;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      overflow: hidden;
      white-space: nowrap;
    }

    .submission-message {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .submission-action {
      flex: 0 0 auto;
      border: 0;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      line-height: 18px;
      padding: 0 8px;
    }

    .submission-action:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .submission.failed {
      color: var(--vscode-editorError-foreground);
    }

    .submission.canceled {
      color: var(--vscode-editorWarning-foreground);
    }

    .submission.completed {
      color: var(--vscode-testing-iconPassed);
    }
  </style>
</head>
<body>
  <main class="shell">
    <section id="conversation-bar" class="conversation-bar" aria-label="Conversation">
      <button id="show-runs" class="conversation-back" type="button" title="Back to runs" tabindex="-1">&lt;</button>
      <div id="conversation-title" class="conversation-title">Conversation</div>
    </section>
    <section class="status" aria-live="polite">
      <div id="status-title" class="status-title">ProleCoder</div>
      <div id="status-subtitle" class="status-subtitle">No run events yet.</div>
    </section>
    <section id="runs-section" class="runs" aria-label="Runs">
      <div class="runs-header">
        <div class="runs-title">Runs</div>
        <button id="refresh-runs" class="refresh-runs" type="button">Refresh</button>
      </div>
      <div id="run-message" class="run-message" aria-live="polite"></div>
      <div id="run-list" class="run-list"></div>
    </section>
    <section class="context-viz" aria-label="Context Capsule">
      <div class="context-header">
        <div class="context-title">Context Capsule</div>
        <div id="context-total" class="context-total">No context yet.</div>
      </div>
      <div id="context-body" class="context-body"></div>
    </section>
    <section id="events" class="events" aria-label="Run events"></section>
    <section id="approval" class="approval-host" aria-live="polite"></section>
    <form id="composer" class="composer">
      <textarea id="prompt" class="prompt" rows="3" placeholder="Ask ProleCoder" aria-label="Chat message"></textarea>
      <div class="composer-row">
        <select id="mode" class="mode" aria-label="Run mode"></select>
        <button id="api-key" class="provider-action" type="button" title="Configure DeepSeek API key">API Key</button>
        <button id="model" class="provider-action" type="button" title="Select DeepSeek model">Model</button>
        <button id="settings" class="provider-action" type="button" title="Open ProleCoder settings">Settings</button>
        <button id="send" class="send" type="submit">Send</button>
        <button id="cancel" class="cancel" type="button">Cancel</button>
        <div id="submission" class="submission" aria-live="polite"></div>
      </div>
    </form>
  </main>
  <script nonce="${nonce}">
    const initialSnapshot = ${initialSnapshot};
    const initialSubmission = ${initialSubmission};
    const initialRuns = ${initialRuns};
    const initialContext = ${initialContext};
    const initialApproval = ${initialApproval};
    const runModes = ${safeScriptJson(CHAT_RUN_MODES)};
    const defaultMode = ${safeScriptJson(DEFAULT_CHAT_MODE)};
    const testProbeEnabled = ${safeScriptJson(process.env["PROLE_CODER_VSCODE_TEST"] === "1")};
    const WORK_LOG_RENDER_LIMIT = 80;
    const WORK_LOG_STATUS_IGNORED_TYPES = new Set(["run.completed"]);
    const vscodeApi = acquireVsCodeApi();
    const shellRoot = document.querySelector(".shell");
    const showRunsButton = document.getElementById("show-runs");
    const conversationTitleRoot = document.getElementById("conversation-title");
    const eventsRoot = document.getElementById("events");
    const runListRoot = document.getElementById("run-list");
    const runMessageRoot = document.getElementById("run-message");
    const refreshRunsButton = document.getElementById("refresh-runs");
    const contextTotalRoot = document.getElementById("context-total");
    const contextBodyRoot = document.getElementById("context-body");
    const statusTitle = document.getElementById("status-title");
    const statusSubtitle = document.getElementById("status-subtitle");
    const composer = document.getElementById("composer");
    const promptInput = document.getElementById("prompt");
    const modeInput = document.getElementById("mode");
    const apiKeyButton = document.getElementById("api-key");
    const modelButton = document.getElementById("model");
    const settingsButton = document.getElementById("settings");
    const sendButton = document.getElementById("send");
    const cancelButton = document.getElementById("cancel");
    const submissionRoot = document.getElementById("submission");
    const approvalRoot = document.getElementById("approval");
    let currentSnapshot = initialSnapshot;
    let currentSubmission = initialSubmission;
    let currentRuns = initialRuns;
    let currentContext = initialContext;
    let currentApproval = initialApproval;
    let pendingRunDeleteId = "";
    const resolvedApprovalIds = new Set();
    let contextSourceTab = "included";

    for (const mode of runModes) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = mode[0].toUpperCase() + mode.slice(1);
      modeInput.append(option);
    }
    modeInput.value = defaultMode;

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "testProbe") {
        handleTestProbe(message);
        return;
      }
      if (message && message.type === "snapshot") {
        render(message.snapshot);
      }
      if (message && message.type === "submission") {
        renderSubmission(message.submission);
      }
      if (message && message.type === "runs") {
        renderRuns(message.runs);
      }
      if (message && message.type === "context") {
        renderContext(message.context);
      }
      if (message && message.type === "approval") {
        renderApproval(message.approval);
      }
    });

    showRunsButton.addEventListener("click", () => {
      vscodeApi.postMessage({ type: "showRuns" });
    });

    refreshRunsButton.addEventListener("click", () => {
      vscodeApi.postMessage({ type: "refreshRuns" });
    });

    apiKeyButton.addEventListener("click", () => {
      vscodeApi.postMessage({ type: "configureDeepSeekApiKey" });
    });

    modelButton.addEventListener("click", () => {
      vscodeApi.postMessage({ type: "selectDeepSeekModel" });
    });

    settingsButton.addEventListener("click", () => {
      vscodeApi.postMessage({ type: "openSettings" });
    });

    cancelButton.addEventListener("click", () => {
      const runId = cancelButton.dataset.runId;
      if (typeof runId === "string" && runId.length > 0) {
        vscodeApi.postMessage({ type: "cancelTurn", runId });
      }
    });

    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      const message = promptInput.value.trim();
      if (!message) {
        renderSubmission({
          busy: false,
          status: "failed",
          message: "Enter a message before sending.",
        });
        promptInput.focus();
        return;
      }

      setComposerBusy(true, false);
      submissionRoot.className = "submission sending";
      submissionRoot.textContent = "Sending turn...";
      currentSubmission = {
        busy: true,
        status: "sending",
        message: "Sending turn...",
      };
      syncConversationChrome();
      vscodeApi.postMessage({
        type: "submitTurn",
        message,
        mode: modeInput.value,
      });
    });

    promptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.shiftKey !== true && event.isComposing !== true) {
        event.preventDefault();
        composer.requestSubmit();
      }
    });

    render(initialSnapshot);
    renderSubmission(initialSubmission);
    renderRuns(initialRuns);
    renderContext(initialContext);
    renderApproval(initialApproval);

    function render(snapshot) {
      currentSnapshot = snapshot && typeof snapshot === "object" ? snapshot : initialSnapshot;
      const items = Array.isArray(currentSnapshot.items) ? currentSnapshot.items : [];
      const visibleItems = timelineVisibleItems(currentSnapshot, items);
      const workItems = timelineWorkItems(currentSnapshot, items);
      statusTitle.textContent = currentSnapshot.latestStatus || "ProleCoder";
      statusSubtitle.textContent = currentSnapshot.latestRunId
        ? currentSnapshot.latestRunId + " - " + currentSnapshot.eventCount + " events"
        : "No run events yet.";
      eventsRoot.replaceChildren();
      syncConversationChrome();

      if (visibleItems.length === 0 && workItems.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No run events yet.";
        eventsRoot.append(empty);
        return;
      }

      for (const item of visibleItems) {
        eventsRoot.append(renderItem(item));
      }
      if (workItems.length > 0) {
        eventsRoot.append(renderWorkLog(workItems));
      }
    }

    function renderRuns(snapshot) {
      const state = snapshot && typeof snapshot === "object" ? snapshot : initialRuns;
      currentRuns = state;
      const runs = Array.isArray(state.runs) ? state.runs : [];
      const status = typeof state.status === "string" ? state.status : "idle";
      const loading = status === "loading";
      refreshRunsButton.disabled = loading;
      runMessageRoot.className = "run-message " + status;
      const runMessage = typeof state.message === "string" ? state.message : "";
      runMessageRoot.textContent = runMessage;
      runMessageRoot.title = runMessage;
      runListRoot.replaceChildren();
      if (pendingRunDeleteId.length > 0 && !runs.some((run) => run.runId === pendingRunDeleteId)) {
        pendingRunDeleteId = "";
      }
      syncConversationChrome();

      if (runs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = loading ? "Loading runs..." : "No runs.";
        runListRoot.append(empty);
        return;
      }

      for (const run of runs) {
        runListRoot.append(renderRunEntry(run, state.selectedRunId, loading));
      }
    }

    function renderRunEntry(run, selectedRunId, disabled) {
      const row = document.createElement("div");
      row.className = "run-entry-row";
      const button = document.createElement("button");
      const status = typeof run.status === "string" ? run.status : "running";
      const runId = typeof run.runId === "string" ? run.runId : "";
      const confirmingDelete = runId.length > 0 && pendingRunDeleteId === runId;
      button.type = "button";
      button.className = "run-entry " + status + (run.runId === selectedRunId ? " selected" : "");
      button.disabled = disabled || confirmingDelete;
      button.title = runId;
      row.dataset.runId = runId;
      button.addEventListener("click", () => {
        if (runId.length > 0) {
          vscodeApi.postMessage({ type: "resumeRun", runId });
        }
      });

      const title = document.createElement("div");
      title.className = "run-entry-title";
      title.textContent = runTitle(run);

      const meta = document.createElement("div");
      meta.className = "run-entry-meta";
      for (const part of runMeta(run)) {
        const item = document.createElement("span");
        item.textContent = part;
        meta.append(item);
      }

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "run-delete";
      deleteButton.disabled = disabled;
      deleteButton.title = "Delete run";
      deleteButton.setAttribute("aria-label", "Delete run");
      deleteButton.dataset.runId = runId;
      deleteButton.textContent = confirmingDelete ? "-" : "x";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (runId.length === 0) {
          return;
        }
        pendingRunDeleteId = confirmingDelete ? "" : runId;
        renderRuns(currentRuns);
      });

      button.append(title, meta);
      row.append(button, deleteButton);
      if (confirmingDelete) {
        row.append(renderRunDeleteConfirm(runId));
      }
      return row;
    }

    function renderRunDeleteConfirm(runId) {
      const confirmRoot = document.createElement("div");
      confirmRoot.className = "run-delete-confirm";
      const label = document.createElement("span");
      label.textContent = "Delete this run?";

      const confirmButton = document.createElement("button");
      confirmButton.type = "button";
      confirmButton.className = "confirm-delete";
      confirmButton.textContent = "Delete";
      confirmButton.addEventListener("click", () => {
        pendingRunDeleteId = "";
        optimisticallyDeleteRun(runId);
        vscodeApi.postMessage({ type: "deleteRun", runId });
      });

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "confirm-cancel";
      cancelButton.textContent = "Cancel";
      cancelButton.addEventListener("click", () => {
        pendingRunDeleteId = "";
        renderRuns(currentRuns);
      });

      confirmRoot.append(label, confirmButton, cancelButton);
      return confirmRoot;
    }

    function optimisticallyDeleteRun(runId) {
      const runs = Array.isArray(currentRuns.runs)
        ? currentRuns.runs.filter((run) => run.runId !== runId)
        : [];
      const selectedRunId =
        currentRuns && typeof currentRuns.selectedRunId === "string" && currentRuns.selectedRunId !== runId
          ? currentRuns.selectedRunId
          : undefined;
      renderRuns({
        status: "loading",
        runs,
        ...(selectedRunId === undefined ? {} : { selectedRunId }),
        message: "Deleting run...",
      });
    }

    function runTitle(run) {
      if (typeof run.title === "string" && run.title.length > 0) {
        return run.title;
      }
      return typeof run.runId === "string" && run.runId.length > 0 ? run.runId : "Untitled run";
    }

    function runMeta(run) {
      const parts = [];
      if (typeof run.status === "string") {
        parts.push(run.status);
      }
      if (typeof run.mode === "string") {
        parts.push(run.mode);
      }
      if (typeof run.eventCount === "number") {
        parts.push(run.eventCount + " events");
      }
      const updated = formatRunTime(run.updatedAt);
      if (updated) {
        parts.push(updated);
      }
      return parts;
    }

    function formatRunTime(value) {
      if (typeof value !== "string" || value.length === 0) {
        return "";
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value;
      }
      return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    function renderContext(snapshot) {
      const state = snapshot && typeof snapshot === "object" ? snapshot : initialContext;
      currentContext = state;
      contextBodyRoot.replaceChildren();

      if (state.status !== "ready") {
        contextTotalRoot.textContent = "No context yet.";
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No context yet.";
        contextBodyRoot.append(empty);
        return;
      }

      contextTotalRoot.textContent = formatTokens(state.inputTokens) + " / " + formatTokens(state.maxInputTokens);
      contextBodyRoot.append(renderContextTokenBar(state));
      contextBodyRoot.append(renderContextSegments(state));
      contextBodyRoot.append(renderContextMetrics(state));
      contextBodyRoot.append(renderContextSources(state));
      if (state.manifest) {
        contextBodyRoot.append(renderContextManifest(state.manifest));
      }
    }

    function renderContextTokenBar(state) {
      const bar = document.createElement("div");
      bar.className = "context-token-bar";
      const segments = Array.isArray(state.segments) ? state.segments : [];
      for (const segment of segments) {
        if (typeof segment.tokens !== "number" || segment.tokens <= 0) {
          continue;
        }
        const entry = document.createElement("div");
        entry.className = "context-token-segment " + placementClass(segment.placement);
        entry.style.flexGrow = String(segment.tokens);
        entry.title = segment.label + ": " + formatTokens(segment.tokens) + " (" + formatPercent(segment.percent) + ")";
        bar.append(entry);
      }
      return bar;
    }

    function renderContextSegments(state) {
      const root = document.createElement("div");
      root.className = "context-segments";
      for (const segment of Array.isArray(state.segments) ? state.segments : []) {
        root.append(
          contextRow(
            segment.label,
            formatTokens(segment.tokens) + " - " + formatPercent(segment.percent),
            segment.itemCount + " items",
          ),
        );
      }
      return root;
    }

    function renderContextMetrics(state) {
      const root = document.createElement("div");
      root.className = "context-metrics";
      root.append(contextMetric("Input budget", formatPercent(state.inputPercent)));
      root.append(contextMetric("Stable budget", formatPercent(state.stablePrefixBudgetPercent)));
      root.append(contextMetric("Stable target", formatPercent(state.stablePrefixBudgetRatioPercent)));
      if (typeof state.cacheHitTokens === "number" || typeof state.cacheMissTokens === "number") {
        root.append(
          contextMetric(
            "Cache",
            formatTokens(state.cacheHitTokens || 0) + " hit / " + formatTokens(state.cacheMissTokens || 0) + " miss",
          ),
        );
      }
      if (state.estimator) {
        root.append(
          contextMetric(
            "Estimator",
            state.estimator.name + (state.estimator.exact === true ? " exact" : " estimated"),
          ),
        );
      }
      if (typeof state.stablePrefixHash === "string") {
        root.append(contextMetric("Stable hash", shortHash(state.stablePrefixHash)));
      }
      return root;
    }

    function renderContextSources(state) {
      const root = document.createElement("div");
      root.className = "context-sources";

      const tabs = document.createElement("div");
      tabs.className = "context-source-tabs";
      tabs.append(contextTabButton("included", "Included", state.includedSourceCount));
      tabs.append(contextTabButton("omitted", "Omitted", state.omittedSourceCount));
      root.append(tabs);

      const list = document.createElement("div");
      list.className = "context-sources";
      const sources = contextSourceTab === "omitted" ? state.omittedSources : state.includedSources;
      if (!Array.isArray(sources) || sources.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = contextSourceTab === "omitted" ? "No omitted sources." : "No included sources.";
        list.append(empty);
      } else {
        for (const source of sources) {
          list.append(renderContextSource(source));
        }
      }
      root.append(list);
      return root;
    }

    function contextTabButton(tab, label, count) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "context-tab" + (contextSourceTab === tab ? " active" : "");
      button.textContent = label + " " + count;
      button.addEventListener("click", () => {
        contextSourceTab = tab;
        renderContext(currentContext);
      });
      return button;
    }

    function renderContextSource(source) {
      const row = document.createElement("div");
      row.className = "context-source-row";
      const title = document.createElement("strong");
      title.textContent = source.label;
      const value = document.createElement("span");
      value.className = "context-value";
      value.textContent = formatTokens(source.tokens) + (source.required === true ? " required" : " optional");
      row.append(title, value);

      const reason = document.createElement("div");
      reason.className = "context-source-reason";
      reason.textContent = source.omissionReason
        ? source.kind + " - " + source.omissionReason + " - " + source.reason
        : source.kind + " - " + source.reason;
      row.append(reason);
      return row;
    }

    function renderContextManifest(manifest) {
      const root = document.createElement("div");
      root.className = "context-manifest";
      root.append(contextMetric("Manifest", shortHash(manifest.manifestHash)));
      root.append(contextMetric("Files", manifest.includedFiles + " / " + manifest.totalDiscoveredFiles));
      root.append(contextMetric("Max entries", String(manifest.maxEntries)));
      if (Array.isArray(manifest.omitted) && manifest.omitted.length > 0) {
        const omitted = manifest.omitted.map((entry) => entry.reason + ": " + entry.count).join(", ");
        root.append(contextMetric("Manifest omitted", omitted));
      }
      return root;
    }

    function contextMetric(label, value) {
      return contextRow(label, value);
    }

    function contextRow(label, value, detail) {
      const row = document.createElement("div");
      row.className = detail ? "context-row" : "context-metric-row";
      const title = document.createElement("strong");
      title.textContent = label;
      const amount = document.createElement("span");
      amount.className = "context-value";
      amount.textContent = value;
      row.append(title, amount);
      if (detail) {
        const detailRoot = document.createElement("div");
        detailRoot.className = "context-source-reason";
        detailRoot.textContent = detail;
        row.append(detailRoot);
      }
      return row;
    }

    function placementClass(placement) {
      if (placement === "stable_prefix") {
        return "stable-prefix";
      }
      if (placement === "dynamic_prelude") {
        return "dynamic-prelude";
      }
      return "turn-suffix";
    }

    function formatTokens(value) {
      return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString() : "0";
    }

    function formatPercent(value) {
      return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1).replace(".0", "") + "%" : "0%";
    }

    function shortHash(value) {
      if (typeof value !== "string") {
        return "";
      }
      return value.length > 18 ? value.slice(0, 18) + "..." : value;
    }

    function renderApproval(approval) {
      const nextApproval = approval && typeof approval === "object" ? approval : undefined;
      currentApproval =
        nextApproval !== undefined && resolvedApprovalIds.has(nextApproval.approvalId)
          ? undefined
          : nextApproval;
      approvalRoot.replaceChildren();
      if (currentApproval === undefined) {
        approvalRoot.className = "approval-host";
        return;
      }

      approvalRoot.className = "approval-host active";
      approvalRoot.append(renderApprovalCard(currentApproval));
    }

    function renderApprovalCard(approval) {
      const card = document.createElement("div");
      card.className = "approval-card";

      const heading = document.createElement("div");
      heading.className = "approval-heading";
      const title = document.createElement("div");
      title.className = "approval-title";
      title.textContent = typeof approval.title === "string" ? approval.title : "Approval required";
      const risk = document.createElement("div");
      risk.className = "approval-risk";
      risk.textContent = typeof approval.risk === "string" ? approval.risk : "risk";
      heading.append(title, risk);
      card.append(heading);

      const detail = document.createElement("div");
      detail.className = "approval-detail";
      detail.textContent = approvalDetailText(approval);
      card.append(detail);

      const meta = approvalMetaText(approval);
      if (meta.length > 0) {
        const metaRoot = document.createElement("div");
        metaRoot.className = "approval-meta";
        metaRoot.textContent = meta;
        card.append(metaRoot);
      }

      if (typeof approval.outputSummary === "string" && approval.outputSummary.length > 0) {
        const output = document.createElement("div");
        output.className = "approval-output";
        output.textContent = "Output: " + approval.outputSummary;
        card.append(output);
      }

      const hunkInputs = [];
      const hunks = Array.isArray(approval.hunks) ? approval.hunks : [];
      if (hunks.length > 0) {
        const hunkRoot = document.createElement("div");
        hunkRoot.className = "approval-hunks";
        for (const hunk of hunks) {
          const label = document.createElement("label");
          label.className = "approval-hunk";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = true;
          input.dataset.hunkId = hunk.id;
          const text = document.createElement("span");
          text.textContent = hunkLabel(hunk);
          label.append(input, text);
          hunkRoot.append(label);
          hunkInputs.push(input);
        }
        card.append(hunkRoot);
      }

      const actions = document.createElement("div");
      actions.className = "approval-actions";
      const rejectButton = document.createElement("button");
      rejectButton.type = "button";
      rejectButton.className = "approval-action reject";
      rejectButton.textContent = "Reject";
      rejectButton.addEventListener("click", () => {
        markApprovalResolved(approval.approvalId);
        vscodeApi.postMessage({
          type: "approvalDecision",
          approvalId: approval.approvalId,
          decision: "reject",
        });
        renderApproval(undefined);
      });

      const approveButton = document.createElement("button");
      approveButton.type = "button";
      approveButton.className = "approval-action approve";
      approveButton.textContent = "Approve";
      approveButton.addEventListener("click", () => {
        markApprovalResolved(approval.approvalId);
        const message = {
          type: "approvalDecision",
          approvalId: approval.approvalId,
          decision: "approve",
        };
        if (hunkInputs.length > 0) {
          message.approvedHunks = selectedHunkIds(hunkInputs);
        }
        vscodeApi.postMessage(message);
        renderApproval(undefined);
      });

      const updateApproveState = () => {
        approveButton.disabled = hunkInputs.length > 0 && selectedHunkIds(hunkInputs).length === 0;
      };
      for (const input of hunkInputs) {
        input.addEventListener("change", updateApproveState);
      }
      updateApproveState();

      actions.append(rejectButton, approveButton);
      card.append(actions);
      return card;
    }

    function markApprovalResolved(approvalId) {
      if (typeof approvalId === "string" && approvalId.length > 0) {
        resolvedApprovalIds.add(approvalId);
      }
    }

    function approvalDetailText(approval) {
      const lines = [];
      if (typeof approval.detail === "string" && approval.detail.length > 0) {
        lines.push(approval.detail);
      }
      if (typeof approval.toolName === "string" && approval.toolName.length > 0) {
        lines.push("Tool: " + approval.toolName);
      }
      return lines.join("\\n");
    }

    function approvalMetaText(approval) {
      const lines = [];
      if (typeof approval.command === "string" && approval.command.length > 0) {
        lines.push("Command: " + approval.command);
      }
      if (typeof approval.cwd === "string" && approval.cwd.length > 0) {
        lines.push("Cwd: " + approval.cwd);
      }
      if (Array.isArray(approval.paths) && approval.paths.length > 0) {
        lines.push("Paths: " + approval.paths.join(", "));
      }
      if (Array.isArray(approval.riskReasons) && approval.riskReasons.length > 0) {
        lines.push("Reasons: " + approval.riskReasons.join(", "));
      }
      return lines.join("\\n");
    }

    function selectedHunkIds(inputs) {
      return inputs
        .filter((input) => input.checked && typeof input.dataset.hunkId === "string")
        .map((input) => input.dataset.hunkId);
    }

    function hunkLabel(hunk) {
      const index = typeof hunk.hunkIndex === "number" ? hunk.hunkIndex + 1 : 1;
      const oldStart = typeof hunk.oldStart === "number" ? hunk.oldStart : 0;
      const oldCount = typeof hunk.oldCount === "number" ? hunk.oldCount : 0;
      const newStart = typeof hunk.newStart === "number" ? hunk.newStart : 0;
      const newCount = typeof hunk.newCount === "number" ? hunk.newCount : 0;
      const section = typeof hunk.section === "string" && hunk.section.length > 0
        ? " - " + hunk.section
        : "";
      return hunk.filePath + " hunk " + index + " (-" + oldStart + "," + oldCount + " +" + newStart + "," + newCount + ")" + section;
    }

    function renderSubmission(submission) {
      const state = submission && typeof submission === "object" ? submission : initialSubmission;
      currentSubmission = state;
      const status = typeof state.status === "string" ? state.status : "idle";
      const busy = state.busy === true;
      const runId = typeof state.runId === "string" ? state.runId : "";
      const cancelable = busy && runId.length > 0 && state.canceling !== true;
      setComposerBusy(busy, cancelable);
      cancelButton.dataset.runId = runId;
      submissionRoot.className = "submission " + status;
      const submissionMessage = typeof state.message === "string" ? state.message : "";
      submissionRoot.title = typeof state.error === "string" ? state.error : submissionMessage;
      submissionRoot.replaceChildren();
      const message = document.createElement("span");
      message.className = "submission-message";
      message.textContent = submissionMessage;
      submissionRoot.append(message);
      const actionButton = renderSubmissionAction(state.action);
      if (actionButton) {
        submissionRoot.append(actionButton);
      }
      if (status === "running") {
        promptInput.value = "";
      }
      syncConversationChrome();
      syncWorkLogSummary();
    }

    function renderSubmissionAction(action) {
      const definition = submissionActionDefinition(action);
      if (definition === undefined) {
        return undefined;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "submission-action";
      button.textContent = typeof action.label === "string" ? action.label : definition.fallbackLabel;
      button.addEventListener("click", () => {
        vscodeApi.postMessage({ type: definition.messageType });
      });
      return button;
    }

    function submissionActionDefinition(action) {
      if (!action || typeof action !== "object") {
        return undefined;
      }

      if (action.type === "configureDeepSeekApiKey") {
        return {
          fallbackLabel: "Configure API Key",
          messageType: "configureDeepSeekApiKey",
        };
      }

      return undefined;
    }

    function setComposerBusy(busy, cancelable) {
      promptInput.disabled = busy;
      modeInput.disabled = busy;
      sendButton.disabled = busy;
      cancelButton.disabled = cancelable !== true;
    }

    function syncConversationChrome() {
      const runId = activeConversationRunId();
      const active = runId.length > 0;
      shellRoot.classList.toggle("conversation-active", active);
      conversationTitleRoot.textContent = "Conversation";
      showRunsButton.disabled = currentSubmission && currentSubmission.busy === true;
    }

    function activeConversationRunId() {
      const submissionRunId =
        currentSubmission && typeof currentSubmission.runId === "string" ? currentSubmission.runId : "";
      const latestRunId =
        currentSnapshot && typeof currentSnapshot.latestRunId === "string" ? currentSnapshot.latestRunId : "";
      const selectedRunId =
        currentRuns && typeof currentRuns.selectedRunId === "string" ? currentRuns.selectedRunId : "";
      if (submissionRunId || latestRunId || selectedRunId) {
        return submissionRunId || latestRunId || selectedRunId;
      }
      return currentSubmission && currentSubmission.busy === true ? "pending" : "";
    }

    function timelineVisibleItems(snapshot, items) {
      if (snapshot && Array.isArray(snapshot.visibleItems)) {
        return snapshot.visibleItems;
      }

      // Fallback only; chatEvents.presentTimelineItems is the authoritative grouping source.
      const hasAssistant = items.some((item) => item && item.kind === "assistant");
      return items.filter((item) => !isWorkLogItem(item, hasAssistant));
    }

    function timelineWorkItems(snapshot, items) {
      if (snapshot && Array.isArray(snapshot.workItems)) {
        return snapshot.workItems;
      }

      // Fallback only; chatEvents.presentTimelineItems is the authoritative grouping source.
      const hasAssistant = items.some((item) => item && item.kind === "assistant");
      return items.filter((item) => isWorkLogItem(item, hasAssistant));
    }

    function isWorkLogItem(item, hasAssistant) {
      if (!item || typeof item !== "object") {
        return true;
      }
      if (item.kind === "user" || item.kind === "assistant") {
        return false;
      }
      if (item.type === "run.failed" || item.type === "run.canceled") {
        return false;
      }
      if (item.type === "run.completed" && hasAssistant !== true) {
        return false;
      }
      return true;
    }

    function renderWorkLog(items) {
      const details = document.createElement("details");
      details.className = "item work-log neutral";
      details.open = false;

      const summary = document.createElement("summary");
      const meta = document.createElement("div");
      meta.className = "meta";
      const count = document.createElement("span");
      count.className = "seq";
      count.textContent = items.length + " events";
      const latest = latestWorkItem(items);
      const latestType = document.createElement("span");
      latestType.className = "type";
      latestType.textContent = latest && typeof latest.type === "string" ? latest.type : "work";
      meta.append(count, latestType);

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = workLogTitle(items);
      summary.append(meta, title);
      details.append(summary);

      const body = document.createElement("div");
      body.className = "body work-log-body";
      const displayedItems = workLogDisplayItems(items);
      const hiddenCount = items.length - displayedItems.length;
      if (hiddenCount > 0) {
        body.append(renderWorkLogNotice(hiddenCount));
      }
      for (const item of displayedItems) {
        body.append(renderWorkLogRow(item));
      }
      details.append(body);
      return details;
    }

    function workLogDisplayItems(items) {
      return items.length <= WORK_LOG_RENDER_LIMIT ? items : items.slice(items.length - WORK_LOG_RENDER_LIMIT);
    }

    function renderWorkLogNotice(hiddenCount) {
      const row = document.createElement("div");
      row.className = "work-log-row neutral";
      const meta = document.createElement("div");
      meta.className = "work-log-row-meta";
      meta.textContent = "work log";
      const title = document.createElement("div");
      title.className = "work-log-row-title";
      title.textContent = hiddenCount + " earlier events hidden";
      row.append(meta, title);
      return row;
    }

    function renderWorkLogRow(item) {
      const row = document.createElement("div");
      row.className = "work-log-row " + (typeof item.tone === "string" ? item.tone : "neutral");

      const meta = document.createElement("div");
      meta.className = "work-log-row-meta";
      const seq = document.createElement("span");
      seq.textContent = item.seq === item.lastSeq ? "#" + item.seq : "#" + item.seq + "-" + item.lastSeq;
      const type = document.createElement("span");
      type.textContent = typeof item.type === "string" ? item.type : "event";
      meta.append(seq, type);

      const title = document.createElement("div");
      title.className = "work-log-row-title";
      title.textContent = typeof item.title === "string" ? item.title : "Work event";
      row.append(meta, title);

      if (typeof item.body === "string" && item.body.length > 0) {
        const body = document.createElement("div");
        body.className = "work-log-row-body";
        body.textContent = item.body;
        row.append(body);
      }

      return row;
    }

    function workLogTitle(items) {
      const latest = latestWorkItem(items);
      const busy = currentSubmission && currentSubmission.busy === true;
      if (busy && latest && typeof latest.title === "string" && latest.title.length > 0) {
        return "Working: " + latest.title;
      }
      return "Work log";
    }

    function latestWorkItem(items) {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (shouldUseWorkItemForStatus(item)) {
          return item;
        }
      }
      return items.length > 0 ? items[items.length - 1] : undefined;
    }

    function shouldUseWorkItemForStatus(item) {
      return item && WORK_LOG_STATUS_IGNORED_TYPES.has(item.type) !== true;
    }

    function syncWorkLogSummary() {
      const title = document.querySelector(".item.work-log > summary .title");
      if (!title) {
        return;
      }

      const snapshot = currentSnapshot && typeof currentSnapshot === "object" ? currentSnapshot : initialSnapshot;
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      title.textContent = workLogTitle(timelineWorkItems(snapshot, items));
    }

    function renderItem(item) {
      const collapsed = item.defaultCollapsed === true;
      const article = document.createElement(collapsed ? "details" : "article");
      article.className = "item " + item.kind + " " + item.tone;
      if (collapsed) {
        article.open = false;
      }

      const meta = document.createElement("div");
      meta.className = "meta";
      const seq = document.createElement("span");
      seq.className = "seq";
      seq.textContent = item.seq === item.lastSeq ? "#" + item.seq : "#" + item.seq + "-" + item.lastSeq;
      const type = document.createElement("span");
      type.className = "type";
      type.textContent = item.type;
      meta.append(seq, type);

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = item.title;

      if (collapsed) {
        const summary = document.createElement("summary");
        summary.append(meta, title);
        article.append(summary);
      } else {
        article.append(meta, title);
      }
      if (item.body) {
        const body = document.createElement("div");
        body.className = "body";
        body.textContent = item.body;
        article.append(body);
      }

      return article;
    }

    function handleTestProbe(message) {
      if (testProbeEnabled !== true) {
        return;
      }

      const id = typeof message.id === "string" ? message.id : "";
      if (!id) {
        return;
      }

      try {
        vscodeApi.postMessage({
          type: "testProbeResult",
          id,
          ok: true,
          result: runTestProbe(message.action),
        });
      } catch (error) {
        vscodeApi.postMessage({
          type: "testProbeResult",
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    function runTestProbe(action) {
      const type = action && typeof action === "object" && typeof action.type === "string" ? action.type : "snapshot";
      if (type === "click") {
        const selector = typeof action.selector === "string" ? action.selector : "";
        const element = selector ? document.querySelector(selector) : undefined;
        if (element && typeof element.click === "function") {
          element.click();
          return { clicked: true, snapshot: collectTestSnapshot() };
        }
        return { clicked: false, snapshot: collectTestSnapshot() };
      }

      if (type === "setPrompt") {
        promptInput.value = typeof action.value === "string" ? action.value : "";
        promptInput.dispatchEvent(new Event("input", { bubbles: true }));
        return { value: promptInput.value, snapshot: collectTestSnapshot() };
      }

      if (type === "keydown") {
        const event = new KeyboardEvent("keydown", {
          key: typeof action.key === "string" ? action.key : "Enter",
          shiftKey: action.shiftKey === true,
          bubbles: true,
          cancelable: true,
        });
        promptInput.dispatchEvent(event);
        return {
          defaultPrevented: event.defaultPrevented,
          snapshot: collectTestSnapshot(),
        };
      }

      return { snapshot: collectTestSnapshot() };
    }

    function collectTestSnapshot() {
      const workLog = document.querySelector(".item.work-log");
      const workLogSummary = workLog ? workLog.querySelector("summary .title") : undefined;
      return {
        conversationActive: shellRoot.classList.contains("conversation-active"),
        statusHidden: isDisplayNone(document.querySelector(".status")),
        runsHidden: isDisplayNone(document.getElementById("runs-section")),
        contextHidden: isDisplayNone(document.querySelector(".context-viz")),
        approvalVisible: approvalRoot.classList.contains("active"),
        approvalTitle: textContent(".approval-title"),
        approvalActionLabels: textContents(".approval-action"),
        runDeleteConfirmVisible: document.querySelector(".run-delete-confirm") !== null,
        runIds: textAttributes(".run-entry-row", "data-run-id"),
        visibleItemTitles: textContents("#events > .item:not(.work-log) .title"),
        visibleItemTypes: textContents("#events > .item:not(.work-log) .type"),
        workLogVisible: workLog !== null,
        workLogOpen: workLog && "open" in workLog ? workLog.open === true : false,
        workLogTitle: workLogSummary ? workLogSummary.textContent || "" : "",
        workLogTypes: textContents(".work-log-row-meta span:last-child"),
        promptValue: promptInput.value,
        sendDisabled: sendButton.disabled,
        cancelDisabled: cancelButton.disabled,
        providerActions: textContents(".provider-action"),
      };
    }

    function isDisplayNone(element) {
      return !element || getComputedStyle(element).display === "none";
    }

    function textContent(selector) {
      const element = document.querySelector(selector);
      return element ? element.textContent || "" : "";
    }

    function textContents(selector) {
      return Array.from(document.querySelectorAll(selector)).map((element) => element.textContent || "");
    }

    function textAttributes(selector, attribute) {
      return Array.from(document.querySelectorAll(selector))
        .map((element) => element.getAttribute(attribute) || "")
        .filter((value) => value.length > 0);
    }
  </script>
</body>
</html>`;
}

function nonceValue(): string {
  return randomUUID().replaceAll("-", "");
}

function idleSubmission(): ChatSubmissionSnapshot {
  return {
    busy: false,
    status: "idle",
    message: "",
  };
}

function chatSubmissionActionFromProviderAction(
  action: ProviderConfigurationAction | undefined,
): ChatSubmissionAction | undefined {
  if (action === undefined) {
    return undefined;
  }

  return {
    type: action.type,
    label: action.label,
  };
}

function terminalSubmission(
  runId: string,
  turnId: string | undefined,
  terminal: TerminalRunState,
): ChatSubmissionSnapshot {
  return {
    busy: false,
    status: terminal.status,
    message: terminal.message,
    ...(terminal.error === undefined ? {} : { error: terminal.error }),
    ...(terminal.action === undefined ? {} : { action: terminal.action }),
    runId,
    ...(turnId === undefined ? {} : { turnId }),
  };
}

function terminalRunState(event: AgentEventEnvelope): TerminalRunState | undefined {
  if (event.type === "run.completed") {
    return {
      status: "completed",
      message: "Run completed.",
    };
  }

  if (event.type === "run.failed") {
    const message = terminalMessage(event, "Run failed.");
    const action = chatSubmissionActionFromProviderAction(
      providerConfigurationActionFromPayload(event.payload),
    );
    return {
      status: "failed",
      message,
      error: message,
      ...(action === undefined ? {} : { action }),
    };
  }

  if (event.type === "run.canceled") {
    return {
      status: "canceled",
      message: terminalMessage(event, "Run canceled."),
    };
  }

  return undefined;
}

function terminalMessage(event: AgentEventEnvelope, fallback: string): string {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const message = payload?.["message"] ?? payload?.["reason"] ?? payload?.["summary"];
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

function formatAgentEventLog(event: AgentEventEnvelope): string {
  const turn = event.turnId === undefined ? "" : ` turn=${event.turnId}`;
  return `agent.event #${event.seq} ${event.type} run=${event.runId}${turn} ${stringifyLogPayload(event.payload)}`;
}

function stringifyLogPayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload);
    return truncateLogText(serialized === undefined ? "undefined" : serialized);
  } catch {
    return truncateLogText(String(payload));
  }
}

function truncateLogText(value: string): string {
  return value.length <= 4096 ? value : `${value.slice(0, 4093)}...`;
}

function cancelRunIdFromMessage(message: unknown): string | undefined {
  if (!isRecord(message) || message["type"] !== "cancelTurn") {
    return undefined;
  }

  const runId = message["runId"];
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

function isConfigureDeepSeekApiKeyMessage(message: unknown): boolean {
  return isRecord(message) && message["type"] === "configureDeepSeekApiKey";
}

function isSelectDeepSeekModelMessage(message: unknown): boolean {
  return isRecord(message) && message["type"] === "selectDeepSeekModel";
}

function isOpenSettingsMessage(message: unknown): boolean {
  return isRecord(message) && message["type"] === "openSettings";
}

function isShowRunsMessage(message: unknown): boolean {
  return isRecord(message) && message["type"] === "showRuns";
}

function testProbeResultFromMessage(message: unknown): TestProbeResultWebviewMessage | undefined {
  if (!isRecord(message) || message["type"] !== "testProbeResult") {
    return undefined;
  }

  const id = message["id"];
  const ok = message["ok"];
  if (typeof id !== "string" || typeof ok !== "boolean") {
    return undefined;
  }

  return {
    type: "testProbeResult",
    id,
    ok,
    ...(message["result"] === undefined ? {} : { result: message["result"] }),
    ...(typeof message["error"] === "string" ? { error: message["error"] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
