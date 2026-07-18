//! Erased native layer for keyed state.
//!
//! Wraps the boxed erased handles from
//! [`prosody::consumer::event_context`] as `#[napi]` classes. Collections are
//! addressed by name; JSON payloads cross as `serde_json::Value` (the napi
//! `serde-json` bridge, exactly like message payloads) and Kafka-message items
//! cross as the same `Message` object shape handlers already receive.
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
use napi::bindgen_prelude::{
    Either, Either4, FromNapiValue, TypeName, ValidateNapiValue, ValueType, sys,
};
use napi::{Error, Status};
use napi_derive::napi;
use opentelemetry::propagation::{TextMapCompositePropagator, TextMapPropagator};
use opentelemetry::trace::FutureExt;
use prosody::consumer::event_context::{
    BoxDequeState, BoxMapState, BoxStateCursor, BoxValueState, ErasedCategory, ErasedStateError,
};
use prosody::consumer::message::{ConsumerMessage, ConsumerMessageValue};
use prosody::state::Direction;
use serde_json::Value;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::ptr;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tracing::Span;

/// Item shape crossing INTO a state handle. `Message` is tried first so a
/// genuine message object routes to the message arm; a plain JSON value fails
/// `Message` conversion and falls through to [`JsonItem`] (napi `Either`
/// else-chain), which is how JSON writes land. The generated TypeScript for
/// these arguments is overridden with `ts_args_type` (the erased `JsonItem`
/// arm has no standalone TS type); the typed layer restores the generics.
type ItemIn = Either<Message, JsonItem>;

/// A JSON value in a napi `Either` input arm.
///
/// `serde_json::Value` implements `FromNapiValue` but neither `TypeName` nor
/// `ValidateNapiValue`, so it cannot occupy an `Either` input arm directly.
/// This newtype supplies both. Its validation accepts any JS value (returning
/// the null "valid" sentinel), so a value that is not a `Message` falls through
/// to here and is decoded as JSON — a bare string, number, boolean, array,
/// object, or the JSON `null` sentinel that core then rejects at write.
///
/// The conversion OUTCOME is captured as a `Result` rather than surfaced as a
/// `from_napi_value` error: a JS value with no JSON representation (a function,
/// symbol, `undefined`, or external — whether bare or nested inside a
/// container) is a CALLER MISTAKE, so it must reject TRANSIENT — it retries and
/// stays visible rather than discarding the message and losing data (see
/// CLAUDE.md error-classification). An `Err` returned during argument
/// conversion is thrown synchronously by napi with the `cause` category tag
/// STRIPPED, so the category would be implicit; capturing the `Err` and
/// re-raising a `transient`-tagged error inside the async method body — on the
/// promise-rejection path where `cause` survives — makes the category explicit
/// and carries a clean message.
///
/// One nested case does NOT reach here: an `undefined` OBJECT property is
/// dropped by the serde bridge (as `JSON.stringify` does) rather than failing,
/// so it is silently omitted. A nested function/symbol, and `undefined` as an
/// array ELEMENT, do fail and are captured. A value whose getter or proxy trap
/// THROWS is a separate, pre-existing case: napi leaves that JS exception
/// pending and surfaces it untagged before this method body runs, so it is not
/// re-tagged here.
pub struct JsonItem(Result<Value, String>);

impl TypeName for JsonItem {
    fn type_name() -> &'static str {
        "any"
    }

    fn value_type() -> ValueType {
        ValueType::Unknown
    }
}

impl ValidateNapiValue for JsonItem {
    // SAFETY: this override inspects nothing — it unconditionally reports the
    // value as valid by returning the null "no rejected promise" sentinel, so
    // `env`/`napi_val` are never dereferenced. The actual type filtering is
    // deferred to `Value::from_napi_value`, which rejects the JS kinds that
    // have no `serde_json::Value` representation.
    #[allow(unsafe_code)]
    unsafe fn validate(
        _env: sys::napi_env,
        _napi_val: sys::napi_value,
    ) -> napi::Result<sys::napi_value> {
        Ok(ptr::null_mut())
    }
}

impl FromNapiValue for JsonItem {
    // SAFETY: `env` and `napi_val` are guaranteed valid by the NAPI-RS runtime
    // when this is invoked through the framework, and the call is forwarded
    // unchanged to `Value::from_napi_value`, which performs its own validated
    // conversion via safe NAPI-RS accessors.
    //
    // This never returns `Err`: a failed conversion is captured in the newtype
    // (see the type docs) so the method body can raise a `transient`-tagged
    // error where the `cause` tag survives, rather than losing it to napi's
    // synchronous argument-conversion throw.
    #[allow(unsafe_code)]
    unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> napi::Result<Self> {
        Ok(Self(
            unsafe { Value::from_napi_value(env, napi_val) }.map_err(|error| {
                format!(
                    "value is not representable as JSON (functions, symbols, `undefined`, and \
                     externals cannot be stored): {error}"
                )
            }),
        ))
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

/// Rejects a JSON `null` write as a transient caller error.
///
/// `null` is not a storable value (it is indistinguishable from absence). Like
/// every caller mistake it is TRANSIENT, not permanent — it retries and stays
/// visible rather than discarding the message. `advice` names the deletion verb
/// for the collection kind (a deque has none).
///
/// @param value The converted JSON value to check.
/// @param advice A trailing clause naming how to delete instead.
/// @returns `Ok` unless `value` is JSON `null`.
fn reject_null(value: &Value, advice: &str) -> napi::Result<()> {
    if value.is_null() {
        return Err(transient_error(format!(
            "JSON null is not a storable value{advice}"
        )));
    }
    Ok(())
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

/// Rebuilds a `ConsumerMessage` from the JavaScript `Message` for a
/// message-collection write.
///
/// Only topic/partition/offset feed the stored message reference; the rest
/// rides along. The offset is read losslessly from the `BigInt`, and a fresh
/// single-permit semaphore supplies the processing permit (never contended —
/// the message is not being scheduled).
///
/// @param message The JavaScript message to rebuild.
/// @returns The reconstructed `ConsumerMessage`.
/// @throws Error (transient) if the offset exceeds the lossless `i64` range,
///   or if the processing permit cannot be acquired.
fn consumer_message(message: Message) -> napi::Result<ConsumerMessage<Value>> {
    let (offset, lossless) = message.offset.get_i64();
    if !lossless {
        return Err(transient_error(
            "message.offset: exceeds the i64 range Kafka offsets occupy".to_owned(),
        ));
    }
    let permit = Arc::new(Semaphore::new(1))
        .try_acquire_owned()
        .map_err(|e| transient_error(format!("failed to acquire message permit: {e}")))?;
    let value = ConsumerMessageValue {
        source_system: None,
        topic: message.topic.as_str().into(),
        partition: message.partition,
        offset,
        key: message.key.into(),
        timestamp: message.timestamp,
        payload: message.payload,
    };
    Ok(ConsumerMessage::new(value, Span::current(), permit))
}

/// The two payload flavours a value handle wraps: owned JSON values or
/// loader-resolved Kafka messages.
pub(crate) enum ValueStateVariant {
    /// A JSON value collection.
    Json(BoxValueState<Value>),
    /// A Kafka-message collection.
    Message(BoxValueState<ConsumerMessage<Value>>),
}

/// The two payload flavours a map handle wraps.
pub(crate) enum MapStateVariant {
    /// A JSON value collection.
    Json(BoxMapState<Value>),
    /// A Kafka-message collection.
    Message(BoxMapState<ConsumerMessage<Value>>),
}

/// The two payload flavours a deque handle wraps.
pub(crate) enum DequeStateVariant {
    /// A JSON value collection.
    Json(BoxDequeState<Value>),
    /// A Kafka-message collection.
    Message(BoxDequeState<ConsumerMessage<Value>>),
}

/// The cursor flavours a scan or key-scan yields.
///
/// The four scan flavours are one per (collection, payload) pair; `MapKey` is
/// the single key-only flavour — keys are `String` for both json and message
/// maps, since core's key scan skips the value and never varies by payload.
enum CursorVariant {
    /// A deque JSON scan yielding values.
    DequeJson(BoxStateCursor<Value>),
    /// A map JSON scan yielding `(key, value)` entries.
    MapJson(BoxStateCursor<(String, Value)>),
    /// A deque message scan yielding messages.
    DequeMessage(BoxStateCursor<ConsumerMessage<Value>>),
    /// A map message scan yielding `(key, message)` entries.
    MapMessage(BoxStateCursor<(String, ConsumerMessage<Value>)>),
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
    ) -> napi::Result<Option<Either<Value, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            ValueStateVariant::Json(handle) => handle
                .get()
                .with_context(context)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            ValueStateVariant::Message(handle) => handle
                .get()
                .with_context(context)
                .await
                .map(|item| item.map(|message| Either::B(Message::from(&message))))
                .map_err(|e| state_error(&e)),
        }
    }

    /// Buffers a write of the value.
    ///
    /// JSON null is rejected with a transient error naming `clear` as the way
    /// to delete. A message-shaped payload cannot be stored in a JSON
    /// collection (and vice versa); such a mismatch is a caller mistake and is
    /// likewise transient (it retries and stays visible, never discarded).
    ///
    /// @param item The value (JSON) or message to write.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(
        writable = false,
        ts_args_type = "item: any, otelContext: Record<string, string>"
    )]
    pub async fn set(
        &self,
        item: ItemIn,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match (&self.state, item) {
            (ValueStateVariant::Json(handle), Either::B(JsonItem(value))) => {
                let value = value.map_err(transient_error)?;
                reject_null(&value, "; use clear() to remove the value")?;
                handle
                    .set(value)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (ValueStateVariant::Message(handle), Either::A(message)) => {
                let message = consumer_message(message)?;
                handle
                    .set(message)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (ValueStateVariant::Json(_), Either::A(_)) => Err(transient_error(
                "a Kafka-message payload cannot be stored in a JSON value collection".to_owned(),
            )),
            (ValueStateVariant::Message(_), Either::B(_)) => Err(transient_error(
                "expected a Kafka message; use clear() to delete a message value collection"
                    .to_owned(),
            )),
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
    ) -> napi::Result<Option<Either<Value, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            MapStateVariant::Json(handle) => handle
                .get(key)
                .with_context(context)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            MapStateVariant::Message(handle) => handle
                .get(key)
                .with_context(context)
                .await
                .map(|item| item.map(|message| Either::B(Message::from(&message))))
                .map_err(|e| state_error(&e)),
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
    ) -> napi::Result<Vec<Option<Either<Value, Message>>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            MapStateVariant::Json(handle) => handle
                .get_many(keys)
                .with_context(context)
                .await
                .map(|items| items.into_iter().map(|item| item.map(Either::A)).collect())
                .map_err(|e| state_error(&e)),
            MapStateVariant::Message(handle) => handle
                .get_many(keys)
                .with_context(context)
                .await
                .map(|items| {
                    items
                        .into_iter()
                        .map(|item| item.map(|message| Either::B(Message::from(&message))))
                        .collect()
                })
                .map_err(|e| state_error(&e)),
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

    /// Inserts or overwrites `key`.
    ///
    /// JSON null is rejected with a transient error naming `delete` as the way
    /// to remove an entry. An item-shape mismatch is a caller mistake and is
    /// likewise transient (it retries and stays visible, never discarded).
    ///
    /// @param key The map key.
    /// @param item The value (JSON) or message to store.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(
        writable = false,
        ts_args_type = "key: string, item: any, otelContext: Record<string, string>"
    )]
    pub async fn set(
        &self,
        key: String,
        item: ItemIn,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match (&self.state, item) {
            (MapStateVariant::Json(handle), Either::B(JsonItem(value))) => {
                let value = value.map_err(transient_error)?;
                reject_null(&value, "; use delete(key) to remove the entry")?;
                handle
                    .set(key, value)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (MapStateVariant::Message(handle), Either::A(message)) => {
                let message = consumer_message(message)?;
                handle
                    .set(key, message)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (MapStateVariant::Json(_), Either::A(_)) => Err(transient_error(
                "a Kafka-message payload cannot be stored in a JSON map collection".to_owned(),
            )),
            (MapStateVariant::Message(_), Either::B(_)) => Err(transient_error(
                "expected a Kafka message; use remove(key) to delete a message map entry"
                    .to_owned(),
            )),
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
    ) -> napi::Result<Option<Either<Value, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        let index = index as usize;
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .get(index)
                .with_context(context)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            DequeStateVariant::Message(handle) => handle
                .get(index)
                .with_context(context)
                .await
                .map(|item| item.map(|message| Either::B(Message::from(&message))))
                .map_err(|e| state_error(&e)),
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
    ) -> napi::Result<Option<Either<Value, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .peek_front()
                .with_context(context)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            DequeStateVariant::Message(handle) => handle
                .peek_front()
                .with_context(context)
                .await
                .map(|item| item.map(|message| Either::B(Message::from(&message))))
                .map_err(|e| state_error(&e)),
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
    ) -> napi::Result<Option<Either<Value, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .peek_back()
                .with_context(context)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            DequeStateVariant::Message(handle) => handle
                .peek_back()
                .with_context(context)
                .await
                .map(|item| item.map(|message| Either::B(Message::from(&message))))
                .map_err(|e| state_error(&e)),
        }
    }

    /// Appends an element at the back.
    ///
    /// JSON null is not a storable element and is rejected with a transient
    /// error. An item-shape mismatch is a caller mistake and is likewise
    /// transient (it retries and stays visible, never discarded).
    ///
    /// @param item The value (JSON) or message to append.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(
        writable = false,
        ts_args_type = "item: any, otelContext: Record<string, string>"
    )]
    pub async fn push_back(
        &self,
        item: ItemIn,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match (&self.state, item) {
            (DequeStateVariant::Json(handle), Either::B(JsonItem(value))) => {
                let value = value.map_err(transient_error)?;
                reject_null(&value, " in a deque")?;
                handle
                    .push_back(value)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (DequeStateVariant::Message(handle), Either::A(message)) => {
                let message = consumer_message(message)?;
                handle
                    .push_back(message)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (DequeStateVariant::Json(_), Either::A(_)) => Err(transient_error(
                "a Kafka-message payload cannot be stored in a JSON deque collection".to_owned(),
            )),
            (DequeStateVariant::Message(_), Either::B(_)) => Err(transient_error(
                "a JSON payload cannot be stored in a Kafka-message deque collection".to_owned(),
            )),
        }
    }

    /// Prepends an element at the front.
    ///
    /// JSON null is not a storable element and is rejected with a transient
    /// error. An item-shape mismatch is a caller mistake and is likewise
    /// transient (it retries and stays visible, never discarded).
    ///
    /// @param item The value (JSON) or message to prepend.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(
        writable = false,
        ts_args_type = "item: any, otelContext: Record<string, string>"
    )]
    pub async fn push_front(
        &self,
        item: ItemIn,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        match (&self.state, item) {
            (DequeStateVariant::Json(handle), Either::B(JsonItem(value))) => {
                let value = value.map_err(transient_error)?;
                reject_null(&value, " in a deque")?;
                handle
                    .push_front(value)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (DequeStateVariant::Message(handle), Either::A(message)) => {
                let message = consumer_message(message)?;
                handle
                    .push_front(message)
                    .with_context(context)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (DequeStateVariant::Json(_), Either::A(_)) => Err(transient_error(
                "a Kafka-message payload cannot be stored in a JSON deque collection".to_owned(),
            )),
            (DequeStateVariant::Message(_), Either::B(_)) => Err(transient_error(
                "a JSON payload cannot be stored in a Kafka-message deque collection".to_owned(),
            )),
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
    ) -> napi::Result<Option<Either<Value, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .pop_front()
                .with_context(context)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            DequeStateVariant::Message(handle) => handle
                .pop_front()
                .with_context(context)
                .await
                .map(|item| item.map(|message| Either::B(Message::from(&message))))
                .map_err(|e| state_error(&e)),
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
    ) -> napi::Result<Option<Either<Value, Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .pop_back()
                .with_context(context)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            DequeStateVariant::Message(handle) => handle
                .pop_back()
                .with_context(context)
                .await
                .map(|item| item.map(|message| Either::B(Message::from(&message))))
                .map_err(|e| state_error(&e)),
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
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The next non-empty vector of items, or null when exhausted.
    /// @throws Error carrying the category on `cause` if the pull fails or the
    ///   cursor was closed.
    #[napi(writable = false)]
    pub async fn next_chunk(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Vec<Either4<Value, (String, Value), Message, (String, Message)>>>>
    {
        let context = op_context(&self.propagator, &otel_context);
        match &self.cursor {
            CursorVariant::DequeJson(cursor) => cursor
                .next_ready_chunk(SCAN_READY_CHUNK_SIZE)
                .with_context(context)
                .await
                .map(|chunk| chunk.map(|items| items.into_iter().map(Either4::A).collect())),
            CursorVariant::MapJson(cursor) => cursor
                .next_ready_chunk(SCAN_READY_CHUNK_SIZE)
                .with_context(context)
                .await
                .map(|chunk| chunk.map(|items| items.into_iter().map(Either4::B).collect())),
            CursorVariant::DequeMessage(cursor) => cursor
                .next_ready_chunk(SCAN_READY_CHUNK_SIZE)
                .with_context(context)
                .await
                .map(|chunk| {
                    chunk.map(|items| {
                        items
                            .into_iter()
                            .map(|message| Either4::C(Message::from(&message)))
                            .collect()
                    })
                }),
            CursorVariant::MapMessage(cursor) => cursor
                .next_ready_chunk(SCAN_READY_CHUNK_SIZE)
                .with_context(context)
                .await
                .map(|chunk| {
                    chunk.map(|items| {
                        items
                            .into_iter()
                            .map(|(key, message)| Either4::D((key, Message::from(&message))))
                            .collect()
                    })
                }),
            CursorVariant::MapKey(cursor) => cursor
                .next_ready_chunk(SCAN_READY_CHUNK_SIZE)
                .with_context(context)
                .await
                // Keys are strings; carry them through the existing value arm
                // rather than widening the cursor union — napi materializes a
                // `Value::String` straight to a JS string, and no value was
                // decoded to produce it.
                .map(|chunk| {
                    chunk.map(|keys| {
                        keys.into_iter()
                            .map(|k| Either4::A(Value::String(k)))
                            .collect()
                    })
                }),
        }
        .map_err(|error| state_error(&error))
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
