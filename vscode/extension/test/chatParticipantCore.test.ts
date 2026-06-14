import assert from "node:assert/strict";
import test from "node:test";

import type { SendTurnParams, SendTurnResult } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

import { automaticContextAttachmentFromMessages } from "../src/automaticContext.js";
import {
  modeFromChatCommand,
  runChatParticipantTurn,
  type ChatParticipantRpcClient,
  type ChatParticipantResponseStream,
} from "../src/chatParticipantCore.js";
import type { AgentEventEnvelope, DisposableLike } from "../src/rpcServer.js";

test("modeFromChatCommand maps known commands and defaults to edit", () => {
  assert.equal(modeFromChatCommand("ask"), "ask");
  assert.equal(modeFromChatCommand("plan"), "plan");
  assert.equal(modeFromChatCommand("review"), "review");
  assert.equal(modeFromChatCommand("missing"), "edit");
  assert.equal(modeFromChatCommand(undefined), "edit");
});

test("runChatParticipantTurn sends a real turn and streams matching run events", async () => {
  const rpc = new FakeChatParticipantRpcClient();
  const response = new FakeChatResponseStream();
  const result = await runChatParticipantTurn({
    rpcClient: rpc,
    request: {
      prompt: "please edit",
      command: "review",
      attachments: [
        {
          kind: "diagnostic",
          path: "src/lib.rs",
          range: {
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 5,
          },
          text: "error",
        },
      ],
    },
    response,
  });

  assert.deepEqual(rpc.sendTurns[0], {
    message: "please edit",
    mode: "review",
    attachments: [
      {
        kind: "diagnostic",
        path: "src/lib.rs",
        range: {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 5,
        },
        text: "error",
      },
    ],
  } satisfies SendTurnParams);
  assert.equal(response.markdownParts.join(""), "hello");
  assert.ok(response.progressParts.some((part) => part.includes("Context ready")));
  assert.deepEqual(result.metadata, {
    runId: "run_chat_1",
    status: "completed",
  });
});

test("runChatParticipantTurn reports automatic context compaction", async () => {
  const rpc = new FakeChatParticipantRpcClient();
  const response = new FakeChatResponseStream();
  const automaticContext = automaticContextAttachmentFromMessages([
    { role: "user", text: "previous request" },
  ]);
  assert.ok(automaticContext);

  await runChatParticipantTurn({
    rpcClient: rpc,
    request: {
      prompt: "continue",
      attachments: [automaticContext],
    },
    response,
  });

  assert.ok(response.progressParts.some((part) => part.includes("compacted")));
  assert.equal(rpc.sendTurns[0]?.attachments?.[0], automaticContext);
});

test("runChatParticipantTurn handles terminal events buffered before sendTurn returns", async () => {
  const rpc = new EarlyTerminalChatParticipantRpcClient();
  const response = new FakeChatResponseStream();
  const result = await withTimeout(
    runChatParticipantTurn({
      rpcClient: rpc,
      request: {
        prompt: "finish quickly",
      },
      response,
    }),
  );

  assert.equal(response.markdownParts.join(""), "early");
  assert.deepEqual(result.metadata, {
    runId: "run_chat_1",
    status: "completed",
  });
});

test("runChatParticipantTurn preserves run failed recovery actions", async () => {
  const rpc = new FailedRecoveryChatParticipantRpcClient();
  const response = new FakeChatResponseStream();
  const result = await withTimeout(
    runChatParticipantTurn({
      rpcClient: rpc,
      request: {
        prompt: "hello",
      },
      response,
    }),
  );

  assert.equal(response.markdownParts.join(""), "\n\nMissing DeepSeek API key.");
  assert.deepEqual(result.metadata?.["providerConfigurationAction"], {
    type: "configureDeepSeekApiKey",
    label: "Configure API Key",
  });
});

test("runChatParticipantTurn logs RPC failures before returning chat errors", async () => {
  const rpc = new RejectingChatParticipantRpcClient(
    new StructuredRpcRequestError(
      "DeepSeek provider configuration failed: DEEPSEEK_API_KEY is required",
      {
        provider: "deepseek",
        configurationError: "missingApiKey",
        recoverableAction: {
          kind: "configureDeepSeekApiKey",
          label: "Configure API Key",
        },
      },
    ),
  );
  const response = new FakeChatResponseStream();
  const logger = new FakeLogger();
  const result = await runChatParticipantTurn({
    rpcClient: rpc,
    request: {
      prompt: "hello",
    },
    response,
    logger,
  });

  assert.ok(result.errorDetails?.message.includes("DEEPSEEK_API_KEY is required"));
  assert.deepEqual(result.metadata?.["providerConfigurationAction"], {
    type: "configureDeepSeekApiKey",
    label: "Configure API Key",
  });
  assert.deepEqual(logger.errors, [result.errorDetails?.message]);
});

test("runChatParticipantTurn returns chat errors without an RPC client", async () => {
  const response = new FakeChatResponseStream();
  const result = await runChatParticipantTurn({
    request: {
      prompt: "hello",
    },
    response,
  });

  assert.ok(result.errorDetails?.message.includes("trusted workspace"));
});

class FakeChatParticipantRpcClient implements ChatParticipantRpcClient {
  readonly sendTurns: SendTurnParams[] = [];
  private readonly handlers = new Set<(event: AgentEventEnvelope) => void>();

  onEvent(handler: (event: AgentEventEnvelope) => void): DisposableLike {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  async sendTurn(params: SendTurnParams) {
    this.sendTurns.push(params);
    queueMicrotask(() => {
      this.emit(agentEvent(1, "context.built", { inputTokens: 12, maxInputTokens: 100 }));
      this.emit(agentEvent(2, "assistant.delta", { text: "hello" }));
      this.emit(agentEvent(3, "run.completed", { summary: "done" }));
    });
    return {
      runId: "run_chat_1",
      turnId: "turn_chat_1",
      accepted: true as const,
    };
  }

  async cancel(params: { readonly runId: string; readonly reason?: string }) {
    return {
      runId: params.runId,
      state: "canceled" as const,
      ...(params.reason === undefined ? {} : { reason: params.reason }),
    };
  }

  protected emit(event: AgentEventEnvelope): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

class EarlyTerminalChatParticipantRpcClient extends FakeChatParticipantRpcClient {
  override async sendTurn(params: SendTurnParams): Promise<SendTurnResult> {
    this.sendTurns.push(params);
    this.emit(agentEvent(1, "assistant.delta", { text: "early" }));
    this.emit(agentEvent(2, "run.completed", { summary: "done" }));
    return {
      runId: "run_chat_1",
      turnId: "turn_chat_1",
      accepted: true as const,
    };
  }
}

class FailedRecoveryChatParticipantRpcClient extends FakeChatParticipantRpcClient {
  override async sendTurn(params: SendTurnParams): Promise<SendTurnResult> {
    this.sendTurns.push(params);
    queueMicrotask(() => {
      this.emit(agentEvent(1, "run.failed", {
        code: "E_PROVIDER_ERROR",
        message: "Missing DeepSeek API key.",
        recoverableAction: {
          kind: "configureDeepSeekApiKey",
          label: "Configure API Key",
        },
      }));
    });
    return {
      runId: "run_chat_1",
      turnId: "turn_chat_1",
      accepted: true as const,
    };
  }
}

class RejectingChatParticipantRpcClient extends FakeChatParticipantRpcClient {
  constructor(private readonly error: Error) {
    super();
  }

  override async sendTurn(params: SendTurnParams): Promise<SendTurnResult> {
    this.sendTurns.push(params);
    throw this.error;
  }
}

class StructuredRpcRequestError extends Error {
  constructor(message: string, readonly data: unknown) {
    super(message);
    this.name = "RpcRequestError";
  }
}

class FakeChatResponseStream implements ChatParticipantResponseStream {
  readonly markdownParts: string[] = [];
  readonly progressParts: string[] = [];

  markdown(value: string): void {
    this.markdownParts.push(value);
  }

  progress(value: string): void {
    this.progressParts.push(value);
  }
}

class FakeLogger {
  readonly errors: string[] = [];
  readonly infos: string[] = [];
  readonly warnings: string[] = [];

  error(message: string): void {
    this.errors.push(message);
  }

  info(message: string): void {
    this.infos.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

function agentEvent(seq: number, type: string, payload: unknown): AgentEventEnvelope {
  return {
    seq,
    time: "1970-01-01T00:00:00.000Z",
    type,
    runId: "run_chat_1",
    turnId: "turn_chat_1",
    payload,
  };
}

async function withTimeout<T>(value: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("timed out waiting for chat turn")), 1_000);
  });
  try {
    return await Promise.race([value, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
