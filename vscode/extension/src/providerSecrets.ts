export const DEEPSEEK_API_KEY_SECRET_ID = "prole-coder.deepseek-api-key";
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";

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
): Record<string, string | undefined> {
  return resolution.apiKey === undefined ? {} : { [DEEPSEEK_API_KEY_ENV]: resolution.apiKey };
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

function normalizedSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
