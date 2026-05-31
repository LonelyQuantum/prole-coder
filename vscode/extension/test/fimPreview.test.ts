import assert from "node:assert/strict";
import test from "node:test";

import { buildFimPreviewParams, selectFimModel } from "../src/fimPreview.js";

test("buildFimPreviewParams trims context by cursor offset and capability model", () => {
  const params = buildFimPreviewParams({
    text: "0123456789CURSORsuffix",
    offset: 10,
    path: "src/main.rs",
    languageId: "rust",
    configuredModel: "",
    maxTokens: 64,
    maxContextChars: 5,
    capabilities: capabilities(),
  });

  assert.deepEqual(params, {
    prefix: "56789",
    suffix: "CURSO",
    path: "src/main.rs",
    languageId: "rust",
    model: "deepseek-v4-pro",
    maxTokens: 64,
  });
});

test("buildFimPreviewParams rejects unsupported configured FIM model", () => {
  const params = buildFimPreviewParams({
    text: "prefix",
    offset: 6,
    configuredModel: "no-fim-model",
    maxContextChars: 100,
    capabilities: capabilities(),
  });

  assert.equal(params, undefined);
});

test("selectFimModel uses server capability flags without name inference", () => {
  assert.equal(selectFimModel(capabilities(), "deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(selectFimModel(capabilities(), "deepseek-v4-flash"), undefined);
});

function capabilities() {
  return {
    protocolVersion: "0.1.0",
    supportsRunResume: true,
    supportsPatchApproval: true,
    supportsPersistentApprovals: true,
    supportsEventBatching: true,
    supportedRiskLevels: ["read", "write", "exec", "network", "destructive"],
    provider: {
      provider: "deepseek",
      defaultModel: "deepseek-v4-pro",
      models: [
        {
          id: "deepseek-v4-pro",
          contextWindowTokens: 1_048_576,
          maxOutputTokens: 393_216,
          supportsThinking: true,
          supportsToolCalls: true,
          supportsToolChoice: false,
          supportsFim: true,
          supportsStreaming: true,
          reportsCacheUsage: true,
        },
        {
          id: "deepseek-v4-flash",
          displayName: "No FIM fixture",
          contextWindowTokens: 1_048_576,
          maxOutputTokens: 393_216,
          supportsThinking: true,
          supportsToolCalls: true,
          supportsToolChoice: false,
          supportsFim: false,
          supportsStreaming: true,
          reportsCacheUsage: true,
        },
        {
          id: "no-fim-model",
          contextWindowTokens: 128,
          maxOutputTokens: 64,
          supportsThinking: false,
          supportsToolCalls: false,
          supportsToolChoice: false,
          supportsFim: false,
          supportsStreaming: false,
          reportsCacheUsage: false,
        },
      ],
    },
  } as const;
}

