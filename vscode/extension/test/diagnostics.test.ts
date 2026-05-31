import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";

import { diagnosticAttachmentsFromProblems } from "../src/diagnostics.js";

test("diagnostic attachments snapshot workspace Problems as diagnostic attachments", () => {
  const workspaceRoot = path.join("C:", "workspace", "project");
  const attachments = diagnosticAttachmentsFromProblems(
    [
      {
        uri: {
          fsPath: path.join(workspaceRoot, "src", "lib.rs"),
        },
        diagnostics: [
          {
            severity: 0,
            message: "unused import",
            source: "rust-analyzer",
            code: {
              value: "unused_imports",
            },
            range: {
              start: {
                line: 2,
                character: 4,
              },
              end: {
                line: 2,
                character: 10,
              },
            },
          },
        ],
      },
    ],
    workspaceRoot,
  );

  assert.deepEqual(attachments, [
    {
      kind: "diagnostic",
      path: "src/lib.rs",
      range: {
        startLine: 3,
        startColumn: 5,
        endLine: 3,
        endColumn: 11,
      },
      text: [
        "Severity: error",
        "Message: unused import",
        "Source: rust-analyzer",
        "Code: unused_imports",
      ].join("\n"),
    },
  ]);
});

test("diagnostic attachments skip Problems outside the workspace", () => {
  const workspaceRoot = path.join("C:", "workspace", "project");
  const attachments = diagnosticAttachmentsFromProblems(
    [
      {
        uri: {
          fsPath: path.join("C:", "workspace", "other", "src", "lib.rs"),
        },
        diagnostics: [
          {
            severity: 1,
            message: "outside workspace",
            range: {
              start: {
                line: 0,
                character: 0,
              },
              end: {
                line: 0,
                character: 1,
              },
            },
          },
        ],
      },
    ],
    workspaceRoot,
  );

  assert.deepEqual(attachments, []);
});

test("diagnostic attachments cap Problems with errors first", () => {
  const workspaceRoot = path.join("C:", "workspace", "project");
  const warningDiagnostics = Array.from({ length: 40 }, (_, index) => ({
    severity: 1,
    message: `warning ${index}`,
    range: {
      start: {
        line: index + 1,
        character: 0,
      },
      end: {
        line: index + 1,
        character: 1,
      },
    },
  }));
  const attachments = diagnosticAttachmentsFromProblems(
    [
      {
        uri: {
          fsPath: path.join(workspaceRoot, "src", "lib.rs"),
        },
        diagnostics: [
          ...warningDiagnostics,
          {
            severity: 0,
            message: "compile error",
            range: {
              start: {
                line: 99,
                character: 2,
              },
              end: {
                line: 99,
                character: 8,
              },
            },
          },
        ],
      },
    ],
    workspaceRoot,
  );

  assert.equal(attachments.length, 32);
  const firstText = attachments[0]?.text;
  if (firstText === undefined) {
    assert.fail("first diagnostic attachment should include text");
  }
  assert.match(firstText, /Severity: error/);
  assert.match(firstText, /Message: compile error/);
  assert.equal(
    attachments.some((attachment) => (attachment.text ?? "").includes("warning 39")),
    false,
  );
});
