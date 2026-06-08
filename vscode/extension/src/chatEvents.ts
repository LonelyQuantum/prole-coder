import type { AgentEventEnvelope } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

const TIMELINE_DISPLAY_TEXT_LIMIT = 1200;
const TIMELINE_COMPACT_JSON_LIMIT = 800;
const TIMELINE_TRUNCATED_NOTICE = "\n[truncated for sidebar; see Output or run logs for full text]";
// Keep enough process events for long real-world turns while treating run log replay
// as the durable source. User, assistant, and terminal items are never counted here.
const DEFAULT_TIMELINE_PROCESS_ITEM_LIMIT = 1200;
// Dedicated read-only tools are folded out of Activity summaries. Shell remains
// counted as a command because even read-only shell calls are explicit process work.
const TRIVIAL_WORK_TOOL_NAMES = new Set([
  "git_diff",
  "git_status",
  "lsp_diagnostics",
  "plan_update",
  "read_file",
  "search",
  "workspace_manifest",
]);

export type ChatTimelineKind =
  | "assistant"
  | "approval"
  | "context"
  | "provider"
  | "raw"
  | "run"
  | "terminal"
  | "tool"
  | "user";

export type ChatTimelineTone = "danger" | "neutral" | "running" | "success" | "warning";

export interface ChatTimelineItem {
  readonly id: string;
  readonly seq: number;
  readonly lastSeq: number;
  readonly time: string;
  readonly type: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly kind: ChatTimelineKind;
  readonly tone: ChatTimelineTone;
  readonly title: string;
  readonly body?: string | undefined;
  readonly detail?: string | undefined;
  readonly defaultCollapsed?: boolean;
  readonly workGroupId?: string;
  readonly workGroupTitle?: string;
  readonly changedFileCount?: number;
  readonly commandCount?: number;
  readonly toolName?: string;
  readonly steerId?: string;
  readonly children?: readonly ChatTimelineItem[];
}

export interface ChatTimelineSnapshot {
  readonly eventCount: number;
  readonly items: readonly ChatTimelineItem[];
  readonly visibleItems?: readonly ChatTimelineItem[];
  readonly workItems?: readonly ChatTimelineItem[];
  readonly supersededItemIds?: readonly string[];
  readonly latestRunId?: string;
  readonly latestStatus?: string;
  readonly oldestLoadedSeq?: number;
  readonly hiddenProcessItemCount?: number;
}

export interface ChatEventTimelineOptions {
  readonly maxItems?: number;
}

export class ChatEventTimeline {
  private maxItems: number;
  private readonly eventsBySeq = new Map<string, AgentEventEnvelope>();
  private readonly items: ChatTimelineItem[] = [];
  private readonly assistantItemsByTurn = new Map<string, string>();
  private readonly supersededItemIds = new Set<string>();
  private eventCount = 0;
  private latestRunId: string | undefined;
  private latestStatus: string | undefined;
  private hiddenProcessItemCount = 0;

  constructor(options: ChatEventTimelineOptions = {}) {
    this.maxItems = options.maxItems ?? DEFAULT_TIMELINE_PROCESS_ITEM_LIMIT;
  }

  append(event: AgentEventEnvelope): ChatTimelineSnapshot {
    const key = eventMapKey(event);
    if (this.eventsBySeq.has(key)) {
      return this.snapshot();
    }
    this.eventsBySeq.set(key, event);
    this.eventCount = this.eventsBySeq.size;
    this.appendEventItem(event);

    return this.snapshot();
  }

  prepend(events: readonly AgentEventEnvelope[]): ChatTimelineSnapshot {
    let added = 0;
    for (const event of events) {
      const key = eventMapKey(event);
      if (this.eventsBySeq.has(key)) {
        continue;
      }
      this.eventsBySeq.set(key, event);
      added += 1;
    }
    if (added > 0) {
      this.maxItems += added;
      this.rebuildFromLoadedEvents();
    }

    return this.snapshot();
  }

  revealHiddenProcessItems(count = 200): ChatTimelineSnapshot {
    if (this.hiddenProcessItemCount > 0) {
      this.maxItems += Math.min(count, this.hiddenProcessItemCount);
      this.rebuildFromLoadedEvents();
    }

    return this.snapshot();
  }

  hasHiddenProcessItems(): boolean {
    return this.hiddenProcessItemCount > 0;
  }

  oldestLoadedSeq(): number | undefined {
    const seqs = Array.from(this.eventsBySeq.values()).map((event) => event.seq);
    return seqs.length === 0 ? undefined : Math.min(...seqs);
  }

  private appendEventItem(event: AgentEventEnvelope, trim = true): void {
    this.latestRunId = event.runId;
    const supersededItemId = supersededItemIdFromEvent(event);
    if (supersededItemId !== undefined) {
      this.supersededItemIds.add(supersededItemId);
    }

    if (event.type === "assistant.delta") {
      this.appendAssistantDelta(event, trim);
    } else {
      const item = createTimelineItem(event);
      this.items.push(item);
      this.latestStatus = latestStatusFor(item);
      if (breaksAssistantSegment(event.type)) {
        this.assistantItemsByTurn.delete(assistantKey(event));
      }
      if (trim) {
        this.trimItems();
      }
    }
  }

  clear(): ChatTimelineSnapshot {
    this.eventsBySeq.clear();
    this.items.length = 0;
    this.assistantItemsByTurn.clear();
    this.supersededItemIds.clear();
    this.eventCount = 0;
    this.latestRunId = undefined;
    this.latestStatus = undefined;
    this.hiddenProcessItemCount = 0;
    return this.snapshot();
  }

  snapshot(): ChatTimelineSnapshot {
    const items = this.items.map((item) => ({ ...item }));
    const oldestLoadedSeq = this.oldestLoadedSeq();
    const presentation = presentTimelineItems(items, this.supersededItemIds);
    return {
      eventCount: this.eventCount,
      items,
      visibleItems: presentation.visibleItems,
      workItems: presentation.workItems,
      ...(this.supersededItemIds.size === 0
        ? {}
        : { supersededItemIds: Array.from(this.supersededItemIds) }),
      ...(this.latestRunId === undefined ? {} : { latestRunId: this.latestRunId }),
      ...(this.latestStatus === undefined ? {} : { latestStatus: this.latestStatus }),
      ...(oldestLoadedSeq === undefined ? {} : { oldestLoadedSeq }),
      ...(this.hiddenProcessItemCount === 0
        ? {}
        : { hiddenProcessItemCount: this.hiddenProcessItemCount }),
    };
  }

  private rebuildFromLoadedEvents(): void {
    const events = Array.from(this.eventsBySeq.values()).sort((left, right) => left.seq - right.seq);
    this.items.length = 0;
    this.assistantItemsByTurn.clear();
    this.supersededItemIds.clear();
    this.eventCount = events.length;
    this.latestRunId = undefined;
    this.latestStatus = undefined;
    this.hiddenProcessItemCount = 0;

    for (const event of events) {
      this.appendEventItem(event, false);
    }
    this.trimItems();
  }

  private appendAssistantDelta(event: AgentEventEnvelope, trim = true): void {
    const key = assistantKey(event);
    const existingId = this.assistantItemsByTurn.get(key);
    const payload = record(event.payload);
    const text = textField(payload, "text") ?? textField(payload, "delta") ?? "";

    if (existingId !== undefined) {
      const index = this.items.findIndex((item) => item.id === existingId);
      if (index >= 0) {
        const current = this.items[index];
        if (current === undefined) {
          return;
        }

        this.items[index] = {
          ...current,
          lastSeq: event.seq,
          time: event.time,
          body: `${current.body ?? ""}${text}`,
          detail: `seq ${current.seq}-${event.seq}`,
        };
        this.latestStatus = "Assistant streaming";
        return;
      }
    }

    const item = createTimelineItem(event);
    this.items.push(item);
    this.assistantItemsByTurn.set(key, item.id);
    this.latestStatus = "Assistant streaming";
    if (trim) {
      this.trimItems();
    }
  }

  private trimItems(): void {
    let discardableCount = 0;
    for (const item of this.items) {
      if (isDiscardableTimelineItem(item)) {
        discardableCount += 1;
      }
    }

    if (discardableCount <= this.maxItems) {
      return;
    }

    this.hiddenProcessItemCount = discardableCount - this.maxItems;
    for (let index = 0; index < this.items.length && discardableCount > this.maxItems;) {
      const item = this.items[index];
      if (item !== undefined && isDiscardableTimelineItem(item)) {
        this.items.splice(index, 1);
        discardableCount -= 1;
        continue;
      }
      index += 1;
    }

  }
}

export function createTimelineItem(event: AgentEventEnvelope): ChatTimelineItem {
  const payload = record(event.payload);
  const base = {
    id: `${event.runId}:${event.seq}`,
    seq: event.seq,
    lastSeq: event.seq,
    time: event.time,
    type: event.type,
    runId: event.runId,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
  };

  switch (event.type) {
    case "assistant.delta":
      return {
        ...base,
        id: `assistant:${event.runId}:${event.turnId ?? "run"}:${event.seq}`,
        kind: "assistant",
        tone: "neutral",
        title: "DeepSeek",
        body: textField(payload, "text") ?? textField(payload, "delta") ?? compactJson(event.payload),
        detail: `seq ${event.seq}`,
      };
    case "run.started":
      return {
        ...base,
        kind: "run",
        tone: "running",
        title: "Run started",
        body: joinParts([label("Mode", textField(payload, "mode")), label("Workspace", textField(payload, "workspaceRoot"))]),
        defaultCollapsed: true,
      };
    case "turn.started":
      return {
        ...base,
        kind: "user",
        tone: "neutral",
        title: "You",
        body: textField(payload, "userTask") ?? textField(payload, "prompt") ?? compactJson(event.payload),
      };
    case "turn.steered": {
      const steerId = textField(payload, "steerId");
      return {
        ...base,
        kind: "user",
        tone: "neutral",
        title: "You",
        body: textField(payload, "message") ?? compactJson(event.payload),
        ...(steerId === undefined ? {} : { steerId }),
      };
    }
    case "context.built":
      return {
        ...base,
        kind: "context",
        tone: "neutral",
        title: "Context built",
        body: joinParts([
          label("Input tokens", valueText(payload, "inputTokens")),
          label("Stable", valueText(payload, "stablePrefixTokens")),
          label("Sources", arrayCount(payload, "includedSources")),
          label("Omitted", arrayCount(payload, "omittedSources")),
        ]),
        defaultCollapsed: true,
      };
    case "provider.requested":
      return {
        ...base,
        kind: "provider",
        tone: "running",
        title: "Provider request",
        ...providerWorkGroup(event, payload),
        body: joinParts([
          label("Iteration", valueText(payload, "iteration")),
          label("Messages", valueText(payload, "messageCount")),
          label("Reasoning", valueText(payload, "reasoningState")),
        ]),
        defaultCollapsed: true,
      };
    case "provider.completed":
      return {
        ...base,
        kind: "provider",
        tone: "neutral",
        title: "Provider completed",
        ...providerWorkGroup(event, payload),
        body: joinParts([
          label("Model", textField(payload, "model")),
          label("Finish", textField(payload, "finishReason")),
          label("Duration", suffix(valueText(payload, "durationMs"), "ms")),
          label("Total tokens", nestedValueText(payload, "usage", "totalTokens")),
        ]),
        defaultCollapsed: true,
      };
    case "provider.retrying":
      return {
        ...base,
        kind: "provider",
        tone: "warning",
        title: "Provider retrying",
        ...providerWorkGroup(event, payload),
        body: joinParts([
          label("Iteration", valueText(payload, "iteration")),
          label("Reason", displayTextField(payload, "reason")),
          label("Timeout", suffix(valueText(payload, "timeoutMs"), "ms")),
          label("Retries remaining", valueText(payload, "retriesRemaining")),
          label("Partial content", suffix(valueText(payload, "partialContentChars"), " chars")),
          displayTextField(payload, "message"),
        ]),
        defaultCollapsed: true,
      };
    case "tool.requested":
      return {
        ...base,
        kind: "tool",
        tone: "neutral",
        title: `Tool requested: ${toolName(payload)}`,
        toolName: toolName(payload),
        ...toolWorkGroup(event, payload),
        body: joinParts([
          label("Risk", displayTextField(payload, "risk")),
          label("Reasons", displayArrayText(payload, "riskReasons")),
          label("Args", displayValueText(payload, "argumentsPreview")),
        ]),
        defaultCollapsed: true,
      };
    case "tool.approvalRequired":
      return {
        ...base,
        kind: "approval",
        tone: "warning",
        title: `Approval required: ${textField(payload, "toolName") ?? "tool"}`,
        toolName: textField(payload, "toolName") ?? "tool",
        ...toolWorkGroup(event, payload),
        body: joinParts([
          displayTextField(payload, "title"),
          displayTextField(payload, "detail"),
          label("Risk", displayTextField(payload, "risk")),
          label("Reasons", displayArrayText(payload, "riskReasons")),
          label("Command", displayTextField(payload, "command")),
          label("Paths", displayArrayText(payload, "paths")),
        ]),
        defaultCollapsed: true,
      };
    case "tool.approvalResolved": {
      const decision = textField(payload, "decision") ?? "resolved";
      return {
        ...base,
        kind: "approval",
        tone: approvalTone(decision),
        title: `Approval ${decision}`,
        ...toolWorkGroup(event, payload),
        body: joinParts([
          label("Tool", displayTextField(payload, "toolName")),
          label("Reason", displayTextField(payload, "reason")),
        ]),
        defaultCollapsed: true,
      };
    }
    case "tool.started":
      return {
        ...base,
        kind: "tool",
        tone: "running",
        title: `Tool started: ${toolName(payload)}`,
        toolName: toolName(payload),
        ...toolWorkGroup(event, payload),
        body: label("Call", textField(payload, "toolCallId")),
        defaultCollapsed: true,
      };
    case "tool.completed": {
      const status = textField(payload, "status");
      const completedToolName = toolName(payload);
      const changedFileCount =
        completedToolName === "apply_patch" && (status === "ok" || status === "success")
          ? nestedArrayCount(payload, "result", "files")
          : undefined;
      return {
        ...base,
        kind: "tool",
        tone: status === "ok" || status === "success" ? "success" : "warning",
        title: `Tool completed: ${completedToolName}`,
        toolName: completedToolName,
        ...toolWorkGroup(event, payload),
        body: joinParts([
          label("Status", status),
          displayTextField(payload, "summary"),
          label("Files", displayNestedValueText(payload, "result", "files")),
        ]),
        defaultCollapsed: true,
        ...(changedFileCount === undefined ? {} : { changedFileCount }),
        ...(completedToolName === "shell" ? { commandCount: 1 } : {}),
      };
    }
    case "run.completed":
      return {
        ...base,
        kind: "terminal",
        tone: "success",
        title: "Run completed",
        body: joinParts([textField(payload, "summary"), label("Changed files", valueText(payload, "changedFiles"))]),
      };
    case "run.failed":
      return {
        ...base,
        kind: "terminal",
        tone: "danger",
        title: "Run failed",
        body: joinParts([
          label("Code", displayTextField(payload, "code")),
          displayTextField(payload, "message"),
          label("Diagnostic file", displayTextField(payload, "diagnosticFile")),
        ]),
      };
    case "run.canceled":
      return {
        ...base,
        kind: "terminal",
        tone: "warning",
        title: "Run canceled",
        body: joinParts([label("Code", displayTextField(payload, "code")), displayTextField(payload, "reason")]),
      };
    default:
      return {
        ...base,
        kind: "raw",
        tone: "neutral",
        title: event.type,
        body: compactJson(event.payload),
        defaultCollapsed: true,
      };
  }
}

export function presentTimelineItems(
  items: readonly ChatTimelineItem[],
  supersededItemIds: ReadonlySet<string> = new Set(),
): {
  readonly visibleItems: readonly ChatTimelineItem[];
  readonly workItems: readonly ChatTimelineItem[];
} {
  const hasAssistantMessage = items.some((item) => item.kind === "assistant");
  const visibleItems: ChatTimelineItem[] = [];
  const workItems: ChatTimelineItem[] = [];
  let hasEmittedAssistant = false;
  let summaryStats = emptyWorkSummaryStats();

  for (const item of items) {
    if (supersededItemIds.has(item.id)) {
      continue;
    }
    if (isWorkLogItem(item, hasAssistantMessage)) {
      workItems.push(item);
      summaryStats = collectWorkSummaryStats(summaryStats, item);
    } else {
      if (hasEmittedAssistant && hasWorkSummaryStats(summaryStats)) {
        visibleItems.push(workSummaryItem(summaryStats, item));
        summaryStats = emptyWorkSummaryStats();
      } else if (!hasEmittedAssistant && item.kind === "assistant") {
        summaryStats = emptyWorkSummaryStats();
      }
      visibleItems.push(item);
      if (item.kind === "assistant") {
        hasEmittedAssistant = true;
      }
    }
  }

  return {
    visibleItems: collapseCompletedRunIntermediates(visibleItems, items, supersededItemIds),
    workItems,
  };
}

export function isWorkLogItem(item: ChatTimelineItem, hasAssistantMessage = false): boolean {
  if (item.kind === "user" || item.kind === "assistant") {
    return false;
  }

  if (item.type === "run.failed" || item.type === "run.canceled") {
    return false;
  }

  if (item.type === "run.completed" && !hasAssistantMessage) {
    return false;
  }

  return true;
}

export function isPersistentTimelineItem(item: ChatTimelineItem): boolean {
  return item.kind === "assistant" || item.kind === "terminal" || item.kind === "user";
}

function isDiscardableTimelineItem(item: ChatTimelineItem): boolean {
  return !isPersistentTimelineItem(item);
}

function assistantKey(event: AgentEventEnvelope): string {
  return `${event.runId}:${event.turnId ?? ""}`;
}

function eventMapKey(event: AgentEventEnvelope): string {
  return `${event.runId}:${event.seq}`;
}

function breaksAssistantSegment(type: string): boolean {
  return type === "turn.steered" || type.startsWith("tool.");
}

function collapseCompletedRunIntermediates(
  visibleItems: readonly ChatTimelineItem[],
  sourceItems: readonly ChatTimelineItem[],
  supersededItemIds: ReadonlySet<string>,
): readonly ChatTimelineItem[] {
  const completed = sourceItems.some(
    (item) => item.type === "run.completed" && supersededItemIds.has(item.id) !== true,
  );
  if (!completed) {
    return visibleItems;
  }

  let finalAssistantIndex = -1;
  for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
    if (visibleItems[index]?.kind === "assistant") {
      finalAssistantIndex = index;
      break;
    }
  }
  if (finalAssistantIndex <= 0) {
    return visibleItems;
  }

  const collapsedBeforeFinal = collapseCompletedIntermediateItems(visibleItems.slice(0, finalAssistantIndex));
  if (collapsedBeforeFinal === undefined) {
    return visibleItems;
  }

  return [...collapsedBeforeFinal, ...visibleItems.slice(finalAssistantIndex)];
}

function collapseCompletedIntermediateItems(items: readonly ChatTimelineItem[]): readonly ChatTimelineItem[] | undefined {
  const collapsedItems: ChatTimelineItem[] = [];
  let current: ChatTimelineItem[] = [];
  let collapsedGroupCount = 0;

  for (const item of items) {
    if (item.kind === "user") {
      if (current.length > 0) {
        collapsedItems.push(completedIntermediateGroupItem(current));
        collapsedGroupCount += 1;
        current = [];
      }
      collapsedItems.push(item);
      continue;
    }
    current.push(item);
  }

  if (current.length > 0) {
    collapsedItems.push(completedIntermediateGroupItem(current));
    collapsedGroupCount += 1;
  }
  return collapsedGroupCount === 0 ? undefined : collapsedItems;
}

function completedIntermediateGroupItem(items: readonly ChatTimelineItem[]): ChatTimelineItem {
  const first = items[0];
  const last = items[items.length - 1] ?? first;
  const runId = first?.runId ?? "run";
  const turnId = first?.turnId;
  return {
    id: `completed-intermediate:${runId}:${turnId ?? "run"}:${first?.seq ?? 0}-${last?.lastSeq ?? last?.seq ?? 0}`,
    seq: first?.seq ?? 0,
    lastSeq: last?.lastSeq ?? last?.seq ?? first?.seq ?? 0,
    time: last?.time ?? first?.time ?? "",
    type: "run.intermediate",
    runId,
    ...(turnId === undefined ? {} : { turnId }),
    kind: "run",
    tone: "neutral",
    title: "Earlier activity",
    body: completedIntermediateGroupBody(items),
    defaultCollapsed: true,
    children: items.map((item) => ({ ...item })),
  };
}

function completedIntermediateGroupBody(items: readonly ChatTimelineItem[]): string {
  const first = items[0];
  const leadingText = truncate(firstLine(first?.body ?? first?.title ?? ""), 160);
  return joinParts([
    `Collapsed ${countWithNoun(items.length, "timeline item", "timeline items")}.`,
    leadingText === undefined ? undefined : `Starts with: ${leadingText}`,
  ]) ?? "";
}

function supersededItemIdFromEvent(event: AgentEventEnvelope): string | undefined {
  if (event.type !== "turn.started") {
    return undefined;
  }

  const payload = record(event.payload);
  const supersedes = record(payload?.["supersedes"]);
  return textField(supersedes, "messageId");
}

function latestStatusFor(item: ChatTimelineItem): string {
  switch (item.type) {
    case "run.completed":
      return "Completed";
    case "run.failed":
      return "Failed";
    case "run.canceled":
      return "Canceled";
    case "tool.approvalRequired":
      return "Waiting for approval";
    default:
      return item.title;
  }
}

function approvalTone(decision: string): ChatTimelineTone {
  switch (decision) {
    case "approved":
      return "success";
    case "rejected":
    case "expired":
      return "danger";
    case "canceled":
      return "warning";
    default:
      return "neutral";
  }
}

function toolName(payload: Record<string, unknown> | undefined): string {
  return textField(payload, "name") ?? textField(payload, "toolName") ?? "tool";
}

interface WorkSummaryStats {
  readonly runId?: string;
  readonly turnId?: string;
  readonly firstSeq?: number;
  readonly lastSeq?: number;
  readonly time?: string;
  readonly changedFileCount: number;
  readonly commandCount: number;
}

function emptyWorkSummaryStats(): WorkSummaryStats {
  return {
    changedFileCount: 0,
    commandCount: 0,
  };
}

function collectWorkSummaryStats(stats: WorkSummaryStats, item: ChatTimelineItem): WorkSummaryStats {
  if (!isSummarizableWorkItem(item)) {
    return stats;
  }

  const changedFileCount = stats.changedFileCount + positiveInteger(item.changedFileCount);
  const commandCount = stats.commandCount + positiveInteger(item.commandCount);
  if (changedFileCount === stats.changedFileCount && commandCount === stats.commandCount) {
    return stats;
  }

  const turnId = stats.turnId ?? item.turnId;
  return {
    runId: stats.runId ?? item.runId,
    ...(turnId === undefined ? {} : { turnId }),
    firstSeq: stats.firstSeq ?? item.seq,
    lastSeq: item.lastSeq,
    time: item.time,
    changedFileCount,
    commandCount,
  };
}

function isSummarizableWorkItem(item: ChatTimelineItem): boolean {
  if (item.type !== "tool.completed") {
    return false;
  }

  const name = item.toolName ?? "";
  return TRIVIAL_WORK_TOOL_NAMES.has(name) !== true;
}

function hasWorkSummaryStats(stats: WorkSummaryStats): boolean {
  return stats.changedFileCount > 0 || stats.commandCount > 0;
}

function workSummaryItem(stats: WorkSummaryStats, nextItem: ChatTimelineItem): ChatTimelineItem {
  const firstSeq = stats.firstSeq ?? nextItem.seq;
  const lastSeq = stats.lastSeq ?? firstSeq;
  const runId = stats.runId ?? nextItem.runId;
  const turnId = stats.turnId ?? nextItem.turnId;
  return {
    id: `work-summary:${runId}:${stats.turnId ?? nextItem.turnId ?? "run"}:${firstSeq}-${lastSeq}`,
    seq: firstSeq,
    lastSeq,
    time: stats.time ?? nextItem.time,
    type: "work.summary",
    runId,
    ...(turnId === undefined ? {} : { turnId }),
    kind: "run",
    tone: "neutral",
    title: "Activity",
    body: workSummaryText(stats),
  };
}

function workSummaryText(stats: WorkSummaryStats): string {
  return `Modified ${countWithNoun(stats.changedFileCount, "file", "files")}, ran ${countWithNoun(
    stats.commandCount,
    "command",
    "commands",
  )}.`;
}

function countWithNoun(count: number, singular: string, plural: string): string {
  const value = positiveInteger(count);
  return `${value} ${value === 1 ? singular : plural}`;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function providerWorkGroup(
  event: AgentEventEnvelope,
  payload: Record<string, unknown> | undefined,
): Pick<ChatTimelineItem, "workGroupId" | "workGroupTitle"> {
  const iteration = valueText(payload, "iteration") ?? "unknown";
  return {
    workGroupId: `${event.runId}:${event.turnId ?? "run"}:provider:${iteration}`,
    workGroupTitle: `Provider iteration ${iteration}`,
  };
}

function toolWorkGroup(
  event: AgentEventEnvelope,
  payload: Record<string, unknown> | undefined,
): Pick<ChatTimelineItem, "workGroupId" | "workGroupTitle"> {
  const toolCallId = textField(payload, "toolCallId") ?? textField(payload, "approvalId") ?? String(event.seq);
  return {
    workGroupId: `${event.runId}:${event.turnId ?? "run"}:tool:${toolCallId}`,
    workGroupTitle: `Tool: ${toolName(payload)}`,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textField(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function valueText(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  if (payload === undefined || !(key in payload)) {
    return undefined;
  }

  return stringifyValue(payload[key]);
}

function displayTextField(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  return truncate(textField(payload, key), TIMELINE_DISPLAY_TEXT_LIMIT);
}

function displayValueText(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  return truncate(valueText(payload, key), TIMELINE_DISPLAY_TEXT_LIMIT);
}

function nestedValueText(
  payload: Record<string, unknown> | undefined,
  outer: string,
  inner: string,
): string | undefined {
  return valueText(record(payload?.[outer]), inner);
}

function displayNestedValueText(
  payload: Record<string, unknown> | undefined,
  outer: string,
  inner: string,
): string | undefined {
  return truncate(nestedValueText(payload, outer, inner), TIMELINE_DISPLAY_TEXT_LIMIT);
}

function arrayCount(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const count = arrayCountNumber(payload, key);
  return count === undefined ? undefined : count.toString();
}

function arrayCountNumber(payload: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = payload?.[key];
  return Array.isArray(value) ? value.length : undefined;
}

function nestedArrayCount(
  payload: Record<string, unknown> | undefined,
  outer: string,
  inner: string,
): number | undefined {
  return arrayCountNumber(record(payload?.[outer]), inner);
}

function arrayText(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return Array.isArray(value) ? value.map((entry) => String(entry)).join(", ") : undefined;
}

function displayArrayText(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  return truncate(arrayText(payload, key), TIMELINE_DISPLAY_TEXT_LIMIT);
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return compactJson(value);
}

function compactJson(value: unknown): string {
  try {
    return truncate(JSON.stringify(value), TIMELINE_COMPACT_JSON_LIMIT) ?? "";
  } catch {
    return String(value);
  }
}

function label(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${name}: ${value}`;
}

function suffix(value: string | undefined, unit: string): string | undefined {
  return value === undefined ? undefined : `${value}${unit}`;
}

function joinParts(parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return present.length > 0 ? present.join("\n") : undefined;
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined || value.length <= maxLength) {
    return value;
  }

  const sliceLength = Math.max(0, maxLength - TIMELINE_TRUNCATED_NOTICE.length);
  return `${value.slice(0, sliceLength)}${TIMELINE_TRUNCATED_NOTICE}`;
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/u)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? ""
  );
}
