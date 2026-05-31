import * as vscode from "vscode";

import { buildFimPreviewParams } from "./fimPreview";
import type { RpcServerManager } from "./rpcServer";

const DEFAULT_FIM_MAX_TOKENS = 128;
const DEFAULT_FIM_MAX_CONTEXT_CHARS = 12_000;

export function registerFimInlineCompletionProvider(rpcServer: RpcServerManager): vscode.Disposable {
  return vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    new ProleFimInlineCompletionProvider(rpcServer),
  );
}

class ProleFimInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly rpcServer: RpcServerManager) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const config = vscode.workspace.getConfiguration("prole-coder.fim");
    if (!config.get("enabled", true) || this.rpcServer.status !== "ready") {
      return [];
    }

    const ready = await this.rpcServer.start();
    if (token.isCancellationRequested) {
      return [];
    }

    const params = buildFimPreviewParams({
      text: document.getText(),
      offset: document.offsetAt(position),
      languageId: document.languageId,
      configuredModel: config.get("model", ""),
      maxTokens: config.get("maxTokens", DEFAULT_FIM_MAX_TOKENS),
      maxContextChars: config.get("maxContextChars", DEFAULT_FIM_MAX_CONTEXT_CHARS),
      capabilities: ready.capabilities,
      ...(document.uri.scheme === "file" ? { path: document.uri.fsPath } : {}),
    });
    if (params === undefined) {
      return [];
    }

    const result = await this.rpcServer.previewFim(params).catch(() => undefined);
    if (result === undefined) {
      return [];
    }
    if (token.isCancellationRequested || result.text.length === 0) {
      return [];
    }

    return [new vscode.InlineCompletionItem(result.text)];
  }
}
