export const DEEPSEEK_API_KEY_SECRET_ID = "prole-coder.deepseek-api-key";
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
export const DEEPSEEK_MODEL_ENV = "DEEPSEEK_MODEL";

export interface DeepSeekModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly detail: string;
}

export const DEEPSEEK_MODEL_OPTIONS: readonly DeepSeekModelOption[] = [
  {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    detail: "1M context, 384K max output",
  },
  {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    detail: "1M context, 384K max output",
  },
];

export type ProviderSecretSource = "missing" | "process-env" | "secret-storage";

export interface DeepSeekSecretResolution {
  readonly provider: "deepseek";
  readonly source: ProviderSecretSource;
  readonly apiKey?: string;
}

export interface ResolveDeepSeekApiKeyInput {
  readonly secretValue?: string | undefined;
  readonly processEnv?: Record<string, string | undefined> | undefined;
}

export interface ResolveDeepSeekModelInput {
  readonly configuredModel?: string | undefined;
  readonly processEnv?: Record<string, string | undefined> | undefined;
}

export function resolveDeepSeekApiKey(input: ResolveDeepSeekApiKeyInput): DeepSeekSecretResolution {
  const secretValue = normalizedSecret(input.secretValue);
  if (secretValue !== undefined) {
    return {
      provider: "deepseek",
      source: "secret-storage",
      apiKey: secretValue,
    };
  }

  const envValue = normalizedSecret(input.processEnv?.[DEEPSEEK_API_KEY_ENV]);
  if (envValue !== undefined) {
    return {
      provider: "deepseek",
      source: "process-env",
      apiKey: envValue,
    };
  }

  return {
    provider: "deepseek",
    source: "missing",
  };
}

export function deepSeekEnvOverride(
  resolution: DeepSeekSecretResolution,
  modelId?: string | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const normalizedModelId = normalizeDeepSeekModelId(modelId);
  if (resolution.apiKey !== undefined) {
    env[DEEPSEEK_API_KEY_ENV] = resolution.apiKey;
  }
  if (normalizedModelId !== undefined) {
    env[DEEPSEEK_MODEL_ENV] = normalizedModelId;
  }
  return env;
}

export function providerSecretRedactionValues(
  resolution: DeepSeekSecretResolution,
): readonly string[] {
  return resolution.apiKey === undefined ? [] : [resolution.apiKey];
}

export function formatProviderSecretStatus(resolution: DeepSeekSecretResolution): string {
  const source =
    resolution.source === "secret-storage"
      ? "VS Code SecretStorage"
      : resolution.source === "process-env"
        ? "process env"
        : "missing";
  return `DeepSeek API key: ${source}`;
}

export function resolveDeepSeekModel(input: ResolveDeepSeekModelInput): string | undefined {
  return (
    normalizeDeepSeekModelId(input.configuredModel) ??
    normalizeDeepSeekModelId(input.processEnv?.[DEEPSEEK_MODEL_ENV])
  );
}

export function normalizeDeepSeekModelId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

export function formatDeepSeekModelStatus(modelId: string | undefined): string {
  const normalized = normalizeDeepSeekModelId(modelId);
  if (normalized === undefined) {
    return "DeepSeek model: provider default";
  }
  const option = DEEPSEEK_MODEL_OPTIONS.find((model) => model.id === normalized);
  return option === undefined
    ? `DeepSeek model: ${normalized}`
    : `DeepSeek model: ${option.displayName} (${option.id})`;
}

function normalizedSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
