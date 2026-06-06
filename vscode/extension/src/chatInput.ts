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

  const message = typeof value["message"] === "string" ? value["message"].trim() : "";
  if (message.length === 0) {
    return { ok: false, error: "Enter a message before sending." };
  }

  const mode = value["mode"];
  if (!isRpcRunMode(mode)) {
    return { ok: false, error: "Choose a valid run mode." };
  }

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
