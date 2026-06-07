import type { RpcRunMode, SendTurnParams, TurnAttachment, TurnSupersedes } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

export const DEFAULT_CHAT_MODE: RpcRunMode = "edit";
const CHAT_RUN_MODE_LOOKUP = {
  edit: true,
  ask: true,
  plan: true,
  review: true,
} as const satisfies Record<RpcRunMode, true>;

export const CHAT_RUN_MODES = ["edit", "ask", "plan", "review"] as const satisfies readonly RpcRunMode[];

export interface ChatTurnSubmission {
  readonly message: string;
  readonly mode: RpcRunMode;
  readonly supersedes?: TurnSupersedes;
}

export type ChatTurnSubmissionParseResult =
  | {
      readonly ok: true;
      readonly value: ChatTurnSubmission;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export function parseChatTurnSubmission(value: unknown): ChatTurnSubmissionParseResult {
  if (!isRecord(value)) {
    return { ok: false, error: "Invalid chat submission." };
  }

  let message = typeof value["message"] === "string" ? value["message"].trim() : "";
  if (message.length === 0) {
    return { ok: false, error: "Enter a message before sending." };
  }

  const prefixedMode = parseExplicitModePrefix(message);
  if (prefixedMode !== undefined) {
    message = prefixedMode.message;
    if (message.length === 0) {
      return { ok: false, error: "Enter a message after the run mode prefix." };
    }
  }

  const rawMode = value["mode"];
  if (rawMode !== undefined && !isRpcRunMode(rawMode)) {
    return { ok: false, error: "Choose a valid run mode." };
  }
  const explicitMode = isRpcRunMode(rawMode) ? rawMode : undefined;
  const mode = prefixedMode?.mode ?? explicitMode ?? inferChatRunMode(message);

  const supersedes = parseTurnSupersedes(value["supersedes"]);
  if (supersedes === false) {
    return { ok: false, error: "Invalid edit resend metadata." };
  }

  return {
    ok: true,
    value: {
      message,
      mode,
      ...(supersedes === undefined ? {} : { supersedes }),
    },
  };
}

export function sendTurnParams(
  submission: ChatTurnSubmission,
  attachments: readonly TurnAttachment[] = [],
): SendTurnParams {
  return {
    message: submission.message,
    mode: submission.mode,
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(submission.supersedes === undefined ? {} : { supersedes: submission.supersedes }),
  };
}

export function isRpcRunMode(value: unknown): value is RpcRunMode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHAT_RUN_MODE_LOOKUP, value);
}

export function inferChatRunMode(message: string): RpcRunMode {
  const text = message.trim();
  if (text.length === 0) {
    return DEFAULT_CHAT_MODE;
  }

  if (matchesAny(text, REVIEW_PATTERNS)) {
    return "review";
  }
  if (matchesAny(text, PLAN_PATTERNS)) {
    return "plan";
  }
  if (isQuestionLike(text) || matchesAny(text, ASK_PATTERNS)) {
    return "ask";
  }
  if (matchesAny(text, EDIT_PATTERNS)) {
    return "edit";
  }

  return DEFAULT_CHAT_MODE;
}

const EXPLICIT_SLASH_MODE_PREFIX = /^\/(ask|plan|review|edit)(?:\s+|$)/i;
const EXPLICIT_LABEL_MODE_PREFIX = /^(ask|plan|review|edit)\s*:\s*/i;

const REVIEW_PATTERNS = [
  /\b(code\s+review|review|audit|inspect)\b/i,
  /代码审查|审查|评审/,
];
const PLAN_PATTERNS = [
  /\b(plan|proposal|design|roadmap|architecture|discuss|brainstorm)\b/i,
  /计划|方案|设计|讨论|规划|路线图|架构/,
];
const EDIT_PATTERNS = [
  /\b(fix|repair|implement|add|update|change|modify|refactor|delete|remove|create|write|complete|restore|reset|generate)\b/i,
  /修复|改动|修改|实现|开发|补齐|添加|删除|移除|创建|生成|还原|复原|完成|整理|更新|标记/,
];
const ASK_PATTERNS = [
  /\b(what|why|how|where|when|explain|summari[sz]e|show|tell)\b/i,
  /是什么|为什么|怎么|如何|是否|能不能|可以吗|有没有|介绍|解释|总结|查看|检查一下/,
];

function parseExplicitModePrefix(message: string): { readonly mode: RpcRunMode; readonly message: string } | undefined {
  const slash = message.match(EXPLICIT_SLASH_MODE_PREFIX);
  if (slash !== null && isRpcRunMode(slash[1])) {
    return {
      mode: slash[1],
      message: message.slice(slash[0].length).trim(),
    };
  }

  const label = message.match(EXPLICIT_LABEL_MODE_PREFIX);
  if (label !== null && isRpcRunMode(label[1])) {
    return {
      mode: label[1],
      message: message.slice(label[0].length).trim(),
    };
  }

  return undefined;
}

function matchesAny(message: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

function isQuestionLike(message: string): boolean {
  return /[?？]\s*$/.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTurnSupersedes(value: unknown): TurnSupersedes | undefined | false {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return false;
  }

  const messageId = typeof value["messageId"] === "string" ? value["messageId"].trim() : "";
  if (messageId.length === 0) {
    return false;
  }
  const turnId = typeof value["turnId"] === "string" ? value["turnId"].trim() : "";
  return {
    messageId,
    ...(turnId.length === 0 ? {} : { turnId }),
  };
}
