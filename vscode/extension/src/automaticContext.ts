import type { TurnAttachment } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

import type { ChatTimelineItem, ChatTimelineSnapshot } from "./chatEvents";

export const MAX_TURN_ATTACHMENTS = 32;
const DEFAULT_MAX_CONTEXT_CHARS = 24_000;
const DEFAULT_RECENT_MESSAGES = 8;
const DEFAULT_COMPACTED_LINE_CHARS = 240;
const DEFAULT_TIMELINE_MESSAGE_CHARS = 8_000;
const AUTOMATIC_CONTEXT_PREFIX = "ProleCoder automatic conversation context";

export interface ConversationContextMessage {
  readonly role: "assistant" | "system" | "user";
  readonly text: string;
}

export interface AutomaticContextOptions {
  readonly maxChars?: number;
  readonly recentMessages?: number;
  readonly compactedLineChars?: number;
}

export function automaticContextAttachmentFromMessages(
  messages: readonly ConversationContextMessage[],
  options: AutomaticContextOptions = {},
): TurnAttachment | undefined {
  const cleaned = messages
    .map((message) => ({
      role: message.role,
      text: normalizeText(message.text),
    }))
    .filter((message) => message.text.length > 0);

  if (cleaned.length === 0) {
    return undefined;
  }

  const maxChars = positiveInteger(options.maxChars, DEFAULT_MAX_CONTEXT_CHARS);
  const recentMessages = positiveInteger(options.recentMessages, DEFAULT_RECENT_MESSAGES);
  const compactedLineChars = positiveInteger(
    options.compactedLineChars,
    DEFAULT_COMPACTED_LINE_CHARS,
  );
  const compactedCount = Math.max(0, cleaned.length - recentMessages);
  const compacted = cleaned.slice(0, compactedCount);
  const recent = cleaned.slice(compactedCount);

  const sections = [
    AUTOMATIC_CONTEXT_PREFIX,
    `Total entries: ${cleaned.length}`,
    `Compacted entries: ${compacted.length}`,
    `Recent entries: ${recent.length}`,
  ];

  if (compacted.length > 0) {
    sections.push(
      "",
      "[Compacted Earlier Entries]",
      ...compacted.map(
        (message, index) =>
          `${index + 1}. ${roleLabel(message.role)}: ${firstLine(message.text, compactedLineChars)}`,
      ),
    );
  }

  sections.push("", "[Recent Entries]");
  for (const message of recent) {
    sections.push(`${roleLabel(message.role)}:`, message.text, "");
  }

  const text = clampText(sections.join("\n"), maxChars);
  if (text.length === 0) {
    return undefined;
  }

  return {
    kind: "explicit_content",
    text,
  };
}

export function automaticContextAttachmentFromTimeline(
  snapshot: ChatTimelineSnapshot,
  options: AutomaticContextOptions = {},
): TurnAttachment | undefined {
  return automaticContextAttachmentFromMessages(messagesFromTimeline(snapshot.items), options);
}

export function mergeTurnAttachments(
  automaticContext: TurnAttachment | undefined,
  attachments: readonly TurnAttachment[],
): readonly TurnAttachment[] {
  if (automaticContext === undefined) {
    return attachments.slice(0, MAX_TURN_ATTACHMENTS);
  }

  return [automaticContext, ...attachments.slice(0, MAX_TURN_ATTACHMENTS - 1)];
}

export function isAutomaticContextAttachment(attachment: TurnAttachment): boolean {
  return (
    attachment.kind === "explicit_content" &&
    typeof attachment.text === "string" &&
    attachment.text.startsWith(AUTOMATIC_CONTEXT_PREFIX)
  );
}

function messagesFromTimeline(items: readonly ChatTimelineItem[]): ConversationContextMessage[] {
  const messages: ConversationContextMessage[] = [];
  for (const item of items) {
    const text = timelineMessageText(item);
    if (text.length === 0) {
      continue;
    }

    if (item.type === "turn.started") {
      messages.push({ role: "user", text });
    } else if (item.type === "assistant.delta") {
      messages.push({ role: "assistant", text });
    } else if (item.kind === "terminal" || item.kind === "approval" || item.kind === "tool") {
      messages.push({ role: "system", text: `${item.title}\n${text}` });
    }
  }
  return messages;
}

function timelineMessageText(item: ChatTimelineItem): string {
  return clampText(item.body ?? item.title, DEFAULT_TIMELINE_MESSAGE_CHARS);
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function firstLine(value: string, maxChars: number): string {
  const line = value
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0) ?? "";
  return clampText(line, maxChars).replace(/\n/gu, " ");
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const marker = "\n[automatic context clipped]\n";
  if (maxChars <= marker.length) {
    return value.slice(0, maxChars);
  }

  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

function roleLabel(role: ConversationContextMessage["role"]): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "user":
      return "User";
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
