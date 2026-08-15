use crate::client::config::{
    Configuration, build_cassandra_config, build_consumer_builders, build_producer_config,
};
use crate::handler::JsHandler;
use crate::published::{NativePublishedDeque, NativePublishedMap, NativePublishedValue};
use napi::bindgen_prelude::{Either, Promise};
use napi::{Error, Result};
use napi_derive::napi;
use opentelemetry::propagation::{TextMapCompositePropagator, TextMapPropagator};
use prosody::codec::BinaryPayload;
use prosody::high_level::erased::{
    ErasedConsumerState, ErasedReadCache, SharedHighLevelClient, new_erased,
};
use prosody::propagator::new_propagator;
use prosody::requester::ResponseError;
use prosody::subsystem::SubsystemName;
use std::collections::HashMap;
use std::result::Result as StdResult;
use std::sync::Arc;
use std::time::Duration;
use tokio::select;
use tracing::debug;
use tracing::field::Empty;
use tracing::{Instrument, info_span};
use tracing_opentelemetry::OpenTelemetrySpanExt;

mod config;

/// A native client wrapper for the Prosody high-level client.
/// Provides methods for sending messages, subscribing to topics, and managing
/// consumer state.
#[napi]
pub struct NativeClient {
    client: SharedHighLevelClient<JsHandler>,
    propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeClient {
    /// Creates a new `NativeClient` instance.
    ///
    /// @param config - The configuration for the client
    /// @throws Error if the client creation fails
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    #[napi(factory, writable = false)]
    pub async fn create(config: Configuration) -> Result<Self> {
        let mut producer_config = build_producer_config(&config);
        let consumer_builders = build_consumer_builders(&config)?;
        let cassandra = build_cassandra_config(&config);

        let client = new_erased(
            config.mode.unwrap_or_default().into(),
            &mut producer_config,
            &consumer_builders,
            &cassandra,
        )
        .await
        .map_err(|error| Error::from_reason(error.to_string()))?;

        Ok(NativeClient {
            client,
            propagator: Arc::new(new_propagator()),
        })
    }

    /// Gets the current state of the consumer.
    ///
    /// @returns The current state of the consumer
    /// @throws Error if the operation fails
    #[napi(writable = false)]
    pub async fn consumer_state(&self) -> Result<ConsumerState> {
        match self.client.consumer_state().await {
            ErasedConsumerState::Shutdown => Ok(ConsumerState::Shutdown),
            ErasedConsumerState::Unconfigured => Ok(ConsumerState::Unconfigured),
            ErasedConsumerState::ConfigurationFailed(error) => Err(Error::from_reason(format!(
                "consumer configuration failed: {error}"
            ))),
            ErasedConsumerState::Configured(_) => Ok(ConsumerState::Configured),
            ErasedConsumerState::Running { .. } => Ok(ConsumerState::Running),
        }
    }

    /// Builds a read-only view of a published value collection.
    #[napi(writable = false)]
    pub async fn published_value(
        &self,
        subsystem: String,
        name: String,
        cache_ms: Option<u32>,
        cache_disabled: Option<bool>,
    ) -> Result<NativePublishedValue> {
        let inner = self
            .client
            .value_state(subsystem, name, read_cache(cache_ms, cache_disabled)?)
            .await
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(NativePublishedValue {
            inner,
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Builds a read-only view of a published map collection.
    #[napi(writable = false)]
    pub async fn published_map(
        &self,
        subsystem: String,
        name: String,
        cache_ms: Option<u32>,
        cache_disabled: Option<bool>,
    ) -> Result<NativePublishedMap> {
        let inner = self
            .client
            .map_state(subsystem, name, read_cache(cache_ms, cache_disabled)?)
            .await
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(NativePublishedMap {
            inner,
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Builds a read-only view of a published deque collection.
    #[napi(writable = false)]
    pub async fn published_deque(
        &self,
        subsystem: String,
        name: String,
        cache_ms: Option<u32>,
        cache_disabled: Option<bool>,
    ) -> Result<NativePublishedDeque> {
        let inner = self
            .client
            .deque_state(subsystem, name, read_cache(cache_ms, cache_disabled)?)
            .await
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(NativePublishedDeque {
            inner,
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Sends a message to a specified topic.
    ///
    /// The payload crosses as its JSON text and is forwarded to Kafka verbatim;
    /// Rust never parses it. The caller supplies the event metadata, read off
    /// the payload object before it was serialized, so the boundary costs no
    /// JSON re-parse.
    ///
    /// @param topic - The topic to send the message to
    /// @param key - The key of the message
    /// @param payload - The payload as JSON text
    /// @param metadata - The event metadata read off the payload object
    /// @param otelContext - The OpenTelemetry context for tracing
    /// @param maybeAbort - Optional promise that resolves when the operation
    /// should be aborted @returns A promise that resolves when the message
    /// has been sent @throws Error if the send operation fails or is
    /// aborted
    #[napi(writable = false)]
    pub async fn send(
        &self,
        topic: String,
        key: String,
        payload: String,
        metadata: EventMetadata,
        otel_context: HashMap<String, String>,
        maybe_abort: Option<Promise<()>>,
    ) -> Result<()> {
        let context = self.client.propagator().extract(&otel_context);
        let span = info_span!("javascript-send", %topic, %key, aborted = Empty);
        if let Err(err) = span.set_parent(context) {
            debug!("failed to set parent span: {err:#}");
        }

        let payload =
            BinaryPayload::new(payload.into_bytes(), metadata.event_id, metadata.event_type);

        let send_future = async {
            self.client
                .send(topic.as_str().into(), key, payload)
                .instrument(span.clone())
                .await
                .map_err(|error| Error::from_reason(error.to_string()))
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

    /// Sends one request and returns one outcome per subsystem.
    #[napi(writable = false)]
    pub async fn request(
        &self,
        request: NativeRequest,
        otel_context: HashMap<String, String>,
        maybe_abort: Option<Promise<()>>,
    ) -> Result<Vec<NativeSubsystemOutcome>> {
        let subsystems = request
            .subsystems
            .into_iter()
            .map(|name| {
                SubsystemName::try_new(name).map_err(|error| Error::from_reason(error.to_string()))
            })
            .collect::<Result<Vec<_>>>()?;
        let context = self.client.propagator().extract(&otel_context);
        let span = info_span!("javascript-request", topic = %request.topic, key = %request.key, aborted = Empty);
        if let Err(error) = span.set_parent(context) {
            debug!("failed to set parent span: {error:#}");
        }
        let payload = BinaryPayload::new(
            request.payload.into_bytes(),
            request.metadata.event_id,
            request.metadata.event_type,
        );
        let timeout = Duration::try_from_secs_f64(request.timeout_ms / 1_000.0)
            .map_err(|error| Error::from_reason(format!("timeoutMs: {error}")))?;
        let request_future = async {
            let results = self
                .client
                .request(
                    request.headers.into_iter().collect(),
                    request.topic.as_str().into(),
                    request.key,
                    payload,
                    subsystems,
                    timeout,
                )
                .instrument(span.clone())
                .await
                .map_err(|error| Error::from_reason(error.to_string()))?;
            Ok(results
                .into_iter()
                .map(|(subsystem, result)| NativeSubsystemOutcome {
                    subsystem: subsystem.to_string(),
                    outcome: native_outcome(result),
                })
                .collect())
        };
        let Some(on_abort) = maybe_abort else {
            let result = request_future.await;
            span.record("aborted", false);
            return result;
        };
        select! {
            result = on_abort.into_future() => {
                span.record("aborted", true);
                match result {
                    Err(error) => Err(error),
                    Ok(()) => Err(Error::from_reason("abort signal resolved without aborting")),
                }
            }
            result = request_future => {
                span.record("aborted", false);
                result
            }
        }
    }

    /// Subscribes to receive messages using the provided event handler.
    ///
    /// @param eventHandler - The event handler to process received messages and
    /// timers @returns A promise that resolves when the subscription is
    /// established @throws Error if the subscription fails
    #[napi(
        writable = false,
        ts_args_type = "eventHandler: { onMessage: (err: null | Error, args: [NativeContext, \
                        Message, Record<string, string>]) => Promise<string>; onTimer: (err: null \
                        | Error, args: [NativeContext, Timer, Record<string, string>]) => \
                        Promise<string>; isPermanent: (args: [Error]) => boolean }"
    )]
    pub async fn subscribe(&self, event_handler: JsHandler) -> Result<()> {
        self.client
            .subscribe(event_handler)
            .await
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Gets the number of partitions assigned to the consumer.
    ///
    /// @returns The number of assigned partitions, or 0 if the consumer is not
    /// in the Running state @throws Error if the operation fails
    #[napi(writable = false)]
    pub async fn assigned_partition_count(&self) -> Result<u32> {
        Ok(self.client.assigned_partition_count().await)
    }

    /// Checks if the consumer is stalled.
    ///
    /// @returns Whether the consumer is stalled, or false if the consumer is
    /// not in the Running state @throws Error if the operation fails
    #[napi(writable = false)]
    pub async fn is_stalled(&self) -> Result<bool> {
        Ok(self.client.is_stalled().await)
    }

    /// Unsubscribes from receiving messages and shuts down the consumer.
    ///
    /// @returns A promise that resolves when the unsubscribe operation is
    /// complete @throws Error if the unsubscribe operation fails
    #[napi(writable = false)]
    pub async fn unsubscribe(&self) -> Result<()> {
        self.client
            .unsubscribe()
            .await
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Shuts down the client and all its services.
    ///
    /// @returns A promise that resolves when shutdown is complete
    /// @throws Error if shutdown fails
    #[napi(writable = false)]
    pub async fn shutdown(&self) -> Result<()> {
        self.client
            .clone()
            .shutdown()
            .await
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Gets the source system identifier configured for the client.
    ///
    /// @returns The source system identifier
    #[napi(getter, writable = false)]
    pub fn source_system(&self) -> &str {
        self.client.source_system()
    }
}

fn read_cache(cache_ms: Option<u32>, disabled: Option<bool>) -> Result<ErasedReadCache> {
    match (cache_ms, disabled.unwrap_or(false)) {
        (Some(_), true) => Err(Error::from_reason(
            "read cache cannot set both ttlMs and disabled",
        )),
        (None, true) => Ok(ErasedReadCache::Disabled),
        (Some(milliseconds), false) => Ok(ErasedReadCache::Ttl(Duration::from_millis(u64::from(
            milliseconds,
        )))),
        (None, false) => Ok(ErasedReadCache::Inherit),
    }
}

/// One request.
#[napi(object)]
pub struct NativeRequest {
    /// Kafka headers.
    pub headers: HashMap<String, String>,
    /// Kafka topic.
    pub topic: String,
    /// Message key.
    pub key: String,
    /// JSON payload text.
    pub payload: String,
    /// Event metadata read before serialization.
    pub metadata: EventMetadata,
    /// Subsystems that must respond.
    pub subsystems: Vec<String>,
    /// Response deadline in milliseconds.
    pub timeout_ms: f64,
}

/// One response failure.
#[napi(object)]
pub struct NativeResponseError {
    /// Failure discriminator.
    pub kind: NativeResponseErrorKind,
    /// Failure text.
    pub message: String,
}

/// One subsystem and its outcome.
#[napi(object)]
pub struct NativeSubsystemOutcome {
    /// Canonical subsystem name.
    pub subsystem: String,
    /// Encoded response or failure.
    pub outcome: Either<String, NativeResponseError>,
}

/// One response failure kind.
#[derive(Clone, Copy)]
#[napi(string_enum)]
pub enum NativeResponseErrorKind {
    #[napi(value = "handler")]
    Handler,
    #[napi(value = "timeout")]
    Timeout,
    #[napi(value = "formatMismatch")]
    FormatMismatch,
    #[napi(value = "malformedResponse")]
    Malformed,
}

fn native_outcome(
    result: StdResult<BinaryPayload, ResponseError>,
) -> Either<String, NativeResponseError> {
    match result {
        Ok(value) => match String::from_utf8(value.bytes) {
            Ok(value) => Either::A(value),
            Err(_) => Either::B(native_error(ResponseError::Malformed)),
        },
        Err(error) => Either::B(native_error(error)),
    }
}

fn native_error(error: ResponseError) -> NativeResponseError {
    let (kind, message) = match error {
        ResponseError::Handler { message } => (NativeResponseErrorKind::Handler, message),
        ResponseError::Timeout => (
            NativeResponseErrorKind::Timeout,
            ResponseError::Timeout.to_string(),
        ),
        ResponseError::FormatMismatch => (
            NativeResponseErrorKind::FormatMismatch,
            ResponseError::FormatMismatch.to_string(),
        ),
        ResponseError::Malformed => (
            NativeResponseErrorKind::Malformed,
            ResponseError::Malformed.to_string(),
        ),
    };
    NativeResponseError { kind, message }
}

/// Event metadata read off a payload before it was serialized.
///
/// Carrying it alongside the JSON text is what lets the send path forward the
/// payload verbatim: neither side re-parses the document to recover these two
/// fields.
#[napi(object)]
pub struct EventMetadata {
    /// The payload's `id` field.
    pub event_id: Option<String>,

    /// The payload's `type` field.
    pub event_type: Option<String>,
}

/// Current state of the consumer.
/// Represents the lifecycle stages of a Prosody consumer.
#[derive(Debug)]
#[napi(string_enum)]
pub enum ConsumerState {
    /// The client is shut down
    Shutdown,

    /// The consumer is not yet configured
    Unconfigured,

    /// The consumer is configured but not running
    Configured,

    /// The consumer is actively running
    Running,

    /// The consumer configuration failed
    ConfigurationFailed,
}
