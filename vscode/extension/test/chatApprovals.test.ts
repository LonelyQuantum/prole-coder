import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalDecisionFromWebviewMessage,
  chatApprovalSnapshotFromRequest,
} from "../src/chatApprovals.js";
import { APPROVAL_REJECTED_REASON, type ApprovalPromptRequest } from "../src/commands.js";

test("chat approval snapshots expose request details without mutating hunks", () => {
  const request = sampleApprovalRequest();

  const snapshot = chatApprovalSnapshotFromRequest(request);

  assert.deepEqual(snapshot, request);
  assert.notEqual(snapshot.hunks, request.hunks);
  assert.deepEqual(snapshot.hunks, request.hunks);
});

test("chat approval messages map approve and reject decisions", () => {
  const request = sampleApprovalRequest({}, false);

  assert.deepEqual(
    approvalDecisionFromWebviewMessage(
      {
        type: "approvalDecision",
        approvalId: "approval_1",
        decision: "approve",
      },
      request,
    ),
    {
      kind: "approve",
      approvalId: "approval_1",
      persist: "never",
    },
  );

  assert.deepEqual(
    approvalDecisionFromWebviewMessage(
      {
        type: "approvalDecision",
        approvalId: "approval_1",
        decision: "reject",
      },
      request,
    ),
    {
      kind: "reject",
      approvalId: "approval_1",
      reason: APPROVAL_REJECTED_REASON,
    },
  );
});

test("chat approval hunk selection returns partial hunk approvals", () => {
  const request = sampleApprovalRequest();

  assert.deepEqual(
    approvalDecisionFromWebviewMessage(
      {
        type: "approvalDecision",
        approvalId: "approval_1",
        decision: "approve",
        approvedHunks: ["hunk_2", "unknown", "hunk_2"],
      },
      request,
    ),
    {
      kind: "approve",
      approvalId: "approval_1",
      persist: "never",
      hunks: {
        approved: ["hunk_2"],
      },
    },
  );
});

test("chat approval hunk selection approves whole patch when all hunks are selected", () => {
  const request = sampleApprovalRequest();

  assert.deepEqual(
    approvalDecisionFromWebviewMessage(
      {
        type: "approvalDecision",
        approvalId: "approval_1",
        decision: "approve",
        approvedHunks: ["hunk_1", "hunk_2"],
      },
      request,
    ),
    {
      kind: "approve",
      approvalId: "approval_1",
      persist: "never",
    },
  );
});

test("chat approval ignores unrelated messages and rejects empty hunk approval", () => {
  const request = sampleApprovalRequest();

  assert.equal(
    approvalDecisionFromWebviewMessage(
      {
        type: "approvalDecision",
        approvalId: "other",
        decision: "approve",
      },
      request,
    ),
    undefined,
  );
  assert.deepEqual(
    approvalDecisionFromWebviewMessage(
      {
        type: "approvalDecision",
        approvalId: "approval_1",
        decision: "approve",
        approvedHunks: [],
      },
      request,
    ),
    {
      kind: "reject",
      approvalId: "approval_1",
      reason: "no patch hunks selected in VS Code",
    },
  );
});

function sampleApprovalRequest(
  overrides: Partial<ApprovalPromptRequest> = {},
  includeHunks = true,
): ApprovalPromptRequest {
  return {
    approvalId: "approval_1",
    toolCallId: "tool_call_1",
    toolName: "apply_patch",
    risk: "write",
    title: "Apply patch",
    detail: "Modify README.md",
    persistable: true,
    command: "apply patch",
    cwd: ".",
    outputSummary: "patch preview ready",
    paths: ["README.md"],
    riskReasons: ["modifies files"],
    ...(includeHunks
      ? {
          hunks: [
            {
              id: "hunk_1",
              filePath: "README.md",
              hunkIndex: 0,
              oldStart: 1,
              oldCount: 2,
              newStart: 1,
              newCount: 3,
            },
            {
              id: "hunk_2",
              filePath: "README.md",
              hunkIndex: 1,
              oldStart: 8,
              oldCount: 1,
              newStart: 9,
              newCount: 2,
              section: "next block",
            },
          ],
        }
      : {}),
    ...overrides,
  };
}
