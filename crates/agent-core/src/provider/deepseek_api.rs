use std::{collections::BTreeMap, env, fmt, pin::Pin, str, time::Duration};

use futures_util::{Stream, StreamExt};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use url::Url;

pub const DEFAULT_API_BASE_URL: &str = "https://api.deepseek.com";
pub const DEFAULT_FIM_API_BASE_URL: &str = "https://api.deepseek.com/beta";
pub const DEFAULT_MODEL: &str = DeepSeekModelId::V4_PRO;
const CHAT_COMPLETIONS_PATH: &str = "chat/completions";
const FIM_COMPLETIONS_PATH: &str = "completions";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);
const FIM_MAX_TOKENS_LIMIT: u32 = 4096;

#[derive(Debug, Error)]
pub enum DeepSeekApiError {
    #[error("DEEPSEEK_API_KEY is required")]
    MissingApiKey,
    #[error("model id must not be empty")]
    EmptyModelId,
    #[error("invalid DeepSeek API base URL `{value}`: {source}")]
    InvalidBaseUrl {
        value: String,
        source: url::ParseError,
    },
    #[error("DeepSeek API base URL must use http or https, got `{scheme}`")]
    UnsupportedBaseUrlScheme { scheme: String },
    #[error("chat completion request must include at least one message")]
    EmptyMessages,
    #[error("FIM completion request prefix must not be empty")]
    EmptyFimPrefix,
    #[error("FIM completion max_tokens must be between 1 and {FIM_MAX_TOKENS_LIMIT}")]
    InvalidFimMaxTokens,
    #[error("reasoning_effort requires thinking.type = enabled")]
    ReasoningEffortRequiresEnabledThinking,
    #[error("tool_choice is not supported while DeepSeek thinking mode is enabled")]
    ToolChoiceUnsupportedWithThinking,
    #[error("non-stream chat completion call received a streaming request")]
    StreamingRequestInNonStreamCall,
    #[error("DeepSeek API request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("DeepSeek API returned HTTP {status}: {body}")]
    Api { status: StatusCode, body: String },
    #[error("DeepSeek API JSON response is invalid: {source}; body: {body}")]
    InvalidJson {
        source: serde_json::Error,
        body: String,
    },
    #[error("DeepSeek stream event JSON is invalid: {source}; data: {data}")]
    InvalidStreamJson {
        source: serde_json::Error,
        data: String,
    },
    #[error("DeepSeek stream event is not valid UTF-8: {0}")]
    InvalidStreamUtf8(#[from] str::Utf8Error),
    #[error("DeepSeek stream ended with an incomplete SSE event ({buffered_bytes} buffered bytes)")]
    IncompleteStreamEvent { buffered_bytes: usize },
}

pub type ChatCompletionStream =
    Pin<Box<dyn Stream<Item = Result<StreamEvent, DeepSeekApiError>> + Send>>;

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeepSeekModelId(String);

impl DeepSeekModelId {
    pub const V4_FLASH: &'static str = "deepseek-v4-flash";
    pub const V4_PRO: &'static str = "deepseek-v4-pro";

    pub fn new(value: impl Into<String>) -> Result<Self, DeepSeekApiError> {
        let value = value.into();
        let value = value.trim();
        if value.is_empty() {
            return Err(DeepSeekApiError::EmptyModelId);
        }

        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for DeepSeekModelId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("DeepSeekModelId")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for DeepSeekModelId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone)]
pub struct DeepSeekApiConfig {
    api_key: String,
    base_url: Url,
    model: DeepSeekModelId,
    timeout: Duration,
}

impl DeepSeekApiConfig {
    pub fn new(
        api_key: impl Into<String>,
        base_url: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, DeepSeekApiError> {
        let api_key = api_key.into();
        let api_key = api_key.trim();
        if api_key.trim().is_empty() {
            return Err(DeepSeekApiError::MissingApiKey);
        }

        let base_url = base_url.into();
        let base_url =
            Url::parse(base_url.trim()).map_err(|source| DeepSeekApiError::InvalidBaseUrl {
                value: base_url,
                source,
            })?;
        if !matches!(base_url.scheme(), "http" | "https") {
            return Err(DeepSeekApiError::UnsupportedBaseUrlScheme {
                scheme: base_url.scheme().to_owned(),
            });
        }

        Ok(Self {
            api_key: api_key.to_owned(),
            base_url,
            model: DeepSeekModelId::new(model)?,
            timeout: DEFAULT_TIMEOUT,
        })
    }

    pub fn from_env() -> Result<Self, DeepSeekApiError> {
        let api_key = env::var("DEEPSEEK_API_KEY").map_err(|_| DeepSeekApiError::MissingApiKey)?;
        let base_url =
            env::var("DEEPSEEK_BASE_URL").unwrap_or_else(|_| DEFAULT_API_BASE_URL.to_owned());
        let model = env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_owned());
        Self::new(api_key, base_url, model)
    }

    pub fn from_env_for_fim() -> Result<Self, DeepSeekApiError> {
        // DeepSeek chat and beta FIM endpoints currently share the same API key.
        let api_key = env::var("DEEPSEEK_API_KEY").map_err(|_| DeepSeekApiError::MissingApiKey)?;
        let base_url =
            env::var("DEEPSEEK_BASE_URL").unwrap_or_else(|_| DEFAULT_FIM_API_BASE_URL.to_owned());
        let model = env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_owned());
        Self::new(api_key, base_url, model)
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    pub fn model(&self) -> &DeepSeekModelId {
        &self.model
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    fn endpoint(&self, path: &str) -> Result<Url, DeepSeekApiError> {
        let mut base_url = self.base_url.clone();
        if !base_url.path().ends_with('/') {
            let mut path = base_url.path().to_owned();
            path.push('/');
            base_url.set_path(&path);
        }

        base_url
            .join(path)
            .map_err(|source| DeepSeekApiError::InvalidBaseUrl {
                value: self.base_url.to_string(),
                source,
            })
    }
}

impl fmt::Debug for DeepSeekApiConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeepSeekApiConfig")
            .field("api_key", &"<redacted>")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("timeout", &self.timeout)
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct DeepSeekApiAdapter {
    client: reqwest::Client,
    config: DeepSeekApiConfig,
}

impl DeepSeekApiAdapter {
    pub fn new(config: DeepSeekApiConfig) -> Result<Self, DeepSeekApiError> {
        let client = reqwest::Client::builder()
            .timeout(config.timeout())
            .build()?;

        Ok(Self { client, config })
    }

    pub fn config(&self) -> &DeepSeekApiConfig {
        &self.config
    }

    pub fn new_chat_request(
        &self,
        messages: Vec<ChatMessage>,
    ) -> Result<ChatCompletionRequest, DeepSeekApiError> {
        ChatCompletionRequest::new(self.config.model().clone(), messages)
    }

    pub async fn create_chat_completion(
        &self,
        request: ChatCompletionRequest,
    ) -> Result<ChatCompletionResponse, DeepSeekApiError> {
        request.validate_for_deepseek()?;
        if request.stream.unwrap_or(false) {
            return Err(DeepSeekApiError::StreamingRequestInNonStreamCall);
        }

        let response = self
            .client
            .post(self.config.endpoint(CHAT_COMPLETIONS_PATH)?)
            .bearer_auth(&self.config.api_key)
            .json(&request)
            .send()
            .await?;

        decode_chat_completion_response(response).await
    }

    pub async fn create_chat_completion_stream(
        &self,
        request: ChatCompletionRequest,
    ) -> Result<ChatCompletionStream, DeepSeekApiError> {
        let request = request.streaming_with_usage_by_default();
        request.validate_for_deepseek()?;

        let response = self
            .client
            .post(self.config.endpoint(CHAT_COMPLETIONS_PATH)?)
            .bearer_auth(&self.config.api_key)
            .json(&request)
            .send()
            .await?;

        decode_chat_completion_stream(response).await
    }

    pub async fn create_fim_completion(
        &self,
        request: FimCompletionRequest,
    ) -> Result<FimCompletionResponse, DeepSeekApiError> {
        request.validate_for_deepseek()?;
        let response = self
            .client
            .post(self.config.endpoint(FIM_COMPLETIONS_PATH)?)
            .bearer_auth(&self.config.api_key)
            .json(&request)
            .send()
            .await?;

        decode_fim_completion_response(response).await
    }
}

async fn decode_chat_completion_response(
    response: reqwest::Response,
) -> Result<ChatCompletionResponse, DeepSeekApiError> {
    let status = response.status();
    let body = response.text().await?;

    if !status.is_success() {
        return Err(DeepSeekApiError::Api { status, body });
    }

    serde_json::from_str(&body).map_err(|source| DeepSeekApiError::InvalidJson { source, body })
}

async fn decode_fim_completion_response(
    response: reqwest::Response,
) -> Result<FimCompletionResponse, DeepSeekApiError> {
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(DeepSeekApiError::Api { status, body });
    }

    serde_json::from_str(&body).map_err(|source| DeepSeekApiError::InvalidJson { source, body })
}

async fn decode_chat_completion_stream(
    response: reqwest::Response,
) -> Result<ChatCompletionStream, DeepSeekApiError> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await?;
        return Err(DeepSeekApiError::Api { status, body });
    }

    let mut byte_stream = response.bytes_stream();

    Ok(Box::pin(async_stream::try_stream! {
        let mut parser = SseEventParser::new();

        while let Some(chunk) = byte_stream.next().await {
            let chunk = chunk?;
            for event in parser.push_bytes(&chunk)? {
                let done = event == StreamEvent::Done;
                yield event;

                if done {
                    return;
                }
            }
        }

        for event in parser.finish()? {
            yield event;
        }
    }))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatCompletionRequest {
    pub model: DeepSeekModelId,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<ResponseFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<StreamOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ChatTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<ToolChoice>,
}

impl ChatCompletionRequest {
    pub fn new(
        model: DeepSeekModelId,
        messages: Vec<ChatMessage>,
    ) -> Result<Self, DeepSeekApiError> {
        if messages.is_empty() {
            return Err(DeepSeekApiError::EmptyMessages);
        }

        Ok(Self {
            model,
            messages,
            thinking: Some(ThinkingConfig::enabled()),
            reasoning_effort: Some(ReasoningEffort::High),
            max_tokens: None,
            response_format: None,
            stream: None,
            stream_options: None,
            tools: None,
            tool_choice: None,
        })
    }

    pub fn with_thinking(mut self, thinking: ThinkingConfig) -> Self {
        if thinking.kind == ThinkingMode::Disabled {
            self.reasoning_effort = None;
        }
        self.thinking = Some(thinking);
        self
    }

    pub fn with_reasoning_effort(mut self, reasoning_effort: ReasoningEffort) -> Self {
        self.thinking = Some(ThinkingConfig::enabled());
        self.reasoning_effort = Some(reasoning_effort);
        self
    }

    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }

    pub fn with_tools(mut self, tools: Vec<ChatTool>) -> Self {
        self.tools = Some(tools);
        self
    }

    pub fn with_tool_choice(mut self, tool_choice: ToolChoice) -> Self {
        self.tool_choice = Some(tool_choice);
        self
    }

    pub fn streaming(mut self, include_usage: bool) -> Self {
        self.stream = Some(true);
        self.stream_options = Some(StreamOptions { include_usage });
        self
    }

    pub fn validate_for_deepseek(&self) -> Result<(), DeepSeekApiError> {
        if self
            .thinking
            .as_ref()
            .is_some_and(|thinking| thinking.kind == ThinkingMode::Disabled)
            && self.reasoning_effort.is_some()
        {
            return Err(DeepSeekApiError::ReasoningEffortRequiresEnabledThinking);
        }

        if self.tool_choice.is_some()
            && !self
                .thinking
                .as_ref()
                .is_some_and(|thinking| thinking.kind == ThinkingMode::Disabled)
        {
            return Err(DeepSeekApiError::ToolChoiceUnsupportedWithThinking);
        }

        Ok(())
    }

    fn streaming_with_usage_by_default(mut self) -> Self {
        self.stream = Some(true);
        if self.stream_options.is_none() {
            self.stream_options = Some(StreamOptions {
                include_usage: true,
            });
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FimCompletionRequest {
    pub model: DeepSeekModelId,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
}

impl FimCompletionRequest {
    pub fn new(
        model: DeepSeekModelId,
        prompt: impl Into<String>,
    ) -> Result<Self, DeepSeekApiError> {
        let prompt = prompt.into();
        if prompt.is_empty() {
            return Err(DeepSeekApiError::EmptyFimPrefix);
        }

        Ok(Self {
            model,
            prompt,
            suffix: None,
            max_tokens: None,
            stream: Some(false),
        })
    }

    pub fn with_suffix(mut self, suffix: impl Into<String>) -> Self {
        self.suffix = Some(suffix.into());
        self
    }

    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }

    pub fn validate_for_deepseek(&self) -> Result<(), DeepSeekApiError> {
        if self.prompt.is_empty() {
            return Err(DeepSeekApiError::EmptyFimPrefix);
        }
        if let Some(max_tokens) = self.max_tokens
            && !(1..=FIM_MAX_TOKENS_LIMIT).contains(&max_tokens)
        {
            return Err(DeepSeekApiError::InvalidFimMaxTokens);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThinkingConfig {
    #[serde(rename = "type")]
    pub kind: ThinkingMode,
}

impl ThinkingConfig {
    pub const fn enabled() -> Self {
        Self {
            kind: ThinkingMode::Enabled,
        }
    }

    pub const fn disabled() -> Self {
        Self {
            kind: ThinkingMode::Disabled,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingMode {
    Enabled,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    High,
    Max,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseFormat {
    #[serde(rename = "type")]
    pub kind: ResponseFormatType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseFormatType {
    Text,
    JsonObject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamOptions {
    pub include_usage: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ChatToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self::text(ChatRole::System, content)
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::text(ChatRole::User, content)
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::text(ChatRole::Assistant, content)
    }

    pub fn assistant_with_tool_calls(
        content: Option<String>,
        reasoning_content: Option<String>,
        tool_calls: Vec<ChatToolCall>,
    ) -> Self {
        Self {
            role: ChatRole::Assistant,
            // Keep content present for assistant tool-call replay; provider responses may omit
            // text, but the replay message should still serialize a stable content field.
            content: Some(content.unwrap_or_default()),
            name: None,
            prefix: None,
            reasoning_content,
            tool_calls: Some(tool_calls),
            tool_call_id: None,
        }
    }

    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Tool,
            content: Some(content.into()),
            name: None,
            prefix: None,
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
        }
    }

    fn text(role: ChatRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: Some(content.into()),
            name: None,
            prefix: None,
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatTool {
    #[serde(rename = "type")]
    pub kind: ChatToolType,
    pub function: ChatFunctionDefinition,
}

impl ChatTool {
    pub fn function(function: ChatFunctionDefinition) -> Self {
        Self {
            kind: ChatToolType::Function,
            function,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatToolType {
    Function,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatFunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolChoice {
    Mode(ToolChoiceMode),
    Function(ToolChoiceFunction),
}

impl ToolChoice {
    pub fn mode(mode: ToolChoiceMode) -> Self {
        Self::Mode(mode)
    }

    pub fn function(name: impl Into<String>) -> Self {
        Self::Function(ToolChoiceFunction {
            kind: ChatToolType::Function,
            function: ToolChoiceFunctionName { name: name.into() },
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolChoiceMode {
    None,
    Auto,
    Required,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolChoiceFunction {
    #[serde(rename = "type")]
    pub kind: ChatToolType,
    pub function: ToolChoiceFunctionName,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolChoiceFunctionName {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ChatToolType,
    pub function: ChatFunctionCall,
}

impl ChatToolCall {
    pub fn function(
        id: impl Into<String>,
        name: impl Into<String>,
        arguments: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            kind: ChatToolType::Function,
            function: ChatFunctionCall {
                name: name.into(),
                arguments: arguments.into(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatFunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChatToolCallDelta {
    pub index: u32,
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<ChatToolType>,
    pub function: Option<ChatFunctionCallDelta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ChatFunctionCallDelta {
    pub name: Option<String>,
    pub arguments: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct ChatToolCallAccumulator {
    entries: BTreeMap<u32, ChatToolCallAccumulatorEntry>,
}

impl ChatToolCallAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn append_delta(
        &mut self,
        delta: ChatToolCallDelta,
    ) -> Result<(), ChatToolCallAccumulatorError> {
        let index = delta.index;
        let entry = self.entries.entry(index).or_default();

        if let Some(id) = delta.id {
            if id.is_empty() {
                return Err(ChatToolCallAccumulatorError::EmptyToolCallId { index });
            }

            match &entry.id {
                Some(existing) if existing != &id => {
                    return Err(ChatToolCallAccumulatorError::ConflictingToolCallId {
                        index,
                        existing: existing.clone(),
                        incoming: id,
                    });
                }
                Some(_) => {}
                None => entry.id = Some(id),
            }
        }

        if let Some(kind) = delta.kind {
            match entry.kind {
                Some(existing) if existing != kind => {
                    return Err(ChatToolCallAccumulatorError::ConflictingToolCallType {
                        index,
                        existing,
                        incoming: kind,
                    });
                }
                Some(_) => {}
                None => entry.kind = Some(kind),
            }
        }

        if let Some(function) = delta.function {
            if let Some(name) = function.name {
                if name.is_empty() {
                    return Err(ChatToolCallAccumulatorError::EmptyFunctionName { index });
                }

                match &entry.function_name {
                    Some(existing) if existing != &name => {
                        return Err(ChatToolCallAccumulatorError::ConflictingFunctionName {
                            index,
                            existing: existing.clone(),
                            incoming: name,
                        });
                    }
                    Some(_) => {}
                    None => entry.function_name = Some(name),
                }
            }

            if let Some(arguments) = function.arguments {
                entry.arguments.push_str(&arguments);
            }
        }

        Ok(())
    }

    pub fn finish(self) -> Result<Vec<ChatToolCall>, ChatToolCallAccumulatorError> {
        self.entries
            .into_iter()
            .map(|(index, entry)| {
                let id = entry
                    .id
                    .ok_or(ChatToolCallAccumulatorError::MissingToolCallId { index })?;
                let kind = entry
                    .kind
                    .ok_or(ChatToolCallAccumulatorError::MissingToolCallType { index })?;
                let name = entry
                    .function_name
                    .ok_or(ChatToolCallAccumulatorError::MissingFunctionName { index })?;

                Ok(ChatToolCall {
                    id,
                    kind,
                    function: ChatFunctionCall {
                        name,
                        arguments: entry.arguments,
                    },
                })
            })
            .collect()
    }
}

#[derive(Debug, Default, Clone)]
struct ChatToolCallAccumulatorEntry {
    id: Option<String>,
    kind: Option<ChatToolType>,
    function_name: Option<String>,
    arguments: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ChatToolCallAccumulatorError {
    #[error("tool call delta at index {index} has an empty id")]
    EmptyToolCallId { index: u32 },
    #[error("tool call delta at index {index} has an empty function name")]
    EmptyFunctionName { index: u32 },
    #[error("tool call delta at index {index} changed id from `{existing}` to `{incoming}`")]
    ConflictingToolCallId {
        index: u32,
        existing: String,
        incoming: String,
    },
    #[error("tool call delta at index {index} changed type from `{existing:?}` to `{incoming:?}`")]
    ConflictingToolCallType {
        index: u32,
        existing: ChatToolType,
        incoming: ChatToolType,
    },
    #[error(
        "tool call delta at index {index} changed function name from `{existing}` to `{incoming}`"
    )]
    ConflictingFunctionName {
        index: u32,
        existing: String,
        incoming: String,
    },
    #[error("tool call stream ended before index {index} emitted an id")]
    MissingToolCallId { index: u32 },
    #[error("tool call stream ended before index {index} emitted a type")]
    MissingToolCallType { index: u32 },
    #[error("tool call stream ended before index {index} emitted a function name")]
    MissingFunctionName { index: u32 },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChatCompletionResponse {
    pub id: String,
    pub choices: Vec<ChatCompletionChoice>,
    pub created: u64,
    pub model: String,
    pub object: String,
    pub usage: Option<Usage>,
    pub system_fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChatCompletionChoice {
    pub index: u32,
    pub message: ChatCompletionMessage,
    pub finish_reason: Option<FinishReason>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChatCompletionMessage {
    pub role: Option<ChatRole>,
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls: Option<Vec<ChatToolCall>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FimCompletionResponse {
    pub id: String,
    pub choices: Vec<FimCompletionChoice>,
    pub created: u64,
    pub model: String,
    pub object: String,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FimCompletionChoice {
    pub index: u32,
    pub text: String,
    pub finish_reason: Option<FinishReason>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChatCompletionChunk {
    pub id: String,
    pub choices: Vec<ChatCompletionChunkChoice>,
    pub created: u64,
    pub model: String,
    pub object: String,
    pub usage: Option<Usage>,
    pub system_fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChatCompletionChunkChoice {
    pub index: u32,
    pub delta: ChatCompletionDelta,
    pub finish_reason: Option<FinishReason>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChatCompletionDelta {
    pub role: Option<ChatRole>,
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls: Option<Vec<ChatToolCallDelta>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    InsufficientSystemResource,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub prompt_cache_hit_tokens: Option<u64>,
    pub prompt_cache_miss_tokens: Option<u64>,
    pub completion_tokens_details: Option<CompletionTokensDetails>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CompletionTokensDetails {
    pub reasoning_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    Chunk(ChatCompletionChunk),
    Done,
}

#[derive(Debug, Default)]
pub struct SseEventParser {
    buffer: Vec<u8>,
}

impl SseEventParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_bytes(&mut self, bytes: &[u8]) -> Result<Vec<StreamEvent>, DeepSeekApiError> {
        self.buffer.extend_from_slice(bytes);

        let mut events = Vec::new();
        while let Some(boundary) = find_sse_event_boundary(&self.buffer) {
            let event_bytes: Vec<u8> = self.buffer.drain(..boundary.block_end).collect();
            self.buffer.drain(..boundary.separator_len);

            let event_block = str::from_utf8(&event_bytes)?;
            if let Some(event) = parse_stream_event_block(event_block)? {
                let done = event == StreamEvent::Done;
                events.push(event);

                if done {
                    break;
                }
            }
        }

        Ok(events)
    }

    pub fn finish(self) -> Result<Vec<StreamEvent>, DeepSeekApiError> {
        if self.buffer.is_empty() || self.buffer.iter().all(u8::is_ascii_whitespace) {
            return Ok(Vec::new());
        }

        Err(DeepSeekApiError::IncompleteStreamEvent {
            buffered_bytes: self.buffer.len(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SseEventBoundary {
    block_end: usize,
    separator_len: usize,
}

fn find_sse_event_boundary(buffer: &[u8]) -> Option<SseEventBoundary> {
    for index in 0..buffer.len() {
        if buffer[index] == b'\n' {
            if buffer.get(index + 1) == Some(&b'\n') {
                return Some(SseEventBoundary {
                    block_end: index,
                    separator_len: 2,
                });
            }

            if buffer.get(index + 1) == Some(&b'\r') && buffer.get(index + 2) == Some(&b'\n') {
                return Some(SseEventBoundary {
                    block_end: index,
                    separator_len: 3,
                });
            }
        }

        if buffer[index] == b'\r'
            && buffer.get(index + 1) == Some(&b'\n')
            && buffer.get(index + 2) == Some(&b'\r')
            && buffer.get(index + 3) == Some(&b'\n')
        {
            return Some(SseEventBoundary {
                block_end: index,
                separator_len: 4,
            });
        }
    }

    None
}

pub fn parse_stream_event_block(block: &str) -> Result<Option<StreamEvent>, DeepSeekApiError> {
    let mut data_lines = Vec::new();

    for line in block.lines() {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }

        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.strip_prefix(' ').unwrap_or(data));
        }
    }

    if data_lines.is_empty() {
        return Ok(None);
    }

    let data = data_lines.join("\n");
    if data == "[DONE]" {
        return Ok(Some(StreamEvent::Done));
    }

    let chunk = serde_json::from_str(&data)
        .map_err(|source| DeepSeekApiError::InvalidStreamJson { source, data })?;

    Ok(Some(StreamEvent::Chunk(chunk)))
}

#[cfg(test)]
mod tests {
    use super::{
        ChatCompletionRequest, ChatFunctionCallDelta, ChatMessage, ChatTool, ChatToolCall,
        ChatToolCallAccumulator, ChatToolCallAccumulatorError, ChatToolCallDelta, ChatToolType,
        DeepSeekApiConfig, DeepSeekApiError, DeepSeekModelId, FimCompletionRequest,
        ReasoningEffort, SseEventParser, StreamEvent, StreamOptions, ThinkingConfig, ToolChoice,
        parse_stream_event_block,
    };

    #[test]
    fn config_redacts_api_key_from_debug() {
        let config = DeepSeekApiConfig::new(
            "test-api-key",
            "https://api.deepseek.com",
            DeepSeekModelId::V4_PRO,
        )
        .expect("config should be valid");

        let debug = format!("{config:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("test-api-key"));
    }

    #[test]
    fn config_rejects_non_http_base_url() {
        let error = DeepSeekApiConfig::new(
            "test-api-key",
            "ftp://example.invalid",
            DeepSeekModelId::V4_PRO,
        )
        .expect_err("file URLs must not be accepted");

        assert!(matches!(
            error,
            super::DeepSeekApiError::UnsupportedBaseUrlScheme { .. }
        ));
    }

    #[test]
    fn endpoint_preserves_base_url_path() {
        let config = DeepSeekApiConfig::new(
            "test-api-key",
            "https://api.deepseek.com/beta",
            DeepSeekModelId::V4_PRO,
        )
        .expect("config should be valid");

        let endpoint = config
            .endpoint("chat/completions")
            .expect("endpoint should be valid");

        assert_eq!(
            endpoint.as_str(),
            "https://api.deepseek.com/beta/chat/completions"
        );
    }

    #[test]
    fn fim_request_serializes_prefix_suffix_and_non_streaming_default() {
        let request = FimCompletionRequest::new(
            DeepSeekModelId::new(DeepSeekModelId::V4_PRO).expect("model should be valid"),
            "fn main() {",
        )
        .expect("FIM request should be valid")
        .with_suffix("}")
        .with_max_tokens(32);

        let json = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(json["model"], "deepseek-v4-pro");
        assert_eq!(json["prompt"], "fn main() {");
        assert_eq!(json["suffix"], "}");
        assert_eq!(json["max_tokens"], 32);
        assert_eq!(json["stream"], false);
    }

    #[test]
    fn fim_request_rejects_invalid_max_tokens() {
        let request = FimCompletionRequest::new(
            DeepSeekModelId::new(DeepSeekModelId::V4_PRO).expect("model should be valid"),
            "prefix",
        )
        .expect("FIM request should be valid")
        .with_max_tokens(0);

        let error = request
            .validate_for_deepseek()
            .expect_err("zero FIM max_tokens should fail");

        assert!(matches!(error, DeepSeekApiError::InvalidFimMaxTokens));
    }

    #[test]
    fn fim_response_deserializes_text_choice() {
        let response = r#"{
          "id": "fim-test",
          "object": "text_completion",
          "created": 1710000000,
          "model": "deepseek-v4-pro",
          "choices": [
            { "index": 0, "text": " println!(\"hi\"); ", "finish_reason": "stop" }
          ],
          "usage": {
            "prompt_tokens": 3,
            "completion_tokens": 2,
            "total_tokens": 5
          }
        }"#;

        let response: super::FimCompletionResponse =
            serde_json::from_str(response).expect("FIM response should parse");

        assert_eq!(response.choices[0].text, " println!(\"hi\"); ");
        assert_eq!(
            response.choices[0].finish_reason,
            Some(super::FinishReason::Stop)
        );
    }

    #[test]
    fn request_serializes_thinking_payload() {
        let request = ChatCompletionRequest::new(
            DeepSeekModelId::new(DeepSeekModelId::V4_PRO).expect("model should be valid"),
            vec![ChatMessage::user("hello")],
        )
        .expect("request should be valid")
        .with_thinking(ThinkingConfig::enabled())
        .with_reasoning_effort(ReasoningEffort::Max)
        .streaming(true);

        let json = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(json["model"], "deepseek-v4-pro");
        assert_eq!(json["thinking"]["type"], "enabled");
        assert_eq!(json["reasoning_effort"], "max");
        assert_eq!(json["stream"], true);
        assert_eq!(json["stream_options"]["include_usage"], true);
    }

    #[test]
    fn disabling_thinking_omits_reasoning_effort() {
        let request = ChatCompletionRequest::new(
            DeepSeekModelId::new(DeepSeekModelId::V4_FLASH).expect("model should be valid"),
            vec![ChatMessage::user("hello")],
        )
        .expect("request should be valid")
        .with_thinking(ThinkingConfig::disabled());

        let json = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(json["thinking"]["type"], "disabled");
        assert!(
            json.get("reasoning_effort").is_none(),
            "reasoning_effort must not be sent with disabled thinking"
        );
    }

    #[test]
    fn reasoning_effort_enables_thinking() {
        let request = ChatCompletionRequest::new(
            DeepSeekModelId::new(DeepSeekModelId::V4_FLASH).expect("model should be valid"),
            vec![ChatMessage::user("hello")],
        )
        .expect("request should be valid")
        .with_thinking(ThinkingConfig::disabled())
        .with_reasoning_effort(ReasoningEffort::Max);

        let json = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(json["thinking"]["type"], "enabled");
        assert_eq!(json["reasoning_effort"], "max");
    }

    #[test]
    fn validation_rejects_reasoning_effort_with_disabled_thinking() {
        let mut request = ChatCompletionRequest::new(
            DeepSeekModelId::new(DeepSeekModelId::V4_FLASH).expect("model should be valid"),
            vec![ChatMessage::user("hello")],
        )
        .expect("request should be valid")
        .with_thinking(ThinkingConfig::disabled());
        request.reasoning_effort = Some(ReasoningEffort::High);

        let error = request
            .validate_for_deepseek()
            .expect_err("disabled thinking with reasoning_effort must fail");

        assert!(matches!(
            error,
            DeepSeekApiError::ReasoningEffortRequiresEnabledThinking
        ));
    }

    #[test]
    fn streaming_request_sets_usage_by_default() {
        let request = ChatCompletionRequest::new(
            DeepSeekModelId::new(DeepSeekModelId::V4_PRO).expect("model should be valid"),
            vec![ChatMessage::user("hello")],
        )
        .expect("request should be valid")
        .streaming_with_usage_by_default();

        assert_eq!(request.stream, Some(true));
        assert_eq!(
            request.stream_options,
            Some(StreamOptions {
                include_usage: true
            })
        );
    }

    #[test]
    fn streaming_request_preserves_explicit_stream_options() {
        let request = ChatCompletionRequest::new(
            DeepSeekModelId::new(DeepSeekModelId::V4_PRO).expect("model should be valid"),
            vec![ChatMessage::user("hello")],
        )
        .expect("request should be valid")
        .streaming(false)
        .streaming_with_usage_by_default();

        assert_eq!(
            request.stream_options,
            Some(StreamOptions {
                include_usage: false
            })
        );
    }

    #[test]
    fn response_deserializes_reasoning_content_tool_calls_and_usage() {
        let response = r#"{
          "id": "chatcmpl-test",
          "object": "chat.completion",
          "created": 1710000000,
          "model": "deepseek-v4-pro",
          "system_fingerprint": "fp_test",
          "choices": [
            {
              "index": 0,
              "message": {
                "role": "assistant",
                "reasoning_content": "Need a tool.",
                "content": null,
                "tool_calls": [
                  {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                      "name": "read_file",
                      "arguments": "{\"path\":\"README.md\"}"
                    }
                  }
                ]
              },
              "finish_reason": "tool_calls"
            }
          ],
          "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
            "prompt_cache_hit_tokens": 7,
            "prompt_cache_miss_tokens": 3,
            "completion_tokens_details": {
              "reasoning_tokens": 4
            }
          }
        }"#;

        let parsed: super::ChatCompletionResponse =
            serde_json::from_str(response).expect("response should deserialize");

        assert_eq!(
            parsed.choices[0].message.reasoning_content.as_deref(),
            Some("Need a tool.")
        );
        assert_eq!(
            parsed.choices[0].message.tool_calls.as_ref().map(Vec::len),
            Some(1)
        );
        assert_eq!(
            parsed
                .usage
                .and_then(|usage| usage.completion_tokens_details)
                .and_then(|details| details.reasoning_tokens),
            Some(4)
        );
    }

    #[test]
    fn stream_parser_handles_keep_alive_chunk_and_done() {
        let keep_alive =
            parse_stream_event_block(": keep-alive\n\n").expect("keep-alive should parse");
        assert_eq!(keep_alive, None);

        let chunk = r#"data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1710000000,"model":"deepseek-v4-pro","system_fingerprint":null,"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking","content":null},"finish_reason":null}],"usage":null}"#;
        let event = parse_stream_event_block(chunk).expect("chunk should parse");

        match event {
            Some(StreamEvent::Chunk(chunk)) => {
                assert_eq!(
                    chunk.choices[0].delta.reasoning_content.as_deref(),
                    Some("thinking")
                );
                assert_eq!(chunk.choices[0].delta.content, None);
            }
            Some(StreamEvent::Done) | None => panic!("expected stream chunk"),
        }

        let done = parse_stream_event_block("data: [DONE]\n\n").expect("done should parse");
        assert_eq!(done, Some(StreamEvent::Done));
    }

    #[test]
    fn stream_parser_handles_usage_chunk() {
        let event = parse_stream_event_block(
            r#"data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1710000000,"model":"deepseek-v4-pro","system_fingerprint":null,"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"prompt_cache_hit_tokens":1,"prompt_cache_miss_tokens":2,"completion_tokens_details":{"reasoning_tokens":2}}}"#,
        )
        .expect("usage chunk should parse");

        match event {
            Some(StreamEvent::Chunk(chunk)) => {
                assert!(chunk.choices.is_empty());
                assert_eq!(chunk.usage.map(|usage| usage.total_tokens), Some(5));
            }
            Some(StreamEvent::Done) | None => panic!("expected usage chunk"),
        }
    }

    #[test]
    fn stream_parser_deserializes_tool_call_delta() {
        let event = parse_stream_event_block(
            r#"data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1710000000,"model":"deepseek-v4-pro","system_fingerprint":null,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\""}}]},"finish_reason":null}],"usage":null}"#,
        )
        .expect("tool call chunk should parse");

        match event {
            Some(StreamEvent::Chunk(chunk)) => {
                let tool_calls = chunk.choices[0]
                    .delta
                    .tool_calls
                    .as_ref()
                    .expect("tool call delta should be present");
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].index, 0);
                assert_eq!(tool_calls[0].id.as_deref(), Some("call_1"));
                assert_eq!(tool_calls[0].kind, Some(ChatToolType::Function));
                let function = tool_calls[0]
                    .function
                    .as_ref()
                    .expect("function delta should be present");
                assert_eq!(function.name.as_deref(), Some("read_file"));
                assert_eq!(function.arguments.as_deref(), Some(r#"{"path""#));
            }
            Some(StreamEvent::Done) | None => panic!("expected stream chunk"),
        }
    }

    #[test]
    fn tool_call_accumulator_builds_complete_calls_from_fragments() {
        let mut accumulator = ChatToolCallAccumulator::new();
        accumulator
            .append_delta(tool_call_delta(
                0,
                Some("call_read"),
                Some(ChatToolType::Function),
                Some("read_file"),
                Some("{\"path\""),
            ))
            .expect("first delta should append");
        accumulator
            .append_delta(tool_call_delta(
                0,
                None,
                None,
                None,
                Some(":\"README.md\"}"),
            ))
            .expect("argument delta should append");

        let tool_calls = accumulator.finish().expect("tool call should complete");

        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "call_read");
        assert_eq!(tool_calls[0].kind, ChatToolType::Function);
        assert_eq!(tool_calls[0].function.name, "read_file");
        assert_eq!(tool_calls[0].function.arguments, r#"{"path":"README.md"}"#);
    }

    #[test]
    fn tool_call_accumulator_preserves_index_order() {
        let mut accumulator = ChatToolCallAccumulator::new();
        accumulator
            .append_delta(tool_call_delta(
                1,
                Some("call_second"),
                Some(ChatToolType::Function),
                Some("shell"),
                Some("{\"command\":\""),
            ))
            .expect("second call first delta should append");
        accumulator
            .append_delta(tool_call_delta(
                0,
                Some("call_first"),
                Some(ChatToolType::Function),
                Some("read_file"),
                Some("{\"path\":\"README.md\"}"),
            ))
            .expect("first call delta should append");
        accumulator
            .append_delta(tool_call_delta(1, None, None, None, Some("pwd\"}")))
            .expect("second call argument delta should append");

        let tool_calls = accumulator
            .finish()
            .expect("interleaved tool calls should complete");

        assert_eq!(tool_calls[0].id, "call_first");
        assert_eq!(tool_calls[1].id, "call_second");
        assert_eq!(tool_calls[1].function.arguments, r#"{"command":"pwd"}"#);
    }

    #[test]
    fn tool_call_accumulator_rejects_conflicting_ids() {
        let mut accumulator = ChatToolCallAccumulator::new();
        accumulator
            .append_delta(tool_call_delta(
                0,
                Some("call_1"),
                Some(ChatToolType::Function),
                Some("read_file"),
                Some("{}"),
            ))
            .expect("first delta should append");

        let error = accumulator
            .append_delta(tool_call_delta(0, Some("call_2"), None, None, None))
            .expect_err("conflicting id should fail");

        assert!(matches!(
            error,
            ChatToolCallAccumulatorError::ConflictingToolCallId { .. }
        ));
    }

    #[test]
    fn tool_call_accumulator_rejects_missing_required_metadata() {
        let mut accumulator = ChatToolCallAccumulator::new();
        accumulator
            .append_delta(tool_call_delta(
                0,
                None,
                Some(ChatToolType::Function),
                Some("read_file"),
                Some("{}"),
            ))
            .expect("delta with missing id should be buffered until finish");

        let error = accumulator
            .finish()
            .expect_err("missing id should fail at finish");

        assert!(matches!(
            error,
            ChatToolCallAccumulatorError::MissingToolCallId { .. }
        ));
    }

    #[test]
    fn sse_byte_parser_handles_events_split_across_chunks() {
        let mut parser = SseEventParser::new();
        let first = parser
            .push_bytes(br#"data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1710000000,"model":"deepseek-v4-pro","system_fingerprint":null,"choices":[{"index":0,"delta":{"role":"assistant","content":"hel"#)
            .expect("partial chunk should be buffered");
        assert!(first.is_empty());

        let second = parser
            .push_bytes(
                br#"lo","reasoning_content":null},"finish_reason":null}],"usage":null}

data: [DONE]

"#,
            )
            .expect("completed chunks should parse");

        assert_eq!(second.len(), 2);
        match &second[0] {
            StreamEvent::Chunk(chunk) => {
                assert_eq!(chunk.choices[0].delta.content.as_deref(), Some("hello"));
            }
            StreamEvent::Done => panic!("expected chunk before done"),
        }
        assert_eq!(second[1], StreamEvent::Done);
    }

    #[test]
    fn sse_byte_parser_handles_crlf_event_boundaries() {
        let mut parser = SseEventParser::new();
        let chunk = concat!(
            r#"data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1710000000,"model":"deepseek-v4-pro","system_fingerprint":null,"choices":[],"usage":null}"#,
            "\r\n\r\n",
        );
        let events = parser
            .push_bytes(chunk.as_bytes())
            .expect("CRLF chunk should parse");

        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], StreamEvent::Chunk(_)));
    }

    #[test]
    fn sse_byte_parser_rejects_incomplete_event() {
        let mut parser = SseEventParser::new();
        let events = parser
            .push_bytes(br#"data: {"id":"chatcmpl-test"}"#)
            .expect("partial event should be buffered");

        assert!(events.is_empty());
        let error = parser.finish().expect_err("incomplete event must fail");

        assert!(matches!(
            error,
            DeepSeekApiError::IncompleteStreamEvent { .. }
        ));
    }

    #[test]
    fn sse_byte_parser_rejects_invalid_utf8_event() {
        let mut parser = SseEventParser::new();
        let error = parser
            .push_bytes(b"data: \xff\n\n")
            .expect_err("invalid UTF-8 event must fail");

        assert!(matches!(error, DeepSeekApiError::InvalidStreamUtf8(_)));
    }

    #[test]
    fn stream_parser_rejects_invalid_json() {
        let error =
            parse_stream_event_block("data: {not-json}\n\n").expect_err("invalid JSON must fail");

        assert!(matches!(error, DeepSeekApiError::InvalidStreamJson { .. }));
    }

    #[test]
    fn tool_definition_serializes_expressive_tool_shape() {
        let tool = ChatTool::function(super::ChatFunctionDefinition {
            name: "read_file".to_owned(),
            description: "Read a file.".to_owned(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }),
        });

        let call = ChatToolCall::function("call_1", "read_file", "{\"path\":\"README.md\"}");
        let request = ChatCompletionRequest::new(
            DeepSeekModelId::new(DeepSeekModelId::V4_FLASH).expect("model should be valid"),
            vec![ChatMessage::assistant_with_tool_calls(
                None,
                Some("Need the README before editing.".to_owned()),
                vec![call],
            )],
        )
        .expect("request should be valid")
        .with_tools(vec![tool]);

        let json = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(json["tools"][0]["type"], "function");
        assert_eq!(json["tools"][0]["function"]["name"], "read_file");
        assert_eq!(
            json["messages"][0]["reasoning_content"],
            "Need the README before editing."
        );
        assert_eq!(
            json["messages"][0]["tool_calls"][0]["function"]["name"],
            "read_file"
        );
    }

    #[test]
    fn assistant_tool_call_helper_always_serializes_content() {
        let message = ChatMessage::assistant_with_tool_calls(
            None,
            None,
            vec![ChatToolCall::function(
                "call_1",
                "read_file",
                "{\"path\":\"README.md\"}",
            )],
        );

        let json = serde_json::to_value(message).expect("message should serialize");

        assert_eq!(json["content"], "");
        assert_eq!(json["tool_calls"][0]["function"]["name"], "read_file");
    }

    #[test]
    fn named_tool_choice_requires_disabled_thinking_for_deepseek() {
        let request = ChatCompletionRequest::new(
            DeepSeekModelId::new(DeepSeekModelId::V4_FLASH).expect("model should be valid"),
            vec![ChatMessage::user("hello")],
        )
        .expect("request should be valid")
        .with_tool_choice(ToolChoice::function("read_file"));

        let error = request
            .validate_for_deepseek()
            .expect_err("tool_choice with default thinking must fail");

        assert!(matches!(
            error,
            DeepSeekApiError::ToolChoiceUnsupportedWithThinking
        ));

        let request = request.with_thinking(ThinkingConfig::disabled());
        request
            .validate_for_deepseek()
            .expect("tool_choice is valid when thinking is disabled");

        let json = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(json["thinking"]["type"], "disabled");
        assert_eq!(json["tool_choice"]["type"], "function");
        assert_eq!(json["tool_choice"]["function"]["name"], "read_file");
    }

    fn tool_call_delta(
        index: u32,
        id: Option<&str>,
        kind: Option<ChatToolType>,
        name: Option<&str>,
        arguments: Option<&str>,
    ) -> ChatToolCallDelta {
        ChatToolCallDelta {
            index,
            id: id.map(str::to_owned),
            kind,
            function: (name.is_some() || arguments.is_some()).then(|| ChatFunctionCallDelta {
                name: name.map(str::to_owned),
                arguments: arguments.map(str::to_owned),
            }),
        }
    }
}
