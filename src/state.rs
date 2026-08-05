//! Erased native layer for keyed state.
//!
//! Wraps the boxed erased handles from
//! [`prosody::consumer::event_context`] as `#[napi]` classes. Collections are
//! addressed by name; JSON documents cross as their raw text (the passthrough
//! codec — Rust never parses the JSON, exactly like the message-payload path)
//! and Kafka-message items cross as the same `Message` object handlers already
//! receive.
//!
//! Every operation extracts the JS-side carrier and activates it while polling
//! the erased future, allowing core's semantic collection span to join the
//! event trace without an extra N-API binding span. Scans activate the carrier
//! while core constructs its stream span; pulls transport vectors of up to 256
//! immediately-ready items without creating per-chunk binding spans.
//!
//! Errors carry their category (`"permanent"` / `"transient"`) as the message
//! of the JavaScript error's `cause`, a machine-readable data channel the
//! typed layer branches on without parsing the human message. No fencing or
//! cursor safety lives here: those are core-owned and this layer only
//! transports and types. Caller-mistake conditions the glue detects (an
//! unrepresentable value, a `null` write, or an invalid enum
//! token) reject TRANSIENT — a caller code error retries and stays visible
//! rather than discarding the message (see CLAUDE.md error-classification).

use crate::message::Message;
use napi::bindgen_prelude::{FromNapiValue, TypeName, ValueType, sys};
use napi::{Error, Status};
use napi_derive::napi;
use opentelemetry::propagation::{TextMapCompositePropagator, TextMapPropagator};
use opentelemetry::trace::FutureExt;
use prosody::codec::{BinaryPayload, ErasedStateCodec};
use prosody::consumer::event_context::{
    BoxDequeState, BoxMapState, BoxStateCursor, BoxValueState, ErasedCategory, ErasedStateError,
};
use prosody::consumer::message::ConsumerMessage;
use prosody::state::Direction;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Arc;

/// A Kafka message crossing INTO a state handle.
///
/// Unwraps the JavaScript `Message` to the [`ConsumerMessage`] it shares: two
/// reference-count bumps, no byte copies. Owned and `'static`, so it survives
/// the awaits inside the async write methods — a borrowed class reference
/// cannot.
///
/// Accepts any message a handler holds, whether it arrived from the topic or
/// was read back out of a collection — both wrap a real consumer message.
pub struct MessageItem(ConsumerMessage<BinaryPayload>);

impl TypeName for MessageItem {
    fn type_name() -> &'static str {
        "Message"
    }

    fn value_type() -> ValueType {
        ValueType::Object
    }
}

impl FromNapiValue for MessageItem {
    // SAFETY: `env` and `napi_val` are guaranteed valid by the NAPI-RS runtime
    // when this is invoked through the framework, and the call is forwarded
    // unchanged to the generated `&Message` conversion, which checks that the
    // value is a wrapped `Message` before dereferencing it.
    #[allow(unsafe_code)]
    unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> napi::Result<Self> {
        let message = unsafe { <&Message>::from_napi_value(env, napi_val) }?;
        Ok(Self(message.consumer_message()))
    }
}

/// Maps a core error category to its JavaScript-readable token.
///
/// @param category The core error category.
/// @returns The `"permanent"` or `"transient"` token.
fn category_token(category: ErasedCategory) -> &'static str {
    match category {
        ErasedCategory::Permanent => "permanent",
        ErasedCategory::Transient => "transient",
    }
}

/// Builds a napi error whose message is the human text and whose `cause` is an
/// error whose message is exactly the category token.
///
/// The `cause` channel survives both the async Promise-rejection path and the
/// sync throw path, so the typed layer selects `PermanentStateError` vs
/// `TransientStateError` by exact match on `error.cause.message` — never by
/// parsing the human message.
///
/// @param category The category token (`"permanent"` or `"transient"`).
/// @param message The human-readable error message.
/// @returns The structured napi error.
fn tagged_error(category: &str, message: String) -> Error {
    let mut error = Error::new(Status::GenericFailure, message);
    error.cause = Some(Box::new(Error::new(
        Status::GenericFailure,
        category.to_owned(),
    )));
    error
}

/// Converts an erased state error into a category-tagged napi error.
///
/// @param error The erased state error to convert.
/// @returns The structured napi error carrying the error's category.
pub(crate) fn state_error(error: &ErasedStateError) -> Error {
    tagged_error(category_token(error.category()), error.message().to_owned())
}

/// Builds a transient-category napi error for a caller-caused condition the
/// glue detects (an unrepresentable value, a `null` write, a wrong argument
/// shape, an out-of-range index, an invalid enum token).
///
/// Caller mistakes are TRANSIENT, never permanent: a permanent error discards
/// the in-flight message and can silently lose data or corrupt downstream
/// state, so a code error retries and stays visible (logs/metrics/lag) instead
/// — the developer sees it and fixes their code. Only an explicit caller
/// `PermanentError` throw is permanent (see CLAUDE.md error-classification).
///
/// @param message The human-readable error message.
/// @returns The structured napi error tagged transient.
fn transient_error(message: String) -> Error {
    tagged_error("transient", message)
}

/// Builds a permanent-category napi error for a stored cell that cannot be
/// decoded.
///
/// Corruption is not a caller mistake and no retry resolves it, so it is the
/// one condition this layer raises permanent. It surfaces on the read that
/// touched the cell rather than being swallowed, which is the only place a
/// caller can see which collection and key went bad.
///
/// @param message The human-readable error message.
/// @returns The structured napi error tagged permanent.
fn permanent_error(message: String) -> Error {
    tagged_error("permanent", message)
}

/// Parses a scan-direction token into the core `Direction`.
///
/// @param direction The `"forward"` or `"backward"` token.
/// @returns The matching `Direction`.
/// @throws Error (transient) if the token is neither `"forward"` nor
/// `"backward"` (a caller mistake — retries, not discarded).
pub(crate) fn parse_direction(direction: &str) -> napi::Result<Direction> {
    match direction {
        "forward" => Ok(Direction::Forward),
        "backward" => Ok(Direction::Backward),
        other => Err(transient_error(format!(
            "direction: expected \"forward\" or \"backward\", got {other:?}"
        ))),
    }
}

/// Extracts the event parent propagated by the JavaScript handler.
///
/// @param propagator The OpenTelemetry propagator for context extraction.
/// @param otelContext The propagated OpenTelemetry carrier.
/// @returns The extracted OpenTelemetry context.
pub(crate) fn op_context(
    propagator: &TextMapCompositePropagator,
    otel_context: &HashMap<String, String>,
) -> opentelemetry::Context {
    propagator.extract(otel_context)
}

/// Prepares JSON text for a write.
///
/// Takes the string's buffer, so the document is stored verbatim with no copy.
/// Rejects the `null` document: `null` is the erased seam's name for absence,
/// so it is not a storable value. Like every caller mistake it rejects
/// TRANSIENT — it retries and stays visible rather than discarding the
/// message. `advice` names the deletion verb for the collection kind (a deque
/// has none).
///
/// @param json The document's JSON text.
/// @param advice A trailing clause naming how to delete instead.
/// @returns The payload to hand core.
/// @throws Error (transient) if the document is JSON `null`.
fn json_payload(json: String, advice: &str) -> napi::Result<BinaryPayload> {
    let payload = BinaryPayload::new(json.into_bytes(), None::<String>, None::<String>);
    if payload.is_absent_sentinel() {
        return Err(transient_error(format!(
            "JSON null is not a storable value{advice}"
        )));
    }
    Ok(payload)
}

/// Hands a stored JSON document to JavaScript as its raw text.
///
/// Takes the payload's bytes; UTF-8 validation is a scan, not a copy. Every
/// document this layer stores came from `JSON.stringify`, so invalid UTF-8
/// means a corrupt cell — see [`permanent_error`] for why that is the one
/// permanent condition here.
///
/// @param payload The stored document.
/// @returns The document's JSON text.
/// @throws Error (permanent) if the stored bytes are not valid UTF-8.
pub(crate) fn json_text(payload: BinaryPayload) -> napi::Result<String> {
    String::from_utf8(payload.bytes).map_err(|error| {
        permanent_error(format!("stored JSON document is not valid UTF-8: {error}"))
    })
}

fn json_value(item: Option<BinaryPayload>) -> napi::Result<Option<String>> {
    item.map(json_text).transpose()
}

fn message_value(item: Option<ConsumerMessage<BinaryPayload>>) -> Option<Message> {
    item.map(Message::new)
}

/// Maximum number of immediately-ready scan items transported through N-API
/// in one vector. Core owns ready draining, error ordering, and pull
/// serialization; this binding owns only the transport cap and conversion.
const SCAN_READY_CHUNK_SIZE: NonZeroUsize = NonZeroUsize::new(256).unwrap();

macro_rules! transaction_methods {
    ($name:ident) => {
        #[napi]
        impl $name {
            /// Durably commits the buffered operations.
            #[napi(writable = false)]
            pub async fn commit(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
                let context = op_context(&self.propagator, &otel_context);
                self.state
                    .commit()
                    .with_context(context)
                    .await
                    .map_err(|error| state_error(&error))
            }

            /// Discards the buffered operations.
            #[napi(writable = false)]
            pub async fn rollback(&self, otel_context: HashMap<String, String>) {
                let context = op_context(&self.propagator, &otel_context);
                self.state.rollback().with_context(context).await;
            }
        }
    };
}

/// JSON single-value state handle for one event.
#[napi]
pub struct NativeJsonValueState {
    pub(crate) state: BoxValueState<BinaryPayload>,
    /// The propagator used to re-establish the event parent per operation.
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeJsonValueState {
    /// Reads the current value.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The current value, or null when absent/cleared.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn get(&self, otel_context: HashMap<String, String>) -> napi::Result<Option<String>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(json_value)
    }

    /// Buffers a write of a JSON document.
    ///
    /// JSON null is rejected with a transient error naming `clear` as the way
    /// to delete. Writing a document to a Kafka-message collection is a caller
    /// mistake and is likewise transient (it retries and stays visible, never
    /// discarded).
    ///
    /// @param json The document's JSON text.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(writable = false)]
    pub async fn set(
        &self,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        let payload = json_payload(json, "; use clear() to remove the value")?;
        self.state
            .set(payload)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Buffers a clear of the value.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .clear()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }
}

/// Kafka-message single-value state handle for one event.
#[napi]
pub struct NativeMessageValueState {
    pub(crate) state: BoxValueState<ConsumerMessage<BinaryPayload>>,
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeMessageValueState {
    /// Reads the current value.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get()
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Buffers a write of a Kafka message.
    #[napi(
        writable = false,
        ts_args_type = "message: Message, otelContext: Record<string, string>"
    )]
    pub async fn set(
        &self,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .set(message.0)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Buffers a clear of the value.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .clear()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }
}

/// JSON ordered-map state handle for one event.
#[napi]
pub struct NativeJsonMapState {
    pub(crate) state: BoxMapState<BinaryPayload>,
    /// The propagator used to re-establish the event parent per operation.
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeJsonMapState {
    /// Reads the value for `key`.
    ///
    /// @param key The map key.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The value, or null when the key is absent.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get(key)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(json_value)
    }

    /// Reads several keys in a single call.
    ///
    /// Returns one entry per key, in the same order requested: the entry at
    /// index `i` is the value for `keys[i]`. A key that isn't there reads as
    /// null, and a key listed more than once is answered at each of its spots.
    /// The whole read happens as one step, so no other change to this event's
    /// state can slip in partway through.
    ///
    /// @param keys The keys to read, in order.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns One result per input key; null for a key that is absent.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn get_many(
        &self,
        keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Vec<Option<String>>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get_many(keys)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(|items| items.into_iter().map(json_value).collect())
    }

    /// Reports whether a stored cell exists for `key`.
    ///
    /// Reads the event's dirty overlay (read-your-writes) and answers presence
    /// WITHOUT decoding the value or running the resolver — a message-backed
    /// map answers with zero Kafka fetches and can report `true` for a
    /// message that can no longer be fetched. This is NOT "no I/O": a cache
    /// miss can still reach Cassandra, so it is async and fallible exactly
    /// like `get`.
    ///
    /// @param key The map key.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns True when a stored cell exists for `key`.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn contains(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .contains_key(key)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Inserts or overwrites `key` with a JSON document.
    ///
    /// JSON null is rejected with a transient error naming `delete` as the way
    /// to remove an entry. Writing a document to a Kafka-message collection is
    /// a caller mistake and is likewise transient (it retries and stays
    /// visible, never discarded).
    ///
    /// @param key The map key.
    /// @param json The document's JSON text.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(writable = false)]
    pub async fn set(
        &self,
        key: String,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        let payload = json_payload(json, "; use delete(key) to remove the entry")?;
        self.state
            .set(key, payload)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes `key`.
    ///
    /// @param key The map key.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the removal fails.
    #[napi(writable = false)]
    pub async fn remove(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .remove(key)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes every entry.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .clear()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Opens a demand-driven cursor over the live entries in key order.
    ///
    /// Synchronous — it performs no I/O. The extracted JavaScript context is
    /// active while core constructs its semantic stream span; chunk pulls do
    /// not create binding spans. Entries are yielded as `(key, value)` pairs.
    ///
    /// @param direction The scan direction (`"forward"` or `"backward"`).
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns A cursor over the map entries.
    /// @throws Error if the direction token is invalid.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn scan(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeJsonMapCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeJsonMapCursor {
            cursor: self.state.scan(dir),
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Opens a demand-driven cursor over the live KEYS in key order.
    ///
    /// Skips the value codec and the resolver (no value decode, no Kafka
    /// fetch), so a message-backed map enumerates keys with zero Kafka
    /// fetches — but it still reads presence, so it is not zero-I/O.
    /// Synchronous like `scan`: the extracted JavaScript context is active
    /// while core constructs its semantic stream span. Yields bare keys.
    ///
    /// @param direction The scan direction (`"forward"` or `"backward"`).
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns A cursor over the map keys.
    /// @throws Error if the direction token is invalid.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn keys(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeMapKeyCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeMapKeyCursor {
            cursor: self.state.keys(dir),
            propagator: Arc::clone(&self.propagator),
        })
    }
}

/// Kafka-message ordered-map state handle for one event.
#[napi]
pub struct NativeMessageMapState {
    pub(crate) state: BoxMapState<ConsumerMessage<BinaryPayload>>,
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeMessageMapState {
    /// Reads the value for `key`.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get(key)
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Reads several keys in one operation.
    #[napi(writable = false)]
    pub async fn get_many(
        &self,
        keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Vec<Option<Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get_many(keys)
            .with_context(context)
            .await
            .map(|items| items.into_iter().map(message_value).collect())
            .map_err(|e| state_error(&e))
    }

    /// Reports whether `key` has a stored cell.
    #[napi(writable = false)]
    pub async fn contains(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .contains_key(key)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Inserts or overwrites `key` with a Kafka message.
    #[napi(
        writable = false,
        ts_args_type = "key: string, message: Message, otelContext: Record<string, string>"
    )]
    pub async fn set(
        &self,
        key: String,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .set(key, message.0)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes `key`.
    #[napi(writable = false)]
    pub async fn remove(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .remove(key)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes every entry.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .clear()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Opens a cursor over entries in key order.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn scan(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeMessageMapCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeMessageMapCursor {
            cursor: self.state.scan(dir),
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Opens a cursor over keys in key order.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn keys(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeMapKeyCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeMapKeyCursor {
            cursor: self.state.keys(dir),
            propagator: Arc::clone(&self.propagator),
        })
    }
}

/// JSON deque state handle for one event.
#[napi]
pub struct NativeJsonDequeState {
    pub(crate) state: BoxDequeState<BinaryPayload>,
    /// The propagator used to re-establish the event parent per operation.
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeJsonDequeState {
    /// The number of live elements.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The element count.
    /// @throws Error carrying the category on `cause` if the read fails, or if
    ///   the count exceeds the `u32` range.
    #[napi(writable = false)]
    pub async fn len(&self, otel_context: HashMap<String, String>) -> napi::Result<u32> {
        let context = op_context(&self.propagator, &otel_context);
        let len = self
            .state
            .len()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))?;
        u32::try_from(len).map_err(|_| {
            transient_error(format!(
                "deque length {len} exceeds the u32 range representable to JavaScript"
            ))
        })
    }

    /// Whether the deque holds no live elements.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns True when the deque is empty.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .is_empty()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Reads the element at front-relative position `index`.
    ///
    /// @param index The zero-based position from the front.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The element, or null past the end.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        index: u32,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        let context = op_context(&self.propagator, &otel_context);
        let index = index as usize;
        self.state
            .get(index)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(json_value)
    }

    /// Reads the front endpoint SLOT without a length round trip — exactly
    /// `get(0)`.
    ///
    /// Decodes and resolves the returned element (unlike eviction). An empty
    /// deque, or a front endpoint slot expired under a TTL, yields null even
    /// when live interior elements exist — a peek never searches inward.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The front element, or null when the endpoint slot is empty.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn peek_front(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .peek_front()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(json_value)
    }

    /// Reads the back endpoint SLOT without a length round trip — exactly
    /// `get(len − 1)`.
    ///
    /// Decodes and resolves the returned element (unlike eviction). An empty
    /// deque, or a back endpoint slot expired under a TTL, yields null even
    /// when live interior elements exist — a peek never searches inward.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The back element, or null when the endpoint slot is empty.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn peek_back(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .peek_back()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(json_value)
    }

    /// Appends a JSON document at the back.
    ///
    /// JSON null is not a storable element and is rejected with a transient
    /// error. Writing a document to a Kafka-message collection is a caller
    /// mistake and is likewise transient (it retries and stays visible, never
    /// discarded).
    ///
    /// @param json The document's JSON text.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(writable = false)]
    pub async fn push_back(
        &self,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        let payload = json_payload(json, " in a deque")?;
        self.state
            .push_back(payload)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Prepends a JSON document at the front.
    ///
    /// JSON null is not a storable element and is rejected with a transient
    /// error. Writing a document to a Kafka-message collection is a caller
    /// mistake and is likewise transient (it retries and stays visible, never
    /// discarded).
    ///
    /// @param json The document's JSON text.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(writable = false)]
    pub async fn push_front(
        &self,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        let payload = json_payload(json, " in a deque")?;
        self.state
            .push_front(payload)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes and returns the front element.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The removed front element, or null when empty.
    /// @throws Error carrying the category on `cause` if the operation fails.
    #[napi(writable = false)]
    pub async fn pop_front(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .pop_front()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(json_value)
    }

    /// Removes and returns the back element.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The removed back element, or null when empty.
    /// @throws Error carrying the category on `cause` if the operation fails.
    #[napi(writable = false)]
    pub async fn pop_back(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .pop_back()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(json_value)
    }

    /// Removes every element.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .clear()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Opens a demand-driven cursor over the live elements in index order.
    ///
    /// Synchronous — it performs no I/O. The extracted JavaScript context is
    /// active while core constructs its semantic stream span; chunk pulls do
    /// not create binding spans.
    ///
    /// @param direction The scan direction (`"forward"` or `"backward"`).
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns A cursor over the deque elements.
    /// @throws Error if the direction token is invalid.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn scan(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeJsonDequeCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeJsonDequeCursor {
            cursor: self.state.scan(dir),
            propagator: Arc::clone(&self.propagator),
        })
    }
}

/// Kafka-message deque state handle for one event.
#[napi]
pub struct NativeMessageDequeState {
    pub(crate) state: BoxDequeState<ConsumerMessage<BinaryPayload>>,
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeMessageDequeState {
    /// Returns the number of live elements.
    #[napi(writable = false)]
    pub async fn len(&self, otel_context: HashMap<String, String>) -> napi::Result<u32> {
        let context = op_context(&self.propagator, &otel_context);
        let len = self
            .state
            .len()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))?;
        u32::try_from(len).map_err(|_| {
            transient_error(format!(
                "deque length {len} exceeds the u32 range representable to JavaScript"
            ))
        })
    }

    /// Reports whether the deque has no live elements.
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .is_empty()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Reads one element by its position from the front.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        index: u32,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get(index as usize)
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Reads the front endpoint.
    #[napi(writable = false)]
    pub async fn peek_front(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .peek_front()
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Reads the back endpoint.
    #[napi(writable = false)]
    pub async fn peek_back(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .peek_back()
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Appends a Kafka message.
    #[napi(
        writable = false,
        ts_args_type = "message: Message, otelContext: Record<string, string>"
    )]
    pub async fn push_back(
        &self,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .push_back(message.0)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Prepends a Kafka message.
    #[napi(
        writable = false,
        ts_args_type = "message: Message, otelContext: Record<string, string>"
    )]
    pub async fn push_front(
        &self,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .push_front(message.0)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes and returns the front element.
    #[napi(writable = false)]
    pub async fn pop_front(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .pop_front()
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Removes and returns the back element.
    #[napi(writable = false)]
    pub async fn pop_back(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .pop_back()
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Removes every element.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .clear()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Opens a cursor over the live elements.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn scan(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeMessageDequeCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeMessageDequeCursor {
            cursor: self.state.scan(dir),
            propagator: Arc::clone(&self.propagator),
        })
    }
}

transaction_methods!(NativeJsonValueState);
transaction_methods!(NativeMessageValueState);
transaction_methods!(NativeJsonMapState);
transaction_methods!(NativeMessageMapState);
transaction_methods!(NativeJsonDequeState);
transaction_methods!(NativeMessageDequeState);

macro_rules! native_cursor {
    ($name:ident, $item:ty, $output:ty, $convert:expr) => {
        /// Demand-driven cursor with one element type.
        #[napi]
        pub struct $name {
            pub(crate) cursor: BoxStateCursor<$item>,
            pub(crate) propagator: Arc<TextMapCompositePropagator>,
        }

        #[napi]
        impl $name {
            /// Pulls the next ready chunk.
            #[napi(writable = false)]
            pub async fn next_chunk(
                &self,
                otel_context: HashMap<String, String>,
            ) -> napi::Result<Option<Vec<$output>>> {
                let context = op_context(&self.propagator, &otel_context);
                pull(&self.cursor, context, $convert).await
            }

            /// Closes the cursor.
            #[napi(writable = false)]
            pub async fn close(&self) {
                self.cursor.close().await;
            }
        }
    };
}

native_cursor!(NativeJsonDequeCursor, BinaryPayload, String, json_text);
native_cursor!(
    NativeJsonMapCursor,
    (String, BinaryPayload),
    (String, String),
    |(key, payload)| Ok((key, json_text(payload)?))
);
native_cursor!(
    NativeMessageDequeCursor,
    ConsumerMessage<BinaryPayload>,
    Message,
    |message| Ok(Message::new(message))
);
native_cursor!(
    NativeMessageMapCursor,
    (String, ConsumerMessage<BinaryPayload>),
    (String, Message),
    |(key, message)| Ok((key, Message::new(message)))
);
native_cursor!(NativeMapKeyCursor, String, String, Ok);

/// Pulls one ready chunk from a cursor and converts its items.
///
/// Preserves the exhausted sentinel: `None` in, `None` out. A store failure
/// becomes a category-tagged error before any item is converted.
///
/// @param cursor The erased cursor to pull from.
/// @param context The OpenTelemetry context to activate for the pull.
/// @param convert Maps one scanned item to the value handed to JavaScript.
/// @returns The converted chunk, or `None` when the scan is exhausted.
/// @throws Error carrying the category on `cause` if the pull fails.
async fn pull<T, U>(
    cursor: &BoxStateCursor<T>,
    context: opentelemetry::Context,
    convert: impl Fn(T) -> napi::Result<U>,
) -> napi::Result<Option<Vec<U>>> {
    cursor
        .next_ready_chunk(SCAN_READY_CHUNK_SIZE)
        .with_context(context)
        .await
        .map_err(|error| state_error(&error))?
        .map(|items| items.into_iter().map(convert).collect())
        .transpose()
}
