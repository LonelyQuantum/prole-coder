import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as vscode from "vscode";

import type { GitWorkflowRepository, GitWorkflowRepositoryProvider } from "./gitWorkflow";

const execFileAsync = promisify(execFile);

interface VscodeGitExtension {
  getAPI(version: 1): VscodeGitApi;
}

interface VscodeGitApi {
  readonly repositories: readonly VscodeGitRepository[];
}

interface VscodeGitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: {
    value: string;
  };
  readonly state: {
    readonly HEAD?: {
      readonly name?: string;
      readonly upstream?: {
        readonly name?: string;
        readonly remote?: string;
      };
    };
  };
  diffIndexWithHEAD?(): Promise<string>;
}

export function createVscodeGitRepositoryProvider(): GitWorkflowRepositoryProvider {
  return {
    async repositories() {
      const extension = vscode.extensions.getExtension<VscodeGitExtension>("vscode.git");
      const gitExtension = extension?.isActive === true ? extension.exports : await extension?.activate();
      const api = gitExtension?.getAPI(1);
      return api?.repositories.map(repositoryFromVscodeGit) ?? [];
    },
  };
}

export function createVscodeMarkdownSink(): {
  showMarkdown(content: string, title: string): Promise<void>;
  copyToClipboard(content: string): Promise<void>;
} {
  return {
    async showMarkdown(content, title) {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.from({
          scheme: "untitled",
          path: "/prole-coder/" + Date.now().toString(36) + "/" + untitledMarkdownName(title),
        }),
      );
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
      });
      const inserted = await editor.edit((edit) => {
        edit.insert(new vscode.Position(0, 0), content);
      });
      if (!inserted) {
        throw new Error("Failed to open markdown preview.");
      }
      await vscode.languages.setTextDocumentLanguage(editor.document, "markdown");
      await vscode.commands.executeCommand("workbench.action.keepEditor");
    },
    async copyToClipboard(content) {
      await vscode.env.clipboard.writeText(content);
    },
  };
}

function untitledMarkdownName(title: string): string {
  const base = title
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/gu, "-")
    .replace(/\s+/gu, " ")
    .slice(0, 80)
    .trim();
  return (base.length === 0 ? "ProleCoder PR Description" : base) + ".md";
}

function repositoryFromVscodeGit(repository: VscodeGitRepository): GitWorkflowRepository {
  const rootPath = repository.rootUri.fsPath;
  return {
    label: repository.rootUri.fsPath.split(/[\\/]/u).at(-1) ?? repository.rootUri.fsPath,
    rootPath,
    branch: repository.state.HEAD?.name,
    upstream: upstreamName(repository.state.HEAD?.upstream),
    inputBox: repository.inputBox,
    async stagedDiff() {
      if (repository.diffIndexWithHEAD !== undefined) {
        const diff = await repository.diffIndexWithHEAD();
        if (diff.trim().length > 0) {
          return diff;
        }
      }
      return git(rootPath, ["diff", "--cached", "--no-ext-diff", "--"]);
    },
    async unstagedDiff() {
      return git(rootPath, ["diff", "--no-ext-diff", "--"]);
    },
    async diffStat(base) {
      return git(rootPath, ["diff", "--stat", "--no-ext-diff", base + "...HEAD", "--"]);
    },
    async branchDiff(base) {
      return git(rootPath, ["diff", "--no-ext-diff", base + "...HEAD", "--"]);
    },
    async commitSummary(base) {
      return git(rootPath, ["log", "--oneline", base + "..HEAD"]);
    },
    async refExists(ref) {
      const result = await git(rootPath, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
      return result.trim().length > 0;
    },
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

function upstreamName(upstream: { readonly name?: string; readonly remote?: string } | undefined): string | undefined {
  if (upstream === undefined) {
    return undefined;
  }
  const name = upstream.name;
  const remote = upstream.remote;
  if (name === undefined || name.length === 0) {
    return undefined;
  }
  return remote === undefined || remote.length === 0 ? name : remote + "/" + name;
}
