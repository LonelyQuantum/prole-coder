import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RPC_ARGS,
  DEFAULT_RPC_COMMAND,
  RPC_APPROVE_METHOD,
  RPC_CANCEL_METHOD,
  RPC_EVENT_BATCH_METHOD,
  RPC_INITIALIZE_METHOD,
  RPC_LIST_RUNS_METHOD,
  RPC_PREVIEW_FIM_METHOD,
  RPC_PROTOCOL_VERSION,
  RPC_REJECT_METHOD,
  RPC_RESUME_METHOD,
  RPC_SEND_TURN_METHOD,
  RpcRequestError,
  RpcServerManager,
  type RpcChildProcess,
  type RpcProcessFactory,
  type RpcReadable,
  type RpcServerConfiguration,
  type RpcSpawnOptions,
  type RpcWritable,
  readRpcServerLaunchConfig,
} from "../src/rpcServer.js";

test("RPC server manager spawns the configured command and initializes the workspace", async () => {
  const factory = new FakeProcessFactory();
  const manager = new RpcServerManager({
    launch: {
      command: "prole",
      args: ["rpc", "--provider", "fixture"],
      autoStart: true,
    },
    workspace: {
      root: "C:/workspace/project",
      trusted: true,
    },
    extensionVersion: "0.1.0",
    processFactory: factory,
  });

  const readyPromise = manager.start();
  const child = factory.lastChild();
  const request = child.initializeRequest();

  assert.equal(factory.lastCommand, "prole");
  assert.deepEqual(factory.lastArgs, ["rpc", "--provider", "fixture"]);
  assert.equal(factory.lastOptions?.cwd, "C:/workspace/project");
  assert.equal(request.method, RPC_INITIALIZE_METHOD);
  assert.equal(request.params.protocolVersion, RPC_PROTOCOL_VERSION);
  assert.equal(request.params.client.frontend, "vscode");
  assert.equal(request.params.workspaceRoot, "C:/workspace/project");
  assert.equal(request.params.workspaceTrusted, true);

  child.stdout.pushJson(initializeResponse(request.id));
  const ready = await readyPromise;

  assert.equal(manager.status, "ready");
  assert.equal(ready.server.name, "prole-coder-agent-rpc");
  assert.equal(ready.capabilities.provider.defaultModel, "deepseek-v4-pro");
  assert.equal(ready.capabilities.supportsEventBatching, true);
});

test("RPC server manager forwards agent.event notifications", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const received: unknown[] = [];
  manager.onEvent((event) => received.push(event));

  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  child.stdout.pushJson({
    jsonrpc: "2.0",
    method: "agent.event",
    params: {
      seq: 1,
      time: "1970-01-01T00:00:00.000Z",
      type: "run.started",
      runId: "run_1",
      payload: { mode: "ask" },
    },
  });

  assert.deepEqual(received, [
    {
      seq: 1,
      time: "1970-01-01T00:00:00.000Z",
      type: "run.started",
      runId: "run_1",
      payload: { mode: "ask" },
    },
  ]);
});

test("RPC server manager ignores malformed agent.event notifications", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const received: unknown[] = [];
  manager.onEvent((event) => received.push(event));

  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  child.stdout.pushJson({
    jsonrpc: "2.0",
    method: "agent.event",
    params: {
      seq: 1,
      time: "1970-01-01T00:00:00.000Z",
      type: "run.started",
      payload: { mode: "ask" },
    },
  });

  assert.deepEqual(received, []);
});

test("RPC server manager forwards agent.eventBatch notifications in order", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const received: unknown[] = [];
  manager.onEvent((event) => received.push(event));

  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  child.stdout.pushJson({
    jsonrpc: "2.0",
    method: RPC_EVENT_BATCH_METHOD,
    params: {
      events: [
        {
          seq: 2,
          time: "1970-01-01T00:00:00.001Z",
          type: "assistant.delta",
          runId: "run_1",
          turnId: "turn_1",
          payload: { text: "hello" },
        },
        {
          seq: 3,
          time: "1970-01-01T00:00:00.002Z",
          type: "assistant.delta",
          runId: "run_1",
          turnId: "turn_1",
          payload: { text: " world" },
        },
      ],
      firstSeq: 2,
      lastSeq: 3,
      count: 2,
    },
  });

  assert.deepEqual(
    received.map((event) => (event as { seq: number }).seq),
    [2, 3],
  );
});

test("RPC server manager ignores malformed agent.eventBatch notifications", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const received: unknown[] = [];
  manager.onEvent((event) => received.push(event));

  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  child.stdout.pushJson({
    jsonrpc: "2.0",
    method: RPC_EVENT_BATCH_METHOD,
    params: {
      events: [
        {
          seq: 2,
          time: "1970-01-01T00:00:00.001Z",
          type: "assistant.delta",
          runId: "run_1",
          payload: { text: "hello" },
        },
      ],
      firstSeq: 2,
      lastSeq: 2,
      count: 2,
    },
  });

  assert.deepEqual(received, []);
});

test("RPC server manager ignores non-agent.event notifications", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const received: unknown[] = [];
  manager.onEvent((event) => received.push(event));

  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  child.stdout.pushJson({
    jsonrpc: "2.0",
    method: "window/logMessage",
    params: {
      message: "hello",
    },
  });

  assert.deepEqual(received, []);
});

test("RPC server manager removes disposed event handlers", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const received: unknown[] = [];
  const disposable = manager.onEvent((event) => received.push(event));
  disposable.dispose();

  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  child.stdout.pushJson(agentEventNotification());

  assert.deepEqual(received, []);
});

test("RPC server manager sends typed agent.sendTurn requests and resolves matching responses", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  const responsePromise = manager.sendTurn({
    message: "hello",
    mode: "edit",
  });
  await flushMicrotasks();
  const request = child.requestAt(1);

  assert.equal(request.method, RPC_SEND_TURN_METHOD);
  assert.deepEqual(request.params, { message: "hello", mode: "edit" });

  child.stdout.pushJson({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      runId: "run_1",
      turnId: "turn_1",
      accepted: true,
    },
  });

  assert.deepEqual(await responsePromise, {
    runId: "run_1",
    turnId: "turn_1",
    accepted: true,
  });
});

test("RPC server manager sends typed run list and resume requests", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  const listPromise = manager.listRuns({ limit: 10 });
  await flushMicrotasks();
  const listRequest = child.requestAt(1);
  assert.equal(listRequest.method, RPC_LIST_RUNS_METHOD);
  assert.deepEqual(listRequest.params, { limit: 10 });
  child.stdout.pushJson({
    jsonrpc: "2.0",
    id: listRequest.id,
    result: {
      runs: [
        {
          runId: "run_1",
          title: "Update docs",
          status: "completed",
          startedAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:01.000Z",
          completedAt: "1970-01-01T00:00:01.000Z",
          lastSeq: 8,
          eventCount: 8,
          mode: "edit",
          summary: "done",
        },
      ],
    },
  });
  assert.deepEqual(await listPromise, {
    runs: [
      {
        runId: "run_1",
        title: "Update docs",
        status: "completed",
        startedAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:01.000Z",
        completedAt: "1970-01-01T00:00:01.000Z",
        lastSeq: 8,
        eventCount: 8,
        mode: "edit",
        summary: "done",
      },
    ],
  });

  const resumePromise = manager.resume({ runId: "run_1", replayFromSeq: 3 });
  await flushMicrotasks();
  const resumeRequest = child.requestAt(2);
  assert.equal(resumeRequest.method, RPC_RESUME_METHOD);
  assert.deepEqual(resumeRequest.params, { runId: "run_1", replayFromSeq: 3 });
  child.stdout.pushJson({
    jsonrpc: "2.0",
    id: resumeRequest.id,
    result: {
      runId: "run_1",
      nextSeq: 9,
      replayStarted: true,
    },
  });

  assert.deepEqual(await resumePromise, {
    runId: "run_1",
    nextSeq: 9,
    replayStarted: true,
  });
});

test("RPC server manager sends typed approval requests", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  const approvePromise = manager.approve({
    approvalId: "approval_1",
    persist: "never",
    hunks: {
      approved: ["README.md#1:old1+3:new1+3"],
    },
  });
  await flushMicrotasks();
  const approveRequest = child.requestAt(1);
  assert.equal(approveRequest.method, RPC_APPROVE_METHOD);
  assert.deepEqual(approveRequest.params, {
    approvalId: "approval_1",
    persist: "never",
    hunks: {
      approved: ["README.md#1:old1+3:new1+3"],
    },
  });
  child.stdout.pushJson({
    jsonrpc: "2.0",
    id: approveRequest.id,
    result: {
      approvalId: "approval_1",
      state: "approved",
      persist: "never",
      hunks: {
        approved: ["README.md#1:old1+3:new1+3"],
      },
    },
  });
  assert.deepEqual(await approvePromise, {
    approvalId: "approval_1",
    state: "approved",
    persist: "never",
    hunks: {
      approved: ["README.md#1:old1+3:new1+3"],
    },
  });

  const rejectPromise = manager.reject({
    approvalId: "approval_2",
    reason: "not now",
  });
  await flushMicrotasks();
  const rejectRequest = child.requestAt(2);
  assert.equal(rejectRequest.method, RPC_REJECT_METHOD);
  assert.deepEqual(rejectRequest.params, {
    approvalId: "approval_2",
    reason: "not now",
  });
  child.stdout.pushJson({
    jsonrpc: "2.0",
    id: rejectRequest.id,
    result: {
      approvalId: "approval_2",
      state: "rejected",
      reason: "not now",
    },
  });
  assert.deepEqual(await rejectPromise, {
    approvalId: "approval_2",
    state: "rejected",
    reason: "not now",
  });
});

test("RPC server manager sends typed cancel requests", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  const cancelPromise = manager.cancel({
    runId: "run_1",
    reason: "user canceled",
  });
  await flushMicrotasks();
  const cancelRequest = child.requestAt(1);
  assert.equal(cancelRequest.method, RPC_CANCEL_METHOD);
  assert.deepEqual(cancelRequest.params, {
    runId: "run_1",
    reason: "user canceled",
  });
  child.stdout.pushJson({
    jsonrpc: "2.0",
    id: cancelRequest.id,
    result: {
      runId: "run_1",
      state: "canceled",
      reason: "user canceled",
    },
  });

  assert.deepEqual(await cancelPromise, {
    runId: "run_1",
    state: "canceled",
    reason: "user canceled",
  });
});

test("RPC server manager sends typed FIM preview requests", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  const previewPromise = manager.previewFim({
    prefix: "fn main() {",
    suffix: "}",
    path: "src/main.rs",
    languageId: "rust",
    model: "deepseek-v4-pro",
    maxTokens: 32,
  });
  await flushMicrotasks();
  const previewRequest = child.requestAt(1);
  assert.equal(previewRequest.method, RPC_PREVIEW_FIM_METHOD);
  assert.deepEqual(previewRequest.params, {
    prefix: "fn main() {",
    suffix: "}",
    path: "src/main.rs",
    languageId: "rust",
    model: "deepseek-v4-pro",
    maxTokens: 32,
  });
  child.stdout.pushJson({
    jsonrpc: "2.0",
    id: previewRequest.id,
    result: {
      text: " println!(\"hi\");",
      model: "deepseek-v4-pro",
      finishReason: "stop",
    },
  });

  assert.deepEqual(await previewPromise, {
    text: " println!(\"hi\");",
    model: "deepseek-v4-pro",
    finishReason: "stop",
  });
});

test("RPC server manager rejects sendRequest when stdin write fails", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;
  child.failStdinWritesWith(new Error("stdin closed"));

  await assert.rejects(
    manager.sendRequest(RPC_SEND_TURN_METHOD, { message: "hello", mode: "edit" }),
    /stdin closed/,
  );
});

test("RPC server manager rejects JSON-RPC error responses", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  const responsePromise = manager.approve({
    approvalId: "approval_1",
  });
  await flushMicrotasks();
  const request = child.requestAt(1);

  child.stdout.pushJson({
    jsonrpc: "2.0",
    id: request.id,
    error: {
      code: -32003,
      message: "approval not found",
      data: { approvalId: "approval_1" },
    },
  });

  await assert.rejects(responsePromise, (error: unknown) => {
    assert.ok(error instanceof RpcRequestError);
    assert.equal(error.code, -32003);
    assert.deepEqual(error.data, { approvalId: "approval_1" });
    return true;
  });
});

test("RPC server manager rejects pending requests when the server exits", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  const responsePromise = manager.sendRequest(RPC_SEND_TURN_METHOD, {
    message: "hello",
    mode: "edit",
  });
  await flushMicrotasks();

  child.exit(1, null);

  await assert.rejects(responsePromise, /exited before the request completed/);
});

test("RPC server manager rejects when spawn throws", async () => {
  const factory = new FakeProcessFactory({
    spawnError: new Error("spawn denied"),
  });
  const manager = rpcManagerWithFactory(factory);

  await assert.rejects(manager.start(), /spawn denied/);

  assert.equal(manager.status, "failed");
});

test("RPC server manager rejects when the child has missing stdio pipes", async () => {
  const factory = new FakeProcessFactory({
    childOptions: {
      stdin: null,
    },
  });
  const manager = rpcManagerWithFactory(factory);

  await assert.rejects(manager.start(), /stdio pipes/);

  assert.equal(manager.status, "failed");
});

test("RPC server manager fails startup on invalid JSON output", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();

  child.stdout.push("{not json}\n");

  await assert.rejects(readyPromise, /invalid JSON/);
  assert.equal(manager.status, "failed");
  assert.equal(child.killed, true);
});

test("RPC server manager fails startup on process error", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();

  child.error(new Error("process launch failed"));

  await assert.rejects(readyPromise, /process launch failed/);
  assert.equal(manager.status, "failed");
});

test("RPC server manager warns clearly on protocol mismatch startup errors", async () => {
  const factory = new FakeProcessFactory();
  const warnings: string[] = [];
  const manager = new RpcServerManager({
    launch: {
      command: "prole",
      args: ["rpc"],
      autoStart: true,
    },
    workspace: {
      root: "C:/workspace/project",
      trusted: true,
    },
    extensionVersion: "0.1.0",
    processFactory: factory,
    notifier: {
      info: () => undefined,
      warn(message) {
        warnings.push(message);
      },
    },
  });

  const readyPromise = manager.start();
  const child = factory.lastChild();
  const request = child.initializeRequest();
  child.stdout.pushJson({
    jsonrpc: "2.0",
    id: request.id,
    error: {
      code: -32001,
      message: "unsupported protocol version `9.9.9`, expected `0.1.0`",
      data: {
        clientProtocolVersion: "9.9.9",
        serverProtocolVersion: RPC_PROTOCOL_VERSION,
      },
    },
  });

  await assert.rejects(readyPromise, /protocol mismatch/i);
  assert.equal(manager.status, "failed");
  assert.equal(child.killed, true);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes("9.9.9"));
  assert.ok(warnings[0]?.includes(RPC_PROTOCOL_VERSION));
});

test("RPC server manager stop rejects pending startup", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();

  manager.stop();

  await assert.rejects(readyPromise, /stopped before initialization/);
  assert.equal(child.killed, true);
  assert.equal(child.stdinEnded, true);
  assert.equal(manager.status, "stopped");
});

test("RPC server manager rejects untrusted workspaces without spawning", async () => {
  const factory = new FakeProcessFactory();
  const manager = new RpcServerManager({
    launch: {
      command: "prole",
      args: ["rpc"],
      autoStart: true,
    },
    workspace: {
      root: "C:/workspace/project",
      trusted: false,
    },
    extensionVersion: "0.1.0",
    processFactory: factory,
  });

  await assert.rejects(manager.start(), /not trusted/);

  assert.equal(factory.spawnCount, 0);
  assert.equal(manager.status, "failed");
});

test("RPC server manager warns when a ready server exits unexpectedly", async () => {
  const factory = new FakeProcessFactory();
  const warnings: string[] = [];
  const manager = new RpcServerManager({
    launch: {
      command: "prole",
      args: ["rpc"],
      autoStart: true,
    },
    workspace: {
      root: "C:/workspace/project",
      trusted: true,
    },
    extensionVersion: "0.1.0",
    processFactory: factory,
    notifier: {
      info: () => undefined,
      warn(message) {
        warnings.push(message);
      },
    },
  });

  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  child.exit(1, null);

  assert.equal(manager.status, "failed");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes("exit code 1"));
});

test("RPC server manager records a bounded stderr preview", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();

  child.stderr.push("first stderr line\n");
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  assert.equal(manager.stderrPreview, "first stderr line\n");

  child.stderr.push("x".repeat(5000));

  assert.equal(manager.stderrPreview.length, 4096);
  assert.ok(manager.stderrPreview.endsWith("x".repeat(64)));
});

test("RPC server manager disposes the child process", async () => {
  const factory = new FakeProcessFactory();
  const manager = rpcManagerWithFactory(factory);
  const readyPromise = manager.start();
  const child = factory.lastChild();
  child.stdout.pushJson(initializeResponse(child.initializeRequest().id));
  await readyPromise;

  manager.dispose();

  assert.equal(child.killed, true);
  assert.equal(child.stdinEnded, true);
  assert.equal(manager.status, "stopped");
});

test("RPC launch configuration reads defaults and rejects an empty command", () => {
  const defaults = readRpcServerLaunchConfig(new FakeConfiguration({}));
  assert.equal(defaults.command, DEFAULT_RPC_COMMAND);
  assert.deepEqual(defaults.args, [...DEFAULT_RPC_ARGS]);
  assert.equal(defaults.autoStart, true);

  const custom = readRpcServerLaunchConfig(
    new FakeConfiguration({
      command: "cargo",
      args: ["run", "-p", "prole-coder-cli", "--", "rpc"],
      autoStart: false,
    }),
  );
  assert.equal(custom.command, "cargo");
  assert.deepEqual(custom.args, ["run", "-p", "prole-coder-cli", "--", "rpc"]);
  assert.equal(custom.autoStart, false);

  assert.throws(() => readRpcServerLaunchConfig(new FakeConfiguration({ command: " " })));
});

function rpcManagerWithFactory(factory: FakeProcessFactory): RpcServerManager {
  return new RpcServerManager({
    launch: {
      command: "prole",
      args: ["rpc"],
      autoStart: true,
    },
    workspace: {
      root: "C:/workspace/project",
      trusted: true,
    },
    extensionVersion: "0.1.0",
    processFactory: factory,
  });
}

function initializeResponse(id: unknown): unknown {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: RPC_PROTOCOL_VERSION,
      server: {
        name: "prole-coder-agent-rpc",
        version: "0.1.0",
      },
      capabilities: {
        protocolVersion: RPC_PROTOCOL_VERSION,
        supportsRunResume: true,
        supportsPatchApproval: true,
        supportsPersistentApprovals: true,
        supportsEventBatching: true,
        supportedRiskLevels: ["read", "write", "exec", "network", "destructive"],
        provider: {
          provider: "deepseek",
          defaultModel: "deepseek-v4-pro",
          models: [
            {
              id: "deepseek-v4-pro",
              displayName: "DeepSeek V4 Pro",
              contextWindowTokens: 1_048_576,
              maxOutputTokens: 393_216,
              supportsThinking: true,
              supportsToolCalls: true,
              supportsToolChoice: false,
              supportsFim: true,
              supportsStreaming: true,
              reportsCacheUsage: true,
            },
          ],
        },
      },
      stateDir: ".prole-coder",
    },
  };
}

function agentEventNotification(): unknown {
  return {
    jsonrpc: "2.0",
    method: "agent.event",
    params: {
      seq: 1,
      time: "1970-01-01T00:00:00.000Z",
      type: "run.started",
      runId: "run_1",
      payload: { mode: "ask" },
    },
  };
}

class FakeConfiguration implements RpcServerConfiguration {
  constructor(private readonly values: Record<string, unknown>) {}

  get<T>(section: string, defaultValue: T): T {
    return section in this.values ? (this.values[section] as T) : defaultValue;
  }
}

interface FakeProcessFactoryOptions {
  readonly spawnError?: Error;
  readonly childOptions?: FakeChildProcessOptions;
}

class FakeProcessFactory implements RpcProcessFactory {
  lastCommand: string | undefined;
  lastArgs: readonly string[] | undefined;
  lastOptions: RpcSpawnOptions | undefined;
  spawnCount = 0;
  private child: FakeChildProcess | undefined;

  constructor(private readonly options: FakeProcessFactoryOptions = {}) {}

  spawn(command: string, args: readonly string[], options: RpcSpawnOptions): RpcChildProcess {
    this.spawnCount += 1;
    if (this.options.spawnError !== undefined) {
      throw this.options.spawnError;
    }

    this.lastCommand = command;
    this.lastArgs = [...args];
    this.lastOptions = options;
    this.child = new FakeChildProcess(this.options.childOptions);
    return this.child;
  }

  lastChild(): FakeChildProcess {
    assert.ok(this.child);
    return this.child;
  }
}

class FakeWritable implements RpcWritable {
  readonly writes: string[] = [];
  ended = false;
  private writeError: Error | undefined;

  write(data: string): unknown {
    if (this.writeError !== undefined) {
      throw this.writeError;
    }

    this.writes.push(data);
    return true;
  }

  end(): unknown {
    this.ended = true;
    return undefined;
  }

  failWritesWith(error: Error): void {
    this.writeError = error;
  }
}

class FakeReadable implements RpcReadable {
  private readonly dataListeners: Array<(chunk: Buffer | string) => void> = [];

  on(event: "data", listener: (chunk: Buffer | string) => void): unknown {
    if (event === "data") {
      this.dataListeners.push(listener);
    }
    return this;
  }

  pushJson(value: unknown): void {
    this.push(`${JSON.stringify(value)}\n`);
  }

  push(chunk: string): void {
    for (const listener of this.dataListeners) {
      listener(chunk);
    }
  }
}

class FakeChildProcess implements RpcChildProcess {
  private readonly fakeStdin = new FakeWritable();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  killed = false;
  private readonly exposeStdin: boolean;

  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> =
    [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  constructor(options: FakeChildProcessOptions = {}) {
    this.exposeStdin = options.stdin !== null;
  }

  get stdin(): FakeWritable | null {
    return this.exposeStdin ? this.fakeStdin : null;
  }

  get stdinEnded(): boolean {
    return this.fakeStdin.ended;
  }

  failStdinWritesWith(error: Error): void {
    this.fakeStdin.failWritesWith(error);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  on(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): unknown {
    if (event === "exit") {
      this.exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    } else {
      this.errorListeners.push(listener as (error: Error) => void);
    }
    return this;
  }

  initializeRequest(): InitializeRequest {
    const firstWrite = this.fakeStdin.writes[0];
    assert.ok(firstWrite);
    return JSON.parse(firstWrite) as InitializeRequest;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.exitListeners) {
      listener(code, signal);
    }
  }

  error(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  requestAt(index: number): RpcRequest {
    const write = this.fakeStdin.writes[index];
    assert.ok(write);
    return JSON.parse(write) as RpcRequest;
  }
}

interface FakeChildProcessOptions {
  readonly stdin?: null;
}

interface InitializeRequest {
  readonly id: string;
  readonly method: string;
  readonly params: {
    readonly protocolVersion: string;
    readonly client: {
      readonly frontend: string;
    };
    readonly workspaceRoot: string;
    readonly workspaceTrusted: boolean;
  };
}

interface RpcRequest {
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}
