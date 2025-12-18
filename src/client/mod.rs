use crate::client::config::{
  Configuration, build_cassandra_config, build_consumer_builders, build_producer_config,
};
use crate::handler::JsHandler;
use napi::bindgen_prelude::Promise;
use napi::{Error, Result};
use napi_derive::napi;
use opentelemetry::propagation::TextMapPropagator;
use prosody::high_level::HighLevelClient;
use prosody::high_level::state::ConsumerState as ProsodyConsumerState;
use serde_json::Value;
use std::collections::HashMap;
use tokio::select;
use tracing::debug;
use tracing::field::Empty;
use tracing::{Instrument, info_span};
use tracing_opentelemetry::OpenTelemetrySpanExt;

mod config;

/// A native client wrapper for the Prosody high-level client.
/// Provides methods for sending messages, subscribing to topics, and managing consumer state.
#[napi]
pub struct NativeClient {
  client: HighLevelClient<JsHandler>,
}

#[napi]
impl NativeClient {
  /// Creates a new `NativeClient` instance.
  ///
  /// @param config - The configuration for the client
  /// @throws Error if the client creation fails
  #[allow(clippy::needless_pass_by_value)] // required by NAPI
  #[napi(constructor, writable = false)]
  pub fn new(config: Configuration) -> Result<Self> {
    let mut producer_config = build_producer_config(&config);
    let consumer_builders = build_consumer_builders(&config);
    let cassandra_config = build_cassandra_config(&config);

    let client = HighLevelClient::new(
      config.mode.unwrap_or_default().into(),
      &mut producer_config,
      &consumer_builders,
      &cassandra_config,
    )
    .map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(NativeClient { client })
  }

  /// Gets the current state of the consumer.
  ///
  /// @returns The current state of the consumer
  /// @throws Error if the operation fails
  #[napi(writable = false)]
  pub async fn consumer_state(&self) -> Result<ConsumerState> {
    let state_view = self.client.consumer_state().await;
    Ok((&*state_view).into())
  }

  /// Sends a message to a specified topic.
  ///
  /// @param topic - The topic to send the message to
  /// @param key - The key of the message
  /// @param payload - The payload of the message (must be JSON-serializable)
  /// @param otelContext - The OpenTelemetry context for tracing
  /// @param maybeAbort - Optional promise that resolves when the operation should be aborted
  /// @returns A promise that resolves when the message has been sent
  /// @throws Error if the send operation fails or is aborted
  #[napi(writable = false)]
  pub async fn send(
    &self,
    topic: String,
    key: String,
    payload: Value,
    otel_context: HashMap<String, String>,
    maybe_abort: Option<Promise<()>>,
  ) -> Result<()> {
    let context = self.client.propagator().extract(&otel_context);
    let span = info_span!("javascript-send", %topic, %key, aborted = Empty);
    if let Err(err) = span.set_parent(context) {
      debug!("failed to set parent span: {err:#}");
    }

    let send_future = async {
      self
        .client
        .send(topic.as_str().into(), &key, &payload)
        .instrument(span.clone())
        .await
        .map_err(|e| Error::from_reason(e.to_string()))
    };

    let Some(on_abort) = maybe_abort else {
      let result = send_future.await;
      span.record("aborted", false);
      return result;
    };

    select! {
        result = on_abort.into_future() => {
            span.record("aborted", true);
            result
        }

        result = send_future => {
            span.record("aborted", false);
            result
        }
    }
  }

  /// Subscribes to receive messages using the provided event handler.
  ///
  /// @param eventHandler - The event handler to process received messages and timers
  /// @returns A promise that resolves when the subscription is established
  /// @throws Error if the subscription fails
  #[napi(
    writable = false,
    ts_args_type = "eventHandler: { \
      onMessage: (err: null | Error, args: [Context, Message, Record<string, string>]) => Promise<void>; \
      onTimer: (err: null | Error, args: [Context, Timer, Record<string, string>]) => Promise<void>; \
      isPermanent: (args: [Error]) => boolean \
    }"
  )]
  pub async fn subscribe(&self, event_handler: JsHandler) -> Result<()> {
    self
      .client
      .subscribe(event_handler)
      .await
      .map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(())
  }

  /// Gets the number of partitions assigned to the consumer.
  ///
  /// @returns The number of assigned partitions, or 0 if the consumer is not in the Running state
  /// @throws Error if the operation fails
  #[napi(writable = false)]
  pub async fn assigned_partition_count(&self) -> Result<u32> {
    Ok(self.client.assigned_partition_count().await)
  }

  /// Checks if the consumer is stalled.
  ///
  /// @returns Whether the consumer is stalled, or false if the consumer is not in the Running state
  /// @throws Error if the operation fails
  #[napi(writable = false)]
  pub async fn is_stalled(&self) -> Result<bool> {
    Ok(self.client.is_stalled().await)
  }

  /// Unsubscribes from receiving messages and shuts down the consumer.
  ///
  /// @returns A promise that resolves when the unsubscribe operation is complete
  /// @throws Error if the unsubscribe operation fails
  #[napi(writable = false)]
  pub async fn unsubscribe(&self) -> Result<()> {
    self
      .client
      .unsubscribe()
      .await
      .map_err(|e| Error::from_reason(e.to_string()))
  }

  /// Gets the source system identifier configured for the client.
  ///
  /// @returns The source system identifier
  #[napi(getter, writable = false)]
  pub fn source_system(&self) -> &str {
    self.client.source_system()
  }
}

/// Current state of the consumer.
/// Represents the lifecycle stages of a Prosody consumer.
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
