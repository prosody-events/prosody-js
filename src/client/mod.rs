use crate::client::config::{
  Configuration, build_cassandra_config, build_consumer_config, build_failure_topic_config,
  build_producer_config, build_retry_config,
};
use crate::handler::JsHandler;
use napi::bindgen_prelude::Promise;
use napi::{Error, Result, Status};
use napi_derive::napi;
use opentelemetry::propagation::TextMapPropagator;
use prosody::high_level::HighLevelClient;
use prosody::high_level::state::ConsumerState as ProsodyConsumerState;
use serde_json::Value;
use std::collections::HashMap;
use tokio::select;
use tracing::field::Empty;
use tracing::{Instrument, info_span};
use tracing_opentelemetry::OpenTelemetrySpanExt;

mod config;

/**
 * A native client wrapper for the Prosody high-level client.
 */
#[napi]
pub struct NativeClient {
  client: HighLevelClient<JsHandler>,
}

#[napi]
impl NativeClient {
  /**
   * Creates a new `NativeClient` instance.
   *
   * @param config - The configuration for the client.
   * @throws Error if the client creation fails.
   */
  #[allow(clippy::needless_pass_by_value)] // required by NAPI
  #[napi(constructor, writable = false)]
  pub fn new(config: Configuration) -> Result<Self> {
    let mut producer_config = build_producer_config(&config);
    let consumer_config = build_consumer_config(&config);
    let retry_config = build_retry_config(&config);
    let failure_topic_config = build_failure_topic_config(&config);
    let cassandra_config = build_cassandra_config(&config);

    let client = HighLevelClient::new(
      config.mode.unwrap_or_default().into(),
      &mut producer_config,
      &consumer_config,
      &retry_config,
      &failure_topic_config,
      &cassandra_config,
    )
    .map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(NativeClient { client })
  }

  /**
   * Gets the current state of the consumer.
   */
  #[napi(writable = false)]
  pub async fn consumer_state(&self) -> Result<ConsumerState> {
    let state_view = self.client.consumer_state().await;
    Ok((&*state_view).into())
  }

  /**
   * Sends a message to a specified topic.
   *
   * @param topic - The topic to send the message to.
   * @param key - The key of the message.
   * @param payload - The payload of the message.
   * @param otelContext - The OpenTelemetry context for tracing.
   * @param onAbort - A promise that resolves when the operation should be aborted.
   * @throws Error if the send operation fails or is aborted.
   */
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

    // Delay send to ensure the biased select will not send if already aborted
    let send_future = async {
      self
        .client
        .send(topic.as_str().into(), &key, &payload)
        .instrument(span.clone())
        .await
    };

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

  /**
   * Subscribes to receive messages using the provided event handler.
   *
   * @param eventHandler - The event handler to process received messages.
   * @throws Error if the subscription fails.
   */
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

  /**
   * Returns the number of partitions assigned to the consumer.
   *
   * @return {number} The number of assigned partitions, or 0 if the consumer is not in the Running state
   */
  #[napi(writable = false)]
  pub async fn assigned_partition_count(&self) -> Result<u32> {
    Ok(self.client.assigned_partition_count().await)
  }

  /**
   * Checks if the consumer is stalled.
   *
   * @return {boolean} Whether the consumer is stalled, or false if the consumer is not in the Running state
   */
  #[napi(writable = false)]
  pub async fn is_stalled(&self) -> Result<bool> {
    Ok(self.client.is_stalled().await)
  }

  /**
   * Unsubscribes from receiving messages.
   *
   * @throws Error if the unsubscribe operation fails.
   */
  #[napi(writable = false)]
  pub async fn unsubscribe(&self) -> Result<()> {
    self
      .client
      .unsubscribe()
      .await
      .map_err(|e| Error::from_reason(e.to_string()))
  }
}

/**
 * Current state of the consumer.
 */
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
