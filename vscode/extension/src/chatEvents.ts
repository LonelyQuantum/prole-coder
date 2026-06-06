import type { AgentEventEnvelope } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

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
}

export interface ChatTimelineSnapshot {
  readonly eventCount: number;
  readonly items: readonly ChatTimelineItem[];
  readonly visibleItems?: readonly ChatTimelineItem[];
  readonly workItems?: readonly ChatTimelineItem[];
  readonly supersededItemIds?: readonly string[];
  readonly latestRunId?: string;
  readonly latestStatus?: string;
}

export interface ChatEventTimelineOptions {
  readonly maxItems?: number;
}

export class ChatEventTimeline {
  private readonly maxItems: number;
  private readonly items: ChatTimelineItem[] = [];
  private readonly assistantItemsByTurn = new Map<string, string>();
  private readonly supersededItemIds = new Set<string>();
  private eventCount = 0;
  private latestRunId: string | undefined;
  private latestStatus: string | undefined;

  constructor(options: ChatEventTimelineOptions = {}) {
    this.maxItems = options.maxItems ?? 300;
  }

  append(event: AgentEventEnvelope): ChatTimelineSnapshot {
    this.eventCount += 1;
    this.latestRunId = event.runId;
    const supersededItemId = supersededItemIdFromEvent(event);
    if (supersededItemId !== undefined) {
      this.supersededItemIds.add(supersededItemId);
    }

    if (event.type === "assistant.delta") {
      this.appendAssistantDelta(event);
    } else {
      const item = createTimelineItem(event);
      this.items.push(item);
      this.latestStatus = latestStatusFor(item);
      this.trimItems();
    }

    return this.snapshot();
  }

  clear(): ChatTimelineSnapshot {
    this.items.length = 0;
    this.assistantItemsByTurn.clear();
    this.supersededItemIds.clear();
    this.eventCount = 0;
    this.latestRunId = undefined;
    this.latestStatus = undefined;
    return this.snapshot();
  }

  snapshot(): ChatTimelineSnapshot {
    const items = this.items.map((item) => ({ ...item }));
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
    };
  }

  private appendAssistantDelta(event: AgentEventEnvelope): void {
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
    this.trimItems();
  }

  private trimItems(): void {
    if (this.items.length <= this.maxItems) {
      return;
    }

    this.items.splice(0, this.items.length - this.maxItems);
    this.rebuildAssistantIndex();
  }

  private rebuildAssistantIndex(): void {
    this.assistantItemsByTurn.clear();
    for (const item of this.items) {
      if (item.kind === "assistant") {
        this.assistantItemsByTurn.set(`${item.runId}:${item.turnId ?? ""}`, item.id);
      }
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
        body: joinParts([
          label("Model", textField(payload, "model")),
          label("Finish", textField(payload, "finishReason")),
          label("Duration", suffix(valueText(payload, "durationMs"), "ms")),
          label("Total tokens", nestedValueText(payload, "usage", "totalTokens")),
        ]),
        defaultCollapsed: true,
      };
    case "tool.requested":
      return {
        ...base,
        kind: "tool",
        tone: "neutral",
        title: `Tool requested: ${toolName(payload)}`,
        body: joinParts([
          label("Risk", textField(payload, "risk")),
          label("Reasons", arrayText(payload, "riskReasons")),
          label("Args", valueText(payload, "argumentsPreview")),
        ]),
        defaultCollapsed: true,
      };
    case "tool.approvalRequired":
      return {
        ...base,
        kind: "approval",
        tone: "warning",
        title: `Approval required: ${textField(payload, "toolName") ?? "tool"}`,
        body: joinParts([
          textField(payload, "title"),
          textField(payload, "detail"),
          label("Risk", textField(payload, "risk")),
          label("Reasons", arrayText(payload, "riskReasons")),
          label("Command", textField(payload, "command")),
          label("Paths", arrayText(payload, "paths")),
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
        body: joinParts([label("Tool", textField(payload, "toolName")), label("Reason", textField(payload, "reason"))]),
        defaultCollapsed: true,
      };
    }
    case "tool.started":
      return {
        ...base,
        kind: "tool",
        tone: "running",
        title: `Tool started: ${toolName(payload)}`,
        body: label("Call", textField(payload, "toolCallId")),
        defaultCollapsed: true,
      };
    case "tool.completed": {
      const status = textField(payload, "status");
      return {
        ...base,
        kind: "tool",
        tone: status === "ok" || status === "success" ? "success" : "warning",
        title: `Tool completed: ${toolName(payload)}`,
        body: joinParts([
          label("Status", status),
          textField(payload, "summary"),
          label("Files", nestedValueText(payload, "result", "files")),
        ]),
        defaultCollapsed: true,
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
          label("Code", textField(payload, "code")),
          textField(payload, "message"),
          label("Diagnostic file", textField(payload, "diagnosticFile")),
        ]),
      };
    case "run.canceled":
      return {
        ...base,
        kind: "terminal",
        tone: "warning",
        title: "Run canceled",
        body: joinParts([label("Code", textField(payload, "code")), textField(payload, "reason")]),
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

  for (const item of items) {
    if (supersededItemIds.has(item.id)) {
      continue;
    }
    if (isWorkLogItem(item, hasAssistantMessage)) {
      workItems.push(item);
    } else {
      visibleItems.push(item);
    }
  }

  return { visibleItems, workItems };
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

function assistantKey(event: AgentEventEnvelope): string {
  return `${event.runId}:${event.turnId ?? ""}`;
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

function nestedValueText(
  payload: Record<string, unknown> | undefined,
  outer: string,
  inner: string,
): string | undefined {
  return valueText(record(payload?.[outer]), inner);
}

function arrayCount(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return Array.isArray(value) ? value.length.toString() : undefined;
}

function arrayText(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return Array.isArray(value) ? value.map((entry) => String(entry)).join(", ") : undefined;
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
    return truncate(JSON.stringify(value), 800);
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

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}
