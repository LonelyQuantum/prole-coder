use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::DEFAULT_STATE_DIR;

const RUNS_DIR: &str = "runs";
const EVENTS_FILE: &str = "events.jsonl";
const SUMMARY_FILE: &str = "summary.json";

pub const REDACTED_VALUE: &str = "<redacted>";
pub const RUN_LOG_MAX_STRING_BYTES: usize = 16 * 1024;
pub const RUN_LOG_MAX_ARRAY_ITEMS: usize = 256;
const RUN_LOG_TRUNCATION_FIELD: &str = "runLogTruncation";

#[derive(Debug, Clone)]
pub struct RunLogStore {
    workspace_root: PathBuf,
    state_dir: PathBuf,
    runs_dir: PathBuf,
}

impl RunLogStore {
    pub fn new(workspace_root: impl AsRef<Path>) -> Result<Self, RunLogError> {
        Self::with_state_dir(workspace_root, DEFAULT_STATE_DIR)
    }

    pub fn with_state_dir(
        workspace_root: impl AsRef<Path>,
        state_dir: impl AsRef<Path>,
    ) -> Result<Self, RunLogError> {
        let workspace_root =
            fs::canonicalize(workspace_root.as_ref()).map_err(|source| RunLogError::Io {
                path: workspace_root.as_ref().to_path_buf(),
                source,
            })?;
        if !workspace_root.is_dir() {
            return Err(RunLogError::WorkspaceRootNotDirectory {
                path: workspace_root,
            });
        }

        let state_dir = normalize_workspace_relative_path(state_dir.as_ref())?;
        let state_dir = workspace_root.join(state_dir);
        let runs_dir = state_dir.join(RUNS_DIR);

        Ok(Self {
            workspace_root,
            state_dir,
            runs_dir,
        })
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn runs_dir(&self) -> &Path {
        &self.runs_dir
    }

    pub fn create_run(&self, run_id: impl Into<String>) -> Result<RunLog, RunLogError> {
        let run_id = validate_id("run id", run_id.into())?;
        let run_dir = self.run_dir(&run_id)?;
        if run_dir.exists() {
            return Err(RunLogError::RunAlreadyExists { run_id });
        }

        fs::create_dir_all(&run_dir).map_err(|source| RunLogError::Io {
            path: run_dir.clone(),
            source,
        })?;
        let events_path = run_dir.join(EVENTS_FILE);
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&events_path)
            .map_err(|source| RunLogError::Io {
                path: events_path.clone(),
                source,
            })?;
        let summary_path = run_dir.join(SUMMARY_FILE);
        write_summary(
            &summary_path,
            &RunSummary::new(run_id.clone(), unix_time_millis()?),
        )?;

        Ok(RunLog::new(run_id, events_path, summary_path, 1))
    }

    pub fn open_run(&self, run_id: impl Into<String>) -> Result<RunLog, RunLogError> {
        let run_id = validate_id("run id", run_id.into())?;
        let events_path = self.events_path(&run_id)?;
        if !events_path.is_file() {
            return Err(RunLogError::RunNotFound { run_id });
        }

        let next_seq = next_sequence_from_events(&run_id, &events_path)?;
        Ok(RunLog::new(
            run_id.clone(),
            events_path,
            self.summary_path(&run_id)?,
            next_seq,
        ))
    }

    pub fn open_or_create_run(&self, run_id: impl Into<String>) -> Result<RunLog, RunLogError> {
        let run_id = validate_id("run id", run_id.into())?;
        let events_path = self.events_path(&run_id)?;
        if events_path.is_file() {
            return self.open_run(run_id);
        }

        self.create_run(run_id)
    }

    pub fn load_run(&self, run_id: impl Into<String>) -> Result<Vec<RunLogEvent>, RunLogError> {
        let run_id = validate_id("run id", run_id.into())?;
        let events_path = self.events_path(&run_id)?;
        if !events_path.is_file() {
            return Err(RunLogError::RunNotFound { run_id });
        }

        read_events(&run_id, &events_path)
    }

    pub fn events_path(&self, run_id: &str) -> Result<PathBuf, RunLogError> {
        let run_id = validate_id("run id", run_id.to_owned())?;
        Ok(self.run_dir(&run_id)?.join(EVENTS_FILE))
    }

    pub fn summary_path(&self, run_id: &str) -> Result<PathBuf, RunLogError> {
        let run_id = validate_id("run id", run_id.to_owned())?;
        Ok(self.run_dir(&run_id)?.join(SUMMARY_FILE))
    }

    pub fn load_run_summary(&self, run_id: impl Into<String>) -> Result<RunSummary, RunLogError> {
        let run_id = validate_id("run id", run_id.into())?;
        read_summary(&run_id, &self.summary_path(&run_id)?)
    }

    pub fn delete_run(&self, run_id: impl Into<String>) -> Result<(), RunLogError> {
        let run_id = validate_id("run id", run_id.into())?;
        let run_dir = self.run_dir(&run_id)?;
        if !run_dir.is_dir() {
            return Err(RunLogError::RunNotFound { run_id });
        }

        fs::remove_dir_all(&run_dir).map_err(|source| RunLogError::Io {
            path: run_dir,
            source,
        })
    }

    pub fn list_run_summaries(&self) -> Result<Vec<RunSummary>, RunLogError> {
        if !self.runs_dir.exists() {
            return Ok(Vec::new());
        }

        let mut summaries = Vec::new();
        for entry in fs::read_dir(&self.runs_dir).map_err(|source| RunLogError::Io {
            path: self.runs_dir.clone(),
            source,
        })? {
            let entry = entry.map_err(|source| RunLogError::Io {
                path: self.runs_dir.clone(),
                source,
            })?;
            let file_type = entry.file_type().map_err(|source| RunLogError::Io {
                path: entry.path(),
                source,
            })?;
            if !file_type.is_dir() {
                continue;
            }

            let run_id = entry.file_name().to_string_lossy().into_owned();
            let run_id = validate_id("run id", run_id)?;
            let summary_path = entry.path().join(SUMMARY_FILE);
            if !summary_path.is_file() {
                continue;
            }
            summaries.push(read_summary(&run_id, &summary_path)?);
        }

        summaries.sort_by(|left, right| {
            right
                .updated_at_unix_ms
                .cmp(&left.updated_at_unix_ms)
                .then_with(|| left.run_id.cmp(&right.run_id))
        });
        Ok(summaries)
    }

    fn run_dir(&self, run_id: &str) -> Result<PathBuf, RunLogError> {
        let run_id = validate_id("run id", run_id.to_owned())?;
        Ok(self.runs_dir.join(run_id))
    }
}

pub trait RunLogWriter {
    fn run_id(&self) -> &str;

    fn append_event(
        &mut self,
        event_type: String,
        turn_id: Option<String>,
        payload: Value,
    ) -> Result<RunLogEvent, RunLogError>;

    fn write_diagnostic_file(
        &mut self,
        relative_path: &Path,
        contents: &str,
    ) -> Result<Option<PathBuf>, RunLogError> {
        let _ = (relative_path, contents);
        Ok(None)
    }

    fn read_payload_file(&mut self, relative_path: &Path) -> Result<Option<String>, RunLogError> {
        let _ = relative_path;
        Ok(None)
    }

    fn append_payload_chunk(
        &mut self,
        relative_path: &Path,
        chunk: &str,
    ) -> Result<Option<PathBuf>, RunLogError> {
        let _ = (relative_path, chunk);
        Ok(None)
    }
}

/// `RunLog` is a single-writer append handle.
#[derive(Debug)]
pub struct RunLog {
    run_id: String,
    events_path: PathBuf,
    summary_path: PathBuf,
    next_seq: u64,
}

impl RunLog {
    fn new(run_id: String, events_path: PathBuf, summary_path: PathBuf, next_seq: u64) -> Self {
        Self {
            run_id,
            events_path,
            summary_path,
            next_seq,
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn events_path(&self) -> &Path {
        &self.events_path
    }

    pub fn summary_path(&self) -> &Path {
        &self.summary_path
    }

    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    pub fn append(
        &mut self,
        event_type: impl Into<String>,
        turn_id: Option<String>,
        payload: Value,
    ) -> Result<RunLogEvent, RunLogError> {
        self.append_at(unix_time_millis()?, event_type, turn_id, payload)
    }

    fn append_at(
        &mut self,
        time_unix_ms: u64,
        event_type: impl Into<String>,
        turn_id: Option<String>,
        payload: Value,
    ) -> Result<RunLogEvent, RunLogError> {
        let event_type = validate_event_type(event_type.into())?;
        let turn_id = turn_id.map(|id| validate_id("turn id", id)).transpose()?;
        let event = RunLogEvent {
            seq: self.next_seq,
            time_unix_ms,
            event_type,
            run_id: self.run_id.clone(),
            turn_id,
            payload: sanitize_payload(payload),
        };

        append_event(&self.events_path, &event)?;
        self.next_seq = self
            .next_seq
            .checked_add(1)
            .ok_or(RunLogError::SequenceOverflow)?;
        update_summary(&self.run_id, &self.summary_path, &event)?;
        Ok(event)
    }

    pub fn load(&self) -> Result<Vec<RunLogEvent>, RunLogError> {
        read_events(&self.run_id, &self.events_path)
    }

    pub fn write_run_diagnostic_file(
        &mut self,
        relative_path: &Path,
        contents: &str,
    ) -> Result<PathBuf, RunLogError> {
        write_run_text_file(&self.events_path, relative_path, contents, true)
    }

    pub fn write_run_payload_file(
        &mut self,
        relative_path: &Path,
        contents: &str,
    ) -> Result<PathBuf, RunLogError> {
        write_run_text_file(&self.events_path, relative_path, contents, false)
    }

    pub fn append_run_payload_chunk(
        &mut self,
        relative_path: &Path,
        chunk: &str,
    ) -> Result<PathBuf, RunLogError> {
        append_run_text_file(&self.events_path, relative_path, chunk)
    }

    pub fn read_run_payload_file(&self, relative_path: &Path) -> Result<String, RunLogError> {
        read_run_text_file(&self.events_path, relative_path)
    }
}

impl RunLogWriter for RunLog {
    fn run_id(&self) -> &str {
        self.run_id()
    }

    fn append_event(
        &mut self,
        event_type: String,
        turn_id: Option<String>,
        payload: Value,
    ) -> Result<RunLogEvent, RunLogError> {
        self.append(event_type, turn_id, payload)
    }

    fn write_diagnostic_file(
        &mut self,
        relative_path: &Path,
        contents: &str,
    ) -> Result<Option<PathBuf>, RunLogError> {
        self.write_run_diagnostic_file(relative_path, contents)
            .map(Some)
    }

    fn read_payload_file(&mut self, relative_path: &Path) -> Result<Option<String>, RunLogError> {
        self.read_run_payload_file(relative_path).map(Some)
    }

    fn append_payload_chunk(
        &mut self,
        relative_path: &Path,
        chunk: &str,
    ) -> Result<Option<PathBuf>, RunLogError> {
        self.append_run_payload_chunk(relative_path, chunk)
            .map(Some)
    }
}

#[derive(Debug, Clone)]
pub struct SerializedRunLog {
    run_id: String,
    events_path: PathBuf,
    summary_path: PathBuf,
    inner: Arc<Mutex<RunLog>>,
}

impl SerializedRunLog {
    pub fn new(run_log: RunLog) -> Self {
        Self {
            run_id: run_log.run_id.clone(),
            events_path: run_log.events_path.clone(),
            summary_path: run_log.summary_path.clone(),
            inner: Arc::new(Mutex::new(run_log)),
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn events_path(&self) -> &Path {
        &self.events_path
    }

    pub fn summary_path(&self) -> &Path {
        &self.summary_path
    }

    pub fn next_seq(&self) -> Result<u64, RunLogError> {
        Ok(self.lock()?.next_seq())
    }

    pub fn append(
        &self,
        event_type: impl Into<String>,
        turn_id: Option<String>,
        payload: Value,
    ) -> Result<RunLogEvent, RunLogError> {
        self.lock()?.append(event_type, turn_id, payload)
    }

    pub fn load(&self) -> Result<Vec<RunLogEvent>, RunLogError> {
        self.lock()?.load()
    }

    pub fn write_run_diagnostic_file(
        &self,
        relative_path: &Path,
        contents: &str,
    ) -> Result<PathBuf, RunLogError> {
        self.lock()?
            .write_run_diagnostic_file(relative_path, contents)
    }

    pub fn write_run_payload_file(
        &self,
        relative_path: &Path,
        contents: &str,
    ) -> Result<PathBuf, RunLogError> {
        self.lock()?.write_run_payload_file(relative_path, contents)
    }

    pub fn append_run_payload_chunk(
        &self,
        relative_path: &Path,
        chunk: &str,
    ) -> Result<PathBuf, RunLogError> {
        self.lock()?.append_run_payload_chunk(relative_path, chunk)
    }

    pub fn read_run_payload_file(&self, relative_path: &Path) -> Result<String, RunLogError> {
        self.lock()?.read_run_payload_file(relative_path)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, RunLog>, RunLogError> {
        self.inner
            .lock()
            .map_err(|_| RunLogError::WriterLockPoisoned {
                run_id: self.run_id.clone(),
            })
    }
}

impl RunLogWriter for SerializedRunLog {
    fn run_id(&self) -> &str {
        self.run_id()
    }

    fn append_event(
        &mut self,
        event_type: String,
        turn_id: Option<String>,
        payload: Value,
    ) -> Result<RunLogEvent, RunLogError> {
        self.append(event_type, turn_id, payload)
    }

    fn write_diagnostic_file(
        &mut self,
        relative_path: &Path,
        contents: &str,
    ) -> Result<Option<PathBuf>, RunLogError> {
        SerializedRunLog::write_run_diagnostic_file(self, relative_path, contents).map(Some)
    }

    fn read_payload_file(&mut self, relative_path: &Path) -> Result<Option<String>, RunLogError> {
        SerializedRunLog::read_run_payload_file(self, relative_path).map(Some)
    }

    fn append_payload_chunk(
        &mut self,
        relative_path: &Path,
        chunk: &str,
    ) -> Result<Option<PathBuf>, RunLogError> {
        SerializedRunLog::append_run_payload_chunk(self, relative_path, chunk).map(Some)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLogEvent {
    pub seq: u64,
    pub time_unix_ms: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunSummaryStatus {
    Running,
    Completed,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub title: String,
    pub status: RunSummaryStatus,
    pub started_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<u64>,
    pub last_seq: u64,
    pub event_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_status: Option<String>,
}

impl RunSummary {
    fn new(run_id: String, created_at_unix_ms: u64) -> Self {
        Self {
            title: run_id.clone(),
            run_id,
            status: RunSummaryStatus::Running,
            started_at_unix_ms: created_at_unix_ms,
            updated_at_unix_ms: created_at_unix_ms,
            completed_at_unix_ms: None,
            last_seq: 0,
            event_count: 0,
            mode: None,
            summary: None,
            changed_files: Vec::new(),
            verification_status: None,
        }
    }

    fn apply_event(&mut self, event: &RunLogEvent, path: &Path) -> Result<(), RunLogError> {
        let expected = self
            .last_seq
            .checked_add(1)
            .ok_or(RunLogError::SequenceOverflow)?;
        if event.seq != expected {
            return Err(RunLogError::SummarySequenceMismatch {
                path: path.to_path_buf(),
                expected,
                actual: event.seq,
            });
        }

        self.last_seq = event.seq;
        self.event_count = event.seq;
        self.updated_at_unix_ms = event.time_unix_ms;

        match event.event_type.as_str() {
            "run.started" => {
                if self.event_count == 1 {
                    self.started_at_unix_ms = event.time_unix_ms;
                }
                self.updated_at_unix_ms = event.time_unix_ms;
                self.status = RunSummaryStatus::Running;
                self.completed_at_unix_ms = None;
                self.summary = None;
                self.changed_files.clear();
                self.verification_status = None;
                self.mode = string_field(&event.payload, "mode");
            }
            "turn.started" => {
                if let Some(task) = string_field(&event.payload, "userTask") {
                    self.title = task;
                }
            }
            "run.completed" => {
                self.status = RunSummaryStatus::Completed;
                self.completed_at_unix_ms = Some(event.time_unix_ms);
                self.summary = string_field(&event.payload, "summary");
                self.changed_files = string_vec_field(&event.payload, "changedFiles");
                self.verification_status = string_field(&event.payload, "verificationStatus");
            }
            "run.failed" => {
                self.status = RunSummaryStatus::Failed;
                self.completed_at_unix_ms = Some(event.time_unix_ms);
                self.summary = string_field(&event.payload, "message");
            }
            "run.canceled" => {
                self.status = RunSummaryStatus::Canceled;
                self.completed_at_unix_ms = Some(event.time_unix_ms);
                self.summary = string_field(&event.payload, "message")
                    .or_else(|| string_field(&event.payload, "reason"));
            }
            "verification.completed" => {
                self.verification_status = string_field(&event.payload, "status");
            }
            _ => {}
        }

        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum RunLogError {
    #[error("workspace root is not a directory: {path}")]
    WorkspaceRootNotDirectory { path: PathBuf },
    #[error("run already exists: {run_id}")]
    RunAlreadyExists { run_id: String },
    #[error("run log not found: {run_id}")]
    RunNotFound { run_id: String },
    #[error("run summary not found: {run_id}")]
    RunSummaryNotFound { run_id: String },
    #[error("invalid {kind}: {value}")]
    InvalidIdentifier { kind: &'static str, value: String },
    #[error("invalid event type: {value}")]
    InvalidEventType { value: String },
    #[error("path must be workspace-relative: {path}")]
    InvalidStatePath { path: PathBuf },
    #[error("run log sequence overflow")]
    SequenceOverflow,
    #[error("run log writer lock was poisoned for run: {run_id}")]
    WriterLockPoisoned { run_id: String },
    #[error("run log sequence mismatch in {path}: expected {expected}, got {actual}")]
    SequenceMismatch {
        path: PathBuf,
        expected: u64,
        actual: u64,
    },
    #[error("run summary sequence mismatch in {path}: expected {expected}, got {actual}")]
    SummarySequenceMismatch {
        path: PathBuf,
        expected: u64,
        actual: u64,
    },
    #[error("run id mismatch in {path}: expected `{expected}`, got `{actual}`")]
    RunIdMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },
    #[error("invalid run log JSON in {path} at line {line}: {source}")]
    InvalidJson {
        path: PathBuf,
        line: usize,
        source: serde_json::Error,
    },
    #[error("invalid run summary JSON in {path}: {source}")]
    InvalidSummaryJson {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("system clock is before UNIX epoch")]
    SystemClockBeforeUnixEpoch,
    #[error("system clock timestamp exceeds u64 milliseconds")]
    TimestampOverflow,
    #[error("I/O error for {path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("serialization failed for {path}: {source}")]
    Serialization {
        path: PathBuf,
        source: serde_json::Error,
    },
}

fn append_event(path: &Path, event: &RunLogEvent) -> Result<(), RunLogError> {
    let mut file = OpenOptions::new()
        .append(true)
        .create(false)
        .open(path)
        .map_err(|source| RunLogError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    serde_json::to_writer(&mut file, event).map_err(|source| RunLogError::Serialization {
        path: path.to_path_buf(),
        source,
    })?;
    file.write_all(b"\n").map_err(|source| RunLogError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    file.flush().map_err(|source| RunLogError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(())
}

fn write_run_text_file(
    events_path: &Path,
    relative_path: &Path,
    contents: &str,
    append_newline: bool,
) -> Result<PathBuf, RunLogError> {
    let relative_path = normalize_workspace_relative_path(relative_path)?;
    let run_dir = events_path
        .parent()
        .ok_or_else(|| RunLogError::InvalidStatePath {
            path: events_path.to_path_buf(),
        })?;
    let path = run_dir.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| RunLogError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .map_err(|source| RunLogError::Io {
            path: path.clone(),
            source,
        })?;
    file.write_all(contents.as_bytes())
        .map_err(|source| RunLogError::Io {
            path: path.clone(),
            source,
        })?;
    if append_newline {
        file.write_all(b"\n").map_err(|source| RunLogError::Io {
            path: path.clone(),
            source,
        })?;
    }
    file.flush().map_err(|source| RunLogError::Io {
        path: path.clone(),
        source,
    })?;
    Ok(path)
}

fn read_run_text_file(events_path: &Path, relative_path: &Path) -> Result<String, RunLogError> {
    let relative_path = normalize_workspace_relative_path(relative_path)?;
    let run_dir = events_path
        .parent()
        .ok_or_else(|| RunLogError::InvalidStatePath {
            path: events_path.to_path_buf(),
        })?;
    let path = run_dir.join(relative_path);
    fs::read_to_string(&path).map_err(|source| RunLogError::Io { path, source })
}

fn append_run_text_file(
    events_path: &Path,
    relative_path: &Path,
    chunk: &str,
) -> Result<PathBuf, RunLogError> {
    let relative_path = normalize_workspace_relative_path(relative_path)?;
    let run_dir = events_path
        .parent()
        .ok_or_else(|| RunLogError::InvalidStatePath {
            path: events_path.to_path_buf(),
        })?;
    let path = run_dir.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| RunLogError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|source| RunLogError::Io {
            path: path.clone(),
            source,
        })?;
    file.write_all(chunk.as_bytes())
        .map_err(|source| RunLogError::Io {
            path: path.clone(),
            source,
        })?;
    file.flush().map_err(|source| RunLogError::Io {
        path: path.clone(),
        source,
    })?;
    Ok(path)
}

fn write_summary(path: &Path, summary: &RunSummary) -> Result<(), RunLogError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|source| RunLogError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    serde_json::to_writer_pretty(&mut file, summary).map_err(|source| {
        RunLogError::Serialization {
            path: path.to_path_buf(),
            source,
        }
    })?;
    file.write_all(b"\n").map_err(|source| RunLogError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    file.flush().map_err(|source| RunLogError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(())
}

fn read_summary(run_id: &str, path: &Path) -> Result<RunSummary, RunLogError> {
    if !path.is_file() {
        return Err(RunLogError::RunSummaryNotFound {
            run_id: run_id.to_owned(),
        });
    }

    let file = File::open(path).map_err(|source| RunLogError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let summary: RunSummary =
        serde_json::from_reader(file).map_err(|source| RunLogError::InvalidSummaryJson {
            path: path.to_path_buf(),
            source,
        })?;
    if summary.run_id != run_id {
        return Err(RunLogError::RunIdMismatch {
            path: path.to_path_buf(),
            expected: run_id.to_owned(),
            actual: summary.run_id,
        });
    }

    Ok(summary)
}

fn update_summary(run_id: &str, path: &Path, event: &RunLogEvent) -> Result<(), RunLogError> {
    let mut summary = read_summary(run_id, path)?;
    summary.apply_event(event, path)?;
    write_summary(path, &summary)
}

fn next_sequence_from_events(run_id: &str, path: &Path) -> Result<u64, RunLogError> {
    let events = read_events(run_id, path)?;
    u64::try_from(events.len())
        .ok()
        .and_then(|count| count.checked_add(1))
        .ok_or(RunLogError::SequenceOverflow)
}

fn read_events(run_id: &str, path: &Path) -> Result<Vec<RunLogEvent>, RunLogError> {
    let file = File::open(path).map_err(|source| RunLogError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut events = Vec::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|source| RunLogError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if line.trim().is_empty() {
            continue;
        }

        let event: RunLogEvent =
            serde_json::from_str(&line).map_err(|source| RunLogError::InvalidJson {
                path: path.to_path_buf(),
                line: index + 1,
                source,
            })?;
        let expected = u64::try_from(events.len())
            .ok()
            .and_then(|count| count.checked_add(1))
            .ok_or(RunLogError::SequenceOverflow)?;
        if event.seq != expected {
            return Err(RunLogError::SequenceMismatch {
                path: path.to_path_buf(),
                expected,
                actual: event.seq,
            });
        }
        if event.run_id != run_id {
            return Err(RunLogError::RunIdMismatch {
                path: path.to_path_buf(),
                expected: run_id.to_owned(),
                actual: event.run_id,
            });
        }

        events.push(event);
    }

    Ok(events)
}

fn unix_time_millis() -> Result<u64, RunLogError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| RunLogError::SystemClockBeforeUnixEpoch)?;
    u64::try_from(elapsed.as_millis()).map_err(|_| RunLogError::TimestampOverflow)
}

fn validate_id(kind: &'static str, value: String) -> Result<String, RunLogError> {
    if value.is_empty()
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(RunLogError::InvalidIdentifier { kind, value });
    }

    Ok(value)
}

fn validate_event_type(value: String) -> Result<String, RunLogError> {
    if value.is_empty()
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
    {
        return Err(RunLogError::InvalidEventType { value });
    }

    Ok(value)
}

fn normalize_workspace_relative_path(path: &Path) -> Result<PathBuf, RunLogError> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(RunLogError::InvalidStatePath {
                    path: path.to_path_buf(),
                });
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err(RunLogError::InvalidStatePath {
            path: path.to_path_buf(),
        });
    }

    Ok(normalized)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_vec_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn redact_value(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(redact_object(map)),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_value).collect()),
        Value::String(text) => Value::String(redact_text(&text)),
        other => other,
    }
}

pub fn redact_text(text: &str) -> String {
    redact_secret_like_tokens(text)
}

pub fn sanitize_payload(value: Value) -> Value {
    let redacted = redact_value(value);
    let mut truncations = Vec::new();
    let mut truncated = truncate_value(redacted, "$", &mut truncations);
    if !truncations.is_empty() {
        match &mut truncated {
            Value::Object(map) => {
                map.insert(
                    RUN_LOG_TRUNCATION_FIELD.to_owned(),
                    Value::Array(
                        truncations
                            .into_iter()
                            .map(RunLogTruncation::into_value)
                            .collect(),
                    ),
                );
                truncated
            }
            other => {
                let mut map = Map::new();
                map.insert("value".to_owned(), std::mem::take(other));
                map.insert(
                    RUN_LOG_TRUNCATION_FIELD.to_owned(),
                    Value::Array(
                        truncations
                            .into_iter()
                            .map(RunLogTruncation::into_value)
                            .collect(),
                    ),
                );
                Value::Object(map)
            }
        }
    } else {
        truncated
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RunLogTruncation {
    path: String,
    reason: &'static str,
    original: usize,
    stored: usize,
}

impl RunLogTruncation {
    fn into_value(self) -> Value {
        let mut map = Map::new();
        map.insert("path".to_owned(), Value::String(self.path));
        map.insert("reason".to_owned(), Value::String(self.reason.to_owned()));
        map.insert("original".to_owned(), Value::from(self.original));
        map.insert("stored".to_owned(), Value::from(self.stored));
        Value::Object(map)
    }
}

fn truncate_value(value: Value, path: &str, truncations: &mut Vec<RunLogTruncation>) -> Value {
    match value {
        Value::Object(map) => Value::Object(truncate_object(map, path, truncations)),
        Value::Array(values) => Value::Array(truncate_array(values, path, truncations)),
        Value::String(text) => truncate_string(text, path, truncations),
        other => other,
    }
}

fn truncate_object(
    map: Map<String, Value>,
    path: &str,
    truncations: &mut Vec<RunLogTruncation>,
) -> Map<String, Value> {
    map.into_iter()
        .map(|(key, value)| {
            let child_path = format!("{path}.{key}");
            (key, truncate_value(value, &child_path, truncations))
        })
        .collect()
}

fn truncate_array(
    values: Vec<Value>,
    path: &str,
    truncations: &mut Vec<RunLogTruncation>,
) -> Vec<Value> {
    let original = values.len();
    let mut truncated = values
        .into_iter()
        .take(RUN_LOG_MAX_ARRAY_ITEMS)
        .enumerate()
        .map(|(index, value)| truncate_value(value, &format!("{path}[{index}]"), truncations))
        .collect::<Vec<_>>();

    if original > RUN_LOG_MAX_ARRAY_ITEMS {
        truncations.push(RunLogTruncation {
            path: path.to_owned(),
            reason: "max_array_items",
            original,
            stored: RUN_LOG_MAX_ARRAY_ITEMS,
        });
    }

    truncated.shrink_to_fit();
    truncated
}

fn truncate_string(text: String, path: &str, truncations: &mut Vec<RunLogTruncation>) -> Value {
    let original = text.len();
    if original <= RUN_LOG_MAX_STRING_BYTES {
        return Value::String(text);
    }

    let mut end = RUN_LOG_MAX_STRING_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let stored = end;
    truncations.push(RunLogTruncation {
        path: path.to_owned(),
        reason: "max_string_bytes",
        original,
        stored,
    });
    Value::String(text[..end].to_owned())
}

fn redact_object(map: Map<String, Value>) -> Map<String, Value> {
    map.into_iter()
        .map(|(key, value)| {
            if is_sensitive_key(&key) {
                (key, Value::String(REDACTED_VALUE.to_owned()))
            } else {
                (key, redact_value(value))
            }
        })
        .collect()
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "apikey"
            | "deepseekapikey"
            | "authorization"
            | "password"
            | "secret"
            | "secretkey"
            | "token"
            | "authtoken"
            | "accesstoken"
            | "refreshtoken"
            | "credential"
            | "credentials"
            | "privatekey"
    )
}

fn redact_secret_like_tokens(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    while let Some(relative_start) = text[index..].find("sk-") {
        let start = index + relative_start;
        output.push_str(&text[index..start]);
        let mut end = start + 3;
        for ch in text[end..].chars() {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                end += ch.len_utf8();
            } else {
                break;
            }
        }

        if end - start >= 12 {
            output.push_str(REDACTED_VALUE);
        } else {
            output.push_str(&text[start..end]);
        }
        index = end;
    }
    output.push_str(&text[index..]);
    output
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{Arc, Barrier},
        thread,
    };

    use serde_json::json;

    use super::{
        REDACTED_VALUE, RUN_LOG_MAX_ARRAY_ITEMS, RUN_LOG_MAX_STRING_BYTES, RUNS_DIR, RunLogError,
        RunLogStore, RunLogWriter, RunSummaryStatus, SerializedRunLog,
    };
    use crate::test_helpers::TestWorkspace;

    #[test]
    fn run_log_appends_and_loads_events_with_monotonic_sequences() {
        let workspace = TestWorkspace::new("run-log");
        let store = RunLogStore::new(workspace.path()).expect("store should open");
        let mut run = store.create_run("run_test").expect("run should be created");

        let started = run
            .append_at(
                10,
                "run.started",
                None,
                json!({ "mode": "edit", "workspaceRoot": "workspace" }),
            )
            .expect("event should append");
        let delta = run
            .append_at(
                20,
                "assistant.delta",
                Some("turn_1".to_owned()),
                json!({ "text": "hello" }),
            )
            .expect("event should append");

        assert_eq!(started.seq, 1);
        assert_eq!(delta.seq, 2);
        assert_eq!(run.next_seq(), 3);

        let loaded = store.load_run("run_test").expect("events should load");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].event_type, "run.started");
        assert_eq!(loaded[1].turn_id.as_deref(), Some("turn_1"));
        assert_eq!(loaded[1].payload["text"], "hello");

        let reopened = store.open_run("run_test").expect("run should reopen");
        assert_eq!(reopened.next_seq(), 3);

        let summary = store
            .load_run_summary("run_test")
            .expect("summary should load");
        assert_eq!(summary.run_id, "run_test");
        assert_eq!(summary.status, RunSummaryStatus::Running);
        assert_eq!(summary.started_at_unix_ms, 10);
        assert_eq!(summary.updated_at_unix_ms, 20);
        assert_eq!(summary.last_seq, 2);
        assert_eq!(summary.event_count, 2);
        assert_eq!(summary.mode.as_deref(), Some("edit"));
    }

    #[test]
    fn run_log_redacts_sensitive_payload_fields_and_secret_like_strings() {
        let workspace = TestWorkspace::new("run-log");
        let store = RunLogStore::new(workspace.path()).expect("store should open");
        let mut run = store
            .create_run("run_redaction")
            .expect("run should be created");
        let api_key = format!("sk-{}", "this-value-should-not-appear");
        let inline_secret = format!("visible sk-{}", "this-inline-secret-123");

        run.append_at(
            10,
            "tool.completed",
            Some("turn_1".to_owned()),
            json!({
                "apiKey": api_key,
                "authorization": "Bearer secret",
                "cacheHitTokens": 42,
                "stdout": inline_secret,
                "nested": {
                    "refresh_token": "secret-token"
                }
            }),
        )
        .expect("event should append");

        let loaded = store.load_run("run_redaction").expect("events should load");
        let payload = &loaded[0].payload;
        assert_eq!(payload["apiKey"], REDACTED_VALUE);
        assert_eq!(payload["authorization"], REDACTED_VALUE);
        assert_eq!(payload["cacheHitTokens"], 42);
        assert_eq!(payload["nested"]["refresh_token"], REDACTED_VALUE);
        assert_eq!(payload["stdout"], format!("visible {REDACTED_VALUE}"));
    }

    #[test]
    fn run_log_writes_diagnostic_files_inside_run_directory() {
        let workspace = TestWorkspace::new("run-log");
        let store = RunLogStore::new(workspace.path()).expect("store should open");
        let mut run = store
            .create_run("run_diagnostic")
            .expect("run should be created");

        let path = run
            .write_run_diagnostic_file(
                std::path::Path::new("diagnostics/invalid-tool-arguments.json"),
                "hello diagnostic",
            )
            .expect("diagnostic file should be written");

        assert!(path.starts_with(store.runs_dir().join("run_diagnostic")));
        assert_eq!(
            fs::read_to_string(path).expect("diagnostic file should be readable"),
            "hello diagnostic\n"
        );
        assert!(matches!(
            run.write_run_diagnostic_file(std::path::Path::new("../outside.txt"), "bad"),
            Err(RunLogError::InvalidStatePath { .. })
        ));

        let payload_path = run
            .write_run_payload_file(
                std::path::Path::new("payloads/apply_patch/patch.diff"),
                "diff",
            )
            .expect("payload file should be written");
        assert_eq!(
            fs::read_to_string(&payload_path).expect("payload file should be readable"),
            "diff"
        );
        assert_eq!(
            run.read_run_payload_file(std::path::Path::new("payloads/apply_patch/patch.diff"))
                .expect("payload file should load"),
            "diff"
        );
        run.append_run_payload_chunk(
            std::path::Path::new("payloads/apply_patch/chunked.diff"),
            "di",
        )
        .expect("first payload chunk should append");
        run.append_run_payload_chunk(
            std::path::Path::new("payloads/apply_patch/chunked.diff"),
            "ff",
        )
        .expect("second payload chunk should append");
        assert_eq!(
            run.read_run_payload_file(std::path::Path::new("payloads/apply_patch/chunked.diff"))
                .expect("chunked payload file should load"),
            "diff"
        );
        assert!(matches!(
            run.read_run_payload_file(std::path::Path::new("../outside.txt")),
            Err(RunLogError::InvalidStatePath { .. })
        ));
    }

    #[test]
    fn run_log_truncates_large_payloads_and_records_boundaries() {
        let workspace = TestWorkspace::new("run-log");
        let store = RunLogStore::new(workspace.path()).expect("store should open");
        let mut run = store
            .create_run("run_truncation")
            .expect("run should be created");
        let long_stdout = "a".repeat(RUN_LOG_MAX_STRING_BYTES + 32);
        let many_matches = (0..RUN_LOG_MAX_ARRAY_ITEMS + 3)
            .map(|index| json!({ "line": index }))
            .collect::<Vec<_>>();

        run.append_at(
            10,
            "tool.completed",
            Some("turn_1".to_owned()),
            json!({
                "stdout": long_stdout,
                "stderr": "",
                "matches": many_matches
            }),
        )
        .expect("event should append");

        let loaded = store
            .load_run("run_truncation")
            .expect("events should load");
        let payload = &loaded[0].payload;
        assert_eq!(
            payload["stdout"]
                .as_str()
                .expect("stdout should be string")
                .len(),
            RUN_LOG_MAX_STRING_BYTES
        );
        assert_eq!(payload["stderr"], "");
        assert_eq!(
            payload["matches"]
                .as_array()
                .expect("matches should stay an array")
                .len(),
            RUN_LOG_MAX_ARRAY_ITEMS
        );
        let truncation = payload["runLogTruncation"]
            .as_array()
            .expect("truncation metadata should be recorded");
        assert!(
            truncation.iter().any(|entry| {
                entry["path"] == "$.stdout" && entry["reason"] == "max_string_bytes"
            })
        );
        assert!(
            truncation.iter().any(|entry| {
                entry["path"] == "$.matches" && entry["reason"] == "max_array_items"
            })
        );
    }

    #[test]
    fn run_log_rejects_unsafe_run_ids_and_state_dirs() {
        let workspace = TestWorkspace::new("run-log");
        let store = RunLogStore::new(workspace.path()).expect("store should open");

        assert!(matches!(
            store.create_run("../outside"),
            Err(RunLogError::InvalidIdentifier { .. })
        ));
        assert!(matches!(
            RunLogStore::with_state_dir(workspace.path(), "../outside"),
            Err(RunLogError::InvalidStatePath { .. })
        ));
    }

    #[test]
    fn run_log_rejects_sequence_gaps() {
        let workspace = TestWorkspace::new("run-log");
        let store = RunLogStore::new(workspace.path()).expect("store should open");
        let mut run = store
            .create_run("run_corrupt")
            .expect("run should be created");
        run.append_at(10, "run.started", None, json!({}))
            .expect("event should append");

        fs::write(
            run.events_path(),
            concat!(
                r#"{"seq":1,"timeUnixMs":10,"type":"run.started","runId":"run_corrupt","payload":{}}"#,
                "\n",
                r#"{"seq":3,"timeUnixMs":20,"type":"run.completed","runId":"run_corrupt","payload":{}}"#,
                "\n"
            ),
        )
        .expect("corrupt log should be written");

        assert!(matches!(
            store.load_run("run_corrupt"),
            Err(RunLogError::SequenceMismatch { .. })
        ));
    }

    #[test]
    fn run_log_summary_tracks_terminal_status_and_metadata() {
        let workspace = TestWorkspace::new("run-log");
        let store = RunLogStore::new(workspace.path()).expect("store should open");
        let mut run = store
            .create_run("run_summary")
            .expect("run should be created");

        run.append_at(
            100,
            "run.started",
            None,
            json!({ "mode": "edit", "workspaceRoot": "workspace" }),
        )
        .expect("run started should append");
        run.append_at(
            110,
            "turn.started",
            Some("turn_1".to_owned()),
            json!({ "turnId": "turn_1", "userTask": "Fix the README" }),
        )
        .expect("turn started should append");
        run.append_at(
            200,
            "run.completed",
            Some("turn_1".to_owned()),
            json!({
                "summary": "Updated README.",
                "changedFiles": ["README.md"],
                "verificationStatus": "skipped"
            }),
        )
        .expect("run completed should append");
        run.append_at(
            240,
            "verification.completed",
            Some("turn_1".to_owned()),
            json!({
                "verificationId": "verification_1",
                "status": "passed",
                "exitCode": 0,
                "durationMs": 10
            }),
        )
        .expect("verification completed should append");

        let summary = store
            .load_run_summary("run_summary")
            .expect("summary should load");
        assert_eq!(summary.title, "Fix the README");
        assert_eq!(summary.status, RunSummaryStatus::Completed);
        assert_eq!(summary.started_at_unix_ms, 100);
        assert_eq!(summary.completed_at_unix_ms, Some(200));
        assert_eq!(summary.updated_at_unix_ms, 240);
        assert_eq!(summary.last_seq, 4);
        assert_eq!(summary.event_count, 4);
        assert_eq!(summary.mode.as_deref(), Some("edit"));
        assert_eq!(summary.summary.as_deref(), Some("Updated README."));
        assert_eq!(summary.changed_files, vec!["README.md"]);
        assert_eq!(summary.verification_status.as_deref(), Some("passed"));
    }

    #[test]
    fn run_log_summary_resets_terminal_fields_when_run_reopens_for_next_turn() {
        let workspace = TestWorkspace::new("run-log");
        let store = RunLogStore::new(workspace.path()).expect("store should open");
        let mut run = store
            .create_run("run_multi_turn_summary")
            .expect("run should be created");

        run.append_at(100, "run.started", None, json!({ "mode": "ask" }))
            .expect("first run started should append");
        run.append_at(
            110,
            "turn.started",
            Some("turn_1".to_owned()),
            json!({ "turnId": "turn_1", "userTask": "First task" }),
        )
        .expect("first turn started should append");
        run.append_at(
            120,
            "run.completed",
            Some("turn_1".to_owned()),
            json!({
                "summary": "First summary.",
                "changedFiles": ["README.md"],
                "verificationStatus": "passed"
            }),
        )
        .expect("first completion should append");
        run.append_at(200, "run.started", None, json!({ "mode": "edit" }))
            .expect("second run started should append");
        run.append_at(
            210,
            "turn.started",
            Some("turn_2".to_owned()),
            json!({ "turnId": "turn_2", "userTask": "Second task" }),
        )
        .expect("second turn started should append");

        let summary = store
            .load_run_summary("run_multi_turn_summary")
            .expect("summary should load");
        assert_eq!(summary.title, "Second task");
        assert_eq!(summary.status, RunSummaryStatus::Running);
        assert_eq!(summary.started_at_unix_ms, 100);
        assert_eq!(summary.updated_at_unix_ms, 210);
        assert_eq!(summary.completed_at_unix_ms, None);
        assert_eq!(summary.last_seq, 5);
        assert_eq!(summary.event_count, 5);
        assert_eq!(summary.mode.as_deref(), Some("edit"));
        assert_eq!(summary.summary, None);
        assert!(summary.changed_files.is_empty());
        assert_eq!(summary.verification_status, None);
    }

    #[test]
    fn run_log_lists_summaries_by_recent_update_without_scanning_events() {
        let workspace = TestWorkspace::new("run-log");
        let store = RunLogStore::new(workspace.path()).expect("store should open");
        let mut older = store
            .create_run("run_older")
            .expect("run should be created");
        let mut newer = store
            .create_run("run_newer")
            .expect("run should be created");

        older
            .append_at(100, "run.started", None, json!({ "mode": "ask" }))
            .expect("older run should append");
        newer
            .append_at(300, "run.started", None, json!({ "mode": "review" }))
            .expect("newer run should append");
        fs::create_dir_all(store.state_dir().join(RUNS_DIR).join("run_legacy"))
            .expect("legacy run directory should be created");

        let summaries = store.list_run_summaries().expect("summaries should list");

        assert_eq!(
            summaries
                .iter()
                .map(|summary| summary.run_id.as_str())
                .collect::<Vec<_>>(),
            vec!["run_newer", "run_older"]
        );
        assert_eq!(summaries[0].updated_at_unix_ms, 300);
        assert_eq!(summaries[1].updated_at_unix_ms, 100);
    }

    #[test]
    fn run_log_deletes_run_directory_safely() {
        let workspace = TestWorkspace::new("run-log");
        let store = RunLogStore::new(workspace.path()).expect("store should open");
        store
            .create_run("run_delete")
            .expect("run should be created");

        store
            .delete_run("run_delete")
            .expect("run should be deleted");

        assert!(matches!(
            store.load_run("run_delete"),
            Err(RunLogError::RunNotFound { .. })
        ));
        assert!(matches!(
            store.delete_run("../outside"),
            Err(RunLogError::InvalidIdentifier { .. })
        ));
    }

    #[test]
    fn serialized_run_log_serializes_concurrent_appenders() {
        let workspace = TestWorkspace::new("run-log");
        let store = RunLogStore::new(workspace.path()).expect("store should open");
        let writer = SerializedRunLog::new(
            store
                .create_run("run_serialized")
                .expect("run should be created"),
        );
        let barrier = Arc::new(Barrier::new(9));
        let handles = (0..8)
            .map(|index| {
                let barrier = Arc::clone(&barrier);
                let mut writer = writer.clone();
                thread::spawn(move || {
                    barrier.wait();
                    writer
                        .append_event(
                            "assistant.delta".to_owned(),
                            Some("turn_1".to_owned()),
                            json!({ "index": index }),
                        )
                        .expect("event should append")
                })
            })
            .collect::<Vec<_>>();

        barrier.wait();
        let mut appended = handles
            .into_iter()
            .map(|handle| handle.join().expect("thread should join"))
            .collect::<Vec<_>>();
        appended.sort_by_key(|event| event.seq);

        assert_eq!(
            appended.iter().map(|event| event.seq).collect::<Vec<_>>(),
            (1..=8).collect::<Vec<_>>()
        );

        let loaded = writer.load().expect("events should load");
        assert_eq!(loaded.len(), 8);
        assert_eq!(
            loaded.iter().map(|event| event.seq).collect::<Vec<_>>(),
            (1..=8).collect::<Vec<_>>()
        );

        let mut indexes = loaded
            .iter()
            .map(|event| {
                event.payload["index"]
                    .as_u64()
                    .expect("index should be numeric")
            })
            .collect::<Vec<_>>();
        indexes.sort_unstable();
        assert_eq!(indexes, (0..8).collect::<Vec<_>>());
        assert_eq!(writer.next_seq().expect("next seq should load"), 9);
        assert_eq!(
            store
                .open_run("run_serialized")
                .expect("run should reopen")
                .next_seq(),
            9
        );
    }
}
