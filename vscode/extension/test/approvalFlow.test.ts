import assert from "node:assert/strict";
import test from "node:test";

import {
  ApprovalEventController,
  approvalPromptRequestFromEvent,
  type ApprovalRpcClient,
} from "../src/approvalFlow.js";
import type { ApprovalPromptDecision, ApprovalWindowMessenger } from "../src/commands.js";
import type { AgentEventEnvelope, DisposableLike } from "../src/rpcServer.js";

test("approval controller sends approve decisions to the RPC pending queue", async () => {
  const rpc = new FakeApprovalRpcClient();
  const prompts: unknown[] = [];
  const controller = new ApprovalEventController(rpc, fakeWindow, fakeNotifier(), async (_window, request) => {
    prompts.push(request);
    return {
      kind: "approve",
      approvalId: request.approvalId,
      persist: "session",
    };
  });

  rpc.emit(approvalEvent());
  await controller.whenIdle();

  assert.equal(prompts.length, 1);
  assert.deepEqual(rpc.approvals, [
    {
      approvalId: "approval_1",
      persist: "session",
    },
  ]);
  assert.deepEqual(rpc.rejections, []);
});

test("approval controller sends hunk approvals to the RPC pending queue", async () => {
  const rpc = new FakeApprovalRpcClient();
  const controller = new ApprovalEventController(rpc, fakeWindow, fakeNotifier(), async (_window, request) => {
    assert.equal(request.hunks?.length, 2);
    return {
      kind: "approve",
      approvalId: request.approvalId,
      persist: "never",
      hunks: {
        approved: ["README.md#2:old5+2:new5+3"],
      },
    };
  });

  rpc.emit(approvalEvent({ toolName: "apply_patch", hunks: true }));
  await controller.whenIdle();

  assert.deepEqual(rpc.approvals, [
    {
      approvalId: "approval_1",
      persist: "never",
      hunks: {
        approved: ["README.md#2:old5+2:new5+3"],
      },
    },
  ]);
});

test("approval controller sends reject decisions to the RPC pending queue", async () => {
  const rpc = new FakeApprovalRpcClient();
  const controller = new ApprovalEventController(rpc, fakeWindow, fakeNotifier(), async (_window, request) => ({
    kind: "reject",
    approvalId: request.approvalId,
    reason: "not this time",
  }));

  rpc.emit(approvalEvent());
  await controller.whenIdle();

  assert.deepEqual(rpc.approvals, []);
  assert.deepEqual(rpc.rejections, [
    {
      approvalId: "approval_1",
      reason: "not this time",
    },
  ]);
});

test("approval controller ignores duplicate approval events while one prompt is active", async () => {
  const rpc = new FakeApprovalRpcClient();
  const deferred = deferredDecision();
  const promptStarted = deferredSignal();
  let promptCount = 0;
  const controller = new ApprovalEventController(rpc, fakeWindow, fakeNotifier(), () => {
    promptCount += 1;
    promptStarted.resolve();
    return deferred.promise;
  });

  rpc.emit(approvalEvent());
  await promptStarted.promise;
  rpc.emit(approvalEvent());

  assert.equal(promptCount, 1);
  deferred.resolve({
    kind: "approve",
    approvalId: "approval_1",
    persist: "never",
  });
  await controller.whenIdle();

  assert.equal(rpc.approvals.length, 1);
});

test("approval controller treats the same approval id in different runs as distinct", async () => {
  const rpc = new FakeApprovalRpcClient();
  let promptCount = 0;
  const controller = new ApprovalEventController(rpc, fakeWindow, fakeNotifier(), async (_window, request) => {
    promptCount += 1;
    return {
      kind: "approve",
      approvalId: request.approvalId,
      persist: "never",
    };
  });

  rpc.emit(approvalEvent({ runId: "run_1" }));
  rpc.emit(approvalEvent({ runId: "run_2" }));
  await controller.whenIdle();

  assert.equal(promptCount, 2);
  assert.deepEqual(
    rpc.approvals.map((approval) => approval.approvalId),
    ["approval_1", "approval_1"],
  );
});

test("approval controller prepares approval preview before prompting", async () => {
  const rpc = new FakeApprovalRpcClient();
  const order: string[] = [];
  const controller = new ApprovalEventController(
    rpc,
    fakeWindow,
    fakeNotifier(),
    async (_window, request) => {
      order.push(`prompt:${request.approvalId}`);
      return {
        kind: "approve",
        approvalId: request.approvalId,
        persist: "never",
      };
    },
    {
      async prepareApproval(_event, request) {
        order.push(`preview:${request.approvalId}`);
      },
    },
  );

  rpc.emit(approvalEvent({ toolName: "apply_patch" }));
  await controller.whenIdle();

  assert.deepEqual(order, ["preview:approval_1", "prompt:approval_1"]);
  assert.equal(rpc.approvals.length, 1);
});

test("approval controller still prompts when approval preview fails", async () => {
  const rpc = new FakeApprovalRpcClient();
  const warnings: string[] = [];
  let prompted = false;
  const controller = new ApprovalEventController(
    rpc,
    fakeWindow,
    {
      warn(message) {
        warnings.push(message);
      },
    },
    async (_window, request) => {
      prompted = true;
      return {
        kind: "approve",
        approvalId: request.approvalId,
        persist: "never",
      };
    },
    {
      async prepareApproval() {
        throw new Error("preview unavailable");
      },
    },
  );

  rpc.emit(approvalEvent({ toolName: "apply_patch" }));
  await controller.whenIdle();

  assert.equal(prompted, true);
  assert.ok(warnings[0]?.includes("approval preview failed"));
  assert.equal(rpc.approvals.length, 1);
});

test("approval controller reports malformed approval events without prompting", async () => {
  const rpc = new FakeApprovalRpcClient();
  const warnings: string[] = [];
  let promptCount = 0;
  const controller = new ApprovalEventController(
    rpc,
    fakeWindow,
    {
      warn(message) {
        warnings.push(message);
      },
    },
    async () => {
      promptCount += 1;
      return {
        kind: "reject",
        approvalId: "approval_1",
        reason: "unexpected",
      };
    },
  );

  rpc.emit({
    ...approvalEvent(),
    payload: {
      approvalId: "approval_1",
    },
  });
  await controller.whenIdle();

  assert.equal(promptCount, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes("malformed approval request"));
  assert.deepEqual(rpc.approvals, []);
  assert.deepEqual(rpc.rejections, []);
});

test("approvalPromptRequestFromEvent maps protocol payloads to modal requests", () => {
  const request = approvalPromptRequestFromEvent(approvalEvent({ hunks: true }));

  assert.deepEqual(request, {
    approvalId: "approval_1",
    toolCallId: "tool_call_1",
    toolName: "shell",
    risk: "exec",
    title: "Execute shell command",
    detail: "Run verification",
    persistable: true,
    command: "cargo test",
    cwd: ".",
    outputSummary: "last output summary",
    paths: ["crates/cli/src/lib.rs"],
    hunks: [
      {
        id: "README.md#1:old1+3:new1+3",
        filePath: "README.md",
        hunkIndex: 0,
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 3,
      },
      {
        id: "README.md#2:old5+2:new5+3",
        filePath: "README.md",
        hunkIndex: 1,
        oldStart: 5,
        oldCount: 2,
        newStart: 5,
        newCount: 3,
        section: "next block",
      },
    ],
    riskReasons: ["dependency install/update"],
  });
});

const fakeWindow: ApprovalWindowMessenger = {
  showWarningMessage() {
    return undefined;
  },
};

function fakeNotifier(): { warn(message: string): unknown } {
  return {
    warn: () => undefined,
  };
}

function approvalEvent(
  options: { readonly runId?: string; readonly toolName?: string; readonly hunks?: boolean } = {},
): AgentEventEnvelope {
  return {
    seq: 1,
    time: "1970-01-01T00:00:00.000Z",
    type: "tool.approvalRequired",
    runId: options.runId ?? "run_1",
    turnId: "turn_1",
    payload: {
      approvalId: "approval_1",
      toolCallId: "tool_call_1",
      toolName: options.toolName ?? "shell",
      risk: "exec",
      title: "Execute shell command",
      detail: "Run verification",
      command: "cargo test",
      cwd: ".",
      outputSummary: "last output summary",
      paths: ["crates/cli/src/lib.rs"],
      ...(options.hunks === true
        ? {
            hunks: [
              {
                id: "README.md#1:old1+3:new1+3",
                filePath: "README.md",
                fileIndex: 0,
                hunkIndex: 0,
                oldStart: 1,
                oldCount: 3,
                newStart: 1,
                newCount: 3,
              },
              {
                id: "README.md#2:old5+2:new5+3",
                filePath: "README.md",
                fileIndex: 0,
                hunkIndex: 1,
                oldStart: 5,
                oldCount: 2,
                newStart: 5,
                newCount: 3,
                section: "next block",
              },
            ],
          }
        : {}),
      riskReasons: ["dependency install/update"],
      persistable: true,
    },
  };
}

class FakeApprovalRpcClient implements ApprovalRpcClient {
  readonly approvals: Array<{
    readonly approvalId: string;
    readonly persist?: string;
    readonly hunks?: { readonly approved: readonly string[] };
  }> = [];
  readonly rejections: Array<{ readonly approvalId: string; readonly reason?: string }> = [];
  private readonly handlers = new Set<(event: AgentEventEnvelope) => void>();

  onEvent(handler: (event: AgentEventEnvelope) => void): DisposableLike {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  emit(event: AgentEventEnvelope): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  async approve(params: {
    readonly approvalId: string;
    readonly persist?: string;
    readonly hunks?: { readonly approved: readonly string[] };
  }): Promise<{
    readonly approvalId: string;
    readonly state: "approved";
    readonly persist: "never" | "session" | "workspace";
    readonly hunks?: { readonly approved: readonly string[] };
  }> {
    this.approvals.push(params);
    return {
      approvalId: params.approvalId,
      state: "approved",
      persist: params.persist === "session" || params.persist === "workspace" ? params.persist : "never",
      ...(params.hunks === undefined ? {} : { hunks: params.hunks }),
    };
  }

  async reject(params: { readonly approvalId: string; readonly reason?: string }): Promise<{
    readonly approvalId: string;
    readonly state: "rejected";
    readonly reason?: string;
  }> {
    this.rejections.push(params);
    return {
      approvalId: params.approvalId,
      state: "rejected",
      ...(params.reason === undefined ? {} : { reason: params.reason }),
    };
  }
}

function deferredDecision(): {
  readonly promise: Promise<ApprovalPromptDecision>;
  resolve(value: ApprovalPromptDecision): void;
} {
  let resolve: ((value: ApprovalPromptDecision) => void) | undefined;
  const promise = new Promise<ApprovalPromptDecision>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve(value) {
      assert.ok(resolve);
      resolve(value);
    },
  };
}

function deferredSignal(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve() {
      assert.ok(resolve);
      resolve();
    },
  };
}
