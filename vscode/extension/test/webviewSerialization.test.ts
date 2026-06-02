import assert from "node:assert/strict";
import test from "node:test";

import { safeScriptJson } from "../src/webviewSerialization.js";

test("safeScriptJson serializes undefined as a script-safe literal", () => {
  assert.equal(safeScriptJson(undefined), "undefined");
});

test("safeScriptJson escapes script-breaking less-than characters", () => {
  assert.equal(
    safeScriptJson({
      value: "</script>",
    }),
    '{"value":"\\u003c/script>"}',
  );
});
