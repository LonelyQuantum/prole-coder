import assert from "node:assert/strict";
import test from "node:test";

import {
  PatchDiffPreviewController,
  applyParsedPatchFile,
  createPatchApprovalBoundary,
  parseUnifiedDiff,
  type PatchDiffOpenRequest,
  type PatchDiffPreviewHost,
  type PatchEventSource,
  type PatchPreviewEvent,
} from "../src/patchPreview.js";

test("parseUnifiedDiff exposes stable hunk approval boundaries", () => {
  const preview = patchPreview();
  const boundary = createPatchApprovalBoundary(preview, "approval_1");

  assert.equal(preview.patch.files.length, 1);
  assert.equal(preview.patch.files[0]?.displayPath, "README.md");
  assert.equal(preview.patch.files[0]?.hunks.length, 2);
  assert.equal(boundary.mode, "whole_patch");
  assert.deepEqual(
    boundary.hunks.map((hunk) => hunk.id),
    ["README.md#1:old1+3:new1+3", "README.md#2:old5+2:new5+3"],
  );
});

test("applyParsedPatchFile builds patched preview content without writing files", () => {
  const parsed = parseUnifiedDiff(samplePatch());
  const file = parsed.files[0];
  assert.ok(file);

  const after = applyParsedPatchFile(file, "one\nold\nthree\n\nkeep\nremove\n");

  assert.equal(after, "one\nnew\nthree\n\nkeep\ninsert\nremove\n");
});

test("parseUnifiedDiff tolerates hunk headers with underdeclared line counts", () => {
  const parsed = parseUnifiedDiff(
    [
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,1 +1,1 @@",
      " one",
      "-old",
      "+new",
      " three",
      "",
    ].join("\n"),
  );
  const file = parsed.files[0];
  assert.ok(file);
  const hunk = file.hunks[0];
  assert.ok(hunk);
  assert.equal(hunk.oldCount, 3);
  assert.equal(hunk.newCount, 3);
  assert.equal(applyParsedPatchFile(file, "one\nold\nthree\n"), "one\nnew\nthree\n");
});

test("parseUnifiedDiff keeps deleted content that resembles a file header", () => {
  const parsed = parseUnifiedDiff(
    [
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,2 +1,2 @@",
      " keep",
      "--- heading",
      "+renamed heading",
      "",
    ].join("\n"),
  );
  const file = parsed.files[0];
  assert.ok(file);
  assert.equal(applyParsedPatchFile(file, "keep\n-- heading\n"), "keep\nrenamed heading\n");
});

test("parseUnifiedDiff rejects severely underdeclared hunk headers", () => {
  assert.throws(
    () =>
      parseUnifiedDiff(
        [
          "--- a/README.md",
          "+++ b/README.md",
          "@@ -1,1 +1,1 @@",
          " one",
          " two",
          " three",
          " four",
          " five",
          " six",
          " seven",
          "",
        ].join("\n"),
      ),
    /too many more lines than declared/,
  );
});

test("PatchDiffPreviewController opens native diff requests before approval prompting", async () => {
  const rpc = new FakePatchEventSource();
  const host = new FakePatchDiffPreviewHost({
    "README.md": "one\nold\nthree\n\nkeep\nremove\n",
  });
  const controller = new PatchDiffPreviewController(rpc, host);

  rpc.emit(toolRequestedEvent());
  await controller.prepareApproval(approvalEvent(), {
    approvalId: "approval_1",
    toolCallId: "tool_call_1",
    toolName: "apply_patch",
  });

  assert.equal(host.opened.length, 1);
  assert.equal(host.opened[0]?.file.displayPath, "README.md");
  assert.equal(host.opened[0]?.afterContent, "one\nnew\nthree\n\nkeep\ninsert\nremove\n");
  assert.equal(host.opened[0]?.boundary.mode, "whole_patch");
  assert.equal(controller.approvalBoundary("approval_1")?.hunks.length, 2);
  assert.deepEqual(host.warnings, []);
});

test("PatchDiffPreviewController ignores replayed patch approval events", async () => {
  const rpc = new FakePatchEventSource();
  const host = new FakePatchDiffPreviewHost({
    "README.md": "one\nold\nthree\n\nkeep\nremove\n",
  });
  const controller = new PatchDiffPreviewController(rpc, host);

  rpc.emit({ ...toolRequestedEvent(), replay: true });
  await controller.prepareApproval({ ...approvalEvent(), replay: true }, {
    approvalId: "approval_1",
    toolCallId: "tool_call_1",
    toolName: "apply_patch",
  });

  assert.equal(host.opened.length, 0);
  assert.equal(controller.approvalBoundary("approval_1"), undefined);
  assert.deepEqual(host.warnings, []);
});

test("PatchDiffPreviewController warns without breaking on malformed patch previews", () => {
  const rpc = new FakePatchEventSource();
  const host = new FakePatchDiffPreviewHost({});
  new PatchDiffPreviewController(rpc, host);

  rpc.emit({
    ...toolRequestedEvent(),
    payload: {
      toolCallId: "tool_call_1",
      name: "apply_patch",
      argumentsPreview: {
        unifiedDiff: "--- a/README.md\n",
        expectedFiles: ["README.md"],
      },
    },
  });

  assert.equal(host.opened.length, 0);
  assert.equal(host.warnings.length, 1);
  assert.ok(host.warnings[0]?.includes("could not parse patch preview"));
});

function patchPreview() {
  return {
    runId: "run_1",
    turnId: "turn_1",
    toolCallId: "tool_call_1",
    expectedFiles: ["README.md"],
    patch: parseUnifiedDiff(samplePatch()),
  };
}

function samplePatch(): string {
  return [
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,3 +1,3 @@",
    " one",
    "-old",
    "+new",
    " three",
    "@@ -5,2 +5,3 @@",
    " keep",
    "+insert",
    " remove",
    "",
  ].join("\n");
}

function toolRequestedEvent(): PatchPreviewEvent {
  return {
    type: "tool.requested",
    runId: "run_1",
    turnId: "turn_1",
    payload: {
      toolCallId: "tool_call_1",
      name: "apply_patch",
      risk: "write",
      argumentsPreview: {
        unifiedDiff: samplePatch(),
        expectedFiles: ["README.md"],
      },
    },
  };
}

function approvalEvent(): PatchPreviewEvent {
  return {
    type: "tool.approvalRequired",
    runId: "run_1",
    turnId: "turn_1",
    payload: {
      approvalId: "approval_1",
      toolCallId: "tool_call_1",
      toolName: "apply_patch",
    },
  };
}

class FakePatchEventSource implements PatchEventSource {
  private readonly handlers = new Set<(event: PatchPreviewEvent) => void>();

  onEvent(handler: (event: PatchPreviewEvent) => void): { dispose(): unknown } {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  emit(event: PatchPreviewEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

class FakePatchDiffPreviewHost implements PatchDiffPreviewHost {
  readonly opened: PatchDiffOpenRequest[] = [];
  readonly warnings: string[] = [];
  private readonly files: ReadonlyMap<string, string>;

  constructor(files: Readonly<Record<string, string>>) {
    this.files = new Map(Object.entries(files));
  }

  async readWorkspaceFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async openDiff(request: PatchDiffOpenRequest): Promise<unknown> {
    this.opened.push(request);
    return undefined;
  }

  warn(message: string): unknown {
    this.warnings.push(message);
    return undefined;
  }
}
