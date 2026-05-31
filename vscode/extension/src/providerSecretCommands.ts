import {
  DEEPSEEK_API_KEY_SECRET_ID,
  DEEPSEEK_MODEL_OPTIONS,
  deepSeekEnvOverride,
  formatDeepSeekModelStatus,
  formatProviderSecretStatus,
  normalizeDeepSeekModelId,
  providerSecretRedactionValues,
  resolveDeepSeekApiKey,
  resolveDeepSeekModel,
  type DeepSeekSecretResolution,
} from "./providerSecrets";
import type { MutableSecretRedactor } from "./redaction";

export const CONFIGURE_DEEPSEEK_API_KEY_COMMAND = "prole-coder.configureDeepSeekApiKey";
export const CLEAR_DEEPSEEK_API_KEY_COMMAND = "prole-coder.clearDeepSeekApiKey";
export const SHOW_PROVIDER_STATUS_COMMAND = "prole-coder.showProviderStatus";
export const SELECT_DEEPSEEK_MODEL_COMMAND = "prole-coder.selectDeepSeekModel";

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
    readonly password: true;
    readonly prompt: string;
    readonly title: string;
  }): string | undefined | PromiseLike<string | undefined>;
  showQuickPick<T extends SecretQuickPickItem>(
    items: readonly T[],
    options: {
      readonly ignoreFocusOut: true;
      readonly placeHolder: string;
      readonly title: string;
    },
  ): T | undefined | PromiseLike<T | undefined>;
  showInformationMessage(message: string): unknown;
  showWarningMessage(message: string): unknown;
}

export interface SecretQuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
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
      const value = await options.window.showInputBox({
        title: "Configure DeepSeek API Key",
        prompt: "Enter the DeepSeek API key for ProleCoder. It is stored in VS Code SecretStorage.",
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return undefined;
      }

      const normalized = value.trim();
      if (normalized.length === 0) {
        return options.window.showWarningMessage("DeepSeek API key was not changed.");
      }

      await options.secrets.store(DEEPSEEK_API_KEY_SECRET_ID, normalized);
      const status = await refreshProviderSecretState(options, state);
      await restartRpcAfterSecretChange(options, "DeepSeek API key saved.");
      return options.window.showInformationMessage(formatProviderSecretStatus(status));
    }),
    options.commands.registerCommand(CLEAR_DEEPSEEK_API_KEY_COMMAND, async () => {
      await options.secrets.delete(DEEPSEEK_API_KEY_SECRET_ID);
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
  const secretValue = await options.secrets.get(DEEPSEEK_API_KEY_SECRET_ID);
  const status = resolveDeepSeekApiKey({
    secretValue,
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
