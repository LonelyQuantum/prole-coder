import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

import type {
  CancelParams,
  CancelResult,
  DeleteRunParams,
  DeleteRunResult,
  LoadRunEventsParams,
  LoadRunEventsResult,
  ListRunsParams,
  ListRunsResult,
  ResumeParams,
  ResumeResult,
  SendTurnParams,
  SendTurnResult,
  SteerParams,
  SteerResult,
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
import { WEBVIEW_MARKDOWN_RENDERER_SCRIPT } from "./webviewMarkdown";
import { safeScriptJson } from "./webviewSerialization";

export const CHAT_VIEW_ID = "prole-coder.chat";
const WEBVIEW_EVENT_POST_DEBOUNCE_MS = 16;

export interface ChatRpcEventSource {
  onEvent(handler: (event: AgentEventEnvelope) => void): DisposableLike;
}

export interface ChatTurnSender {
  sendTurn(params: SendTurnParams): Promise<SendTurnResult>;
}

export interface ChatCancelClient {
  cancel(params: CancelParams): Promise<CancelResult>;
}

export interface ChatSteerClient {
  steer(params: SteerParams): Promise<SteerResult>;
}

export interface ChatRunHistoryClient {
  listRuns(params?: ListRunsParams): Promise<ListRunsResult>;
  resume(params: ResumeParams): Promise<ResumeResult>;
  loadRunEvents(params: LoadRunEventsParams): Promise<LoadRunEventsResult>;
  deleteRun(params: DeleteRunParams): Promise<DeleteRunResult>;
}

export type ChatRpcClient = ChatRpcEventSource &
  ChatTurnSender &
  ChatCancelClient &
  ChatSteerClient &
  ChatRunHistoryClient;

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

interface SteerResultWebviewMessage {
  readonly type: "steerResult";
  readonly ok: boolean;
  readonly message: string;
  readonly steerId?: string;
}

interface TimelineHistoryWebviewMessage {
  readonly type: "timelineHistory";
  readonly inFlight: boolean;
}

type ExtensionToWebviewMessage =
  | SnapshotWebviewMessage
  | SubmissionWebviewMessage
  | RunsWebviewMessage
  | ContextWebviewMessage
  | ApprovalWebviewMessage
  | TimelineHistoryWebviewMessage
  | SteerResultWebviewMessage
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

interface WebviewErrorMessage {
  readonly type: "webviewError";
  readonly message: string;
  readonly stack?: string;
}

interface WebviewReadyMessage {
  readonly type: "webviewReady";
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

interface PendingWebviewReady {
  readonly timeout: ReturnType<typeof setTimeout>;
  resolve(): void;
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
  private readonly webviewReadyWaiters = new Set<PendingWebviewReady>();
  private rpcSubscription: DisposableLike | undefined;
  private viewMessageSubscription: DisposableLike | undefined;
  private view: vscode.WebviewView | undefined;
  private webviewReady = false;
  private webviewGeneration = 0;
  private webviewPostFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotPostQueued = false;
  private submissionPostQueued = false;
  private contextPostQueued = false;
  private cancelActiveTurnRequested = false;
  private historyLoadInFlight = false;
  private readonly conversationApprovalGrants = new Map<string, Set<string>>();

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
      this.queueSnapshotPost();
      if (contextViz !== undefined) {
        this.queueContextPost();
      }
      this.queueSubmissionPost();
      if (terminal && this.view !== undefined) {
        void this.refreshRuns("Refreshing runs...");
      }
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.webviewReady = false;
    const webviewGeneration = (this.webviewGeneration += 1);
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
    this.postSubmission();
    this.postSnapshot();
    this.postRuns();
    this.postContext();
    this.postApproval();
    void this.refreshRuns();
    setTimeout(() => {
      if (
        this.view === webviewView &&
        this.webviewGeneration === webviewGeneration &&
        this.webviewReady !== true
      ) {
        this.logger?.error(
          "Sidebar webview did not report ready within 3000ms; scripts may be blocked or the webview may need reload.",
        );
      }
    }, 3000);
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

    await this.waitForWebviewReady();
    this.flushQueuedWebviewPosts();

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
    this.rejectPendingWebviewReady("chat view disposed");
    this.clearQueuedWebviewPosts();
    this.rpcSubscription?.dispose();
    this.viewMessageSubscription?.dispose();
    this.rpcSubscription = undefined;
    this.viewMessageSubscription = undefined;
  }

  requestApproval(request: ApprovalPromptRequest): Promise<ApprovalPromptDecision> {
    const grantKey = conversationApprovalGrantKey(request);
    if (grantKey !== undefined && this.hasConversationApprovalGrant(request.runId, grantKey)) {
      return Promise.resolve({
        kind: "approve",
        approvalId: request.approvalId,
        persist: "never",
      });
    }

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

    const webviewError = webviewErrorFromMessage(message);
    if (webviewError !== undefined) {
      const stack = webviewError.stack === undefined ? "" : `\n${webviewError.stack}`;
      this.logger?.error(this.redact(`Sidebar webview error: ${webviewError.message}${stack}`));
      return;
    }

    if (isWebviewReadyMessage(message)) {
      this.logger?.info("Sidebar webview ready.");
      this.markWebviewReady();
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

    if (isLoadEarlierTimelineMessage(message)) {
      await this.loadEarlierTimeline();
      return;
    }

    const approvalDecision =
      this.pendingApproval === undefined
        ? undefined
        : this.approvalDecisionFromWebviewMessage(message, this.pendingApproval.request);
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
    if (isCancelTurnMessage(message)) {
      await this.cancelActiveTurn();
      return;
    }

    const steerMessage = steerTurnMessageFromWebviewMessage(message);
    if (steerMessage !== undefined) {
      await this.steerActiveTurn(steerMessage);
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

    this.cancelActiveTurnRequested = false;
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
      const nextSubmission: ChatSubmissionSnapshot =
        terminal === undefined
          ? {
              busy: true,
              status: "running",
              message: "Agent turn running.",
              runId: result.runId,
              turnId: result.turnId,
            }
          : terminalSubmission(result.runId, result.turnId, terminal);
      this.setSubmission(nextSubmission);
      if (this.cancelActiveTurnRequested && nextSubmission.busy) {
        this.cancelActiveTurnRequested = false;
        await this.cancelTurn(result.runId);
      } else {
        this.cancelActiveTurnRequested = false;
      }
    } catch (error) {
      this.cancelActiveTurnRequested = false;
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
    this.postToWebview(message);
  }

  private postSubmission(): void {
    const message: ExtensionToWebviewMessage = {
      type: "submission",
      submission: this.submission,
    };
    this.postToWebview(message);
  }

  private postRuns(): void {
    const message: ExtensionToWebviewMessage = {
      type: "runs",
      runs: this.runList,
    };
    this.postToWebview(message);
  }

  private postContext(): void {
    const message: ExtensionToWebviewMessage = {
      type: "context",
      context: this.contextViz,
    };
    this.postToWebview(message);
  }

  private queueSnapshotPost(): void {
    this.snapshotPostQueued = true;
    this.scheduleWebviewPostFlush();
  }

  private queueSubmissionPost(): void {
    this.submissionPostQueued = true;
    this.scheduleWebviewPostFlush();
  }

  private queueContextPost(): void {
    this.contextPostQueued = true;
    this.scheduleWebviewPostFlush();
  }

  private scheduleWebviewPostFlush(): void {
    if (this.webviewPostFlushTimer !== undefined) {
      return;
    }

    this.webviewPostFlushTimer = setTimeout(() => {
      this.flushQueuedWebviewPosts();
    }, WEBVIEW_EVENT_POST_DEBOUNCE_MS);
  }

  private flushQueuedWebviewPosts(): void {
    if (this.webviewPostFlushTimer !== undefined) {
      clearTimeout(this.webviewPostFlushTimer);
      this.webviewPostFlushTimer = undefined;
    }

    const postSnapshot = this.snapshotPostQueued;
    const postSubmission = this.submissionPostQueued;
    const postContext = this.contextPostQueued;
    this.snapshotPostQueued = false;
    this.submissionPostQueued = false;
    this.contextPostQueued = false;

    if (postSubmission) {
      this.postSubmission();
    }
    if (postSnapshot) {
      this.postSnapshot();
    }
    if (postContext) {
      this.postContext();
    }
  }

  private clearQueuedWebviewPosts(): void {
    if (this.webviewPostFlushTimer !== undefined) {
      clearTimeout(this.webviewPostFlushTimer);
      this.webviewPostFlushTimer = undefined;
    }
    this.snapshotPostQueued = false;
    this.submissionPostQueued = false;
    this.contextPostQueued = false;
  }

  private postApproval(): void {
    const approval = this.pendingApprovalSnapshot();
    const message: ExtensionToWebviewMessage = {
      type: "approval",
      ...(approval === undefined ? {} : { approval }),
    };
    this.postToWebview(message);
  }

  private postTimelineHistory(inFlight: boolean): void {
    this.postToWebview({
      type: "timelineHistory",
      inFlight,
    });
  }

  private postToWebview(message: ExtensionToWebviewMessage): void {
    if (this.view === undefined || !this.webviewReady) {
      return;
    }
    void this.view.webview.postMessage(message);
  }

  private markWebviewReady(): void {
    if (this.webviewReady) {
      return;
    }

    this.webviewReady = true;
    for (const pending of this.webviewReadyWaiters) {
      clearTimeout(pending.timeout);
      pending.resolve();
    }
    this.webviewReadyWaiters.clear();

    this.postSubmission();
    this.postSnapshot();
    this.postRuns();
    this.postContext();
    this.postApproval();
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

  private async loadEarlierTimeline(): Promise<void> {
    if (this.historyLoadInFlight) {
      return;
    }

    const runId = this.activeConversationRunId ?? this.timeline.snapshot().latestRunId;
    if (runId === undefined) {
      this.postTimelineHistory(false);
      return;
    }

    if (this.timeline.hasHiddenProcessItems()) {
      this.timeline.revealHiddenProcessItems();
      this.postSnapshot();
      this.postTimelineHistory(false);
      return;
    }

    if (this.rpcClient === undefined) {
      this.postTimelineHistory(false);
      return;
    }

    const beforeSeq = this.timeline.oldestLoadedSeq();
    if (beforeSeq === undefined || beforeSeq <= 1) {
      this.postTimelineHistory(false);
      return;
    }

    this.historyLoadInFlight = true;
    this.postTimelineHistory(true);
    try {
      const result = await this.rpcClient.loadRunEvents({
        runId,
        beforeSeq,
        limit: 200,
      });
      if (result.events.length > 0) {
        this.timeline.prepend(result.events);
        this.activeConversationRunId = result.runId;
        this.postSnapshot();
      }
    } catch (error) {
      this.logger?.warn(this.redact(`Failed to load earlier run events: ${errorMessage(error)}`));
    } finally {
      this.historyLoadInFlight = false;
      this.postTimelineHistory(false);
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

  private async cancelActiveTurn(): Promise<void> {
    const runId = this.submission.runId;
    if (runId !== undefined && runId.length > 0) {
      await this.cancelTurn(runId);
      return;
    }

    if (!this.submission.busy || this.submission.canceling) {
      return;
    }

    this.cancelActiveTurnRequested = true;
    this.setSubmission({
      ...this.submission,
      message: "Cancel requested...",
      canceling: true,
    });
  }

  private async steerActiveTurn(params: SteerParams): Promise<void> {
    if (this.rpcClient === undefined) {
      this.setSubmission({
        ...this.submission,
        message: "Open a trusted workspace before steering a turn.",
        error: "No trusted workspace is available.",
      });
      this.postSteerResult(false, params.message);
      return;
    }

    if (!this.submission.busy || this.submission.runId !== params.runId) {
      this.setSubmission({
        ...this.submission,
        message: "No active turn is available for steering.",
      });
      this.postSteerResult(false, params.message);
      return;
    }

    try {
      const result = await this.rpcClient.steer(params);
      this.setSubmission({
        ...this.submission,
        message: "Steer queued.",
      });
      this.postSteerResult(true, params.message, result.steerId);
    } catch (error) {
      const messageText = `Failed to steer turn: ${errorMessage(error)}`;
      const redacted = this.redact(messageText);
      this.logger?.error(redacted);
      this.setSubmission({
        ...this.submission,
        message: redacted,
        error: redacted,
      });
      this.postSteerResult(false, params.message);
    }
  }

  private postSteerResult(ok: boolean, message: string, steerId?: string): void {
    this.postToWebview({
      type: "steerResult",
      ok,
      message,
      ...(steerId === undefined ? {} : { steerId }),
    });
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

  private approvalDecisionFromWebviewMessage(
    message: unknown,
    request: ApprovalPromptRequest,
  ): ApprovalPromptDecision | undefined {
    if (isConversationApprovalMessage(message, request)) {
      const grantKey = conversationApprovalGrantKey(request);
      if (grantKey !== undefined) {
        this.rememberConversationApprovalGrant(request.runId, grantKey);
      }
      return {
        kind: "approve",
        approvalId: request.approvalId,
        persist: "never",
      };
    }

    return approvalDecisionFromWebviewMessage(message, request);
  }

  private hasConversationApprovalGrant(runId: string | undefined, grantKey: string): boolean {
    if (runId === undefined || runId.length === 0) {
      return false;
    }
    return this.conversationApprovalGrants.get(runId)?.has(grantKey) === true;
  }

  private rememberConversationApprovalGrant(runId: string | undefined, grantKey: string): void {
    if (runId === undefined || runId.length === 0) {
      return;
    }
    let grants = this.conversationApprovalGrants.get(runId);
    if (grants === undefined) {
      grants = new Set<string>();
      this.conversationApprovalGrants.set(runId, grants);
    }
    grants.add(grantKey);
    while (this.conversationApprovalGrants.size > 20) {
      const oldest = this.conversationApprovalGrants.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.conversationApprovalGrants.delete(oldest);
    }
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

  private waitForWebviewReady(): Promise<void> {
    if (this.webviewReady) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.webviewReadyWaiters.delete(pending);
        reject(new Error("timed out waiting for chat webview ready"));
      }, 5000);
      const pending: PendingWebviewReady = {
        timeout,
        resolve,
        reject,
      };
      this.webviewReadyWaiters.add(pending);
    });
  }

  private rejectPendingWebviewReady(reason: string): void {
    for (const pending of this.webviewReadyWaiters) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.webviewReadyWaiters.delete(pending);
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src ${webview.cspSource} 'nonce-${nonce}';">
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
      position: relative;
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
      padding: 8px 44px 8px 10px;
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
      padding: 10px 44px 10px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-sideBarSectionHeader-background);
    }

    .settings-action {
      position: absolute;
      top: 8px;
      right: 10px;
      z-index: 2;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      color: var(--vscode-icon-foreground);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 3px;
      cursor: pointer;
    }

    .settings-action:hover:enabled {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .settings-action svg {
      width: 16px;
      height: 16px;
      pointer-events: none;
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

    .message-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    .message-heading .title {
      min-width: 0;
    }

    .message-edit {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      min-width: 24px;
      height: 24px;
      padding: 0;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 0;
      border-radius: 4px;
    }

    .message-edit-icon {
      width: 15px;
      height: 15px;
      flex: 0 0 15px;
      pointer-events: none;
    }

    .message-edit:hover:enabled {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .message-edit:disabled {
      opacity: 0.55;
      cursor: default;
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

    .body.markdown {
      display: grid;
      gap: 8px;
      white-space: normal;
    }

    .body.markdown > * {
      margin: 0;
      min-width: 0;
    }

    .body.markdown h3,
    .body.markdown h4,
    .body.markdown h5,
    .body.markdown h6 {
      font-size: 13px;
      line-height: 1.35;
      margin-top: 2px;
    }

    .body.markdown ul,
    .body.markdown ol {
      padding-left: 18px;
    }

    .body.markdown li + li {
      margin-top: 3px;
    }

    .body.markdown blockquote {
      border-left: 2px solid var(--vscode-textBlockQuote-border);
      color: var(--vscode-textBlockQuote-foreground);
      padding-left: 10px;
    }

    .body.markdown hr {
      border: 0;
      border-top: 1px solid var(--vscode-editorWidget-border);
      margin: 2px 0;
    }

    .body.markdown pre {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 6px;
      overflow-x: auto;
      padding: 8px;
      white-space: pre;
    }

    .body.markdown code {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      padding: 1px 4px;
    }

    .body.markdown pre code {
      background: transparent;
      border-radius: 0;
      display: block;
      padding: 0;
    }

    .body.markdown table {
      border-collapse: collapse;
      display: block;
      overflow-x: auto;
    }

    .body.markdown th,
    .body.markdown td {
      border: 1px solid var(--vscode-editorWidget-border);
      padding: 4px 6px;
      text-align: left;
      vertical-align: top;
    }

    .body.markdown th {
      background: var(--vscode-editorWidget-background);
      font-weight: 600;
    }

    details.item:not([open]) > .body {
      display: none;
    }

    .item-children {
      display: grid;
      gap: 8px;
      padding-left: 10px;
      border-left: 1px solid var(--vscode-editorWidget-border);
    }

    details.item:not([open]) > .item-children {
      display: none;
    }

    .work-log-body {
      display: grid;
      gap: 0;
    }

    .work-log-group {
      border-top: 1px solid var(--vscode-editorWidget-border);
      padding: 6px 0;
    }

    .work-log-group:first-child {
      border-top: 0;
      padding-top: 0;
    }

    .work-log-segment-summary {
      border-top: 1px solid var(--vscode-editorWidget-border);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.35;
      padding: 6px 0;
    }

    .work-log-group-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }

    .work-log-group-count {
      color: var(--vscode-descriptionForeground);
      font-weight: 400;
      white-space: nowrap;
    }

    .work-log-group-body {
      display: grid;
      gap: 0;
      margin-top: 4px;
      padding-left: 10px;
      border-left: 1px solid var(--vscode-editorWidget-border);
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

    .active-work-status {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.35;
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
      max-height: min(70vh, 32rem);
      overflow: auto;
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

    .approval-detail {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .approval-section {
      display: grid;
      gap: 3px;
      padding: 6px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
    }

    .approval-section-label {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.2;
    }

    /* Long shell commands intentionally wrap vertically; the approval card owns scrolling. */
    .approval-section-body {
      color: var(--vscode-foreground);
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    /* Keep command text distinct from scope/output summaries for fast approval scanning. */
    .approval-command .approval-section-body {
      font-family: var(--vscode-editor-font-family);
    }

    .approval-meta .approval-section-body,
    .approval-output .approval-section-body {
      color: var(--vscode-descriptionForeground);
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
      flex-wrap: wrap;
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
    .message-edit:focus,
    .settings-action:focus,
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
      flex-wrap: nowrap;
      gap: 8px;
      min-width: 0;
    }

    .provider-actions {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }

    .mode {
      min-width: 92px;
      height: 28px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border, transparent);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    .mode[hidden] {
      display: none !important;
    }

    .send,
    .cancel {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      min-width: 28px;
      height: 28px;
      padding: 0;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 0;
      font: var(--vscode-font-size) var(--vscode-font-family);
      font-weight: 600;
    }

    .send.stop {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    .send:hover:enabled {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .send.stop:hover:enabled {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .cancel {
      display: none;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font-weight: 500;
    }

    .provider-action {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      min-width: 28px;
      height: 28px;
      padding: 0;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 0;
      font: var(--vscode-font-size) var(--vscode-font-family);
      font-weight: 500;
    }

    .provider-action-icon,
    .send-icon {
      display: block;
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      pointer-events: none;
    }

    .send-icon[hidden] {
      display: none !important;
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
      flex: 1 1 auto;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      font-size: 12px;
      overflow: visible;
      white-space: normal;
    }

    .submission-message {
      min-width: 0;
      flex: 1 1 8rem;
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

    .steer-confirmation-host:empty {
      display: none;
    }

    .steer-confirm {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 6px;
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-editorWidget-border);
    }

    .steer-confirm-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .steer-confirm button {
      height: 24px;
      min-width: 48px;
      border: 1px solid transparent;
      border-radius: 3px;
      cursor: pointer;
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    .steer-confirm-send {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .steer-confirm-delete {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    .steer-confirm button:hover {
      filter: brightness(1.08);
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
    <button id="settings" class="settings-action" type="button" title="Open ProleCoder settings" aria-label="Open ProleCoder settings">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" fill="none" stroke="currentColor" stroke-width="1.8"/>
        <path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.5-2.4 1a8 8 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A8 8 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a8 8 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>
    </button>
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
      <div id="steer-confirmation" class="steer-confirmation-host" aria-live="polite"></div>
      <textarea id="prompt" class="prompt" rows="3" placeholder="Ask ProleCoder" aria-label="Chat message"></textarea>
      <div class="composer-row">
        <select id="mode" class="mode" aria-label="Run mode" hidden></select>
        <div class="provider-actions" aria-label="Provider controls">
          <button id="api-key" class="provider-action" type="button" title="Configure DeepSeek API key" aria-label="Configure DeepSeek API key">
            <svg class="provider-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="7.5" cy="15.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/>
              <path d="M10.7 12.3 21 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <path d="m15.5 6.5 3 3M18 4l2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
          <button id="model" class="provider-action" type="button" title="Select DeepSeek model" aria-label="Select DeepSeek model">
            <svg class="provider-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M9.2 4.2c-1.5 0-2.8 1.1-3 2.6-1.6.4-2.7 1.8-2.7 3.5 0 1 .4 1.9 1.1 2.6-.5.6-.8 1.4-.8 2.3 0 2 1.6 3.6 3.6 3.6.5 1 1.5 1.8 2.7 1.8 1.6 0 2.9-1.3 2.9-2.9V7.1c0-1.6-1.3-2.9-2.9-2.9h-.9Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
              <path d="M14.8 4.2c1.5 0 2.8 1.1 3 2.6 1.6.4 2.7 1.8 2.7 3.5 0 1-.4 1.9-1.1 2.6.5.6.8 1.4.8 2.3 0 2-1.6 3.6-3.6 3.6-.5 1-1.5 1.8-2.7 1.8-1.6 0-2.9-1.3-2.9-2.9V7.1c0-1.6 1.3-2.9 2.9-2.9h.9Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
              <path d="M12 8.2c-.8-.8-2.1-.9-3-.2M12 12c-1.1-.7-2.5-.5-3.3.5M12 15.8c-.8.9-2.1 1.2-3.2.6M12 8.2c.8-.8 2.1-.9 3-.2M12 12c1.1-.7 2.5-.5 3.3.5M12 15.8c.8.9 2.1 1.2 3.2.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
        <button id="send" class="send" type="button" title="Send message" aria-label="Send message">
          <svg class="send-icon send-icon-submit" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M20 4v7a4 4 0 0 1-4 4H5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="m10 10-5 5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg class="send-icon send-icon-stop" viewBox="0 0 24 24" aria-hidden="true" focusable="false" hidden>
            <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>
          </svg>
        </button>
        <button id="cancel" class="cancel" type="button" hidden>Cancel</button>
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
${WEBVIEW_MARKDOWN_RENDERER_SCRIPT}
    const vscodeApi = acquireVsCodeApi();
    window.addEventListener("error", (event) => {
      postWebviewError(event.message, event.error && event.error.stack);
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      const message = reason && typeof reason.message === "string" ? reason.message : String(reason);
      const stack = reason && typeof reason.stack === "string" ? reason.stack : undefined;
      postWebviewError(message, stack);
    });
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
    const sendSubmitIcon = sendButton.querySelector(".send-icon-submit");
    const sendStopIcon = sendButton.querySelector(".send-icon-stop");
    const cancelButton = document.getElementById("cancel");
    const submissionRoot = document.getElementById("submission");
    const steerConfirmationRoot = document.getElementById("steer-confirmation");
    const approvalRoot = document.getElementById("approval");
    const restoredWebviewState = readWebviewState();
    let currentSnapshot = initialSnapshot;
    let currentSubmission = initialSubmission;
    let currentRuns = initialRuns;
    let currentContext = initialContext;
    let currentApproval = initialApproval;
    let pendingRunDeleteId = "";
    let editingMessageId = "";
    let editingMessageTurnId = "";
    let pendingSteerMessage = "";
    let pendingSteerRunId = "";
    let pendingSteerId = "";
    let pendingSteerAccepted = false;
    let pendingSteerConfirmation = "";
    let historyLoadRequested = false;
    const supersededUserItemIds = new Set(restoredWebviewState.supersededUserItemIds);
    const resolvedApprovalIds = new Set();
    let contextSourceTab = "included";

    for (const mode of runModes) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = mode[0].toUpperCase() + mode.slice(1);
      modeInput.append(option);
    }
    modeInput.value = defaultMode;

    window.addEventListener("message", safeWebviewEventHandler("message", (event) => {
      const message = event.data;
      if (message && message.type === "testProbe") {
        handleTestProbe(message);
        return;
      }
      if (message && message.type === "snapshot") {
        clearPendingSteerIfDelivered(message.snapshot);
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
      if (message && message.type === "timelineHistory") {
        historyLoadRequested = message.inFlight === true;
      }
      if (message && message.type === "approval") {
        renderApproval(message.approval);
      }
      if (message && message.type === "steerResult") {
        handleSteerResult(message);
      }
    }));

    showRunsButton.addEventListener("click", safeWebviewEventHandler("show runs click", () => {
      vscodeApi.postMessage({ type: "showRuns" });
    }));

    refreshRunsButton.addEventListener("click", safeWebviewEventHandler("refresh runs click", () => {
      vscodeApi.postMessage({ type: "refreshRuns" });
    }));

    eventsRoot.addEventListener("scroll", safeWebviewEventHandler("events scroll", () => {
      if (eventsRoot.scrollTop > 24 || historyLoadRequested === true) {
        return;
      }
      historyLoadRequested = true;
      vscodeApi.postMessage({ type: "loadEarlierTimeline" });
    }));

    apiKeyButton.addEventListener("click", safeWebviewEventHandler("api key click", () => {
      vscodeApi.postMessage({ type: "configureDeepSeekApiKey" });
    }));

    modelButton.addEventListener("click", safeWebviewEventHandler("model click", () => {
      vscodeApi.postMessage({ type: "selectDeepSeekModel" });
    }));

    settingsButton.addEventListener("click", safeWebviewEventHandler("settings click", () => {
      vscodeApi.postMessage({ type: "openSettings" });
    }));

    cancelButton.addEventListener("click", safeWebviewEventHandler("cancel click", () => {
      requestCancelCurrentTurn();
    }));

    composer.addEventListener("submit", safeWebviewEventHandler("composer submit", (event) => {
      event.preventDefault();
      if (currentSubmission && currentSubmission.busy === true) {
        queueSteerConfirmation();
        return;
      }
      submitComposerMessage();
    }));

    sendButton.addEventListener("click", safeWebviewEventHandler("send click", () => {
      if (currentSubmission && currentSubmission.busy === true) {
        if (promptHasText()) {
          queueSteerConfirmation();
        } else {
          requestCancelCurrentTurn();
        }
        return;
      }
      submitComposerMessage();
    }));

    promptInput.addEventListener("input", safeWebviewEventHandler("prompt input", () => {
      syncSendButtonMode();
    }));

    promptInput.addEventListener("keydown", safeWebviewEventHandler("prompt keydown", (event) => {
      if (event.key === "Enter" && event.shiftKey !== true) {
        event.preventDefault();
        if (event.isComposing === true) {
          return;
        }
        if (currentSubmission && currentSubmission.busy === true) {
          queueSteerConfirmation();
          return;
        }
        submitComposerMessage();
      }
    }));

    try {
      render(initialSnapshot);
      renderSubmission(initialSubmission);
      renderRuns(initialRuns);
      renderContext(initialContext);
      renderApproval(initialApproval);
    } catch (error) {
      reportWebviewException("initial render", error);
    }
    vscodeApi.postMessage({ type: "webviewReady" });

    function submitComposerMessage() {
      if (sendButton.disabled) {
        return;
      }

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

      currentSubmission = {
        busy: true,
        status: "sending",
        message: "Sending turn...",
      };
      const supersedes = editingMessageId.length > 0
        ? {
            messageId: editingMessageId,
            ...(editingMessageTurnId.length > 0 ? { turnId: editingMessageTurnId } : {}),
          }
        : undefined;
      if (supersedes !== undefined) {
        supersededUserItemIds.add(editingMessageId);
        persistSupersededUserItems();
        editingMessageId = "";
        editingMessageTurnId = "";
      }
      renderPendingUserMessage(message);
      clearPromptInput();
      renderSubmission(currentSubmission);
      vscodeApi.postMessage({
        type: "submitTurn",
        message,
        ...(supersedes === undefined ? {} : { supersedes }),
      });
    }

    function queueSteerConfirmation() {
      if (sendButton.disabled) {
        return;
      }
      const runId = currentSubmission && typeof currentSubmission.runId === "string" ? currentSubmission.runId : "";
      const message = promptInput.value.trim();
      if (runId.length === 0 || message.length === 0) {
        return;
      }
      pendingSteerConfirmation = message;
      clearPromptInput();
      renderSubmission(currentSubmission);
    }

    function sendConfirmedSteerMessage(message) {
      const runId = currentSubmission && typeof currentSubmission.runId === "string" ? currentSubmission.runId : "";
      if (runId.length === 0 || typeof message !== "string" || message.trim().length === 0) {
        return;
      }
      const trimmedMessage = message.trim();
      pendingSteerMessage = trimmedMessage;
      pendingSteerRunId = runId;
      pendingSteerId = "";
      pendingSteerAccepted = false;
      pendingSteerConfirmation = "";
      currentSubmission = {
        ...(currentSubmission && typeof currentSubmission === "object" ? currentSubmission : {}),
        busy: true,
        status: "running",
        message: "Sending steer...",
      };
      renderSubmission(currentSubmission);
      render(currentSnapshot);
      vscodeApi.postMessage({
        type: "steerTurn",
        runId,
        message: trimmedMessage,
      });
    }

    function handleSteerResult(result) {
      const message = result && typeof result.message === "string" ? result.message.trim() : "";
      if (message.length === 0) {
        return;
      }

      if (result && result.ok === true) {
        if (promptInput.value.trim() === message) {
          promptInput.value = "";
        }
        const steerId = typeof result.steerId === "string" ? result.steerId : "";
        if (pendingSteerMessage === message) {
          pendingSteerAccepted = true;
        }
        if (pendingSteerMessage === message && steerId.length > 0) {
          pendingSteerId = steerId;
        }
        clearPendingSteerIfDelivered(currentSnapshot);
      } else if (promptInput.value.trim().length === 0) {
        promptInput.value = message;
        if (pendingSteerMessage === message) {
          clearPendingSteerState();
        }
      }

      syncSendButtonMode();
      render(currentSnapshot);
    }

    function clearPromptInput() {
      promptInput.value = "";
      promptInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function promptHasText() {
      return promptInput.value.trim().length > 0;
    }

    function requestCancelCurrentTurn() {
      const runId = sendButton.dataset.runId || cancelButton.dataset.runId || "";
      const canceling = currentSubmission && currentSubmission.canceling === true;
      if (canceling === true) {
        return;
      }
      vscodeApi.postMessage({
        type: "cancelTurn",
        ...(runId.length > 0 ? { runId } : {}),
      });
    }

    function readWebviewState() {
      let state = {};
      if (typeof vscodeApi.getState === "function") {
        const restored = vscodeApi.getState();
        state = isWebviewStateRecord(restored) ? restored : {};
      }
      return {
        ...state,
        supersededUserItemIds: readStringArray(state.supersededUserItemIds),
      };
    }

    function persistSupersededUserItems() {
      const state = readWebviewState();
      const nextIds = Array.from(supersededUserItemIds).slice(-200);
      supersededUserItemIds.clear();
      for (const id of nextIds) {
        supersededUserItemIds.add(id);
      }
      vscodeApi.setState({
        ...state,
        supersededUserItemIds: nextIds,
      });
    }

    function readStringArray(value) {
      if (!Array.isArray(value)) {
        return [];
      }
      return value.filter((item) => typeof item === "string" && item.length > 0);
    }

    function isWebviewStateRecord(value) {
      return value !== null && typeof value === "object" && Array.isArray(value) !== true;
    }

    function postWebviewError(message, stack) {
      vscodeApi.postMessage({
        type: "webviewError",
        message: typeof message === "string" && message.length > 0 ? message : "unknown webview error",
        ...(typeof stack === "string" && stack.length > 0 ? { stack } : {}),
      });
    }

    function safeWebviewEventHandler(label, handler) {
      return (event) => {
        try {
          handler(event);
        } catch (error) {
          reportWebviewException(label, error);
        }
      };
    }

    function reportWebviewException(label, error) {
      const message = error && typeof error.message === "string" ? error.message : String(error);
      const stack = error && typeof error.stack === "string" ? error.stack : undefined;
      postWebviewError(label + ": " + message, stack);
    }

    function renderPendingUserMessage(message) {
      const snapshot = currentSnapshot && typeof currentSnapshot === "object" ? currentSnapshot : initialSnapshot;
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      const visibleItems = visibleTimelineItems(snapshot, items);
      const workItems = Array.from(timelineWorkItems(snapshot, items));
      const pendingRunId = activeConversationRunId() || "pending";
      visibleItems.push({
        id: "pending-user-message",
        seq: 0,
        lastSeq: 0,
        time: new Date().toISOString(),
        type: "turn.pending",
        runId: pendingRunId,
        kind: "user",
        tone: "neutral",
        title: "You",
        body: message,
      });
      render({
        ...snapshot,
        latestRunId: typeof snapshot.latestRunId === "string" ? snapshot.latestRunId : pendingRunId,
        latestStatus: "Sending turn",
        visibleItems,
        workItems,
      });
    }

    function pendingSteerTimelineItem(snapshot) {
      if (pendingSteerMessage.length === 0) {
        return undefined;
      }

      const runId = pendingSteerRunId || activeConversationRunId() || "pending";
      return {
        id: "pending-steer-message",
        seq: 0,
        lastSeq: 0,
        time: new Date().toISOString(),
        type: "turn.steerPending",
        runId,
        kind: "user",
        tone: "neutral",
        title: "You (queued)",
        body: pendingSteerMessage,
      };
    }

    function clearPendingSteerIfDelivered(snapshot) {
      if (pendingSteerMessage.length === 0 || hasDeliveredPendingSteer(snapshot) !== true) {
        return;
      }
      clearPendingSteerState();
    }

    function clearPendingSteerState() {
      pendingSteerMessage = "";
      pendingSteerRunId = "";
      pendingSteerId = "";
      pendingSteerAccepted = false;
    }

    function hasDeliveredPendingSteer(snapshot) {
      if (!snapshot || typeof snapshot !== "object") {
        return false;
      }
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      for (const item of items) {
        if (!item || typeof item !== "object" || item.type !== "turn.steered") {
          continue;
        }
        const sameRun = pendingSteerRunId.length === 0 || item.runId === pendingSteerRunId;
        if (sameRun !== true) {
          continue;
        }
        if (pendingSteerId.length > 0) {
          if (item.steerId === pendingSteerId) {
            return true;
          }
          continue;
        }
        if (pendingSteerAccepted === true && item.body === pendingSteerMessage) {
          return true;
        }
      }
      return false;
    }

    function render(snapshot) {
      currentSnapshot = snapshot && typeof snapshot === "object" ? snapshot : initialSnapshot;
      syncSupersededUserItemsFromSnapshot(currentSnapshot);
      const items = Array.isArray(currentSnapshot.items) ? currentSnapshot.items : [];
      const visibleItems = visibleTimelineItems(currentSnapshot, items);
      const workItems = timelineWorkItems(currentSnapshot, items);
      const pendingSteerItem = pendingSteerTimelineItem(currentSnapshot);
      statusTitle.textContent = currentSnapshot.latestStatus || "ProleCoder";
      statusSubtitle.textContent = currentSnapshot.latestRunId
        ? currentSnapshot.latestRunId + " - " + currentSnapshot.eventCount + " events"
        : "No run events yet.";
      eventsRoot.replaceChildren();
      syncConversationChrome();

      if (visibleItems.length === 0 && workItems.length === 0 && pendingSteerItem === undefined) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No run events yet.";
        eventsRoot.append(empty);
        return;
      }

      for (const item of visibleItems) {
        eventsRoot.append(renderItemSafely(item));
      }
      if (workItems.length > 0 && shouldOpenWorkLog(workItems)) {
        eventsRoot.append(renderWorkLog(workItems));
      }
      if (pendingSteerItem !== undefined) {
        eventsRoot.append(renderItemSafely(pendingSteerItem));
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

      if (typeof approval.command === "string" && approval.command.length > 0) {
        card.append(renderApprovalSection("Command", approval.command, "approval-command"));
      }

      const meta = approvalMetaText(approval);
      if (meta.length > 0) {
        card.append(renderApprovalSection("Scope", meta, "approval-meta"));
      }

      if (typeof approval.outputSummary === "string" && approval.outputSummary.length > 0) {
        card.append(renderApprovalSection("Previous output", approval.outputSummary, "approval-output"));
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

      const conversationApproveButton = document.createElement("button");
      conversationApproveButton.type = "button";
      conversationApproveButton.className = "approval-action approve conversation";
      conversationApproveButton.textContent = "Approve for conversation";
      conversationApproveButton.addEventListener("click", () => {
        markApprovalResolved(approval.approvalId);
        vscodeApi.postMessage({
          type: "approvalDecision",
          approvalId: approval.approvalId,
          decision: "approve",
          persist: "conversation",
        });
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
      if (canApproveForConversation(approval, hunkInputs)) {
        actions.append(conversationApproveButton);
      }
      card.append(actions);
      return card;
    }

    function canApproveForConversation(approval, hunkInputs) {
      return (
        approval &&
        approval.toolName === "shell" &&
        approval.persistable === true &&
        typeof approval.runId === "string" &&
        approval.runId.length > 0 &&
        typeof approval.command === "string" &&
        approval.command.length > 0 &&
        hunkInputs.length === 0
      );
    }

    function renderApprovalSection(label, body, className) {
      const section = document.createElement("div");
      section.classList.add("approval-section", className);
      const sectionLabel = document.createElement("div");
      sectionLabel.className = "approval-section-label";
      sectionLabel.textContent = label;
      const sectionBody = document.createElement("div");
      sectionBody.className = "approval-section-body";
      sectionBody.textContent = body;
      section.append(sectionLabel, sectionBody);
      return section;
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
      const wasBusy = currentSubmission && currentSubmission.busy === true;
      const state = submission && typeof submission === "object" ? submission : initialSubmission;
      currentSubmission = state;
      const status = typeof state.status === "string" ? state.status : "idle";
      const busy = state.busy === true;
      const runId = typeof state.runId === "string" ? state.runId : "";
      const cancelable = busy && runId.length > 0 && state.canceling !== true;
      const canceling = state.canceling === true;
      setComposerBusy(busy, cancelable, runId, canceling);
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
      renderSteerConfirmation();
      if (status === "running" && wasBusy !== true) {
        clearPromptInput();
      }
      syncConversationChrome();
      syncWorkLogSummary();
      if (wasBusy === true && busy !== true) {
        pendingSteerConfirmation = "";
        render(currentSnapshot);
      }
    }

    function renderSteerConfirmation() {
      steerConfirmationRoot.replaceChildren();
      if (pendingSteerConfirmation.length === 0) {
        return;
      }

      const card = document.createElement("div");
      card.className = "steer-confirm";
      const text = document.createElement("div");
      text.className = "steer-confirm-text";
      text.textContent = pendingSteerConfirmation;
      text.title = pendingSteerConfirmation;

      const send = document.createElement("button");
      send.type = "button";
      send.className = "steer-confirm-send";
      send.textContent = "Send";
      send.addEventListener("click", () => {
        const message = pendingSteerConfirmation;
        sendConfirmedSteerMessage(message);
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "steer-confirm-delete";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => {
        pendingSteerConfirmation = "";
        renderSubmission(currentSubmission);
        promptInput.focus();
      });

      card.append(text, send, remove);
      steerConfirmationRoot.append(card);
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

    function setComposerBusy(busy, cancelable, runId, canceling) {
      promptInput.disabled = false;
      promptInput.placeholder = busy ? "Steer the current turn..." : "Ask ProleCoder";
      promptInput.title = busy ? "Steer the current turn without starting a new turn" : "";
      promptInput.setAttribute("aria-label", busy ? "Steer current turn" : "Chat message");
      modeInput.disabled = busy;
      // Run mode is inferred from message text; the legacy selector stays hidden to keep
      // the composer close to Codex's single-input UX.
      modeInput.hidden = true;
      sendButton.dataset.runId = cancelable === true ? runId : "";
      cancelButton.dataset.runId = cancelable === true ? runId : "";
      cancelButton.disabled = true;
      cancelButton.hidden = true;
      syncSendButtonMode();
      syncMessageEditButtons(busy);
    }

    function syncSendButtonMode() {
      const busy = currentSubmission && currentSubmission.busy === true;
      const canceling = currentSubmission && currentSubmission.canceling === true;
      const steerReady = busy && promptHasText();
      sendButton.disabled = busy && canceling === true;
      setSendIconVisible(sendSubmitIcon, busy !== true || steerReady);
      setSendIconVisible(sendStopIcon, busy === true && steerReady !== true);
      sendButton.title = busy
        ? steerReady ? "Send steer" : "Stop current turn"
        : "Send message";
      sendButton.setAttribute(
        "aria-label",
        busy ? steerReady ? "Send steer" : "Stop current turn" : "Send message",
      );
      sendButton.classList.toggle("stop", busy && steerReady !== true);
      sendButton.classList.toggle("steer-ready", steerReady);
    }

    function setSendIconVisible(icon, visible) {
      if (!icon) {
        return;
      }
      icon.toggleAttribute("hidden", visible !== true);
      icon.setAttribute("aria-hidden", "true");
    }

    function syncMessageEditButtons(disabled) {
      for (const button of document.querySelectorAll(".message-edit")) {
        button.disabled = disabled === true;
      }
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

    function syncSupersededUserItemsFromSnapshot(snapshot) {
      if (!snapshot || Array.isArray(snapshot.supersededItemIds) !== true) {
        return;
      }
      let changed = false;
      for (const id of snapshot.supersededItemIds) {
        if (typeof id === "string" && id.length > 0 && supersededUserItemIds.has(id) !== true) {
          supersededUserItemIds.add(id);
          changed = true;
        }
      }
      if (changed) {
        persistSupersededUserItems();
      }
    }

    function timelineVisibleItems(snapshot, items) {
      if (snapshot && Array.isArray(snapshot.visibleItems)) {
        return snapshot.visibleItems;
      }

      // Fallback only; chatEvents.presentTimelineItems is the authoritative grouping source.
      const hasAssistant = items.some((item) => item && item.kind === "assistant");
      return items.filter((item) => !isWorkLogItem(item, hasAssistant));
    }

    function visibleTimelineItems(snapshot, items) {
      return Array.from(timelineVisibleItems(snapshot, items)).filter(
        (item) => supersededUserItemIds.has(item.id) !== true,
      );
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
      const article = document.createElement("article");
      article.className = "item work-log neutral active-work-status";
      const meta = document.createElement("div");
      meta.className = "meta";
      const count = document.createElement("span");
      count.className = "seq";
      const latest = latestWorkItem(items);
      count.textContent = latest && typeof latest.seq === "number" ? "#" + latest.seq : items.length + " events";
      const latestType = document.createElement("span");
      latestType.className = "type";
      latestType.textContent = latest && typeof latest.type === "string" ? latest.type : "work";
      meta.append(count, latestType);

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = workLogTitle(items);
      article.append(meta, title);
      return article;
    }

    function shouldOpenWorkLog(items) {
      return currentSubmission && currentSubmission.busy === true && latestWorkItem(items) !== undefined;
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

    function renderWorkLogSegmentSummary(stats) {
      const row = document.createElement("div");
      row.className = "work-log-segment-summary";
      row.textContent =
        "Modified " +
        countWithNoun(stats.changedFileCount, "file", "files") +
        ", ran " +
        countWithNoun(stats.commandCount, "command", "commands") +
        ".";
      return row;
    }

    function countWithNoun(count, singular, plural) {
      const value = safeWorkLogCount(count);
      return value + " " + (value === 1 ? singular : plural);
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

    function workLogGroups(items) {
      const groups = [];
      const byId = new Map();
      for (const item of items) {
        const groupId =
          item && typeof item.workGroupId === "string" && item.workGroupId.length > 0
            ? item.workGroupId
            : "event:" + item.id;
        let group = byId.get(groupId);
        if (group === undefined) {
          group = {
            id: groupId,
            title:
              item && typeof item.workGroupTitle === "string" && item.workGroupTitle.length > 0
                ? item.workGroupTitle
                : item.title,
            items: [],
          };
          byId.set(groupId, group);
          groups.push(group);
        }
        group.items.push(item);
      }
      return groups;
    }

    function emptyWorkLogSegmentStats() {
      return {
        changedFileCount: 0,
        commandCount: 0,
      };
    }

    function addWorkLogSegmentStats(stats, group) {
      if (!group || !Array.isArray(group.items)) {
        return stats;
      }

      for (const item of group.items) {
        stats.changedFileCount += safeWorkLogCount(item && item.changedFileCount);
        stats.commandCount += safeWorkLogCount(item && item.commandCount);
      }
      return stats;
    }

    function hasWorkLogSegmentStats(stats) {
      return safeWorkLogCount(stats && stats.changedFileCount) > 0 || safeWorkLogCount(stats && stats.commandCount) > 0;
    }

    function safeWorkLogCount(value) {
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
    }

    function isProviderWorkLogGroup(group) {
      return Boolean(
        group &&
          Array.isArray(group.items) &&
          group.items.some(
            (item) =>
              item &&
              (item.kind === "provider" ||
                (typeof item.workGroupId === "string" && item.workGroupId.indexOf(":provider:") !== -1)),
          ),
      );
    }

    function renderWorkLogGroup(group, open) {
      if (!group || !Array.isArray(group.items) || group.items.length <= 1) {
        return renderWorkLogRow(group && Array.isArray(group.items) ? group.items[0] : {});
      }

      const details = document.createElement("details");
      details.className = "work-log-group";
      details.open = open === true;

      const summary = document.createElement("summary");
      summary.className = "work-log-group-summary";
      const title = document.createElement("span");
      title.className = "work-log-group-title";
      title.textContent = typeof group.title === "string" && group.title.length > 0 ? group.title : "Work group";
      const count = document.createElement("span");
      count.className = "work-log-group-count";
      count.textContent = group.items.length + " events";
      summary.append(title, count);
      details.append(summary);

      const body = document.createElement("div");
      body.className = "work-log-group-body";
      for (const item of group.items) {
        body.append(renderWorkLogRow(item));
      }
      details.append(body);
      return details;
    }

    function groupContainsItem(group, item) {
      if (!group || !Array.isArray(group.items) || !item) {
        return false;
      }
      return group.items.some((candidate) => candidate && candidate.id === item.id);
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
      const title = document.querySelector(".item.work-log .title");
      if (!title) {
        return;
      }

      const snapshot = currentSnapshot && typeof currentSnapshot === "object" ? currentSnapshot : initialSnapshot;
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      title.textContent = workLogTitle(timelineWorkItems(snapshot, items));
    }

    function renderItemSafely(item) {
      try {
        return renderItem(item);
      } catch (error) {
        const message = error && typeof error.message === "string" ? error.message : String(error);
        const stack = error && typeof error.stack === "string" ? error.stack : undefined;
        postWebviewError("Failed to render chat item: " + message, stack);
        return renderPlainItem(item);
      }
    }

    function renderPlainItem(item) {
      const article = document.createElement("article");
      const kind = item && typeof item.kind === "string" ? item.kind : "raw";
      const tone = item && typeof item.tone === "string" ? item.tone : "neutral";
      article.className = "item " + kind + " " + tone;

      const meta = document.createElement("div");
      meta.className = "meta";
      const seq = document.createElement("span");
      seq.className = "seq";
      const seqValue = item && typeof item.seq === "number" ? item.seq : 0;
      const lastSeqValue = item && typeof item.lastSeq === "number" ? item.lastSeq : seqValue;
      seq.textContent = seqValue === lastSeqValue ? "#" + seqValue : "#" + seqValue + "-" + lastSeqValue;
      const type = document.createElement("span");
      type.className = "type";
      type.textContent = item && typeof item.type === "string" ? item.type : "event";
      meta.append(seq, type);

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = item && typeof item.title === "string" ? item.title : "Message";
      const bodyText = itemBodyText(item);
      appendMessageHeader(article, meta, title, item, bodyText);
      if (bodyText.length > 0) {
        const body = document.createElement("div");
        body.className = "body";
        body.textContent = bodyText;
        article.append(body);
      }
      return article;
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
      const bodyText = itemBodyText(item);

      if (collapsed) {
        const summary = document.createElement("summary");
        summary.append(meta, title);
        article.append(summary);
      } else {
        appendMessageHeader(article, meta, title, item, bodyText);
      }
      if (bodyText.length > 0) {
        const body = document.createElement("div");
        if (shouldRenderMarkdown(item)) {
          body.className = "body markdown";
          appendMarkdownBlocks(body, bodyText);
        } else {
          body.className = "body";
          body.textContent = bodyText;
        }
        article.append(body);
      }
      const children = itemChildren(item);
      if (children.length > 0) {
        const childRoot = document.createElement("div");
        childRoot.className = "item-children";
        for (const child of children) {
          childRoot.append(renderItemSafely(child));
        }
        article.append(childRoot);
      }

      return article;
    }

    function appendMessageHeader(container, meta, title, item, bodyText) {
      if (!isEditableUserItem(item, bodyText)) {
        container.append(meta, title);
        return;
      }

      const heading = document.createElement("div");
      heading.className = "message-heading";
      heading.append(title, renderMessageEditButton(item, bodyText));
      container.append(meta, heading);
    }

    function isEditableUserItem(item, bodyText) {
      return item && typeof item === "object" && item.kind === "user" && item.type !== "turn.steerPending" && bodyText.length > 0;
    }

    function renderMessageEditButton(item, message) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "message-edit";
      button.title = "Edit and resend message";
      button.setAttribute("aria-label", "Edit and resend message");
      button.append(renderPenIcon());
      button.disabled = currentSubmission && currentSubmission.busy === true;
      button.addEventListener("click", () => {
        editComposerMessage(item, message);
      });
      return button;
    }

    function renderPenIcon() {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "message-edit-icon");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M4 20h4.5L19 9.5 14.5 5 4 15.5V20Z");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.8");
      path.setAttribute("stroke-linejoin", "round");
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      line.setAttribute("d", "m13.5 6 4.5 4.5M4 20h16");
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "currentColor");
      line.setAttribute("stroke-width", "1.8");
      line.setAttribute("stroke-linecap", "round");
      svg.append(path, line);
      return svg;
    }

    function editComposerMessage(item, message) {
      if (currentSubmission && currentSubmission.busy === true) {
        return;
      }

      editingMessageId = item && typeof item.id === "string" ? item.id : "";
      editingMessageTurnId = item && typeof item.turnId === "string" ? item.turnId : "";
      promptInput.disabled = false;
      promptInput.value = message;
      promptInput.dispatchEvent(new Event("input", { bubbles: true }));
      promptInput.focus();
      if (typeof promptInput.setSelectionRange === "function") {
        const end = promptInput.value.length;
        promptInput.setSelectionRange(end, end);
      }
    }

    function itemBodyText(item) {
      if (!item || typeof item !== "object" || item.body === undefined || item.body === null) {
        return "";
      }
      return typeof item.body === "string" ? item.body : String(item.body);
    }

    function itemChildren(item) {
      return item && typeof item === "object" && Array.isArray(item.children)
        ? item.children.filter((child) => child && typeof child === "object")
        : [];
    }

    function shouldRenderMarkdown(item) {
      if (!item || typeof item !== "object") {
        return false;
      }
      if (item.kind === "assistant" && currentSubmission && currentSubmission.busy === true) {
        return false;
      }
      if (item.kind === "assistant" || item.kind === "user") {
        return true;
      }
      return item.kind === "terminal" && item.type === "run.completed";
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
          isComposing: action.isComposing === true,
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
        userMessages: textContents("#events > .item.user .body"),
        markdownBlockCount: document.querySelectorAll("#events > .item:not(.work-log) .body.markdown").length,
        markdownCodeBlocks: textContents("#events > .item:not(.work-log) .body.markdown pre code"),
        markdownInlineCodes: textContents("#events > .item:not(.work-log) .body.markdown code:not(pre code)"),
        markdownLinks: textAttributes("#events > .item:not(.work-log) .body.markdown a", "href"),
        markdownTables: document.querySelectorAll("#events > .item:not(.work-log) .body.markdown table").length,
        markdownHorizontalRules: document.querySelectorAll("#events > .item:not(.work-log) .body.markdown hr").length,
        markdownText: textContents("#events > .item:not(.work-log) .body.markdown").join("\\n"),
        workLogVisible: workLog !== null,
        workLogOpen: workLog && "open" in workLog ? workLog.open === true : false,
        workLogTitle: workLogSummary ? workLogSummary.textContent || "" : "",
        workLogTypes: textContents(".work-log-row-meta span:last-child"),
        workLogSegmentSummaries: textContents(".work-log-segment-summary"),
        workLogGroupOpen: Array.from(document.querySelectorAll(".work-log-group")).map((element) =>
          "open" in element ? element.open === true : false,
        ),
        promptValue: promptInput.value,
        promptPlaceholder: promptInput.getAttribute("placeholder") || "",
        promptTitle: promptInput.title || "",
        promptAriaLabel: promptInput.getAttribute("aria-label") || "",
        sendLabel: sendButton.getAttribute("aria-label") || "",
        sendTitle: sendButton.title || "",
        sendIsStop: sendButton.classList.contains("stop"),
        sendVisibleIcons: Array.from(document.querySelectorAll(".send-icon"))
          .filter((element) => !isDisplayNone(element))
          .map((element) => element.classList.contains("send-icon-stop") ? "stop" : "submit"),
        sendDisabled: sendButton.disabled,
        steerConfirmVisible: document.querySelector(".steer-confirm") !== null,
        steerConfirmText: textContent(".steer-confirm-text"),
        steerConfirmActions: textContents(".steer-confirm button"),
        modeHidden: modeInput.hidden === true,
        cancelDisabled: cancelButton.disabled,
        messageEditButtons: textContents(".message-edit"),
        messageEditLabels: textAttributes(".message-edit", "aria-label"),
        messageEditDisabled: Array.from(document.querySelectorAll(".message-edit")).map((element) => element.disabled === true),
        supersededUserItemIds: Array.from(supersededUserItemIds),
        providerActions: Array.from(document.querySelectorAll(".provider-action")).map((element) => element.getAttribute("aria-label") || ""),
        settingsActionVisible: document.querySelector(".settings-action") !== null,
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
  if (!isCancelTurnMessage(message)) {
    return undefined;
  }

  const runId = message["runId"];
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

function isCancelTurnMessage(message: unknown): message is Record<string, unknown> {
  return isRecord(message) && message["type"] === "cancelTurn";
}

function steerTurnMessageFromWebviewMessage(message: unknown): SteerParams | undefined {
  if (!isRecord(message) || message["type"] !== "steerTurn") {
    return undefined;
  }

  const runId = message["runId"];
  const steerMessage = message["message"];
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    typeof steerMessage !== "string" ||
    steerMessage.trim().length === 0
  ) {
    return undefined;
  }

  return {
    runId,
    message: steerMessage.trim(),
  };
}

function isConversationApprovalMessage(message: unknown, request: ApprovalPromptRequest): boolean {
  return (
    isRecord(message) &&
    message["type"] === "approvalDecision" &&
    message["approvalId"] === request.approvalId &&
    message["decision"] === "approve" &&
    message["persist"] === "conversation"
  );
}

function conversationApprovalGrantKey(request: ApprovalPromptRequest): string | undefined {
  if (request.toolName !== "shell" || request.command === undefined || request.command.trim().length === 0) {
    return undefined;
  }
  const cwd = request.cwd === undefined || request.cwd.trim().length === 0 ? "." : request.cwd.trim();
  return `${cwd}\n${request.command.trim()}`;
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

function isLoadEarlierTimelineMessage(message: unknown): boolean {
  return isRecord(message) && message["type"] === "loadEarlierTimeline";
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

function webviewErrorFromMessage(message: unknown): WebviewErrorMessage | undefined {
  if (!isRecord(message) || message["type"] !== "webviewError") {
    return undefined;
  }

  const errorMessage = message["message"];
  if (typeof errorMessage !== "string" || errorMessage.length === 0) {
    return undefined;
  }

  return {
    type: "webviewError",
    message: errorMessage,
    ...(typeof message["stack"] === "string" ? { stack: message["stack"] } : {}),
  };
}

function isWebviewReadyMessage(message: unknown): message is WebviewReadyMessage {
  return isRecord(message) && message["type"] === "webviewReady";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
