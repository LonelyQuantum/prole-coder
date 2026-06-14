export const PATCH_PREVIEW_EVENT_TYPE = "tool.requested";
export const PATCH_APPROVAL_EVENT_TYPE = "tool.approvalRequired";

const APPLY_PATCH_TOOL_NAME = "apply_patch";
const DEFAULT_MAX_PENDING_PATCHES = 50;
const HUNK_DECLARED_COUNT_TOLERANCE = 5;

export interface DisposableLike {
  dispose(): unknown;
}

export interface PatchEventSource {
  onEvent(handler: (event: PatchPreviewEvent) => void): DisposableLike;
}

export interface PatchPreviewEvent {
  readonly type: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly replay?: boolean;
  readonly payload: unknown;
}

export interface PatchApprovalRequest {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface PatchDiffPreviewHost {
  readWorkspaceFile(path: string): Promise<string | undefined>;
  openDiff(request: PatchDiffOpenRequest): Promise<unknown>;
  warn(message: string): unknown;
}

export interface PatchDiffPreviewControllerOptions {
  readonly maxPendingPatches?: number;
}

export interface ParsedPatch {
  readonly files: readonly ParsedPatchFile[];
}

export interface ParsedPatchFile {
  readonly fileIndex: number;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly displayPath: string;
  readonly hunks: readonly ParsedPatchHunk[];
}

export interface ParsedPatchHunk {
  readonly hunkIndex: number;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly section?: string;
  readonly lines: readonly ParsedPatchLine[];
}

export type ParsedPatchLine =
  | {
      readonly kind: "context";
      readonly text: string;
    }
  | {
      readonly kind: "remove";
      readonly text: string;
    }
  | {
      readonly kind: "add";
      readonly text: string;
    };

export interface PatchHunkApprovalBoundary {
  readonly id: string;
  readonly filePath: string;
  readonly fileIndex: number;
  readonly hunkIndex: number;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly section?: string;
  readonly state: "pending";
}

export interface PatchApprovalBoundary {
  readonly runId: string;
  readonly turnId?: string;
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly mode: "whole_patch";
  readonly hunks: readonly PatchHunkApprovalBoundary[];
}

export interface PatchDiffOpenRequest {
  readonly runId: string;
  readonly turnId?: string;
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly file: ParsedPatchFile;
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly boundary: PatchApprovalBoundary;
}

export interface PendingPatchPreview {
  readonly runId: string;
  readonly turnId?: string;
  readonly toolCallId: string;
  readonly expectedFiles: readonly string[];
  readonly patch: ParsedPatch;
}

export class PatchPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchPreviewError";
  }
}

export class PatchDiffPreviewController implements DisposableLike {
  private readonly maxPendingPatches: number;
  private readonly pendingPatches = new Map<string, PendingPatchPreview>();
  private readonly pendingPatchOrder: string[] = [];
  private readonly approvalBoundaries = new Map<string, PatchApprovalBoundary>();
  private readonly subscription: DisposableLike;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    eventSource: PatchEventSource,
    private readonly host: PatchDiffPreviewHost,
    options: PatchDiffPreviewControllerOptions = {},
  ) {
    this.maxPendingPatches = options.maxPendingPatches ?? DEFAULT_MAX_PENDING_PATCHES;
    this.subscription = eventSource.onEvent((event) => {
      this.handleEvent(event);
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.pendingPatches.clear();
    this.pendingPatchOrder.length = 0;
    this.approvalBoundaries.clear();
  }

  whenIdle(): Promise<void> {
    return this.queue.catch(() => undefined);
  }

  approvalBoundary(approvalId: string): PatchApprovalBoundary | undefined {
    return this.approvalBoundaries.get(approvalId);
  }

  prepareApproval(event: PatchPreviewEvent, request: PatchApprovalRequest): Promise<void> {
    if (
      event.replay === true ||
      event.type !== PATCH_APPROVAL_EVENT_TYPE ||
      request.toolName !== APPLY_PATCH_TOOL_NAME
    ) {
      return Promise.resolve();
    }

    this.queue = this.queue
      .catch(() => undefined)
      .then(() => this.openApprovalPreview(event, request));
    return this.queue;
  }

  private handleEvent(event: PatchPreviewEvent): void {
    if (event.replay === true) {
      return;
    }

    if (event.type !== PATCH_PREVIEW_EVENT_TYPE) {
      return;
    }

    let preview: PendingPatchPreview | undefined;
    try {
      preview = patchPreviewFromEvent(event);
    } catch (error) {
      this.host.warn(`prole-coder could not parse patch preview: ${errorMessage(error)}`);
      return;
    }
    if (preview === undefined) {
      return;
    }

    const key = patchKey(preview.runId, preview.toolCallId);
    this.pendingPatches.set(key, preview);
    this.pendingPatchOrder.push(key);
    this.trimPendingPatches();
  }

  private async openApprovalPreview(
    event: PatchPreviewEvent,
    request: PatchApprovalRequest,
  ): Promise<void> {
    const preview = this.pendingPatches.get(patchKey(event.runId, request.toolCallId));
    if (preview === undefined) {
      this.host.warn(`prole-coder patch preview is unavailable for approval ${request.approvalId}.`);
      return;
    }

    const boundary = createPatchApprovalBoundary(preview, request.approvalId);
    this.approvalBoundaries.set(request.approvalId, boundary);

    for (const file of preview.patch.files) {
      const beforeContent = await this.readBeforeContent(file);
      if (beforeContent === undefined) {
        this.host.warn(`prole-coder could not read ${file.oldPath ?? file.displayPath} for patch preview.`);
        continue;
      }

      let afterContent: string;
      try {
        afterContent = applyParsedPatchFile(file, beforeContent);
      } catch (error) {
        this.host.warn(`prole-coder could not build patch preview for ${file.displayPath}: ${errorMessage(error)}`);
        continue;
      }

      await this.host.openDiff({
        runId: preview.runId,
        ...(preview.turnId === undefined ? {} : { turnId: preview.turnId }),
        approvalId: request.approvalId,
        toolCallId: request.toolCallId,
        file,
        beforeContent,
        afterContent,
        boundary,
      });
    }
  }

  private async readBeforeContent(file: ParsedPatchFile): Promise<string | undefined> {
    if (file.oldPath === undefined) {
      return "";
    }

    return this.host.readWorkspaceFile(file.oldPath);
  }

  private trimPendingPatches(): void {
    while (this.pendingPatchOrder.length > this.maxPendingPatches) {
      const oldest = this.pendingPatchOrder.shift();
      if (oldest !== undefined) {
        this.pendingPatches.delete(oldest);
      }
    }
  }
}

export function patchPreviewFromEvent(event: PatchPreviewEvent): PendingPatchPreview | undefined {
  const payload = record(event.payload);
  if (payload === undefined || payload["name"] !== APPLY_PATCH_TOOL_NAME) {
    return undefined;
  }

  const toolCallId = stringField(payload, "toolCallId");
  const argumentsPreview = record(payload["argumentsPreview"]);
  const unifiedDiff = stringField(argumentsPreview, "unifiedDiff");
  const expectedFiles = stringArrayField(argumentsPreview, "expectedFiles");
  if (toolCallId === undefined || unifiedDiff === undefined || expectedFiles === undefined) {
    return undefined;
  }

  return {
    runId: event.runId,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    toolCallId,
    expectedFiles,
    patch: parseUnifiedDiff(unifiedDiff),
  };
}

export function parseUnifiedDiff(unifiedDiff: string): ParsedPatch {
  const lines = splitPatchLines(unifiedDiff);
  const files: ParsedPatchFile[] = [];
  let index = 0;

  while (index < lines.length) {
    const oldHeader = lines[index];
    if (oldHeader === undefined || !oldHeader.startsWith("--- ")) {
      index += 1;
      continue;
    }

    const oldPath = parsePatchPath(oldHeader.slice(4));
    index += 1;
    const newHeader = lines[index];
    if (newHeader === undefined || !newHeader.startsWith("+++ ")) {
      throw new PatchPreviewError("expected new file header after old file header");
    }

    const newPath = parsePatchPath(newHeader.slice(4));
    index += 1;

    const fileIndex = files.length;
    const hunks: ParsedPatchHunk[] = [];
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined) {
        break;
      }
      if (line.startsWith("--- ") || line.startsWith("diff --git ")) {
        break;
      }
      if (line.length === 0) {
        index += 1;
        continue;
      }
      if (!line.startsWith("@@ ")) {
        throw new PatchPreviewError(`expected hunk header, got \`${line}\``);
      }

      const header = parseHunkHeader(line);
      index += 1;
      const parsed = parseHunkLines(lines, index, header);
      hunks.push({
        hunkIndex: hunks.length,
        ...header,
        oldCount: parsed.oldCount,
        newCount: parsed.newCount,
        lines: parsed.lines,
      });
      index = parsed.nextIndex;
    }

    if (hunks.length === 0) {
      throw new PatchPreviewError("file patch has no hunks");
    }

    files.push({
      fileIndex,
      ...(oldPath === undefined ? {} : { oldPath }),
      ...(newPath === undefined ? {} : { newPath }),
      displayPath: newPath ?? oldPath ?? `file-${fileIndex + 1}`,
      hunks,
    });
  }

  if (files.length === 0) {
    throw new PatchPreviewError("patch must contain at least one file");
  }

  return { files };
}

export function applyParsedPatchFile(file: ParsedPatchFile, beforeContent: string): string {
  const original = splitContentLines(beforeContent);
  const result: string[] = [];
  let cursor = 0;

  for (const hunk of file.hunks) {
    const hunkStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (hunkStart < cursor) {
      throw new PatchPreviewError(`hunk starts before previous hunk ended in ${file.displayPath}`);
    }

    while (cursor < hunkStart) {
      const line = original[cursor];
      if (line === undefined) {
        throw new PatchPreviewError(`hunk starts past end of ${file.displayPath}`);
      }
      result.push(line);
      cursor += 1;
    }

    for (const line of hunk.lines) {
      if (line.kind === "add") {
        result.push(line.text);
        continue;
      }

      const originalLine = original[cursor];
      if (originalLine !== line.text) {
        throw new PatchPreviewError(`hunk mismatch in ${file.displayPath} at line ${cursor + 1}`);
      }

      if (line.kind === "context") {
        result.push(originalLine);
      }
      cursor += 1;
    }
  }

  while (cursor < original.length) {
    const line = original[cursor];
    if (line !== undefined) {
      result.push(line);
    }
    cursor += 1;
  }

  return joinContentLines(result, beforeContent.endsWith("\n") || result.length > 0);
}

export function createPatchApprovalBoundary(
  preview: PendingPatchPreview,
  approvalId: string,
): PatchApprovalBoundary {
  const hunks = preview.patch.files.flatMap((file) =>
    file.hunks.map((hunk) => ({
      id: hunkBoundaryId(file, hunk),
      filePath: file.displayPath,
      fileIndex: file.fileIndex,
      hunkIndex: hunk.hunkIndex,
      oldStart: hunk.oldStart,
      oldCount: hunk.oldCount,
      newStart: hunk.newStart,
      newCount: hunk.newCount,
      ...(hunk.section === undefined ? {} : { section: hunk.section }),
      state: "pending" as const,
    })),
  );

  return {
    runId: preview.runId,
    ...(preview.turnId === undefined ? {} : { turnId: preview.turnId }),
    approvalId,
    toolCallId: preview.toolCallId,
    mode: "whole_patch",
    hunks,
  };
}

function parseHunkLines(
  lines: readonly string[],
  startIndex: number,
  header: Omit<ParsedPatchHunk, "hunkIndex" | "lines">,
): {
  readonly lines: readonly ParsedPatchLine[];
  readonly nextIndex: number;
  readonly oldCount: number;
  readonly newCount: number;
} {
  const hunkLines: ParsedPatchLine[] = [];
  let oldSeen = 0;
  let newSeen = 0;
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    const nextLine = lines[index + 1];
    if (
      line.startsWith("@@ ") ||
      line.startsWith("diff --git ") ||
      (line.startsWith("--- ") && nextLine !== undefined && nextLine.startsWith("+++ "))
    ) {
      break;
    }
    if (line.length === 0) {
      if (index === lines.length - 1) {
        break;
      }
      throw new PatchPreviewError("invalid blank patch line in hunk");
    }
    if (line.startsWith("\\ No newline at end of file")) {
      index += 1;
      continue;
    }

    const prefix = line[0];
    const text = line.slice(1);
    switch (prefix) {
      case " ":
        oldSeen += 1;
        newSeen += 1;
        hunkLines.push({ kind: "context", text });
        break;
      case "-":
        oldSeen += 1;
        hunkLines.push({ kind: "remove", text });
        break;
      case "+":
        newSeen += 1;
        hunkLines.push({ kind: "add", text });
        break;
      default:
        throw new PatchPreviewError(`invalid patch line \`${line}\``);
    }

    index += 1;
  }

  if (hunkLines.length === 0) {
    throw new PatchPreviewError("hunk has no patch lines");
  }
  if (
    oldSeen > header.oldCount + HUNK_DECLARED_COUNT_TOLERANCE ||
    newSeen > header.newCount + HUNK_DECLARED_COUNT_TOLERANCE
  ) {
    throw new PatchPreviewError("hunk contains too many more lines than declared");
  }

  return { lines: hunkLines, nextIndex: index, oldCount: oldSeen, newCount: newSeen };
}

function parseHunkHeader(line: string): Omit<ParsedPatchHunk, "hunkIndex" | "lines"> {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/.exec(line);
  if (match === null) {
    throw new PatchPreviewError(`invalid hunk header \`${line}\``);
  }

  const oldStart = parseNonNegativeInteger(match[1], "old hunk start");
  const oldCount = match[2] === undefined ? 1 : parseNonNegativeInteger(match[2], "old hunk count");
  const newStart = parseNonNegativeInteger(match[3], "new hunk start");
  const newCount = match[4] === undefined ? 1 : parseNonNegativeInteger(match[4], "new hunk count");

  return {
    oldStart,
    oldCount,
    newStart,
    newCount,
    ...(match[5] === undefined || match[5].length === 0 ? {} : { section: match[5] }),
  };
}

function parsePatchPath(rawPath: string): string | undefined {
  const path = rawPath.split("\t", 1)[0]?.trim();
  if (path === undefined || path.length === 0 || path === "/dev/null") {
    return undefined;
  }
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
}

function splitPatchLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function splitContentLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.length === 0) {
    return [];
  }
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function joinContentLines(lines: readonly string[], finalNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }

  return `${lines.join("\n")}${finalNewline ? "\n" : ""}`;
}

function parseNonNegativeInteger(value: string | undefined, label: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new PatchPreviewError(`invalid ${label}: ${value ?? ""}`);
  }

  return Number(value);
}

function hunkBoundaryId(file: ParsedPatchFile, hunk: ParsedPatchHunk): string {
  return `${file.displayPath}#${hunk.hunkIndex + 1}:old${hunk.oldStart}+${hunk.oldCount}:new${hunk.newStart}+${hunk.newCount}`;
}

function patchKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayField(payload: Record<string, unknown> | undefined, key: string): readonly string[] | undefined {
  const value = payload?.[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
