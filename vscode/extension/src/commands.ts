export const OPEN_CHAT_COMMAND = "prole-coder.openChat";
export const OPEN_SETTINGS_COMMAND = "prole-coder.openSettings";
export const OPEN_CHAT_NO_WORKSPACE_MESSAGE =
  "Open a trusted workspace before starting the prole-coder RPC server.";
export const APPROVAL_APPROVE_LABEL = "Approve";
export const APPROVAL_APPROVE_SELECTED_HUNKS_LABEL = "Select Hunks";
export const APPROVAL_REJECT_LABEL = "Reject";
export const APPROVAL_DISMISSED_REASON = "approval prompt dismissed";
export const APPROVAL_REJECTED_REASON = "rejected in VS Code";

export interface CommandRegistry {
  registerCommand(command: string, callback: () => unknown): DisposableLike;
}

export interface WindowMessenger {
  showInformationMessage(message: string): unknown;
  showWarningMessage?(message: string): unknown;
}

export interface RpcServerStarter {
  readonly status: string;
  start(): Promise<{
    readonly server: {
      readonly name: string;
      readonly version: string;
    };
  }>;
}

export interface SettingsRpcServer {
  readonly status: string;
  readonly launchConfig: {
    readonly command: string;
    readonly args: readonly string[];
    readonly autoStart: boolean;
  };
  start(): Promise<{
    readonly server: {
      readonly name: string;
      readonly version: string;
    };
    readonly capabilities: {
      readonly supportsPersistentApprovals: boolean;
      readonly provider: {
        readonly provider: string;
        readonly defaultModel: string;
        readonly models: ReadonlyArray<{
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
        }>;
      };
    };
    readonly stateDir: string;
  }>;
}

export interface SettingsWindowMessenger extends WindowMessenger {
  openSettings?(query: string): unknown;
}

export interface ChatViewOpener {
  openChatView(): unknown;
}

export interface ApprovalWindowMessenger {
  showWarningMessage(
    message: string,
    options: { modal: true },
    ...items: string[]
  ): string | undefined | PromiseLike<string | undefined>;
  showQuickPick?(
    items: readonly ApprovalHunkQuickPickItem[],
    options: { canPickMany: true; placeHolder: string },
  ):
    | readonly ApprovalHunkQuickPickItem[]
    | undefined
    | PromiseLike<readonly ApprovalHunkQuickPickItem[] | undefined>;
}

export interface DisposableLike {
  dispose(): unknown;
}

export type ApprovalPersistence = "never" | "session" | "workspace";

export interface ApprovalPromptRequest {
  readonly approvalId: string;
  readonly runId?: string;
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
  readonly hunks?: readonly ApprovalPromptHunk[];
  readonly riskReasons?: readonly string[];
}

export interface ApprovalPromptHunk {
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

export interface ApprovalHunkQuickPickItem {
  readonly label: string;
  readonly description: string;
  readonly detail?: string;
  readonly hunkId: string;
}

export type ApprovalPromptDecision =
  | {
      readonly kind: "approve";
      readonly approvalId: string;
      readonly persist: ApprovalPersistence;
      readonly hunks?: {
        readonly approved: readonly string[];
      };
    }
  | {
      readonly kind: "reject";
      readonly approvalId: string;
      readonly reason: string;
    };

export function registerOpenChatCommand(
  commands: CommandRegistry,
  window: WindowMessenger,
  rpcServer?: RpcServerStarter,
  chatView?: ChatViewOpener,
): DisposableLike {
  return commands.registerCommand(OPEN_CHAT_COMMAND, () => {
    chatView?.openChatView();

    if (rpcServer === undefined) {
      return window.showInformationMessage(OPEN_CHAT_NO_WORKSPACE_MESSAGE);
    }

    return rpcServer
      .start()
      .then(() => undefined)
      .catch((error: unknown) => {
        const message = `prole-coder RPC server failed to start: ${errorMessage(error)}`;
        if (window.showWarningMessage !== undefined) {
          return window.showWarningMessage(message);
        }

        return window.showInformationMessage(message);
      });
  });
}

export function registerOpenSettingsCommand(
  commands: CommandRegistry,
  window: SettingsWindowMessenger,
  rpcServer?: SettingsRpcServer,
): DisposableLike {
  return commands.registerCommand(OPEN_SETTINGS_COMMAND, async () => {
    window.openSettings?.("@ext:prole-coder.prole-coder-vscode");

    if (rpcServer === undefined) {
      return window.showInformationMessage(OPEN_CHAT_NO_WORKSPACE_MESSAGE);
    }

    try {
      const ready = await rpcServer.start();
      return window.showInformationMessage(formatSettingsSummary(rpcServer.launchConfig, ready));
    } catch (error) {
      const message = `prole-coder settings opened, but RPC capabilities are unavailable: ${errorMessage(error)}`;
      if (window.showWarningMessage !== undefined) {
        return window.showWarningMessage(message);
      }
      return window.showInformationMessage(message);
    }
  });
}

export function formatSettingsSummary(
  launch: SettingsRpcServer["launchConfig"],
  ready: Awaited<ReturnType<SettingsRpcServer["start"]>>,
): string {
  const provider = ready.capabilities.provider;
  const defaultModel =
    provider.models.find((model) => model.id === provider.defaultModel) ?? provider.models[0];
  const modelLabel =
    defaultModel === undefined
      ? provider.defaultModel
      : `${defaultModel.displayName ?? defaultModel.id} (${defaultModel.id})`;
  const featureSummary =
    defaultModel === undefined
      ? "capability data unavailable"
      : [
          defaultModel.supportsThinking ? "thinking" : "no-thinking",
          defaultModel.supportsToolCalls ? "tool-calls" : "no-tool-calls",
          defaultModel.supportsToolChoice ? "tool-choice" : "no-tool-choice",
          defaultModel.supportsFim ? "fim" : "no-fim",
          defaultModel.supportsStreaming ? "streaming" : "no-streaming",
          defaultModel.reportsCacheUsage ? "cache-usage" : "no-cache-usage",
        ].join(", ");
  const budgetSummary =
    defaultModel === undefined
      ? "capability data unavailable"
      : `${defaultModel.contextWindowTokens} context tokens, ${defaultModel.maxOutputTokens} max output tokens`;
  const approvalSummary = ready.capabilities.supportsPersistentApprovals
    ? "one-shot, session, and workspace approvals available"
    : "one-shot approvals only";

  return [
    `Provider: ${provider.provider}`,
    `Model: ${modelLabel}`,
    `Budget: ${budgetSummary}`,
    `Capabilities: ${featureSummary}`,
    `Approvals: ${approvalSummary}`,
    `RPC: ${launch.command} ${launch.args.join(" ")} (autoStart: ${launch.autoStart})`,
    `State: ${ready.stateDir}`,
    "API keys are read by the RPC server environment and are not stored in VS Code settings.",
  ].join("\n");
}

export async function requestApproval(
  window: ApprovalWindowMessenger,
  request: ApprovalPromptRequest,
): Promise<ApprovalPromptDecision> {
  const choices = approvalChoices(request);
  const selected = await window.showWarningMessage(
    formatApprovalMessage(request),
    { modal: true },
    ...choices,
  );

  if (selected === APPROVAL_APPROVE_LABEL) {
    return {
      kind: "approve",
      approvalId: request.approvalId,
      persist: "never",
    };
  }

  if (selected === APPROVAL_APPROVE_SELECTED_HUNKS_LABEL) {
    const hunks = await requestSelectedHunks(window, request);
    if (hunks.length > 0) {
      return {
        kind: "approve",
        approvalId: request.approvalId,
        persist: "never",
        hunks: {
          approved: hunks,
        },
      };
    }

    return {
      kind: "reject",
      approvalId: request.approvalId,
      reason: APPROVAL_DISMISSED_REASON,
    };
  }

  if (selected === APPROVAL_REJECT_LABEL) {
    return {
      kind: "reject",
      approvalId: request.approvalId,
      reason: APPROVAL_REJECTED_REASON,
    };
  }

  return {
    kind: "reject",
    approvalId: request.approvalId,
    reason: APPROVAL_DISMISSED_REASON,
  };
}

function approvalChoices(request: ApprovalPromptRequest): string[] {
  const hunkChoices =
    request.toolName === "apply_patch" && request.hunks !== undefined && request.hunks.length > 1
      ? [APPROVAL_APPROVE_SELECTED_HUNKS_LABEL]
      : [];

  return [APPROVAL_APPROVE_LABEL, ...hunkChoices, APPROVAL_REJECT_LABEL];
}

async function requestSelectedHunks(
  window: ApprovalWindowMessenger,
  request: ApprovalPromptRequest,
): Promise<readonly string[]> {
  const hunks = request.hunks ?? [];
  if (window.showQuickPick === undefined || hunks.length === 0) {
    return [];
  }

  const selected = await window.showQuickPick(
    hunks.map((hunk) => ({
      label: `${hunk.filePath} hunk ${hunk.hunkIndex + 1}`,
      description: `-${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount}`,
      ...(hunk.section === undefined ? {} : { detail: hunk.section }),
      hunkId: hunk.id,
    })),
    {
      canPickMany: true,
      placeHolder: "Select patch hunks to approve",
    },
  );

  return selected?.map((item) => item.hunkId) ?? [];
}

function formatApprovalMessage(request: ApprovalPromptRequest): string {
  const detail = [
    request.title,
    request.detail,
    `Tool: ${request.toolName}`,
    `Risk: ${request.risk}`,
  ];

  if (request.riskReasons !== undefined && request.riskReasons.length > 0) {
    detail.push(`Risk reasons: ${request.riskReasons.join(", ")}`);
  }

  if (request.command !== undefined) {
    detail.push(`Command: ${request.command}`);
  }

  if (request.cwd !== undefined) {
    detail.push(`Cwd: ${request.cwd}`);
  }

  if (request.paths !== undefined && request.paths.length > 0) {
    detail.push(`Paths: ${request.paths.join(", ")}`);
  }

  return detail.join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
