import assert from "node:assert/strict";
import test from "node:test";

import { isDeepSeekApiKeyRequiredMessage } from "../src/providerConfigurationUx.js";

test("isDeepSeekApiKeyRequiredMessage detects missing DeepSeek API key errors", () => {
  assert.equal(
    isDeepSeekApiKeyRequiredMessage(
      "DeepSeek provider configuration failed: DEEPSEEK_API_KEY is required",
    ),
    true,
  );
  assert.equal(isDeepSeekApiKeyRequiredMessage("OpenAI API key is required"), false);
  assert.equal(isDeepSeekApiKeyRequiredMessage("DeepSeek request failed with status 401"), false);
});
