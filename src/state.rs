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
//! unrepresentable value, a `null` write, a wrong item shape, an invalid enum
//! token) reject TRANSIENT — a caller code error retries and stays visible
//! rather than discarding the message (see CLAUDE.md error-classification).

use crate::message::Message;
use napi::bindgen_prelude::{Either, Either4, FromNapiValue, TypeName, ValueType, sys};
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
fn parse_direction(direction: &str) -> napi::Result<Direction> {
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
fn op_context(
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

/// Rejects a Kafka message handed to a JSON collection.
///
/// A collection stores one item flavour, fixed at registration. Handing it the
/// other is a caller mistake, so it rejects TRANSIENT like the rest.
///
/// @param kind The collection kind, named in the message.
/// @returns The structured napi error tagged transient.
fn expected_json(kind: &str) -> Error {
    transient_error(format!(
        "a Kafka message cannot be stored in a JSON {kind} collection"
    ))
}

/// Rejects a JSON document handed to a Kafka-message collection.
///
/// @param kind The collection kind, named in the message.
/// @returns The structured napi error tagged transient.
fn expected_message(kind: &str) -> Error {
    transient_error(format!(
        "expected a Kafka message; a JSON document cannot be stored in a message {kind} collection"
    ))
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
fn json_text(payload: BinaryPayload) -> napi::Result<String> {
    String::from_utf8(payload.bytes).map_err(|error| {
        permanent_error(format!("stored JSON document is not valid UTF-8: {error}"))
    })
}

/// Converts one read JSON document into the value handed to JavaScript.
///
/// @param item The document read, or `None` when the cell is absent.
/// @returns The JSON text, or `None` when the cell is absent.
/// @throws Error (transient) if the stored bytes are not valid UTF-8.
fn json_item(item: Option<BinaryPayload>) -> napi::Result<Option<Either<String, Message>>> {
    item.map(|payload| json_text(payload).map(Either::A))
        .transpose()
}

/// Converts one resolved Kafka message into the value handed to JavaScript.
///
/// Detaches it from the loader permit it was resolved under — see
/// [`Message::detached`].
///
/// @param item The message read, or `None` when the cell is absent.
/// @returns The `Message` object, or `None` when the cell is absent.
/// @throws Error if the detached message's permit cannot be acquired.
fn message_item(
    item: Option<ConsumerMessage<BinaryPayload>>,
) -> napi::Result<Option<Either<String, Message>>> {
    item.map(|message| Message::detached(&message).map(Either::B))
        .transpose()
}

/// The two payload flavours a value handle wraps: owned JSON values or
/// loader-resolved Kafka messages.
pub(crate) enum ValueStateVariant {
    /// A JSON value collection.
    Json(BoxValueState<BinaryPayload>),
    /// A Kafka-message collection.
    Message(BoxValueState<ConsumerMessage<BinaryPayload>>),
}

/// The two payload flavours a map handle wraps.
pub(crate) enum MapStateVariant {
    /// A JSON value collection.
    Json(BoxMapState<BinaryPayload>),
    /// A Kafka-message collection.
    Message(BoxMapState<ConsumerMessage<BinaryPayload>>),
}

/// The two payload flavours a deque handle wraps.
pub(crate) enum DequeStateVariant {
    /// A JSON value collection.
    Json(BoxDequeState<BinaryPayload>),
    /// A Kafka-message collection.
    Message(BoxDequeState<ConsumerMessage<BinaryPayload>>),
}

/// The cursor flavours a scan or key-scan yields.
///
/// The four scan flavours are one per (collection, payload) pair; `MapKey` is
/// the single key-only flavour — keys are `String` for both json and message
/// maps, since core's key scan skips the value and never varies by payload.
enum CursorVariant {
    /// A deque JSON scan yielding values.
    DequeJson(BoxStateCursor<BinaryPayload>),
    /// A map JSON scan yielding `(key, value)` entries.
    MapJson(BoxStateCursor<(String, BinaryPayload)>),
    /// A deque message scan yielding messages.
    DequeMessage(BoxStateCursor<ConsumerMessage<BinaryPayload>>),
    /// A map message scan yielding `(key, message)` entries.
    MapMessage(BoxStateCursor<(String, ConsumerMessage<BinaryPayload>)>),
    /// A map key-only scan yielding bare keys (no value decode, no resolver).
    MapKey(BoxStateCursor<String>),
}

/// Maximum number of immediately-ready scan items transported through N-API
/// in one vector. Core owns ready draining, error ordering, and pull
/// serialization; this binding owns only the transport cap and conversion.
const SCAN_READY_CHUNK_SIZE: NonZeroUsize = NonZeroUsize::new(256).unwrap();

/// Erased single-value state handle, vended per event.
///
/// Wraps the boxed erased value handle plus the propagator used to open each
/// operation's span. Values cross as JSON; message collections cross as the
/// `Message` object.
#[napi]
pub struct NativeValueState {
    /// The wrapped erased value handle.
    pub(crate) state: ValueStateVariant,
    /// The propagator used to re-establish the event parent per operation.
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeValueState {
    /// Reads the current value.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The current value, or null when absent/cleared.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Either<String, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            ValueStateVariant::Json(handle) => handle
                .get()
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(json_item),
            ValueStateVariant::Message(handle) => handle
                .get()
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(message_item),
        }
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
    pub async fn set_json(
        &self,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            ValueStateVariant::Json(handle) => {
                let payload = json_payload(json, "; use clear() to remove the value")?;
                handle
                    .set(payload)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            ValueStateVariant::Message(_) => Err(expected_message("value")),
        }
    }

    /// Buffers a write of a Kafka message.
    ///
    /// The message is stored with its wire bytes unchanged. Writing one to a
    /// JSON collection is a caller mistake and is transient (it retries and
    /// stays visible, never discarded).
    ///
    /// @param message The message to write.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(
        writable = false,
        ts_args_type = "message: Message, otelContext: Record<string, string>"
    )]
    pub async fn set_message(
        &self,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            ValueStateVariant::Message(handle) => handle
                .set(message.0)
                .with_context(context)
                .await
                .map_err(|e| state_error(&e)),
            ValueStateVariant::Json(_) => Err(expected_json("value")),
        }
    }

    /// Buffers a clear of the value.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            ValueStateVariant::Json(handle) => handle.clear().with_context(context).await,
            ValueStateVariant::Message(handle) => handle.clear().with_context(context).await,
        }
        .map_err(|e| state_error(&e))
    }

    /// Durably commits the buffered operations mid-handler.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the commit fails.
    #[napi(writable = false)]
    pub async fn commit(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            ValueStateVariant::Json(handle) => handle.commit().with_context(context).await,
            ValueStateVariant::Message(handle) => handle.commit().with_context(context).await,
        }
        .map_err(|e| state_error(&e))
    }

    /// Discards the buffered uncommitted operations.
    ///
    /// Infallible: rolling back a terminated session is a no-op.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    #[napi(writable = false)]
    pub async fn rollback(&self, otel_context: HashMap<String, String>) {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            ValueStateVariant::Json(handle) => handle.rollback().with_context(context).await,
            ValueStateVariant::Message(handle) => handle.rollback().with_context(context).await,
        }
    }
}

/// Erased ordered-map state handle, keyed by `String`, vended per event.
#[napi]
pub struct NativeMapState {
    /// The wrapped erased map handle.
    pub(crate) state: MapStateVariant,
    /// The propagator used to re-establish the event parent per operation.
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeMapState {
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
    ) -> napi::Result<Option<Either<String, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            MapStateVariant::Json(handle) => handle
                .get(key)
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(json_item),
            MapStateVariant::Message(handle) => handle
                .get(key)
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(message_item),
        }
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
    ) -> napi::Result<Vec<Option<Either<String, Message>>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            MapStateVariant::Json(handle) => handle
                .get_many(keys)
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(|items| items.into_iter().map(json_item).collect()),
            MapStateVariant::Message(handle) => handle
                .get_many(keys)
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(|items| items.into_iter().map(message_item).collect()),
        }
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
        match &self.state {
            MapStateVariant::Json(handle) => handle.contains_key(key).with_context(context).await,
            MapStateVariant::Message(handle) => {
                handle.contains_key(key).with_context(context).await
            }
        }
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
    pub async fn set_json(
        &self,
        key: String,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            MapStateVariant::Json(handle) => {
                let payload = json_payload(json, "; use delete(key) to remove the entry")?;
                handle
                    .set(key, payload)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            MapStateVariant::Message(_) => Err(expected_message("map")),
        }
    }

    /// Inserts or overwrites `key` with a Kafka message.
    ///
    /// The message is stored with its wire bytes unchanged. Writing one to a
    /// JSON collection is a caller mistake and is transient (it retries and
    /// stays visible, never discarded).
    ///
    /// @param key The map key.
    /// @param message The message to store.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(
        writable = false,
        ts_args_type = "key: string, message: Message, otelContext: Record<string, string>"
    )]
    pub async fn set_message(
        &self,
        key: String,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            MapStateVariant::Message(handle) => handle
                .set(key, message.0)
                .with_context(context)
                .await
                .map_err(|e| state_error(&e)),
            MapStateVariant::Json(_) => Err(expected_json("map")),
        }
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
        match &self.state {
            MapStateVariant::Json(handle) => handle.remove(key).with_context(context).await,
            MapStateVariant::Message(handle) => handle.remove(key).with_context(context).await,
        }
        .map_err(|e| state_error(&e))
    }

    /// Removes every entry.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            MapStateVariant::Json(handle) => handle.clear().with_context(context).await,
            MapStateVariant::Message(handle) => handle.clear().with_context(context).await,
        }
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
    ) -> napi::Result<NativeStateCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        let cursor = match &self.state {
            MapStateVariant::Json(handle) => CursorVariant::MapJson(handle.scan(dir)),
            MapStateVariant::Message(handle) => CursorVariant::MapMessage(handle.scan(dir)),
        };
        Ok(NativeStateCursor {
            cursor,
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
    ) -> napi::Result<NativeStateCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        let cursor = match &self.state {
            MapStateVariant::Json(handle) => CursorVariant::MapKey(handle.keys(dir)),
            MapStateVariant::Message(handle) => CursorVariant::MapKey(handle.keys(dir)),
        };
        Ok(NativeStateCursor {
            cursor,
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Durably commits the buffered operations mid-handler.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the commit fails.
    #[napi(writable = false)]
    pub async fn commit(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            MapStateVariant::Json(handle) => handle.commit().with_context(context).await,
            MapStateVariant::Message(handle) => handle.commit().with_context(context).await,
        }
        .map_err(|e| state_error(&e))
    }

    /// Discards the buffered uncommitted operations.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    #[napi(writable = false)]
    pub async fn rollback(&self, otel_context: HashMap<String, String>) {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            MapStateVariant::Json(handle) => handle.rollback().with_context(context).await,
            MapStateVariant::Message(handle) => handle.rollback().with_context(context).await,
        }
    }
}

/// Erased deque state handle, vended per event.
#[napi]
pub struct NativeDequeState {
    /// The wrapped erased deque handle.
    pub(crate) state: DequeStateVariant,
    /// The propagator used to re-establish the event parent per operation.
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeDequeState {
    /// The number of live elements.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The element count.
    /// @throws Error carrying the category on `cause` if the read fails, or if
    ///   the count exceeds the `u32` range.
    #[napi(writable = false)]
    pub async fn len(&self, otel_context: HashMap<String, String>) -> napi::Result<u32> {
        let context = op_context(&self.propagator, &otel_context);
        let len = match &self.state {
            DequeStateVariant::Json(handle) => handle.len().with_context(context).await,
            DequeStateVariant::Message(handle) => handle.len().with_context(context).await,
        }
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
        match &self.state {
            DequeStateVariant::Json(handle) => handle.is_empty().with_context(context).await,
            DequeStateVariant::Message(handle) => handle.is_empty().with_context(context).await,
        }
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
    ) -> napi::Result<Option<Either<String, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        let index = index as usize;
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .get(index)
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(json_item),
            DequeStateVariant::Message(handle) => handle
                .get(index)
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(message_item),
        }
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
    ) -> napi::Result<Option<Either<String, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .peek_front()
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(json_item),
            DequeStateVariant::Message(handle) => handle
                .peek_front()
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(message_item),
        }
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
    ) -> napi::Result<Option<Either<String, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .peek_back()
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(json_item),
            DequeStateVariant::Message(handle) => handle
                .peek_back()
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(message_item),
        }
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
    pub async fn push_back_json(
        &self,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => {
                let payload = json_payload(json, " in a deque")?;
                handle
                    .push_back(payload)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            DequeStateVariant::Message(_) => Err(expected_message("deque")),
        }
    }

    /// Appends a Kafka message at the back.
    ///
    /// The message is stored with its wire bytes unchanged. Writing one to a
    /// JSON collection is a caller mistake and is transient (it retries and
    /// stays visible, never discarded).
    ///
    /// @param message The message to store.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(
        writable = false,
        ts_args_type = "message: Message, otelContext: Record<string, string>"
    )]
    pub async fn push_back_message(
        &self,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Message(handle) => handle
                .push_back(message.0)
                .with_context(context)
                .await
                .map_err(|e| state_error(&e)),
            DequeStateVariant::Json(_) => Err(expected_json("deque")),
        }
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
    pub async fn push_front_json(
        &self,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => {
                let payload = json_payload(json, " in a deque")?;
                handle
                    .push_front(payload)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            DequeStateVariant::Message(_) => Err(expected_message("deque")),
        }
    }

    /// Prepends a Kafka message at the front.
    ///
    /// The message is stored with its wire bytes unchanged. Writing one to a
    /// JSON collection is a caller mistake and is transient (it retries and
    /// stays visible, never discarded).
    ///
    /// @param message The message to store.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(
        writable = false,
        ts_args_type = "message: Message, otelContext: Record<string, string>"
    )]
    pub async fn push_front_message(
        &self,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Message(handle) => handle
                .push_front(message.0)
                .with_context(context)
                .await
                .map_err(|e| state_error(&e)),
            DequeStateVariant::Json(_) => Err(expected_json("deque")),
        }
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
    ) -> napi::Result<Option<Either<String, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .pop_front()
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(json_item),
            DequeStateVariant::Message(handle) => handle
                .pop_front()
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(message_item),
        }
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
    ) -> napi::Result<Option<Either<String, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .pop_back()
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(json_item),
            DequeStateVariant::Message(handle) => handle
                .pop_back()
                .with_context(context)
                .await
                .map_err(|e| state_error(&e))
                .and_then(message_item),
        }
    }

    /// Removes every element.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => handle.clear().with_context(context).await,
            DequeStateVariant::Message(handle) => handle.clear().with_context(context).await,
        }
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
    ) -> napi::Result<NativeStateCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        let cursor = match &self.state {
            DequeStateVariant::Json(handle) => CursorVariant::DequeJson(handle.scan(dir)),
            DequeStateVariant::Message(handle) => CursorVariant::DequeMessage(handle.scan(dir)),
        };
        Ok(NativeStateCursor {
            cursor,
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Durably commits the buffered operations mid-handler.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the commit fails.
    #[napi(writable = false)]
    pub async fn commit(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => handle.commit().with_context(context).await,
            DequeStateVariant::Message(handle) => handle.commit().with_context(context).await,
        }
        .map_err(|e| state_error(&e))
    }

    /// Discards the buffered uncommitted operations.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    #[napi(writable = false)]
    pub async fn rollback(&self, otel_context: HashMap<String, String>) {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => handle.rollback().with_context(context).await,
            DequeStateVariant::Message(handle) => handle.rollback().with_context(context).await,
        }
    }
}

/// Demand-driven scan cursor over a map or deque collection.
///
/// Pulling is lazy: each `next_chunk()` restores the JavaScript context without
/// creating a binding span, awaits one stream item, and asks core to drain only
/// the immediately-ready tail. Chunking,
/// exhaustion, error ordering, serialization, close-idempotence, and
/// use-after-close behavior are core-owned; this layer only transports.
#[napi]
pub struct NativeStateCursor {
    /// The wrapped erased cursor.
    cursor: CursorVariant,
    /// The propagator used to re-establish the event parent per pull.
    propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeStateCursor {
    /// Pulls the next immediately-ready chunk of scanned items.
    ///
    /// Awaits the first item, then drains up to 255 more items only while they
    /// are immediately ready. This amortizes N-API overhead without waiting to
    /// fill a chunk.
    ///
    /// Map keys ride the JSON-text arm: they are already strings, and no value
    /// was decoded to produce them. The typed layer knows which cursor it
    /// opened, so the arms never need telling apart at runtime.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The next non-empty vector of items, or null when exhausted.
    /// @throws Error carrying the category on `cause` if the pull fails or the
    ///   cursor was closed.
    #[napi(writable = false)]
    pub async fn next_chunk(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Vec<Either4<String, (String, String), Message, (String, Message)>>>>
    {
        let context = op_context(&self.propagator, &otel_context);
        match &self.cursor {
            CursorVariant::DequeJson(cursor) => {
                pull(cursor, context, |payload| {
                    json_text(payload).map(Either4::A)
                })
                .await
            }
            CursorVariant::MapJson(cursor) => {
                pull(cursor, context, |(key, payload)| {
                    Ok(Either4::B((key, json_text(payload)?)))
                })
                .await
            }
            CursorVariant::DequeMessage(cursor) => {
                pull(cursor, context, |message| {
                    Message::detached(&message).map(Either4::C)
                })
                .await
            }
            CursorVariant::MapMessage(cursor) => {
                pull(cursor, context, |(key, message)| {
                    Ok(Either4::D((key, Message::detached(&message)?)))
                })
                .await
            }
            CursorVariant::MapKey(cursor) => pull(cursor, context, |key| Ok(Either4::A(key))).await,
        }
    }

    /// Closes the cursor, releasing the underlying stream.
    ///
    /// Idempotent; a subsequent `next_chunk()` errors. No span — pure teardown.
    ///
    /// @returns A promise that resolves when the cursor is closed.
    #[napi(writable = false)]
    pub async fn close(&self) {
        match &self.cursor {
            CursorVariant::DequeJson(cursor) => cursor.close().await,
            CursorVariant::MapJson(cursor) => cursor.close().await,
            CursorVariant::DequeMessage(cursor) => cursor.close().await,
            CursorVariant::MapMessage(cursor) => cursor.close().await,
            CursorVariant::MapKey(cursor) => cursor.close().await,
        }
    }
}

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
