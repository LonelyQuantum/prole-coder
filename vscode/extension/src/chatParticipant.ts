import * as vscode from "vscode";

import type { TurnAttachment } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

import {
  automaticContextAttachmentFromMessages,
  mergeTurnAttachments,
  type ConversationContextMessage,
} from "./automaticContext";
import {
  CHAT_PARTICIPANT_ID,
  runChatParticipantTurn,
  type ChatParticipantRpcClient,
} from "./chatParticipantCore";
import { diagnosticAttachmentsFromProblems } from "./diagnostics";
import type { ProleLogger } from "./logging";

export function registerProleChatParticipant(
  context: vscode.ExtensionContext,
  rpcClient: ChatParticipantRpcClient | undefined,
  workspaceRoot: string | undefined,
  logger?: ProleLogger,
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(
    CHAT_PARTICIPANT_ID,
    (request, chatContext, response, token) => {
      const automaticContext = automaticContextAttachmentFromMessages(
        messagesFromChatHistory(chatContext.history),
      );
      const diagnostics = collectDiagnosticAttachments(workspaceRoot);
      const attachments = mergeTurnAttachments(automaticContext, diagnostics);
      return runChatParticipantTurn({
        ...(rpcClient === undefined ? {} : { rpcClient }),
        request: {
          prompt: request.prompt,
          ...(request.command === undefined ? {} : { command: request.command }),
          ...(attachments.length === 0 ? {} : { attachments }),
        },
        response,
        ...(logger === undefined ? {} : { logger }),
        token,
      });
    },
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "prole-coder-view.svg");
  return participant;
}

function collectDiagnosticAttachments(workspaceRoot: string | undefined): readonly TurnAttachment[] {
  if (workspaceRoot === undefined) {
    return [];
  }

  const problems = vscode.languages.getDiagnostics().map(([uri, diagnostics]) => ({
    uri: {
      fsPath: uri.fsPath,
    },
    diagnostics,
  }));

  return diagnosticAttachmentsFromProblems(problems, workspaceRoot);
}

function messagesFromChatHistory(
  history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[],
): readonly ConversationContextMessage[] {
  const messages: ConversationContextMessage[] = [];
  for (const turn of history) {
    if (isChatRequestTurn(turn)) {
      messages.push({ role: "user", text: turn.prompt });
    } else {
      const text = markdownTextFromResponse(turn.response);
      if (text.length > 0) {
        messages.push({ role: "assistant", text });
      }
    }
  }
  return messages;
}

function isChatRequestTurn(
  turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn,
): turn is vscode.ChatRequestTurn {
  return "prompt" in turn;
}

function markdownTextFromResponse(
  response: ReadonlyArray<
    | vscode.ChatResponseMarkdownPart
    | vscode.ChatResponseFileTreePart
    | vscode.ChatResponseAnchorPart
    | vscode.ChatResponseCommandButtonPart
  >,
): string {
  return response
    .map((part) => {
      const value = part.value;
      if (value instanceof vscode.MarkdownString) {
        return value.value;
      }
      if (isMarkdownStringLike(value)) {
        return value.value;
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function isMarkdownStringLike(value: unknown): value is { readonly value: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    typeof (value as { readonly value?: unknown }).value === "string"
  );
}
