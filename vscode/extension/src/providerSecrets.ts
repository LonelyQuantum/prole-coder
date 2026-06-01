export const DEEPSEEK_API_KEY_SECRET_ID = "prole-coder.deepseek-api-key";
export const DEEPSEEK_API_KEY_STORE_SECRET_ID = "prole-coder.deepseek-api-keys.v1";
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
  readonly keyAlias?: string;
  readonly redactionValues?: readonly string[];
}

export interface ResolveDeepSeekApiKeyInput {
  readonly secretValue?: string | undefined;
  readonly keyStoreValue?: string | undefined;
  readonly processEnv?: Record<string, string | undefined> | undefined;
}

export interface ResolveDeepSeekModelInput {
  readonly configuredModel?: string | undefined;
  readonly processEnv?: Record<string, string | undefined> | undefined;
}

export interface DeepSeekApiKeyEntry {
  readonly id: string;
  readonly alias: string;
  readonly apiKey: string;
}

export interface DeepSeekApiKeyStore {
  readonly selectedKeyId?: string | undefined;
  readonly entries: readonly DeepSeekApiKeyEntry[];
}

export function resolveDeepSeekApiKey(input: ResolveDeepSeekApiKeyInput): DeepSeekSecretResolution {
  const keyStore = parseDeepSeekApiKeyStore(input.keyStoreValue);
  const selectedKey = selectedDeepSeekApiKeyEntry(keyStore);
  const legacySecretValue = normalizedSecret(input.secretValue);
  const storedRedactionValues = uniqueStrings([
    ...keyStore.entries.map((entry) => entry.apiKey),
    ...(legacySecretValue === undefined ? [] : [legacySecretValue]),
  ]);

  if (selectedKey !== undefined) {
    return {
      provider: "deepseek",
      source: "secret-storage",
      apiKey: selectedKey.apiKey,
      keyAlias: selectedKey.alias,
      redactionValues: storedRedactionValues,
    };
  }

  if (legacySecretValue !== undefined) {
    return {
      provider: "deepseek",
      source: "secret-storage",
      apiKey: legacySecretValue,
      redactionValues: storedRedactionValues,
    };
  }

  const envValue = normalizedSecret(input.processEnv?.[DEEPSEEK_API_KEY_ENV]);
  if (envValue !== undefined) {
    return {
      provider: "deepseek",
      source: "process-env",
      apiKey: envValue,
      redactionValues: [envValue],
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
  return uniqueStrings([
    ...(resolution.redactionValues ?? []),
    ...(resolution.apiKey === undefined ? [] : [resolution.apiKey]),
  ]);
}

export function formatProviderSecretStatus(resolution: DeepSeekSecretResolution): string {
  const source =
    resolution.source === "secret-storage"
      ? "VS Code SecretStorage"
      : resolution.source === "process-env"
        ? "process env"
        : "missing";
  return resolution.keyAlias === undefined ? `DeepSeek API key: ${source}` : `DeepSeek API key: ${source} (${resolution.keyAlias})`;
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

export function parseDeepSeekApiKeyStore(value: string | undefined): DeepSeekApiKeyStore {
  if (value === undefined || value.trim().length === 0) {
    return emptyDeepSeekApiKeyStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return emptyDeepSeekApiKeyStore();
  }

  if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["keys"])) {
    return emptyDeepSeekApiKeyStore();
  }

  const entries: DeepSeekApiKeyEntry[] = [];
  const seenIds = new Set<string>();
  for (const item of parsed["keys"]) {
    if (!isRecord(item)) {
      continue;
    }

    const id = normalizeId(item["id"]);
    const apiKey = typeof item["apiKey"] === "string" ? normalizedSecret(item["apiKey"]) : undefined;
    if (id === undefined || apiKey === undefined || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    entries.push({
      id,
      alias: normalizeDeepSeekKeyAlias(typeof item["alias"] === "string" ? item["alias"] : undefined, "DeepSeek API key"),
      apiKey,
    });
  }

  return {
    selectedKeyId: normalizeId(parsed["selectedKeyId"]),
    entries,
  };
}

export function serializeDeepSeekApiKeyStore(store: DeepSeekApiKeyStore): string {
  const entries = validatedDeepSeekApiKeyStoreEntries(store.entries);
  return JSON.stringify({
    version: 1,
    selectedKeyId: normalizeId(store.selectedKeyId),
    keys: entries,
  });
}

export function selectedDeepSeekApiKeyEntry(
  store: DeepSeekApiKeyStore,
): DeepSeekApiKeyEntry | undefined {
  return store.entries.find((entry) => entry.id === store.selectedKeyId) ?? store.entries[0];
}

export function maskDeepSeekApiKey(value: string): string {
  const normalized = normalizedSecret(value);
  if (normalized === undefined) {
    return "";
  }
  if (normalized.length <= 8) {
    return "********";
  }
  return `${normalized.slice(0, 4)}********${normalized.slice(-4)}`;
}

export function normalizeDeepSeekKeyAlias(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized === undefined || normalized.length === 0 ? fallback : normalized.slice(0, 80);
}

export function emptyDeepSeekApiKeyStore(): DeepSeekApiKeyStore {
  return {
    entries: [],
  };
}

function normalizedSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function normalizeId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function validatedDeepSeekApiKeyStoreEntries(
  entries: readonly DeepSeekApiKeyEntry[],
): readonly DeepSeekApiKeyEntry[] {
  const seenIds = new Set<string>();
  return entries.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`DeepSeek API key store entry ${index + 1} must be an object.`);
    }

    const id = normalizeId(entry["id"]);
    if (id === undefined) {
      throw new Error(`DeepSeek API key store entry ${index + 1} must have a non-empty id.`);
    }
    if (seenIds.has(id)) {
      throw new Error(`DeepSeek API key store entry id "${id}" must be unique.`);
    }

    const apiKey = typeof entry["apiKey"] === "string" ? normalizedSecret(entry["apiKey"]) : undefined;
    if (apiKey === undefined) {
      throw new Error(`DeepSeek API key store entry "${id}" must have a non-empty apiKey.`);
    }

    seenIds.add(id);
    return {
      id,
      alias: normalizeDeepSeekKeyAlias(
        typeof entry["alias"] === "string" ? entry["alias"] : undefined,
        "DeepSeek API key",
      ),
      apiKey,
    };
  });
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
