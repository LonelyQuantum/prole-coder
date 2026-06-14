import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { WEBVIEW_MARKDOWN_RENDERER_SCRIPT } from "../src/webviewMarkdown.js";

test("webview markdown renderer handles horizontal rules and escaped table pipes", () => {
  const html = renderMarkdown([
    "Before",
    "",
    "---",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| escaped | A \\| B |",
  ].join("\n"));

  assert.match(html, /<hr><\/hr>/);
  assert.match(html, /<td>escaped<\/td><td>A \| B<\/td>/);
});

test("webview markdown renderer keeps unsafe and relative links as text", () => {
  const html = renderMarkdown(
    "[safe](https://example.com/docs) [mail](mailto:test@example.com) [bad](javascript:alert(1)) [relative](docs/readme.md)",
  );

  assert.match(html, /<a href="https:\/\/example\.com\/docs"/);
  assert.match(html, /<a href="mailto:test@example\.com"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /\[relative\]\(docs\/readme\.md\)/);
});

test("webview markdown renderer tolerates nested and unclosed inline markers", () => {
  const html = renderMarkdown("prefix **bold `code`** *loose [unfinished](https://example.com");

  assert.match(html, /prefix \*\*bold /);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /\*\* \*loose \[unfinished\]\(https:\/\/example\.com/);
});

test("webview markdown renderer handles large text without collapsing output", () => {
  const markdown = Array.from({ length: 300 }, (_, index) => `Paragraph ${index} with **strong** text.`).join("\n\n");
  const html = renderMarkdown(markdown);

  assert.match(html, /Paragraph 0/);
  assert.match(html, /Paragraph 299/);
  assert.equal((html.match(/<p>/g) ?? []).length, 300);
});

function renderMarkdown(markdown: string): string {
  const root = new FakeElement("div");
  const context = {
    document: {
      createElement: (tagName: string) => new FakeElement(tagName),
      createTextNode: (text: string) => new FakeText(text),
    },
    URL,
  } as Record<string, unknown>;

  runInNewContext(
    `${WEBVIEW_MARKDOWN_RENDERER_SCRIPT}\nglobalThis.__appendMarkdownBlocks = appendMarkdownBlocks;`,
    context,
    { filename: "webviewMarkdown.js" },
  );
  const appendMarkdownBlocks = context["__appendMarkdownBlocks"];
  assert.equal(typeof appendMarkdownBlocks, "function");
  (appendMarkdownBlocks as (parent: FakeElement, markdown: string) => void)(root, markdown);
  return root.children.map((child) => serializeNode(child)).join("");
}

type FakeNode = FakeElement | FakeText;

class FakeText {
  readonly kind = "text";

  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly kind = "element";
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  textContent = "";
  href = "";
  target = "";
  rel = "";

  constructor(readonly tagName: string) {}

  append(...nodes: readonly (FakeNode | string)[]): void {
    for (const node of nodes) {
      this.children.push(typeof node === "string" ? new FakeText(node) : node);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

function serializeNode(node: FakeNode): string {
  if (node.kind === "text") {
    return escapeHtml(node.textContent);
  }

  const tagName = node.tagName.toLowerCase();
  const attributes = new Map(node.attributes);
  for (const [name, value] of [
    ["href", node.href],
    ["target", node.target],
    ["rel", node.rel],
  ] as const) {
    if (value.length > 0) {
      attributes.set(name, value);
    }
  }
  const attrText = [...attributes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
  const content = `${escapeHtml(node.textContent)}${node.children.map((child) => serializeNode(child)).join("")}`;
  return `<${tagName}${attrText}>${content}</${tagName}>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
