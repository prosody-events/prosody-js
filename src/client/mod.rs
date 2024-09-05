use crate::client::config::{
  build_consumer_config, build_failure_topic_config, build_producer_config, build_retry_config,
  Configuration,
};
use crate::handler::JsHandler;
use crate::handler::NativeHandler;
use napi::bindgen_prelude::Promise;
use napi::{Error, Result, Status};
use napi_derive::napi;
use opentelemetry::propagation::TextMapPropagator;
use prosody::high_level::state::ConsumerState as ProsodyConsumerState;
use prosody::high_level::HighLevelClient;
use serde_json::Value;
use std::collections::HashMap;
use std::ops::Deref;
use tokio::select;
use tracing::field::Empty;
use tracing::{info_span, Instrument};
use tracing_opentelemetry::OpenTelemetrySpanExt;

mod config;

/// A native client wrapper for the Prosody high-level client.
#[napi]
pub struct NativeClient {
  client: HighLevelClient<JsHandler>,
}

#[napi]
impl NativeClient {
  /// Creates a new `NativeClient` instance.
  ///
  /// # Arguments
  ///
  /// * `config` - The configuration for the client.
  ///
  /// # Errors
  ///
  /// Returns an error if the client creation fails.
  #[allow(clippy::needless_pass_by_value)] // required by NAPI
  #[napi(constructor, writable = false)]
  pub fn new(config: Configuration) -> Result<Self> {
    let producer_config = build_producer_config(&config);
    let consumer_config = build_consumer_config(&config);
    let retry_config = build_retry_config(&config);
    let failure_topic_config = build_failure_topic_config(&config);

    let client = HighLevelClient::new(
      config.mode.unwrap_or_default().into(),
      &producer_config,
      &consumer_config,
      &retry_config,
      &failure_topic_config,
    )
    .map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(NativeClient { client })
  }

  /// Gets the current state of the consumer.
  #[napi(getter, writable = false)]
  pub fn consumer_state(&self) -> ConsumerState {
    self.client.consumer_state().deref().into()
  }

  /// Sends a message to a specified topic.
  ///
  /// # Arguments
  ///
  /// * `topic` - The topic to send the message to.
  /// * `key` - The key of the message.
  /// * `payload` - The payload of the message.
  /// * `otel_context` - The OpenTelemetry context for tracing.
  /// * `on_abort` - A promise that resolves when the operation should be aborted.
  ///
  /// # Errors
  ///
  /// Returns an error if the send operation fails or is aborted.
  #[napi(writable = false)]
  pub async fn send(
    &self,
    topic: String,
    key: String,
    payload: Value,
    otel_context: HashMap<String, String>,
    on_abort: Promise<()>,
  ) -> Result<()> {
    let context = self.client.propagator().extract(&otel_context);
    let span = info_span!("javascript-send", %topic, %key, aborted = Empty);
    span.set_parent(context);

    let send_future = self
      .client
      .send(topic.as_str().into(), &key, &payload)
      .instrument(span.clone());

    select! {
        biased;

        result = on_abort => {
            span.record("aborted", true);
            result.map_err(|_| Error::new(Status::Cancelled, "Abort signal received"))
        }

        result = send_future => {
            span.record("aborted", false);
            result.map_err(|e| Error::from_reason(e.to_string()))
        }
    }
  }

  /// Subscribes to receive messages using the provided event handler.
  ///
  /// # Arguments
  ///
  /// * `event_handler` - The event handler to process received messages.
  ///
  /// # Errors
  ///
  /// Returns an error if the subscription fails.
  #[allow(clippy::needless_pass_by_value)] // required by NAPI
  #[napi(writable = false)]
  pub fn subscribe(&self, event_handler: NativeHandler) -> Result<()> {
    let handler = JsHandler::new(&event_handler, 0)?;

    self
      .client
      .subscribe(handler)
      .map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(())
  }

  /// Unsubscribes from receiving messages.
  ///
  /// # Errors
  ///
  /// Returns an error if the unsubscribe operation fails.
  #[napi(writable = false)]
  pub async fn unsubscribe(&self) -> Result<()> {
    self
      .client
      .unsubscribe()
      .await
      .map_err(|e| Error::from_reason(e.to_string()))
  }
}

/// Current state of the consumer.
#[derive(Debug)]
#[napi(string_enum)]
pub enum ConsumerState {
  /// The consumer is not yet configured
  Unconfigured,

  /// The consumer is configured but not running
  Configured,

  /// The consumer is actively running
  Running,
}

impl<T> From<&ProsodyConsumerState<T>> for ConsumerState {
  fn from(value: &ProsodyConsumerState<T>) -> Self {
    match value {
      ProsodyConsumerState::Unconfigured => Self::Unconfigured,
      ProsodyConsumerState::Configured(_) => Self::Configured,
      ProsodyConsumerState::Running { .. } => Self::Running,
    }
  }
}
