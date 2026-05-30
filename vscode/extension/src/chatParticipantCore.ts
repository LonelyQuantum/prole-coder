import type {
  CancelResult,
  RpcRunMode,
  SendTurnParams,
  SendTurnResult,
  TurnAttachment,
} from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

import {
  isAutomaticContextAttachment,
  type ConversationContextMessage,
} from "./automaticContext";
import { DEFAULT_CHAT_MODE, sendTurnParams } from "./chatInput";
import type { AgentEventEnvelope, DisposableLike } from "./rpcServer";

export const CHAT_PARTICIPANT_ID = "prole-coder.chatParticipant";
export const CHAT_PARTICIPANT_NAME = "prole";

export interface ChatParticipantRpcClient {
  onEvent(handler: (event: AgentEventEnvelope) => void): DisposableLike;
  sendTurn(params: SendTurnParams): Promise<SendTurnResult>;
  cancel(params: { readonly runId: string; readonly reason?: string }): Promise<CancelResult>;
}

export interface ChatParticipantResponseStream {
  markdown(value: string): void;
  progress(value: string): void;
}

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => unknown): DisposableLike;
}

export interface ChatParticipantResult {
  readonly errorDetails?: {
    readonly message: string;
  };
  readonly metadata?: {
    readonly [key: string]: unknown;
  };
}

export interface ChatParticipantTurnRequest {
  readonly prompt: string;
  readonly command?: string;
  readonly attachments?: readonly TurnAttachment[];
}

export interface ChatParticipantTurnOptions {
  readonly rpcClient?: ChatParticipantRpcClient;
  readonly request: ChatParticipantTurnRequest;
  readonly response: ChatParticipantResponseStream;
  readonly token?: CancellationTokenLike;
}

export function modeFromChatCommand(command: string | undefined): RpcRunMode {
  switch (command) {
    case "ask":
    case "edit":
    case "plan":
    case "review":
      return command;
    default:
      return DEFAULT_CHAT_MODE;
  }
}

export async function runChatParticipantTurn(
  options: ChatParticipantTurnOptions,
): Promise<ChatParticipantResult> {
  const prompt = options.request.prompt.trim();
  if (prompt.length === 0) {
    return errorResult("Enter a message before sending.");
  }

  if (options.rpcClient === undefined) {
    return errorResult("Open a trusted workspace before chatting with ProleCoder.");
  }

  if (options.token?.isCancellationRequested === true) {
    return canceledResult();
  }

  const params = sendTurnParams(
    {
      message: prompt,
      mode: modeFromChatCommand(options.request.command),
    },
    options.request.attachments ?? [],
  );
  if (params.attachments?.some(isAutomaticContextAttachment) === true) {
    options.response.progress("Conversation context compacted.");
  }

  let runId: string | undefined;
  let terminalResult: ChatParticipantResult | undefined;
  let resolveTerminal: ((result: ChatParticipantResult) => void) | undefined;
  const cancellationState = { requested: false };
  const bufferedEvents: AgentEventEnvelope[] = [];
  const terminalPromise = new Promise<ChatParticipantResult>((resolve) => {
    resolveTerminal = resolve;
  });

  const eventSubscription = options.rpcClient.onEvent((event) => {
    if (runId === undefined) {
      bufferedEvents.push(event);
      return;
    }
    if (event.runId !== runId) {
      return;
    }

    handleParticipantEvent(event, options.response, finish);
  });
  const cancellationSubscription = options.token?.onCancellationRequested(() => {
    cancellationState.requested = true;
    if (runId !== undefined) {
      void options.rpcClient?.cancel({
        runId,
        reason: "canceled in VS Code Chat",
      });
      finish(canceledResult(runId));
    }
  });

  try {
    const result = await options.rpcClient.sendTurn(params);
    runId = result.runId;
    options.response.progress(`Run ${shortId(runId)} started.`);

    for (const event of bufferedEvents) {
      if (event.runId === runId) {
        handleParticipantEvent(event, options.response, finish);
      }
    }

    if (terminalResult !== undefined) {
      return terminalResult;
    }

    if (cancellationState.requested) {
      await options.rpcClient.cancel({
        runId,
        reason: "canceled in VS Code Chat",
      });
      return canceledResult(runId);
    }

    return await terminalPromise;
  } catch (error) {
    return errorResult(`ProleCoder turn failed: ${errorMessage(error)}`, runId);
  } finally {
    eventSubscription.dispose();
    cancellationSubscription?.dispose();
  }

  function finish(result: ChatParticipantResult): void {
    if (terminalResult !== undefined) {
      return;
    }
    terminalResult = result;
    resolveTerminal?.(result);
  }
}

export function conversationMessagesFromPlainHistory(
  history: readonly { readonly role: ConversationContextMessage["role"]; readonly text: string }[],
): readonly ConversationContextMessage[] {
  return history.map((entry) => ({
    role: entry.role,
    text: entry.text,
  }));
}

function handleParticipantEvent(
  event: AgentEventEnvelope,
  response: ChatParticipantResponseStream,
  finish: (result: ChatParticipantResult) => void,
): void {
  const payload = record(event.payload);
  switch (event.type) {
    case "assistant.delta": {
      const text = textField(payload, "text") ?? textField(payload, "delta");
      if (text !== undefined) {
        response.markdown(text);
      }
      return;
    }
    case "context.built":
    case "tool.approvalRequired":
    case "tool.approvalResolved":
    case "tool.started":
    case "tool.completed": {
      const message = eventProgressMessage(event, payload);
      if (message !== undefined) {
        response.progress(message);
      }
      return;
    }
    case "run.completed":
      finish({
        metadata: {
          runId: event.runId,
          status: "completed",
        },
      });
      return;
    case "run.failed": {
      const message = terminalMessage(payload, "Run failed.");
      response.markdown(`\n\n${message}`);
      finish(errorResult(message, event.runId));
      return;
    }
    case "run.canceled": {
      const message = terminalMessage(payload, "Run canceled.");
      response.progress(message);
      finish(canceledResult(event.runId));
      return;
    }
  }
}

function eventProgressMessage(
  event: AgentEventEnvelope,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  switch (event.type) {
    case "context.built":
      return contextBuiltMessage(payload);
    case "tool.approvalRequired":
      return `Waiting for approval: ${textField(payload, "title") ?? textField(payload, "toolName") ?? "tool"}.`;
    case "tool.approvalResolved":
      return `Approval ${textField(payload, "decision") ?? "resolved"}.`;
    case "tool.started":
      return `Running ${textField(payload, "name") ?? textField(payload, "toolName") ?? "tool"}...`;
    case "tool.completed":
      return `${textField(payload, "name") ?? textField(payload, "toolName") ?? "Tool"} completed.`;
    default:
      return undefined;
  }
}

function contextBuiltMessage(payload: Record<string, unknown> | undefined): string {
  const inputTokens = numberField(payload, "inputTokens");
  const maxInputTokens = numberField(payload, "maxInputTokens");
  if (inputTokens !== undefined && maxInputTokens !== undefined) {
    return `Context ready: ${inputTokens.toLocaleString()} / ${maxInputTokens.toLocaleString()} tokens.`;
  }
  return "Context ready.";
}

function terminalMessage(payload: Record<string, unknown> | undefined, fallback: string): string {
  return (
    textField(payload, "message") ??
    textField(payload, "reason") ??
    textField(payload, "summary") ??
    fallback
  );
}

function errorResult(message: string, runId?: string): ChatParticipantResult {
  return {
    errorDetails: { message },
    metadata: {
      status: "failed",
      ...(runId === undefined ? {} : { runId }),
    },
  };
}

function canceledResult(runId?: string): ChatParticipantResult {
  return {
    metadata: {
      status: "canceled",
      ...(runId === undefined ? {} : { runId }),
    },
  };
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 12)}...`;
}

function textField(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(payload: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
