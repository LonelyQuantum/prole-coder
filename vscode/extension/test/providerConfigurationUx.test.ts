import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL,
  providerConfigurationActionFromError,
  providerConfigurationActionFromMetadata,
  providerConfigurationActionFromPayload,
} from "../src/providerConfigurationUx.js";

test("providerConfigurationActionFromError reads structured RPC recovery data", () => {
  const error = {
    data: {
      provider: "deepseek",
      configurationError: "missingApiKey",
      recoverableAction: {
        kind: "configureDeepSeekApiKey",
        label: CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL,
      },
    },
  };

  assert.deepEqual(providerConfigurationActionFromError(error), {
    type: "configureDeepSeekApiKey",
    label: CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL,
  });
  assert.equal(
    providerConfigurationActionFromError(
      new Error("DeepSeek provider configuration failed: DEEPSEEK_API_KEY is required"),
    ),
    undefined,
  );
});

test("providerConfigurationActionFromPayload reads run failed recovery data", () => {
  assert.deepEqual(
    providerConfigurationActionFromPayload({
      code: "E_PROVIDER_ERROR",
      recoverableAction: {
        kind: "configureDeepSeekApiKey",
        label: CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL,
      },
    }),
    {
      type: "configureDeepSeekApiKey",
      label: CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL,
    },
  );
});

test("providerConfigurationActionFromMetadata reads chat participant actions", () => {
  assert.deepEqual(
    providerConfigurationActionFromMetadata({
      providerConfigurationAction: {
        type: "configureDeepSeekApiKey",
        label: CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL,
      },
    }),
    {
      type: "configureDeepSeekApiKey",
      label: CONFIGURE_DEEPSEEK_API_KEY_ACTION_LABEL,
    },
  );
});
