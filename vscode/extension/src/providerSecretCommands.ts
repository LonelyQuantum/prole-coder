import { randomUUID } from "node:crypto";

import {
  DEEPSEEK_API_KEY_STORE_SECRET_ID,
  DEEPSEEK_API_KEY_SECRET_ID,
  DEEPSEEK_MODEL_OPTIONS,
  deepSeekEnvOverride,
  formatDeepSeekModelStatus,
  formatProviderSecretStatus,
  maskDeepSeekApiKey,
  normalizeDeepSeekKeyAlias,
  normalizeDeepSeekModelId,
  parseDeepSeekApiKeyStore,
  providerSecretRedactionValues,
  resolveDeepSeekApiKey,
  resolveDeepSeekModel,
  selectedDeepSeekApiKeyEntry,
  serializeDeepSeekApiKeyStore,
  type DeepSeekApiKeyEntry,
  type DeepSeekApiKeyStore,
  type DeepSeekSecretResolution,
} from "./providerSecrets";
import type { MutableSecretRedactor } from "./redaction";

export const CONFIGURE_DEEPSEEK_API_KEY_COMMAND = "prole-coder.configureDeepSeekApiKey";
export const CLEAR_DEEPSEEK_API_KEY_COMMAND = "prole-coder.clearDeepSeekApiKey";
export const SHOW_PROVIDER_STATUS_COMMAND = "prole-coder.showProviderStatus";
export const SELECT_DEEPSEEK_MODEL_COMMAND = "prole-coder.selectDeepSeekModel";
const DELETE_DEEPSEEK_API_KEY_CONFIRM_LABEL = "Delete";

export interface CommandRegistry {
  registerCommand(command: string, callback: () => unknown): DisposableLike;
}

export interface DisposableLike {
  dispose(): unknown;
}

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface SecretWindowMessenger {
  showInputBox(options: {
    readonly ignoreFocusOut: true;
    readonly password?: boolean;
    readonly placeHolder?: string;
    readonly prompt: string;
    readonly title: string;
    readonly value?: string;
  }): string | undefined | PromiseLike<string | undefined>;
  showQuickPick<T extends SecretQuickPickItem>(
    items: readonly T[],
    options: {
      readonly ignoreFocusOut: true;
      readonly placeHolder: string;
      readonly title: string;
    },
  ): T | undefined | PromiseLike<T | undefined>;
  createQuickPick<T extends SecretQuickPickItem>(): SecretQuickPickController<T>;
  showInformationMessage(message: string): unknown;
  showWarningMessage(message: string, ...items: readonly string[]): unknown;
}

export interface SecretQuickInputButton {
  readonly iconPath?: unknown;
  readonly tooltip?: string;
}

export interface SecretQuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly buttons?: readonly SecretQuickInputButton[];
  readonly alwaysShow?: boolean;
}

export interface SecretQuickPickItemButtonEvent<T extends SecretQuickPickItem> {
  readonly button: SecretQuickInputButton;
  readonly item: T;
}

export interface SecretQuickPickController<T extends SecretQuickPickItem> extends DisposableLike {
  title: string | undefined;
  placeholder: string | undefined;
  ignoreFocusOut: boolean;
  matchOnDescription: boolean;
  items: readonly T[];
  readonly selectedItems: readonly T[];
  onDidAccept(callback: () => unknown): DisposableLike;
  onDidHide(callback: () => unknown): DisposableLike;
  onDidTriggerItemButton(callback: (event: SecretQuickPickItemButtonEvent<T>) => unknown): DisposableLike;
  show(): void;
  hide(): void;
}

export interface ProviderConfigurationLike {
  get<T>(section: string, defaultValue: T): T;
  update(section: string, value: unknown, configurationTarget?: unknown): PromiseLike<void> | void;
}

export interface ProviderSecretRpcServer {
  readonly status: string;
  setProcessEnv(env: Record<string, string | undefined>): void;
  start(): Promise<unknown>;
  stop(): void;
}

export interface RegisterProviderSecretCommandOptions {
  readonly commands: CommandRegistry;
  readonly window: SecretWindowMessenger;
  readonly secrets: SecretStorageLike;
  readonly processEnv?: Record<string, string | undefined> | undefined;
  readonly redactor?: MutableSecretRedactor;
  readonly rpcServer?: ProviderSecretRpcServer | undefined;
  readonly isRpcIdle?: () => boolean;
  readonly providerConfiguration?: ProviderConfigurationLike | undefined;
  readonly configurationTarget?: unknown;
  readonly renameAliasButton?: SecretQuickInputButton | undefined;
  readonly deleteKeyButton?: SecretQuickInputButton | undefined;
}

export interface ProviderSecretRuntimeState {
  status: DeepSeekSecretResolution;
  modelId?: string | undefined;
}

export function registerProviderSecretCommands(
  options: RegisterProviderSecretCommandOptions,
): readonly DisposableLike[] {
  const state: ProviderSecretRuntimeState = {
    status: resolveDeepSeekApiKey({ processEnv: options.processEnv }),
    modelId: currentDeepSeekModel(options),
  };

  void refreshProviderSecretState(options, state);

  return [
    options.commands.registerCommand(CONFIGURE_DEEPSEEK_API_KEY_COMMAND, async () => {
      return showDeepSeekApiKeyManager(options, state);
    }),
    options.commands.registerCommand(CLEAR_DEEPSEEK_API_KEY_COMMAND, async () => {
      await clearSelectedDeepSeekApiKey(options);
      const status = await refreshProviderSecretState(options, state);
      await restartRpcAfterSecretChange(options, "DeepSeek API key cleared.");
      return options.window.showInformationMessage(formatProviderSecretStatus(status));
    }),
    options.commands.registerCommand(SHOW_PROVIDER_STATUS_COMMAND, async () => {
      const status = await refreshProviderSecretState(options, state);
      return options.window.showInformationMessage(
        `${formatProviderSecretStatus(status)}; ${formatDeepSeekModelStatus(state.modelId)}`,
      );
    }),
    options.commands.registerCommand(SELECT_DEEPSEEK_MODEL_COMMAND, async () => {
      const item = await options.window.showQuickPick(deepSeekModelPickItems(state.modelId), {
        title: "Select DeepSeek Model",
        placeHolder: "Choose the DeepSeek model used for chat and agent turns.",
        ignoreFocusOut: true,
      });
      if (item === undefined) {
        return undefined;
      }

      const modelId = normalizeDeepSeekModelId(item.modelId);
      if (modelId === undefined) {
        return options.window.showWarningMessage("DeepSeek model was not changed.");
      }

      state.modelId = modelId;
      await options.providerConfiguration?.update("model", modelId, options.configurationTarget);
      const status = await refreshProviderSecretState(options, state);
      await restartRpcAfterProviderChange(options, "DeepSeek model updated.", "DeepSeek model updated");
      options.window.showInformationMessage(formatDeepSeekModelStatus(modelId));
      return status;
    }),
  ];
}

export async function refreshProviderSecretState(
  options: Pick<
    RegisterProviderSecretCommandOptions,
    "processEnv" | "providerConfiguration" | "redactor" | "rpcServer" | "secrets"
  >,
  state?: ProviderSecretRuntimeState,
): Promise<DeepSeekSecretResolution> {
  const [secretValue, keyStoreValue] = await Promise.all([
    options.secrets.get(DEEPSEEK_API_KEY_SECRET_ID),
    options.secrets.get(DEEPSEEK_API_KEY_STORE_SECRET_ID),
  ]);
  const status = resolveDeepSeekApiKey({
    secretValue,
    keyStoreValue,
    processEnv: options.processEnv,
  });
  const modelId = state?.modelId ?? currentDeepSeekModel(options);
  options.rpcServer?.setProcessEnv(deepSeekEnvOverride(status, modelId));
  options.redactor?.update(providerSecretRedactionValues(status));
  if (state !== undefined) {
    state.status = status;
    state.modelId = modelId;
  }
  return status;
}

async function restartRpcAfterProviderChange(
  options: Pick<RegisterProviderSecretCommandOptions, "isRpcIdle" | "redactor" | "rpcServer" | "window">,
  prefix: string,
  failurePrefix: string,
): Promise<void> {
  const rpcServer = options.rpcServer;
  if (rpcServer === undefined || rpcServer.status === "stopped" || rpcServer.status === "failed") {
    return;
  }

  if (rpcServer.status !== "ready") {
    options.window.showInformationMessage(`${prefix} It will be used after the RPC server restarts.`);
    return;
  }

  if (options.isRpcIdle?.() === false) {
    options.window.showInformationMessage(`${prefix} It will be used after the current turn finishes.`);
    return;
  }

  rpcServer.stop();
  try {
    await rpcServer.start();
  } catch (error) {
    options.window.showWarningMessage(
      redactMessage(`${failurePrefix}, but RPC restart failed: ${errorMessage(error)}`, options.redactor),
    );
  }
}

async function restartRpcAfterSecretChange(
  options: Pick<RegisterProviderSecretCommandOptions, "isRpcIdle" | "redactor" | "rpcServer" | "window">,
  prefix: string,
): Promise<void> {
  await restartRpcAfterProviderChange(options, prefix, "DeepSeek API key updated");
}

async function showDeepSeekApiKeyManager(
  options: RegisterProviderSecretCommandOptions,
  state: ProviderSecretRuntimeState,
): Promise<DeepSeekSecretResolution | undefined> {
  let store = await readDeepSeekApiKeyStore(options.secrets);
  const quickPick = options.window.createQuickPick<DeepSeekApiKeyPickItem>();
  quickPick.title = "Select DeepSeek API Key";
  quickPick.placeholder = "Choose a key, add one, or use item buttons to rename or delete.";
  quickPick.ignoreFocusOut = true;
  quickPick.matchOnDescription = true;
  quickPick.items = deepSeekApiKeyPickItems(store, {
    deleteKeyButton: options.deleteKeyButton,
    renameAliasButton: options.renameAliasButton,
  });

  return new Promise((resolve) => {
    let finished = false;
    let actionInProgress = false;
    const disposables: DisposableLike[] = [];

    const finish = (value: DeepSeekSecretResolution | undefined): void => {
      if (finished) {
        return;
      }
      finished = true;
      for (const disposable of disposables) {
        disposable.dispose();
      }
      quickPick.dispose();
      resolve(value);
    };

    disposables.push(
      quickPick.onDidHide(() => {
        if (!actionInProgress) {
          finish(undefined);
        }
      }),
      quickPick.onDidAccept(() => {
        const item = quickPick.selectedItems[0];
        if (item === undefined) {
          return;
        }
        actionInProgress = true;
        quickPick.hide();
        void (async () => {
          if (item.kind === "add") {
            finish(await addDeepSeekApiKey(options, state, store));
            return;
          }

          store = {
            ...store,
            selectedKeyId: item.keyId,
          };
          await saveDeepSeekApiKeyStore(options.secrets, store);
          const status = await refreshProviderSecretState(options, state);
          await restartRpcAfterSecretChange(options, "DeepSeek API key selected.");
          options.window.showInformationMessage(formatProviderSecretStatus(status));
          finish(status);
        })();
      }),
      quickPick.onDidTriggerItemButton((event) => {
        if (event.item.kind !== "key") {
          return;
        }

        actionInProgress = true;
        quickPick.hide();
        void (async () => {
          finish(
            event.button === options.deleteKeyButton
              ? await deleteDeepSeekApiKey(options, state, store, event.item.keyId)
              : await renameDeepSeekApiKeyAlias(options, state, store, event.item.keyId),
          );
        })();
      }),
    );

    quickPick.show();
  });
}

async function addDeepSeekApiKey(
  options: RegisterProviderSecretCommandOptions,
  state: ProviderSecretRuntimeState,
  store: DeepSeekApiKeyStore,
): Promise<DeepSeekSecretResolution | undefined> {
  const aliasValue = await options.window.showInputBox({
    title: "Add DeepSeek API Key",
    prompt: "Enter an alias for this key.",
    placeHolder: "Personal account",
    value: `DeepSeek key ${store.entries.length + 1}`,
    ignoreFocusOut: true,
  });
  if (aliasValue === undefined) {
    return undefined;
  }

  const apiKeyValue = await options.window.showInputBox({
    title: "Add DeepSeek API Key",
    prompt: "Enter the DeepSeek API key. It is stored in VS Code SecretStorage.",
    password: true,
    ignoreFocusOut: true,
  });
  if (apiKeyValue === undefined) {
    return undefined;
  }

  const apiKey = apiKeyValue.trim();
  if (apiKey.length === 0) {
    options.window.showWarningMessage("DeepSeek API key was not changed.");
    return undefined;
  }

  const entry: DeepSeekApiKeyEntry = {
    id: randomUUID(),
    alias: normalizeDeepSeekKeyAlias(aliasValue, `DeepSeek key ${store.entries.length + 1}`),
    apiKey,
  };
  const nextStore: DeepSeekApiKeyStore = {
    selectedKeyId: entry.id,
    entries: [...store.entries, entry],
  };
  await saveDeepSeekApiKeyStore(options.secrets, nextStore);
  const status = await refreshProviderSecretState(options, state);
  await restartRpcAfterSecretChange(options, "DeepSeek API key saved.");
  options.window.showInformationMessage(formatProviderSecretStatus(status));
  return status;
}

async function renameDeepSeekApiKeyAlias(
  options: RegisterProviderSecretCommandOptions,
  state: ProviderSecretRuntimeState,
  store: DeepSeekApiKeyStore,
  keyId: string,
): Promise<DeepSeekSecretResolution | undefined> {
  const entry = store.entries.find((candidate) => candidate.id === keyId);
  if (entry === undefined) {
    return undefined;
  }

  const aliasValue = await options.window.showInputBox({
    title: "Rename DeepSeek API Key",
    prompt: "Enter a new alias for this key.",
    value: entry.alias,
    ignoreFocusOut: true,
  });
  if (aliasValue === undefined) {
    return undefined;
  }

  const alias = normalizeDeepSeekKeyAlias(aliasValue, entry.alias);
  const nextStore: DeepSeekApiKeyStore = {
    selectedKeyId: store.selectedKeyId,
    entries: store.entries.map((candidate) => (candidate.id === keyId ? { ...candidate, alias } : candidate)),
  };
  await saveDeepSeekApiKeyStore(options.secrets, nextStore);
  const status = await refreshProviderSecretState(options, state);
  options.window.showInformationMessage(`DeepSeek API key alias updated: ${alias}`);
  return status;
}

async function deleteDeepSeekApiKey(
  options: RegisterProviderSecretCommandOptions,
  state: ProviderSecretRuntimeState,
  store: DeepSeekApiKeyStore,
  keyId: string,
): Promise<DeepSeekSecretResolution | undefined> {
  const entry = store.entries.find((candidate) => candidate.id === keyId);
  if (entry === undefined) {
    return undefined;
  }

  const confirmation = await options.window.showWarningMessage(
    `Delete DeepSeek API key "${entry.alias}"?`,
    DELETE_DEEPSEEK_API_KEY_CONFIRM_LABEL,
  );
  if (confirmation !== DELETE_DEEPSEEK_API_KEY_CONFIRM_LABEL) {
    return undefined;
  }

  const activeKeyId = selectedDeepSeekApiKeyEntry(store)?.id;
  const entries = store.entries.filter((candidate) => candidate.id !== keyId);
  const nextSelectedKeyId =
    activeKeyId === keyId
      ? entries[0]?.id
      : entries.some((candidate) => candidate.id === store.selectedKeyId)
        ? store.selectedKeyId
        : entries[0]?.id;
  await saveDeepSeekApiKeyStore(options.secrets, {
    selectedKeyId: nextSelectedKeyId,
    entries,
  });
  const status = await refreshProviderSecretState(options, state);
  if (activeKeyId === keyId) {
    await restartRpcAfterSecretChange(options, "DeepSeek API key deleted.");
  }
  options.window.showInformationMessage(`DeepSeek API key deleted: ${entry.alias}`);
  return status;
}

async function clearSelectedDeepSeekApiKey(
  options: Pick<RegisterProviderSecretCommandOptions, "secrets">,
): Promise<void> {
  const store = await readDeepSeekApiKeyStore(options.secrets);
  const selected = selectedDeepSeekApiKeyEntry(store);
  if (selected === undefined) {
    await options.secrets.delete(DEEPSEEK_API_KEY_SECRET_ID);
    await options.secrets.delete(DEEPSEEK_API_KEY_STORE_SECRET_ID);
    return;
  }

  const entries = store.entries.filter((entry) => entry.id !== selected.id);
  await saveDeepSeekApiKeyStore(options.secrets, {
    selectedKeyId: entries[0]?.id,
    entries,
  });
}

async function readDeepSeekApiKeyStore(
  secrets: SecretStorageLike,
): Promise<DeepSeekApiKeyStore> {
  const [keyStoreValue, legacySecretValue] = await Promise.all([
    secrets.get(DEEPSEEK_API_KEY_STORE_SECRET_ID),
    secrets.get(DEEPSEEK_API_KEY_SECRET_ID),
  ]);
  const store = parseDeepSeekApiKeyStore(keyStoreValue);
  if (store.entries.length > 0) {
    return store;
  }

  const legacySecret = legacySecretValue?.trim();
  if (legacySecret === undefined || legacySecret.length === 0) {
    return store;
  }

  return {
    selectedKeyId: "legacy",
    entries: [
      {
        id: "legacy",
        alias: "Default key",
        apiKey: legacySecret,
      },
    ],
  };
}

async function saveDeepSeekApiKeyStore(
  secrets: SecretStorageLike,
  store: DeepSeekApiKeyStore,
): Promise<void> {
  if (store.entries.length === 0) {
    await secrets.delete(DEEPSEEK_API_KEY_STORE_SECRET_ID);
  } else {
    await secrets.store(DEEPSEEK_API_KEY_STORE_SECRET_ID, serializeDeepSeekApiKeyStore(store));
  }
  await secrets.delete(DEEPSEEK_API_KEY_SECRET_ID);
}

interface DeepSeekApiKeyPickItem extends SecretQuickPickItem {
  readonly kind: "add" | "key";
  readonly keyId: string;
}

function deepSeekApiKeyPickItems(
  store: DeepSeekApiKeyStore,
  buttons: {
    readonly deleteKeyButton?: SecretQuickInputButton | undefined;
    readonly renameAliasButton?: SecretQuickInputButton | undefined;
  },
): readonly DeepSeekApiKeyPickItem[] {
  const selected = selectedDeepSeekApiKeyEntry(store);
  const keyItems = store.entries.map((entry) => ({
    label: entry.alias,
    description: `${maskDeepSeekApiKey(entry.apiKey)}${entry.id === selected?.id ? " (current)" : ""}`,
    detail: "Stored in VS Code SecretStorage",
    buttons: [buttons.renameAliasButton, buttons.deleteKeyButton].filter(
      (button): button is SecretQuickInputButton => button !== undefined,
    ),
    kind: "key" as const,
    keyId: entry.id,
  }));
  return [
    ...keyItems,
    {
      label: "+ Add DeepSeek API Key",
      description: "Store a new key and alias in VS Code SecretStorage",
      alwaysShow: true,
      kind: "add",
      keyId: "__add__",
    },
  ];
}

function currentDeepSeekModel(
  options: Pick<RegisterProviderSecretCommandOptions, "processEnv" | "providerConfiguration">,
): string | undefined {
  const configuredModel = options.providerConfiguration?.get<unknown>("model", "");
  return resolveDeepSeekModel({
    configuredModel: typeof configuredModel === "string" ? configuredModel : "",
    processEnv: options.processEnv,
  });
}

interface DeepSeekModelPickItem extends SecretQuickPickItem {
  readonly modelId: string;
}

function deepSeekModelPickItems(currentModelId: string | undefined): readonly DeepSeekModelPickItem[] {
  const current = normalizeDeepSeekModelId(currentModelId);
  return DEEPSEEK_MODEL_OPTIONS.map((model) => ({
    label: model.displayName,
    description: model.id === current ? `${model.id} (current)` : model.id,
    detail: model.detail,
    modelId: model.id,
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactMessage(message: string, redactor: MutableSecretRedactor | undefined): string {
  return redactor?.redact(message) ?? message;
}
