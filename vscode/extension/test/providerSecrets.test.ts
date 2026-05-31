import assert from "node:assert/strict";
import test from "node:test";

import {
  DEEPSEEK_API_KEY_ENV,
  deepSeekEnvOverride,
  formatProviderSecretStatus,
  providerSecretRedactionValues,
  resolveDeepSeekApiKey,
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
  assert.deepEqual(providerSecretRedactionValues(resolution), ["secret-storage-key"]);
  assert.equal(formatProviderSecretStatus(resolution), "DeepSeek API key: VS Code SecretStorage");
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
