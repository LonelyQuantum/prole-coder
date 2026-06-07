import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { Script, runInNewContext } from "node:vm";

import { WEBVIEW_MARKDOWN_RENDERER_SCRIPT } from "../src/webviewMarkdown.js";

test("webview markdown renderer script export exposes expected entrypoint", () => {
  assert.ok(WEBVIEW_MARKDOWN_RENDERER_SCRIPT.trim().length > 0);
  assert.match(WEBVIEW_MARKDOWN_RENDERER_SCRIPT, /function appendMarkdownBlocks\(/);
  assert.match(WEBVIEW_MARKDOWN_RENDERER_SCRIPT, /function safeMarkdownHref\(/);
});

test("generated chat webview inline script parses as JavaScript", () => {
  const chatViewPath = path.resolve(__dirname, "../src/chatView.js");
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const baseRequire = createRequire(chatViewPath);
  const source = `${readFileSync(chatViewPath, "utf8")}\nexports.__renderChatViewHtml = renderChatViewHtml;`;
  assert.match(
    source,
    /if \(postSubmission\) \{\s*this\.postSubmission\(\);\s*\}\s*if \(postSnapshot\) \{\s*this\.postSnapshot\(\);/s,
  );

  runInNewContext(
    source,
    {
      Buffer,
      URL,
      __dirname: path.dirname(chatViewPath),
      __filename: chatViewPath,
      clearTimeout,
      console,
      exports: moduleObject.exports,
      module: moduleObject,
      process,
      require: (id: string) => (id === "vscode" ? {} : baseRequire(id)),
      setTimeout,
    },
    { filename: chatViewPath },
  );

  const renderChatViewHtml = moduleObject.exports["__renderChatViewHtml"] as
    | ((...args: readonly unknown[]) => unknown)
    | undefined;
  if (renderChatViewHtml === undefined) {
    assert.fail("renderChatViewHtml was not found in compiled chatView.js");
  }

  const html = renderChatViewHtml(
    { cspSource: "vscode-webview://test" },
    {
      eventCount: 1,
      items: [
        {
          body: "## Summary\n\n---\n\n- Item\n\n```text\nhello\n```",
          id: "assistant-1",
          kind: "assistant",
          lastSeq: 1,
          runId: "run_1",
          seq: 1,
          time: "2026-06-05T00:00:00.000Z",
          title: "DeepSeek",
          tone: "neutral",
          type: "assistant.delta",
        },
      ],
      latestStatus: "Assistant",
    },
    { busy: false },
    { runs: [], status: "idle" },
    { omitted: [], segments: [], sources: [], totalTokens: 0 },
    { status: "idle" },
  ) as string;

  assert.match(html, /aria-label="Send message"/);
  assert.match(html, /message-edit/);
  assert.match(html, /\.composer-row\s*\{[^}]*flex-wrap: nowrap/s);
  assert.match(html, /\.send,\s*\n\s*\.cancel\s*\{[^}]*width: 28px/s);
  assert.match(html, /\.send-icon\[hidden\]\s*\{[^}]*display: none !important/s);
  assert.match(html, /\.mode\[hidden\]\s*\{[^}]*display: none !important/s);
  assert.match(html, /\.approval-card\s*\{[^}]*max-height: min\(70vh, 32rem\)/s);
  assert.match(html, /\.approval-section\s*\{/);
  assert.match(html, /\.approval-command \.approval-section-body\s*\{/);
  assert.match(html, /class="send-icon send-icon-stop"[^>]*hidden/);

  const script = extractInlineScript(html);
  assert.doesNotThrow(() => new Script(script, { filename: "prole-chat-webview-inline.js" }));
  assert.match(script, /function setSendIconVisible\(/);
  assert.match(script, /toggleAttribute\("hidden"/);
  assert.match(script, /modeInput\.hidden = busy === true/);
  assert.match(script, /function renderApprovalSection\(/);
  assert.match(script, /section\.classList\.add\("approval-section", className\)/);
  assert.match(script, /const wasBusy = currentSubmission && currentSubmission\.busy === true/);
  assert.match(script, /item\.kind === "assistant" && currentSubmission && currentSubmission\.busy === true/);
});

function extractInlineScript(html: string): string {
  const start = html.indexOf("<script nonce=");
  assert.notEqual(start, -1);
  const scriptStart = html.indexOf(">", start) + 1;
  const scriptEnd = html.indexOf("</script>", scriptStart);
  assert.notEqual(scriptEnd, -1);
  return html.slice(scriptStart, scriptEnd);
}
