use std::{collections::HashSet, future::Future, path::Path, pin::Pin, time::Instant};

use futures_util::{Stream, StreamExt};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};
use thiserror::Error;

use crate::{
    approval::{ApprovalRequirement, RiskLevel},
    cancellation::{CancellationError, CancellationToken},
    command_risk::classify_shell_command,
    context::{
        ContextBuildError, ContextBuilder, ContextBuilderConfig, ContextItem, ContextItemKind,
        ContextManifestOmitted, ContextManifestReport,
    },
    provider::deepseek_api::{ChatMessage, ChatToolCall},
    reasoning::{
        ReasoningContentError, ReasoningContentMode, ReasoningContentState,
        ReasoningContentStateMachine,
    },
    run_log::{RunLogError, RunLogEvent, RunLogWriter, redact_text},
    tool::{
        ToolArgumentSchemaError, ToolDefinition, ToolName, find_builtin_tool,
        validate_tool_arguments,
    },
    tool_execution::{
        ApplyPatchArgs, PatchApprovalHunk, ReadFileArgs, ShellArgs, ShellResult,
        ToolExecutionError, ToolStatus, WorkspaceManifestArgs, WorkspaceToolExecutor,
        filter_apply_patch_hunks, patch_approval_hunks, redacted_tool_result_value,
    },
};

const DEFAULT_MAX_ATTACHMENTS: usize = 32;
const DEFAULT_MAX_ATTACHMENT_BYTES: u64 = 256 * 1024;
const SHELL_APPROVAL_OUTPUT_SUMMARY_MAX_LINES: usize = 8;
const SHELL_APPROVAL_OUTPUT_SUMMARY_MAX_BYTES: usize = 2 * 1024;

#[derive(Debug)]
pub struct AgentTurnLoop<P, A> {
    provider: P,
    approval_policy: A,
    tools: WorkspaceToolExecutor,
    reasoning: ReasoningContentStateMachine,
    config: AgentTurnLoopConfig,
}

impl<P> AgentTurnLoop<P, RejectAllApprovalPolicy> {
    pub fn new(workspace_root: impl AsRef<Path>, provider: P) -> Result<Self, AgentTurnLoopError> {
        Self::with_approval_policy(workspace_root, provider, RejectAllApprovalPolicy)
    }
}

impl<P, A> AgentTurnLoop<P, A> {
    pub fn with_approval_policy(
        workspace_root: impl AsRef<Path>,
        provider: P,
        approval_policy: A,
    ) -> Result<Self, AgentTurnLoopError> {
        Ok(Self {
            provider,
            approval_policy,
            tools: WorkspaceToolExecutor::new(workspace_root)?,
            reasoning: ReasoningContentStateMachine::default(),
            config: AgentTurnLoopConfig::default(),
        })
    }

    pub fn with_config(mut self, config: AgentTurnLoopConfig) -> Self {
        self.reasoning = match config.reasoning_mode {
            ReasoningContentMode::ThinkingEnabled => {
                ReasoningContentStateMachine::thinking_enabled()
            }
            ReasoningContentMode::ThinkingDisabled => {
                ReasoningContentStateMachine::thinking_disabled()
            }
        };
        self.config = config;
        self
    }

    pub fn with_reasoning(mut self, reasoning: ReasoningContentStateMachine) -> Self {
        self.reasoning = reasoning;
        self
    }
}

impl<P, A> AgentTurnLoop<P, A>
where
    P: TurnProvider,
    A: ApprovalPolicy,
{
    pub async fn run_turn<L>(
        &mut self,
        input: AgentTurnInput,
        run_log: &mut L,
    ) -> Result<AgentTurnOutcome, AgentTurnLoopError>
    where
        L: RunLogWriter + ?Sized,
    {
        let mut event_sink = NoopTurnEventSink;
        self.run_turn_with_event_sink(input, run_log, &mut event_sink)
            .await
    }

    pub async fn run_turn_with_event_sink<L, S>(
        &mut self,
        input: AgentTurnInput,
        run_log: &mut L,
        event_sink: &mut S,
    ) -> Result<AgentTurnOutcome, AgentTurnLoopError>
    where
        L: RunLogWriter + ?Sized,
        S: TurnEventSink + ?Sized,
    {
        let turn_id = input.turn_id.clone();
        let result = self.run_turn_inner(input, run_log, event_sink).await;
        if let Err(error) = &result
            && !matches!(
                error,
                AgentTurnLoopError::RunLog(_) | AgentTurnLoopError::EventSink(_)
            )
        {
            let (event_type, payload) = terminal_error_event(error);
            let append_result =
                append_turn_event(run_log, event_sink, event_type, Some(turn_id), payload);
            if let Err(append_error) = append_result {
                eprintln!(
                    "failed to append {event_type} event after `{}`: {append_error}",
                    error.code()
                );
            }
        }

        result
    }

    async fn run_turn_inner(
        &mut self,
        input: AgentTurnInput,
        run_log: &mut (impl RunLogWriter + ?Sized),
        event_sink: &mut (impl TurnEventSink + ?Sized),
    ) -> Result<AgentTurnOutcome, AgentTurnLoopError> {
        if self.config.max_model_turns == 0 {
            return Err(AgentTurnLoopError::InvalidConfig {
                detail: "max_model_turns must be greater than zero".to_owned(),
            });
        }
        input.cancellation_token.check()?;

        append_turn_event(
            run_log,
            event_sink,
            "run.started",
            None,
            json!({
                "runId": run_log.run_id(),
                "workspaceRoot": self.tools.root().display().to_string(),
                "mode": input.mode.as_str(),
            }),
        )?;
        append_turn_event(
            run_log,
            event_sink,
            "turn.started",
            Some(input.turn_id.clone()),
            json!({
                "turnId": input.turn_id.clone(),
                "userTask": input.user_task.clone(),
            }),
        )?;

        let context = self.build_context(&input)?;
        append_turn_event(
            run_log,
            event_sink,
            "context.built",
            Some(input.turn_id.clone()),
            context.context_built_payload(),
        )?;

        let mut messages = vec![ChatMessage::user(context.content)];
        let mut tool_results = Vec::new();
        let mut changed_files = Vec::new();
        let mut last_shell_output_summary = None;

        for iteration in 1..=self.config.max_model_turns {
            let prepared = self.reasoning.prepare_messages(&messages)?;
            append_turn_event(
                run_log,
                event_sink,
                "provider.requested",
                Some(input.turn_id.clone()),
                json!({
                    "iteration": iteration,
                    "messageCount": prepared.messages.len(),
                    "reasoningState": reasoning_state_payload(prepared.state),
                }),
            )?;

            let provider_turn = self
                .collect_provider_response(
                    TurnProviderRequest {
                        iteration,
                        messages: prepared.messages,
                        cancellation_token: input.cancellation_token.clone(),
                    },
                    &input.turn_id,
                    iteration,
                    run_log,
                    event_sink,
                )
                .await?;
            let response = provider_turn.response;

            if !response.tool_calls.is_empty()
                && self.reasoning.mode() == ReasoningContentMode::ThinkingEnabled
                && response
                    .reasoning_content
                    .as_deref()
                    .is_none_or(|reasoning| reasoning.trim().is_empty())
            {
                return Err(AgentTurnLoopError::MissingAssistantReasoningContent);
            }

            if let Some(content) = response
                .content
                .as_deref()
                .filter(|content| !content.is_empty())
                .filter(|_| !provider_turn.emitted_content_delta)
            {
                append_turn_event(
                    run_log,
                    event_sink,
                    "assistant.delta",
                    Some(input.turn_id.clone()),
                    json!({
                        "iteration": iteration,
                        "text": content,
                    }),
                )?;
            }

            if response.tool_calls.is_empty() {
                let final_message = response.content.unwrap_or_default();
                append_turn_event(
                    run_log,
                    event_sink,
                    "run.completed",
                    Some(input.turn_id.clone()),
                    json!({
                        "summary": final_message,
                        "changedFiles": changed_files.clone(),
                        "verificationStatus": "skipped",
                    }),
                )?;

                return Ok(AgentTurnOutcome {
                    final_message,
                    iterations: iteration,
                    tool_results,
                    changed_files,
                });
            }

            let tool_calls = response.tool_calls;
            messages.push(ChatMessage::assistant_with_tool_calls(
                response.content,
                response.reasoning_content,
                tool_calls.clone(),
            ));

            for (tool_index, tool_call) in tool_calls.iter().enumerate() {
                let tool_context = ToolCallContext {
                    turn_id: &input.turn_id,
                    iteration,
                    tool_index: tool_index + 1,
                    previous_shell_output_summary: last_shell_output_summary.as_deref(),
                    cancellation_token: &input.cancellation_token,
                };
                let executed =
                    self.execute_tool_call(tool_call, tool_context, run_log, event_sink)?;
                let follow_up_output_summary = executed.follow_up_output_summary.clone();
                changed_files.extend(executed.changed_files.iter().cloned());
                messages.push(ChatMessage::tool_result(
                    tool_call.id.clone(),
                    executed.message_content.clone(),
                ));
                tool_results.push(AgentToolResult {
                    tool_call_id: tool_call.id.clone(),
                    name: tool_call.function.name.clone(),
                    status: executed.status,
                    result: executed.log_result,
                });
                if let Some(output_summary) = follow_up_output_summary {
                    last_shell_output_summary = Some(output_summary);
                }
            }
        }

        Err(AgentTurnLoopError::MaxModelTurnsExceeded {
            max_model_turns: self.config.max_model_turns,
        })
    }

    async fn collect_provider_response<L>(
        &mut self,
        request: TurnProviderRequest,
        turn_id: &str,
        iteration: usize,
        run_log: &mut L,
        event_sink: &mut (impl TurnEventSink + ?Sized),
    ) -> Result<CollectedProviderTurn, AgentTurnLoopError>
    where
        L: RunLogWriter + ?Sized,
    {
        let cancellation_token = request.cancellation_token.clone();
        cancellation_token.check()?;
        let started = Instant::now();
        let mut stream = self
            .provider
            .complete_stream(request)
            .await
            .map_err(|error| provider_error_or_canceled(error, &cancellation_token))?;
        cancellation_token.check()?;
        let mut response = None;
        let mut emitted_content_delta = false;

        while let Some(event) = stream.next().await {
            cancellation_token.check()?;
            match event.map_err(|error| provider_error_or_canceled(error, &cancellation_token))? {
                TurnProviderEvent::AssistantDelta(delta) => {
                    if response.is_some() {
                        return Err(AgentTurnLoopError::ProviderEventAfterCompletion);
                    }

                    if let Some(content) = delta
                        .content
                        .as_deref()
                        .filter(|content| !content.is_empty())
                    {
                        emitted_content_delta = true;
                        append_turn_event(
                            run_log,
                            event_sink,
                            "assistant.delta",
                            Some(turn_id.to_owned()),
                            json!({
                                "iteration": iteration,
                                "text": content,
                                "stream": true,
                            }),
                        )?;
                    }
                }
                TurnProviderEvent::Completed(completed) => {
                    if response.replace(completed).is_some() {
                        return Err(AgentTurnLoopError::ProviderCompletedMultipleTimes);
                    }
                }
            }
            cancellation_token.check()?;
        }

        cancellation_token.check()?;
        let response = response.ok_or(AgentTurnLoopError::ProviderStreamEndedWithoutCompletion)?;
        append_provider_completed_event(
            run_log,
            event_sink,
            turn_id,
            iteration,
            started.elapsed().as_millis(),
            &response.completion,
        )?;
        Ok(CollectedProviderTurn {
            response,
            emitted_content_delta,
        })
    }

    fn build_context(
        &self,
        input: &AgentTurnInput,
    ) -> Result<crate::context::ContextCapsule, AgentTurnLoopError> {
        let mut builder =
            ContextBuilder::new(ContextBuilderConfig::new(self.config.max_input_tokens));
        if !input
            .context_items
            .iter()
            .any(|item| item.kind == ContextItemKind::WorkspaceManifest)
        {
            let manifest = self.tools.workspace_manifest_with_cancellation(
                WorkspaceManifestArgs {
                    root: None,
                    respect_gitignore: Some(true),
                    max_entries: None,
                },
                &input.cancellation_token,
            )?;
            builder.set_manifest_report(ContextManifestReport {
                manifest_hash: manifest.manifest.manifest_hash.clone(),
                max_entries: manifest.manifest.max_entries,
                total_discovered_files: manifest.manifest.total_discovered_files,
                included_files: manifest.manifest.included_files,
                omitted: manifest
                    .manifest
                    .omitted
                    .iter()
                    .map(|omitted| ContextManifestOmitted {
                        reason: omitted.reason.as_str().to_owned(),
                        count: omitted.count,
                    })
                    .collect(),
            });
            builder.add_item(ContextItem::workspace_manifest(
                manifest.summary_markdown,
                "stable workspace manifest summary",
            ));
        }
        builder.add_item(ContextItem::user_task(input.user_task.clone()));
        for item in &input.context_items {
            builder.add_item(item.clone());
        }
        for item in self.attachment_context_items(input)? {
            builder.add_item(item);
        }

        Ok(builder.build()?)
    }

    fn attachment_context_items(
        &self,
        input: &AgentTurnInput,
    ) -> Result<Vec<ContextItem>, AgentTurnLoopError> {
        if input.attachments.len() > self.config.max_attachments {
            return Err(AgentTurnLoopError::TooManyAttachments {
                count: input.attachments.len(),
                max_attachments: self.config.max_attachments,
            });
        }

        let mut items = Vec::new();
        let mut seen = HashSet::new();
        for (index, attachment) in input.attachments.iter().enumerate() {
            input.cancellation_token.check()?;
            let key = attachment.dedup_key(index);
            if !seen.insert(key.clone()) {
                return Err(AgentTurnLoopError::DuplicateAttachment {
                    index,
                    signature: attachment_dedup_signature(&key),
                });
            }

            let item = match attachment.kind {
                TurnAttachmentKind::File => {
                    self.file_attachment_context_item(index, attachment, &input.cancellation_token)?
                }
                TurnAttachmentKind::Selection => self.text_attachment_context_item(
                    index,
                    attachment,
                    ContextItemKind::Selection,
                    "selection attachment",
                    "attached editor selection from agent.sendTurn",
                )?,
                TurnAttachmentKind::ExplicitContent => self.text_attachment_context_item(
                    index,
                    attachment,
                    ContextItemKind::ExplicitContent,
                    "explicit content attachment",
                    "explicit content supplied with agent.sendTurn",
                )?,
                TurnAttachmentKind::Diagnostic => self.text_attachment_context_item(
                    index,
                    attachment,
                    ContextItemKind::Diagnostic,
                    "diagnostic attachment",
                    "diagnostic supplied with agent.sendTurn",
                )?,
            };
            items.push(item);
        }

        Ok(items)
    }

    fn file_attachment_context_item(
        &self,
        index: usize,
        attachment: &TurnAttachment,
        cancellation_token: &CancellationToken,
    ) -> Result<ContextItem, AgentTurnLoopError> {
        let path = attachment_path(index, attachment)?;
        if attachment.text.is_some() {
            return Err(AgentTurnLoopError::InvalidAttachment {
                index,
                detail: "file attachments must not include inline text".to_owned(),
            });
        }

        let result = self.tools.read_file_with_cancellation(
            ReadFileArgs {
                path: path.clone(),
                start_line: attachment
                    .range
                    .map(|range| validate_text_range(index, range))
                    .transpose()?
                    .map(|range| range.start_line as usize),
                end_line: attachment.range.map(|range| range.end_line as usize),
            },
            cancellation_token,
        )?;
        ensure_attachment_size(
            index,
            result.content.len() as u64,
            self.config.max_attachment_bytes,
        )?;

        let mut content = String::new();
        content.push_str("Attachment-Kind: file\n");
        content.push_str("SHA-256: ");
        content.push_str(&result.sha256);
        content.push('\n');
        content.push_str("Size-Bytes: ");
        content.push_str(&result.size_bytes.to_string());
        content.push('\n');
        content.push_str("Line-Count: ");
        content.push_str(&result.line_count.to_string());
        content.push('\n');
        if let Some(range) = attachment.range {
            content.push_str("Range: ");
            content.push_str(&range.label());
            content.push('\n');
        }
        content.push('\n');
        content.push_str(&result.content);

        Ok(
            ContextItem::file(path, content, "attached file from agent.sendTurn")
                .with_title(attachment_title(index, "file", attachment.range)),
        )
    }

    fn text_attachment_context_item(
        &self,
        index: usize,
        attachment: &TurnAttachment,
        kind: ContextItemKind,
        label: &str,
        reason: &str,
    ) -> Result<ContextItem, AgentTurnLoopError> {
        let text = attachment_text(index, attachment)?;
        ensure_attachment_size(index, text.len() as u64, self.config.max_attachment_bytes)?;

        match kind {
            ContextItemKind::Selection | ContextItemKind::Diagnostic => {
                let _ = attachment_path(index, attachment)?;
                let range =
                    attachment
                        .range
                        .ok_or_else(|| AgentTurnLoopError::InvalidAttachment {
                            index,
                            detail: "selection and diagnostic attachments require a range"
                                .to_owned(),
                        })?;
                validate_text_range(index, range)?;
            }
            ContextItemKind::ExplicitContent
                if attachment.path.is_some() || attachment.range.is_some() =>
            {
                return Err(AgentTurnLoopError::InvalidAttachment {
                    index,
                    detail: "explicit_content attachments must not include path or range"
                        .to_owned(),
                });
            }
            ContextItemKind::ExplicitContent => {}
            _ => {}
        }

        let mut content = String::new();
        content.push_str("Attachment-Kind: ");
        content.push_str(kind_name_for_attachment(kind));
        content.push('\n');
        if let Some(range) = attachment.range {
            content.push_str("Range: ");
            content.push_str(&range.label());
            content.push('\n');
        }
        content.push('\n');
        content.push_str(text);

        let mut item = ContextItem::required(kind, content, reason).with_title(attachment_title(
            index,
            label,
            attachment.range,
        ));
        if let Some(path) = attachment.path.as_deref() {
            item = item.with_path(path);
        }
        Ok(item)
    }

    fn execute_tool_call(
        &mut self,
        tool_call: &ChatToolCall,
        context: ToolCallContext<'_>,
        run_log: &mut (impl RunLogWriter + ?Sized),
        event_sink: &mut (impl TurnEventSink + ?Sized),
    ) -> Result<ExecutedToolCall, AgentTurnLoopError> {
        context.cancellation_token.check()?;
        let tool_name = tool_call.function.name.as_str();
        let definition =
            find_builtin_tool(tool_name).ok_or_else(|| AgentTurnLoopError::UnknownTool {
                tool_call_id: tool_call.id.clone(),
                name: tool_name.to_owned(),
            })?;
        let arguments_preview = parse_tool_arguments_value(tool_call)?;
        validate_tool_call_arguments(definition, tool_call, &arguments_preview)?;
        let risk_assessment = tool_risk_assessment(definition, &arguments_preview);

        append_turn_event(
            run_log,
            event_sink,
            "tool.requested",
            Some(context.turn_id.to_owned()),
            tool_requested_payload(
                tool_call.id.clone(),
                tool_name,
                &risk_assessment,
                arguments_preview.clone(),
            ),
        )?;

        match definition.name {
            ToolName::WorkspaceManifest => {
                let args = parse_tool_arguments(tool_call, &arguments_preview)?;
                self.execute_without_approval(
                    tool_call,
                    context,
                    args,
                    run_log,
                    event_sink,
                    |tools, args, cancellation_token| {
                        let result =
                            tools.workspace_manifest_with_cancellation(args, cancellation_token)?;
                        tool_record(result.status, result.summary.clone(), Vec::new(), &result)
                    },
                )
            }
            ToolName::ReadFile => {
                let args = parse_tool_arguments(tool_call, &arguments_preview)?;
                self.execute_without_approval(
                    tool_call,
                    context,
                    args,
                    run_log,
                    event_sink,
                    |tools, args, cancellation_token| {
                        let result = tools.read_file_with_cancellation(args, cancellation_token)?;
                        tool_record(result.status, result.summary.clone(), Vec::new(), &result)
                    },
                )
            }
            ToolName::Search => {
                let args = parse_tool_arguments(tool_call, &arguments_preview)?;
                self.execute_without_approval(
                    tool_call,
                    context,
                    args,
                    run_log,
                    event_sink,
                    |tools, args, cancellation_token| {
                        let result = tools.search_with_cancellation(args, cancellation_token)?;
                        tool_record(result.status, result.summary.clone(), Vec::new(), &result)
                    },
                )
            }
            ToolName::ApplyPatch => {
                let args: ApplyPatchArgs = parse_tool_arguments(tool_call, &arguments_preview)?;
                let approval_hunks = patch_approval_hunks(&args.unified_diff)?;
                let approval_scope = self.ensure_approval(
                    definition,
                    &risk_assessment,
                    tool_call,
                    context.turn_id,
                    context.iteration,
                    context.tool_index,
                    Some(args.expected_files.clone()),
                    None,
                    None,
                    None,
                    Some(approval_hunks),
                    run_log,
                    event_sink,
                )?;
                let args = match approval_scope {
                    ApprovalScope::All => args,
                    ApprovalScope::Hunks { hunk_ids } => filter_apply_patch_hunks(args, &hunk_ids)?,
                };
                self.execute_without_approval(
                    tool_call,
                    context,
                    args,
                    run_log,
                    event_sink,
                    |tools, args, cancellation_token| {
                        let result =
                            tools.apply_patch_with_cancellation(args, cancellation_token)?;
                        tool_record(
                            result.status,
                            result.summary.clone(),
                            result.files.clone(),
                            &result,
                        )
                    },
                )
            }
            ToolName::Shell => {
                let args: ShellArgs = parse_tool_arguments(tool_call, &arguments_preview)?;
                self.ensure_approval(
                    definition,
                    &risk_assessment,
                    tool_call,
                    context.turn_id,
                    context.iteration,
                    context.tool_index,
                    args.cwd.clone().map(|cwd| vec![cwd]),
                    Some(args.command.clone()),
                    Some(args.cwd.clone().unwrap_or_else(|| ".".to_owned())),
                    context.previous_shell_output_summary.map(str::to_owned),
                    None,
                    run_log,
                    event_sink,
                )?;
                self.execute_without_approval(
                    tool_call,
                    context,
                    args,
                    run_log,
                    event_sink,
                    |tools, args, cancellation_token| {
                        let result = tools.shell_with_cancellation(args, cancellation_token)?;
                        shell_tool_record(result)
                    },
                )
            }
            ToolName::GitStatus => {
                let args = parse_tool_arguments(tool_call, &arguments_preview)?;
                self.execute_without_approval(
                    tool_call,
                    context,
                    args,
                    run_log,
                    event_sink,
                    |tools, args, cancellation_token| {
                        let result =
                            tools.git_status_with_cancellation(args, cancellation_token)?;
                        tool_record(result.status, result.summary.clone(), Vec::new(), &result)
                    },
                )
            }
            ToolName::GitDiff => {
                let args = parse_tool_arguments(tool_call, &arguments_preview)?;
                self.execute_without_approval(
                    tool_call,
                    context,
                    args,
                    run_log,
                    event_sink,
                    |tools, args, cancellation_token| {
                        let result = tools.git_diff_with_cancellation(args, cancellation_token)?;
                        tool_record(result.status, result.summary.clone(), Vec::new(), &result)
                    },
                )
            }
            ToolName::LspDiagnostics => Err(AgentTurnLoopError::UnsupportedTool {
                tool_call_id: tool_call.id.clone(),
                name: tool_name.to_owned(),
            }),
            ToolName::PlanUpdate => Err(AgentTurnLoopError::UnsupportedTool {
                tool_call_id: tool_call.id.clone(),
                name: tool_name.to_owned(),
            }),
        }
    }

    fn execute_without_approval<L, Args, F>(
        &self,
        tool_call: &ChatToolCall,
        context: ToolCallContext<'_>,
        args: Args,
        run_log: &mut L,
        event_sink: &mut (impl TurnEventSink + ?Sized),
        execute: F,
    ) -> Result<ExecutedToolCall, AgentTurnLoopError>
    where
        L: RunLogWriter + ?Sized,
        F: FnOnce(
            &WorkspaceToolExecutor,
            Args,
            &CancellationToken,
        ) -> Result<ExecutedToolCall, AgentTurnLoopError>,
    {
        context.cancellation_token.check()?;
        append_turn_event(
            run_log,
            event_sink,
            "tool.started",
            Some(context.turn_id.to_owned()),
            json!({
                "toolCallId": tool_call.id.clone(),
                "name": tool_call.function.name.clone(),
            }),
        )?;

        let executed = execute(&self.tools, args, context.cancellation_token)?;
        append_turn_event(
            run_log,
            event_sink,
            "tool.completed",
            Some(context.turn_id.to_owned()),
            json!({
                "toolCallId": tool_call.id.clone(),
                "name": tool_call.function.name.clone(),
                "status": executed.status.as_str(),
                "summary": executed.summary.clone(),
                "result": executed.log_result.clone(),
            }),
        )?;

        Ok(executed)
    }

    #[allow(clippy::too_many_arguments)]
    fn ensure_approval(
        &mut self,
        definition: &ToolDefinition,
        risk_assessment: &ToolRiskAssessment,
        tool_call: &ChatToolCall,
        turn_id: &str,
        iteration: usize,
        tool_index: usize,
        paths: Option<Vec<String>>,
        command: Option<String>,
        cwd: Option<String>,
        output_summary: Option<String>,
        hunks: Option<Vec<PatchApprovalHunk>>,
        run_log: &mut (impl RunLogWriter + ?Sized),
        event_sink: &mut (impl TurnEventSink + ?Sized),
    ) -> Result<ApprovalScope, AgentTurnLoopError> {
        let approval = effective_approval_requirement(definition.approval, risk_assessment.risk);
        if approval == ApprovalRequirement::None {
            return Ok(ApprovalScope::All);
        }

        let request = TurnApprovalRequest {
            approval_id: format!("approval_{iteration}_{tool_index}"),
            tool_call_id: tool_call.id.clone(),
            tool_name: definition.name.as_str().to_owned(),
            risk: risk_assessment.risk,
            title: approval_title(definition.name.as_str()).to_owned(),
            detail: approval_detail(
                definition.name.as_str(),
                command.as_deref(),
                paths.as_deref(),
                &risk_assessment.risk_reasons,
            ),
            command,
            cwd,
            output_summary,
            paths,
            hunks,
            risk_reasons: risk_assessment.risk_reasons.clone(),
            persistable: approval_persistable(approval, risk_assessment.risk),
        };

        append_turn_event(
            run_log,
            event_sink,
            "tool.approvalRequired",
            Some(turn_id.to_owned()),
            approval_payload(&request),
        )?;

        match self.approval_policy.decide(&request)? {
            ApprovalDecision::Approved => {
                append_turn_event(
                    run_log,
                    event_sink,
                    "tool.approvalResolved",
                    Some(turn_id.to_owned()),
                    approval_resolved_payload(
                        &request,
                        "approved",
                        None,
                        Some(&ApprovalScope::All),
                    ),
                )?;
                Ok(ApprovalScope::All)
            }
            ApprovalDecision::ApprovedHunks { hunk_ids } => {
                let approval_scope = ApprovalScope::Hunks { hunk_ids };
                append_turn_event(
                    run_log,
                    event_sink,
                    "tool.approvalResolved",
                    Some(turn_id.to_owned()),
                    approval_resolved_payload(&request, "approved", None, Some(&approval_scope)),
                )?;
                Ok(approval_scope)
            }
            ApprovalDecision::Rejected { reason } => {
                append_turn_event(
                    run_log,
                    event_sink,
                    "tool.approvalResolved",
                    Some(turn_id.to_owned()),
                    approval_resolved_payload(&request, "rejected", Some(reason.as_str()), None),
                )?;
                Err(AgentTurnLoopError::ApprovalRejected {
                    approval_id: request.approval_id,
                    tool_call_id: request.tool_call_id,
                    reason,
                })
            }
            ApprovalDecision::Canceled { reason } => {
                append_turn_event(
                    run_log,
                    event_sink,
                    "tool.approvalResolved",
                    Some(turn_id.to_owned()),
                    approval_resolved_payload(&request, "canceled", Some(reason.as_str()), None),
                )?;
                Err(AgentTurnLoopError::ApprovalCanceled {
                    approval_id: request.approval_id,
                    tool_call_id: request.tool_call_id,
                    reason,
                })
            }
            ApprovalDecision::Expired { reason } => {
                append_turn_event(
                    run_log,
                    event_sink,
                    "tool.approvalResolved",
                    Some(turn_id.to_owned()),
                    approval_resolved_payload(&request, "expired", Some(reason.as_str()), None),
                )?;
                Err(AgentTurnLoopError::ApprovalExpired {
                    approval_id: request.approval_id,
                    tool_call_id: request.tool_call_id,
                    reason,
                })
            }
        }
    }
}

pub trait TurnEventSink {
    fn on_event(&mut self, event: &RunLogEvent) -> Result<(), TurnEventSinkError>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NoopTurnEventSink;

impl TurnEventSink for NoopTurnEventSink {
    fn on_event(&mut self, _event: &RunLogEvent) -> Result<(), TurnEventSinkError> {
        Ok(())
    }
}

#[derive(Debug, Error)]
#[error("turn event sink failed: {message}")]
pub struct TurnEventSinkError {
    message: String,
}

impl TurnEventSinkError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

fn append_turn_event<L>(
    run_log: &mut L,
    event_sink: &mut (impl TurnEventSink + ?Sized),
    event_type: impl Into<String>,
    turn_id: Option<String>,
    payload: Value,
) -> Result<RunLogEvent, AgentTurnLoopError>
where
    L: RunLogWriter + ?Sized,
{
    let event = run_log.append_event(event_type.into(), turn_id, payload)?;
    event_sink.on_event(&event)?;
    Ok(event)
}

fn append_provider_completed_event<L>(
    run_log: &mut L,
    event_sink: &mut (impl TurnEventSink + ?Sized),
    turn_id: &str,
    iteration: usize,
    duration_ms: u128,
    completion: &TurnProviderCompletion,
) -> Result<RunLogEvent, AgentTurnLoopError>
where
    L: RunLogWriter + ?Sized,
{
    let duration_ms = u64::try_from(duration_ms).unwrap_or(u64::MAX);
    let mut payload = serde_json::to_value(completion)?;
    if let Value::Object(payload) = &mut payload {
        payload.insert("iteration".to_owned(), json!(iteration));
        payload.insert("durationMs".to_owned(), json!(duration_ms));
    }
    append_turn_event(
        run_log,
        event_sink,
        "provider.completed",
        Some(turn_id.to_owned()),
        payload,
    )
}

fn attachment_path(
    index: usize,
    attachment: &TurnAttachment,
) -> Result<String, AgentTurnLoopError> {
    let path = attachment
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| AgentTurnLoopError::InvalidAttachment {
            index,
            detail: "attachment path is required".to_owned(),
        })?;
    Ok(path.to_owned())
}

fn attachment_text(index: usize, attachment: &TurnAttachment) -> Result<&str, AgentTurnLoopError> {
    attachment
        .text
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| AgentTurnLoopError::InvalidAttachment {
            index,
            detail: "attachment text is required".to_owned(),
        })
}

fn ensure_attachment_size(
    index: usize,
    size_bytes: u64,
    max_bytes: u64,
) -> Result<(), AgentTurnLoopError> {
    if size_bytes > max_bytes {
        return Err(AgentTurnLoopError::AttachmentTooLarge {
            index,
            size_bytes,
            max_bytes,
        });
    }
    Ok(())
}

fn validate_text_range(index: usize, range: TextRange) -> Result<TextRange, AgentTurnLoopError> {
    if range.start_line == 0
        || range.start_column == 0
        || range.end_line == 0
        || range.end_column == 0
        || range.end_line < range.start_line
        || (range.end_line == range.start_line && range.end_column < range.start_column)
    {
        return Err(AgentTurnLoopError::InvalidAttachment {
            index,
            detail: format!("invalid text range {}", range.label()),
        });
    }

    Ok(range)
}

fn attachment_title(index: usize, label: &str, range: Option<TextRange>) -> String {
    match range {
        Some(range) => format!("{label} #{} ({})", index + 1, range.label()),
        None => format!("{label} #{}", index + 1),
    }
}

fn kind_name_for_attachment(kind: ContextItemKind) -> &'static str {
    match kind {
        ContextItemKind::Selection => "selection",
        ContextItemKind::ExplicitContent => "explicit_content",
        ContextItemKind::Diagnostic => "diagnostic",
        ContextItemKind::File => "file",
        _ => "attachment",
    }
}

fn attachment_dedup_signature(key: &str) -> String {
    crate::hashing::sha256_hex(key.as_bytes())
        .chars()
        .take(16)
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentTurnLoopConfig {
    pub max_input_tokens: u64,
    pub max_model_turns: usize,
    pub reasoning_mode: ReasoningContentMode,
    pub max_attachments: usize,
    pub max_attachment_bytes: u64,
}

impl Default for AgentTurnLoopConfig {
    fn default() -> Self {
        Self {
            max_input_tokens: 1_000_000,
            max_model_turns: 8,
            reasoning_mode: ReasoningContentMode::ThinkingEnabled,
            max_attachments: DEFAULT_MAX_ATTACHMENTS,
            max_attachment_bytes: DEFAULT_MAX_ATTACHMENT_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTurnInput {
    pub turn_id: String,
    pub user_task: String,
    pub mode: AgentRunMode,
    pub context_items: Vec<ContextItem>,
    pub attachments: Vec<TurnAttachment>,
    pub cancellation_token: CancellationToken,
}

impl AgentTurnInput {
    pub fn new(turn_id: impl Into<String>, user_task: impl Into<String>) -> Self {
        Self {
            turn_id: turn_id.into(),
            user_task: user_task.into(),
            mode: AgentRunMode::Edit,
            context_items: Vec::new(),
            attachments: Vec::new(),
            cancellation_token: CancellationToken::new(),
        }
    }

    pub fn with_mode(mut self, mode: AgentRunMode) -> Self {
        self.mode = mode;
        self
    }

    pub fn with_context_item(mut self, item: ContextItem) -> Self {
        self.context_items.push(item);
        self
    }

    pub fn with_attachment(mut self, attachment: TurnAttachment) -> Self {
        self.attachments.push(attachment);
        self
    }

    pub fn with_attachments(mut self, attachments: Vec<TurnAttachment>) -> Self {
        self.attachments = attachments;
        self
    }

    pub fn with_cancellation_token(mut self, cancellation_token: CancellationToken) -> Self {
        self.cancellation_token = cancellation_token;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnAttachment {
    pub kind: TurnAttachmentKind,
    pub path: Option<String>,
    pub range: Option<TextRange>,
    pub text: Option<String>,
}

impl TurnAttachment {
    pub fn file(path: impl Into<String>) -> Self {
        Self {
            kind: TurnAttachmentKind::File,
            path: Some(path.into()),
            range: None,
            text: None,
        }
    }

    pub fn selection(path: impl Into<String>, range: TextRange, text: impl Into<String>) -> Self {
        Self {
            kind: TurnAttachmentKind::Selection,
            path: Some(path.into()),
            range: Some(range),
            text: Some(text.into()),
        }
    }

    pub fn explicit_content(text: impl Into<String>) -> Self {
        Self {
            kind: TurnAttachmentKind::ExplicitContent,
            path: None,
            range: None,
            text: Some(text.into()),
        }
    }

    pub fn diagnostic(path: impl Into<String>, range: TextRange, text: impl Into<String>) -> Self {
        Self {
            kind: TurnAttachmentKind::Diagnostic,
            path: Some(path.into()),
            range: Some(range),
            text: Some(text.into()),
        }
    }

    fn dedup_key(&self, index: usize) -> String {
        let mut key = format!("{:?}|", self.kind);
        key.push_str(self.path.as_deref().unwrap_or("<no-path>"));
        key.push('|');
        if let Some(range) = self.range {
            key.push_str(&range.label());
        } else {
            key.push_str("<no-range>");
        }
        key.push('|');
        if let Some(text) = self.text.as_deref() {
            key.push_str(&crate::hashing::sha256_hex(text.as_bytes()));
        } else {
            key.push_str("<no-text>");
        }
        if self.kind == TurnAttachmentKind::ExplicitContent && self.text.is_none() {
            key.push('|');
            key.push_str(&index.to_string());
        }
        key
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TurnAttachmentKind {
    File,
    Selection,
    ExplicitContent,
    Diagnostic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TextRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

impl TextRange {
    pub const fn new(start_line: u32, start_column: u32, end_line: u32, end_column: u32) -> Self {
        Self {
            start_line,
            start_column,
            end_line,
            end_column,
        }
    }

    fn label(self) -> String {
        format!(
            "{}:{}-{}:{}",
            self.start_line, self.start_column, self.end_line, self.end_column
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRunMode {
    Plan,
    Edit,
    Review,
    Ask,
}

impl AgentRunMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Edit => "edit",
            Self::Review => "review",
            Self::Ask => "ask",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentTurnOutcome {
    pub final_message: String,
    pub iterations: usize,
    pub tool_results: Vec<AgentToolResult>,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentToolResult {
    pub tool_call_id: String,
    pub name: String,
    pub status: ToolStatus,
    pub result: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnProviderRequest {
    pub iteration: usize,
    pub messages: Vec<ChatMessage>,
    pub cancellation_token: CancellationToken,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnProviderResponse {
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls: Vec<ChatToolCall>,
    pub completion: TurnProviderCompletion,
}

impl TurnProviderResponse {
    pub fn final_text(content: impl Into<String>) -> Self {
        Self {
            content: Some(content.into()),
            reasoning_content: None,
            tool_calls: Vec::new(),
            completion: TurnProviderCompletion::fixture(TurnProviderFinishReason::Stop),
        }
    }

    pub fn tool_calls(
        content: Option<String>,
        reasoning_content: Option<String>,
        tool_calls: Vec<ChatToolCall>,
    ) -> Self {
        Self {
            content,
            reasoning_content,
            tool_calls,
            completion: TurnProviderCompletion::fixture(TurnProviderFinishReason::ToolCalls),
        }
    }

    pub fn with_completion(mut self, completion: TurnProviderCompletion) -> Self {
        self.completion = completion;
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum TurnProviderEvent {
    AssistantDelta(TurnProviderDelta),
    Completed(TurnProviderResponse),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnProviderDelta {
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
}

impl TurnProviderDelta {
    pub fn new(content: Option<String>, reasoning_content: Option<String>) -> Self {
        Self {
            content,
            reasoning_content,
        }
    }

    pub fn content(content: impl Into<String>) -> Self {
        Self {
            content: Some(content.into()),
            reasoning_content: None,
        }
    }

    pub fn reasoning_content(reasoning_content: impl Into<String>) -> Self {
        Self {
            content: None,
            reasoning_content: Some(reasoning_content.into()),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.content
            .as_deref()
            .is_none_or(|content| content.is_empty())
            && self
                .reasoning_content
                .as_deref()
                .is_none_or(|reasoning_content| reasoning_content.is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnProviderCompletion {
    pub model: String,
    pub finish_reason: TurnProviderFinishReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnProviderUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<TurnProviderStreamingSummary>,
}

impl TurnProviderCompletion {
    pub fn new(model: impl Into<String>, finish_reason: TurnProviderFinishReason) -> Self {
        Self {
            model: model.into(),
            finish_reason,
            usage: None,
            streaming: None,
        }
    }

    pub fn fixture(finish_reason: TurnProviderFinishReason) -> Self {
        Self::new("fixture", finish_reason)
    }

    pub fn with_usage(mut self, usage: TurnProviderUsage) -> Self {
        self.usage = Some(usage);
        self
    }

    pub fn with_streaming(mut self, streaming: TurnProviderStreamingSummary) -> Self {
        self.streaming = Some(streaming);
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnProviderFinishReason {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnProviderUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_hit_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_miss_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnProviderStreamingSummary {
    pub chunk_count: u64,
    pub tool_call_delta_count: u64,
}

pub type TurnProviderStream =
    Pin<Box<dyn Stream<Item = Result<TurnProviderEvent, TurnProviderError>> + Send>>;

pub type TurnProviderFuture<'a> =
    Pin<Box<dyn Future<Output = Result<TurnProviderStream, TurnProviderError>> + Send + 'a>>;

pub fn turn_provider_response_stream(response: TurnProviderResponse) -> TurnProviderStream {
    Box::pin(futures_util::stream::once(async move {
        Ok(TurnProviderEvent::Completed(response))
    }))
}

pub trait TurnProvider {
    fn complete_stream(&mut self, request: TurnProviderRequest) -> TurnProviderFuture<'_>;
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct TurnProviderError {
    message: String,
}

impl TurnProviderError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnApprovalRequest {
    pub approval_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub risk: RiskLevel,
    pub title: String,
    pub detail: String,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub output_summary: Option<String>,
    pub paths: Option<Vec<String>>,
    pub hunks: Option<Vec<PatchApprovalHunk>>,
    pub risk_reasons: Vec<String>,
    pub persistable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approved,
    ApprovedHunks { hunk_ids: Vec<String> },
    Rejected { reason: String },
    Canceled { reason: String },
    Expired { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalScope {
    All,
    Hunks { hunk_ids: Vec<String> },
}

pub trait ApprovalPolicy {
    fn decide(
        &mut self,
        request: &TurnApprovalRequest,
    ) -> Result<ApprovalDecision, ApprovalPolicyError>;
}

#[derive(Debug, Error)]
#[error("approval policy failed: {message}")]
pub struct ApprovalPolicyError {
    message: String,
}

impl ApprovalPolicyError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for ApprovalPolicyError {
    fn from(source: std::io::Error) -> Self {
        Self::new(source.to_string())
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct RejectAllApprovalPolicy;

impl ApprovalPolicy for RejectAllApprovalPolicy {
    fn decide(
        &mut self,
        request: &TurnApprovalRequest,
    ) -> Result<ApprovalDecision, ApprovalPolicyError> {
        Ok(ApprovalDecision::Rejected {
            reason: format!("approval required for {}", request.tool_name),
        })
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct AutoApprovePolicy;

impl ApprovalPolicy for AutoApprovePolicy {
    fn decide(
        &mut self,
        _request: &TurnApprovalRequest,
    ) -> Result<ApprovalDecision, ApprovalPolicyError> {
        Ok(ApprovalDecision::Approved)
    }
}

#[derive(Debug, Error)]
pub enum AgentTurnLoopError {
    #[error("invalid turn loop config: {detail}")]
    InvalidConfig { detail: String },
    #[error("context build failed: {0}")]
    ContextBuild(#[from] ContextBuildError),
    #[error("reasoning content state error: {0}")]
    Reasoning(#[from] ReasoningContentError),
    #[error("provider failed: {0}")]
    Provider(#[from] TurnProviderError),
    #[error("provider stream ended without a completed response")]
    ProviderStreamEndedWithoutCompletion,
    #[error("provider stream emitted more than one completed response")]
    ProviderCompletedMultipleTimes,
    #[error("provider stream emitted an event after the completed response")]
    ProviderEventAfterCompletion,
    #[error("run log failed: {0}")]
    RunLog(#[from] RunLogError),
    #[error("event sink failed: {0}")]
    EventSink(#[from] TurnEventSinkError),
    #[error("tool execution failed: {0}")]
    ToolExecution(ToolExecutionError),
    #[error("run canceled: {reason}")]
    Canceled { reason: String },
    #[error("tool call `{tool_call_id}` requested unknown tool `{name}`")]
    UnknownTool { tool_call_id: String, name: String },
    #[error("tool `{name}` is registered but not implemented in the Phase 1 executor")]
    UnsupportedTool { tool_call_id: String, name: String },
    #[error("tool call `{tool_call_id}` for `{name}` has invalid JSON arguments: {source}")]
    InvalidToolArguments {
        tool_call_id: String,
        name: String,
        source: serde_json::Error,
    },
    #[error("tool call `{tool_call_id}` for `{name}` failed JSON Schema validation: {source}")]
    InvalidToolArgumentSchema {
        tool_call_id: String,
        name: String,
        source: ToolArgumentSchemaError,
    },
    #[error("tool result serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("too many attachments: got {count}, max {max_attachments}")]
    TooManyAttachments {
        count: usize,
        max_attachments: usize,
    },
    #[error("duplicate attachment at index {index}: signature {signature}")]
    DuplicateAttachment { index: usize, signature: String },
    #[error("invalid attachment at index {index}: {detail}")]
    InvalidAttachment { index: usize, detail: String },
    #[error("attachment at index {index} is too large: {size_bytes} bytes, max {max_bytes}")]
    AttachmentTooLarge {
        index: usize,
        size_bytes: u64,
        max_bytes: u64,
    },
    #[error("assistant tool call response is missing reasoning_content while thinking is enabled")]
    MissingAssistantReasoningContent,
    #[error("approval `{approval_id}` rejected for tool call `{tool_call_id}`: {reason}")]
    ApprovalRejected {
        approval_id: String,
        tool_call_id: String,
        reason: String,
    },
    #[error("approval `{approval_id}` canceled for tool call `{tool_call_id}`: {reason}")]
    ApprovalCanceled {
        approval_id: String,
        tool_call_id: String,
        reason: String,
    },
    #[error("approval `{approval_id}` expired for tool call `{tool_call_id}`: {reason}")]
    ApprovalExpired {
        approval_id: String,
        tool_call_id: String,
        reason: String,
    },
    #[error("approval policy failed: {0}")]
    ApprovalPolicy(#[from] ApprovalPolicyError),
    #[error("model did not finish after {max_model_turns} turns")]
    MaxModelTurnsExceeded { max_model_turns: usize },
}

impl AgentTurnLoopError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidConfig { .. } => "E_INVALID_CONFIG",
            Self::ContextBuild(_) => "E_CONTEXT_BUILD_FAILED",
            Self::Reasoning(_) => "E_REASONING_CONTENT",
            Self::Provider(_) => "E_PROVIDER_ERROR",
            Self::ProviderStreamEndedWithoutCompletion => "E_PROVIDER_STREAM_INCOMPLETE",
            Self::ProviderCompletedMultipleTimes => "E_PROVIDER_STREAM_INVALID",
            Self::ProviderEventAfterCompletion => "E_PROVIDER_STREAM_INVALID",
            Self::RunLog(_) => "E_RUN_LOG",
            Self::EventSink(_) => "E_EVENT_SINK",
            Self::ToolExecution(_) => "E_TOOL_EXECUTION",
            Self::Canceled { .. } => "E_RUN_CANCELED",
            Self::UnknownTool { .. } => "E_UNKNOWN_TOOL",
            Self::UnsupportedTool { .. } => "E_UNSUPPORTED_TOOL",
            Self::InvalidToolArguments { .. } | Self::InvalidToolArgumentSchema { .. } => {
                "E_INVALID_TOOL_ARGUMENTS"
            }
            Self::Serialization(_) => "E_SERIALIZATION",
            Self::TooManyAttachments { .. }
            | Self::DuplicateAttachment { .. }
            | Self::InvalidAttachment { .. }
            | Self::AttachmentTooLarge { .. } => "E_INVALID_ATTACHMENT",
            Self::MissingAssistantReasoningContent => "E_MISSING_REASONING_CONTENT",
            Self::ApprovalRejected { .. } => "E_APPROVAL_REJECTED",
            Self::ApprovalCanceled { .. } => "E_APPROVAL_CANCELED",
            Self::ApprovalExpired { .. } => "E_APPROVAL_EXPIRED",
            Self::ApprovalPolicy(_) => "E_APPROVAL_POLICY",
            Self::MaxModelTurnsExceeded { .. } => "E_MAX_MODEL_TURNS",
        }
    }
}

impl From<ToolExecutionError> for AgentTurnLoopError {
    fn from(error: ToolExecutionError) -> Self {
        match error {
            ToolExecutionError::CommandCanceled { reason, .. } => Self::Canceled { reason },
            error => Self::ToolExecution(error),
        }
    }
}

impl From<CancellationError> for AgentTurnLoopError {
    fn from(error: CancellationError) -> Self {
        Self::Canceled {
            reason: error.reason().to_owned(),
        }
    }
}

struct ExecutedToolCall {
    status: ToolStatus,
    summary: String,
    message_content: String,
    log_result: Value,
    changed_files: Vec<String>,
    follow_up_output_summary: Option<String>,
}

struct CollectedProviderTurn {
    // `response` is the authoritative completed assistant message used for final text,
    // reasoning replay, and tool execution. Streaming deltas are only presentation/log events.
    response: TurnProviderResponse,
    // Only visible content deltas count here. Reasoning deltas stay provider-private, and this
    // flag prevents duplicating the final content as another assistant.delta after streaming.
    emitted_content_delta: bool,
}

#[derive(Clone, Copy)]
struct ToolCallContext<'a> {
    turn_id: &'a str,
    iteration: usize,
    tool_index: usize,
    previous_shell_output_summary: Option<&'a str>,
    cancellation_token: &'a CancellationToken,
}

fn parse_tool_arguments_value(tool_call: &ChatToolCall) -> Result<Value, AgentTurnLoopError> {
    serde_json::from_str(&tool_call.function.arguments).map_err(|source| {
        AgentTurnLoopError::InvalidToolArguments {
            tool_call_id: tool_call.id.clone(),
            name: tool_call.function.name.clone(),
            source,
        }
    })
}

fn validate_tool_call_arguments(
    definition: &ToolDefinition,
    tool_call: &ChatToolCall,
    arguments: &Value,
) -> Result<(), AgentTurnLoopError> {
    validate_tool_arguments(definition, arguments).map_err(|source| {
        AgentTurnLoopError::InvalidToolArgumentSchema {
            tool_call_id: tool_call.id.clone(),
            name: tool_call.function.name.clone(),
            source,
        }
    })
}

fn parse_tool_arguments<T: DeserializeOwned>(
    tool_call: &ChatToolCall,
    arguments: &Value,
) -> Result<T, AgentTurnLoopError> {
    serde_json::from_value(arguments.clone()).map_err(|source| {
        AgentTurnLoopError::InvalidToolArguments {
            tool_call_id: tool_call.id.clone(),
            name: tool_call.function.name.clone(),
            source,
        }
    })
}

fn tool_record<T: serde::Serialize>(
    status: ToolStatus,
    summary: String,
    changed_files: Vec<String>,
    result: &T,
) -> Result<ExecutedToolCall, AgentTurnLoopError> {
    let log_result = redacted_tool_result_value(result)?;
    let message_content = serde_json::to_string(&log_result)?;
    Ok(ExecutedToolCall {
        status,
        summary,
        message_content,
        log_result,
        changed_files,
        follow_up_output_summary: None,
    })
}

fn shell_tool_record(result: ShellResult) -> Result<ExecutedToolCall, AgentTurnLoopError> {
    let output_summary = shell_approval_output_summary(&result);
    let log_result = redacted_tool_result_value(&result)?;
    let message_content = serde_json::to_string(&log_result)?;
    Ok(ExecutedToolCall {
        status: result.status,
        summary: result.summary,
        message_content,
        log_result,
        changed_files: Vec::new(),
        follow_up_output_summary: output_summary,
    })
}

fn shell_approval_output_summary(result: &ShellResult) -> Option<String> {
    let mut sections = Vec::new();
    if let Some(stdout) = shell_output_tail_section("stdout", &result.stdout) {
        sections.push(stdout);
    }
    if let Some(stderr) = shell_output_tail_section("stderr", &result.stderr) {
        sections.push(stderr);
    }
    if sections.is_empty() {
        return None;
    }

    let exit_code = result
        .exit_code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "unknown".to_owned());
    let summary = format!("exitCode: {exit_code}\n{}", sections.join("\n"));
    Some(truncate_shell_output_summary(&summary))
}

fn shell_output_tail_section(label: &str, output: &str) -> Option<String> {
    let redacted = redact_text(output);
    let trimmed = redacted.trim_end();
    if trimmed.is_empty() {
        return None;
    }

    let line_count = trimmed.lines().count();
    let omitted = line_count.saturating_sub(SHELL_APPROVAL_OUTPUT_SUMMARY_MAX_LINES);
    let shown = line_count - omitted;
    let mut section = if omitted == 0 {
        format!("{label}:")
    } else {
        format!("{label} (last {shown} of {line_count} lines):")
    };
    for line in trimmed.lines().skip(omitted) {
        section.push('\n');
        section.push_str(line);
    }
    Some(section)
}

fn truncate_shell_output_summary(text: &str) -> String {
    const TRUNCATED_MARKER: &str = "\n[output summary truncated]";
    if text.len() <= SHELL_APPROVAL_OUTPUT_SUMMARY_MAX_BYTES {
        return text.to_owned();
    }

    let mut end = SHELL_APPROVAL_OUTPUT_SUMMARY_MAX_BYTES - TRUNCATED_MARKER.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &text[..end], TRUNCATED_MARKER)
}

fn reasoning_state_payload(state: ReasoningContentState) -> Value {
    match state {
        ReasoningContentState::NoReplayRequired => {
            json!({ "state": "no_replay_required" })
        }
        ReasoningContentState::ReplayRequired { assistant_messages } => {
            json!({
                "state": "replay_required",
                "assistantMessages": assistant_messages,
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolRiskAssessment {
    risk: RiskLevel,
    risk_reasons: Vec<String>,
}

fn tool_risk_assessment(definition: &ToolDefinition, arguments: &Value) -> ToolRiskAssessment {
    if definition.name == ToolName::Shell
        && let Some(command) = arguments.get("command").and_then(Value::as_str)
    {
        let classification = classify_shell_command(command);
        return ToolRiskAssessment {
            risk: classification.risk,
            risk_reasons: classification.reason_summaries(),
        };
    }

    ToolRiskAssessment {
        risk: definition.risk,
        risk_reasons: Vec::new(),
    }
}

fn effective_approval_requirement(
    static_approval: ApprovalRequirement,
    risk: RiskLevel,
) -> ApprovalRequirement {
    let risk_approval = risk.default_approval();
    if approval_requirement_rank(risk_approval) > approval_requirement_rank(static_approval) {
        risk_approval
    } else {
        static_approval
    }
}

fn approval_persistable(approval: ApprovalRequirement, risk: RiskLevel) -> bool {
    approval.is_persistable() && !matches!(risk, RiskLevel::Network | RiskLevel::Destructive)
}

fn approval_requirement_rank(approval: ApprovalRequirement) -> u8 {
    match approval {
        ApprovalRequirement::None => 0,
        ApprovalRequirement::Required => 1,
        ApprovalRequirement::AlwaysRequired => 2,
    }
}

fn approval_title(tool_name: &str) -> &'static str {
    match tool_name {
        "apply_patch" => "Apply patch",
        "shell" => "Run shell command",
        _ => "Approve tool call",
    }
}

fn approval_detail(
    tool_name: &str,
    command: Option<&str>,
    paths: Option<&[String]>,
    risk_reasons: &[String],
) -> String {
    let mut detail = match (tool_name, command, paths) {
        ("shell", Some(command), _) => format!("Execute `{command}`"),
        ("apply_patch", _, Some(paths)) => {
            format!(
                "Modify {} expected file(s): {}",
                paths.len(),
                paths.join(", ")
            )
        }
        _ => format!("Execute tool `{tool_name}`"),
    };

    if !risk_reasons.is_empty() {
        detail.push_str("; risk upgrade: ");
        detail.push_str(&risk_reasons.join(", "));
    }

    detail
}

fn tool_requested_payload(
    tool_call_id: String,
    tool_name: &str,
    risk_assessment: &ToolRiskAssessment,
    arguments_preview: Value,
) -> Value {
    let mut payload = Map::new();
    payload.insert("toolCallId".to_owned(), Value::String(tool_call_id));
    payload.insert("name".to_owned(), Value::String(tool_name.to_owned()));
    payload.insert(
        "risk".to_owned(),
        Value::String(risk_assessment.risk.as_str().to_owned()),
    );
    payload.insert("argumentsPreview".to_owned(), arguments_preview);
    if !risk_assessment.risk_reasons.is_empty() {
        payload.insert(
            "riskReasons".to_owned(),
            Value::Array(
                risk_assessment
                    .risk_reasons
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }

    Value::Object(payload)
}

fn approval_payload(request: &TurnApprovalRequest) -> Value {
    let mut payload = Map::new();
    payload.insert(
        "approvalId".to_owned(),
        Value::String(request.approval_id.clone()),
    );
    payload.insert(
        "toolCallId".to_owned(),
        Value::String(request.tool_call_id.clone()),
    );
    payload.insert(
        "toolName".to_owned(),
        Value::String(request.tool_name.clone()),
    );
    payload.insert(
        "risk".to_owned(),
        Value::String(request.risk.as_str().to_owned()),
    );
    payload.insert("title".to_owned(), Value::String(request.title.clone()));
    payload.insert("detail".to_owned(), Value::String(request.detail.clone()));
    payload.insert("persistable".to_owned(), Value::Bool(request.persistable));
    if let Some(command) = &request.command {
        payload.insert("command".to_owned(), Value::String(command.clone()));
    }
    if let Some(cwd) = &request.cwd {
        payload.insert("cwd".to_owned(), Value::String(cwd.clone()));
    }
    if let Some(output_summary) = &request.output_summary {
        payload.insert(
            "outputSummary".to_owned(),
            Value::String(output_summary.clone()),
        );
    }
    if let Some(paths) = &request.paths {
        payload.insert(
            "paths".to_owned(),
            Value::Array(paths.iter().cloned().map(Value::String).collect()),
        );
    }
    if let Some(hunks) = &request.hunks {
        payload.insert(
            "hunks".to_owned(),
            serde_json::to_value(hunks).expect("patch approval hunks must serialize"),
        );
    }
    if !request.risk_reasons.is_empty() {
        payload.insert(
            "riskReasons".to_owned(),
            Value::Array(
                request
                    .risk_reasons
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }

    Value::Object(payload)
}

fn approval_resolved_payload(
    request: &TurnApprovalRequest,
    decision: &'static str,
    reason: Option<&str>,
    scope: Option<&ApprovalScope>,
) -> Value {
    let mut payload = Map::new();
    payload.insert(
        "approvalId".to_owned(),
        Value::String(request.approval_id.clone()),
    );
    payload.insert(
        "toolCallId".to_owned(),
        Value::String(request.tool_call_id.clone()),
    );
    payload.insert(
        "toolName".to_owned(),
        Value::String(request.tool_name.clone()),
    );
    payload.insert("decision".to_owned(), Value::String(decision.to_owned()));
    if let Some(reason) = reason {
        payload.insert("reason".to_owned(), Value::String(reason.to_owned()));
    }
    if let Some(scope) = scope {
        let mut scope_payload = Map::new();
        match scope {
            ApprovalScope::All => {
                scope_payload.insert("scope".to_owned(), Value::String("all".to_owned()));
            }
            ApprovalScope::Hunks { hunk_ids } => {
                scope_payload.insert("scope".to_owned(), Value::String("selected".to_owned()));
                scope_payload.insert(
                    "approved".to_owned(),
                    Value::Array(hunk_ids.iter().cloned().map(Value::String).collect()),
                );
            }
        }
        payload.insert("hunks".to_owned(), Value::Object(scope_payload));
    }

    Value::Object(payload)
}

fn provider_error_or_canceled(
    error: TurnProviderError,
    cancellation_token: &CancellationToken,
) -> AgentTurnLoopError {
    if cancellation_token.is_canceled() {
        AgentTurnLoopError::Canceled {
            reason: cancellation_token.cancellation_reason(),
        }
    } else {
        AgentTurnLoopError::Provider(error)
    }
}

fn terminal_error_event(error: &AgentTurnLoopError) -> (&'static str, Value) {
    match error {
        AgentTurnLoopError::ApprovalCanceled {
            approval_id,
            tool_call_id,
            reason,
        }
        | AgentTurnLoopError::ApprovalExpired {
            approval_id,
            tool_call_id,
            reason,
        } => (
            "run.canceled",
            json!({
                "code": error.code(),
                "message": error.to_string(),
                "approvalId": approval_id,
                "toolCallId": tool_call_id,
                "reason": reason,
            }),
        ),
        AgentTurnLoopError::Canceled { reason } => (
            "run.canceled",
            json!({
                "code": error.code(),
                "message": error.to_string(),
                "reason": reason,
            }),
        ),
        _ => (
            "run.failed",
            json!({
                "code": error.code(),
                "message": error.to_string(),
            }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, fs};

    use futures_util::stream;
    use serde_json::json;

    use crate::{
        context::ContextItem,
        provider::deepseek_api::ChatToolCall,
        reasoning::ReasoningContentMode,
        run_log::{RunLogEvent, RunLogStore},
        test_helpers::TestWorkspace,
    };

    use super::{
        AgentRunMode, AgentTurnInput, AgentTurnLoop, AgentTurnLoopConfig, AgentTurnLoopError,
        ApprovalDecision, ApprovalPolicy, ApprovalPolicyError, AutoApprovePolicy,
        CancellationToken, TextRange, TurnApprovalRequest, TurnAttachment, TurnEventSink,
        TurnEventSinkError, TurnProvider, TurnProviderCompletion, TurnProviderDelta,
        TurnProviderError, TurnProviderEvent, TurnProviderFinishReason, TurnProviderFuture,
        TurnProviderRequest, TurnProviderResponse, TurnProviderStream,
        TurnProviderStreamingSummary, TurnProviderUsage, turn_provider_response_stream,
    };

    #[tokio::test]
    async fn turn_loop_runs_read_tool_and_continues_to_final_answer() {
        let workspace = TestWorkspace::new("turn-loop");
        workspace.write("README.md", "hello from README\n");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_read")
            .expect("run should be created");
        let provider = ScriptedProvider::new(vec![
            TurnProviderResponse::tool_calls(
                None,
                Some("I need to inspect the README before answering.".to_owned()),
                vec![ChatToolCall::function(
                    "call_1",
                    "read_file",
                    r#"{"path":"README.md"}"#,
                )],
            ),
            TurnProviderResponse::final_text("README says hello."),
        ]);
        let mut loop_runner =
            AgentTurnLoop::new(workspace.path(), provider).expect("turn loop should initialize");

        let outcome = loop_runner
            .run_turn(
                AgentTurnInput::new("turn_1", "Read README and summarize it")
                    .with_mode(AgentRunMode::Ask)
                    .with_context_item(ContextItem::project_rules(
                        "Answer concisely.",
                        "project instructions",
                    )),
                &mut run,
            )
            .await
            .expect("turn should complete");

        assert_eq!(outcome.final_message, "README says hello.");
        assert_eq!(outcome.iterations, 2);
        assert_eq!(outcome.tool_results.len(), 1);
        assert_eq!(loop_runner.provider.requests.len(), 2);
        assert_eq!(
            loop_runner.provider.requests[1].messages[1]
                .reasoning_content
                .as_deref(),
            Some("I need to inspect the README before answering.")
        );
        assert_eq!(
            loop_runner.provider.requests[1].messages[2]
                .content
                .as_deref()
                .and_then(|content| serde_json::from_str::<serde_json::Value>(content).ok())
                .and_then(|value| value["content"].as_str().map(str::to_owned)),
            Some("hello from README\n".to_owned())
        );

        let events = store.load_run("run_turn_read").expect("events should load");
        let workspace_root = fs::canonicalize(workspace.path())
            .expect("workspace path should canonicalize")
            .display()
            .to_string();
        let event_types = events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            event_types,
            vec![
                "run.started",
                "turn.started",
                "context.built",
                "provider.requested",
                "provider.completed",
                "tool.requested",
                "tool.started",
                "tool.completed",
                "provider.requested",
                "provider.completed",
                "assistant.delta",
                "run.completed",
            ]
        );
        assert_eq!(events[0].payload["workspaceRoot"], workspace_root);
        assert!(
            events[2].payload["includedSources"]
                .as_array()
                .expect("includedSources should be array")
                .iter()
                .any(|source| source["kind"] == json!("workspace_manifest"))
        );
        assert!(
            events[2].payload["manifest"]["manifestHash"]
                .as_str()
                .is_some_and(|hash| hash.starts_with("sha256:"))
        );
        assert!(
            events[2].payload["stablePrefixTokens"]
                .as_u64()
                .unwrap_or_default()
                > 0
        );
        assert!(
            events[2].payload["turnSuffixTokens"]
                .as_u64()
                .unwrap_or_default()
                > 0
        );
        assert_eq!(events[4].payload["model"], "fixture");
        assert_eq!(events[4].payload["finishReason"], "tool_calls");
        assert_eq!(events[9].payload["finishReason"], "stop");
        assert_eq!(events[7].payload["name"], "read_file");
        assert_eq!(
            events[7].payload["result"]["content"],
            "hello from README\n"
        );
    }

    #[tokio::test]
    async fn turn_loop_includes_attachments_in_context() {
        let workspace = TestWorkspace::new("turn-loop");
        workspace.write("README.md", "attached README\nsecond line\n");
        workspace.write("src/lib.rs", "pub fn demo() {}\n");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_attachments")
            .expect("run should be created");
        let provider = ScriptedProvider::new(vec![TurnProviderResponse::final_text(
            "attachments received.",
        )]);
        let mut loop_runner =
            AgentTurnLoop::new(workspace.path(), provider).expect("turn loop should initialize");

        let range = TextRange::new(1, 1, 1, 18);
        let outcome = loop_runner
            .run_turn(
                AgentTurnInput::new("turn_1", "Use the attached context")
                    .with_attachment(TurnAttachment::file("README.md"))
                    .with_attachment(TurnAttachment::selection(
                        "src/lib.rs",
                        range,
                        "pub fn demo() {}",
                    ))
                    .with_attachment(TurnAttachment::explicit_content(
                        "acceptance: mention attachments",
                    ))
                    .with_attachment(TurnAttachment::diagnostic(
                        "src/lib.rs",
                        range,
                        "warning: demo is unused",
                    )),
                &mut run,
            )
            .await
            .expect("turn should complete with attachments");

        assert_eq!(outcome.final_message, "attachments received.");
        let prompt = loop_runner.provider.requests[0].messages[0]
            .content
            .as_deref()
            .expect("provider prompt should include context");
        assert!(prompt.contains("Attachment-Kind: file"));
        assert!(prompt.contains("attached README"));
        assert!(prompt.contains("Kind: selection"));
        assert!(prompt.contains("Attachment-Kind: selection"));
        assert!(prompt.contains("Kind: explicit_content"));
        assert!(prompt.contains("acceptance: mention attachments"));
        assert!(prompt.contains("Kind: diagnostic"));
        assert!(prompt.contains("warning: demo is unused"));

        let events = store
            .load_run("run_turn_attachments")
            .expect("events should load");
        let context_built = events
            .iter()
            .find(|event| event.event_type == "context.built")
            .expect("context.built should be emitted");
        for kind in ["file", "selection", "explicit_content", "diagnostic"] {
            assert!(
                context_built.payload["includedSources"]
                    .as_array()
                    .expect("includedSources should be an array")
                    .iter()
                    .any(|source| source["kind"] == json!(kind)),
                "context should include {kind} attachment source"
            );
        }
    }

    #[tokio::test]
    async fn turn_loop_rejects_duplicate_attachments_before_provider_call() {
        let workspace = TestWorkspace::new("turn-loop");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_duplicate_attachment")
            .expect("run should be created");
        let provider = ScriptedProvider::new(vec![TurnProviderResponse::final_text(
            "should not be called",
        )]);
        let mut loop_runner =
            AgentTurnLoop::new(workspace.path(), provider).expect("turn loop should initialize");

        let error = loop_runner
            .run_turn(
                AgentTurnInput::new("turn_1", "Use duplicated attachments")
                    .with_attachment(TurnAttachment::explicit_content("same"))
                    .with_attachment(TurnAttachment::explicit_content("same")),
                &mut run,
            )
            .await
            .expect_err("duplicate attachment should fail");

        assert!(matches!(
            error,
            AgentTurnLoopError::DuplicateAttachment { .. }
        ));
        assert!(loop_runner.provider.requests.is_empty());
        let events = store
            .load_run("run_turn_duplicate_attachment")
            .expect("events should load");
        assert!(events.iter().any(|event| {
            event.event_type == "run.failed" && event.payload["code"] == "E_INVALID_ATTACHMENT"
        }));
    }

    #[tokio::test]
    async fn turn_loop_rejects_oversized_attachment_before_provider_call() {
        let workspace = TestWorkspace::new("turn-loop");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_oversized_attachment")
            .expect("run should be created");
        let provider = ScriptedProvider::new(vec![TurnProviderResponse::final_text(
            "should not be called",
        )]);
        let config = AgentTurnLoopConfig {
            max_attachment_bytes: 4,
            ..AgentTurnLoopConfig::default()
        };
        let mut loop_runner = AgentTurnLoop::new(workspace.path(), provider)
            .expect("turn loop should initialize")
            .with_config(config);

        let error = loop_runner
            .run_turn(
                AgentTurnInput::new("turn_1", "Use oversized attachment")
                    .with_attachment(TurnAttachment::explicit_content("too large")),
                &mut run,
            )
            .await
            .expect_err("oversized attachment should fail");

        assert!(matches!(
            error,
            AgentTurnLoopError::AttachmentTooLarge { .. }
        ));
        assert!(loop_runner.provider.requests.is_empty());
    }

    #[tokio::test]
    async fn turn_loop_logs_provider_completed_usage_cache_and_stream_summary() {
        let workspace = TestWorkspace::new("turn-loop");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_provider_summary")
            .expect("run should be created");
        let completion =
            TurnProviderCompletion::new("deepseek-v4-pro", TurnProviderFinishReason::Stop)
                .with_usage(TurnProviderUsage {
                    prompt_tokens: Some(100),
                    completion_tokens: Some(20),
                    total_tokens: Some(120),
                    prompt_cache_hit_tokens: Some(64),
                    prompt_cache_miss_tokens: Some(36),
                    reasoning_tokens: Some(8),
                })
                .with_streaming(TurnProviderStreamingSummary {
                    chunk_count: 3,
                    tool_call_delta_count: 0,
                });
        let provider = ScriptedProvider::new(vec![
            TurnProviderResponse::final_text("done").with_completion(completion),
        ]);
        let mut loop_runner =
            AgentTurnLoop::new(workspace.path(), provider).expect("turn loop should initialize");

        loop_runner
            .run_turn(AgentTurnInput::new("turn_1", "Say done"), &mut run)
            .await
            .expect("turn should complete");

        let events = store
            .load_run("run_turn_provider_summary")
            .expect("events should load");
        let provider_completed = events
            .iter()
            .find(|event| event.event_type == "provider.completed")
            .expect("provider.completed should be emitted");
        assert_eq!(provider_completed.payload["iteration"], 1);
        assert_eq!(provider_completed.payload["model"], "deepseek-v4-pro");
        assert_eq!(provider_completed.payload["finishReason"], "stop");
        assert!(provider_completed.payload["durationMs"].as_u64().is_some());
        assert_eq!(provider_completed.payload["usage"]["promptTokens"], 100);
        assert_eq!(
            provider_completed.payload["usage"]["promptCacheHitTokens"],
            64
        );
        assert_eq!(
            provider_completed.payload["usage"]["promptCacheMissTokens"],
            36
        );
        assert_eq!(provider_completed.payload["usage"]["reasoningTokens"], 8);
        assert_eq!(provider_completed.payload["streaming"]["chunkCount"], 3);
        assert_eq!(
            provider_completed.payload["streaming"]["toolCallDeltaCount"],
            0
        );
    }

    #[tokio::test]
    async fn turn_loop_requires_approval_for_shell_before_execution() {
        let workspace = TestWorkspace::new("turn-loop");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_reject")
            .expect("run should be created");
        let provider = ScriptedProvider::new(vec![TurnProviderResponse::tool_calls(
            None,
            Some("I need to run a command.".to_owned()),
            vec![ChatToolCall::function(
                "call_1",
                "shell",
                r#"{"command":"Write-Output hello","timeoutMs":1000}"#,
            )],
        )]);
        let mut loop_runner =
            AgentTurnLoop::new(workspace.path(), provider).expect("turn loop should initialize");

        let error = loop_runner
            .run_turn(AgentTurnInput::new("turn_1", "Run a command"), &mut run)
            .await
            .expect_err("approval rejection should fail the turn");

        assert!(matches!(error, AgentTurnLoopError::ApprovalRejected { .. }));
        let events = store
            .load_run("run_turn_reject")
            .expect("events should load");
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "tool.approvalRequired")
        );
        assert!(
            !events
                .iter()
                .any(|event| event.event_type == "tool.started")
        );
        assert!(events.iter().any(|event| event.event_type == "run.failed"));
    }

    #[tokio::test]
    async fn turn_loop_upgrades_shell_approval_risk_for_dependency_install() {
        let workspace = TestWorkspace::new("turn-loop");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_network_risk")
            .expect("run should be created");
        let provider = ScriptedProvider::new(vec![TurnProviderResponse::tool_calls(
            None,
            Some("I need to install dependencies.".to_owned()),
            vec![ChatToolCall::function(
                "call_shell",
                "shell",
                r#"{"command":"npm install","timeoutMs":1000}"#,
            )],
        )]);
        let mut loop_runner =
            AgentTurnLoop::new(workspace.path(), provider).expect("turn loop should initialize");

        let error = loop_runner
            .run_turn(AgentTurnInput::new("turn_1", "Install deps"), &mut run)
            .await
            .expect_err("default policy should reject upgraded shell approval");

        assert!(matches!(error, AgentTurnLoopError::ApprovalRejected { .. }));
        let events = store
            .load_run("run_turn_network_risk")
            .expect("events should load");
        let requested = events
            .iter()
            .find(|event| event.event_type == "tool.requested")
            .expect("tool.requested should be emitted");
        assert_eq!(requested.payload["risk"], "network");
        assert_eq!(
            requested.payload["riskReasons"],
            json!(["dependency install/update"])
        );
        let approval = events
            .iter()
            .find(|event| event.event_type == "tool.approvalRequired")
            .expect("tool.approvalRequired should be emitted");
        assert_eq!(approval.payload["risk"], "network");
        assert_eq!(approval.payload["command"], "npm install");
        assert_eq!(approval.payload["cwd"], ".");
        assert_eq!(
            approval.payload["riskReasons"],
            json!(["dependency install/update"])
        );
        assert_eq!(approval.payload["persistable"], false);
        assert!(
            approval.payload["detail"]
                .as_str()
                .expect("detail should be text")
                .contains("risk upgrade: dependency install/update")
        );
    }

    #[tokio::test]
    async fn turn_loop_upgrades_shell_approval_risk_for_destructive_command() {
        let workspace = TestWorkspace::new("turn-loop");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_destructive_risk")
            .expect("run should be created");
        let provider = ScriptedProvider::new(vec![TurnProviderResponse::tool_calls(
            None,
            Some("I need to delete build output.".to_owned()),
            vec![ChatToolCall::function(
                "call_shell",
                "shell",
                r#"{"command":"rm -rf target","timeoutMs":1000}"#,
            )],
        )]);
        let mut loop_runner =
            AgentTurnLoop::new(workspace.path(), provider).expect("turn loop should initialize");

        let error = loop_runner
            .run_turn(AgentTurnInput::new("turn_1", "Clean target"), &mut run)
            .await
            .expect_err("default policy should reject destructive shell approval");

        assert!(matches!(error, AgentTurnLoopError::ApprovalRejected { .. }));
        let events = store
            .load_run("run_turn_destructive_risk")
            .expect("events should load");
        let approval = events
            .iter()
            .find(|event| event.event_type == "tool.approvalRequired")
            .expect("tool.approvalRequired should be emitted");
        assert_eq!(approval.payload["risk"], "destructive");
        assert_eq!(approval.payload["riskReasons"], json!(["file deletion"]));
        assert_eq!(approval.payload["persistable"], false);
        assert!(
            !events
                .iter()
                .any(|event| event.event_type == "tool.started")
        );
    }

    #[tokio::test]
    async fn turn_loop_includes_previous_shell_output_summary_in_next_shell_approval() {
        let workspace = TestWorkspace::new("turn-loop");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_shell_output_summary")
            .expect("run should be created");
        #[cfg(windows)]
        let first_command = "Write-Output first; Write-Output second";
        #[cfg(not(windows))]
        let first_command = "printf 'first\\nsecond\\n'";
        #[cfg(windows)]
        let second_command = "Write-Output done";
        #[cfg(not(windows))]
        let second_command = "printf done";
        let provider = ScriptedProvider::new(vec![
            TurnProviderResponse::tool_calls(
                None,
                Some("Run two commands.".to_owned()),
                vec![
                    ChatToolCall::function(
                        "call_shell_1",
                        "shell",
                        json!({
                            "command": first_command,
                            "timeoutMs": 10_000
                        })
                        .to_string(),
                    ),
                    ChatToolCall::function(
                        "call_shell_2",
                        "shell",
                        json!({
                            "command": second_command,
                            "timeoutMs": 10_000
                        })
                        .to_string(),
                    ),
                ],
            ),
            TurnProviderResponse::final_text("Commands finished."),
        ]);
        let mut loop_runner =
            AgentTurnLoop::with_approval_policy(workspace.path(), provider, AutoApprovePolicy)
                .expect("turn loop should initialize");

        loop_runner
            .run_turn(AgentTurnInput::new("turn_1", "Run two commands"), &mut run)
            .await
            .expect("approved shell commands should complete");

        let events = store
            .load_run("run_turn_shell_output_summary")
            .expect("events should load");
        let approvals = events
            .iter()
            .filter(|event| event.event_type == "tool.approvalRequired")
            .collect::<Vec<_>>();
        assert_eq!(approvals.len(), 2);
        assert!(approvals[0].payload.get("outputSummary").is_none());
        let output_summary = approvals[1].payload["outputSummary"]
            .as_str()
            .expect("second approval should include previous shell output summary");
        assert!(output_summary.contains("exitCode: 0"));
        assert!(output_summary.contains("stdout:"));
        assert!(output_summary.contains("second"));
    }

    #[tokio::test]
    async fn turn_loop_rejects_tool_arguments_before_typed_deserialization() {
        let workspace = TestWorkspace::new("turn-loop");
        workspace.write("README.md", "hello\n");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_schema_reject")
            .expect("run should be created");
        let provider = ScriptedProvider::new(vec![TurnProviderResponse::tool_calls(
            None,
            Some("I should read the README.".to_owned()),
            vec![ChatToolCall::function(
                "call_1",
                "read_file",
                r#"{"path":"README.md","unexpected":true}"#,
            )],
        )]);
        let mut loop_runner =
            AgentTurnLoop::new(workspace.path(), provider).expect("turn loop should initialize");

        let error = loop_runner
            .run_turn(AgentTurnInput::new("turn_1", "Read README"), &mut run)
            .await
            .expect_err("schema validation should reject unexpected properties");

        assert!(matches!(
            error,
            AgentTurnLoopError::InvalidToolArgumentSchema { .. }
        ));
        let events = store
            .load_run("run_turn_schema_reject")
            .expect("events should load");
        assert!(
            !events
                .iter()
                .any(|event| event.event_type == "tool.requested")
        );
        assert!(events.iter().any(|event| {
            event.event_type == "run.failed" && event.payload["code"] == "E_INVALID_TOOL_ARGUMENTS"
        }));
    }

    #[tokio::test]
    async fn turn_loop_executes_approved_patch_and_tracks_changed_files() {
        let workspace = TestWorkspace::new("turn-loop");
        workspace.write("README.md", "old\n");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_patch")
            .expect("run should be created");
        let patch = concat!(
            "--- a/README.md\n",
            "+++ b/README.md\n",
            "@@ -1 +1 @@\n",
            "-old\n",
            "+new\n"
        );
        let provider = ScriptedProvider::new(vec![
            TurnProviderResponse::tool_calls(
                None,
                Some("I should edit the README.".to_owned()),
                vec![ChatToolCall::function(
                    "call_1",
                    "apply_patch",
                    json!({
                        "unifiedDiff": patch,
                        "expectedFiles": ["README.md"],
                    })
                    .to_string(),
                )],
            ),
            TurnProviderResponse::final_text("Updated README."),
        ]);
        let mut loop_runner =
            AgentTurnLoop::with_approval_policy(workspace.path(), provider, AutoApprovePolicy)
                .expect("turn loop should initialize");

        let outcome = loop_runner
            .run_turn(AgentTurnInput::new("turn_1", "Update README"), &mut run)
            .await
            .expect("approved patch should complete");

        assert_eq!(workspace.read("README.md"), "new\n");
        assert_eq!(outcome.changed_files, vec!["README.md"]);
        let events = store
            .load_run("run_turn_patch")
            .expect("events should load");
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "tool.approvalRequired")
        );
        let completed = events
            .iter()
            .find(|event| event.event_type == "run.completed")
            .expect("run should complete");
        assert_eq!(completed.payload["changedFiles"], json!(["README.md"]));
    }

    #[tokio::test]
    async fn turn_loop_applies_only_approved_patch_hunks() {
        let workspace = TestWorkspace::new("turn-loop");
        workspace.write("README.md", "one\nold\nthree\n\nkeep\nremove\n");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_patch_hunks")
            .expect("run should be created");
        let patch = concat!(
            "--- a/README.md\n",
            "+++ b/README.md\n",
            "@@ -1,3 +1,3 @@\n",
            " one\n",
            "-old\n",
            "+new\n",
            " three\n",
            "@@ -5,2 +5,3 @@\n",
            " keep\n",
            "+insert\n",
            " remove\n",
        );
        let provider = ScriptedProvider::new(vec![
            TurnProviderResponse::tool_calls(
                None,
                Some("I should edit the README.".to_owned()),
                vec![ChatToolCall::function(
                    "call_1",
                    "apply_patch",
                    json!({
                        "unifiedDiff": patch,
                        "expectedFiles": ["README.md"],
                    })
                    .to_string(),
                )],
            ),
            TurnProviderResponse::final_text("Updated README."),
        ]);
        let mut loop_runner =
            AgentTurnLoop::with_approval_policy(workspace.path(), provider, HunkApprovePolicy)
                .expect("turn loop should initialize");

        let outcome = loop_runner
            .run_turn(AgentTurnInput::new("turn_1", "Update README"), &mut run)
            .await
            .expect("hunk-approved patch should complete");

        assert_eq!(
            workspace.read("README.md"),
            "one\nold\nthree\n\nkeep\ninsert\nremove\n"
        );
        assert_eq!(outcome.changed_files, vec!["README.md"]);
        let events = store
            .load_run("run_turn_patch_hunks")
            .expect("events should load");
        let required = events
            .iter()
            .find(|event| event.event_type == "tool.approvalRequired")
            .expect("approval should be required");
        assert_eq!(required.payload["hunks"].as_array().map(Vec::len), Some(2));
        let resolved = events
            .iter()
            .find(|event| event.event_type == "tool.approvalResolved")
            .expect("approval should resolve");
        assert_eq!(resolved.payload["hunks"]["scope"], "selected");
        assert_eq!(
            resolved.payload["hunks"]["approved"],
            json!(["README.md#2:old5+2:new5+3"])
        );
    }

    #[tokio::test]
    async fn turn_loop_allows_tool_calls_without_reasoning_when_thinking_is_disabled() {
        let workspace = TestWorkspace::new("turn-loop");
        workspace.write("README.md", "old\n");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_patch_thinking_disabled")
            .expect("run should be created");
        let patch = concat!(
            "--- a/README.md\n",
            "+++ b/README.md\n",
            "@@ -1 +1 @@\n",
            "-old\n",
            "+new\n"
        );
        let provider = ScriptedProvider::new(vec![
            TurnProviderResponse::tool_calls(
                None,
                None,
                vec![ChatToolCall::function(
                    "call_1",
                    "apply_patch",
                    json!({
                        "unifiedDiff": patch,
                        "expectedFiles": ["README.md"],
                    })
                    .to_string(),
                )],
            ),
            TurnProviderResponse::final_text("Updated README."),
        ]);
        let config = AgentTurnLoopConfig {
            reasoning_mode: ReasoningContentMode::ThinkingDisabled,
            ..AgentTurnLoopConfig::default()
        };
        let mut loop_runner =
            AgentTurnLoop::with_approval_policy(workspace.path(), provider, AutoApprovePolicy)
                .expect("turn loop should initialize")
                .with_config(config);

        let outcome = loop_runner
            .run_turn(AgentTurnInput::new("turn_1", "Update README"), &mut run)
            .await
            .expect("thinking-disabled tool call should complete without reasoning_content");

        assert_eq!(workspace.read("README.md"), "new\n");
        assert_eq!(outcome.final_message, "Updated README.");
    }

    #[tokio::test]
    async fn turn_loop_logs_streamed_content_deltas_once() {
        let workspace = TestWorkspace::new("turn-loop");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_streaming")
            .expect("run should be created");
        let provider = EventScriptedProvider::new(vec![vec![
            TurnProviderEvent::AssistantDelta(TurnProviderDelta::content("hello ")),
            TurnProviderEvent::AssistantDelta(TurnProviderDelta::reasoning_content(
                "private reasoning",
            )),
            TurnProviderEvent::AssistantDelta(TurnProviderDelta::content("world")),
            TurnProviderEvent::Completed(TurnProviderResponse::final_text("hello world")),
        ]]);
        let mut loop_runner =
            AgentTurnLoop::new(workspace.path(), provider).expect("turn loop should initialize");

        let outcome = loop_runner
            .run_turn(AgentTurnInput::new("turn_1", "Say hello"), &mut run)
            .await
            .expect("streaming turn should complete");

        assert_eq!(outcome.final_message, "hello world");
        let events = store
            .load_run("run_turn_streaming")
            .expect("events should load");
        let deltas = events
            .iter()
            .filter(|event| event.event_type == "assistant.delta")
            .collect::<Vec<_>>();
        assert_eq!(deltas.len(), 2);
        assert_eq!(deltas[0].payload["text"], "hello ");
        assert_eq!(deltas[0].payload["stream"], true);
        assert_eq!(deltas[1].payload["text"], "world");
    }

    #[tokio::test]
    async fn turn_loop_sends_each_persisted_event_to_sink() {
        let workspace = TestWorkspace::new("turn-loop");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_sink")
            .expect("run should be created");
        let provider = EventScriptedProvider::new(vec![vec![
            TurnProviderEvent::AssistantDelta(TurnProviderDelta::content("live")),
            TurnProviderEvent::Completed(TurnProviderResponse::final_text("live")),
        ]]);
        let mut loop_runner =
            AgentTurnLoop::new(workspace.path(), provider).expect("turn loop should initialize");
        let mut sink = RecordingEventSink::default();

        let outcome = loop_runner
            .run_turn_with_event_sink(
                AgentTurnInput::new("turn_1", "Say hello"),
                &mut run,
                &mut sink,
            )
            .await
            .expect("streaming turn should complete");

        assert_eq!(outcome.final_message, "live");
        let events = store.load_run("run_turn_sink").expect("events should load");
        assert_eq!(sink.events, events);
        assert!(
            sink.events
                .iter()
                .any(|event| event.event_type == "assistant.delta")
        );
    }

    #[tokio::test]
    async fn turn_loop_cancels_provider_stream_when_token_is_signaled() {
        let workspace = TestWorkspace::new("turn-loop");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_provider_cancel")
            .expect("run should be created");
        let cancellation_token = CancellationToken::new();
        let provider = EventScriptedProvider::new(vec![vec![
            TurnProviderEvent::AssistantDelta(TurnProviderDelta::content("partial")),
            TurnProviderEvent::Completed(TurnProviderResponse::final_text("complete")),
        ]]);
        let mut loop_runner =
            AgentTurnLoop::new(workspace.path(), provider).expect("turn loop should initialize");
        let mut sink = CancelOnEventSink::new(
            cancellation_token.clone(),
            "assistant.delta",
            "provider canceled by test",
        );

        let error = loop_runner
            .run_turn_with_event_sink(
                AgentTurnInput::new("turn_1", "Cancel during provider stream")
                    .with_cancellation_token(cancellation_token),
                &mut run,
                &mut sink,
            )
            .await
            .expect_err("turn should be canceled");

        assert!(matches!(error, AgentTurnLoopError::Canceled { .. }));
        let events = store
            .load_run("run_turn_provider_cancel")
            .expect("events should load");
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "assistant.delta")
        );
        assert!(events.iter().any(|event| {
            event.event_type == "run.canceled"
                && event.payload["code"] == "E_RUN_CANCELED"
                && event.payload["reason"] == "provider canceled by test"
        }));
    }

    #[tokio::test]
    async fn turn_loop_cancels_shell_tool_when_token_is_signaled() {
        let workspace = TestWorkspace::new("turn-loop");
        let store = RunLogStore::new(workspace.path()).expect("run log store should open");
        let mut run = store
            .create_run("run_turn_tool_cancel")
            .expect("run should be created");
        let cancellation_token = CancellationToken::new();
        #[cfg(windows)]
        let command = "Start-Sleep -Seconds 5; Write-Output done";
        #[cfg(not(windows))]
        let command = "sleep 5; printf done";
        let provider = ScriptedProvider::new(vec![TurnProviderResponse::tool_calls(
            None,
            Some("Run a long command.".to_owned()),
            vec![ChatToolCall::function(
                "call_shell",
                "shell",
                json!({
                    "command": command,
                    "timeoutMs": 10_000
                })
                .to_string(),
            )],
        )]);
        let mut loop_runner =
            AgentTurnLoop::with_approval_policy(workspace.path(), provider, AutoApprovePolicy)
                .expect("turn loop should initialize");
        let mut sink = CancelOnEventSink::new(
            cancellation_token.clone(),
            "tool.started",
            "tool canceled by test",
        );

        let error = loop_runner
            .run_turn_with_event_sink(
                AgentTurnInput::new("turn_1", "Cancel shell")
                    .with_cancellation_token(cancellation_token),
                &mut run,
                &mut sink,
            )
            .await
            .expect_err("turn should be canceled");

        assert!(matches!(error, AgentTurnLoopError::Canceled { .. }));
        let events = store
            .load_run("run_turn_tool_cancel")
            .expect("events should load");
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "tool.started")
        );
        assert!(events.iter().any(|event| {
            event.event_type == "run.canceled"
                && event.payload["code"] == "E_RUN_CANCELED"
                && event.payload["reason"] == "tool canceled by test"
        }));
    }

    struct ScriptedProvider {
        responses: VecDeque<TurnProviderResponse>,
        requests: Vec<TurnProviderRequest>,
    }

    struct HunkApprovePolicy;

    impl ApprovalPolicy for HunkApprovePolicy {
        fn decide(
            &mut self,
            request: &TurnApprovalRequest,
        ) -> Result<ApprovalDecision, ApprovalPolicyError> {
            assert_eq!(request.tool_name, "apply_patch");
            assert_eq!(request.hunks.as_ref().map(Vec::len), Some(2));
            Ok(ApprovalDecision::ApprovedHunks {
                hunk_ids: vec!["README.md#2:old5+2:new5+3".to_owned()],
            })
        }
    }

    impl ScriptedProvider {
        fn new(responses: Vec<TurnProviderResponse>) -> Self {
            Self {
                responses: responses.into(),
                requests: Vec::new(),
            }
        }
    }

    impl TurnProvider for ScriptedProvider {
        fn complete_stream(&mut self, request: TurnProviderRequest) -> TurnProviderFuture<'_> {
            Box::pin(async move {
                self.requests.push(request);
                let response = self
                    .responses
                    .pop_front()
                    .ok_or_else(|| TurnProviderError::new("scripted provider has no response"))?;
                Ok(turn_provider_response_stream(response))
            })
        }
    }

    struct EventScriptedProvider {
        streams: VecDeque<Vec<TurnProviderEvent>>,
    }

    impl EventScriptedProvider {
        fn new(streams: Vec<Vec<TurnProviderEvent>>) -> Self {
            Self {
                streams: streams.into(),
            }
        }
    }

    impl TurnProvider for EventScriptedProvider {
        fn complete_stream(&mut self, _request: TurnProviderRequest) -> TurnProviderFuture<'_> {
            Box::pin(async move {
                let events = self.streams.pop_front().ok_or_else(|| {
                    TurnProviderError::new("event scripted provider has no stream")
                })?;
                let stream: TurnProviderStream = Box::pin(stream::iter(events.into_iter().map(Ok)));
                Ok(stream)
            })
        }
    }

    #[derive(Default)]
    struct RecordingEventSink {
        events: Vec<RunLogEvent>,
    }

    impl TurnEventSink for RecordingEventSink {
        fn on_event(&mut self, event: &RunLogEvent) -> Result<(), TurnEventSinkError> {
            self.events.push(event.clone());
            Ok(())
        }
    }

    struct CancelOnEventSink {
        cancellation_token: CancellationToken,
        event_type: &'static str,
        reason: &'static str,
    }

    impl CancelOnEventSink {
        fn new(
            cancellation_token: CancellationToken,
            event_type: &'static str,
            reason: &'static str,
        ) -> Self {
            Self {
                cancellation_token,
                event_type,
                reason,
            }
        }
    }

    impl TurnEventSink for CancelOnEventSink {
        fn on_event(&mut self, event: &RunLogEvent) -> Result<(), TurnEventSinkError> {
            if event.event_type == self.event_type {
                self.cancellation_token.cancel(self.reason);
            }
            Ok(())
        }
    }
}
