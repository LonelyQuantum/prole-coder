import type { SendTurnParams, SendTurnResult, TurnAttachment } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

import type { MessageRedactor } from "./redaction";
import type { AgentEventEnvelope, DisposableLike } from "./rpcServer";

export const GENERATE_COMMIT_MESSAGE_COMMAND = "prole-coder.generateCommitMessage";
export const GENERATE_PR_DESCRIPTION_COMMAND = "prole-coder.generatePrDescription";

const USE_UNSTAGED_CHANGES_LABEL = "Use Unstaged";

type AgentTextTerminalResult =
  | {
      readonly state: "completed";
      readonly text: string;
    }
  | {
      readonly state: "failed";
      readonly error: Error;
    };

export interface GitWorkflowRepository {
  readonly label: string;
  readonly rootPath: string;
  readonly branch?: string | undefined;
  readonly upstream?: string | undefined;
  readonly inputBox?: {
    value: string;
  };
  stagedDiff(): Promise<string>;
  unstagedDiff(): Promise<string>;
  diffStat(base: string): Promise<string>;
  branchDiff(base: string): Promise<string>;
  commitSummary(base: string): Promise<string>;
  refExists(ref: string): Promise<boolean>;
}

export interface GitWorkflowRepositoryProvider {
  repositories(): Promise<readonly GitWorkflowRepository[]>;
}

export interface GitWorkflowWindow {
  showInformationMessage(message: string): unknown;
  showWarningMessage(
    message: string,
    ...items: string[]
  ): string | undefined | PromiseLike<string | undefined>;
  showQuickPick?(
    items: readonly GitWorkflowRepositoryQuickPickItem[],
    options: { readonly placeHolder: string },
  ):
    | GitWorkflowRepositoryQuickPickItem
    | undefined
    | PromiseLike<GitWorkflowRepositoryQuickPickItem | undefined>;
  showInputBox?(options: { readonly prompt: string; readonly title: string }): string | undefined | PromiseLike<string | undefined>;
}

export interface GitWorkflowRepositoryQuickPickItem {
  readonly label: string;
  readonly description: string;
  readonly repository: GitWorkflowRepository;
}

export interface GitWorkflowAgent {
  onEvent(handler: (event: AgentEventEnvelope) => void): DisposableLike;
  sendTurn(params: SendTurnParams): Promise<SendTurnResult>;
}

export interface GitWorkflowMarkdownSink {
  showMarkdown(content: string, title: string): Promise<void> | void;
  copyToClipboard?(content: string): Promise<void> | void;
}

export interface GenerateCommitMessageOptions {
  readonly repositories: GitWorkflowRepositoryProvider;
  readonly window: GitWorkflowWindow;
  readonly agent?: GitWorkflowAgent | undefined;
  readonly redactor?: MessageRedactor | undefined;
}

export interface GeneratePrDescriptionOptions extends GenerateCommitMessageOptions {
  readonly markdownSink: GitWorkflowMarkdownSink;
}

export async function generateCommitMessage(options: GenerateCommitMessageOptions): Promise<void> {
  try {
    await generateCommitMessageUnchecked(options);
  } catch (error) {
    options.window.showWarningMessage(
      redactMessage(`Failed to generate commit message: ${errorMessage(error)}`, options.redactor),
    );
  }
}

async function generateCommitMessageUnchecked(options: GenerateCommitMessageOptions): Promise<void> {
  if (options.agent === undefined) {
    options.window.showWarningMessage("Open a trusted workspace before generating a commit message.");
    return;
  }

  const repository = await selectRepository(options.repositories, options.window);
  if (repository === undefined) {
    return;
  }

  const diff = await commitDiff(repository, options.window);
  if (diff === undefined) {
    return;
  }

  const message = await collectAgentText(options.agent, {
    message: "Generate a concise Conventional Commit message for the attached staged diff. Respond with only the commit message.",
    mode: "ask",
    attachments: [explicitContentAttachment("git/staged.diff", diff)],
  });

  const value = message.trim();
  if (repository.inputBox !== undefined) {
    repository.inputBox.value = value;
  }
  options.window.showInformationMessage("Commit message generated in Source Control.");
}

export async function generatePrDescription(options: GeneratePrDescriptionOptions): Promise<void> {
  try {
    await generatePrDescriptionUnchecked(options);
  } catch (error) {
    options.window.showWarningMessage(
      redactMessage(`Failed to generate PR description: ${errorMessage(error)}`, options.redactor),
    );
  }
}

async function generatePrDescriptionUnchecked(options: GeneratePrDescriptionOptions): Promise<void> {
  if (options.agent === undefined) {
    options.window.showWarningMessage("Open a trusted workspace before generating a PR description.");
    return;
  }

  const repository = await selectRepository(options.repositories, options.window);
  if (repository === undefined) {
    return;
  }

  const base = await selectBaseRef(repository, options.window);
  if (base === undefined) {
    return;
  }

  const [diffStat, branchDiff, commits] = await Promise.all([
    repository.diffStat(base),
    repository.branchDiff(base),
    repository.commitSummary(base),
  ]);
  const content = await collectAgentText(options.agent, {
    message:
      "Generate a pull request title and markdown body for the attached branch context. Include Summary, Tests, Risks, and Follow-ups sections. Respond with markdown only.",
    mode: "ask",
    attachments: [
      explicitContentAttachment(
        `git/pr-${base}.md`,
        [
          `Base: ${base}`,
          `Branch: ${repository.branch ?? "unknown"}`,
          "",
          "## Commits",
          commits,
          "",
          "## Diff Stat",
          diffStat,
          "",
          "## Diff",
          branchDiff,
        ].join("\n"),
      ),
    ],
  });

  const markdown = content.trim();
  await options.markdownSink.showMarkdown(markdown, "ProleCoder PR Description");
  await options.markdownSink.copyToClipboard?.(markdown);
  options.window.showInformationMessage("PR description generated as markdown.");
}

async function selectRepository(
  provider: GitWorkflowRepositoryProvider,
  window: GitWorkflowWindow,
): Promise<GitWorkflowRepository | undefined> {
  const repositories = await provider.repositories();
  if (repositories.length === 0) {
    window.showWarningMessage("Open a Git repository before using ProleCoder Git workflows.");
    return undefined;
  }

  if (repositories.length === 1) {
    return repositories[0];
  }

  if (window.showQuickPick === undefined) {
    window.showWarningMessage("Multiple Git repositories are open; choose a repository first.");
    return undefined;
  }

  const selected = await window.showQuickPick(
    repositories.map((repository) => ({
      label: repository.label,
      description: repository.rootPath,
      repository,
    })),
    {
      placeHolder: "Choose a repository for the ProleCoder Git workflow",
    },
  );
  return selected?.repository;
}

async function commitDiff(
  repository: GitWorkflowRepository,
  window: GitWorkflowWindow,
): Promise<string | undefined> {
  const staged = await repository.stagedDiff();
  if (staged.trim().length > 0) {
    return staged;
  }

  const selected = await window.showWarningMessage(
    "No staged diff found. Use unstaged changes as context?",
    USE_UNSTAGED_CHANGES_LABEL,
  );
  if (selected !== USE_UNSTAGED_CHANGES_LABEL) {
    return undefined;
  }

  const unstaged = await repository.unstagedDiff();
  if (unstaged.trim().length === 0) {
    window.showWarningMessage("No unstaged changes found.");
    return undefined;
  }
  return unstaged;
}

async function selectBaseRef(
  repository: GitWorkflowRepository,
  window: GitWorkflowWindow,
): Promise<string | undefined> {
  if (repository.upstream !== undefined && repository.upstream.length > 0) {
    return repository.upstream;
  }

  for (const candidate of ["main", "master"]) {
    if (await repository.refExists(candidate)) {
      return candidate;
    }
  }

  const value = await window.showInputBox?.({
    title: "Choose PR Base",
    prompt: "Enter the base branch or ref for the PR description.",
  });
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    window.showWarningMessage("Choose a base branch before generating a PR description.");
    return undefined;
  }
  return normalized;
}

async function collectAgentText(agent: GitWorkflowAgent, params: SendTurnParams): Promise<string> {
  let runId: string | undefined;
  const bufferedEvents: AgentEventEnvelope[] = [];
  const textParts: string[] = [];
  let terminalResult: AgentTextTerminalResult | undefined;
  let resolveTerminal: ((result: AgentTextTerminalResult) => void) | undefined;

  const terminalPromise = new Promise<AgentTextTerminalResult>((resolve) => {
    resolveTerminal = resolve;
  });

  const subscription = agent.onEvent((event) => {
    if (runId === undefined) {
      bufferedEvents.push(event);
      return;
    }
    handleAgentEvent(event, runId, textParts, finish);
  });

  try {
    const result = await agent.sendTurn(params);
    runId = result.runId;
    for (const event of bufferedEvents) {
      handleAgentEvent(event, runId, textParts, finish);
    }
    if (terminalResult !== undefined) {
      return terminalText(terminalResult);
    }
    return terminalText(await terminalPromise);
  } finally {
    subscription.dispose();
  }

  function finish(result: AgentTextTerminalResult): void {
    if (terminalResult !== undefined) {
      return;
    }
    terminalResult = result;
    resolveTerminal?.(result);
  }
}

function handleAgentEvent(
  event: AgentEventEnvelope,
  runId: string,
  textParts: string[],
  finish: (result: AgentTextTerminalResult) => void,
): void {
  if (event.runId !== runId) {
    return;
  }

  if (event.type === "assistant.delta" && isRecord(event.payload) && typeof event.payload["text"] === "string") {
    textParts.push(event.payload["text"]);
    return;
  }

  if (event.type === "run.completed") {
    finish({ state: "completed", text: textParts.join("") });
    return;
  }

  if (event.type === "run.failed") {
    finish({ state: "failed", error: new Error(terminalMessage(event, "Agent run failed.")) });
    return;
  }

  if (event.type === "run.canceled") {
    finish({ state: "failed", error: new Error(terminalMessage(event, "Agent run canceled.")) });
  }
}

function terminalText(result: AgentTextTerminalResult): string {
  if (result.state === "completed") {
    return result.text;
  }
  throw result.error;
}

function explicitContentAttachment(path: string, text: string): TurnAttachment {
  return {
    kind: "explicit_content",
    path,
    text,
  };
}

function terminalMessage(event: AgentEventEnvelope, fallback: string): string {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const message = payload?.["message"] ?? payload?.["reason"] ?? payload?.["summary"];
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactMessage(message: string, redactor: MessageRedactor | undefined): string {
  return redactor?.redact(message) ?? message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
