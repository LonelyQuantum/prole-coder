use std::{
    collections::BTreeSet,
    fs, io,
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::workspace_manifest::{
    DEFAULT_WORKSPACE_MANIFEST_MAX_ENTRIES, WorkspaceManifest, WorkspaceManifestConfig,
    WorkspaceManifestError, build_workspace_manifest,
};
use crate::{cancellation::CancellationToken, hashing::sha256_hex, run_log::sanitize_payload};

const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_SEARCH_MAX_RESULTS: usize = 100;
#[cfg(unix)]
const PROCESS_TREE_TERMINATION_GRACE: Duration = Duration::from_millis(100);
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

#[derive(Debug, Clone)]
pub struct WorkspaceToolExecutor {
    root: PathBuf,
}

impl WorkspaceToolExecutor {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, ToolExecutionError> {
        let root = fs::canonicalize(root.as_ref()).map_err(|source| ToolExecutionError::Io {
            path: root.as_ref().to_path_buf(),
            source,
        })?;

        if !root.is_dir() {
            return Err(ToolExecutionError::WorkspaceRootNotDirectory { path: root });
        }

        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn workspace_manifest(
        &self,
        args: WorkspaceManifestArgs,
    ) -> Result<WorkspaceManifestResult, ToolExecutionError> {
        self.workspace_manifest_with_cancellation(args, &CancellationToken::new())
    }

    pub fn workspace_manifest_with_cancellation(
        &self,
        args: WorkspaceManifestArgs,
        cancellation_token: &CancellationToken,
    ) -> Result<WorkspaceManifestResult, ToolExecutionError> {
        check_canceled(cancellation_token, "workspace_manifest")?;
        let max_entries = args
            .max_entries
            .unwrap_or(DEFAULT_WORKSPACE_MANIFEST_MAX_ENTRIES);
        let config = WorkspaceManifestConfig::new(max_entries)
            .with_respect_gitignore(args.respect_gitignore.unwrap_or(true));
        let manifest =
            build_workspace_manifest(&self.root, args.root.as_deref(), config, cancellation_token)
                .map_err(|source| match source {
                    WorkspaceManifestError::Canceled { source } => {
                        ToolExecutionError::CommandCanceled {
                            program: "workspace_manifest".to_owned(),
                            reason: source.reason().to_owned(),
                        }
                    }
                    source => ToolExecutionError::WorkspaceManifest { source },
                })?;
        let summary_markdown = manifest.summary_markdown();

        Ok(WorkspaceManifestResult {
            status: ToolStatus::Ok,
            summary: format!(
                "Built workspace manifest with {} of {} files.",
                manifest.included_files, manifest.total_discovered_files
            ),
            error_code: None,
            manifest_hash: manifest.manifest_hash.clone(),
            summary_markdown,
            manifest,
        })
    }

    pub fn read_file(&self, args: ReadFileArgs) -> Result<ReadFileResult, ToolExecutionError> {
        self.read_file_with_cancellation(args, &CancellationToken::new())
    }

    pub fn read_file_with_cancellation(
        &self,
        args: ReadFileArgs,
        cancellation_token: &CancellationToken,
    ) -> Result<ReadFileResult, ToolExecutionError> {
        check_canceled(cancellation_token, "read_file")?;
        let path = self.resolve_existing_workspace_path(&args.path)?;
        if !path.is_file() {
            return Err(ToolExecutionError::PathNotFile { path });
        }

        let full_content = fs::read_to_string(&path).map_err(|source| ToolExecutionError::Io {
            path: path.clone(),
            source,
        })?;
        let size_bytes = full_content.len() as u64;
        let sha256 = sha256_hex(full_content.as_bytes());
        let line_count = count_lines(&full_content);
        let content = select_line_range(
            &full_content,
            line_count,
            args.start_line,
            args.end_line,
            &args.path,
        )?;

        Ok(ReadFileResult {
            status: ToolStatus::Ok,
            summary: format!("Read {}.", args.path),
            error_code: None,
            path: args.path,
            content,
            line_count,
            sha256,
            size_bytes,
        })
    }

    pub fn search(&self, args: SearchArgs) -> Result<SearchResult, ToolExecutionError> {
        self.search_with_cancellation(args, &CancellationToken::new())
    }

    pub fn search_with_cancellation(
        &self,
        args: SearchArgs,
        cancellation_token: &CancellationToken,
    ) -> Result<SearchResult, ToolExecutionError> {
        check_canceled(cancellation_token, "rg")?;
        if args.query.trim().is_empty() {
            return Err(ToolExecutionError::InvalidArgument(
                "search query must not be empty".to_owned(),
            ));
        }

        let max_results = args
            .max_results
            .unwrap_or(DEFAULT_SEARCH_MAX_RESULTS)
            .max(1);
        let mut command_args = vec![
            "--json".to_owned(),
            "--fixed-strings".to_owned(),
            "--line-number".to_owned(),
            "--column".to_owned(),
            "--color".to_owned(),
            "never".to_owned(),
            "--glob".to_owned(),
            "!.git/**".to_owned(),
            "--glob".to_owned(),
            "!.secrets/**".to_owned(),
            "--glob".to_owned(),
            "!.secret/**".to_owned(),
            "--glob".to_owned(),
            "!.env".to_owned(),
            "--glob".to_owned(),
            "!.env.*".to_owned(),
            "--glob".to_owned(),
            "!node_modules/**".to_owned(),
            "--glob".to_owned(),
            "!target/**".to_owned(),
        ];
        if !args.case_sensitive.unwrap_or(false) {
            command_args.push("--ignore-case".to_owned());
        }
        command_args.push(args.query);

        if args.paths.is_empty() {
            command_args.push(".".to_owned());
        } else {
            for path in &args.paths {
                let resolved = self.resolve_existing_workspace_path(path)?;
                command_args.push(self.relative_path_string(&resolved)?);
            }
        }

        let output = run_command(
            "rg",
            command_args.iter().map(String::as_str),
            &self.root,
            DEFAULT_COMMAND_TIMEOUT,
            cancellation_token,
        )?;

        if !matches!(output.exit_code, Some(0) | Some(1)) {
            return Err(ToolExecutionError::CommandFailed {
                program: "rg".to_owned(),
                exit_code: output.exit_code,
                stderr: output.stderr,
            });
        }

        let mut matches = Vec::new();
        for line in output.stdout.lines() {
            if matches.len() >= max_results {
                break;
            }

            let event: Value =
                serde_json::from_str(line).map_err(|source| ToolExecutionError::InvalidJson {
                    source,
                    body: line.to_owned(),
                })?;
            if event.get("type").and_then(Value::as_str) != Some("match") {
                continue;
            }

            let data =
                event
                    .get("data")
                    .ok_or_else(|| ToolExecutionError::MalformedToolOutput {
                        detail: "rg match event missing data".to_owned(),
                    })?;
            let path = data
                .pointer("/path/text")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolExecutionError::MalformedToolOutput {
                    detail: "rg match event missing path".to_owned(),
                })?
                .replace('\\', "/")
                .trim_start_matches("./")
                .to_owned();
            let line_number = data
                .get("line_number")
                .and_then(Value::as_u64)
                .ok_or_else(|| ToolExecutionError::MalformedToolOutput {
                    detail: "rg match event missing line_number".to_owned(),
                })?;
            let text = data
                .pointer("/lines/text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim_end_matches(['\r', '\n'])
                .to_owned();
            let column = data
                .get("submatches")
                .and_then(Value::as_array)
                .and_then(|submatches| submatches.first())
                .and_then(|submatch| submatch.get("start"))
                .and_then(Value::as_u64)
                .map(|start| start + 1)
                .unwrap_or(1);

            matches.push(SearchMatch {
                path,
                line: line_number,
                column,
                text,
            });
        }

        let truncated = matches.len() >= max_results && output.stdout.lines().count() > max_results;
        Ok(SearchResult {
            status: ToolStatus::Ok,
            summary: format!("Found {} matches.", matches.len()),
            error_code: None,
            matches,
            truncated,
            duration_ms: output.duration_ms,
        })
    }

    pub fn apply_patch(
        &self,
        args: ApplyPatchArgs,
    ) -> Result<ApplyPatchResult, ToolExecutionError> {
        self.apply_patch_with_cancellation(args, &CancellationToken::new())
    }

    pub fn apply_patch_with_cancellation(
        &self,
        args: ApplyPatchArgs,
        cancellation_token: &CancellationToken,
    ) -> Result<ApplyPatchResult, ToolExecutionError> {
        check_canceled(cancellation_token, "apply_patch")?;
        let parsed = parse_unified_diff(&args.unified_diff)?;
        if parsed.files.is_empty() {
            return Err(ToolExecutionError::InvalidPatch(
                "patch must contain at least one file".to_owned(),
            ));
        }

        let expected: BTreeSet<String> = args
            .expected_files
            .iter()
            .map(|path| normalize_workspace_relative_path(path))
            .collect::<Result<_, _>>()?;
        let actual: BTreeSet<String> = parsed
            .files
            .iter()
            .map(FilePatch::target_path)
            .collect::<Result<_, _>>()?;
        if expected != actual {
            return Err(ToolExecutionError::PatchFileMismatch {
                expected: expected.into_iter().collect(),
                actual: actual.into_iter().collect(),
            });
        }

        for path in &actual {
            self.resolve_workspace_path(path)?;
        }

        let reverse_patch = parsed.reverse_patch();
        let mut staged_files = Vec::new();
        for file_patch in parsed.files {
            let relative_path = file_patch.target_path()?;
            let path = self.resolve_workspace_path(&relative_path)?;
            let original = if file_patch.old_path.is_none() {
                String::new()
            } else {
                fs::read_to_string(&path).map_err(|source| ToolExecutionError::Io {
                    path: path.clone(),
                    source,
                })?
            };

            let applied = apply_file_patch(&original, &file_patch)?;
            let operation = if file_patch.new_path.is_none() {
                StagedPatchOperation::Delete
            } else {
                StagedPatchOperation::Write(applied)
            };
            staged_files.push((relative_path, path, operation));
        }

        check_canceled(cancellation_token, "apply_patch")?;

        let mut modified_files = Vec::new();
        for (relative_path, path, operation) in staged_files {
            match operation {
                StagedPatchOperation::Delete => {
                    if path.exists() {
                        fs::remove_file(&path).map_err(|source| ToolExecutionError::Io {
                            path: path.clone(),
                            source,
                        })?;
                    }
                }
                StagedPatchOperation::Write(applied) => {
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent).map_err(|source| ToolExecutionError::Io {
                            path: parent.to_path_buf(),
                            source,
                        })?;
                    }
                    fs::write(&path, applied).map_err(|source| ToolExecutionError::Io {
                        path: path.clone(),
                        source,
                    })?;
                }
            }

            modified_files.push(relative_path);
        }

        Ok(ApplyPatchResult {
            status: ToolStatus::Ok,
            summary: format!("Applied patch to {} files.", modified_files.len()),
            error_code: None,
            files: modified_files,
            reverse_patch,
        })
    }

    pub fn shell(&self, args: ShellArgs) -> Result<ShellResult, ToolExecutionError> {
        self.shell_with_cancellation(args, &CancellationToken::new())
    }

    pub fn shell_with_cancellation(
        &self,
        args: ShellArgs,
        cancellation_token: &CancellationToken,
    ) -> Result<ShellResult, ToolExecutionError> {
        check_canceled(cancellation_token, "shell")?;
        if args.command.trim().is_empty() {
            return Err(ToolExecutionError::InvalidArgument(
                "shell command must not be empty".to_owned(),
            ));
        }

        let cwd = match args.cwd {
            Some(cwd) => self.resolve_existing_workspace_path(&cwd)?,
            None => self.root.clone(),
        };
        if !cwd.is_dir() {
            return Err(ToolExecutionError::PathNotDirectory { path: cwd });
        }

        let timeout = args
            .timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_COMMAND_TIMEOUT);
        let output = run_shell_command(&args.command, &cwd, timeout, cancellation_token)?;
        let status = if output.exit_code == Some(0) {
            ToolStatus::Ok
        } else {
            ToolStatus::Failed
        };

        Ok(ShellResult {
            status,
            summary: match status {
                ToolStatus::Ok => "Command completed.".to_owned(),
                ToolStatus::Failed => "Command failed.".to_owned(),
            },
            error_code: (status == ToolStatus::Failed).then(|| "E_COMMAND_FAILED".to_owned()),
            exit_code: output.exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
            duration_ms: output.duration_ms,
        })
    }

    pub fn git_status(&self, args: GitStatusArgs) -> Result<GitStatusResult, ToolExecutionError> {
        self.git_status_with_cancellation(args, &CancellationToken::new())
    }

    pub fn git_status_with_cancellation(
        &self,
        args: GitStatusArgs,
        cancellation_token: &CancellationToken,
    ) -> Result<GitStatusResult, ToolExecutionError> {
        check_canceled(cancellation_token, "git status")?;
        let output = if args.porcelain.unwrap_or(true) {
            run_command(
                "git",
                ["status", "--short", "--branch"],
                &self.root,
                DEFAULT_COMMAND_TIMEOUT,
                cancellation_token,
            )?
        } else {
            run_command(
                "git",
                ["status"],
                &self.root,
                DEFAULT_COMMAND_TIMEOUT,
                cancellation_token,
            )?
        };
        if output.exit_code != Some(0) {
            return Err(ToolExecutionError::CommandFailed {
                program: "git status".to_owned(),
                exit_code: output.exit_code,
                stderr: output.stderr,
            });
        }

        let mut lines = output.stdout.lines();
        let branch = lines
            .next()
            .filter(|line| line.starts_with("## "))
            .map(|line| line.trim_start_matches("## ").to_owned());
        let entries = if branch.is_some() {
            lines.map(str::to_owned).collect()
        } else {
            output.stdout.lines().map(str::to_owned).collect()
        };

        Ok(GitStatusResult {
            status: ToolStatus::Ok,
            summary: "Read git status.".to_owned(),
            error_code: None,
            branch,
            entries,
        })
    }

    pub fn git_diff(&self, args: GitDiffArgs) -> Result<GitDiffResult, ToolExecutionError> {
        self.git_diff_with_cancellation(args, &CancellationToken::new())
    }

    pub fn git_diff_with_cancellation(
        &self,
        args: GitDiffArgs,
        cancellation_token: &CancellationToken,
    ) -> Result<GitDiffResult, ToolExecutionError> {
        check_canceled(cancellation_token, "git diff")?;
        let mut command_args = vec!["diff".to_owned(), "--no-ext-diff".to_owned()];
        if args.staged.unwrap_or(false) {
            command_args.push("--cached".to_owned());
        }
        command_args.push("--".to_owned());
        for path in &args.paths {
            let resolved = self.resolve_existing_workspace_path(path)?;
            command_args.push(self.relative_path_string(&resolved)?);
        }

        let output = run_command(
            "git",
            command_args.iter().map(String::as_str),
            &self.root,
            DEFAULT_COMMAND_TIMEOUT,
            cancellation_token,
        )?;
        if output.exit_code != Some(0) {
            return Err(ToolExecutionError::CommandFailed {
                program: "git diff".to_owned(),
                exit_code: output.exit_code,
                stderr: output.stderr,
            });
        }

        let files = diff_file_paths(&output.stdout);
        Ok(GitDiffResult {
            status: ToolStatus::Ok,
            summary: format!("Read git diff for {} files.", files.len()),
            error_code: None,
            unified_diff: output.stdout,
            files,
        })
    }

    fn resolve_workspace_path(&self, relative: &str) -> Result<PathBuf, ToolExecutionError> {
        let normalized = normalize_workspace_relative_path(relative)?;
        reject_sensitive_path(&normalized)?;
        let path = self.root.join(Path::new(&normalized));
        let parent = path.parent().unwrap_or(&self.root);
        let canonical_parent =
            fs::canonicalize(parent).map_err(|source| ToolExecutionError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        if !canonical_parent.starts_with(&self.root) {
            return Err(ToolExecutionError::PathOutsideWorkspace {
                path: relative.to_owned(),
            });
        }

        Ok(path)
    }

    fn resolve_existing_workspace_path(
        &self,
        relative: &str,
    ) -> Result<PathBuf, ToolExecutionError> {
        let path = self.resolve_workspace_path(relative)?;
        let canonical = fs::canonicalize(&path).map_err(|source| ToolExecutionError::Io {
            path: path.clone(),
            source,
        })?;
        if !canonical.starts_with(&self.root) {
            return Err(ToolExecutionError::PathOutsideWorkspace {
                path: relative.to_owned(),
            });
        }

        Ok(canonical)
    }

    fn relative_path_string(&self, path: &Path) -> Result<String, ToolExecutionError> {
        let relative = path.strip_prefix(&self.root).map_err(|_| {
            ToolExecutionError::PathOutsideWorkspace {
                path: path.display().to_string(),
            }
        })?;
        Ok(path_to_slash_string(relative))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolStatus {
    Ok,
    Failed,
}

impl ToolStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceManifestArgs {
    pub root: Option<String>,
    pub respect_gitignore: Option<bool>,
    pub max_entries: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceManifestResult {
    pub status: ToolStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub manifest_hash: String,
    pub summary_markdown: String,
    pub manifest: WorkspaceManifest,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileArgs {
    pub path: String,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    pub status: ToolStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub path: String,
    pub content: String,
    pub line_count: usize,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    pub query: String,
    #[serde(default)]
    pub paths: Vec<String>,
    pub case_sensitive: Option<bool>,
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u64,
    pub column: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub status: ToolStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchArgs {
    pub unified_diff: String,
    pub expected_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchApprovalHunk {
    pub id: String,
    pub file_path: String,
    pub file_index: usize,
    pub hunk_index: usize,
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchResult {
    pub status: ToolStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub files: Vec<String>,
    pub reverse_patch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellArgs {
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub status: ToolStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusArgs {
    pub porcelain: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub status: ToolStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub branch: Option<String>,
    pub entries: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffArgs {
    pub staged: Option<bool>,
    #[serde(default)]
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub status: ToolStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub unified_diff: String,
    pub files: Vec<String>,
}

pub fn redacted_tool_result_value<T: Serialize>(result: &T) -> Result<Value, ToolExecutionError> {
    let value = serde_json::to_value(result)
        .map_err(|source| ToolExecutionError::Serialization { source })?;
    Ok(sanitize_payload(value))
}

#[derive(Debug, Error)]
pub enum ToolExecutionError {
    #[error("workspace root is not a directory: {path}")]
    WorkspaceRootNotDirectory { path: PathBuf },
    #[error("path is outside workspace: {path}")]
    PathOutsideWorkspace { path: String },
    #[error("path is blocked because it may contain local or secret data: {path}")]
    SensitivePath { path: String },
    #[error("path is not a file: {path}")]
    PathNotFile { path: PathBuf },
    #[error("path is not a directory: {path}")]
    PathNotDirectory { path: PathBuf },
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("invalid line range for `{path}`")]
    InvalidLineRange { path: String },
    #[error("invalid JSON from tool command: {source}; body: {body}")]
    InvalidJson {
        source: serde_json::Error,
        body: String,
    },
    #[error("malformed tool command output: {detail}")]
    MalformedToolOutput { detail: String },
    #[error("invalid patch: {0}")]
    InvalidPatch(String),
    #[error("patch files do not match expected files; expected {expected:?}, got {actual:?}")]
    PatchFileMismatch {
        expected: Vec<String>,
        actual: Vec<String>,
    },
    #[error("patch hunk mismatch in {path} at line {line}")]
    PatchHunkMismatch { path: String, line: usize },
    #[error("command `{program}` failed with exit code {exit_code:?}: {stderr}")]
    CommandFailed {
        program: String,
        exit_code: Option<i32>,
        stderr: String,
    },
    #[error("command `{program}` timed out after {timeout_ms}ms")]
    CommandTimedOut { program: String, timeout_ms: u128 },
    #[error("command `{program}` canceled: {reason}")]
    CommandCanceled { program: String, reason: String },
    #[error("tool result serialization failed: {source}")]
    Serialization { source: serde_json::Error },
    #[error("I/O error at {path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("I/O error while running `{program}`: {source}")]
    CommandIo { program: String, source: io::Error },
    #[error("workspace manifest failed: {source}")]
    WorkspaceManifest {
        #[from]
        source: WorkspaceManifestError,
    },
}

#[derive(Debug, Clone)]
struct CommandOutput {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u128,
}

fn run_shell_command(
    command: &str,
    cwd: &Path,
    timeout: Duration,
    cancellation_token: &CancellationToken,
) -> Result<CommandOutput, ToolExecutionError> {
    #[cfg(windows)]
    {
        run_command(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-Command", command],
            cwd,
            timeout,
            cancellation_token,
        )
    }

    #[cfg(not(windows))]
    {
        run_command("sh", ["-c", command], cwd, timeout, cancellation_token)
    }
}

fn run_command<'a>(
    program: &str,
    args: impl IntoIterator<Item = &'a str>,
    cwd: &Path,
    timeout: Duration,
    cancellation_token: &CancellationToken,
) -> Result<CommandOutput, ToolExecutionError> {
    check_canceled(cancellation_token, program)?;
    let start = Instant::now();
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_tree_root(&mut command);

    let mut child = command
        .spawn()
        .map_err(|source| ToolExecutionError::CommandIo {
            program: program.to_owned(),
            source,
        })?;

    loop {
        if cancellation_token.is_canceled() {
            terminate_child_process_tree(&mut child);
            return Err(ToolExecutionError::CommandCanceled {
                program: program.to_owned(),
                reason: cancellation_token.cancellation_reason(),
            });
        }

        if child
            .try_wait()
            .map_err(|source| ToolExecutionError::CommandIo {
                program: program.to_owned(),
                source,
            })?
            .is_some()
        {
            let output =
                child
                    .wait_with_output()
                    .map_err(|source| ToolExecutionError::CommandIo {
                        program: program.to_owned(),
                        source,
                    })?;
            return Ok(CommandOutput {
                exit_code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                duration_ms: start.elapsed().as_millis(),
            });
        }

        if start.elapsed() >= timeout {
            terminate_child_process_tree(&mut child);
            return Err(ToolExecutionError::CommandTimedOut {
                program: program.to_owned(),
                timeout_ms: timeout.as_millis(),
            });
        }

        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn configure_process_tree_root(command: &mut Command) {
    command.process_group(0);
}

#[cfg(windows)]
fn configure_process_tree_root(command: &mut Command) {
    command.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
fn configure_process_tree_root(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_child_process_tree(child: &mut Child) {
    let group_id = child.id().to_string();
    send_unix_process_group_signal("TERM", &group_id);
    wait_for_child_exit(child, PROCESS_TREE_TERMINATION_GRACE);
    if child.try_wait().ok().flatten().is_none() {
        send_unix_process_group_signal("KILL", &group_id);
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(unix)]
fn send_unix_process_group_signal(signal: &str, group_id: &str) {
    let process_group = format!("-{group_id}");
    let _ = Command::new("kill")
        .arg(format!("-{signal}"))
        .arg("--")
        .arg(process_group)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(windows)]
fn terminate_child_process_tree(child: &mut Child) {
    let pid = child.id();
    stop_windows_process_tree(pid);
    let pid = pid.to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn stop_windows_process_tree(root_pid: u32) {
    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$RootProcessId = {root_pid}
$Processes = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$Pending = New-Object System.Collections.Generic.Queue[int]
$Targets = New-Object System.Collections.Generic.List[int]
$Pending.Enqueue($RootProcessId)
while ($Pending.Count -gt 0) {{
    $ParentProcessId = $Pending.Dequeue()
    foreach ($Process in $Processes) {{
        if ($Process.ParentProcessId -eq $ParentProcessId) {{
            $ProcessId = [int]$Process.ProcessId
            [void]$Targets.Add($ProcessId)
            $Pending.Enqueue($ProcessId)
        }}
    }}
}}
for ($Index = $Targets.Count - 1; $Index -ge 0; $Index--) {{
    Stop-Process -Id $Targets[$Index] -Force -ErrorAction SilentlyContinue
}}
Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
"#
    );

    let _ = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script.as_str(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(any(unix, windows)))]
fn terminate_child_process_tree(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn wait_for_child_exit(child: &mut Child, timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn check_canceled(
    cancellation_token: &CancellationToken,
    program: &str,
) -> Result<(), ToolExecutionError> {
    if cancellation_token.is_canceled() {
        return Err(ToolExecutionError::CommandCanceled {
            program: program.to_owned(),
            reason: cancellation_token.cancellation_reason(),
        });
    }

    Ok(())
}

fn normalize_workspace_relative_path(path: &str) -> Result<String, ToolExecutionError> {
    if path.trim().is_empty() {
        return Err(ToolExecutionError::InvalidArgument(
            "path must not be empty".to_owned(),
        ));
    }

    let path = Path::new(path);
    if path.is_absolute() {
        return Err(ToolExecutionError::PathOutsideWorkspace {
            path: path.display().to_string(),
        });
    }

    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_owned()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ToolExecutionError::PathOutsideWorkspace {
                    path: path.display().to_string(),
                });
            }
        }
    }

    if parts.is_empty() {
        return Ok(".".to_owned());
    }

    let normalized = parts.iter().collect::<PathBuf>();
    Ok(path_to_slash_string(&normalized))
}

fn reject_sensitive_path(path: &str) -> Result<(), ToolExecutionError> {
    let path = Path::new(path);
    for component in path.components() {
        let Component::Normal(part) = component else {
            continue;
        };
        let part = part.to_string_lossy();
        if matches!(
            part.as_ref(),
            ".git" | ".secrets" | ".secret" | ".agents" | ".codex"
        ) || part == ".env"
            || part.starts_with(".env.")
        {
            return Err(ToolExecutionError::SensitivePath {
                path: path_to_slash_string(path),
            });
        }
    }

    Ok(())
}

fn path_to_slash_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn count_lines(content: &str) -> usize {
    if content.is_empty() {
        0
    } else {
        content.lines().count()
    }
}

fn select_line_range(
    content: &str,
    line_count: usize,
    start_line: Option<usize>,
    end_line: Option<usize>,
    path: &str,
) -> Result<String, ToolExecutionError> {
    let Some(start_line) = start_line else {
        return Ok(content.to_owned());
    };
    let end_line = end_line.unwrap_or(start_line);
    if start_line == 0 || end_line < start_line || end_line > line_count {
        return Err(ToolExecutionError::InvalidLineRange {
            path: path.to_owned(),
        });
    }

    let selected = content
        .split_inclusive('\n')
        .skip(start_line - 1)
        .take(end_line - start_line + 1)
        .collect::<String>();
    Ok(selected)
}

#[derive(Debug, Clone)]
struct ParsedPatch {
    files: Vec<FilePatch>,
}

impl ParsedPatch {
    fn to_unified_diff(&self) -> String {
        let mut output = String::new();
        for file in &self.files {
            output.push_str(&format!(
                "--- {}\n+++ {}\n",
                file.format_old_path(),
                file.format_new_path()
            ));
            for hunk in &file.hunks {
                output.push_str(&format!(
                    "@@ -{}{} +{}{} @@{}\n",
                    hunk.old_start,
                    format_count(hunk.old_count),
                    hunk.new_start,
                    format_count(hunk.new_count),
                    hunk.section
                ));
                for line in &hunk.lines {
                    match line {
                        PatchLine::Context(text) => {
                            output.push(' ');
                            output.push_str(text);
                            output.push('\n');
                        }
                        PatchLine::Remove(text) => {
                            output.push('-');
                            output.push_str(text);
                            output.push('\n');
                        }
                        PatchLine::Add(text) => {
                            output.push('+');
                            output.push_str(text);
                            output.push('\n');
                        }
                    }
                }
            }
        }
        output
    }

    fn approval_hunks(&self) -> Result<Vec<PatchApprovalHunk>, ToolExecutionError> {
        let mut hunks = Vec::new();
        for (file_index, file) in self.files.iter().enumerate() {
            let file_path = file.target_path()?;
            for (hunk_index, hunk) in file.hunks.iter().enumerate() {
                hunks.push(PatchApprovalHunk {
                    id: patch_hunk_id(&file_path, hunk_index, hunk),
                    file_path: file_path.clone(),
                    file_index,
                    hunk_index,
                    old_start: hunk.old_start,
                    old_count: hunk.old_count,
                    new_start: hunk.new_start,
                    new_count: hunk.new_count,
                    section: if hunk.section.trim().is_empty() {
                        None
                    } else {
                        Some(hunk.section.trim().to_owned())
                    },
                });
            }
        }
        Ok(hunks)
    }

    fn reverse_patch(&self) -> String {
        let mut output = String::new();
        for file in &self.files {
            output.push_str(&format!(
                "--- {}\n+++ {}\n",
                file.format_new_path(),
                file.format_old_path()
            ));
            for hunk in &file.hunks {
                output.push_str(&format!(
                    "@@ -{}{} +{}{} @@{}\n",
                    hunk.new_start,
                    format_count(hunk.new_count),
                    hunk.old_start,
                    format_count(hunk.old_count),
                    hunk.section
                ));
                for line in &hunk.lines {
                    match line {
                        PatchLine::Context(text) => {
                            output.push(' ');
                            output.push_str(text);
                            output.push('\n');
                        }
                        PatchLine::Remove(text) => {
                            output.push('+');
                            output.push_str(text);
                            output.push('\n');
                        }
                        PatchLine::Add(text) => {
                            output.push('-');
                            output.push_str(text);
                            output.push('\n');
                        }
                    }
                }
            }
        }
        output
    }
}

#[derive(Debug, Clone)]
struct FilePatch {
    old_path: Option<String>,
    new_path: Option<String>,
    hunks: Vec<PatchHunk>,
}

impl FilePatch {
    fn target_path(&self) -> Result<String, ToolExecutionError> {
        self.new_path
            .as_ref()
            .or(self.old_path.as_ref())
            .cloned()
            .ok_or_else(|| ToolExecutionError::InvalidPatch("file patch has no path".to_owned()))
    }

    fn format_old_path(&self) -> String {
        self.old_path
            .as_ref()
            .map(|path| format!("a/{path}"))
            .unwrap_or_else(|| "/dev/null".to_owned())
    }

    fn format_new_path(&self) -> String {
        self.new_path
            .as_ref()
            .map(|path| format!("b/{path}"))
            .unwrap_or_else(|| "/dev/null".to_owned())
    }
}

#[derive(Debug, Clone)]
struct PatchHunk {
    old_start: usize,
    old_count: usize,
    new_start: usize,
    new_count: usize,
    section: String,
    lines: Vec<PatchLine>,
}

#[derive(Debug, Clone)]
enum PatchLine {
    Context(String),
    Remove(String),
    Add(String),
}

enum StagedPatchOperation {
    Write(String),
    Delete,
}

fn parse_unified_diff(diff: &str) -> Result<ParsedPatch, ToolExecutionError> {
    let lines: Vec<&str> = diff.lines().collect();
    let mut index = 0;
    let mut files = Vec::new();

    while index < lines.len() {
        let line = lines[index];
        if line.starts_with("diff --git ") || line.starts_with("index ") {
            index += 1;
            continue;
        }
        if !line.starts_with("--- ") {
            return Err(ToolExecutionError::InvalidPatch(format!(
                "expected file header, got `{line}`"
            )));
        }

        let old_path = parse_patch_path(line.trim_start_matches("--- "))?;
        index += 1;
        if index >= lines.len() || !lines[index].starts_with("+++ ") {
            return Err(ToolExecutionError::InvalidPatch(
                "expected new file header".to_owned(),
            ));
        }
        let new_path = parse_patch_path(lines[index].trim_start_matches("+++ "))?;
        index += 1;

        let mut hunks = Vec::new();
        while index < lines.len() {
            let line = lines[index];
            if line.starts_with("--- ") || line.starts_with("diff --git ") {
                break;
            }
            if !line.starts_with("@@ ") {
                return Err(ToolExecutionError::InvalidPatch(format!(
                    "expected hunk header, got `{line}`"
                )));
            }

            let (old_start, old_count, new_start, new_count, section) = parse_hunk_header(line)?;
            index += 1;
            let mut hunk_lines = Vec::new();
            while index < lines.len() {
                let line = lines[index];
                if line.starts_with("@@ ")
                    || line.starts_with("--- ")
                    || line.starts_with("diff --git ")
                {
                    break;
                }
                if line == r"\ No newline at end of file" {
                    index += 1;
                    continue;
                }

                let patch_line = if let Some(text) = line.strip_prefix(' ') {
                    PatchLine::Context(text.to_owned())
                } else if let Some(text) = line.strip_prefix('-') {
                    PatchLine::Remove(text.to_owned())
                } else if let Some(text) = line.strip_prefix('+') {
                    PatchLine::Add(text.to_owned())
                } else {
                    return Err(ToolExecutionError::InvalidPatch(format!(
                        "invalid patch line `{line}`"
                    )));
                };
                hunk_lines.push(patch_line);
                index += 1;
            }

            hunks.push(PatchHunk {
                old_start,
                old_count,
                new_start,
                new_count,
                section,
                lines: hunk_lines,
            });
        }

        files.push(FilePatch {
            old_path,
            new_path,
            hunks,
        });
    }

    Ok(ParsedPatch { files })
}

pub fn patch_approval_hunks(diff: &str) -> Result<Vec<PatchApprovalHunk>, ToolExecutionError> {
    let parsed = parse_unified_diff(diff)?;
    parsed.approval_hunks()
}

pub fn filter_apply_patch_hunks(
    args: ApplyPatchArgs,
    approved_hunk_ids: &[String],
) -> Result<ApplyPatchArgs, ToolExecutionError> {
    if approved_hunk_ids.is_empty() {
        return Err(ToolExecutionError::InvalidPatch(
            "hunk approval must include at least one hunk id".to_owned(),
        ));
    }

    let approved: BTreeSet<&str> = approved_hunk_ids.iter().map(String::as_str).collect();
    let parsed = parse_unified_diff(&args.unified_diff)?;
    let mut seen = BTreeSet::new();
    let mut selected_files = Vec::new();
    let mut expected_files = BTreeSet::new();

    for file in parsed.files {
        let mut selected_hunks = Vec::new();
        let hunk_count = file.hunks.len();
        let file_path = file.target_path()?;
        let mut all_delta: isize = 0;
        let mut selected_delta: isize = 0;
        for (hunk_index, hunk) in file.hunks.into_iter().enumerate() {
            let id = patch_hunk_id(&file_path, hunk_index, &hunk);
            if approved.contains(id.as_str()) {
                seen.insert(id);
                let omitted_delta = all_delta - selected_delta;
                let mut selected_hunk = hunk.clone();
                selected_hunk.new_start =
                    adjusted_hunk_start(selected_hunk.new_start, omitted_delta)?;
                selected_delta += hunk.new_count as isize - hunk.old_count as isize;
                selected_hunks.push(selected_hunk);
            }
            all_delta += hunk.new_count as isize - hunk.old_count as isize;
        }

        if selected_hunks.is_empty() {
            continue;
        }

        if selected_hunks.len() != hunk_count
            && (file.old_path.is_none() || file.new_path.is_none())
        {
            return Err(ToolExecutionError::InvalidPatch(format!(
                "hunk approval for file creation or deletion must include every hunk in `{file_path}`"
            )));
        }

        expected_files.insert(file_path);
        selected_files.push(FilePatch {
            old_path: file.old_path,
            new_path: file.new_path,
            hunks: selected_hunks,
        });
    }

    let missing: Vec<String> = approved
        .into_iter()
        .filter(|id| !seen.contains(*id))
        .map(str::to_owned)
        .collect();
    if !missing.is_empty() {
        return Err(ToolExecutionError::InvalidPatch(format!(
            "approved hunk id(s) were not present in the patch: {}",
            missing.join(", ")
        )));
    }

    if selected_files.is_empty() {
        return Err(ToolExecutionError::InvalidPatch(
            "hunk approval did not select any patch hunks".to_owned(),
        ));
    }

    let filtered = ParsedPatch {
        files: selected_files,
    };
    Ok(ApplyPatchArgs {
        unified_diff: filtered.to_unified_diff(),
        expected_files: expected_files.into_iter().collect(),
    })
}

fn parse_patch_path(path: &str) -> Result<Option<String>, ToolExecutionError> {
    let path = path.split('\t').next().unwrap_or(path);
    if path == "/dev/null" {
        return Ok(None);
    }

    let path = path
        .strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path);
    Ok(Some(normalize_workspace_relative_path(path)?))
}

fn parse_hunk_header(
    line: &str,
) -> Result<(usize, usize, usize, usize, String), ToolExecutionError> {
    let rest = line
        .strip_prefix("@@ -")
        .ok_or_else(|| ToolExecutionError::InvalidPatch("invalid hunk header".to_owned()))?;
    let (old_part, rest) = rest
        .split_once(" +")
        .ok_or_else(|| ToolExecutionError::InvalidPatch("invalid old hunk range".to_owned()))?;
    let (new_part, section) = rest
        .split_once(" @@")
        .ok_or_else(|| ToolExecutionError::InvalidPatch("invalid new hunk range".to_owned()))?;

    let (old_start, old_count) = parse_hunk_range(old_part)?;
    let (new_start, new_count) = parse_hunk_range(new_part)?;
    Ok((
        old_start,
        old_count,
        new_start,
        new_count,
        section.to_owned(),
    ))
}

fn parse_hunk_range(range: &str) -> Result<(usize, usize), ToolExecutionError> {
    if let Some((start, count)) = range.split_once(',') {
        Ok((
            start.parse().map_err(|_| {
                ToolExecutionError::InvalidPatch(format!("invalid hunk start `{start}`"))
            })?,
            count.parse().map_err(|_| {
                ToolExecutionError::InvalidPatch(format!("invalid hunk count `{count}`"))
            })?,
        ))
    } else {
        Ok((
            range.parse().map_err(|_| {
                ToolExecutionError::InvalidPatch(format!("invalid hunk start `{range}`"))
            })?,
            1,
        ))
    }
}

fn format_count(count: usize) -> String {
    if count == 1 {
        String::new()
    } else {
        format!(",{count}")
    }
}

fn patch_hunk_id(file_path: &str, hunk_index: usize, hunk: &PatchHunk) -> String {
    format!(
        "{}#{}:old{}+{}:new{}+{}",
        file_path,
        hunk_index + 1,
        hunk.old_start,
        hunk.old_count,
        hunk.new_start,
        hunk.new_count
    )
}

fn adjusted_hunk_start(start: usize, omitted_delta: isize) -> Result<usize, ToolExecutionError> {
    let adjusted = start as isize - omitted_delta;
    if adjusted < 0 {
        return Err(ToolExecutionError::InvalidPatch(
            "selected patch hunk line numbers underflow after filtering".to_owned(),
        ));
    }
    Ok(adjusted as usize)
}

fn apply_file_patch(original: &str, patch: &FilePatch) -> Result<String, ToolExecutionError> {
    let original_had_trailing_newline = original.ends_with('\n');
    let original_lines: Vec<&str> = original.lines().collect();
    let mut output = Vec::new();
    let mut cursor = 0;

    for hunk in &patch.hunks {
        let hunk_start = hunk.old_start.saturating_sub(1);
        while cursor < hunk_start {
            let line = original_lines.get(cursor).ok_or_else(|| {
                ToolExecutionError::PatchHunkMismatch {
                    path: patch.target_path().unwrap_or_default(),
                    line: cursor + 1,
                }
            })?;
            output.push((*line).to_owned());
            cursor += 1;
        }

        for line in &hunk.lines {
            match line {
                PatchLine::Context(expected) => {
                    let actual = original_lines.get(cursor).ok_or_else(|| {
                        ToolExecutionError::PatchHunkMismatch {
                            path: patch.target_path().unwrap_or_default(),
                            line: cursor + 1,
                        }
                    })?;
                    if actual != expected {
                        return Err(ToolExecutionError::PatchHunkMismatch {
                            path: patch.target_path().unwrap_or_default(),
                            line: cursor + 1,
                        });
                    }
                    output.push(expected.clone());
                    cursor += 1;
                }
                PatchLine::Remove(expected) => {
                    let actual = original_lines.get(cursor).ok_or_else(|| {
                        ToolExecutionError::PatchHunkMismatch {
                            path: patch.target_path().unwrap_or_default(),
                            line: cursor + 1,
                        }
                    })?;
                    if actual != expected {
                        return Err(ToolExecutionError::PatchHunkMismatch {
                            path: patch.target_path().unwrap_or_default(),
                            line: cursor + 1,
                        });
                    }
                    cursor += 1;
                }
                PatchLine::Add(added) => output.push(added.clone()),
            }
        }
    }

    while cursor < original_lines.len() {
        output.push(original_lines[cursor].to_owned());
        cursor += 1;
    }

    let mut content = output.join("\n");
    if original_had_trailing_newline || !content.is_empty() {
        content.push('\n');
    }
    Ok(content)
}

fn diff_file_paths(diff: &str) -> Vec<String> {
    let mut files = BTreeSet::new();
    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("+++ b/") {
            let path = path.split('\t').next().unwrap_or(path);
            files.insert(path.to_owned());
        }
    }
    files.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::{
        ApplyPatchArgs, GitDiffArgs, GitStatusArgs, ReadFileArgs, SearchArgs, ShellArgs,
        ShellResult, ToolExecutionError, ToolStatus, WorkspaceManifestArgs, WorkspaceToolExecutor,
        redacted_tool_result_value,
    };
    use crate::cancellation::CancellationToken;
    use crate::hashing::sha256_hex;
    use crate::run_log::{REDACTED_VALUE, RUN_LOG_MAX_STRING_BYTES};
    use crate::test_helpers::TestWorkspace;

    #[test]
    fn sha256_hex_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn read_file_reads_full_file_and_line_range() {
        let workspace = TestWorkspace::new("tool-execution");
        let full_content = "fn main() {}\nprintln!(\"hi\");\n";
        let expected_sha256 = sha256_hex(full_content.as_bytes());
        workspace.write("src/main.rs", full_content);
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");

        let full = tools
            .read_file(ReadFileArgs {
                path: "src/main.rs".to_owned(),
                start_line: None,
                end_line: None,
            })
            .expect("file should read");
        assert_eq!(full.line_count, 2);
        assert_eq!(full.content, full_content);
        assert_eq!(full.size_bytes, full_content.len() as u64);
        assert_eq!(full.sha256, expected_sha256);

        let serialized = serde_json::to_value(&full).expect("read result should serialize");
        assert_eq!(serialized["sizeBytes"], full_content.len() as u64);
        assert_eq!(serialized["sha256"], expected_sha256);

        let line = tools
            .read_file(ReadFileArgs {
                path: "src/main.rs".to_owned(),
                start_line: Some(2),
                end_line: Some(2),
            })
            .expect("line range should read");
        assert_eq!(line.content, "println!(\"hi\");\n");
        assert_eq!(line.size_bytes, full.size_bytes);
        assert_eq!(line.sha256, full.sha256);
    }

    #[test]
    fn workspace_manifest_builds_result_and_excludes_sensitive_paths() {
        let workspace = TestWorkspace::new("tool-execution");
        workspace.write("src/lib.rs", "pub fn answer() -> i32 { 42 }\n");
        workspace.write(".secrets/token.txt", "secret\n");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");

        let result = tools
            .workspace_manifest(WorkspaceManifestArgs {
                root: None,
                respect_gitignore: Some(true),
                max_entries: Some(10),
            })
            .expect("manifest should build");

        assert_eq!(result.status, ToolStatus::Ok);
        assert_eq!(result.manifest_hash, result.manifest.manifest_hash);
        assert!(result.summary_markdown.contains(&result.manifest_hash));
        assert!(
            result
                .manifest
                .entries
                .iter()
                .any(|entry| entry.path == "src/lib.rs")
        );
        assert!(
            !result
                .manifest
                .entries
                .iter()
                .any(|entry| entry.path.starts_with(".secrets/"))
        );
    }

    #[test]
    fn read_file_rejects_secret_paths_and_parent_traversal() {
        let workspace = TestWorkspace::new("tool-execution");
        workspace.write(".secrets/deepseek-api-key", "secret");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");

        assert!(matches!(
            tools.read_file(ReadFileArgs {
                path: ".secrets/deepseek-api-key".to_owned(),
                start_line: None,
                end_line: None,
            }),
            Err(ToolExecutionError::SensitivePath { .. })
        ));
        assert!(matches!(
            tools.read_file(ReadFileArgs {
                path: "../outside".to_owned(),
                start_line: None,
                end_line: None,
            }),
            Err(ToolExecutionError::PathOutsideWorkspace { .. })
        ));
    }

    #[test]
    fn search_finds_text_and_excludes_secret_paths() {
        let workspace = TestWorkspace::new("tool-execution");
        workspace.write("README.md", "hello visible\n");
        workspace.write(".secrets/token.txt", "hello hidden\n");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");

        let result = tools
            .search(SearchArgs {
                query: "hello".to_owned(),
                paths: Vec::new(),
                case_sensitive: Some(true),
                max_results: Some(10),
            })
            .expect("search should run");

        assert_eq!(result.status, ToolStatus::Ok);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "README.md");
    }

    #[test]
    fn apply_patch_modifies_expected_files_and_returns_reverse_patch() {
        let workspace = TestWorkspace::new("tool-execution");
        workspace.write("README.md", "old\n");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");

        let result = tools
            .apply_patch(ApplyPatchArgs {
                unified_diff: concat!(
                    "--- a/README.md\n",
                    "+++ b/README.md\n",
                    "@@ -1 +1 @@\n",
                    "-old\n",
                    "+new\n",
                )
                .to_owned(),
                expected_files: vec!["README.md".to_owned()],
            })
            .expect("patch should apply");

        assert_eq!(result.files, vec!["README.md"]);
        assert_eq!(workspace.read("README.md"), "new\n");
        assert!(result.reverse_patch.contains("-new"));
        assert!(result.reverse_patch.contains("+old"));
    }

    #[test]
    fn filter_apply_patch_hunks_keeps_only_selected_hunks() {
        let args = ApplyPatchArgs {
            unified_diff: concat!(
                "--- a/README.md\n",
                "+++ b/README.md\n",
                "@@ -1,3 +1,4 @@\n",
                " one\n",
                "+intro\n",
                "-old\n",
                "+new\n",
                " three\n",
                "@@ -5,2 +6,3 @@\n",
                " keep\n",
                "+insert\n",
                " remove\n",
            )
            .to_owned(),
            expected_files: vec!["README.md".to_owned()],
        };

        let hunks = super::patch_approval_hunks(&args.unified_diff)
            .expect("patch should expose approval hunks");
        let filtered = super::filter_apply_patch_hunks(args, &[hunks[1].id.clone()])
            .expect("selected hunk should filter patch");

        assert_eq!(
            filtered.unified_diff,
            concat!(
                "--- a/README.md\n",
                "+++ b/README.md\n",
                "@@ -5,2 +5,3 @@\n",
                " keep\n",
                "+insert\n",
                " remove\n",
            )
        );
        assert_eq!(filtered.expected_files, vec!["README.md"]);
    }

    #[test]
    fn apply_patch_rejects_unexpected_files() {
        let workspace = TestWorkspace::new("tool-execution");
        workspace.write("README.md", "old\n");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");

        let error = tools
            .apply_patch(ApplyPatchArgs {
                unified_diff: concat!(
                    "--- a/README.md\n",
                    "+++ b/README.md\n",
                    "@@ -1 +1 @@\n",
                    "-old\n",
                    "+new\n",
                )
                .to_owned(),
                expected_files: vec!["src/lib.rs".to_owned()],
            })
            .expect_err("file mismatch should fail");

        assert!(matches!(
            error,
            ToolExecutionError::PatchFileMismatch { .. }
        ));
    }

    #[test]
    fn apply_patch_rejects_empty_hunk_lines_without_panicking() {
        let workspace = TestWorkspace::new("tool-execution");
        workspace.write("README.md", "old\n");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");

        let error = tools
            .apply_patch(ApplyPatchArgs {
                unified_diff: concat!(
                    "--- a/README.md\n",
                    "+++ b/README.md\n",
                    "@@ -1 +1 @@\n",
                    "\n",
                )
                .to_owned(),
                expected_files: vec!["README.md".to_owned()],
            })
            .expect_err("malformed hunk line should fail");

        assert!(matches!(error, ToolExecutionError::InvalidPatch(_)));
    }

    #[test]
    fn apply_patch_rejects_partial_multi_file_failure_without_modifying_files() {
        let workspace = TestWorkspace::new("tool-execution");
        workspace.write("README.md", "old\n");
        workspace.write("CHANGELOG.md", "current\n");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");

        let error = tools
            .apply_patch(ApplyPatchArgs {
                unified_diff: concat!(
                    "--- a/README.md\n",
                    "+++ b/README.md\n",
                    "@@ -1 +1 @@\n",
                    "-old\n",
                    "+new\n",
                    "--- a/CHANGELOG.md\n",
                    "+++ b/CHANGELOG.md\n",
                    "@@ -1 +1 @@\n",
                    "-missing\n",
                    "+updated\n",
                )
                .to_owned(),
                expected_files: vec!["README.md".to_owned(), "CHANGELOG.md".to_owned()],
            })
            .expect_err("second file hunk mismatch should fail");

        assert!(matches!(
            error,
            ToolExecutionError::PatchHunkMismatch { .. }
        ));
        assert_eq!(workspace.read("README.md"), "old\n");
        assert_eq!(workspace.read("CHANGELOG.md"), "current\n");
    }

    #[test]
    fn shell_runs_non_interactive_command() {
        let workspace = TestWorkspace::new("tool-execution");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");

        #[cfg(windows)]
        let command = "Write-Output hello";
        #[cfg(not(windows))]
        let command = "printf hello";

        let result = tools
            .shell(ShellArgs {
                command: command.to_owned(),
                cwd: None,
                timeout_ms: Some(10_000),
            })
            .expect("shell should run");

        assert_eq!(result.status, ToolStatus::Ok);
        assert!(result.stdout.contains("hello"));
    }

    #[test]
    fn shell_cancels_running_command() {
        let workspace = TestWorkspace::new("tool-execution");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");
        let cancellation_token = CancellationToken::new();
        let cancel_from_thread = cancellation_token.clone();
        let cancel_thread = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            cancel_from_thread.cancel("stop command");
        });

        #[cfg(windows)]
        let command = "Start-Sleep -Seconds 5; Write-Output done";
        #[cfg(not(windows))]
        let command = "sleep 5; printf done";

        let error = tools
            .shell_with_cancellation(
                ShellArgs {
                    command: command.to_owned(),
                    cwd: None,
                    timeout_ms: Some(10_000),
                },
                &cancellation_token,
            )
            .expect_err("shell should be canceled");
        cancel_thread.join().expect("cancel thread should join");

        assert!(matches!(
            error,
            ToolExecutionError::CommandCanceled { ref reason, .. } if reason == "stop command"
        ));
    }

    #[test]
    fn shell_cancels_descendant_processes() {
        let workspace = TestWorkspace::new("tool-execution");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");
        let cancellation_token = CancellationToken::new();
        let cancel_from_thread = cancellation_token.clone();
        let cancel_thread = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            cancel_from_thread.cancel("stop process tree");
        });

        #[cfg(windows)]
        let command = r#"cmd /C "ping -n 4 127.0.0.1 > nul && echo alive>tree-marker.txt""#;
        #[cfg(not(windows))]
        let command = "(sleep 3; printf alive > tree-marker.txt) & wait";

        let error = tools
            .shell_with_cancellation(
                ShellArgs {
                    command: command.to_owned(),
                    cwd: None,
                    timeout_ms: Some(10_000),
                },
                &cancellation_token,
            )
            .expect_err("shell process tree should be canceled");
        cancel_thread.join().expect("cancel thread should join");

        assert!(matches!(
            error,
            ToolExecutionError::CommandCanceled { ref reason, .. }
                if reason == "stop process tree"
        ));

        std::thread::sleep(std::time::Duration::from_millis(4_000));
        assert!(
            !workspace.path().join("tree-marker.txt").exists(),
            "descendant process survived cancellation and wrote the marker"
        );
    }

    #[test]
    fn shell_timeout_cleans_descendant_processes() {
        let workspace = TestWorkspace::new("tool-execution");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");
        let cancellation_token = CancellationToken::new();

        #[cfg(windows)]
        let command = r#"cmd /C "ping -n 4 127.0.0.1 > nul && echo alive>tree-marker.txt""#;
        #[cfg(not(windows))]
        let command = "(sleep 3; printf alive > tree-marker.txt) & wait";

        let error = tools
            .shell_with_cancellation(
                ShellArgs {
                    command: command.to_owned(),
                    cwd: None,
                    timeout_ms: Some(100),
                },
                &cancellation_token,
            )
            .expect_err("shell process tree should time out");

        assert!(matches!(
            error,
            ToolExecutionError::CommandTimedOut {
                timeout_ms: 100,
                ..
            }
        ));

        std::thread::sleep(std::time::Duration::from_millis(4_000));
        assert!(
            !workspace.path().join("tree-marker.txt").exists(),
            "descendant process survived timeout cleanup and wrote the marker"
        );
    }

    #[test]
    fn redacted_tool_result_value_redacts_shell_output_for_logs() {
        let secret = format!("sk-{}", "not-a-real-tool-output-secret-123");
        let result = ShellResult {
            status: ToolStatus::Ok,
            summary: "Command completed.".to_owned(),
            error_code: None,
            exit_code: Some(0),
            stdout: format!("stdout contains {secret}"),
            stderr: format!("stderr contains {secret}"),
            duration_ms: 1,
        };

        let value =
            redacted_tool_result_value(&result).expect("tool result should serialize and redact");

        assert_eq!(value["stdout"], format!("stdout contains {REDACTED_VALUE}"));
        assert_eq!(value["stderr"], format!("stderr contains {REDACTED_VALUE}"));
        assert!(!value.to_string().contains(&secret));
    }

    #[test]
    fn redacted_tool_result_value_truncates_large_shell_output_for_logs() {
        let result = ShellResult {
            status: ToolStatus::Ok,
            summary: "Command completed.".to_owned(),
            error_code: None,
            exit_code: Some(0),
            stdout: "x".repeat(RUN_LOG_MAX_STRING_BYTES + 1),
            stderr: String::new(),
            duration_ms: 1,
        };

        let value =
            redacted_tool_result_value(&result).expect("tool result should serialize and sanitize");

        assert_eq!(
            value["stdout"]
                .as_str()
                .expect("stdout should be string")
                .len(),
            RUN_LOG_MAX_STRING_BYTES
        );
        assert_eq!(value["runLogTruncation"][0]["reason"], "max_string_bytes");
    }

    #[test]
    fn git_status_and_diff_read_repository_state() {
        let workspace = TestWorkspace::new("tool-execution");
        workspace.git_init();
        workspace.write("README.md", "hello\n");
        let tools = WorkspaceToolExecutor::new(workspace.path()).expect("workspace should open");

        let status = tools
            .git_status(GitStatusArgs {
                porcelain: Some(true),
            })
            .expect("status should run");
        assert!(
            status
                .entries
                .iter()
                .any(|entry| entry.contains("README.md"))
        );

        workspace.git_add("README.md");
        let diff = tools
            .git_diff(GitDiffArgs {
                staged: Some(true),
                paths: vec!["README.md".to_owned()],
            })
            .expect("diff should run");
        assert!(diff.unified_diff.contains("+hello"));
        assert_eq!(diff.files, vec!["README.md"]);
    }
}
