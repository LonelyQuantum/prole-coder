import {
  DEEPSEEK_API_KEY_SECRET_ID,
  deepSeekEnvOverride,
  formatProviderSecretStatus,
  providerSecretRedactionValues,
  resolveDeepSeekApiKey,
  type DeepSeekSecretResolution,
} from "./providerSecrets";
import type { MutableSecretRedactor } from "./redaction";

export const CONFIGURE_DEEPSEEK_API_KEY_COMMAND = "prole-coder.configureDeepSeekApiKey";
export const CLEAR_DEEPSEEK_API_KEY_COMMAND = "prole-coder.clearDeepSeekApiKey";
export const SHOW_PROVIDER_STATUS_COMMAND = "prole-coder.showProviderStatus";

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
  showInformationMessage(message: string): unknown;
  showWarningMessage(message: string): unknown;
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
}

export interface ProviderSecretRuntimeState {
  status: DeepSeekSecretResolution;
}

export function registerProviderSecretCommands(
  options: RegisterProviderSecretCommandOptions,
): readonly DisposableLike[] {
  const state: ProviderSecretRuntimeState = {
    status: resolveDeepSeekApiKey({ processEnv: options.processEnv }),
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
      return options.window.showInformationMessage(formatProviderSecretStatus(status));
    }),
  ];
}

export async function refreshProviderSecretState(
  options: Pick<RegisterProviderSecretCommandOptions, "processEnv" | "redactor" | "rpcServer" | "secrets">,
  state?: ProviderSecretRuntimeState,
): Promise<DeepSeekSecretResolution> {
  const secretValue = await options.secrets.get(DEEPSEEK_API_KEY_SECRET_ID);
  const status = resolveDeepSeekApiKey({
    secretValue,
    processEnv: options.processEnv,
  });
  options.rpcServer?.setProcessEnv(deepSeekEnvOverride(status));
  options.redactor?.update(providerSecretRedactionValues(status));
  if (state !== undefined) {
    state.status = status;
  }
  return status;
}

async function restartRpcAfterSecretChange(
  options: Pick<RegisterProviderSecretCommandOptions, "isRpcIdle" | "redactor" | "rpcServer" | "window">,
  prefix: string,
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
      redactMessage(`DeepSeek API key updated, but RPC restart failed: ${errorMessage(error)}`, options.redactor),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactMessage(message: string, redactor: MutableSecretRedactor | undefined): string {
  return redactor?.redact(message) ?? message;
}
