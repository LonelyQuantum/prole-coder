import assert from "node:assert/strict";
import test from "node:test";

import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_API_KEY_STORE_SECRET_ID,
  DEEPSEEK_MODEL_ENV,
  deepSeekEnvOverride,
  formatDeepSeekModelStatus,
  formatProviderSecretStatus,
  maskDeepSeekApiKey,
  parseDeepSeekApiKeyStore,
  providerSecretRedactionValues,
  resolveDeepSeekApiKey,
  resolveDeepSeekModel,
  serializeDeepSeekApiKeyStore,
} from "../src/providerSecrets.js";

test("resolveDeepSeekApiKey prefers SecretStorage over process env", () => {
  const resolution = resolveDeepSeekApiKey({
    secretValue: " secret-storage-key ",
    processEnv: {
      [DEEPSEEK_API_KEY_ENV]: "env-key",
    },
  });

  assert.equal(resolution.source, "secret-storage");
  assert.equal(resolution.apiKey, "secret-storage-key");
  assert.deepEqual(deepSeekEnvOverride(resolution), {
    [DEEPSEEK_API_KEY_ENV]: "secret-storage-key",
  });
  assert.deepEqual(deepSeekEnvOverride(resolution, " deepseek-v4-flash "), {
    [DEEPSEEK_API_KEY_ENV]: "secret-storage-key",
    [DEEPSEEK_MODEL_ENV]: "deepseek-v4-flash",
  });
  assert.deepEqual(providerSecretRedactionValues(resolution), ["secret-storage-key"]);
  assert.equal(formatProviderSecretStatus(resolution), "DeepSeek API key: VS Code SecretStorage");
});

test("resolveDeepSeekApiKey selects stored key aliases and redacts every stored key", () => {
  const keyStoreValue = serializeDeepSeekApiKeyStore({
    selectedKeyId: "work",
    entries: [
      {
        id: "personal",
        alias: "Personal",
        apiKey: "personal-secret-value",
      },
      {
        id: "work",
        alias: "Work",
        apiKey: "work-secret-value",
      },
    ],
  });

  const store = parseDeepSeekApiKeyStore(keyStoreValue);
  assert.equal(store.entries.length, 2);
  assert.equal(maskDeepSeekApiKey("work-secret-value"), "work********alue");

  const resolution = resolveDeepSeekApiKey({
    keyStoreValue,
    secretValue: "legacy-secret-value",
    processEnv: {
      [DEEPSEEK_API_KEY_ENV]: "env-secret-value",
    },
  });

  assert.equal(resolution.source, "secret-storage");
  assert.equal(resolution.apiKey, "work-secret-value");
  assert.equal(resolution.keyAlias, "Work");
  assert.equal(formatProviderSecretStatus(resolution), "DeepSeek API key: VS Code SecretStorage (Work)");
  assert.deepEqual(providerSecretRedactionValues(resolution), [
    "personal-secret-value",
    "work-secret-value",
    "legacy-secret-value",
  ]);
  assert.deepEqual(deepSeekEnvOverride(resolution), {
    [DEEPSEEK_API_KEY_ENV]: "work-secret-value",
  });
  assert.ok(keyStoreValue.includes(DEEPSEEK_API_KEY_STORE_SECRET_ID) === false);
});

test("serializeDeepSeekApiKeyStore validates entries before writing", () => {
  assert.throws(
    () =>
      serializeDeepSeekApiKeyStore({
        entries: [
          {
            id: "empty",
            alias: "Empty",
            apiKey: " ",
          },
        ],
      }),
    /non-empty apiKey/,
  );
  assert.throws(
    () =>
      serializeDeepSeekApiKeyStore({
        entries: [
          {
            id: "duplicate",
            alias: "First",
            apiKey: "first-secret-value",
          },
          {
            id: "duplicate",
            alias: "Second",
            apiKey: "second-secret-value",
          },
        ],
      }),
    /must be unique/,
  );

  const serialized = serializeDeepSeekApiKeyStore({
    selectedKeyId: " work ",
    entries: [
      {
        id: " work ",
        alias: " Work   Key ",
        apiKey: " work-secret-value ",
      },
    ],
  });

  assert.deepEqual(parseDeepSeekApiKeyStore(serialized), {
    selectedKeyId: "work",
    entries: [
      {
        id: "work",
        alias: "Work Key",
        apiKey: "work-secret-value",
      },
    ],
  });
});

test("resolveDeepSeekApiKey falls back to process env and reports missing", () => {
  const envResolution = resolveDeepSeekApiKey({
    processEnv: {
      [DEEPSEEK_API_KEY_ENV]: " env-key ",
    },
  });

  assert.equal(envResolution.source, "process-env");
  assert.equal(envResolution.apiKey, "env-key");
  assert.equal(formatProviderSecretStatus(envResolution), "DeepSeek API key: process env");

  const missingResolution = resolveDeepSeekApiKey({
    secretValue: " ",
    processEnv: {
      [DEEPSEEK_API_KEY_ENV]: "",
    },
  });

  assert.equal(missingResolution.source, "missing");
  assert.deepEqual(deepSeekEnvOverride(missingResolution), {});
  assert.deepEqual(providerSecretRedactionValues(missingResolution), []);
  assert.equal(formatProviderSecretStatus(missingResolution), "DeepSeek API key: missing");
});

test("resolveDeepSeekModel prefers configured model over process env", () => {
  assert.equal(
    resolveDeepSeekModel({
      configuredModel: " deepseek-v4-pro ",
      processEnv: {
        [DEEPSEEK_MODEL_ENV]: "deepseek-v4-flash",
      },
    }),
    "deepseek-v4-pro",
  );
  assert.equal(
    resolveDeepSeekModel({
      configuredModel: "",
      processEnv: {
        [DEEPSEEK_MODEL_ENV]: " deepseek-v4-flash ",
      },
    }),
    "deepseek-v4-flash",
  );
  assert.equal(resolveDeepSeekModel({ configuredModel: " ", processEnv: {} }), undefined);
  assert.equal(
    formatDeepSeekModelStatus("deepseek-v4-pro"),
    "DeepSeek model: DeepSeek V4 Pro (deepseek-v4-pro)",
  );
});
