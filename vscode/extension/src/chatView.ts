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
import { CHAT_RUN_MODES, DEFAULT_CHAT_MODE, parseChatTurnSubmission, sendTurnParams } from "./chatInput";
import { ChatEventTimeline, type ChatTimelineSnapshot } from "./chatEvents";
import {
  contextVizFromEvent,
  emptyContextViz,
  type ContextVizSnapshot,
} from "./contextViz";
import { diagnosticAttachmentsFromProblems } from "./diagnostics";
import type { ProleLogger } from "./logging";
import {
  CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL,
  isDeepSeekApiKeyRequiredMessage,
} from "./providerConfigurationUx";
import {
  CONFIGURE_DEEPSEEK_API_KEY_COMMAND,
  SELECT_DEEPSEEK_MODEL_COMMAND,
} from "./providerSecretCommands";
import type { MessageRedactor } from "./redaction";
import type { AgentEventEnvelope, DisposableLike } from "./rpcServer";
import {
  RUN_LIST_LIMIT,
  failedRunList,
  idleRunList,
  isRefreshRunsMessage,
  deleteRunIdFromMessage,
  loadingRunList,
  readyRunList,
  resumeRunIdFromMessage,
  type RunListSnapshot,
} from "./runHistory";

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

type ExtensionToWebviewMessage =
  | SnapshotWebviewMessage
  | SubmissionWebviewMessage
  | RunsWebviewMessage
  | ContextWebviewMessage;

type ChatSubmissionStatus = "idle" | "sending" | "running" | "completed" | "failed" | "canceled";
type TerminalSubmissionStatus = Extract<ChatSubmissionStatus, "completed" | "failed" | "canceled">;

export interface ChatSubmissionAction {
  readonly type: "configureDeepSeekApiKey";
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
}

export interface ChatViewTestState {
  readonly timeline: ChatTimelineSnapshot;
  readonly submission: ChatSubmissionSnapshot;
  readonly runs: RunListSnapshot;
  readonly context: ContextVizSnapshot;
}

export class ProleChatViewProvider implements vscode.WebviewViewProvider, DisposableLike {
  private readonly timeline = new ChatEventTimeline();
  private readonly terminalRuns = new Map<string, TerminalRunState>();
  private readonly rpcClient: ChatRpcClient | undefined;
  private submission: ChatSubmissionSnapshot = idleSubmission();
  private runList: RunListSnapshot = idleRunList();
  private contextViz: ContextVizSnapshot = emptyContextViz();
  private activeConversationRunId: string | undefined;
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
    );
    this.postSnapshot();
    this.postSubmission();
    this.postRuns();
    this.postContext();
    void this.refreshRuns();
  }

  openChatView(): Thenable<unknown> {
    return vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
  }

  testHandleWebviewMessage(message: unknown): Promise<void> {
    return this.handleWebviewMessage(message);
  }

  testState(): ChatViewTestState {
    return {
      timeline: this.timeline.snapshot(),
      submission: this.submission,
      runs: this.runList,
      context: this.contextViz,
    };
  }

  isIdle(): boolean {
    return !this.submission.busy;
  }

  dispose(): void {
    this.rpcSubscription?.dispose();
    this.viewMessageSubscription?.dispose();
    this.rpcSubscription = undefined;
    this.viewMessageSubscription = undefined;
  }

  private async handleWebviewMessage(message: unknown): Promise<void> {
    if (isRefreshRunsMessage(message)) {
      await this.refreshRuns();
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
      const missingApiKey = isDeepSeekApiKeyRequiredMessage(messageText);
      this.logger?.error(redacted);
      this.setSubmission({
        ...idleSubmission(),
        status: "failed",
        message: redacted,
        error: redacted,
        ...(missingApiKey ? { action: configureDeepSeekApiKeyAction() } : {}),
      });
      if (missingApiKey) {
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
      const runs = this.runList.runs.filter((run) => run.runId !== result.runId);
      if (this.activeConversationRunId === result.runId) {
        this.activeConversationRunId = undefined;
        this.timeline.clear();
        this.terminalRuns.delete(result.runId);
        this.setSubmission(idleSubmission());
        this.setContextViz(emptyContextViz());
        this.postSnapshot();
      }
      this.setRunList(readyRunList({ runs }, undefined, `Deleted ${result.runId}.`));
      void this.refreshRuns("Refreshing runs...");
    } catch (error) {
      const messageText = `Failed to delete run: ${errorMessage(error)}`;
      const redacted = this.redact(messageText);
      this.logger?.error(redacted);
      this.setRunList(failedRunList(redacted, this.runList));
    }
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

  private redact(message: string): string {
    return this.redactor?.redact(message) ?? message;
  }

  private async configureDeepSeekApiKey(): Promise<void> {
    await vscode.commands.executeCommand(CONFIGURE_DEEPSEEK_API_KEY_COMMAND);
  }

  private async selectDeepSeekModel(): Promise<void> {
    await vscode.commands.executeCommand(SELECT_DEEPSEEK_MODEL_COMMAND);
  }
}

function renderChatViewHtml(
  webview: vscode.Webview,
  snapshot: ChatTimelineSnapshot,
  submission: ChatSubmissionSnapshot,
  runList: RunListSnapshot,
  contextViz: ContextVizSnapshot,
): string {
  const nonce = nonceValue();
  const initialSnapshot = safeScriptJson(snapshot);
  const initialSubmission = safeScriptJson(submission);
  const initialRuns = safeScriptJson(runList);
  const initialContext = safeScriptJson(contextViz);
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

    .item.assistant {
      border-radius: 6px;
      background: var(--vscode-input-background);
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
    .refresh-runs:focus,
    .run-entry:focus,
    .run-delete:focus,
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
    <section class="status" aria-live="polite">
      <div id="status-title" class="status-title">ProleCoder</div>
      <div id="status-subtitle" class="status-subtitle">No run events yet.</div>
    </section>
    <section class="runs" aria-label="Runs">
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
    <form id="composer" class="composer">
      <textarea id="prompt" class="prompt" rows="3" placeholder="Ask ProleCoder" aria-label="Chat message"></textarea>
      <div class="composer-row">
        <select id="mode" class="mode" aria-label="Run mode"></select>
        <button id="api-key" class="provider-action" type="button" title="Configure DeepSeek API key">API Key</button>
        <button id="model" class="provider-action" type="button" title="Select DeepSeek model">Model</button>
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
    const runModes = ${safeScriptJson(CHAT_RUN_MODES)};
    const defaultMode = ${safeScriptJson(DEFAULT_CHAT_MODE)};
    const vscodeApi = acquireVsCodeApi();
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
    const sendButton = document.getElementById("send");
    const cancelButton = document.getElementById("cancel");
    const submissionRoot = document.getElementById("submission");
    let currentContext = initialContext;
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
      vscodeApi.postMessage({
        type: "submitTurn",
        message,
        mode: modeInput.value,
      });
    });

    promptInput.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        composer.requestSubmit();
      }
    });

    render(initialSnapshot);
    renderSubmission(initialSubmission);
    renderRuns(initialRuns);
    renderContext(initialContext);

    function render(snapshot) {
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      statusTitle.textContent = snapshot.latestStatus || "ProleCoder";
      statusSubtitle.textContent = snapshot.latestRunId
        ? snapshot.latestRunId + " - " + snapshot.eventCount + " events"
        : "No run events yet.";
      eventsRoot.replaceChildren();

      if (items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No run events yet.";
        eventsRoot.append(empty);
        return;
      }

      for (const item of items) {
        eventsRoot.append(renderItem(item));
      }
    }

    function renderRuns(snapshot) {
      const state = snapshot && typeof snapshot === "object" ? snapshot : initialRuns;
      const runs = Array.isArray(state.runs) ? state.runs : [];
      const status = typeof state.status === "string" ? state.status : "idle";
      const loading = status === "loading";
      refreshRunsButton.disabled = loading;
      runMessageRoot.className = "run-message " + status;
      const runMessage = typeof state.message === "string" ? state.message : "";
      runMessageRoot.textContent = runMessage;
      runMessageRoot.title = runMessage;
      runListRoot.replaceChildren();

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
      button.type = "button";
      button.className = "run-entry " + status + (run.runId === selectedRunId ? " selected" : "");
      button.disabled = disabled;
      button.title = typeof run.runId === "string" ? run.runId : "";
      button.addEventListener("click", () => {
        if (typeof run.runId === "string" && run.runId.length > 0) {
          vscodeApi.postMessage({ type: "resumeRun", runId: run.runId });
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
      deleteButton.textContent = "x";
      deleteButton.addEventListener("click", () => {
        if (typeof run.runId === "string" && run.runId.length > 0 && confirm("Delete this run?")) {
          vscodeApi.postMessage({ type: "deleteRun", runId: run.runId });
        }
      });

      button.append(title, meta);
      row.append(button, deleteButton);
      return row;
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

    function renderSubmission(submission) {
      const state = submission && typeof submission === "object" ? submission : initialSubmission;
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

    function renderItem(item) {
      const collapsed = item.defaultCollapsed === true;
      const article = document.createElement(collapsed ? "details" : "article");
      article.className = "item " + item.kind + " " + item.tone;

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
  </script>
</body>
</html>`;
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
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

function configureDeepSeekApiKeyAction(): ChatSubmissionAction {
  return {
    type: "configureDeepSeekApiKey",
    label: CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL,
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
    return {
      status: "failed",
      message,
      error: message,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
