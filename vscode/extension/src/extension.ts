import * as vscode from "vscode";

import { ApprovalEventController, type ApprovalRequester } from "./approvalFlow";
import { registerProleChatParticipant } from "./chatParticipant";
import { CHAT_VIEW_ID, ProleChatViewProvider } from "./chatView";
import {
  type ChatViewOpener,
  registerOpenChatCommand,
  registerOpenSettingsCommand,
} from "./commands";
import { createPatchDiffPreviewController } from "./diffPreview";
import { registerFimInlineCompletionProvider } from "./fimPreviewVscode";
import {
  GENERATE_COMMIT_MESSAGE_COMMAND,
  GENERATE_PR_DESCRIPTION_COMMAND,
  generateCommitMessage,
  generatePrDescription,
} from "./gitWorkflow";
import { createVscodeGitRepositoryProvider, createVscodeMarkdownSink } from "./gitWorkflowVscode";
import { createOutputLogger } from "./logging";
import { createExtensionNotifier, type ExtensionNotifier } from "./notifier";
import {
  registerProviderSecretCommands,
  type SecretQuickPickController,
  type SecretQuickPickItem,
} from "./providerSecretCommands";
import {
  DEEPSEEK_API_KEY_STORE_SECRET_ID,
  DEEPSEEK_API_KEY_SECRET_ID,
  deepSeekEnvOverride,
  providerSecretRedactionValues,
  resolveDeepSeekApiKey,
  resolveDeepSeekModel,
} from "./providerSecrets";
import { MutableSecretRedactor } from "./redaction";
import { RpcServerManager, readRpcServerLaunchConfig } from "./rpcServer";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const outputChannel = vscode.window.createOutputChannel("ProleCoder");
  const logger = createOutputLogger(outputChannel);
  const secretRedactor = new MutableSecretRedactor();
  const initialSecretStatus = resolveDeepSeekApiKey({
    secretValue: await context.secrets.get(DEEPSEEK_API_KEY_SECRET_ID),
    keyStoreValue: await context.secrets.get(DEEPSEEK_API_KEY_STORE_SECRET_ID),
    processEnv: process.env,
  });
  const providerConfiguration = vscode.workspace.getConfiguration("prole-coder.provider");
  const configuredModel = providerConfiguration.get<unknown>("model", "");
  const initialModelId = resolveDeepSeekModel({
    configuredModel: typeof configuredModel === "string" ? configuredModel : "",
    processEnv: process.env,
  });
  secretRedactor.update(providerSecretRedactionValues(initialSecretStatus));
  const notifier = createExtensionNotifier(logger, vscode.window, secretRedactor);
  context.subscriptions.push(outputChannel);

  const rpcServer = createRpcServerManager(context, notifier, deepSeekEnvOverride(initialSecretStatus, initialModelId));
  const chatView = new ProleChatViewProvider(context.extensionUri, rpcServer, workspaceRoot, logger, secretRedactor);
  const chatParticipant = registerProleChatParticipant(context, rpcServer, workspaceRoot, logger, secretRedactor);
  const openChat = registerOpenChatCommand(
    vscode.commands,
    vscode.window,
    rpcServer,
    nativeChatOpener(chatView),
  );
  const openSettings = registerOpenSettingsCommand(
    vscode.commands,
    {
      showInformationMessage(message) {
        return notifier.info(message);
      },
      showWarningMessage(message) {
        return notifier.warn(message);
      },
      openSettings(query) {
        return vscode.commands.executeCommand("workbench.action.openSettings", query);
      },
    },
    rpcServer,
  );
  const chatViewRegistration = vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chatView, {
    webviewOptions: {
      retainContextWhenHidden: true,
    },
  });
  const secretWindow = {
    showInputBox: vscode.window.showInputBox.bind(vscode.window),
    showQuickPick: vscode.window.showQuickPick.bind(vscode.window),
    createQuickPick: <T extends SecretQuickPickItem>(): SecretQuickPickController<T> =>
      vscode.window.createQuickPick<vscode.QuickPickItem>() as unknown as SecretQuickPickController<T>,
    showInformationMessage: vscode.window.showInformationMessage.bind(vscode.window),
    showWarningMessage: vscode.window.showWarningMessage.bind(vscode.window),
  };
  const providerSecretCommands = registerProviderSecretCommands({
    commands: vscode.commands,
    window: secretWindow,
    secrets: context.secrets,
    processEnv: process.env,
    redactor: secretRedactor,
    rpcServer,
    isRpcIdle: () => chatView.isIdle(),
    providerConfiguration,
    configurationTarget: vscode.ConfigurationTarget.Global,
    renameAliasButton: {
      iconPath: new vscode.ThemeIcon("edit"),
      tooltip: "Rename alias",
    },
    deleteKeyButton: {
      iconPath: new vscode.ThemeIcon("trash"),
      tooltip: "Delete key",
    },
  });
  const gitRepositoryProvider = createVscodeGitRepositoryProvider();
  const markdownSink = createVscodeMarkdownSink();
  const gitWorkflowCommands = [
    vscode.commands.registerCommand(GENERATE_COMMIT_MESSAGE_COMMAND, () =>
      generateCommitMessage({
        repositories: gitRepositoryProvider,
        window: vscode.window,
        agent: rpcServer,
        redactor: secretRedactor,
      }),
    ),
    vscode.commands.registerCommand(GENERATE_PR_DESCRIPTION_COMMAND, () =>
      generatePrDescription({
        repositories: gitRepositoryProvider,
        window: vscode.window,
        agent: rpcServer,
        markdownSink,
        redactor: secretRedactor,
      }),
    ),
  ];

  context.subscriptions.push(
    openChat,
    openSettings,
    chatView,
    chatViewRegistration,
    chatParticipant,
    ...providerSecretCommands,
    ...gitWorkflowCommands,
  );
  registerTestCommands(context, chatView);
  if (rpcServer !== undefined && workspaceRoot !== undefined) {
    const patchDiffPreviewController = createPatchDiffPreviewController(context, rpcServer, workspaceRoot);
    const approvalRequester = testApprovalRequester(context) ?? inlineChatApprovalRequester(chatView);
    const approvalController = new ApprovalEventController(
      rpcServer,
      vscode.window,
      notifier,
      approvalRequester,
      patchDiffPreviewController,
    );
    context.subscriptions.push(patchDiffPreviewController, approvalController);
    context.subscriptions.push(registerFimInlineCompletionProvider(rpcServer));
    context.subscriptions.push(rpcServer);
    if (rpcServer.autoStart) {
      void rpcServer.start().catch((error: unknown) => {
        const message = `prole-coder RPC server failed to start: ${errorMessage(error)}`;
        void notifier.error(message);
      });
    }
  }
}

export function deactivate(): void {
  // VS Code disposes context subscriptions, including the RPC server manager.
}

function createRpcServerManager(
  context: vscode.ExtensionContext,
  notifier: ExtensionNotifier,
  processEnv: Record<string, string | undefined>,
): RpcServerManager | undefined {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot === undefined) {
    return undefined;
  }

  return new RpcServerManager({
    launch: readRpcServerLaunchConfig(vscode.workspace.getConfiguration("prole-coder.rpc")),
    workspace: {
      root: workspaceRoot,
      trusted: vscode.workspace.isTrusted,
    },
    extensionVersion: extensionVersion(context),
    processEnv,
    notifier,
  });
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const packageJson = context.extension.packageJSON as { version?: unknown };
  return typeof packageJson.version === "string" ? packageJson.version : "0.1.0";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nativeChatOpener(fallback: ChatViewOpener): ChatViewOpener {
  return {
    async openChatView() {
      try {
        return await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: "@prole ",
          isPartialQuery: true,
        });
      } catch {
        return fallback.openChatView();
      }
    },
  };
}

function registerTestCommands(context: vscode.ExtensionContext, chatView: ProleChatViewProvider): void {
  if (context.extensionMode !== vscode.ExtensionMode.Test || process.env["PROLE_CODER_VSCODE_TEST"] !== "1") {
    return;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("prole-coder.test.chatMessage", (message: unknown) =>
      chatView.testHandleWebviewMessage(message),
    ),
    vscode.commands.registerCommand("prole-coder.test.chatState", () => chatView.testState()),
  );
}

function testApprovalRequester(context: vscode.ExtensionContext): ApprovalRequester | undefined {
  if (
    context.extensionMode !== vscode.ExtensionMode.Test ||
    process.env["PROLE_CODER_VSCODE_TEST_AUTO_APPROVE"] !== "1"
  ) {
    return undefined;
  }

  return async (_window, request) => ({
    kind: "approve",
    approvalId: request.approvalId,
    persist: "never",
  });
}

function inlineChatApprovalRequester(chatView: ProleChatViewProvider): ApprovalRequester {
  return (_window, request) => chatView.requestApproval(request);
}
