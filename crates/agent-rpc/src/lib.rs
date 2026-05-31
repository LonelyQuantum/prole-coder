#![forbid(unsafe_code)]

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, mpsc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use prole_coder_agent_core::{
    AGENT_METADATA,
    approval::{ALL_RISK_LEVELS, RiskLevel},
    cancellation::CancellationToken,
    run_log::{
        RunLog, RunLogError, RunLogEvent, RunLogStore, RunSummary, RunSummaryStatus,
        SerializedRunLog,
    },
    turn_loop::{
        AgentRunMode, AgentTurnInput, AgentTurnLoop, AgentTurnLoopConfig, AgentTurnLoopError,
        ApprovalDecision, ApprovalPolicy, ApprovalPolicyError, TextRange as CoreTextRange,
        TurnApprovalRequest, TurnAttachment as CoreTurnAttachment,
        TurnAttachmentKind as CoreTurnAttachmentKind, TurnEventSink, TurnEventSinkError,
        TurnProvider,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

pub const JSON_RPC_VERSION: &str = "2.0";
pub const PROTOCOL_VERSION: &str = "0.1.0";
pub const METHOD_NAMESPACE: &str = "agent";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RpcMethod {
    pub name: &'static str,
}

impl RpcMethod {
    pub const fn new(name: &'static str) -> Self {
        Self { name }
    }

    pub fn qualified_name(self) -> String {
        format!("{METHOD_NAMESPACE}.{}", self.name)
    }
}

pub const INITIALIZE_METHOD: RpcMethod = RpcMethod::new("initialize");
pub const SEND_TURN_METHOD: RpcMethod = RpcMethod::new("sendTurn");
pub const APPROVE_METHOD: RpcMethod = RpcMethod::new("approve");
pub const REJECT_METHOD: RpcMethod = RpcMethod::new("reject");
pub const CANCEL_METHOD: RpcMethod = RpcMethod::new("cancel");
pub const RESUME_METHOD: RpcMethod = RpcMethod::new("resume");
pub const LIST_RUNS_METHOD: RpcMethod = RpcMethod::new("listRuns");
pub const FIM_PREVIEW_METHOD: RpcMethod = RpcMethod::new("previewFim");
pub const EVENT_METHOD: RpcMethod = RpcMethod::new("event");
pub const EVENT_BATCH_METHOD: RpcMethod = RpcMethod::new("eventBatch");

pub const JSON_RPC_PARSE_ERROR: i64 = -32700;
pub const JSON_RPC_INVALID_REQUEST: i64 = -32600;
pub const JSON_RPC_METHOD_NOT_FOUND: i64 = -32601;
pub const JSON_RPC_INVALID_PARAMS: i64 = -32602;
pub const JSON_RPC_INTERNAL_ERROR: i64 = -32603;

pub const RPC_UNSUPPORTED_PROTOCOL: i64 = -32001;
pub const RPC_WORKSPACE_UNTRUSTED: i64 = -32002;
pub const RPC_RUN_NOT_FOUND: i64 = -32003;
pub const RPC_RUN_ALREADY_ACTIVE: i64 = -32004;
pub const RPC_INVALID_TOOL_ARGUMENTS: i64 = -32010;
pub const RPC_APPROVAL_NOT_FOUND: i64 = -32011;
pub const RPC_APPROVAL_DENIED: i64 = -32012;
pub const RPC_CONTEXT_BUDGET_EXCEEDED: i64 = -32020;
pub const RPC_PROVIDER_ERROR: i64 = -32030;
pub const RPC_TOOL_EXECUTION_FAILED: i64 = -32040;
pub const RPC_RUN_CANCELED: i64 = -32050;
pub const RPC_INTERNAL_INVARIANT: i64 = -32060;

pub const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);
const RPC_LOOP_QUEUE_BOUND: usize = 256;
const RPC_LIVE_EVENT_QUEUE_BOUND: usize = 256;
const RPC_LIVE_EVENT_BATCH_MAX: usize = 64;
const APPROVAL_PERSISTENCE_FILE: &str = "approvals.v1.json";
const APPROVAL_PERSISTENCE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcRequest<TParams = Value> {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<TParams>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcResponse<TResult = Value> {
    pub jsonrpc: String,
    pub id: Value,
    pub result: TResult,
}

impl<TResult> JsonRpcResponse<TResult> {
    pub fn new(id: Value, result: TResult) -> Self {
        Self {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            id,
            result,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcErrorResponse {
    pub jsonrpc: String,
    pub id: Value,
    pub error: JsonRpcErrorObject,
}

impl JsonRpcErrorResponse {
    pub fn new(id: Value, error: JsonRpcErrorObject) -> Self {
        Self {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            id,
            error,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcErrorObject {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcErrorObject {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrontendKind {
    Cli,
    Tui,
    Vscode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
    pub frontend: FrontendKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInitializeParams {
    pub protocol_version: String,
    pub client: ClientInfo,
    pub workspace_root: String,
    pub workspace_trusted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelCapabilities {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub context_window_tokens: u64,
    pub max_output_tokens: u64,
    pub supports_thinking: bool,
    pub supports_tool_calls: bool,
    pub supports_tool_choice: bool,
    pub supports_fim: bool,
    pub supports_streaming: bool,
    pub reports_cache_usage: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub provider: String,
    pub default_model: String,
    pub models: Vec<ProviderModelCapabilities>,
}

impl Default for ProviderCapabilities {
    fn default() -> Self {
        Self {
            provider: "deepseek".to_owned(),
            default_model: "deepseek-v4-pro".to_owned(),
            models: vec![
                ProviderModelCapabilities {
                    id: "deepseek-v4-flash".to_owned(),
                    display_name: Some("DeepSeek V4 Flash".to_owned()),
                    context_window_tokens: 1_048_576,
                    max_output_tokens: 393_216,
                    supports_thinking: true,
                    supports_tool_calls: true,
                    supports_tool_choice: false,
                    supports_fim: true,
                    supports_streaming: true,
                    reports_cache_usage: true,
                },
                ProviderModelCapabilities {
                    id: "deepseek-v4-pro".to_owned(),
                    display_name: Some("DeepSeek V4 Pro".to_owned()),
                    context_window_tokens: 1_048_576,
                    max_output_tokens: 393_216,
                    supports_thinking: true,
                    supports_tool_calls: true,
                    supports_tool_choice: false,
                    supports_fim: true,
                    supports_streaming: true,
                    reports_cache_usage: true,
                },
            ],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub protocol_version: String,
    pub supports_run_resume: bool,
    pub supports_patch_approval: bool,
    pub supports_persistent_approvals: bool,
    pub supports_event_batching: bool,
    pub supported_risk_levels: Vec<String>,
    pub provider: ProviderCapabilities,
}

impl Default for ServerCapabilities {
    fn default() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            supports_run_resume: true,
            supports_patch_approval: true,
            supports_persistent_approvals: true,
            supports_event_batching: true,
            supported_risk_levels: ALL_RISK_LEVELS
                .iter()
                .map(|risk| risk.as_str().to_owned())
                .collect(),
            provider: ProviderCapabilities::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInitializeResult {
    pub protocol_version: String,
    pub server: ServerInfo,
    pub capabilities: ServerCapabilities,
    pub state_dir: String,
}

impl Default for AgentInitializeResult {
    fn default() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            server: ServerInfo {
                name: "prole-coder-agent-rpc".to_owned(),
                version: env!("CARGO_PKG_VERSION").to_owned(),
            },
            capabilities: ServerCapabilities::default(),
            state_dir: AGENT_METADATA.state_dir.to_owned(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RpcRunMode {
    Plan,
    Edit,
    Review,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendTurnParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub message: String,
    pub mode: RpcRunMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<TurnAttachment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAttachment {
    pub kind: TurnAttachmentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<TextRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnAttachmentKind {
    File,
    Selection,
    ExplicitContent,
    Diagnostic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendTurnResult {
    pub run_id: String,
    pub turn_id: String,
    pub accepted: bool,
}

impl From<RpcRunMode> for AgentRunMode {
    fn from(value: RpcRunMode) -> Self {
        match value {
            RpcRunMode::Plan => Self::Plan,
            RpcRunMode::Edit => Self::Edit,
            RpcRunMode::Review => Self::Review,
            RpcRunMode::Ask => Self::Ask,
        }
    }
}

fn core_turn_attachment_from_rpc(
    attachment: &TurnAttachment,
) -> Result<CoreTurnAttachment, AgentRpcHandlerError> {
    Ok(CoreTurnAttachment {
        kind: match attachment.kind {
            TurnAttachmentKind::File => CoreTurnAttachmentKind::File,
            TurnAttachmentKind::Selection => CoreTurnAttachmentKind::Selection,
            TurnAttachmentKind::ExplicitContent => CoreTurnAttachmentKind::ExplicitContent,
            TurnAttachmentKind::Diagnostic => CoreTurnAttachmentKind::Diagnostic,
        },
        path: attachment.path.clone(),
        range: attachment.range.map(|range| CoreTextRange {
            start_line: range.start_line,
            start_column: range.start_column,
            end_line: range.end_line,
            end_column: range.end_column,
        }),
        text: attachment.text.clone(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeParams {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_from_seq: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeResult {
    pub run_id: String,
    pub next_seq: u64,
    pub replay_started: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRunsParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRunsResult {
    pub runs: Vec<RpcRunSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRunSummary {
    pub run_id: String,
    pub title: String,
    pub status: RpcRunSummaryStatus,
    pub started_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RpcRunSummaryStatus {
    Running,
    Completed,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RpcApprovalPersistence {
    Never,
    Session,
    Workspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RpcApprovalState {
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RpcRunState {
    Canceled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveParams {
    pub approval_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persist: Option<RpcApprovalPersistence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunks: Option<RpcApprovedHunks>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcApprovedHunks {
    pub approved: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveResult {
    pub approval_id: String,
    pub state: RpcApprovalState,
    pub persist: RpcApprovalPersistence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunks: Option<RpcApprovedHunks>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectParams {
    pub approval_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectResult {
    pub approval_id: String,
    pub state: RpcApprovalState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    pub run_id: String,
    pub state: RpcRunState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FimPreviewParams {
    pub prefix: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FimPreviewResult {
    pub text: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentRpcHandlerOutput<TResult> {
    pub result: TResult,
    pub events: Vec<RunLogEvent>,
}

impl<TResult> AgentRpcHandlerOutput<TResult> {
    pub fn new(result: TResult) -> Self {
        Self {
            result,
            events: Vec::new(),
        }
    }

    pub fn with_events(mut self, events: Vec<RunLogEvent>) -> Self {
        self.events = events;
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentRpcHandlerError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl AgentRpcHandlerError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    fn into_error_object(self) -> JsonRpcErrorObject {
        JsonRpcErrorObject {
            code: self.code,
            message: self.message,
            data: self.data,
        }
    }
}

pub trait AgentRpcRequestHandler {
    fn attach_live_event_sender(&mut self, _sender: mpsc::SyncSender<RunLogEvent>) {}

    fn detach_live_event_sender(&mut self) {}

    fn attach_disconnect_handle(&mut self, _handle: RpcDisconnectHandle) {}

    fn detach_disconnect_handle(&mut self) {}

    fn initialize(
        &mut self,
        params: AgentInitializeParams,
    ) -> Result<AgentInitializeResult, AgentRpcHandlerError>;

    fn send_turn(
        &mut self,
        params: SendTurnParams,
    ) -> Result<AgentRpcHandlerOutput<SendTurnResult>, AgentRpcHandlerError>;

    fn approve(
        &mut self,
        params: ApproveParams,
    ) -> Result<AgentRpcHandlerOutput<ApproveResult>, AgentRpcHandlerError>;

    fn reject(
        &mut self,
        params: RejectParams,
    ) -> Result<AgentRpcHandlerOutput<RejectResult>, AgentRpcHandlerError>;

    fn cancel(
        &mut self,
        params: CancelParams,
    ) -> Result<AgentRpcHandlerOutput<CancelResult>, AgentRpcHandlerError>;

    fn resume(
        &mut self,
        params: ResumeParams,
    ) -> Result<AgentRpcHandlerOutput<ResumeResult>, AgentRpcHandlerError>;

    fn list_runs(
        &mut self,
        params: ListRunsParams,
    ) -> Result<AgentRpcHandlerOutput<ListRunsResult>, AgentRpcHandlerError>;

    fn preview_fim(
        &mut self,
        params: FimPreviewParams,
    ) -> Result<AgentRpcHandlerOutput<FimPreviewResult>, AgentRpcHandlerError>;

    fn shutdown(&mut self) -> Result<Vec<RunLogEvent>, AgentRpcHandlerError> {
        Ok(Vec::new())
    }
}

pub trait RpcTurnProviderFactory {
    type Provider: TurnProvider;

    fn create_provider(
        &mut self,
        params: &SendTurnParams,
    ) -> Result<Self::Provider, AgentRpcHandlerError>;

    fn preview_fim(
        &mut self,
        _params: &FimPreviewParams,
    ) -> Result<FimPreviewResult, AgentRpcHandlerError> {
        Err(AgentRpcHandlerError::new(
            RPC_PROVIDER_ERROR,
            "FIM preview is not supported by this RPC provider",
        ))
    }
}

impl<F, P> RpcTurnProviderFactory for F
where
    F: FnMut(&SendTurnParams) -> Result<P, AgentRpcHandlerError>,
    P: TurnProvider,
{
    type Provider = P;

    fn create_provider(
        &mut self,
        params: &SendTurnParams,
    ) -> Result<Self::Provider, AgentRpcHandlerError> {
        self(params)
    }
}

#[derive(Debug)]
pub struct AgentTurnLoopRpcHandler<F> {
    provider_factory: F,
    config: AgentTurnLoopConfig,
    workspace: Option<RpcWorkspace>,
    approval_queue: RpcApprovalQueue,
    active_run: Option<ActiveRpcRun>,
    live_event_sender: Option<mpsc::SyncSender<RunLogEvent>>,
    disconnect_handle: Option<RpcDisconnectHandle>,
}

impl<F> AgentTurnLoopRpcHandler<F> {
    pub fn new(provider_factory: F) -> Self {
        Self {
            provider_factory,
            config: AgentTurnLoopConfig::default(),
            workspace: None,
            approval_queue: RpcApprovalQueue::default(),
            active_run: None,
            live_event_sender: None,
            disconnect_handle: None,
        }
    }

    pub fn with_config(mut self, config: AgentTurnLoopConfig) -> Self {
        self.config = config;
        self
    }

    pub fn with_approval_timeout(mut self, approval_timeout: Duration) -> Self {
        self.approval_queue = RpcApprovalQueue::new(approval_timeout);
        self
    }

    pub fn workspace_root(&self) -> Option<&std::path::Path> {
        self.workspace
            .as_ref()
            .map(|workspace| workspace.store.workspace_root())
    }
}

impl<F> AgentRpcRequestHandler for AgentTurnLoopRpcHandler<F>
where
    F: RpcTurnProviderFactory,
    F::Provider: Send + 'static,
{
    fn attach_live_event_sender(&mut self, sender: mpsc::SyncSender<RunLogEvent>) {
        self.live_event_sender = Some(sender);
    }

    fn detach_live_event_sender(&mut self) {
        self.live_event_sender = None;
    }

    fn attach_disconnect_handle(&mut self, handle: RpcDisconnectHandle) {
        self.disconnect_handle = Some(handle);
    }

    fn detach_disconnect_handle(&mut self) {
        self.disconnect_handle = None;
    }

    fn initialize(
        &mut self,
        params: AgentInitializeParams,
    ) -> Result<AgentInitializeResult, AgentRpcHandlerError> {
        if !params.workspace_trusted {
            return Err(AgentRpcHandlerError::new(
                RPC_WORKSPACE_UNTRUSTED,
                "workspace is not trusted",
            ));
        }

        let store = RunLogStore::new(&params.workspace_root).map_err(map_run_log_error)?;
        self.approval_queue
            .configure_workspace_persistence(store.workspace_root())?;
        let result = AgentInitializeResult::default();
        self.workspace = Some(RpcWorkspace { store });
        Ok(result)
    }

    fn send_turn(
        &mut self,
        params: SendTurnParams,
    ) -> Result<AgentRpcHandlerOutput<SendTurnResult>, AgentRpcHandlerError> {
        self.drain_ready_active_run_events()?;
        if self.active_run.is_some() {
            return Err(AgentRpcHandlerError::new(
                RPC_RUN_ALREADY_ACTIVE,
                "another RPC Turn Loop run is already active and waiting for completion",
            ));
        }

        let workspace_root = self.workspace_root_path()?;
        let run_id = match params.run_id.clone() {
            Some(run_id) => run_id,
            None => generate_id("run")?,
        };
        let turn_id = "turn_1".to_owned();
        let provider = self.provider_factory.create_provider(&params)?;
        let run_log = self
            .workspace()?
            .store
            .create_run(run_id.clone())
            .map_err(map_run_log_error)?;
        let attachments = params
            .attachments
            .iter()
            .map(core_turn_attachment_from_rpc)
            .collect::<Result<Vec<_>, _>>()?;
        let input = AgentTurnInput::new(turn_id.clone(), params.message.clone())
            .with_mode(params.mode.into())
            .with_attachments(attachments);

        let live_events = self.live_event_sender.clone();
        let active_run = spawn_active_run(ActiveRunSpawn {
            run_id: run_id.clone(),
            workspace_root,
            provider,
            run_log,
            input,
            config: self.config,
            approval_queue: self.approval_queue.clone(),
            live_events,
        })?;
        if let Some(disconnect_handle) = &self.disconnect_handle {
            disconnect_handle.register(&active_run)?;
        }
        self.active_run = Some(active_run);
        let events = if self.live_events_enabled() {
            Vec::new()
        } else {
            self.collect_active_run_events_until_pause()?
        };

        Ok(AgentRpcHandlerOutput::new(SendTurnResult {
            run_id,
            turn_id,
            accepted: true,
        })
        .with_events(events))
    }

    fn approve(
        &mut self,
        params: ApproveParams,
    ) -> Result<AgentRpcHandlerOutput<ApproveResult>, AgentRpcHandlerError> {
        let persist = params.persist.unwrap_or(RpcApprovalPersistence::Never);
        let hunks = params.hunks.clone();
        if let Err(error) = self
            .approval_queue
            .approve(&params.approval_id, persist, params.hunks)
        {
            self.drain_ready_active_run_events()?;
            return Err(error);
        }
        let events = if self.live_events_enabled() {
            Vec::new()
        } else {
            self.collect_active_run_events_until_pause()?
        };

        Ok(AgentRpcHandlerOutput::new(ApproveResult {
            approval_id: params.approval_id,
            state: RpcApprovalState::Approved,
            persist,
            hunks,
        })
        .with_events(events))
    }

    fn reject(
        &mut self,
        params: RejectParams,
    ) -> Result<AgentRpcHandlerOutput<RejectResult>, AgentRpcHandlerError> {
        let reason = params
            .reason
            .unwrap_or_else(|| "rejected by RPC client".to_owned());
        if let Err(error) = self
            .approval_queue
            .reject(&params.approval_id, reason.clone())
        {
            self.drain_ready_active_run_events()?;
            return Err(error);
        }
        let events = if self.live_events_enabled() {
            Vec::new()
        } else {
            self.collect_active_run_events_until_pause()?
        };

        Ok(AgentRpcHandlerOutput::new(RejectResult {
            approval_id: params.approval_id,
            state: RpcApprovalState::Rejected,
            reason: Some(reason),
        })
        .with_events(events))
    }

    fn cancel(
        &mut self,
        params: CancelParams,
    ) -> Result<AgentRpcHandlerOutput<CancelResult>, AgentRpcHandlerError> {
        self.drain_ready_active_run_events()?;
        let active_run = self.active_run.as_ref().ok_or_else(|| {
            AgentRpcHandlerError::new(
                RPC_RUN_NOT_FOUND,
                format!(
                    "run `{}` is not active in the current RPC handler",
                    params.run_id
                ),
            )
        })?;
        if active_run.run_id != params.run_id {
            return Err(AgentRpcHandlerError::new(
                RPC_RUN_NOT_FOUND,
                format!(
                    "run `{}` is not active in the current RPC handler",
                    params.run_id
                ),
            ));
        }

        let reason = params
            .reason
            .unwrap_or_else(|| "canceled by RPC client".to_owned());
        active_run.cancellation_token.cancel(reason.clone());
        self.approval_queue
            .cancel_run_pending_approvals(&params.run_id, reason.clone())?;
        let events = if self.live_events_enabled() {
            Vec::new()
        } else {
            self.collect_active_run_events_until_pause()?
        };

        Ok(AgentRpcHandlerOutput::new(CancelResult {
            run_id: params.run_id,
            state: RpcRunState::Canceled,
            reason: Some(reason),
        })
        .with_events(events))
    }

    fn resume(
        &mut self,
        params: ResumeParams,
    ) -> Result<AgentRpcHandlerOutput<ResumeResult>, AgentRpcHandlerError> {
        self.drain_ready_active_run_events()?;
        let store = &self.workspace()?.store;
        let events = match self
            .active_run
            .as_ref()
            .filter(|active_run| active_run.run_id == params.run_id)
        {
            Some(active_run) => active_run.run_log.load().map_err(map_run_log_error)?,
            None => store
                .load_run(params.run_id.clone())
                .map_err(map_run_log_error)?,
        };
        let replay_from_seq = params.replay_from_seq.unwrap_or(1);
        let replay_events = events
            .iter()
            .filter(|event| event.seq >= replay_from_seq)
            .cloned()
            .collect::<Vec<_>>();
        let next_seq = u64::try_from(events.len())
            .ok()
            .and_then(|count| count.checked_add(1))
            .ok_or_else(|| {
                AgentRpcHandlerError::new(
                    RPC_INTERNAL_INVARIANT,
                    "run log sequence count overflowed",
                )
            })?;

        Ok(AgentRpcHandlerOutput::new(ResumeResult {
            run_id: params.run_id,
            next_seq,
            replay_started: !replay_events.is_empty(),
        })
        .with_events(replay_events))
    }

    fn list_runs(
        &mut self,
        params: ListRunsParams,
    ) -> Result<AgentRpcHandlerOutput<ListRunsResult>, AgentRpcHandlerError> {
        self.drain_ready_active_run_events()?;
        let mut summaries = self
            .workspace()?
            .store
            .list_run_summaries()
            .map_err(map_run_log_error)?;
        if let Some(limit) = params.limit {
            summaries.truncate(limit);
        }
        let runs = summaries
            .iter()
            .map(RpcRunSummary::try_from)
            .collect::<Result<Vec<_>, _>>()?;

        Ok(AgentRpcHandlerOutput::new(ListRunsResult { runs }))
    }

    fn preview_fim(
        &mut self,
        params: FimPreviewParams,
    ) -> Result<AgentRpcHandlerOutput<FimPreviewResult>, AgentRpcHandlerError> {
        let result = self.provider_factory.preview_fim(&params)?;
        Ok(AgentRpcHandlerOutput::new(result))
    }

    fn shutdown(&mut self) -> Result<Vec<RunLogEvent>, AgentRpcHandlerError> {
        let mut events = self.drain_ready_active_run_events()?;
        let Some(active_run) = self.active_run.as_ref() else {
            return Ok(events);
        };

        let run_id = active_run.run_id.clone();
        let reason = "RPC client disconnected".to_owned();
        active_run.cancellation_token.cancel(reason.clone());
        self.approval_queue
            .cancel_run_pending_approvals(&run_id, reason)?;
        events.extend(self.collect_active_run_events_until_pause()?);
        Ok(events)
    }
}

impl<F> AgentTurnLoopRpcHandler<F> {
    fn live_events_enabled(&self) -> bool {
        self.live_event_sender.is_some()
    }

    fn workspace(&self) -> Result<&RpcWorkspace, AgentRpcHandlerError> {
        self.workspace.as_ref().ok_or_else(|| {
            AgentRpcHandlerError::new(
                JSON_RPC_INVALID_REQUEST,
                "agent.initialize must be called before using the RPC Turn Loop handler",
            )
        })
    }

    fn workspace_root_path(&self) -> Result<PathBuf, AgentRpcHandlerError> {
        Ok(self.workspace()?.store.workspace_root().to_path_buf())
    }

    fn collect_active_run_events_until_pause(
        &mut self,
    ) -> Result<Vec<RunLogEvent>, AgentRpcHandlerError> {
        let mut events = Vec::new();
        let collect_events = !self.live_events_enabled();
        let Some(active_run) = self.active_run.as_mut() else {
            return Ok(events);
        };

        let finish_active_run = loop {
            match active_run.events.recv() {
                Ok(event) => {
                    let pauses_for_approval = is_approval_pause_event(&event);
                    let is_terminal = is_terminal_run_event(&event);
                    if collect_events {
                        events.push(event);
                    }
                    if pauses_for_approval || is_terminal {
                        break is_terminal;
                    }
                }
                Err(_) => {
                    break true;
                }
            }
        };

        if finish_active_run {
            self.finish_active_run()?;
        }

        Ok(events)
    }

    fn drain_ready_active_run_events(&mut self) -> Result<Vec<RunLogEvent>, AgentRpcHandlerError> {
        let mut events = Vec::new();
        let collect_events = !self.live_events_enabled();
        let Some(active_run) = self.active_run.as_mut() else {
            return Ok(events);
        };

        let finish_active_run = loop {
            match active_run.events.try_recv() {
                Ok(event) => {
                    let is_terminal = is_terminal_run_event(&event);
                    if collect_events {
                        events.push(event);
                    }
                    if is_terminal {
                        break true;
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break false,
                Err(mpsc::TryRecvError::Disconnected) => break true,
            }
        };

        if finish_active_run {
            self.finish_active_run()?;
        }

        Ok(events)
    }

    fn finish_active_run(&mut self) -> Result<(), AgentRpcHandlerError> {
        let Some(active_run) = self.active_run.take() else {
            return Ok(());
        };
        if let Some(disconnect_handle) = &self.disconnect_handle {
            disconnect_handle.clear_run(&active_run.run_id)?;
        }

        match active_run.join.join() {
            Ok(result) => result,
            Err(_) => Err(AgentRpcHandlerError::new(
                RPC_INTERNAL_INVARIANT,
                "RPC Turn Loop worker thread panicked",
            )),
        }
    }
}

impl TryFrom<&RunSummary> for RpcRunSummary {
    type Error = AgentRpcHandlerError;

    fn try_from(summary: &RunSummary) -> Result<Self, Self::Error> {
        Ok(Self {
            run_id: summary.run_id.clone(),
            title: summary.title.clone(),
            status: RpcRunSummaryStatus::from(&summary.status),
            started_at: format_unix_millis(summary.started_at_unix_ms).map_err(map_rpc_error)?,
            updated_at: format_unix_millis(summary.updated_at_unix_ms).map_err(map_rpc_error)?,
            completed_at: summary
                .completed_at_unix_ms
                .map(format_unix_millis)
                .transpose()
                .map_err(map_rpc_error)?,
            last_seq: summary.last_seq,
            event_count: summary.event_count,
            mode: summary.mode.clone(),
            summary: summary.summary.clone(),
            changed_files: summary.changed_files.clone(),
            verification_status: summary.verification_status.clone(),
        })
    }
}

impl From<&RunSummaryStatus> for RpcRunSummaryStatus {
    fn from(value: &RunSummaryStatus) -> Self {
        match value {
            RunSummaryStatus::Running => Self::Running,
            RunSummaryStatus::Completed => Self::Completed,
            RunSummaryStatus::Failed => Self::Failed,
            RunSummaryStatus::Canceled => Self::Canceled,
        }
    }
}

#[derive(Debug, Clone)]
struct RpcWorkspace {
    store: RunLogStore,
}

#[derive(Debug)]
struct ActiveRpcRun {
    run_id: String,
    cancellation_token: CancellationToken,
    approval_queue: RpcApprovalQueue,
    run_log: SerializedRunLog,
    events: mpsc::Receiver<RunLogEvent>,
    join: thread::JoinHandle<Result<(), AgentRpcHandlerError>>,
}

#[derive(Debug, Clone, Default)]
pub struct RpcDisconnectHandle {
    active_run: Arc<Mutex<Option<ActiveRunCancelHandle>>>,
}

#[derive(Debug, Clone)]
struct ActiveRunCancelHandle {
    run_id: String,
    cancellation_token: CancellationToken,
    approval_queue: RpcApprovalQueue,
}

impl RpcDisconnectHandle {
    fn register(&self, active_run: &ActiveRpcRun) -> Result<(), AgentRpcHandlerError> {
        let mut active = self.lock_active_run()?;
        *active = Some(ActiveRunCancelHandle {
            run_id: active_run.run_id.clone(),
            cancellation_token: active_run.cancellation_token.clone(),
            approval_queue: active_run.approval_queue.clone(),
        });
        Ok(())
    }

    fn clear_run(&self, run_id: &str) -> Result<(), AgentRpcHandlerError> {
        let mut active = self.lock_active_run()?;
        if active
            .as_ref()
            .is_some_and(|active_run| active_run.run_id == run_id)
        {
            *active = None;
        }
        Ok(())
    }

    fn cancel_active(&self, reason: String) -> Result<(), AgentRpcHandlerError> {
        let active = self.lock_active_run()?.clone();
        if let Some(active_run) = active {
            active_run.cancellation_token.cancel(reason.clone());
            active_run
                .approval_queue
                .cancel_run_pending_approvals(&active_run.run_id, reason)?;
        }
        Ok(())
    }

    fn lock_active_run(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<ActiveRunCancelHandle>>, AgentRpcHandlerError>
    {
        self.active_run.lock().map_err(|_| {
            AgentRpcHandlerError::new(
                RPC_INTERNAL_INVARIANT,
                "RPC disconnect handle lock was poisoned",
            )
        })
    }
}

#[derive(Debug, Clone)]
struct RpcApprovalQueue {
    inner: Arc<RpcApprovalQueueInner>,
}

impl Default for RpcApprovalQueue {
    fn default() -> Self {
        Self::new(DEFAULT_APPROVAL_TIMEOUT)
    }
}

#[derive(Debug)]
struct RpcApprovalQueueInner {
    approval_timeout: Duration,
    pending: Mutex<HashMap<String, PendingApproval>>,
    persistence: Mutex<RpcApprovalPersistenceState>,
    changed: Condvar,
}

#[derive(Debug, Default)]
struct RpcApprovalPersistenceState {
    session_keys: HashSet<String>,
    workspace_keys: HashSet<String>,
    workspace_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcApprovalPersistenceFile {
    version: u32,
    approvals: Vec<String>,
}

#[derive(Debug, Clone)]
struct PendingApproval {
    run_id: String,
    request: TurnApprovalRequest,
    decision: Option<ApprovalDecision>,
    expires_at: Instant,
}

impl RpcApprovalQueue {
    fn new(approval_timeout: Duration) -> Self {
        Self {
            inner: Arc::new(RpcApprovalQueueInner {
                approval_timeout,
                pending: Mutex::new(HashMap::new()),
                persistence: Mutex::new(RpcApprovalPersistenceState::default()),
                changed: Condvar::new(),
            }),
        }
    }

    fn configure_workspace_persistence(
        &self,
        workspace_root: &Path,
    ) -> Result<(), AgentRpcHandlerError> {
        let path = workspace_root
            .join(AGENT_METADATA.state_dir)
            .join(APPROVAL_PERSISTENCE_FILE);
        let workspace_keys = load_workspace_approvals(&path)?;
        let mut persistence = self.lock_persistence()?;
        persistence.session_keys.clear();
        persistence.workspace_path = Some(path);
        persistence.workspace_keys = workspace_keys;
        Ok(())
    }

    fn register(
        &self,
        run_id: String,
        request: TurnApprovalRequest,
    ) -> Result<(), AgentRpcHandlerError> {
        let mut pending = self.lock_pending()?;
        match pending.get(&request.approval_id) {
            Some(existing) if existing.request != request || existing.run_id != run_id => {
                return Err(AgentRpcHandlerError::new(
                    RPC_INTERNAL_INVARIANT,
                    format!(
                        "approval `{}` was registered with conflicting metadata",
                        request.approval_id
                    ),
                ));
            }
            Some(_) => {}
            None => {
                pending.insert(
                    request.approval_id.clone(),
                    PendingApproval {
                        run_id,
                        request,
                        decision: None,
                        expires_at: approval_expires_at(self.inner.approval_timeout),
                    },
                );
            }
        }
        self.inner.changed.notify_all();
        Ok(())
    }

    fn approve(
        &self,
        approval_id: &str,
        persist: RpcApprovalPersistence,
        hunks: Option<RpcApprovedHunks>,
    ) -> Result<(), AgentRpcHandlerError> {
        let decision = match hunks {
            Some(hunks) => ApprovalDecision::ApprovedHunks {
                hunk_ids: hunks.approved,
            },
            None => ApprovalDecision::Approved,
        };
        self.resolve(approval_id, decision, Some(persist))
    }

    fn reject(&self, approval_id: &str, reason: String) -> Result<(), AgentRpcHandlerError> {
        self.resolve(approval_id, ApprovalDecision::Rejected { reason }, None)
    }

    fn cancel_run_pending_approvals(
        &self,
        run_id: &str,
        reason: String,
    ) -> Result<(), AgentRpcHandlerError> {
        let mut pending = self.lock_pending()?;
        for entry in pending.values_mut() {
            if entry.run_id == run_id && entry.decision.is_none() {
                entry.decision = Some(ApprovalDecision::Canceled {
                    reason: reason.clone(),
                });
            }
        }

        self.inner.changed.notify_all();
        Ok(())
    }

    fn wait_for_decision(
        &self,
        request: &TurnApprovalRequest,
    ) -> Result<ApprovalDecision, AgentRpcHandlerError> {
        let mut pending = self.lock_pending()?;

        loop {
            let expires_at = match pending.get(&request.approval_id) {
                Some(entry) => {
                    if let Some(decision) = entry.decision.clone() {
                        pending.remove(&request.approval_id);
                        self.inner.changed.notify_all();
                        return Ok(decision);
                    }

                    if self.is_persistently_approved(&entry.request)? {
                        pending.remove(&request.approval_id);
                        self.inner.changed.notify_all();
                        return Ok(ApprovalDecision::Approved);
                    }

                    if Instant::now() >= entry.expires_at {
                        pending.remove(&request.approval_id);
                        self.inner.changed.notify_all();
                        return Ok(ApprovalDecision::Expired {
                            reason: approval_expired_reason(&request.approval_id),
                        });
                    }

                    entry.expires_at
                }
                None => {
                    return Err(AgentRpcHandlerError::new(
                        RPC_INTERNAL_INVARIANT,
                        format!(
                            "approval `{}` was not registered before policy wait",
                            request.approval_id
                        ),
                    ));
                }
            };

            let remaining = expires_at.saturating_duration_since(Instant::now());
            let wait_result = self
                .inner
                .changed
                .wait_timeout(pending, remaining)
                .map_err(|_| {
                    AgentRpcHandlerError::new(
                        RPC_INTERNAL_INVARIANT,
                        "approval queue lock was poisoned while waiting for a decision",
                    )
                })?;
            pending = wait_result.0;
        }
    }

    fn resolve(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
        persist: Option<RpcApprovalPersistence>,
    ) -> Result<(), AgentRpcHandlerError> {
        let request_to_persist = {
            let pending = self.lock_pending()?;
            let entry = pending.get(approval_id).ok_or_else(|| {
                AgentRpcHandlerError::new(
                    RPC_APPROVAL_NOT_FOUND,
                    format!("approval `{approval_id}` is not pending in the current RPC handler"),
                )
            })?;

            if entry.decision.is_some() {
                return Err(AgentRpcHandlerError::new(
                    RPC_APPROVAL_NOT_FOUND,
                    format!("approval `{approval_id}` has already been resolved"),
                ));
            }

            if Instant::now() >= entry.expires_at {
                return Err(AgentRpcHandlerError::new(
                    RPC_APPROVAL_NOT_FOUND,
                    format!("approval `{approval_id}` expired before it could be resolved"),
                ));
            }

            validate_approval_decision(&entry.request, &decision, persist)?;

            if matches!(
                persist,
                Some(RpcApprovalPersistence::Session | RpcApprovalPersistence::Workspace)
            ) && !approval_request_allows_persistence(&entry.request)
            {
                return Err(AgentRpcHandlerError::new(
                    RPC_APPROVAL_DENIED,
                    format!("approval `{approval_id}` does not allow persistent decisions"),
                ));
            }

            if matches!(decision, ApprovalDecision::Approved)
                && matches!(
                    persist,
                    Some(RpcApprovalPersistence::Session | RpcApprovalPersistence::Workspace)
                )
            {
                Some(entry.request.clone())
            } else {
                None
            }
        };

        let persistence_key = request_to_persist
            .as_ref()
            .map(approval_persistence_key)
            .transpose()?
            .flatten();
        if let (Some(key), Some(RpcApprovalPersistence::Workspace)) =
            (persistence_key.as_ref(), persist)
        {
            self.write_workspace_approval_key(key)?;
        }

        let mut pending = self.lock_pending()?;
        let entry = pending.get_mut(approval_id).ok_or_else(|| {
            AgentRpcHandlerError::new(
                RPC_APPROVAL_NOT_FOUND,
                format!("approval `{approval_id}` is not pending in the current RPC handler"),
            )
        })?;

        if entry.decision.is_some() {
            return Err(AgentRpcHandlerError::new(
                RPC_APPROVAL_NOT_FOUND,
                format!("approval `{approval_id}` has already been resolved"),
            ));
        }

        if Instant::now() >= entry.expires_at {
            entry.decision = Some(ApprovalDecision::Expired {
                reason: approval_expired_reason(approval_id),
            });
            self.inner.changed.notify_all();
            return Err(AgentRpcHandlerError::new(
                RPC_APPROVAL_NOT_FOUND,
                format!("approval `{approval_id}` expired before it could be resolved"),
            ));
        }

        entry.decision = Some(decision);
        self.inner.changed.notify_all();
        drop(pending);
        if let (Some(key), Some(persist)) = (persistence_key, persist) {
            self.remember_persistent_key(key, persist)?;
        }
        Ok(())
    }

    fn is_persistently_approved(
        &self,
        request: &TurnApprovalRequest,
    ) -> Result<bool, AgentRpcHandlerError> {
        let Some(key) = approval_persistence_key(request)? else {
            return Ok(false);
        };
        let persistence = self.lock_persistence()?;
        Ok(persistence.session_keys.contains(&key) || persistence.workspace_keys.contains(&key))
    }

    fn write_workspace_approval_key(&self, key: &str) -> Result<(), AgentRpcHandlerError> {
        let (path, keys) = {
            let persistence = self.lock_persistence()?;
            let mut keys = persistence.workspace_keys.clone();
            keys.insert(key.to_owned());
            let path = persistence.workspace_path.clone().ok_or_else(|| {
                AgentRpcHandlerError::new(
                    RPC_INTERNAL_INVARIANT,
                    "workspace approval persistence was not configured",
                )
            })?;
            (path, keys)
        };

        write_workspace_approvals(&path, &keys)
    }

    fn remember_persistent_key(
        &self,
        key: String,
        persist: RpcApprovalPersistence,
    ) -> Result<(), AgentRpcHandlerError> {
        match persist {
            RpcApprovalPersistence::Never => Ok(()),
            RpcApprovalPersistence::Session => {
                let mut persistence = self.lock_persistence()?;
                persistence.session_keys.insert(key);
                Ok(())
            }
            RpcApprovalPersistence::Workspace => {
                let mut persistence = self.lock_persistence()?;
                persistence.workspace_keys.insert(key);
                Ok(())
            }
        }
    }

    fn lock_pending(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, PendingApproval>>, AgentRpcHandlerError>
    {
        self.inner.pending.lock().map_err(|_| {
            AgentRpcHandlerError::new(RPC_INTERNAL_INVARIANT, "approval queue lock was poisoned")
        })
    }

    fn lock_persistence(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, RpcApprovalPersistenceState>, AgentRpcHandlerError> {
        self.inner.persistence.lock().map_err(|_| {
            AgentRpcHandlerError::new(
                RPC_INTERNAL_INVARIANT,
                "approval persistence lock was poisoned",
            )
        })
    }
}

fn approval_expires_at(timeout: Duration) -> Instant {
    let now = Instant::now();
    now.checked_add(timeout).unwrap_or(now)
}

fn approval_expired_reason(approval_id: &str) -> String {
    format!("approval `{approval_id}` expired before a decision was received")
}

fn validate_approval_decision(
    request: &TurnApprovalRequest,
    decision: &ApprovalDecision,
    persist: Option<RpcApprovalPersistence>,
) -> Result<(), AgentRpcHandlerError> {
    let ApprovalDecision::ApprovedHunks { hunk_ids } = decision else {
        return Ok(());
    };

    if matches!(
        persist,
        Some(RpcApprovalPersistence::Session | RpcApprovalPersistence::Workspace)
    ) {
        return Err(AgentRpcHandlerError::new(
            RPC_APPROVAL_DENIED,
            format!(
                "approval `{}` cannot persist a hunk-level patch decision",
                request.approval_id
            ),
        ));
    }

    if hunk_ids.is_empty() {
        return Err(AgentRpcHandlerError::new(
            RPC_APPROVAL_DENIED,
            format!(
                "approval `{}` must include at least one approved hunk",
                request.approval_id
            ),
        ));
    }

    let Some(available_hunks) = &request.hunks else {
        return Err(AgentRpcHandlerError::new(
            RPC_APPROVAL_DENIED,
            format!(
                "approval `{}` does not support hunk-level decisions",
                request.approval_id
            ),
        ));
    };

    let mut available = HashSet::new();
    for hunk in available_hunks {
        available.insert(hunk.id.as_str());
    }

    let mut seen = HashSet::new();
    for hunk_id in hunk_ids {
        if !seen.insert(hunk_id.as_str()) {
            return Err(AgentRpcHandlerError::new(
                RPC_APPROVAL_DENIED,
                format!(
                    "approval `{}` contains duplicate hunk id `{hunk_id}`",
                    request.approval_id
                ),
            ));
        }
        if !available.contains(hunk_id.as_str()) {
            return Err(AgentRpcHandlerError::new(
                RPC_APPROVAL_DENIED,
                format!(
                    "approval `{}` does not contain hunk id `{hunk_id}`",
                    request.approval_id
                ),
            ));
        }
    }

    Ok(())
}

fn approval_request_allows_persistence(request: &TurnApprovalRequest) -> bool {
    request.persistable && !matches!(request.risk, RiskLevel::Network | RiskLevel::Destructive)
}

fn approval_persistence_key(
    request: &TurnApprovalRequest,
) -> Result<Option<String>, AgentRpcHandlerError> {
    if !approval_request_allows_persistence(request) {
        return Ok(None);
    }

    let mut paths = request.paths.clone().unwrap_or_default();
    paths.sort_unstable();
    paths.dedup();
    serde_json::to_string(&json!({
        "toolName": request.tool_name.as_str(),
        "risk": request.risk.as_str(),
        "command": request.command.as_deref(),
        "cwd": request.cwd.as_deref(),
        "paths": paths,
    }))
    .map(Some)
    .map_err(|source| {
        AgentRpcHandlerError::new(
            RPC_INTERNAL_INVARIANT,
            format!("approval persistence key could not be serialized: {source}"),
        )
    })
}

fn load_workspace_approvals(path: &Path) -> Result<HashSet<String>, AgentRpcHandlerError> {
    if !path.exists() {
        return Ok(HashSet::new());
    }

    let bytes = fs::read(path).map_err(map_io_error)?;
    let file: RpcApprovalPersistenceFile = serde_json::from_slice(&bytes).map_err(|source| {
        AgentRpcHandlerError::new(
            RPC_INTERNAL_INVARIANT,
            format!("approval persistence file is malformed: {source}"),
        )
    })?;
    if file.version != APPROVAL_PERSISTENCE_VERSION {
        return Err(AgentRpcHandlerError::new(
            RPC_INTERNAL_INVARIANT,
            format!(
                "unsupported approval persistence version {}, expected {}",
                file.version, APPROVAL_PERSISTENCE_VERSION
            ),
        ));
    }

    Ok(file.approvals.into_iter().collect())
}

fn write_workspace_approvals(
    path: &Path,
    keys: &HashSet<String>,
) -> Result<(), AgentRpcHandlerError> {
    let parent = path.parent().ok_or_else(|| {
        AgentRpcHandlerError::new(
            RPC_INTERNAL_INVARIANT,
            "approval persistence path has no parent directory",
        )
    })?;
    fs::create_dir_all(parent).map_err(map_io_error)?;

    let mut approvals = keys.iter().cloned().collect::<Vec<_>>();
    approvals.sort_unstable();
    let file = RpcApprovalPersistenceFile {
        version: APPROVAL_PERSISTENCE_VERSION,
        approvals,
    };
    let bytes = serde_json::to_vec_pretty(&file).map_err(|source| {
        AgentRpcHandlerError::new(
            RPC_INTERNAL_INVARIANT,
            format!("approval persistence file could not be serialized: {source}"),
        )
    })?;
    fs::write(path, bytes).map_err(map_io_error)
}

#[derive(Debug, Clone)]
struct RpcApprovalPolicy {
    queue: RpcApprovalQueue,
}

impl ApprovalPolicy for RpcApprovalPolicy {
    fn decide(
        &mut self,
        request: &TurnApprovalRequest,
    ) -> Result<ApprovalDecision, ApprovalPolicyError> {
        self.queue
            .wait_for_decision(request)
            .map_err(|error| ApprovalPolicyError::new(error.message))
    }
}

#[derive(Debug)]
struct RpcRunEventSink {
    events: mpsc::Sender<RunLogEvent>,
    approval_queue: RpcApprovalQueue,
    live_events: Option<mpsc::SyncSender<RunLogEvent>>,
    buffer_internal_events: bool,
}

impl TurnEventSink for RpcRunEventSink {
    fn on_event(&mut self, event: &RunLogEvent) -> Result<(), TurnEventSinkError> {
        if is_approval_pause_event(event) {
            let request = approval_request_from_event(event).map_err(|error| {
                TurnEventSinkError::new(format!(
                    "approval event could not be registered: {}",
                    error.message
                ))
            })?;
            self.approval_queue
                .register(event.run_id.clone(), request)
                .map_err(|error| {
                    TurnEventSinkError::new(format!(
                        "approval event could not be queued: {}",
                        error.message
                    ))
                })?;
        }

        if self.buffer_internal_events || is_terminal_run_event(event) {
            self.events
                .send(event.clone())
                .map_err(|_| TurnEventSinkError::new("RPC event receiver was dropped"))?;
        }
        if let Some(live_events) = &self.live_events {
            live_events
                .send(event.clone())
                .map_err(|_| TurnEventSinkError::new("RPC live event receiver was dropped"))?;
        }
        Ok(())
    }
}

struct ActiveRunSpawn<P> {
    run_id: String,
    workspace_root: PathBuf,
    provider: P,
    run_log: RunLog,
    input: AgentTurnInput,
    config: AgentTurnLoopConfig,
    approval_queue: RpcApprovalQueue,
    live_events: Option<mpsc::SyncSender<RunLogEvent>>,
}

struct ActiveTurnLoopWorker<P> {
    workspace_root: PathBuf,
    provider: P,
    run_log: SerializedRunLog,
    input: AgentTurnInput,
    config: AgentTurnLoopConfig,
    events: mpsc::Sender<RunLogEvent>,
    approval_queue: RpcApprovalQueue,
    live_events: Option<mpsc::SyncSender<RunLogEvent>>,
    buffer_internal_events: bool,
}

fn spawn_active_run<P>(spawn: ActiveRunSpawn<P>) -> Result<ActiveRpcRun, AgentRpcHandlerError>
where
    P: TurnProvider + Send + 'static,
{
    let ActiveRunSpawn {
        run_id,
        workspace_root,
        provider,
        run_log,
        input,
        config,
        approval_queue,
        live_events,
    } = spawn;
    let buffer_internal_events = live_events.is_none();
    let cancellation_token = CancellationToken::new();
    let worker_input = input.with_cancellation_token(cancellation_token.clone());
    let run_log = SerializedRunLog::new(run_log);
    let worker_run_log = run_log.clone();
    let worker_approval_queue = approval_queue.clone();
    let (events_tx, events_rx) = mpsc::channel();
    let thread_name = format!("prole-coder-rpc-{run_id}");
    let join = thread::Builder::new()
        .name(thread_name)
        .spawn(move || {
            run_active_turn_loop(ActiveTurnLoopWorker {
                workspace_root,
                provider,
                run_log: worker_run_log,
                input: worker_input,
                config,
                events: events_tx,
                approval_queue: worker_approval_queue,
                live_events,
                buffer_internal_events,
            })
        })
        .map_err(map_io_error)?;

    Ok(ActiveRpcRun {
        run_id,
        cancellation_token,
        approval_queue,
        run_log,
        events: events_rx,
        join,
    })
}

fn run_active_turn_loop<P>(worker: ActiveTurnLoopWorker<P>) -> Result<(), AgentRpcHandlerError>
where
    P: TurnProvider,
{
    let ActiveTurnLoopWorker {
        workspace_root,
        provider,
        mut run_log,
        input,
        config,
        events,
        approval_queue,
        live_events,
        buffer_internal_events,
    } = worker;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .thread_name("prole-coder-rpc-turn-loop-runtime")
        .build()
        .map_err(map_io_error)?;

    runtime.block_on(async move {
        let approval_policy = RpcApprovalPolicy {
            queue: approval_queue.clone(),
        };
        let mut event_sink = RpcRunEventSink {
            events,
            approval_queue,
            live_events,
            buffer_internal_events,
        };
        let mut loop_runner =
            AgentTurnLoop::with_approval_policy(&workspace_root, provider, approval_policy)
                .map_err(map_turn_loop_setup_error)?
                .with_config(config);

        match loop_runner
            .run_turn_with_event_sink(input, &mut run_log, &mut event_sink)
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if turn_loop_error_emitted_terminal_event(&error) => Ok(()),
            Err(error) => Err(map_completed_turn_loop_error(error)),
        }
    })
}

fn turn_loop_error_emitted_terminal_event(error: &AgentTurnLoopError) -> bool {
    !matches!(
        error,
        AgentTurnLoopError::RunLog(_) | AgentTurnLoopError::EventSink(_)
    )
}

fn is_approval_pause_event(event: &RunLogEvent) -> bool {
    event.event_type == "tool.approvalRequired"
}

fn is_terminal_run_event(event: &RunLogEvent) -> bool {
    matches!(
        event.event_type.as_str(),
        "run.completed" | "run.failed" | "run.canceled"
    )
}

fn approval_request_from_event(
    event: &RunLogEvent,
) -> Result<TurnApprovalRequest, AgentRpcHandlerError> {
    let payload: ApprovalRequiredPayload =
        serde_json::from_value(event.payload.clone()).map_err(|source| {
            AgentRpcHandlerError::new(
                RPC_INTERNAL_INVARIANT,
                format!("approval event payload does not match schema: {source}"),
            )
        })?;

    Ok(TurnApprovalRequest {
        approval_id: payload.approval_id,
        tool_call_id: payload.tool_call_id,
        tool_name: payload.tool_name,
        risk: payload.risk.into(),
        title: payload.title,
        detail: payload.detail,
        command: payload.command,
        cwd: payload.cwd,
        output_summary: payload.output_summary,
        paths: payload.paths,
        hunks: payload.hunks,
        risk_reasons: payload.risk_reasons,
        persistable: payload.persistable,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalRequiredPayload {
    approval_id: String,
    tool_call_id: String,
    tool_name: String,
    risk: ApprovalRequiredRisk,
    title: String,
    detail: String,
    command: Option<String>,
    cwd: Option<String>,
    output_summary: Option<String>,
    paths: Option<Vec<String>>,
    hunks: Option<Vec<prole_coder_agent_core::tool_execution::PatchApprovalHunk>>,
    #[serde(default)]
    risk_reasons: Vec<String>,
    persistable: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ApprovalRequiredRisk {
    Read,
    Write,
    Exec,
    Network,
    Destructive,
}

impl From<ApprovalRequiredRisk> for RiskLevel {
    fn from(value: ApprovalRequiredRisk) -> Self {
        match value {
            ApprovalRequiredRisk::Read => Self::Read,
            ApprovalRequiredRisk::Write => Self::Write,
            ApprovalRequiredRisk::Exec => Self::Exec,
            ApprovalRequiredRisk::Network => Self::Network,
            ApprovalRequiredRisk::Destructive => Self::Destructive,
        }
    }
}

fn map_run_log_error(error: RunLogError) -> AgentRpcHandlerError {
    match error {
        RunLogError::RunAlreadyExists { run_id } => AgentRpcHandlerError::new(
            RPC_RUN_ALREADY_ACTIVE,
            format!("run `{run_id}` already exists"),
        ),
        RunLogError::RunNotFound { run_id } => {
            AgentRpcHandlerError::new(RPC_RUN_NOT_FOUND, format!("run `{run_id}` was not found"))
        }
        RunLogError::WorkspaceRootNotDirectory { path } => AgentRpcHandlerError::new(
            JSON_RPC_INVALID_PARAMS,
            format!("workspace root is not a directory: {}", path.display()),
        ),
        RunLogError::InvalidIdentifier { kind, value } => {
            AgentRpcHandlerError::new(JSON_RPC_INVALID_PARAMS, format!("invalid {kind}: {value}"))
        }
        RunLogError::InvalidStatePath { path } => AgentRpcHandlerError::new(
            JSON_RPC_INVALID_PARAMS,
            format!("state path must be workspace-relative: {}", path.display()),
        ),
        other => AgentRpcHandlerError::new(RPC_INTERNAL_INVARIANT, other.to_string()),
    }
}

fn map_turn_loop_setup_error(error: AgentTurnLoopError) -> AgentRpcHandlerError {
    AgentRpcHandlerError::new(RPC_INTERNAL_INVARIANT, error.to_string())
}

fn map_completed_turn_loop_error(error: AgentTurnLoopError) -> AgentRpcHandlerError {
    match error {
        AgentTurnLoopError::ApprovalRejected {
            approval_id,
            reason,
            ..
        } => AgentRpcHandlerError::new(
            RPC_APPROVAL_DENIED,
            format!("approval `{approval_id}` rejected: {reason}"),
        ),
        AgentTurnLoopError::ApprovalCanceled { reason, .. }
        | AgentTurnLoopError::ApprovalExpired { reason, .. } => {
            AgentRpcHandlerError::new(RPC_RUN_CANCELED, reason)
        }
        other => AgentRpcHandlerError::new(RPC_INTERNAL_INVARIANT, other.to_string()),
    }
}

fn map_io_error(error: io::Error) -> AgentRpcHandlerError {
    AgentRpcHandlerError::new(RPC_INTERNAL_INVARIANT, error.to_string())
}

fn map_rpc_error(error: AgentRpcError) -> AgentRpcHandlerError {
    AgentRpcHandlerError::new(RPC_INTERNAL_INVARIANT, error.to_string())
}

fn generate_id(prefix: &str) -> Result<String, AgentRpcHandlerError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|source| {
            AgentRpcHandlerError::new(
                RPC_INTERNAL_INVARIANT,
                format!("system clock is before UNIX epoch: {source}"),
            )
        })?
        .as_millis();
    Ok(format!("{prefix}_{}_{}", std::process::id(), millis))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JsonRpcNotification<TParams> {
    pub jsonrpc: String,
    pub method: String,
    pub params: TParams,
}

impl<TParams> JsonRpcNotification<TParams> {
    pub fn new(method: RpcMethod, params: TParams) -> Self {
        Self {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            method: method.qualified_name(),
            params,
        }
    }
}

pub type AgentEventNotification = JsonRpcNotification<AgentEventEnvelope>;
pub type AgentEventBatchNotification = JsonRpcNotification<AgentEventBatchParams>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub seq: u64,
    pub time: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventBatchParams {
    pub events: Vec<AgentEventEnvelope>,
    pub first_seq: u64,
    pub last_seq: u64,
    pub count: usize,
}

pub fn run_log_event_to_envelope(event: &RunLogEvent) -> Result<AgentEventEnvelope, AgentRpcError> {
    Ok(AgentEventEnvelope {
        seq: event.seq,
        time: format_unix_millis(event.time_unix_ms)?,
        event_type: event.event_type.clone(),
        run_id: event.run_id.clone(),
        turn_id: event.turn_id.clone(),
        payload: event.payload.clone(),
    })
}

pub fn run_log_event_to_notification(
    event: &RunLogEvent,
) -> Result<AgentEventNotification, AgentRpcError> {
    Ok(JsonRpcNotification::new(
        EVENT_METHOD,
        run_log_event_to_envelope(event)?,
    ))
}

pub fn run_log_events_to_batch_notification(
    events: &[RunLogEvent],
) -> Result<AgentEventBatchNotification, AgentRpcError> {
    let envelopes = events
        .iter()
        .map(run_log_event_to_envelope)
        .collect::<Result<Vec<_>, _>>()?;
    let first_seq = envelopes.first().map_or(0, |event| event.seq);
    let last_seq = envelopes.last().map_or(0, |event| event.seq);
    let count = envelopes.len();

    Ok(JsonRpcNotification::new(
        EVENT_BATCH_METHOD,
        AgentEventBatchParams {
            events: envelopes,
            first_seq,
            last_seq,
            count,
        },
    ))
}

#[derive(Debug)]
pub struct StdioEventBridge<W> {
    writer: W,
}

impl<W> StdioEventBridge<W>
where
    W: Write,
{
    pub fn new(writer: W) -> Self {
        Self { writer }
    }

    pub fn into_inner(self) -> W {
        self.writer
    }

    pub fn emit_event(&mut self, event: &RunLogEvent) -> Result<AgentEventEnvelope, AgentRpcError> {
        let notification = run_log_event_to_notification(event)?;
        let envelope = notification.params.clone();
        write_json_line(&mut self.writer, &notification)?;
        Ok(envelope)
    }

    pub fn emit_events<'event>(
        &mut self,
        events: impl IntoIterator<Item = &'event RunLogEvent>,
    ) -> Result<Vec<AgentEventEnvelope>, AgentRpcError> {
        events
            .into_iter()
            .map(|event| self.emit_event(event))
            .collect()
    }
}

impl<W> TurnEventSink for StdioEventBridge<W>
where
    W: Write,
{
    fn on_event(&mut self, event: &RunLogEvent) -> Result<(), TurnEventSinkError> {
        self.emit_event(event)
            .map(|_| ())
            .map_err(|source| TurnEventSinkError::new(source.to_string()))
    }
}

#[derive(Debug)]
pub struct AgentRpcServer<H> {
    handler: H,
    initialized: bool,
}

impl<H> AgentRpcServer<H>
where
    H: AgentRpcRequestHandler,
{
    pub fn new(handler: H) -> Self {
        Self {
            handler,
            initialized: false,
        }
    }

    pub fn into_inner(self) -> H {
        self.handler
    }

    pub fn handle_line<W>(&mut self, line: &str, writer: &mut W) -> Result<(), AgentRpcError>
    where
        W: Write,
    {
        if line.trim().is_empty() {
            return Ok(());
        }

        let message = match parse_incoming_message(line) {
            Ok(message) => message,
            Err(error) => {
                let id = error.id.clone();
                write_json_line(
                    writer,
                    &JsonRpcErrorResponse::new(id, error.into_error_object()),
                )?;
                return Ok(());
            }
        };

        let Some(id) = message.id else {
            return Ok(());
        };

        if message.jsonrpc != JSON_RPC_VERSION {
            return write_error(
                writer,
                id,
                JsonRpcErrorObject::new(
                    JSON_RPC_INVALID_REQUEST,
                    "JSON-RPC message must use version 2.0",
                ),
            );
        }

        if !self.initialized && message.method != INITIALIZE_METHOD.qualified_name() {
            return write_error(
                writer,
                id,
                JsonRpcErrorObject::new(
                    JSON_RPC_INVALID_REQUEST,
                    "agent.initialize must be the first request",
                ),
            );
        }

        match message.method.as_str() {
            method if method == INITIALIZE_METHOD.qualified_name() => {
                self.handle_initialize(id, message.params, writer)
            }
            method if method == SEND_TURN_METHOD.qualified_name() => {
                self.handle_send_turn(id, message.params, writer)
            }
            method if method == APPROVE_METHOD.qualified_name() => {
                self.handle_approve(id, message.params, writer)
            }
            method if method == REJECT_METHOD.qualified_name() => {
                self.handle_reject(id, message.params, writer)
            }
            method if method == CANCEL_METHOD.qualified_name() => {
                self.handle_cancel(id, message.params, writer)
            }
            method if method == RESUME_METHOD.qualified_name() => {
                self.handle_resume(id, message.params, writer)
            }
            method if method == LIST_RUNS_METHOD.qualified_name() => {
                self.handle_list_runs(id, message.params, writer)
            }
            method if method == FIM_PREVIEW_METHOD.qualified_name() => {
                self.handle_preview_fim(id, message.params, writer)
            }
            method => write_error(
                writer,
                id,
                JsonRpcErrorObject::new(
                    JSON_RPC_METHOD_NOT_FOUND,
                    format!("method `{method}` is not supported by this request loop"),
                ),
            ),
        }
    }

    pub fn shutdown<W>(&mut self, writer: &mut W) -> Result<(), AgentRpcError>
    where
        W: Write,
    {
        let events = self
            .handler
            .shutdown()
            .map_err(|source| AgentRpcError::HandlerShutdown(source.message))?;
        emit_run_log_events(writer, &events)
    }

    fn handle_initialize<W>(
        &mut self,
        id: Value,
        params: Option<Value>,
        writer: &mut W,
    ) -> Result<(), AgentRpcError>
    where
        W: Write,
    {
        if self.initialized {
            return write_error(
                writer,
                id,
                JsonRpcErrorObject::new(
                    JSON_RPC_INVALID_REQUEST,
                    "agent.initialize must not be called more than once",
                ),
            );
        }

        let params = match parse_params::<AgentInitializeParams>(
            params,
            INITIALIZE_METHOD.qualified_name().as_str(),
        ) {
            Ok(params) => params,
            Err(error) => return write_error(writer, id, error),
        };

        if params.protocol_version != PROTOCOL_VERSION {
            return write_error(
                writer,
                id,
                JsonRpcErrorObject::new(
                    RPC_UNSUPPORTED_PROTOCOL,
                    format!(
                        "unsupported protocol version `{}`, expected `{PROTOCOL_VERSION}`",
                        params.protocol_version
                    ),
                )
                .with_data(json!({
                    "clientProtocolVersion": params.protocol_version,
                    "serverProtocolVersion": PROTOCOL_VERSION,
                })),
            );
        }

        match self.handler.initialize(params) {
            Ok(result) => {
                write_json_line(writer, &JsonRpcResponse::new(id, result))?;
                self.initialized = true;
                Ok(())
            }
            Err(error) => write_error(writer, id, error.into_error_object()),
        }
    }

    fn handle_approve<W>(
        &mut self,
        id: Value,
        params: Option<Value>,
        writer: &mut W,
    ) -> Result<(), AgentRpcError>
    where
        W: Write,
    {
        let params =
            match parse_params::<ApproveParams>(params, APPROVE_METHOD.qualified_name().as_str()) {
                Ok(params) => params,
                Err(error) => return write_error(writer, id, error),
            };

        match self.handler.approve(params) {
            Ok(output) => {
                write_json_line(writer, &JsonRpcResponse::new(id, output.result))?;
                emit_run_log_events(writer, &output.events)
            }
            Err(error) => write_error(writer, id, error.into_error_object()),
        }
    }

    fn handle_reject<W>(
        &mut self,
        id: Value,
        params: Option<Value>,
        writer: &mut W,
    ) -> Result<(), AgentRpcError>
    where
        W: Write,
    {
        let params =
            match parse_params::<RejectParams>(params, REJECT_METHOD.qualified_name().as_str()) {
                Ok(params) => params,
                Err(error) => return write_error(writer, id, error),
            };

        match self.handler.reject(params) {
            Ok(output) => {
                write_json_line(writer, &JsonRpcResponse::new(id, output.result))?;
                emit_run_log_events(writer, &output.events)
            }
            Err(error) => write_error(writer, id, error.into_error_object()),
        }
    }

    fn handle_cancel<W>(
        &mut self,
        id: Value,
        params: Option<Value>,
        writer: &mut W,
    ) -> Result<(), AgentRpcError>
    where
        W: Write,
    {
        let params =
            match parse_params::<CancelParams>(params, CANCEL_METHOD.qualified_name().as_str()) {
                Ok(params) => params,
                Err(error) => return write_error(writer, id, error),
            };

        match self.handler.cancel(params) {
            Ok(output) => {
                write_json_line(writer, &JsonRpcResponse::new(id, output.result))?;
                emit_run_log_events(writer, &output.events)
            }
            Err(error) => write_error(writer, id, error.into_error_object()),
        }
    }

    fn handle_send_turn<W>(
        &mut self,
        id: Value,
        params: Option<Value>,
        writer: &mut W,
    ) -> Result<(), AgentRpcError>
    where
        W: Write,
    {
        let params = match parse_params::<SendTurnParams>(
            params,
            SEND_TURN_METHOD.qualified_name().as_str(),
        ) {
            Ok(params) => params,
            Err(error) => return write_error(writer, id, error),
        };

        match self.handler.send_turn(params) {
            Ok(output) => {
                write_json_line(writer, &JsonRpcResponse::new(id, output.result))?;
                emit_run_log_events(writer, &output.events)
            }
            Err(error) => write_error(writer, id, error.into_error_object()),
        }
    }

    fn handle_resume<W>(
        &mut self,
        id: Value,
        params: Option<Value>,
        writer: &mut W,
    ) -> Result<(), AgentRpcError>
    where
        W: Write,
    {
        let params =
            match parse_params::<ResumeParams>(params, RESUME_METHOD.qualified_name().as_str()) {
                Ok(params) => params,
                Err(error) => return write_error(writer, id, error),
            };

        match self.handler.resume(params) {
            Ok(output) => {
                write_json_line(writer, &JsonRpcResponse::new(id, output.result))?;
                emit_run_log_events(writer, &output.events)
            }
            Err(error) => write_error(writer, id, error.into_error_object()),
        }
    }

    fn handle_list_runs<W>(
        &mut self,
        id: Value,
        params: Option<Value>,
        writer: &mut W,
    ) -> Result<(), AgentRpcError>
    where
        W: Write,
    {
        let params = match parse_optional_params::<ListRunsParams>(
            params,
            LIST_RUNS_METHOD.qualified_name().as_str(),
        ) {
            Ok(params) => params,
            Err(error) => return write_error(writer, id, error),
        };

        match self.handler.list_runs(params) {
            Ok(output) => {
                write_json_line(writer, &JsonRpcResponse::new(id, output.result))?;
                emit_run_log_events(writer, &output.events)
            }
            Err(error) => write_error(writer, id, error.into_error_object()),
        }
    }

    fn handle_preview_fim<W>(
        &mut self,
        id: Value,
        params: Option<Value>,
        writer: &mut W,
    ) -> Result<(), AgentRpcError>
    where
        W: Write,
    {
        let params = match parse_params::<FimPreviewParams>(
            params,
            FIM_PREVIEW_METHOD.qualified_name().as_str(),
        ) {
            Ok(params) => params,
            Err(error) => return write_error(writer, id, error),
        };

        match self.handler.preview_fim(params) {
            Ok(output) => {
                write_json_line(writer, &JsonRpcResponse::new(id, output.result))?;
                emit_run_log_events(writer, &output.events)
            }
            Err(error) => write_error(writer, id, error.into_error_object()),
        }
    }
}

#[derive(Debug)]
enum RpcLoopMessage {
    InputLine(Result<String, io::Error>),
    ReaderEof,
    RunEvent(RunLogEvent),
}

pub fn run_stdio_request_loop<R, W, H>(
    reader: R,
    writer: &mut W,
    handler: H,
) -> Result<H, AgentRpcError>
where
    R: BufRead + Send,
    W: Write,
    H: AgentRpcRequestHandler,
{
    let (loop_tx, loop_rx) = mpsc::sync_channel(RPC_LOOP_QUEUE_BOUND);
    let (live_event_tx, live_event_rx) = mpsc::sync_channel(RPC_LIVE_EVENT_QUEUE_BOUND);
    let disconnect_handle = RpcDisconnectHandle::default();
    let mut server = AgentRpcServer::new(handler);
    server.handler.attach_live_event_sender(live_event_tx);
    server
        .handler
        .attach_disconnect_handle(disconnect_handle.clone());

    thread::scope(|scope| -> Result<(), AgentRpcError> {
        let reader_tx = loop_tx.clone();
        scope.spawn(move || {
            for line in reader.lines() {
                if reader_tx.send(RpcLoopMessage::InputLine(line)).is_err() {
                    return;
                }
            }
            let _ = reader_tx.send(RpcLoopMessage::ReaderEof);
        });

        let event_tx = loop_tx.clone();
        scope.spawn(move || {
            for event in live_event_rx {
                if event_tx.send(RpcLoopMessage::RunEvent(event)).is_err() {
                    return;
                }
            }
        });
        drop(loop_tx);

        let mut shutdown_started = false;
        let mut pending_error = None;
        let mut pending_messages = VecDeque::new();
        loop {
            let message = match pending_messages.pop_front() {
                Some(message) => message,
                None => match loop_rx.recv() {
                    Ok(message) => message,
                    Err(_) => break,
                },
            };

            match message {
                RpcLoopMessage::InputLine(Ok(line)) if !shutdown_started => {
                    let result = server.handle_line(&line, writer);
                    handle_stdio_write_result(&mut server, result, &disconnect_handle)?;
                }
                RpcLoopMessage::InputLine(Err(error)) if !shutdown_started => {
                    shutdown_started = true;
                    pending_error = Some(AgentRpcError::Io(error));
                    let result = server.shutdown(writer);
                    handle_stdio_write_result(&mut server, result, &disconnect_handle)?;
                    detach_stdio_loop_handler(&mut server);
                }
                RpcLoopMessage::ReaderEof if !shutdown_started => {
                    shutdown_started = true;
                    let result = server.shutdown(writer);
                    handle_stdio_write_result(&mut server, result, &disconnect_handle)?;
                    detach_stdio_loop_handler(&mut server);
                }
                RpcLoopMessage::RunEvent(event) => {
                    let mut events = vec![event];
                    while events.len() < RPC_LIVE_EVENT_BATCH_MAX {
                        match loop_rx.try_recv() {
                            Ok(RpcLoopMessage::RunEvent(event)) => events.push(event),
                            Ok(other) => {
                                pending_messages.push_back(other);
                                break;
                            }
                            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => {
                                break;
                            }
                        }
                    }
                    let result = emit_live_run_log_events(writer, &events);
                    handle_stdio_write_result(&mut server, result, &disconnect_handle)?;
                }
                RpcLoopMessage::InputLine(_) | RpcLoopMessage::ReaderEof => {}
            }
        }

        if !shutdown_started {
            let result = server.shutdown(writer);
            handle_stdio_write_result(&mut server, result, &disconnect_handle)?;
            detach_stdio_loop_handler(&mut server);
        }

        match pending_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    })?;
    Ok(server.into_inner())
}

fn detach_stdio_loop_handler<H>(server: &mut AgentRpcServer<H>)
where
    H: AgentRpcRequestHandler,
{
    server.handler.detach_live_event_sender();
    server.handler.detach_disconnect_handle();
}

fn write_or_cancel_disconnect(
    result: Result<(), AgentRpcError>,
    disconnect_handle: &RpcDisconnectHandle,
) -> Result<(), AgentRpcError> {
    if result.is_err() {
        let _ = disconnect_handle.cancel_active("RPC client disconnected".to_owned());
    }
    result
}

fn handle_stdio_write_result<H>(
    server: &mut AgentRpcServer<H>,
    result: Result<(), AgentRpcError>,
    disconnect_handle: &RpcDisconnectHandle,
) -> Result<(), AgentRpcError>
where
    H: AgentRpcRequestHandler,
{
    match write_or_cancel_disconnect(result, disconnect_handle) {
        Ok(()) => Ok(()),
        Err(error) => {
            detach_stdio_loop_handler(server);
            Err(error)
        }
    }
}

pub fn write_json_line<W, T>(writer: &mut W, message: &T) -> Result<(), AgentRpcError>
where
    W: Write,
    T: Serialize,
{
    serde_json::to_writer(&mut *writer, message)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn write_error<W>(writer: &mut W, id: Value, error: JsonRpcErrorObject) -> Result<(), AgentRpcError>
where
    W: Write,
{
    write_json_line(writer, &JsonRpcErrorResponse::new(id, error))
}

fn emit_run_log_events<W>(writer: &mut W, events: &[RunLogEvent]) -> Result<(), AgentRpcError>
where
    W: Write,
{
    for event in events {
        let notification = run_log_event_to_notification(event)?;
        write_json_line(writer, &notification)?;
    }

    Ok(())
}

fn emit_live_run_log_events<W>(writer: &mut W, events: &[RunLogEvent]) -> Result<(), AgentRpcError>
where
    W: Write,
{
    if events.len() <= 1 {
        return emit_run_log_events(writer, events);
    }

    let notification = run_log_events_to_batch_notification(events)?;
    write_json_line(writer, &notification)
}

#[derive(Debug, Clone, PartialEq)]
struct IncomingMessage {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

fn parse_incoming_message(line: &str) -> Result<IncomingMessage, AgentRpcParseError> {
    let value: Value = serde_json::from_str(line).map_err(|source| AgentRpcParseError {
        code: JSON_RPC_PARSE_ERROR,
        id: Value::Null,
        message: format!("JSON-RPC parse error: {source}"),
    })?;
    let object = value.as_object().ok_or_else(|| AgentRpcParseError {
        code: JSON_RPC_INVALID_REQUEST,
        id: Value::Null,
        message: "JSON-RPC message must be an object".to_owned(),
    })?;
    let error_id = object.get("id").cloned().unwrap_or(Value::Null);
    let jsonrpc = object
        .get("jsonrpc")
        .and_then(Value::as_str)
        .ok_or_else(|| AgentRpcParseError {
            code: JSON_RPC_INVALID_REQUEST,
            id: error_id.clone(),
            message: "JSON-RPC message is missing string field `jsonrpc`".to_owned(),
        })?
        .to_owned();
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| AgentRpcParseError {
            code: JSON_RPC_INVALID_REQUEST,
            id: error_id,
            message: "JSON-RPC message is missing string field `method`".to_owned(),
        })?
        .to_owned();
    let id = object.get("id").cloned();
    let params = object.get("params").cloned();

    Ok(IncomingMessage {
        jsonrpc,
        id,
        method,
        params,
    })
}

#[derive(Debug, Clone, PartialEq)]
struct AgentRpcParseError {
    code: i64,
    id: Value,
    message: String,
}

impl AgentRpcParseError {
    fn into_error_object(self) -> JsonRpcErrorObject {
        JsonRpcErrorObject::new(self.code, self.message)
    }
}

fn parse_params<T>(params: Option<Value>, method: &str) -> Result<T, JsonRpcErrorObject>
where
    T: for<'de> Deserialize<'de>,
{
    let params = params.unwrap_or(Value::Null);
    serde_json::from_value(params).map_err(|source| {
        JsonRpcErrorObject::new(
            JSON_RPC_INVALID_PARAMS,
            format!("invalid params for {method}: {source}"),
        )
    })
}

fn parse_optional_params<T>(params: Option<Value>, method: &str) -> Result<T, JsonRpcErrorObject>
where
    T: Default + for<'de> Deserialize<'de>,
{
    match params {
        None | Some(Value::Null) => Ok(T::default()),
        Some(params) => serde_json::from_value(params).map_err(|source| {
            JsonRpcErrorObject::new(
                JSON_RPC_INVALID_PARAMS,
                format!("invalid params for {method}: {source}"),
            )
        }),
    }
}

#[derive(Debug, Error)]
pub enum AgentRpcError {
    #[error("JSON-RPC message serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("JSON-RPC stdio write failed: {0}")]
    Io(#[from] io::Error),
    #[error("JSON-RPC handler shutdown failed: {0}")]
    HandlerShutdown(String),
    #[error("event timestamp exceeds supported range: {time_unix_ms}")]
    TimestampOutOfRange { time_unix_ms: u64 },
}

fn format_unix_millis(time_unix_ms: u64) -> Result<String, AgentRpcError> {
    let seconds = time_unix_ms / 1_000;
    let millis = time_unix_ms % 1_000;
    let days = seconds / 86_400;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_unix_days(days, time_unix_ms)?;
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
}

fn civil_from_unix_days(
    days_since_unix_epoch: u64,
    time_unix_ms: u64,
) -> Result<(i64, u32, u32), AgentRpcError> {
    let days_since_unix_epoch = i64::try_from(days_since_unix_epoch)
        .map_err(|_| AgentRpcError::TimestampOutOfRange { time_unix_ms })?;
    let z = days_since_unix_epoch
        .checked_add(719_468)
        .ok_or(AgentRpcError::TimestampOutOfRange { time_unix_ms })?;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };

    Ok((
        year,
        u32::try_from(month).map_err(|_| AgentRpcError::TimestampOutOfRange { time_unix_ms })?,
        u32::try_from(day).map_err(|_| AgentRpcError::TimestampOutOfRange { time_unix_ms })?,
    ))
}

#[cfg(test)]
mod tests {
    const RPC_TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

    use prole_coder_agent_core::{
        approval::RiskLevel,
        provider::deepseek_api::ChatToolCall,
        run_log::{RunLogEvent, RunLogStore},
        test_helpers::TestWorkspace,
        turn_loop::{
            AgentTurnInput, AgentTurnLoopConfig, ApprovalDecision, TurnApprovalRequest,
            TurnEventSink, TurnProvider, TurnProviderError, TurnProviderFuture,
            TurnProviderRequest, TurnProviderResponse, turn_provider_response_stream,
        },
    };
    use serde::Deserialize;
    use serde_json::{Value, json};
    use std::{
        collections::{HashMap, VecDeque},
        io::{self, Cursor, Read, Write},
        sync::{Arc, Condvar, Mutex, mpsc},
        thread,
        time::{Duration, Instant},
    };

    use super::{
        APPROVE_METHOD, ActiveRunSpawn, AgentInitializeParams, AgentInitializeResult,
        AgentRpcError, AgentRpcHandlerError, AgentRpcHandlerOutput, AgentRpcRequestHandler,
        AgentTurnLoopRpcHandler, ApproveParams, ApproveResult, CANCEL_METHOD, CancelParams,
        CancelResult, EVENT_BATCH_METHOD, EVENT_METHOD, FIM_PREVIEW_METHOD, FimPreviewParams,
        FimPreviewResult, INITIALIZE_METHOD, JSON_RPC_INTERNAL_ERROR, JSON_RPC_INVALID_PARAMS,
        JSON_RPC_INVALID_REQUEST, JSON_RPC_METHOD_NOT_FOUND, JSON_RPC_PARSE_ERROR,
        LIST_RUNS_METHOD, ListRunsParams, ListRunsResult, PROTOCOL_VERSION, REJECT_METHOD,
        RESUME_METHOD, RPC_APPROVAL_DENIED, RPC_APPROVAL_NOT_FOUND, RPC_CONTEXT_BUDGET_EXCEEDED,
        RPC_INTERNAL_INVARIANT, RPC_INVALID_TOOL_ARGUMENTS, RPC_PROVIDER_ERROR,
        RPC_RUN_ALREADY_ACTIVE, RPC_RUN_CANCELED, RPC_RUN_NOT_FOUND, RPC_TOOL_EXECUTION_FAILED,
        RPC_UNSUPPORTED_PROTOCOL, RPC_WORKSPACE_UNTRUSTED, RejectParams, RejectResult,
        ResumeParams, ResumeResult, RpcApprovalPersistence, RpcApprovalQueue, RpcApprovalState,
        RpcApprovedHunks, RpcRunState, RpcRunSummary, RpcRunSummaryStatus, RpcWorkspace,
        SEND_TURN_METHOD, SendTurnParams, SendTurnResult, StdioEventBridge,
        emit_live_run_log_events, format_unix_millis, run_log_event_to_notification,
        run_log_events_to_batch_notification, run_stdio_request_loop, spawn_active_run,
    };

    #[test]
    fn method_names_match_protocol_docs() {
        assert_eq!(INITIALIZE_METHOD.qualified_name(), "agent.initialize");
        assert_eq!(SEND_TURN_METHOD.qualified_name(), "agent.sendTurn");
        assert_eq!(APPROVE_METHOD.qualified_name(), "agent.approve");
        assert_eq!(REJECT_METHOD.qualified_name(), "agent.reject");
        assert_eq!(CANCEL_METHOD.qualified_name(), "agent.cancel");
        assert_eq!(RESUME_METHOD.qualified_name(), "agent.resume");
        assert_eq!(LIST_RUNS_METHOD.qualified_name(), "agent.listRuns");
        assert_eq!(FIM_PREVIEW_METHOD.qualified_name(), "agent.previewFim");
        assert_eq!(EVENT_METHOD.qualified_name(), "agent.event");
        assert_eq!(EVENT_BATCH_METHOD.qualified_name(), "agent.eventBatch");
    }

    #[test]
    fn error_codes_match_protocol_docs() {
        let docs = include_str!("../../../docs/json-rpc-protocol.md");
        let expected = [
            (JSON_RPC_PARSE_ERROR, "Parse error"),
            (JSON_RPC_INVALID_REQUEST, "Invalid Request"),
            (JSON_RPC_METHOD_NOT_FOUND, "Method not found"),
            (JSON_RPC_INVALID_PARAMS, "Invalid params"),
            (JSON_RPC_INTERNAL_ERROR, "Internal error"),
            (RPC_UNSUPPORTED_PROTOCOL, "`E_UNSUPPORTED_PROTOCOL`"),
            (RPC_WORKSPACE_UNTRUSTED, "`E_WORKSPACE_UNTRUSTED`"),
            (RPC_RUN_NOT_FOUND, "`E_RUN_NOT_FOUND`"),
            (RPC_RUN_ALREADY_ACTIVE, "`E_RUN_ALREADY_ACTIVE`"),
            (RPC_INVALID_TOOL_ARGUMENTS, "`E_INVALID_TOOL_ARGUMENTS`"),
            (RPC_APPROVAL_NOT_FOUND, "`E_APPROVAL_NOT_FOUND`"),
            (RPC_APPROVAL_DENIED, "`E_APPROVAL_DENIED`"),
            (RPC_CONTEXT_BUDGET_EXCEEDED, "`E_CONTEXT_BUDGET_EXCEEDED`"),
            (RPC_PROVIDER_ERROR, "`E_PROVIDER_ERROR`"),
            (RPC_TOOL_EXECUTION_FAILED, "`E_TOOL_EXECUTION_FAILED`"),
            (RPC_RUN_CANCELED, "`E_RUN_CANCELED`"),
            (RPC_INTERNAL_INVARIANT, "`E_INTERNAL_INVARIANT`"),
        ];

        for (code, name) in expected {
            let row_prefix = format!("| {code} | {name} |");
            assert!(
                docs.contains(&row_prefix),
                "protocol docs should contain error row starting with `{row_prefix}`"
            );
        }
    }

    #[test]
    fn run_log_event_converts_to_agent_event_notification() {
        let event = RunLogEvent {
            seq: 7,
            time_unix_ms: 123,
            event_type: "assistant.delta".to_owned(),
            run_id: "run_01".to_owned(),
            turn_id: Some("turn_01".to_owned()),
            payload: json!({ "text": "hello" }),
        };

        let notification =
            run_log_event_to_notification(&event).expect("notification should convert");
        assert_eq!(notification.jsonrpc, "2.0");
        assert_eq!(notification.method, "agent.event");
        assert_eq!(notification.params.seq, 7);
        assert_eq!(notification.params.time, "1970-01-01T00:00:00.123Z");
        assert_eq!(notification.params.event_type, "assistant.delta");
        assert_eq!(notification.params.run_id, "run_01");
        assert_eq!(notification.params.turn_id.as_deref(), Some("turn_01"));
        assert_eq!(notification.params.payload["text"], "hello");
    }

    #[test]
    fn default_initialize_result_exposes_provider_capabilities() {
        let result = AgentInitializeResult::default();
        let value = serde_json::to_value(&result).expect("initialize result should serialize");

        assert_eq!(value["capabilities"]["supportsEventBatching"], true);
        assert_eq!(
            value["capabilities"]["provider"]["defaultModel"],
            "deepseek-v4-pro"
        );
        assert_eq!(
            value["capabilities"]["provider"]["models"][0]["contextWindowTokens"],
            1_048_576
        );
        assert_eq!(
            value["capabilities"]["provider"]["models"][1]["maxOutputTokens"],
            393_216
        );
    }

    #[test]
    fn run_log_events_convert_to_agent_event_batch_notification() {
        let events = vec![
            run_log_event(
                10,
                "assistant.delta",
                "run_01",
                Some("turn_01"),
                json!({ "text": "hello" }),
            ),
            run_log_event(
                11,
                "assistant.delta",
                "run_01",
                Some("turn_01"),
                json!({ "text": " world" }),
            ),
        ];

        let notification = run_log_events_to_batch_notification(&events)
            .expect("batch notification should convert");

        assert_eq!(notification.jsonrpc, "2.0");
        assert_eq!(notification.method, "agent.eventBatch");
        assert_eq!(notification.params.first_seq, 10);
        assert_eq!(notification.params.last_seq, 11);
        assert_eq!(notification.params.count, 2);
        assert_eq!(notification.params.events[0].seq, 10);
        assert_eq!(notification.params.events[1].payload["text"], " world");
    }

    #[test]
    fn live_event_emission_batches_multiple_queued_events() {
        let events = vec![
            run_log_event(
                1,
                "assistant.delta",
                "run_01",
                Some("turn_01"),
                json!({ "text": "a" }),
            ),
            run_log_event(
                2,
                "assistant.delta",
                "run_01",
                Some("turn_01"),
                json!({ "text": "b" }),
            ),
        ];
        let mut output = Vec::new();

        emit_live_run_log_events(&mut output, &events)
            .expect("live events should be emitted as one batch");

        let lines = output_lines(output);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["method"], "agent.eventBatch");
        assert_eq!(lines[0]["params"]["firstSeq"], 1);
        assert_eq!(lines[0]["params"]["lastSeq"], 2);
        assert_eq!(lines[0]["params"]["count"], 2);
    }

    #[test]
    fn live_event_emission_keeps_single_event_wire_compatible() {
        let event = run_log_event(
            1,
            "assistant.delta",
            "run_01",
            Some("turn_01"),
            json!({ "text": "hello" }),
        );
        let mut output = Vec::new();

        emit_live_run_log_events(&mut output, &[event]).expect("single live event should emit");

        let lines = output_lines(output);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["method"], "agent.event");
        assert_eq!(lines[0]["params"]["seq"], 1);
    }

    #[test]
    fn event_payload_fixture_matches_rust_payload_samples() {
        #[derive(Deserialize)]
        struct EventPayloadFixture {
            version: String,
            events: Vec<EventPayloadFixtureEntry>,
        }

        #[derive(Deserialize)]
        struct EventPayloadFixtureEntry {
            #[serde(rename = "type")]
            event_type: String,
            required: Vec<String>,
        }

        let fixture: EventPayloadFixture = serde_json::from_str(include_str!(
            "../../../docs/protocol/event-payloads.v1.json"
        ))
        .expect("event payload fixture should parse");
        let samples = HashMap::from([
            (
                "provider.requested",
                json!({
                    "iteration": 1,
                    "messageCount": 4,
                    "reasoningState": { "status": "active" }
                }),
            ),
            (
                "tool.completed",
                json!({
                    "toolCallId": "call_1",
                    "name": "shell",
                    "status": "ok",
                    "summary": "Command completed.",
                    "result": { "exitCode": 0 }
                }),
            ),
            (
                "run.completed",
                json!({
                    "summary": "Updated the workspace.",
                    "changedFiles": ["README.md"],
                    "verificationStatus": "passed"
                }),
            ),
            (
                "tool.approvalRequired",
                json!({
                    "approvalId": "approval_1",
                    "toolCallId": "call_patch",
                    "toolName": "apply_patch",
                    "risk": "write",
                    "title": "Apply patch",
                    "detail": "Modify README.md",
                    "paths": ["README.md"],
                    "hunks": [{
                        "id": "README.md#1:old1+3:new1+3",
                        "filePath": "README.md",
                        "fileIndex": 0,
                        "hunkIndex": 0,
                        "oldStart": 1,
                        "oldCount": 3,
                        "newStart": 1,
                        "newCount": 3
                    }],
                    "persistable": true
                }),
            ),
            (
                "tool.approvalResolved",
                json!({
                    "approvalId": "approval_1",
                    "toolCallId": "call_patch",
                    "toolName": "apply_patch",
                    "decision": "approved",
                    "hunks": {
                        "scope": "selected",
                        "approved": ["README.md#1:old1+3:new1+3"]
                    }
                }),
            ),
        ]);

        assert_eq!(fixture.version, PROTOCOL_VERSION);
        for event in fixture.events {
            let sample = samples
                .get(event.event_type.as_str())
                .unwrap_or_else(|| panic!("missing sample for {}", event.event_type));
            let object = sample
                .as_object()
                .expect("sample payload must be an object");
            for field in event.required {
                assert!(
                    object.contains_key(&field),
                    "{} must include required field {}",
                    event.event_type,
                    field
                );
            }
        }
    }

    #[test]
    fn stdio_bridge_writes_newline_delimited_notifications() {
        let events = vec![
            RunLogEvent {
                seq: 1,
                time_unix_ms: 0,
                event_type: "run.started".to_owned(),
                run_id: "run_01".to_owned(),
                turn_id: None,
                payload: json!({ "mode": "ask" }),
            },
            RunLogEvent {
                seq: 2,
                time_unix_ms: 86_400_000,
                event_type: "run.completed".to_owned(),
                run_id: "run_01".to_owned(),
                turn_id: Some("turn_01".to_owned()),
                payload: json!({ "summary": "done" }),
            },
        ];
        let mut bridge = StdioEventBridge::new(Vec::new());

        let envelopes = bridge
            .emit_events(&events)
            .expect("events should be emitted");

        assert_eq!(envelopes.len(), 2);
        let output = String::from_utf8(bridge.into_inner()).expect("stdio output must be UTF-8");
        let lines = output.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);

        let first: Value = serde_json::from_str(lines[0]).expect("first line should be JSON");
        let second: Value = serde_json::from_str(lines[1]).expect("second line should be JSON");
        assert_eq!(first["jsonrpc"], "2.0");
        assert_eq!(first["method"], "agent.event");
        assert_eq!(first["params"]["seq"], 1);
        assert_eq!(first["params"]["runId"], "run_01");
        assert!(first["params"].get("turnId").is_none());
        assert_eq!(second["params"]["time"], "1970-01-02T00:00:00.000Z");
        assert_eq!(second["params"]["payload"]["summary"], "done");
    }

    #[test]
    fn stdio_bridge_can_stream_turn_loop_events() {
        let event = RunLogEvent {
            seq: 1,
            time_unix_ms: 0,
            event_type: "assistant.delta".to_owned(),
            run_id: "run_01".to_owned(),
            turn_id: Some("turn_01".to_owned()),
            payload: json!({ "text": "hello", "stream": true }),
        };
        let mut bridge = StdioEventBridge::new(Vec::new());

        bridge
            .on_event(&event)
            .expect("turn event should be streamed");

        let output = String::from_utf8(bridge.into_inner()).expect("stdio output must be UTF-8");
        let lines = output.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 1);
        let value: Value = serde_json::from_str(lines[0]).expect("line should be JSON");
        assert_eq!(value["method"], EVENT_METHOD.qualified_name());
        assert_eq!(value["params"]["type"], "assistant.delta");
        assert_eq!(value["params"]["payload"]["text"], "hello");
    }

    #[test]
    fn unix_millis_formatter_handles_leap_day() {
        let formatted =
            format_unix_millis(951_782_400_000).expect("2000-02-29 timestamp should format");

        assert_eq!(formatted, "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn request_loop_initializes_and_accepts_turns() {
        let input = [
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params()
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "id": "turn_1",
                "method": "agent.sendTurn",
                "params": {
                    "runId": "run_rpc",
                    "message": "Read README",
                    "mode": "ask"
                }
            })
            .to_string(),
        ]
        .join("\n");
        let mut output = Vec::new();

        let handler =
            run_stdio_request_loop(Cursor::new(input), &mut output, TestHandler::default())
                .expect("request loop should complete");

        assert_eq!(handler.initialized.len(), 1);
        assert_eq!(handler.send_turns.len(), 1);
        assert_eq!(handler.send_turns[0].message, "Read README");
        let lines = output_lines(output);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["id"], "init_1");
        assert_eq!(lines[0]["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(lines[1]["id"], "turn_1");
        assert_eq!(lines[1]["result"]["accepted"], true);
        assert_eq!(lines[1]["result"]["runId"], "run_rpc");
        assert_eq!(lines[2]["method"], "agent.event");
        assert_eq!(lines[2]["params"]["type"], "run.started");
    }

    #[test]
    fn request_loop_rejects_send_turn_before_initialize() {
        let input = json!({
            "jsonrpc": "2.0",
            "id": "turn_1",
            "method": "agent.sendTurn",
            "params": {
                "message": "hello",
                "mode": "ask"
            }
        })
        .to_string();
        let mut output = Vec::new();

        run_stdio_request_loop(Cursor::new(input), &mut output, TestHandler::default())
            .expect("request loop should write an error response");

        let lines = output_lines(output);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["id"], "turn_1");
        assert_eq!(lines[0]["error"]["code"], JSON_RPC_INVALID_REQUEST);
        assert!(
            lines[0]["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("agent.initialize"))
        );
    }

    #[test]
    fn request_loop_rejects_unsupported_protocol_without_initializing() {
        let input = [
            json!({
                "jsonrpc": "2.0",
                "id": "bad_init",
                "method": "agent.initialize",
                "params": {
                    "protocolVersion": "9.9.9",
                    "client": {
                        "name": "test-client",
                        "version": "0.1.0",
                        "frontend": "cli"
                    },
                    "workspaceRoot": "C:/workspace/project",
                    "workspaceTrusted": true
                }
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "id": "good_init",
                "method": "agent.initialize",
                "params": initialize_params()
            })
            .to_string(),
        ]
        .join("\n");
        let mut output = Vec::new();

        let handler =
            run_stdio_request_loop(Cursor::new(input), &mut output, TestHandler::default())
                .expect("request loop should complete");

        assert_eq!(handler.initialized.len(), 1);
        let lines = output_lines(output);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["error"]["code"], RPC_UNSUPPORTED_PROTOCOL);
        assert_eq!(lines[1]["id"], "good_init");
        assert_eq!(lines[1]["result"]["protocolVersion"], PROTOCOL_VERSION);
    }

    #[test]
    fn request_loop_replays_resume_events_after_response() {
        let input = [
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params()
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "id": "resume_1",
                "method": "agent.resume",
                "params": {
                    "runId": "run_rpc",
                    "replayFromSeq": 2
                }
            })
            .to_string(),
        ]
        .join("\n");
        let mut output = Vec::new();

        let handler =
            run_stdio_request_loop(Cursor::new(input), &mut output, TestHandler::default())
                .expect("request loop should complete");

        assert_eq!(handler.resumes.len(), 1);
        assert_eq!(handler.resumes[0].replay_from_seq, Some(2));
        let lines = output_lines(output);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1]["id"], "resume_1");
        assert_eq!(lines[1]["result"]["nextSeq"], 3);
        assert_eq!(lines[2]["method"], "agent.event");
        assert_eq!(lines[2]["params"]["seq"], 2);
    }

    #[test]
    fn request_loop_lists_run_summaries() {
        let input = [
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params()
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "id": "list_1",
                "method": "agent.listRuns",
                "params": {
                    "limit": 10
                }
            })
            .to_string(),
        ]
        .join("\n");
        let mut output = Vec::new();

        let handler =
            run_stdio_request_loop(Cursor::new(input), &mut output, TestHandler::default())
                .expect("request loop should complete");

        assert_eq!(handler.list_runs.len(), 1);
        assert_eq!(handler.list_runs[0].limit, Some(10));
        let lines = output_lines(output);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["id"], "list_1");
        assert_eq!(lines[1]["result"]["runs"][0]["runId"], "run_rpc");
        assert_eq!(lines[1]["result"]["runs"][0]["title"], "Read README");
        assert_eq!(lines[1]["result"]["runs"][0]["status"], "completed");
        assert_eq!(lines[1]["result"]["runs"][0]["lastSeq"], 3);
        assert_eq!(lines[1]["result"]["runs"][0]["eventCount"], 3);
        assert_eq!(
            lines[1]["result"]["runs"][0]["verificationStatus"],
            "skipped"
        );
    }

    #[test]
    fn request_loop_handles_fim_preview_requests() {
        let input = [
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params()
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "id": "fim_1",
                "method": "agent.previewFim",
                "params": {
                    "prefix": "fn main() {",
                    "suffix": "}",
                    "path": "src/main.rs",
                    "languageId": "rust",
                    "model": "fixture-fim",
                    "maxTokens": 32
                }
            })
            .to_string(),
        ]
        .join("\n");
        let mut output = Vec::new();

        let handler =
            run_stdio_request_loop(Cursor::new(input), &mut output, TestHandler::default())
                .expect("request loop should complete");

        assert_eq!(handler.fim_previews.len(), 1);
        assert_eq!(handler.fim_previews[0].language_id.as_deref(), Some("rust"));
        assert_eq!(handler.fim_previews[0].max_tokens, Some(32));
        let lines = output_lines(output);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["id"], "fim_1");
        assert_eq!(lines[1]["result"]["text"], "fixture completion");
        assert_eq!(lines[1]["result"]["model"], "fixture-fim");
    }

    #[test]
    fn request_loop_dispatches_approval_decisions() {
        let input = [
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params()
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "id": "approve_1",
                "method": "agent.approve",
                "params": {
                    "approvalId": "approval_1",
                    "persist": "session"
                }
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "id": "reject_1",
                "method": "agent.reject",
                "params": {
                    "approvalId": "approval_2",
                    "reason": "not safe"
                }
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "id": "cancel_1",
                "method": "agent.cancel",
                "params": {
                    "runId": "run_rpc",
                    "reason": "user canceled"
                }
            })
            .to_string(),
        ]
        .join("\n");
        let mut output = Vec::new();

        let handler =
            run_stdio_request_loop(Cursor::new(input), &mut output, TestHandler::default())
                .expect("request loop should complete");

        assert_eq!(handler.approvals.len(), 1);
        assert_eq!(handler.approvals[0].approval_id, "approval_1");
        assert_eq!(
            handler.approvals[0].persist,
            Some(RpcApprovalPersistence::Session)
        );
        assert_eq!(handler.rejections.len(), 1);
        assert_eq!(handler.rejections[0].approval_id, "approval_2");
        assert_eq!(handler.cancellations.len(), 1);
        assert_eq!(handler.cancellations[0].run_id, "run_rpc");
        let lines = output_lines(output);
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[1]["id"], "approve_1");
        assert_eq!(lines[1]["result"]["state"], "approved");
        assert_eq!(lines[1]["result"]["persist"], "session");
        assert_eq!(lines[2]["id"], "reject_1");
        assert_eq!(lines[2]["result"]["state"], "rejected");
        assert_eq!(lines[2]["result"]["reason"], "not safe");
        assert_eq!(lines[3]["id"], "cancel_1");
        assert_eq!(lines[3]["result"]["state"], "canceled");
        assert_eq!(lines[3]["result"]["reason"], "user canceled");
    }

    #[test]
    fn request_loop_writes_parse_and_method_errors() {
        let input = [
            "{not json}".to_owned(),
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params()
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "id": "missing_1",
                "method": "agent.missing",
                "params": {}
            })
            .to_string(),
        ]
        .join("\n");
        let mut output = Vec::new();

        run_stdio_request_loop(Cursor::new(input), &mut output, TestHandler::default())
            .expect("request loop should complete after errors");

        let lines = output_lines(output);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["id"], Value::Null);
        assert_eq!(lines[0]["error"]["code"], JSON_RPC_PARSE_ERROR);
        assert_eq!(lines[2]["id"], "missing_1");
        assert_eq!(lines[2]["error"]["code"], JSON_RPC_METHOD_NOT_FOUND);
    }

    #[test]
    fn request_loop_preserves_id_for_invalid_request_errors() {
        let input = json!({
            "jsonrpc": "2.0",
            "id": "bad_request",
            "params": {}
        })
        .to_string();
        let mut output = Vec::new();

        run_stdio_request_loop(Cursor::new(input), &mut output, TestHandler::default())
            .expect("request loop should write an invalid request error");

        let lines = output_lines(output);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["id"], "bad_request");
        assert_eq!(lines[0]["error"]["code"], JSON_RPC_INVALID_REQUEST);
    }

    #[test]
    fn request_loop_does_not_respond_to_notifications() {
        let input = json!({
            "jsonrpc": "2.0",
            "method": "agent.initialize",
            "params": initialize_params()
        })
        .to_string();
        let mut output = Vec::new();

        let handler =
            run_stdio_request_loop(Cursor::new(input), &mut output, TestHandler::default())
                .expect("request loop should ignore notifications");

        assert!(handler.initialized.is_empty());
        assert!(output.is_empty());
    }

    #[test]
    fn turn_loop_rpc_handler_runs_send_turn_and_replays_events() {
        let workspace = TestWorkspace::new("rpc");
        let (input, output, join) =
            spawn_interactive_rpc_loop(AgentTurnLoopRpcHandler::new(final_provider_factory));
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params_for(workspace.path_str())
            }),
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "turn_1",
                "method": "agent.sendTurn",
                "params": {
                    "runId": "run_real_rpc",
                    "message": "Say hello",
                    "mode": "ask"
                }
            }),
        );

        output.wait_for_line(
            |line| {
                line["method"] == "agent.event"
                    && line["params"]["type"] == "run.completed"
                    && line["params"]["runId"] == "run_real_rpc"
            },
            RPC_TEST_TIMEOUT,
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "resume_1",
                "method": "agent.resume",
                "params": {
                    "runId": "run_real_rpc",
                    "replayFromSeq": 1
                }
            }),
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "list_1",
                "method": "agent.listRuns"
            }),
        );
        output.wait_for_line(|line| line["id"] == "list_1", RPC_TEST_TIMEOUT);
        drop(input);
        join.join()
            .expect("request loop thread should not panic")
            .expect("real turn loop handler should complete");

        let lines = output.lines();
        assert_eq!(lines[0]["id"], "init_1");
        assert_eq!(lines[1]["id"], "turn_1");
        assert_eq!(lines[1]["result"]["accepted"], true);
        assert_eq!(lines[1]["result"]["runId"], "run_real_rpc");
        assert_eq!(lines[1]["result"]["turnId"], "turn_1");
        let turn_response_index = line_index(&lines, |line| line["id"] == "turn_1");
        let run_started_index = line_index(&lines, |line| {
            line["method"] == "agent.event" && line["params"]["type"] == "run.started"
        });
        assert!(turn_response_index < run_started_index);
        assert!(lines.iter().any(|line| line["method"] == "agent.event"
            && line["params"]["type"] == "run.completed"
            && line["params"]["payload"]["summary"] == "RPC final answer"));
        assert!(lines.iter().any(|line| {
            line["id"] == "resume_1"
                && line["result"]["nextSeq"]
                    .as_u64()
                    .is_some_and(|seq| seq > 1)
        }));
        let list_response = lines
            .iter()
            .find(|line| line["id"] == "list_1")
            .expect("listRuns response should be present");
        assert_eq!(list_response["result"]["runs"][0]["runId"], "run_real_rpc");
        assert_eq!(list_response["result"]["runs"][0]["title"], "Say hello");
        assert_eq!(list_response["result"]["runs"][0]["status"], "completed");
        assert_eq!(
            list_response["result"]["runs"][0]["summary"],
            "RPC final answer"
        );
        assert!(
            list_response["result"]["runs"][0]["lastSeq"]
                .as_u64()
                .is_some_and(|seq| seq > 1)
        );

        let store = RunLogStore::new(workspace.path()).expect("store should open");
        let events = store
            .load_run("run_real_rpc")
            .expect("real handler should persist run log");
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "run.completed")
        );
    }

    #[test]
    fn request_loop_send_turn_returns_before_provider_completion() {
        let workspace = TestWorkspace::new("rpc");
        let gate = ProviderGate::default();
        let provider_gate = gate.clone();
        let (input, output, join) = spawn_interactive_rpc_loop(AgentTurnLoopRpcHandler::new(
            move |_params: &SendTurnParams| {
                Ok(GatedFinalProvider {
                    gate: provider_gate.clone(),
                })
            },
        ));
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params_for(workspace.path_str())
            }),
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "turn_1",
                "method": "agent.sendTurn",
                "params": {
                    "runId": "run_rpc_early_accept",
                    "message": "Wait for provider",
                    "mode": "ask"
                }
            }),
        );

        output.wait_for_line(|line| line["id"] == "turn_1", RPC_TEST_TIMEOUT);
        assert!(
            !output.lines().iter().any(|line| {
                line["method"] == "agent.event" && line["params"]["type"] == "run.completed"
            }),
            "sendTurn response must be written before the blocked provider completes"
        );

        gate.release();
        output.wait_for_line(
            |line| {
                line["method"] == "agent.event"
                    && line["params"]["type"] == "run.completed"
                    && line["params"]["runId"] == "run_rpc_early_accept"
            },
            RPC_TEST_TIMEOUT,
        );
        drop(input);
        join.join()
            .expect("request loop thread should not panic")
            .expect("real turn loop handler should complete");
    }

    #[test]
    fn turn_loop_rpc_handler_waits_for_approval_and_applies_after_approve() {
        let workspace = TestWorkspace::new("rpc");
        workspace.write("README.md", "old\n");
        let (input, output, join) =
            spawn_interactive_rpc_loop(AgentTurnLoopRpcHandler::new(patch_provider_factory));
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params_for(workspace.path_str())
            }),
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "turn_1",
                "method": "agent.sendTurn",
                "params": {
                    "runId": "run_rpc_approval",
                    "message": "Update README",
                    "mode": "edit"
                }
            }),
        );
        output.wait_for_line(
            |line| {
                line["method"] == "agent.event"
                    && line["params"]["type"] == "tool.approvalRequired"
                    && line["params"]["runId"] == "run_rpc_approval"
            },
            RPC_TEST_TIMEOUT,
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "approve_1",
                "method": "agent.approve",
                "params": {
                    "approvalId": "approval_1_1",
                    "persist": "session"
                }
            }),
        );
        output.wait_for_line(
            |line| {
                line["method"] == "agent.event"
                    && line["params"]["type"] == "run.completed"
                    && line["params"]["runId"] == "run_rpc_approval"
            },
            RPC_TEST_TIMEOUT,
        );
        drop(input);
        join.join()
            .expect("request loop thread should not panic")
            .expect("real turn loop handler should complete after approval");

        assert_eq!(workspace.read("README.md"), "new\n");
        let lines = output.lines();
        let approval_required_index = line_index(&lines, |line| {
            line["method"] == "agent.event" && line["params"]["type"] == "tool.approvalRequired"
        });
        let approve_response_index = line_index(&lines, |line| line["id"] == "approve_1");
        let approval_resolved_index = line_index(&lines, |line| {
            line["method"] == "agent.event"
                && line["params"]["type"] == "tool.approvalResolved"
                && line["params"]["payload"]["decision"] == "approved"
        });

        assert!(approval_required_index < approve_response_index);
        assert!(approve_response_index < approval_resolved_index);
        let approval_payload = &lines[approval_required_index]["params"]["payload"];
        assert_eq!(approval_payload["approvalId"], "approval_1_1");
        assert_eq!(approval_payload["toolCallId"], "call_patch");
        assert_eq!(approval_payload["toolName"], "apply_patch");
        assert_eq!(approval_payload["risk"], "write");
        assert_eq!(approval_payload["paths"], json!(["README.md"]));
        assert_eq!(approval_payload["persistable"], true);
        assert_eq!(lines[1]["id"], "turn_1");
        assert_eq!(lines[1]["result"]["accepted"], true);
        assert!(1 < approval_required_index);
        assert_eq!(lines[approve_response_index]["result"]["state"], "approved");
        assert_eq!(
            lines[approve_response_index]["result"]["persist"],
            "session"
        );
        assert!(lines.iter().any(|line| {
            line["method"] == "agent.event"
                && line["params"]["type"] == "run.completed"
                && line["params"]["payload"]["changedFiles"] == json!(["README.md"])
        }));
    }

    #[test]
    fn turn_loop_rpc_handler_rejects_pending_approval_without_running_tool() {
        let workspace = TestWorkspace::new("rpc");
        workspace.write("README.md", "old\n");
        let (input, output, join) =
            spawn_interactive_rpc_loop(AgentTurnLoopRpcHandler::new(patch_provider_factory));
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params_for(workspace.path_str())
            }),
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "turn_1",
                "method": "agent.sendTurn",
                "params": {
                    "runId": "run_rpc_rejected_approval",
                    "message": "Update README",
                    "mode": "edit"
                }
            }),
        );
        output.wait_for_line(
            |line| {
                line["method"] == "agent.event"
                    && line["params"]["type"] == "tool.approvalRequired"
                    && line["params"]["runId"] == "run_rpc_rejected_approval"
            },
            RPC_TEST_TIMEOUT,
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "reject_1",
                "method": "agent.reject",
                "params": {
                    "approvalId": "approval_1_1",
                    "reason": "not now"
                }
            }),
        );
        output.wait_for_line(
            |line| {
                line["method"] == "agent.event"
                    && line["params"]["type"] == "run.failed"
                    && line["params"]["runId"] == "run_rpc_rejected_approval"
            },
            RPC_TEST_TIMEOUT,
        );
        drop(input);
        join.join()
            .expect("request loop thread should not panic")
            .expect("real turn loop handler should complete after rejection");

        assert_eq!(workspace.read("README.md"), "old\n");
        let lines = output.lines();
        let reject_response_index = line_index(&lines, |line| line["id"] == "reject_1");
        assert_eq!(lines[reject_response_index]["result"]["state"], "rejected");
        assert_eq!(lines[reject_response_index]["result"]["reason"], "not now");
        assert!(lines.iter().any(|line| {
            line["method"] == "agent.event"
                && line["params"]["type"] == "tool.approvalResolved"
                && line["params"]["payload"]["decision"] == "rejected"
        }));
        assert!(lines.iter().any(|line| {
            line["method"] == "agent.event" && line["params"]["type"] == "run.failed"
        }));
        assert!(!lines.iter().any(|line| {
            line["method"] == "agent.event" && line["params"]["type"] == "tool.started"
        }));
    }

    #[test]
    fn turn_loop_rpc_handler_cancels_pending_approval_without_running_tool() {
        let workspace = TestWorkspace::new("rpc");
        workspace.write("README.md", "old\n");
        let (input, output, join) =
            spawn_interactive_rpc_loop(AgentTurnLoopRpcHandler::new(patch_provider_factory));
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params_for(workspace.path_str())
            }),
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "turn_1",
                "method": "agent.sendTurn",
                "params": {
                    "runId": "run_rpc_canceled_approval",
                    "message": "Update README",
                    "mode": "edit"
                }
            }),
        );
        output.wait_for_line(
            |line| {
                line["method"] == "agent.event"
                    && line["params"]["type"] == "tool.approvalRequired"
                    && line["params"]["runId"] == "run_rpc_canceled_approval"
            },
            RPC_TEST_TIMEOUT,
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "cancel_1",
                "method": "agent.cancel",
                "params": {
                    "runId": "run_rpc_canceled_approval",
                    "reason": "user changed their mind"
                }
            }),
        );
        output.wait_for_line(
            |line| {
                line["method"] == "agent.event"
                    && line["params"]["type"] == "run.canceled"
                    && line["params"]["runId"] == "run_rpc_canceled_approval"
            },
            RPC_TEST_TIMEOUT,
        );
        drop(input);
        join.join()
            .expect("request loop thread should not panic")
            .expect("real turn loop handler should complete after cancellation");

        assert_eq!(workspace.read("README.md"), "old\n");
        let lines = output.lines();
        let events = agent_event_values(&lines);
        let cancel_response_index = line_index(&lines, |line| line["id"] == "cancel_1");
        assert_eq!(lines[cancel_response_index]["result"]["state"], "canceled");
        assert_eq!(
            lines[cancel_response_index]["result"]["reason"],
            "user changed their mind"
        );
        assert!(events.iter().any(|event| {
            event["type"] == "tool.approvalResolved" && event["payload"]["decision"] == "canceled"
        }));
        assert!(events.iter().any(|event| {
            event["type"] == "run.canceled" && event["payload"]["code"] == "E_APPROVAL_CANCELED"
        }));
        assert!(!events.iter().any(|event| event["type"] == "tool.started"));
    }

    #[test]
    fn turn_loop_rpc_handler_cancels_provider_with_signal() {
        let workspace = TestWorkspace::new("rpc");
        let store = RunLogStore::new(workspace.path()).expect("store should open");
        let run_log = store
            .create_run("run_rpc_provider_cancel")
            .expect("run should be created");
        let active_run = spawn_active_run(ActiveRunSpawn {
            run_id: "run_rpc_provider_cancel".to_owned(),
            workspace_root: workspace.path().to_path_buf(),
            provider: WaitingForCancellationProvider,
            run_log,
            input: AgentTurnInput::new("turn_1", "Wait for cancellation"),
            config: AgentTurnLoopConfig::default(),
            approval_queue: RpcApprovalQueue::default(),
            live_events: None,
        })
        .expect("active run should spawn");
        let mut handler = AgentTurnLoopRpcHandler::new(final_provider_factory);
        handler.workspace = Some(RpcWorkspace { store });
        handler.active_run = Some(active_run);

        let output = handler
            .cancel(CancelParams {
                run_id: "run_rpc_provider_cancel".to_owned(),
                reason: Some("client canceled provider".to_owned()),
            })
            .expect("cancel should signal provider");

        assert_eq!(output.result.state, RpcRunState::Canceled);
        assert_eq!(
            output.result.reason.as_deref(),
            Some("client canceled provider")
        );
        assert!(output.events.iter().any(|event| {
            event.event_type == "run.canceled"
                && event.payload["code"] == "E_RUN_CANCELED"
                && event.payload["reason"] == "client canceled provider"
        }));
        assert!(
            handler.active_run.is_none(),
            "provider cancellation should finish active run"
        );
    }

    #[test]
    fn request_loop_rejects_concurrent_turn_and_cancels_pending_approval_on_eof() {
        let workspace = TestWorkspace::new("rpc");
        workspace.write("README.md", "old\n");
        let (input, output, join) =
            spawn_interactive_rpc_loop(AgentTurnLoopRpcHandler::new(patch_provider_factory));
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "init_1",
                "method": "agent.initialize",
                "params": initialize_params_for(workspace.path_str())
            }),
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "turn_1",
                "method": "agent.sendTurn",
                "params": {
                    "runId": "run_rpc_active_disconnect",
                    "message": "Update README and wait for approval",
                    "mode": "edit"
                }
            }),
        );
        output.wait_for_line(
            |line| {
                line["method"] == "agent.event"
                    && line["params"]["type"] == "tool.approvalRequired"
                    && line["params"]["runId"] == "run_rpc_active_disconnect"
            },
            RPC_TEST_TIMEOUT,
        );
        send_rpc_line(
            &input,
            json!({
                "jsonrpc": "2.0",
                "id": "turn_2",
                "method": "agent.sendTurn",
                "params": {
                    "runId": "run_rpc_second",
                    "message": "This turn must be rejected while the first run is active",
                    "mode": "ask"
                }
            }),
        );
        output.wait_for_line(|line| line["id"] == "turn_2", RPC_TEST_TIMEOUT);
        drop(input);

        let handler = join
            .join()
            .expect("request loop thread should not panic")
            .expect("request loop should cancel the active run after EOF");

        assert!(
            handler.active_run.is_none(),
            "EOF shutdown should finish the active run"
        );
        let lines = output.lines();
        let events = agent_event_values(&lines);
        let first_turn_response_index = line_index(&lines, |line| line["id"] == "turn_1");
        assert_eq!(
            lines[first_turn_response_index]["result"]["runId"],
            "run_rpc_active_disconnect"
        );

        let second_turn_error_index = line_index(&lines, |line| line["id"] == "turn_2");
        assert_eq!(
            lines[second_turn_error_index]["error"]["code"],
            RPC_RUN_ALREADY_ACTIVE
        );
        assert!(events.iter().any(|event| {
            event["type"] == "tool.approvalResolved"
                && event["runId"] == "run_rpc_active_disconnect"
                && event["payload"]["decision"] == "canceled"
                && event["payload"]["reason"] == "RPC client disconnected"
        }));
        assert!(events.iter().any(|event| {
            event["type"] == "run.canceled"
                && event["runId"] == "run_rpc_active_disconnect"
                && event["payload"]["code"] == "E_APPROVAL_CANCELED"
        }));
    }

    #[test]
    fn turn_loop_rpc_handler_expires_pending_approval_without_running_tool() {
        let workspace = TestWorkspace::new("rpc");
        workspace.write("README.md", "old\n");
        let mut handler = AgentTurnLoopRpcHandler::new(patch_provider_factory)
            .with_approval_timeout(Duration::from_millis(20));
        handler
            .initialize(
                serde_json::from_value(initialize_params_for(workspace.path_str()))
                    .expect("initialize params should deserialize"),
            )
            .expect("handler should initialize");

        let send_output = handler
            .send_turn(SendTurnParams {
                run_id: Some("run_rpc_expired_approval".to_owned()),
                message: "Update README".to_owned(),
                mode: super::RpcRunMode::Edit,
                attachments: Vec::new(),
            })
            .expect("sendTurn should pause for approval");
        assert!(send_output.events.iter().any(|event| {
            event.event_type == "tool.approvalRequired"
                && event.payload["approvalId"] == "approval_1_1"
        }));

        let resume_output = (0..50)
            .find_map(|_| {
                let output = handler
                    .resume(ResumeParams {
                        run_id: "run_rpc_expired_approval".to_owned(),
                        replay_from_seq: None,
                    })
                    .expect("resume should load run log");
                if output
                    .events
                    .iter()
                    .any(|event| event.event_type == "run.canceled")
                {
                    Some(output)
                } else {
                    thread::sleep(Duration::from_millis(20));
                    None
                }
            })
            .expect("approval should expire and cancel the run");

        assert_eq!(workspace.read("README.md"), "old\n");
        assert!(resume_output.events.iter().any(|event| {
            event.event_type == "tool.approvalResolved"
                && event.payload["decision"] == "expired"
                && event.payload["approvalId"] == "approval_1_1"
        }));
        assert!(resume_output.events.iter().any(|event| {
            event.event_type == "run.canceled" && event.payload["code"] == "E_APPROVAL_EXPIRED"
        }));
        assert!(
            !resume_output
                .events
                .iter()
                .any(|event| event.event_type == "tool.started")
        );
    }

    #[test]
    fn turn_loop_rpc_handler_accepts_file_attachments_and_rejects_missing_approval() {
        let workspace = TestWorkspace::new("rpc");
        workspace.write("README.md", "attached README\n");
        let mut handler = AgentTurnLoopRpcHandler::new(final_provider_factory);
        handler
            .initialize(
                serde_json::from_value(initialize_params_for(workspace.path_str()))
                    .expect("initialize params should deserialize"),
            )
            .expect("handler should initialize");

        let send_output = handler
            .send_turn(SendTurnParams {
                run_id: Some("run_with_attachment".to_owned()),
                message: "Read attached file".to_owned(),
                mode: super::RpcRunMode::Ask,
                attachments: vec![super::TurnAttachment {
                    kind: super::TurnAttachmentKind::File,
                    path: Some("README.md".to_owned()),
                    range: None,
                    text: None,
                }],
            })
            .expect("file attachments should be accepted");
        let context_built = send_output
            .events
            .iter()
            .find(|event| event.event_type == "context.built")
            .expect("context.built should be emitted");
        assert!(
            context_built.payload["includedSources"]
                .as_array()
                .expect("includedSources should be an array")
                .iter()
                .any(|source| {
                    source["kind"] == json!("file") && source["path"] == json!("README.md")
                })
        );

        let approval_error = handler
            .approve(ApproveParams {
                approval_id: "approval_missing".to_owned(),
                persist: None,
                hunks: None,
            })
            .expect_err("missing approval should be rejected");
        assert_eq!(approval_error.code, RPC_APPROVAL_NOT_FOUND);
    }

    #[test]
    fn approval_queue_reuses_session_persistent_approval() {
        let queue = RpcApprovalQueue::new(Duration::from_secs(60));
        let first = sample_turn_approval_request("approval_1", RiskLevel::Exec, true);
        queue
            .register("run_1".to_owned(), first.clone())
            .expect("approval should register");
        queue
            .approve("approval_1", RpcApprovalPersistence::Session, None)
            .expect("session approval should resolve");
        assert_eq!(
            queue
                .wait_for_decision(&first)
                .expect("first approval should resolve"),
            ApprovalDecision::Approved
        );

        let second = sample_turn_approval_request("approval_2", RiskLevel::Exec, true);
        queue
            .register("run_2".to_owned(), second.clone())
            .expect("second approval should register");
        assert_eq!(
            queue
                .wait_for_decision(&second)
                .expect("second approval should be auto-approved"),
            ApprovalDecision::Approved
        );
    }

    #[test]
    fn approval_queue_reuses_workspace_persistent_approval_after_reload() {
        let workspace = TestWorkspace::new("rpc-approval-persistence");
        let queue = RpcApprovalQueue::new(Duration::from_secs(60));
        queue
            .configure_workspace_persistence(workspace.path())
            .expect("workspace persistence should configure");
        let first = sample_turn_approval_request("approval_1", RiskLevel::Exec, true);
        queue
            .register("run_1".to_owned(), first.clone())
            .expect("approval should register");
        queue
            .approve("approval_1", RpcApprovalPersistence::Workspace, None)
            .expect("workspace approval should resolve");
        assert_eq!(
            queue
                .wait_for_decision(&first)
                .expect("first approval should resolve"),
            ApprovalDecision::Approved
        );

        let reloaded = RpcApprovalQueue::new(Duration::from_secs(60));
        reloaded
            .configure_workspace_persistence(workspace.path())
            .expect("workspace persistence should reload");
        let second = sample_turn_approval_request("approval_2", RiskLevel::Exec, true);
        reloaded
            .register("run_2".to_owned(), second.clone())
            .expect("second approval should register");
        assert_eq!(
            reloaded
                .wait_for_decision(&second)
                .expect("workspace approval should be auto-approved"),
            ApprovalDecision::Approved
        );
    }

    #[test]
    fn approval_queue_rejects_persistence_for_network_and_destructive_risks() {
        for risk in [RiskLevel::Network, RiskLevel::Destructive] {
            let queue = RpcApprovalQueue::new(Duration::from_secs(60));
            let request = sample_turn_approval_request("approval_1", risk, true);
            queue
                .register("run_1".to_owned(), request)
                .expect("approval should register");
            let error = queue
                .approve("approval_1", RpcApprovalPersistence::Session, None)
                .expect_err("high-risk approvals must not be persisted");

            assert_eq!(error.code, RPC_APPROVAL_DENIED);
        }
    }

    #[test]
    fn approval_queue_resolves_hunk_level_patch_decisions() {
        let queue = RpcApprovalQueue::new(Duration::from_secs(60));
        let request = sample_patch_turn_approval_request("approval_1");
        queue
            .register("run_1".to_owned(), request.clone())
            .expect("approval should register");
        queue
            .approve(
                "approval_1",
                RpcApprovalPersistence::Never,
                Some(RpcApprovedHunks {
                    approved: vec!["README.md#2:old5+2:new5+3".to_owned()],
                }),
            )
            .expect("hunk approval should resolve");

        assert_eq!(
            queue
                .wait_for_decision(&request)
                .expect("hunk approval should be returned"),
            ApprovalDecision::ApprovedHunks {
                hunk_ids: vec!["README.md#2:old5+2:new5+3".to_owned()]
            }
        );
    }

    #[test]
    fn approval_queue_rejects_hunk_decisions_for_non_patch_approvals() {
        let queue = RpcApprovalQueue::new(Duration::from_secs(60));
        let request = sample_turn_approval_request("approval_1", RiskLevel::Exec, true);
        queue
            .register("run_1".to_owned(), request)
            .expect("approval should register");

        let error = queue
            .approve(
                "approval_1",
                RpcApprovalPersistence::Never,
                Some(RpcApprovedHunks {
                    approved: vec!["README.md#1:old1+1:new1+1".to_owned()],
                }),
            )
            .expect_err("non-patch hunk approvals should be rejected");

        assert_eq!(error.code, RPC_APPROVAL_DENIED);
    }

    #[test]
    fn approval_request_from_event_uses_typed_payload_schema() {
        let event = run_log_event(
            1,
            "tool.approvalRequired",
            "run_rpc",
            Some("turn_1"),
            json!({
                "approvalId": "approval_1_1",
                "toolCallId": "call_patch",
                "toolName": "apply_patch",
                "risk": "write",
                "title": "Apply patch",
                "detail": "Modify README.md",
                "cwd": ".",
                "outputSummary": "previous command output summary",
                "paths": ["README.md"],
                "riskReasons": ["file deletion"],
                "persistable": true
            }),
        );

        let request =
            super::approval_request_from_event(&event).expect("approval payload should parse");

        assert_eq!(request.approval_id, "approval_1_1");
        assert_eq!(request.tool_call_id, "call_patch");
        assert_eq!(request.tool_name, "apply_patch");
        assert_eq!(
            request.risk,
            prole_coder_agent_core::approval::RiskLevel::Write
        );
        assert_eq!(request.paths, Some(vec!["README.md".to_owned()]));
        assert_eq!(request.cwd, Some(".".to_owned()));
        assert_eq!(
            request.output_summary,
            Some("previous command output summary".to_owned())
        );
        assert_eq!(request.risk_reasons, vec!["file deletion".to_owned()]);
        assert!(request.persistable);
    }

    #[test]
    fn approval_request_from_event_rejects_malformed_payload() {
        let event = run_log_event(
            1,
            "tool.approvalRequired",
            "run_rpc",
            Some("turn_1"),
            json!({
                "approvalId": "approval_1_1",
                "toolCallId": "call_patch",
                "toolName": "apply_patch",
                "risk": "write",
                "title": "Apply patch",
                "detail": "Modify README.md"
            }),
        );

        let error = super::approval_request_from_event(&event)
            .expect_err("missing persistable should reject the payload");

        assert_eq!(error.code, RPC_INTERNAL_INVARIANT);
    }

    fn sample_turn_approval_request(
        approval_id: &str,
        risk: RiskLevel,
        persistable: bool,
    ) -> TurnApprovalRequest {
        TurnApprovalRequest {
            approval_id: approval_id.to_owned(),
            tool_call_id: "call_shell".to_owned(),
            tool_name: "shell".to_owned(),
            risk,
            title: "Run shell command".to_owned(),
            detail: "Execute cargo test".to_owned(),
            command: Some("cargo test".to_owned()),
            cwd: Some(".".to_owned()),
            output_summary: None,
            paths: None,
            hunks: None,
            risk_reasons: Vec::new(),
            persistable,
        }
    }

    fn sample_patch_turn_approval_request(approval_id: &str) -> TurnApprovalRequest {
        TurnApprovalRequest {
            approval_id: approval_id.to_owned(),
            tool_call_id: "call_patch".to_owned(),
            tool_name: "apply_patch".to_owned(),
            risk: RiskLevel::Write,
            title: "Apply patch".to_owned(),
            detail: "Modify README.md".to_owned(),
            command: None,
            cwd: None,
            output_summary: None,
            paths: Some(vec!["README.md".to_owned()]),
            hunks: Some(vec![
                prole_coder_agent_core::tool_execution::PatchApprovalHunk {
                    id: "README.md#1:old1+3:new1+3".to_owned(),
                    file_path: "README.md".to_owned(),
                    file_index: 0,
                    hunk_index: 0,
                    old_start: 1,
                    old_count: 3,
                    new_start: 1,
                    new_count: 3,
                    section: None,
                },
                prole_coder_agent_core::tool_execution::PatchApprovalHunk {
                    id: "README.md#2:old5+2:new5+3".to_owned(),
                    file_path: "README.md".to_owned(),
                    file_index: 0,
                    hunk_index: 1,
                    old_start: 5,
                    old_count: 2,
                    new_start: 5,
                    new_count: 3,
                    section: Some("next block".to_owned()),
                },
            ]),
            risk_reasons: Vec::new(),
            persistable: true,
        }
    }

    fn initialize_params() -> Value {
        initialize_params_for("C:/workspace/project")
    }

    fn initialize_params_for(workspace_root: &str) -> Value {
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "client": {
                "name": "test-client",
                "version": "0.1.0",
                "frontend": "cli"
            },
            "workspaceRoot": workspace_root,
            "workspaceTrusted": true
        })
    }

    fn output_lines(output: Vec<u8>) -> Vec<Value> {
        String::from_utf8(output)
            .expect("output should be UTF-8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("line should be JSON"))
            .collect()
    }

    // Extracts event envelopes from single-event and batch wire formats for assertions.
    // Batch metadata is validated by dedicated batch tests, not by this helper.
    fn agent_event_values(lines: &[Value]) -> Vec<Value> {
        let mut events = Vec::new();
        for line in lines {
            if line["method"] == "agent.event" {
                events.push(line["params"].clone());
            } else if line["method"] == "agent.eventBatch"
                && let Some(batch_events) = line["params"]["events"].as_array()
            {
                events.extend(batch_events.iter().cloned());
            }
        }
        events
    }

    fn line_index(lines: &[Value], predicate: impl Fn(&Value) -> bool) -> usize {
        lines
            .iter()
            .position(predicate)
            .expect("expected output line should exist")
    }

    fn spawn_interactive_rpc_loop<H>(
        handler: H,
    ) -> (
        mpsc::Sender<String>,
        SharedOutput,
        thread::JoinHandle<Result<H, AgentRpcError>>,
    )
    where
        H: AgentRpcRequestHandler + Send + 'static,
    {
        let (input_tx, input_rx) = mpsc::channel();
        let reader = io::BufReader::new(ChannelReader::new(input_rx));
        let output = SharedOutput::default();
        let mut writer = output.clone();
        let join = thread::spawn(move || run_stdio_request_loop(reader, &mut writer, handler));
        (input_tx, output, join)
    }

    fn send_rpc_line(input: &mpsc::Sender<String>, message: Value) {
        input
            .send(format!("{message}\n"))
            .expect("request loop input should be open");
    }

    fn complete_output_lines(output: &[u8]) -> Vec<Value> {
        let output = std::str::from_utf8(output).expect("output should be UTF-8");
        output
            .split_inclusive('\n')
            .filter_map(|line| line.strip_suffix('\n'))
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).expect("line should be JSON"))
            .collect()
    }

    struct ChannelReader {
        input: mpsc::Receiver<String>,
        pending: Cursor<Vec<u8>>,
    }

    impl ChannelReader {
        fn new(input: mpsc::Receiver<String>) -> Self {
            Self {
                input,
                pending: Cursor::new(Vec::new()),
            }
        }
    }

    impl Read for ChannelReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            loop {
                let read = self.pending.read(buf)?;
                if read > 0 {
                    return Ok(read);
                }

                match self.input.recv() {
                    Ok(line) => {
                        self.pending = Cursor::new(line.into_bytes());
                    }
                    Err(_) => return Ok(0),
                }
            }
        }
    }

    #[derive(Clone, Default)]
    struct SharedOutput {
        inner: Arc<(Mutex<Vec<u8>>, Condvar)>,
    }

    impl SharedOutput {
        fn lines(&self) -> Vec<Value> {
            let output = self
                .inner
                .0
                .lock()
                .expect("shared output lock should not be poisoned")
                .clone();
            output_lines(output)
        }

        fn wait_for_line(&self, predicate: impl Fn(&Value) -> bool, timeout: Duration) -> Value {
            let deadline = Instant::now()
                .checked_add(timeout)
                .expect("timeout deadline should be representable");
            let (output, changed) = &*self.inner;
            let mut output = output
                .lock()
                .expect("shared output lock should not be poisoned");

            loop {
                let lines = complete_output_lines(&output);
                if let Some(line) = lines.iter().find(|line| predicate(line)) {
                    return line.clone();
                }

                let now = Instant::now();
                if now >= deadline {
                    panic!(
                        "timed out waiting for RPC output line; output so far: {}",
                        String::from_utf8_lossy(&output)
                    );
                }

                let remaining = deadline.saturating_duration_since(now);
                let wait_result = changed
                    .wait_timeout(output, remaining)
                    .expect("shared output lock should not be poisoned");
                output = wait_result.0;
            }
        }
    }

    impl Write for SharedOutput {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let (output, changed) = &*self.inner;
            let mut output = output
                .lock()
                .expect("shared output lock should not be poisoned");
            output.extend_from_slice(buf);
            changed.notify_all();
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct TestHandler {
        initialized: Vec<AgentInitializeParams>,
        send_turns: Vec<SendTurnParams>,
        approvals: Vec<ApproveParams>,
        rejections: Vec<RejectParams>,
        cancellations: Vec<CancelParams>,
        resumes: Vec<ResumeParams>,
        list_runs: Vec<ListRunsParams>,
        fim_previews: Vec<FimPreviewParams>,
    }

    impl AgentRpcRequestHandler for TestHandler {
        fn initialize(
            &mut self,
            params: AgentInitializeParams,
        ) -> Result<AgentInitializeResult, AgentRpcHandlerError> {
            self.initialized.push(params);
            Ok(AgentInitializeResult::default())
        }

        fn send_turn(
            &mut self,
            params: SendTurnParams,
        ) -> Result<AgentRpcHandlerOutput<SendTurnResult>, AgentRpcHandlerError> {
            let run_id = params
                .run_id
                .clone()
                .unwrap_or_else(|| "run_rpc".to_owned());
            self.send_turns.push(params);
            Ok(AgentRpcHandlerOutput::new(SendTurnResult {
                run_id: run_id.clone(),
                turn_id: "turn_rpc".to_owned(),
                accepted: true,
            })
            .with_events(vec![run_log_event(
                1,
                "run.started",
                &run_id,
                None,
                json!({ "mode": "ask" }),
            )]))
        }

        fn approve(
            &mut self,
            params: ApproveParams,
        ) -> Result<AgentRpcHandlerOutput<ApproveResult>, AgentRpcHandlerError> {
            self.approvals.push(params.clone());
            Ok(AgentRpcHandlerOutput::new(ApproveResult {
                approval_id: params.approval_id,
                state: RpcApprovalState::Approved,
                persist: params.persist.unwrap_or(RpcApprovalPersistence::Never),
                hunks: params.hunks,
            }))
        }

        fn reject(
            &mut self,
            params: RejectParams,
        ) -> Result<AgentRpcHandlerOutput<RejectResult>, AgentRpcHandlerError> {
            self.rejections.push(params.clone());
            Ok(AgentRpcHandlerOutput::new(RejectResult {
                approval_id: params.approval_id,
                state: RpcApprovalState::Rejected,
                reason: params.reason,
            }))
        }

        fn cancel(
            &mut self,
            params: CancelParams,
        ) -> Result<AgentRpcHandlerOutput<CancelResult>, AgentRpcHandlerError> {
            self.cancellations.push(params.clone());
            Ok(AgentRpcHandlerOutput::new(CancelResult {
                run_id: params.run_id,
                state: RpcRunState::Canceled,
                reason: params.reason,
            }))
        }

        fn resume(
            &mut self,
            params: ResumeParams,
        ) -> Result<AgentRpcHandlerOutput<ResumeResult>, AgentRpcHandlerError> {
            let run_id = params.run_id.clone();
            self.resumes.push(params);
            Ok(AgentRpcHandlerOutput::new(ResumeResult {
                run_id: run_id.clone(),
                next_seq: 3,
                replay_started: true,
            })
            .with_events(vec![run_log_event(
                2,
                "assistant.delta",
                &run_id,
                Some("turn_rpc"),
                json!({ "text": "hello", "stream": true }),
            )]))
        }

        fn list_runs(
            &mut self,
            params: ListRunsParams,
        ) -> Result<AgentRpcHandlerOutput<ListRunsResult>, AgentRpcHandlerError> {
            self.list_runs.push(params);
            Ok(AgentRpcHandlerOutput::new(ListRunsResult {
                runs: vec![RpcRunSummary {
                    run_id: "run_rpc".to_owned(),
                    title: "Read README".to_owned(),
                    status: RpcRunSummaryStatus::Completed,
                    started_at: "1970-01-01T00:00:00.000Z".to_owned(),
                    updated_at: "1970-01-01T00:00:01.000Z".to_owned(),
                    completed_at: Some("1970-01-01T00:00:01.000Z".to_owned()),
                    last_seq: 3,
                    event_count: 3,
                    mode: Some("ask".to_owned()),
                    summary: Some("Done".to_owned()),
                    changed_files: Vec::new(),
                    verification_status: Some("skipped".to_owned()),
                }],
            }))
        }

        fn preview_fim(
            &mut self,
            params: FimPreviewParams,
        ) -> Result<AgentRpcHandlerOutput<FimPreviewResult>, AgentRpcHandlerError> {
            self.fim_previews.push(params);
            Ok(AgentRpcHandlerOutput::new(FimPreviewResult {
                text: "fixture completion".to_owned(),
                model: "fixture-fim".to_owned(),
                finish_reason: Some("stop".to_owned()),
            }))
        }
    }

    fn run_log_event(
        seq: u64,
        event_type: &str,
        run_id: &str,
        turn_id: Option<&str>,
        payload: Value,
    ) -> RunLogEvent {
        RunLogEvent {
            seq,
            time_unix_ms: 0,
            event_type: event_type.to_owned(),
            run_id: run_id.to_owned(),
            turn_id: turn_id.map(str::to_owned),
            payload,
        }
    }

    fn final_provider_factory(
        _params: &SendTurnParams,
    ) -> Result<ScriptedProvider, AgentRpcHandlerError> {
        Ok(ScriptedProvider::new(vec![
            TurnProviderResponse::final_text("RPC final answer"),
        ]))
    }

    fn patch_provider_factory(
        _params: &SendTurnParams,
    ) -> Result<ScriptedProvider, AgentRpcHandlerError> {
        let patch = concat!(
            "--- a/README.md\n",
            "+++ b/README.md\n",
            "@@ -1 +1 @@\n",
            "-old\n",
            "+new\n"
        );
        Ok(ScriptedProvider::new(vec![
            TurnProviderResponse::tool_calls(
                None,
                Some("I should edit the README.".to_owned()),
                vec![ChatToolCall::function(
                    "call_patch",
                    "apply_patch",
                    json!({
                        "unifiedDiff": patch,
                        "expectedFiles": ["README.md"],
                    })
                    .to_string(),
                )],
            ),
            TurnProviderResponse::final_text("Patch approved and applied."),
        ]))
    }

    struct ScriptedProvider {
        responses: VecDeque<TurnProviderResponse>,
    }

    impl ScriptedProvider {
        fn new(responses: Vec<TurnProviderResponse>) -> Self {
            Self {
                responses: responses.into(),
            }
        }
    }

    impl TurnProvider for ScriptedProvider {
        fn complete_stream(&mut self, _request: TurnProviderRequest) -> TurnProviderFuture<'_> {
            Box::pin(async move {
                let response = self
                    .responses
                    .pop_front()
                    .ok_or_else(|| TurnProviderError::new("scripted provider has no response"))?;
                Ok(turn_provider_response_stream(response))
            })
        }
    }

    #[derive(Clone, Default)]
    struct ProviderGate {
        inner: Arc<(Mutex<bool>, Condvar)>,
    }

    impl ProviderGate {
        fn wait(&self) {
            let (released, changed) = &*self.inner;
            let mut released = released
                .lock()
                .expect("provider gate lock should not be poisoned");
            while !*released {
                released = changed
                    .wait(released)
                    .expect("provider gate lock should not be poisoned");
            }
        }

        fn release(&self) {
            let (released, changed) = &*self.inner;
            let mut released = released
                .lock()
                .expect("provider gate lock should not be poisoned");
            *released = true;
            changed.notify_all();
        }
    }

    struct GatedFinalProvider {
        gate: ProviderGate,
    }

    impl TurnProvider for GatedFinalProvider {
        fn complete_stream(&mut self, _request: TurnProviderRequest) -> TurnProviderFuture<'_> {
            Box::pin(async move {
                self.gate.wait();
                Ok(turn_provider_response_stream(
                    TurnProviderResponse::final_text("provider was released"),
                ))
            })
        }
    }

    struct WaitingForCancellationProvider;

    impl TurnProvider for WaitingForCancellationProvider {
        fn complete_stream(&mut self, request: TurnProviderRequest) -> TurnProviderFuture<'_> {
            Box::pin(async move {
                while !request.cancellation_token.is_canceled() {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(TurnProviderError::new(
                    request.cancellation_token.cancellation_reason(),
                ))
            })
        }
    }
}
