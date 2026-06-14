import assert from "node:assert/strict";
import test from "node:test";

import type { SendTurnParams, SendTurnResult } from "@prole-coder/protocol" with {
  "resolution-mode": "import",
};

import {
  generateCommitMessage,
  generatePrDescription,
  type GitWorkflowAgent,
  type GitWorkflowRepository,
  type GitWorkflowRepositoryProvider,
} from "../src/gitWorkflow.js";
import type { AgentEventEnvelope, DisposableLike } from "../src/rpcServer.js";

test("generateCommitMessage sends staged diff to the agent and writes the SCM input box", async () => {
  const repository = new FakeRepository({
    stagedDiff: "diff --git a/src/lib.rs b/src/lib.rs\n+new code\n",
  });
  const agent = new FakeAgent("feat: update library");
  const window = new FakeGitWindow();

  await generateCommitMessage({
    repositories: repositoryProvider(repository),
    window,
    agent,
  });

  assert.equal(repository.inputBox.value, "feat: update library");
  assert.equal(agent.sendTurns[0]?.mode, "ask");
  assert.ok(agent.sendTurns[0]?.message.includes("Conventional Commit"));
  assert.ok(agent.sendTurns[0]?.attachments?.[0]?.text?.includes("diff --git"));
  assert.equal(window.infos.at(-1), "Commit message generated in Source Control.");
});

test("generateCommitMessage asks before using unstaged changes", async () => {
  const repository = new FakeRepository({
    stagedDiff: "",
    unstagedDiff: "diff --git a/README.md b/README.md\n+docs\n",
  });
  const agent = new FakeAgent("docs: update readme");
  const window = new FakeGitWindow(["Use Unstaged"]);

  await generateCommitMessage({
    repositories: repositoryProvider(repository),
    window,
    agent,
  });

  assert.equal(repository.inputBox.value, "docs: update readme");
  assert.ok(agent.sendTurns[0]?.attachments?.[0]?.text?.includes("README.md"));
});

test("generateCommitMessage redacts generation failures", async () => {
  const repository = new FakeRepository({
    stagedDiff: "diff --git a/src/lib.rs b/src/lib.rs\n+new code\n",
  });
  const window = new FakeGitWindow();

  await generateCommitMessage({
    repositories: repositoryProvider(repository),
    window,
    agent: new FailingAgent(new Error("provider failed with fixture-secret")),
    redactor: {
      redact(message) {
        return message.replaceAll("fixture-secret", "[redacted]");
      },
    },
  });

  assert.equal(window.warnings.at(-1), "Failed to generate commit message: provider failed with [redacted]");
});

test("generateCommitMessage keeps the first terminal agent event", async () => {
  const repository = new FakeRepository({
    stagedDiff: "diff --git a/src/lib.rs b/src/lib.rs\n+new code\n",
  });
  const window = new FakeGitWindow();

  await generateCommitMessage({
    repositories: repositoryProvider(repository),
    window,
    agent: new DuplicateTerminalAgent(),
  });

  assert.equal(repository.inputBox.value, "feat: first result");
  assert.deepEqual(window.warnings, []);
});

test("generatePrDescription uses upstream branch context and opens markdown without creating a PR", async () => {
  const repository = new FakeRepository({
    branch: "feature/api-key",
    upstream: "origin/main",
    diffStat: " README.md | 2 ++",
    branchDiff: "diff --git a/README.md b/README.md\n+summary\n",
    commitSummary: "abc123 Add API key UX",
  });
  const agent = new FakeAgent("# Add API key UX\n\n## Summary\n- Adds configuration");
  const sink = new FakeMarkdownSink();

  await generatePrDescription({
    repositories: repositoryProvider(repository),
    window: new FakeGitWindow(),
    agent,
    markdownSink: sink,
  });

  assert.ok(agent.sendTurns[0]?.attachments?.[0]?.text?.includes("Base: origin/main"));
  assert.ok(agent.sendTurns[0]?.attachments?.[0]?.text?.includes("abc123 Add API key UX"));
  assert.equal(sink.markdowns[0]?.title, "ProleCoder PR Description");
  assert.ok(sink.copied.at(-1)?.includes("## Summary"));
});

test("generatePrDescription falls back to main when no upstream exists", async () => {
  const repository = new FakeRepository({
    branch: "feature/no-upstream",
    refs: new Set(["main"]),
  });
  const agent = new FakeAgent("# PR\n");
  const sink = new FakeMarkdownSink();

  await generatePrDescription({
    repositories: repositoryProvider(repository),
    window: new FakeGitWindow(),
    agent,
    markdownSink: sink,
  });

  assert.ok(agent.sendTurns[0]?.attachments?.[0]?.text?.includes("Base: main"));
});

class FakeRepository implements GitWorkflowRepository {
  readonly label = "repo";
  readonly rootPath = "C:/workspace/repo";
  readonly inputBox = { value: "" };
  readonly branch?: string | undefined;
  readonly upstream?: string | undefined;
  private readonly stagedDiffValue: string;
  private readonly unstagedDiffValue: string;
  private readonly diffStatValue: string;
  private readonly branchDiffValue: string;
  private readonly commitSummaryValue: string;
  private readonly refs: Set<string>;

  constructor(options: {
    readonly branch?: string;
    readonly upstream?: string;
    readonly stagedDiff?: string;
    readonly unstagedDiff?: string;
    readonly diffStat?: string;
    readonly branchDiff?: string;
    readonly commitSummary?: string;
    readonly refs?: Set<string>;
  } = {}) {
    this.branch = options.branch;
    this.upstream = options.upstream;
    this.stagedDiffValue = options.stagedDiff ?? "";
    this.unstagedDiffValue = options.unstagedDiff ?? "";
    this.diffStatValue = options.diffStat ?? "";
    this.branchDiffValue = options.branchDiff ?? "";
    this.commitSummaryValue = options.commitSummary ?? "";
    this.refs = options.refs ?? new Set();
  }

  async stagedDiff(): Promise<string> {
    return this.stagedDiffValue;
  }

  async unstagedDiff(): Promise<string> {
    return this.unstagedDiffValue;
  }

  async diffStat(): Promise<string> {
    return this.diffStatValue;
  }

  async branchDiff(): Promise<string> {
    return this.branchDiffValue;
  }

  async commitSummary(): Promise<string> {
    return this.commitSummaryValue;
  }

  async refExists(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

class FakeGitWindow {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];

  constructor(private readonly warningSelections: string[] = []) {}

  showInformationMessage(message: string): void {
    this.infos.push(message);
  }

  showWarningMessage(message: string): string | undefined {
    this.warnings.push(message);
    return this.warningSelections.shift();
  }
}

class FakeAgent implements GitWorkflowAgent {
  readonly sendTurns: SendTurnParams[] = [];
  private readonly handlers = new Set<(event: AgentEventEnvelope) => void>();

  constructor(private readonly responseText: string) {}

  onEvent(handler: (event: AgentEventEnvelope) => void): DisposableLike {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  async sendTurn(params: SendTurnParams): Promise<SendTurnResult> {
    this.sendTurns.push(params);
    queueMicrotask(() => {
      this.emit(agentEvent(1, "assistant.delta", { text: this.responseText }));
      this.emit(agentEvent(2, "run.completed", { summary: "done" }));
    });
    return {
      runId: "run_git_1",
      turnId: "turn_git_1",
      accepted: true,
    };
  }

  private emit(event: AgentEventEnvelope): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

class FailingAgent implements GitWorkflowAgent {
  constructor(private readonly error: Error) {}

  onEvent(): DisposableLike {
    return { dispose: () => undefined };
  }

  async sendTurn(): Promise<SendTurnResult> {
    throw this.error;
  }
}

class DuplicateTerminalAgent implements GitWorkflowAgent {
  private readonly handlers = new Set<(event: AgentEventEnvelope) => void>();

  onEvent(handler: (event: AgentEventEnvelope) => void): DisposableLike {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  async sendTurn(): Promise<SendTurnResult> {
    this.emit(agentEvent(1, "assistant.delta", { text: "feat: first result" }));
    this.emit(agentEvent(2, "run.completed", { summary: "done" }));
    this.emit(agentEvent(3, "assistant.delta", { text: "\nshould be ignored" }));
    this.emit(agentEvent(4, "run.failed", { message: "late failure" }));
    return {
      runId: "run_git_1",
      turnId: "turn_git_1",
      accepted: true,
    };
  }

  private emit(event: AgentEventEnvelope): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

class FakeMarkdownSink {
  readonly markdowns: Array<{ readonly content: string; readonly title: string }> = [];
  readonly copied: string[] = [];

  showMarkdown(content: string, title: string): void {
    this.markdowns.push({ content, title });
  }

  copyToClipboard(content: string): void {
    this.copied.push(content);
  }
}

function repositoryProvider(repository: GitWorkflowRepository): GitWorkflowRepositoryProvider {
  return {
    async repositories() {
      return [repository];
    },
  };
}

function agentEvent(seq: number, type: string, payload: unknown): AgentEventEnvelope {
  return {
    seq,
    time: "1970-01-01T00:00:00.000Z",
    type,
    runId: "run_git_1",
    turnId: "turn_git_1",
    payload,
  };
}
