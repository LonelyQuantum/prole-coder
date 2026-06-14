import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_APPROVE_LABEL,
  APPROVAL_APPROVE_SELECTED_HUNKS_LABEL,
  APPROVAL_DISMISSED_REASON,
  APPROVAL_REJECTED_REASON,
  APPROVAL_REJECT_LABEL,
  OPEN_CHAT_COMMAND,
  OPEN_CHAT_NO_WORKSPACE_MESSAGE,
  OPEN_SETTINGS_COMMAND,
  type ApprovalPromptRequest,
  type ApprovalWindowMessenger,
  type CommandRegistry,
  type DisposableLike,
  formatSettingsSummary,
  type WindowMessenger,
  registerOpenChatCommand,
  registerOpenSettingsCommand,
  requestApproval,
} from "../src/commands.js";

test("registerOpenChatCommand registers the public command id", () => {
  const disposable: DisposableLike = { dispose: () => undefined };
  let registeredCommand: string | undefined;

  const commands: CommandRegistry = {
    registerCommand(command) {
      registeredCommand = command;
      return disposable;
    },
  };

  const window: WindowMessenger = {
    showInformationMessage: () => undefined,
  };

  const returned = registerOpenChatCommand(commands, window);

  assert.equal(registeredCommand, OPEN_CHAT_COMMAND);
  assert.equal(returned, disposable);
});

test("open chat command asks for a workspace when RPC server is unavailable", () => {
  let callback: (() => unknown) | undefined;
  let message: string | undefined;

  const commands: CommandRegistry = {
    registerCommand(_command, registeredCallback) {
      callback = registeredCallback;
      return { dispose: () => undefined };
    },
  };

  const window: WindowMessenger = {
    showInformationMessage(value) {
      message = value;
    },
  };

  registerOpenChatCommand(commands, window);
  assert.ok(callback);

  callback();

  assert.equal(message, OPEN_CHAT_NO_WORKSPACE_MESSAGE);
  assert.ok(message?.includes("trusted workspace"));
});

test("open chat command opens chat and starts the RPC server without a success toast", async () => {
  let callback: (() => unknown) | undefined;
  let message: string | undefined;
  let chatOpened = false;
  let started = false;

  const commands: CommandRegistry = {
    registerCommand(_command, registeredCallback) {
      callback = registeredCallback;
      return { dispose: () => undefined };
    },
  };

  const window: WindowMessenger = {
    showInformationMessage(value) {
      message = value;
    },
  };

  registerOpenChatCommand(
    commands,
    window,
    {
      status: "stopped",
      async start() {
        started = true;
        return {
          server: {
            name: "prole-coder-agent-rpc",
            version: "0.1.0",
          },
        };
      },
    },
    {
      openChatView() {
        chatOpened = true;
      },
    },
  );
  assert.ok(callback);

  await callback();

  assert.equal(chatOpened, true);
  assert.equal(started, true);
  assert.equal(message, undefined);
});

test("open chat command reports RPC startup failures with warning messages", async () => {
  let callback: (() => unknown) | undefined;
  let warning: string | undefined;

  const commands: CommandRegistry = {
    registerCommand(_command, registeredCallback) {
      callback = registeredCallback;
      return { dispose: () => undefined };
    },
  };

  const window: WindowMessenger = {
    showInformationMessage: () => undefined,
    showWarningMessage(value) {
      warning = value;
    },
  };

  registerOpenChatCommand(commands, window, {
    status: "failed",
    start() {
      return Promise.reject(new Error("spawn denied"));
    },
  });
  assert.ok(callback);

  await callback();

  assert.ok(warning?.includes("failed to start"));
  assert.ok(warning?.includes("spawn denied"));
});

test("registerOpenSettingsCommand opens VS Code settings and reports server capabilities", async () => {
  const disposable: DisposableLike = { dispose: () => undefined };
  let registeredCommand: string | undefined;
  let callback: (() => unknown) | undefined;
  let settingsQuery: string | undefined;
  let message: string | undefined;

  const commands: CommandRegistry = {
    registerCommand(command, registeredCallback) {
      registeredCommand = command;
      callback = registeredCallback;
      return disposable;
    },
  };

  registerOpenSettingsCommand(
    commands,
    {
      showInformationMessage(value) {
        message = value;
      },
      openSettings(query) {
        settingsQuery = query;
      },
    },
    sampleSettingsRpcServer(),
  );
  assert.equal(registeredCommand, OPEN_SETTINGS_COMMAND);
  assert.ok(callback);

  await callback();

  assert.equal(settingsQuery, "@ext:prole-coder.prole-coder-vscode");
  assert.ok(message?.includes("Provider: deepseek"));
  assert.ok(message?.includes("Model: DeepSeek V4 Pro"));
  assert.ok(message?.includes("Budget: 1048576 context tokens"));
  assert.ok(message?.includes("RPC: prole rpc"));
  assert.ok(message?.includes("not stored in VS Code settings"));
  assert.equal(message?.toLowerCase().includes("api key:"), false);
});

test("formatSettingsSummary uses server capability data without model name inference", () => {
  const summary = formatSettingsSummary(
    {
      command: "prole",
      args: ["rpc"],
      autoStart: true,
    },
    {
      server: {
        name: "prole-coder-agent-rpc",
        version: "0.1.0",
      },
      stateDir: ".prole-coder",
      capabilities: {
        supportsPersistentApprovals: true,
        provider: {
          provider: "deepseek",
          defaultModel: "custom-model",
          models: [
            {
              id: "custom-model",
              contextWindowTokens: 123,
              maxOutputTokens: 45,
              supportsThinking: false,
              supportsToolCalls: true,
              supportsToolChoice: true,
              supportsFim: false,
              supportsStreaming: true,
              reportsCacheUsage: false,
            },
          ],
        },
      },
    },
  );

  assert.ok(summary.includes("Model: custom-model (custom-model)"));
  assert.ok(summary.includes("no-thinking"));
  assert.ok(summary.includes("no-fim"));
  assert.ok(summary.includes("123 context tokens, 45 max output tokens"));
});

test("open chat command falls back to information messages for non-Error startup failures", async () => {
  let callback: (() => unknown) | undefined;
  let info: string | undefined;

  const commands: CommandRegistry = {
    registerCommand(_command, registeredCallback) {
      callback = registeredCallback;
      return { dispose: () => undefined };
    },
  };

  const window: WindowMessenger = {
    showInformationMessage(value) {
      info = value;
    },
  };

  registerOpenChatCommand(commands, window, {
    status: "failed",
    start() {
      return Promise.reject("plain failure");
    },
  });
  assert.ok(callback);

  await callback();

  assert.ok(info?.includes("failed to start"));
  assert.ok(info?.includes("plain failure"));
});

test("requestApproval maps the simple approve choice to one-shot approval", async () => {
  let message: string | undefined;
  let modal: boolean | undefined;
  let items: readonly string[] = [];
  const window: ApprovalWindowMessenger = {
    showWarningMessage(value, options, ...choices) {
      message = value;
      modal = options.modal;
      items = choices;
      return APPROVAL_APPROVE_LABEL;
    },
  };

  const decision = await requestApproval(window, sampleApprovalRequest(true));

  assert.deepEqual(decision, {
    kind: "approve",
    approvalId: "approval_1",
    persist: "never",
  });
  assert.equal(modal, true);
  assert.ok(message?.includes("Command: cargo test"));
  assert.ok(message?.includes("Cwd: crates/cli"));
  assert.equal(message?.includes("Output: last run passed"), false);
  assert.deepEqual(items, [APPROVAL_APPROVE_LABEL, APPROVAL_REJECT_LABEL]);
});

test("requestApproval keeps the modal choices simple for all risks", async () => {
  for (const risk of ["exec", "network", "destructive"] as const) {
    let items: readonly string[] = [];
    const window: ApprovalWindowMessenger = {
      showWarningMessage(_message, _options, ...choices) {
        items = choices;
        return APPROVAL_APPROVE_LABEL;
      },
    };

    const decision = await requestApproval(window, {
      ...sampleApprovalRequest(true),
      risk,
    });

    assert.equal(decision.kind, "approve");
    assert.deepEqual(items, [APPROVAL_APPROVE_LABEL, APPROVAL_REJECT_LABEL]);
  }
});

test("requestApproval maps non-persistable approve to one-shot approval", async () => {
  let items: readonly string[] = [];
  const window: ApprovalWindowMessenger = {
    showWarningMessage(_message, _options, ...choices) {
      items = choices;
      return APPROVAL_APPROVE_LABEL;
    },
  };

  const decision = await requestApproval(window, sampleApprovalRequest(false));

  assert.deepEqual(decision, {
    kind: "approve",
    approvalId: "approval_1",
    persist: "never",
  });
  assert.deepEqual(items, [APPROVAL_APPROVE_LABEL, APPROVAL_REJECT_LABEL]);
});

test("requestApproval maps selected patch hunks to one-shot approve params", async () => {
  let warningChoices: readonly string[] = [];
  let quickPickItems: readonly { readonly hunkId: string }[] = [];
  const window: ApprovalWindowMessenger = {
    showWarningMessage(_message, _options, ...choices) {
      warningChoices = choices;
      return APPROVAL_APPROVE_SELECTED_HUNKS_LABEL;
    },
    showQuickPick(items) {
      quickPickItems = items;
      return [items[1]].filter((item): item is (typeof items)[number] => item !== undefined);
    },
  };

  const decision = await requestApproval(window, {
    ...sampleApprovalRequest(true),
    toolName: "apply_patch",
    hunks: [
      {
        id: "README.md#1:old1+3:new1+3",
        filePath: "README.md",
        fileIndex: 0,
        hunkIndex: 0,
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 3,
      },
      {
        id: "README.md#2:old5+2:new5+3",
        filePath: "README.md",
        fileIndex: 0,
        hunkIndex: 1,
        oldStart: 5,
        oldCount: 2,
        newStart: 5,
        newCount: 3,
        section: "next block",
      },
    ],
  });

  assert.ok(warningChoices.includes(APPROVAL_APPROVE_SELECTED_HUNKS_LABEL));
  assert.equal(quickPickItems.length, 2);
  assert.deepEqual(decision, {
    kind: "approve",
    approvalId: "approval_1",
    persist: "never",
    hunks: {
      approved: ["README.md#2:old5+2:new5+3"],
    },
  });
});

test("requestApproval includes command and joined paths in the modal message", async () => {
  let message = "";
  const window: ApprovalWindowMessenger = {
    showWarningMessage(value) {
      message = value;
      return APPROVAL_REJECT_LABEL;
    },
  };

  await requestApproval(window, {
    ...sampleApprovalRequest(false),
    command: "cargo test -p prole-coder-cli",
    paths: ["crates/cli/src/lib.rs", "crates/cli/tests/run_smoke.rs"],
    riskReasons: ["dependency install/update"],
  });

  assert.ok(message.includes("Command: cargo test -p prole-coder-cli"));
  assert.ok(
    message.includes("Paths: crates/cli/src/lib.rs, crates/cli/tests/run_smoke.rs"),
  );
  assert.ok(message.includes("Risk reasons: dependency install/update"));
});

test("requestApproval maps reject and dismiss to reject decisions", async () => {
  const rejectWindow: ApprovalWindowMessenger = {
    showWarningMessage() {
      return APPROVAL_REJECT_LABEL;
    },
  };
  const rejected = await requestApproval(rejectWindow, sampleApprovalRequest(false));

  assert.deepEqual(rejected, {
    kind: "reject",
    approvalId: "approval_1",
    reason: APPROVAL_REJECTED_REASON,
  });

  const dismissWindow: ApprovalWindowMessenger = {
    showWarningMessage() {
      return undefined;
    },
  };
  const dismissed = await requestApproval(dismissWindow, sampleApprovalRequest(false));

  assert.deepEqual(dismissed, {
    kind: "reject",
    approvalId: "approval_1",
    reason: APPROVAL_DISMISSED_REASON,
  });
});

function sampleApprovalRequest(persistable: boolean): ApprovalPromptRequest {
  return {
    approvalId: "approval_1",
    toolCallId: "tool_call_1",
    toolName: "shell",
    risk: "exec",
    title: "Execute shell command",
    detail: "Run verification",
    persistable,
    command: "cargo test",
    cwd: "crates/cli",
    outputSummary: "last run passed",
    paths: ["crates/cli/src/lib.rs"],
  };
}

function sampleSettingsRpcServer() {
  return {
    status: "ready",
    launchConfig: {
      command: "prole",
      args: ["rpc"],
      autoStart: true,
    },
    async start() {
      return {
        server: {
          name: "prole-coder-agent-rpc",
          version: "0.1.0",
        },
        stateDir: ".prole-coder",
        capabilities: {
          supportsPersistentApprovals: true,
          provider: {
            provider: "deepseek",
            defaultModel: "deepseek-v4-pro",
            models: [
              {
                id: "deepseek-v4-pro",
                displayName: "DeepSeek V4 Pro",
                contextWindowTokens: 1_048_576,
                maxOutputTokens: 393_216,
                supportsThinking: true,
                supportsToolCalls: true,
                supportsToolChoice: false,
                supportsFim: true,
                supportsStreaming: true,
                reportsCacheUsage: true,
              },
            ],
          },
        },
      };
    },
  };
}
