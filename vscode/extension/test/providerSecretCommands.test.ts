import assert from "node:assert/strict";
import test from "node:test";

import {
  CLEAR_DEEPSEEK_API_KEY_COMMAND,
  CONFIGURE_DEEPSEEK_API_KEY_COMMAND,
  SHOW_PROVIDER_STATUS_COMMAND,
  registerProviderSecretCommands,
} from "../src/providerSecretCommands.js";
import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_API_KEY_SECRET_ID } from "../src/providerSecrets.js";
import { MutableSecretRedactor } from "../src/redaction.js";

test("configure DeepSeek API key stores SecretStorage value, updates env, and restarts idle RPC", async () => {
  const commands = new FakeCommands();
  const window = new FakeSecretWindow([" fixture-secret-value "]);
  const secrets = new FakeSecrets();
  const redactor = new MutableSecretRedactor();
  const rpc = new FakeRpcServer("ready");

  registerProviderSecretCommands({
    commands,
    window,
    secrets,
    processEnv: {
      [DEEPSEEK_API_KEY_ENV]: "env-secret-value",
    },
    redactor,
    rpcServer: rpc,
    isRpcIdle: () => true,
  });

  await commands.run(CONFIGURE_DEEPSEEK_API_KEY_COMMAND);

  assert.equal(await secrets.get(DEEPSEEK_API_KEY_SECRET_ID), "fixture-secret-value");
  assert.deepEqual(rpc.processEnv, {
    [DEEPSEEK_API_KEY_ENV]: "fixture-secret-value",
  });
  assert.equal(rpc.stopCount, 1);
  assert.equal(rpc.startCount, 1);
  assert.deepEqual(window.infos.at(-1), "DeepSeek API key: VS Code SecretStorage");
  assert.equal(redactor.redact("key fixture-secret-value"), "key [redacted]");
});

test("clear DeepSeek API key falls back to process env without restarting active RPC", async () => {
  const commands = new FakeCommands();
  const window = new FakeSecretWindow([]);
  const secrets = new FakeSecrets({
    [DEEPSEEK_API_KEY_SECRET_ID]: "fixture-secret-value",
  });
  const rpc = new FakeRpcServer("ready");

  registerProviderSecretCommands({
    commands,
    window,
    secrets,
    processEnv: {
      [DEEPSEEK_API_KEY_ENV]: "env-secret-value",
    },
    rpcServer: rpc,
    isRpcIdle: () => false,
  });

  await commands.run(CLEAR_DEEPSEEK_API_KEY_COMMAND);

  assert.equal(await secrets.get(DEEPSEEK_API_KEY_SECRET_ID), undefined);
  assert.deepEqual(rpc.processEnv, {
    [DEEPSEEK_API_KEY_ENV]: "env-secret-value",
  });
  assert.equal(rpc.stopCount, 0);
  assert.equal(rpc.startCount, 0);
  assert.ok(window.infos.some((message) => message.includes("current turn finishes")));
  assert.deepEqual(window.infos.at(-1), "DeepSeek API key: process env");
});

test("show provider status reports missing configuration without exposing keys", async () => {
  const commands = new FakeCommands();
  const window = new FakeSecretWindow([]);

  registerProviderSecretCommands({
    commands,
    window,
    secrets: new FakeSecrets(),
    processEnv: {},
  });

  await commands.run(SHOW_PROVIDER_STATUS_COMMAND);

  assert.deepEqual(window.infos.at(-1), "DeepSeek API key: missing");
});

test("configure DeepSeek API key redacts restart failures", async () => {
  const commands = new FakeCommands();
  const window = new FakeSecretWindow(["fixture-secret-value"]);
  const redactor = new MutableSecretRedactor();
  const rpc = new FakeRpcServer("ready", new Error("failed with fixture-secret-value"));

  registerProviderSecretCommands({
    commands,
    window,
    secrets: new FakeSecrets(),
    redactor,
    rpcServer: rpc,
    isRpcIdle: () => true,
  });

  await commands.run(CONFIGURE_DEEPSEEK_API_KEY_COMMAND);

  assert.equal(window.warnings.at(-1), "DeepSeek API key updated, but RPC restart failed: failed with [redacted]");
});

class FakeCommands {
  private readonly callbacks = new Map<string, () => unknown>();

  registerCommand(command: string, callback: () => unknown) {
    this.callbacks.set(command, callback);
    return { dispose: () => undefined };
  }

  async run(command: string): Promise<void> {
    const callback = this.callbacks.get(command);
    assert.ok(callback, `${command} should be registered`);
    await callback();
  }
}

class FakeSecretWindow {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];

  constructor(private readonly inputValues: string[]) {}

  showInputBox(): string | undefined {
    return this.inputValues.shift();
  }

  showInformationMessage(message: string): void {
    this.infos.push(message);
  }

  showWarningMessage(message: string): void {
    this.warnings.push(message);
  }
}

class FakeSecrets {
  constructor(private readonly values: Record<string, string | undefined> = {}) {}

  async get(key: string): Promise<string | undefined> {
    return this.values[key];
  }

  async store(key: string, value: string): Promise<void> {
    this.values[key] = value;
  }

  async delete(key: string): Promise<void> {
    delete this.values[key];
  }
}

class FakeRpcServer {
  processEnv: Record<string, string | undefined> = {};
  startCount = 0;
  stopCount = 0;

  constructor(
    readonly status: string,
    private readonly startError?: Error,
  ) {}

  setProcessEnv(env: Record<string, string | undefined>): void {
    this.processEnv = env;
  }

  async start(): Promise<void> {
    this.startCount += 1;
    if (this.startError !== undefined) {
      throw this.startError;
    }
  }

  stop(): void {
    this.stopCount += 1;
  }
}
