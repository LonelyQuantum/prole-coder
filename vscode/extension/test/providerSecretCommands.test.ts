import assert from "node:assert/strict";
import test from "node:test";

import {
  CLEAR_DEEPSEEK_API_KEY_COMMAND,
  CONFIGURE_DEEPSEEK_API_KEY_COMMAND,
  SELECT_DEEPSEEK_MODEL_COMMAND,
  SHOW_PROVIDER_STATUS_COMMAND,
  registerProviderSecretCommands,
  type SecretQuickInputButton,
  type SecretQuickPickItemButtonEvent,
} from "../src/providerSecretCommands.js";
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_API_KEY_STORE_SECRET_ID,
  DEEPSEEK_API_KEY_SECRET_ID,
  DEEPSEEK_MODEL_ENV,
  parseDeepSeekApiKeyStore,
  serializeDeepSeekApiKeyStore,
} from "../src/providerSecrets.js";
import { MutableSecretRedactor } from "../src/redaction.js";

test("configure DeepSeek API key stores SecretStorage value, updates env, and restarts idle RPC", async () => {
  const commands = new FakeCommands();
  const window = new FakeSecretWindow(["Work", " fixture-secret-value "], [], [
    { label: "+ Add DeepSeek API Key" },
  ]);
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
    renameAliasButton: FakeSecretWindow.renameButton,
  });

  await commands.run(CONFIGURE_DEEPSEEK_API_KEY_COMMAND);

  const keyStore = parseDeepSeekApiKeyStore(await secrets.get(DEEPSEEK_API_KEY_STORE_SECRET_ID));
  assert.equal(keyStore.entries.length, 1);
  assert.equal(keyStore.entries[0]?.alias, "Work");
  assert.equal(keyStore.entries[0]?.apiKey, "fixture-secret-value");
  assert.equal(keyStore.selectedKeyId, keyStore.entries[0]?.id);
  assert.equal(await secrets.get(DEEPSEEK_API_KEY_SECRET_ID), undefined);
  assert.deepEqual(rpc.processEnv, {
    [DEEPSEEK_API_KEY_ENV]: "fixture-secret-value",
  });
  assert.equal(rpc.stopCount, 1);
  assert.equal(rpc.startCount, 1);
  assert.deepEqual(window.infos.at(-1), "DeepSeek API key: VS Code SecretStorage (Work)");
  assert.equal(redactor.redact("key fixture-secret-value"), "key [redacted]");
});

test("configure DeepSeek API key selects an existing stored key", async () => {
  const commands = new FakeCommands();
  const window = new FakeSecretWindow([], [], [{ label: "Personal" }]);
  const secrets = new FakeSecrets({
    [DEEPSEEK_API_KEY_STORE_SECRET_ID]: serializeDeepSeekApiKeyStore({
      selectedKeyId: "work",
      entries: [
        {
          id: "work",
          alias: "Work",
          apiKey: "work-secret-value",
        },
        {
          id: "personal",
          alias: "Personal",
          apiKey: "personal-secret-value",
        },
      ],
    }),
  });
  const rpc = new FakeRpcServer("ready");

  registerProviderSecretCommands({
    commands,
    window,
    secrets,
    rpcServer: rpc,
    isRpcIdle: () => true,
    renameAliasButton: FakeSecretWindow.renameButton,
  });

  await commands.run(CONFIGURE_DEEPSEEK_API_KEY_COMMAND);

  const keyStore = parseDeepSeekApiKeyStore(await secrets.get(DEEPSEEK_API_KEY_STORE_SECRET_ID));
  assert.equal(keyStore.selectedKeyId, "personal");
  assert.deepEqual(rpc.processEnv, {
    [DEEPSEEK_API_KEY_ENV]: "personal-secret-value",
  });
  assert.equal(rpc.stopCount, 1);
  assert.equal(rpc.startCount, 1);
  assert.deepEqual(window.infos.at(-1), "DeepSeek API key: VS Code SecretStorage (Personal)");
});

test("configure DeepSeek API key renames an existing key alias without restarting RPC", async () => {
  const commands = new FakeCommands();
  const window = new FakeSecretWindow(["Team"], [], [{ label: "Work", button: true }]);
  const secrets = new FakeSecrets({
    [DEEPSEEK_API_KEY_STORE_SECRET_ID]: serializeDeepSeekApiKeyStore({
      selectedKeyId: "work",
      entries: [
        {
          id: "work",
          alias: "Work",
          apiKey: "work-secret-value",
        },
      ],
    }),
  });
  const rpc = new FakeRpcServer("ready");

  registerProviderSecretCommands({
    commands,
    window,
    secrets,
    rpcServer: rpc,
    isRpcIdle: () => true,
    renameAliasButton: FakeSecretWindow.renameButton,
  });

  await commands.run(CONFIGURE_DEEPSEEK_API_KEY_COMMAND);

  const keyStore = parseDeepSeekApiKeyStore(await secrets.get(DEEPSEEK_API_KEY_STORE_SECRET_ID));
  assert.equal(keyStore.entries[0]?.alias, "Team");
  assert.deepEqual(rpc.processEnv, {
    [DEEPSEEK_API_KEY_ENV]: "work-secret-value",
  });
  assert.equal(rpc.stopCount, 0);
  assert.equal(rpc.startCount, 0);
  assert.deepEqual(window.infos.at(-1), "DeepSeek API key alias updated: Team");
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

  assert.deepEqual(window.infos.at(-1), "DeepSeek API key: missing; DeepSeek model: provider default");
});

test("select DeepSeek model stores configuration, updates env, and restarts idle RPC", async () => {
  const commands = new FakeCommands();
  const window = new FakeSecretWindow([], ["DeepSeek V4 Flash"]);
  const secrets = new FakeSecrets({
    [DEEPSEEK_API_KEY_SECRET_ID]: "fixture-secret-value",
  });
  const configuration = new FakeProviderConfiguration({
    model: "deepseek-v4-pro",
  });
  const rpc = new FakeRpcServer("ready");

  registerProviderSecretCommands({
    commands,
    window,
    secrets,
    providerConfiguration: configuration,
    rpcServer: rpc,
    isRpcIdle: () => true,
  });

  await commands.run(SELECT_DEEPSEEK_MODEL_COMMAND);

  assert.equal(configuration.values["model"], "deepseek-v4-flash");
  assert.deepEqual(rpc.processEnv, {
    [DEEPSEEK_API_KEY_ENV]: "fixture-secret-value",
    [DEEPSEEK_MODEL_ENV]: "deepseek-v4-flash",
  });
  assert.equal(rpc.stopCount, 1);
  assert.equal(rpc.startCount, 1);
  assert.deepEqual(window.infos.at(-1), "DeepSeek model: DeepSeek V4 Flash (deepseek-v4-flash)");
});

test("configure DeepSeek API key redacts restart failures", async () => {
  const commands = new FakeCommands();
  const window = new FakeSecretWindow(["Key", "fixture-secret-value"], [], [
    { label: "+ Add DeepSeek API Key" },
  ]);
  const redactor = new MutableSecretRedactor();
  const rpc = new FakeRpcServer("ready", new Error("failed with fixture-secret-value"));

  registerProviderSecretCommands({
    commands,
    window,
    secrets: new FakeSecrets(),
    redactor,
    rpcServer: rpc,
    isRpcIdle: () => true,
    renameAliasButton: FakeSecretWindow.renameButton,
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
  static readonly renameButton = { tooltip: "Rename alias" };

  readonly infos: string[] = [];
  readonly warnings: string[] = [];

  constructor(
    private readonly inputValues: string[],
    private readonly quickPickLabels: string[] = [],
    private readonly quickPickInteractions: FakeQuickPickInteraction[] = [],
  ) {}

  showInputBox(): string | undefined {
    return this.inputValues.shift();
  }

  showQuickPick<T extends { readonly label: string }>(items: readonly T[]): T | undefined {
    const label = this.quickPickLabels.shift();
    if (label === undefined) {
      return undefined;
    }
    return items.find((item) => item.label === label);
  }

  createQuickPick<T extends { readonly label: string; readonly buttons?: readonly SecretQuickInputButton[] }>(): FakeQuickPick<T> {
    return new FakeQuickPick<T>(this.quickPickInteractions);
  }

  showInformationMessage(message: string): void {
    this.infos.push(message);
  }

  showWarningMessage(message: string): void {
    this.warnings.push(message);
  }
}

interface FakeQuickPickInteraction {
  readonly label: string;
  readonly button?: boolean;
}

class FakeQuickPick<T extends { readonly label: string; readonly buttons?: readonly SecretQuickInputButton[] }> {
  title: string | undefined;
  placeholder: string | undefined;
  ignoreFocusOut = false;
  matchOnDescription = false;
  items: readonly T[] = [];
  selectedItems: readonly T[] = [];

  private readonly acceptCallbacks: Array<() => unknown> = [];
  private readonly hideCallbacks: Array<() => unknown> = [];
  private readonly buttonCallbacks: Array<(event: SecretQuickPickItemButtonEvent<T>) => unknown> = [];

  constructor(private readonly interactions: FakeQuickPickInteraction[]) {}

  onDidAccept(callback: () => unknown): { dispose(): void } {
    this.acceptCallbacks.push(callback);
    return { dispose: () => undefined };
  }

  onDidHide(callback: () => unknown): { dispose(): void } {
    this.hideCallbacks.push(callback);
    return { dispose: () => undefined };
  }

  onDidTriggerItemButton(callback: (event: SecretQuickPickItemButtonEvent<T>) => unknown): { dispose(): void } {
    this.buttonCallbacks.push(callback);
    return { dispose: () => undefined };
  }

  show(): void {
    const interaction = this.interactions.shift();
    queueMicrotask(() => {
      if (interaction === undefined) {
        this.hide();
        return;
      }

      const item = this.items.find((candidate) => candidate.label === interaction.label);
      assert.ok(item, `${interaction.label} should exist in quick pick`);
      if (interaction.button === true) {
        const button = item.buttons?.[0];
        assert.ok(button, `${interaction.label} should have a button`);
        for (const callback of this.buttonCallbacks) {
          callback({ button, item });
        }
        return;
      }

      this.selectedItems = [item];
      for (const callback of this.acceptCallbacks) {
        callback();
      }
    });
  }

  hide(): void {
    for (const callback of this.hideCallbacks) {
      callback();
    }
  }

  dispose(): void {
    return undefined;
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

class FakeProviderConfiguration {
  constructor(readonly values: Record<string, unknown> = {}) {}

  get<T>(section: string, defaultValue: T): T {
    const value = this.values[section];
    return value === undefined ? defaultValue : (value as T);
  }

  update(section: string, value: unknown): void {
    this.values[section] = value;
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
