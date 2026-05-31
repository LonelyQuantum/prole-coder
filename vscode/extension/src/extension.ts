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
import { createOutputLogger, type ProleLogger } from "./logging";
import { RpcServerManager, readRpcServerLaunchConfig } from "./rpcServer";

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const outputChannel = vscode.window.createOutputChannel("ProleCoder");
  const logger = createOutputLogger(outputChannel);
  const notifier = createExtensionNotifier(logger);
  context.subscriptions.push(outputChannel);

  const rpcServer = createRpcServerManager(context, notifier);
  const chatView = new ProleChatViewProvider(context.extensionUri, rpcServer, workspaceRoot, logger);
  const chatParticipant = registerProleChatParticipant(context, rpcServer, workspaceRoot, logger);
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

  context.subscriptions.push(openChat, openSettings, chatView, chatViewRegistration, chatParticipant);
  registerTestCommands(context, chatView);
  if (rpcServer !== undefined && workspaceRoot !== undefined) {
    const patchDiffPreviewController = createPatchDiffPreviewController(context, rpcServer, workspaceRoot);
    const approvalController = new ApprovalEventController(
      rpcServer,
      vscode.window,
      notifier,
      testApprovalRequester(context),
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
    notifier,
  });
}

interface ExtensionNotifier {
  info(message: string): unknown;
  warn(message: string): unknown;
  error(message: string): unknown;
}

function createExtensionNotifier(logger: ProleLogger): ExtensionNotifier {
  return {
    info(message) {
      logger.info(message);
      return vscode.window.showInformationMessage(message);
    },
    warn(message) {
      logger.warn(message);
      return vscode.window.showWarningMessage(message);
    },
    error(message) {
      logger.error(message);
      return vscode.window.showWarningMessage(message);
    },
  };
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
