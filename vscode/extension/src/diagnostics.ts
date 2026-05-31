import * as path from "node:path";

import type { TextRange, TurnAttachment } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

const MAX_DIAGNOSTIC_ATTACHMENTS = 32;

export interface ProblemDiagnosticSnapshot {
  readonly uri: {
    readonly fsPath: string;
  };
  readonly diagnostics: readonly ProblemDiagnostic[];
}

export interface ProblemDiagnostic {
  readonly severity: number;
  readonly message: string;
  readonly source?: string;
  readonly code?: string | number | { readonly value?: string | number };
  readonly range: {
    readonly start: {
      readonly line: number;
      readonly character: number;
    };
    readonly end: {
      readonly line: number;
      readonly character: number;
    };
  };
}

export function diagnosticAttachmentsFromProblems(
  problems: readonly ProblemDiagnosticSnapshot[],
  workspaceRoot: string,
): TurnAttachment[] {
  const candidates: DiagnosticAttachmentCandidate[] = [];
  let sequence = 0;

  for (const entry of problems) {
    const relativePath = workspaceRelativePath(workspaceRoot, entry.uri.fsPath);
    if (relativePath === undefined) {
      continue;
    }

    for (const diagnostic of entry.diagnostics) {
      candidates.push({
        relativePath,
        diagnostic,
        sequence,
      });
      sequence += 1;
    }
  }

  candidates.sort(compareDiagnosticCandidates);

  return candidates.slice(0, MAX_DIAGNOSTIC_ATTACHMENTS).map((candidate) => ({
    kind: "diagnostic",
    path: candidate.relativePath,
    range: protocolRangeFromDiagnostic(candidate.diagnostic),
    text: diagnosticText(candidate.diagnostic),
  }));
}

interface DiagnosticAttachmentCandidate {
  readonly relativePath: string;
  readonly diagnostic: ProblemDiagnostic;
  readonly sequence: number;
}

function compareDiagnosticCandidates(
  left: DiagnosticAttachmentCandidate,
  right: DiagnosticAttachmentCandidate,
): number {
  return (
    severityRank(left.diagnostic.severity) - severityRank(right.diagnostic.severity) ||
    left.relativePath.localeCompare(right.relativePath) ||
    compareRanges(left.diagnostic.range, right.diagnostic.range) ||
    left.sequence - right.sequence
  );
}

function compareRanges(
  left: ProblemDiagnostic["range"],
  right: ProblemDiagnostic["range"],
): number {
  return (
    left.start.line - right.start.line ||
    left.start.character - right.start.character ||
    left.end.line - right.end.line ||
    left.end.character - right.end.character
  );
}

function severityRank(severity: number): number {
  switch (severity) {
    case 0:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    default:
      return 4;
  }
}

function workspaceRelativePath(workspaceRoot: string, filePath: string): string | undefined {
  const relative = path.relative(workspaceRoot, filePath);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }

  return relative.replaceAll(path.sep, "/");
}

function protocolRangeFromDiagnostic(diagnostic: ProblemDiagnostic): TextRange {
  return {
    startLine: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLine: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
  };
}

function diagnosticText(diagnostic: ProblemDiagnostic): string {
  const lines = [
    `Severity: ${severityLabel(diagnostic.severity)}`,
    `Message: ${diagnostic.message}`,
  ];
  if (diagnostic.source !== undefined && diagnostic.source.length > 0) {
    lines.push(`Source: ${diagnostic.source}`);
  }
  const code = diagnosticCode(diagnostic.code);
  if (code !== undefined) {
    lines.push(`Code: ${code}`);
  }

  return lines.join("\n");
}

function severityLabel(severity: number): string {
  switch (severity) {
    case 0:
      return "error";
    case 1:
      return "warning";
    case 2:
      return "information";
    case 3:
      return "hint";
    default:
      return "unknown";
  }
}

function diagnosticCode(
  code: string | number | { readonly value?: string | number } | undefined,
): string | undefined {
  if (typeof code === "string" || typeof code === "number") {
    return String(code);
  }
  if (code !== undefined && (typeof code.value === "string" || typeof code.value === "number")) {
    return String(code.value);
  }
  return undefined;
}
