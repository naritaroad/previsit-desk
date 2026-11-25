//! The only place that talks to model providers. genai handles Gemini; the model name picks the provider
//! (any `gemini*` id goes to the Gemini adapter). `mock` is an offline stand-in for tests and demos without a key.
//!
//! Thinking level: genai 0.7.1 turns a model-name suffix such as `-minimal` into `ReasoningEffort::Low`
//! (its suffix table maps both "low" and "minimal" to Low), so a suffix cannot ask for MINIMAL. We set
//! `ChatOptions::with_reasoning_effort` explicitly instead: for `gemini-3*` models genai sends it as
//! `generationConfig.thinkingConfig.thinkingLevel` (MINIMAL, LOW, MEDIUM or HIGH). The model name stays clean.

pub mod mock;

use anyhow::Result;
use futures::future::BoxFuture;
use genai::chat::{ChatMessage, ChatOptions, ChatRequest, ReasoningEffort, ToolCall};

use crate::config::Thinking;

/// What one model call returns, reduced to what the loop needs.
pub struct ModelReply {
    pub text: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    /// The assistant turn to append before the tool responses (keeps provider metadata such as thought signatures).
    pub assistant_message: Option<ChatMessage>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Thinking tokens, when the provider reports them (used to confirm the thinking level took effect).
    pub reasoning_tokens: Option<i64>,
}

pub trait ModelGateway: Send + Sync {
    fn model_name(&self) -> &str;
    fn chat(&self, request: ChatRequest) -> BoxFuture<'_, Result<ModelReply>>;
}

struct GenaiGateway {
    client: genai::Client,
    model: String,
    options: ChatOptions,
}

impl ModelGateway for GenaiGateway {
    fn model_name(&self) -> &str {
        &self.model
    }

    fn chat(&self, request: ChatRequest) -> BoxFuture<'_, Result<ModelReply>> {
        Box::pin(async move {
            let response = self
                .client
                .exec_chat(self.model.as_str(), request, Some(&self.options))
                .await?;
            let usage = &response.usage;
            let (input_tokens, output_tokens) = (
                i64::from(usage.prompt_tokens.unwrap_or(0)),
                i64::from(usage.completion_tokens.unwrap_or(0)),
            );
            let reasoning_tokens = usage
                .completion_tokens_details
                .as_ref()
                .and_then(|d| d.reasoning_tokens)
                .map(i64::from);
            let text = response.first_text().map(str::to_string);
            let tool_calls: Vec<ToolCall> = response.tool_calls().into_iter().cloned().collect();
            let assistant_message = response.into_assistant_message_for_tool_use();
            Ok(ModelReply {
                text,
                tool_calls,
                assistant_message,
                input_tokens,
                output_tokens,
                reasoning_tokens,
            })
        })
    }
}

/// Model access for the whole app. The provider key comes from the provider's usual variable (`GEMINI_API_KEY`).
pub struct Ai {
    client: genai::Client,
}

impl Ai {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: genai::Client::new()?,
        })
    }

    /// A gateway for `model` with the given thinking level (`None` or `Default` sends no thinking option).
    /// Every name that starts with `mock` is the offline stand-in.
    pub fn gateway(
        &self,
        model: &str,
        thinking: Option<Thinking>,
        temperature: f64,
    ) -> Box<dyn ModelGateway> {
        if model.starts_with("mock") {
            return Box::new(mock::MockGateway);
        }
        Box::new(GenaiGateway {
            client: self.client.clone(),
            model: model.to_string(),
            options: chat_options(thinking, temperature),
        })
    }
}

fn chat_options(thinking: Option<Thinking>, temperature: f64) -> ChatOptions {
    let mut options = ChatOptions::default()
        .with_temperature(temperature)
        .with_max_tokens(2048);
    if let Some(effort) = reasoning_effort(thinking) {
        options = options.with_reasoning_effort(effort);
    }
    options
}

fn reasoning_effort(thinking: Option<Thinking>) -> Option<ReasoningEffort> {
    match thinking {
        None | Some(Thinking::Default) => None,
        Some(Thinking::Minimal) => Some(ReasoningEffort::Minimal),
        Some(Thinking::Low) => Some(ReasoningEffort::Low),
        Some(Thinking::Medium) => Some(ReasoningEffort::Medium),
        Some(Thinking::High) => Some(ReasoningEffort::High),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_levels_map_to_explicit_reasoning_efforts() {
        assert!(matches!(
            reasoning_effort(Some(Thinking::Minimal)),
            Some(ReasoningEffort::Minimal)
        ));
        assert!(matches!(
            reasoning_effort(Some(Thinking::Low)),
            Some(ReasoningEffort::Low)
        ));
        assert!(matches!(
            reasoning_effort(Some(Thinking::High)),
            Some(ReasoningEffort::High)
        ));
        assert!(reasoning_effort(Some(Thinking::Default)).is_none());
        assert!(
            reasoning_effort(None).is_none(),
            "the fallback model gets no thinking option"
        );
    }

    #[test]
    fn chat_options_carry_the_effort_only_when_asked() {
        assert!(matches!(
            chat_options(Some(Thinking::Minimal), 0.3).reasoning_effort,
            Some(ReasoningEffort::Minimal)
        ));
        assert!(chat_options(None, 0.3).reasoning_effort.is_none());
    }

    #[tokio::test]
    async fn the_mock_gateway_is_selected_by_name() {
        let ai = Ai {
            client: genai::Client::new().expect("client"),
        };
        assert_eq!(ai.gateway("mock", None, 0.3).model_name(), "mock");
        assert_eq!(
            ai.gateway("gemini-3.5-flash", Some(Thinking::Minimal), 0.3)
                .model_name(),
            "gemini-3.5-flash"
        );
    }
}
