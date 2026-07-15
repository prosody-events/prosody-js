//! Erased native layer for keyed state.
//!
//! Wraps the boxed erased handles from
//! [`prosody::consumer::event_context`] as `#[napi]` classes. Collections are
//! addressed by name; JSON payloads cross as `serde_json::Value` (the napi
//! `serde-json` bridge, exactly like message payloads) and Kafka-message items
//! cross as the same `Message` object shape handlers already receive.
//!
//! Every operation opens its own tracing span the timer-method way (extract the
//! parent from the JS-side carrier, then instrument the erased future) — spans
//! open per operation and per cursor `next()`, never at vend, because vended
//! handles outlive the vend call.
//!
//! Errors carry their category (`"permanent"` / `"transient"`) as the message
//! of the JavaScript error's `cause`, a machine-readable data channel the
//! typed layer branches on without parsing the human message. No fencing,
//! cursor safety, or null-write rejection lives here: those are core-owned and
//! this layer only transports and types.

use crate::message::Message;
use napi::bindgen_prelude::{
    Either, Either4, FromNapiValue, TypeName, ValidateNapiValue, ValueType, sys,
};
use napi::{Error, Status};
use napi_derive::napi;
use opentelemetry::propagation::{TextMapCompositePropagator, TextMapPropagator};
use prosody::consumer::event_context::{
    BoxDequeState, BoxMapState, BoxStateCursor, BoxValueState, ErasedCategory, ErasedStateError,
};
use prosody::consumer::message::{ConsumerMessage, ConsumerMessageValue};
use prosody::state::Direction;
use serde_json::Value;
use std::collections::HashMap;
use std::ptr;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tracing::{Instrument, Span, debug, info_span};
use tracing_opentelemetry::OpenTelemetrySpanExt;

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
/// symbol, `undefined`, or external — whether bare or nested inside a container)
/// fails conversion, and an `Err` returned during argument conversion is thrown
/// synchronously by napi with the `cause` category tag STRIPPED — the typed
/// layer would then misclassify the write as transient and retry it forever.
/// The captured `Err` is instead re-raised as a `permanent`-tagged error inside
/// the async method body, on the promise-rejection path where `cause` survives.
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
    // (see the type docs) so the method body can raise a `permanent`-tagged
    // error where the `cause` tag survives, rather than losing it to napi's
    // synchronous argument-conversion throw.
    #[allow(unsafe_code)]
    unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> napi::Result<Self> {
        Ok(Self(
            unsafe { Value::from_napi_value(env, napi_val) }.map_err(|error| {
                format!(
                    "value is not representable as JSON (functions, symbols, `undefined`, \
                     and externals cannot be stored): {error}"
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

/// Builds a permanent-category napi error for a glue-detected condition
/// (argument-shape mistake or value unrepresentable across the boundary).
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
/// @throws Error (permanent) if the token is neither `"forward"` nor `"backward"`.
fn parse_direction(direction: &str) -> napi::Result<Direction> {
    match direction {
        "forward" => Ok(Direction::Forward),
        "backward" => Ok(Direction::Backward),
        other => Err(permanent_error(format!(
            "direction: expected \"forward\" or \"backward\", got {other:?}"
        ))),
    }
}

/// Opens the per-operation span and re-establishes the event parent from the
/// JS-side carrier, exactly like the timer methods on `NativeContext`.
///
/// @param propagator The OpenTelemetry propagator for context extraction.
/// @param otelContext The propagated OpenTelemetry carrier.
/// @param span The freshly-created operation span.
/// @returns The span with its parent set.
fn op_span(
    propagator: &TextMapCompositePropagator,
    otel_context: &HashMap<String, String>,
    span: Span,
) -> Span {
    let context = propagator.extract(otel_context);
    if let Err(err) = span.set_parent(context) {
        debug!("failed to set parent span: {err:#}");
    }
    span
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
/// @throws Error (permanent) if the offset exceeds the lossless `i64` range,
///   or if the processing permit cannot be acquired.
fn consumer_message(message: Message) -> napi::Result<ConsumerMessage<Value>> {
    let (offset, lossless) = message.offset.get_i64();
    if !lossless {
        return Err(permanent_error(
            "message.offset: exceeds the i64 range Kafka offsets occupy".to_owned(),
        ));
    }
    let permit = Arc::new(Semaphore::new(1))
        .try_acquire_owned()
        .map_err(|e| permanent_error(format!("failed to acquire message permit: {e}")))?;
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

/// The four cursor flavours a scan yields, one per (collection, payload) pair.
enum CursorVariant {
    /// A deque JSON scan yielding values.
    DequeJson(BoxStateCursor<Value>),
    /// A map JSON scan yielding `(key, value)` entries.
    MapJson(BoxStateCursor<(String, Value)>),
    /// A deque message scan yielding messages.
    DequeMessage(BoxStateCursor<ConsumerMessage<Value>>),
    /// A map message scan yielding `(key, message)` entries.
    MapMessage(BoxStateCursor<(String, ConsumerMessage<Value>)>),
}

/// Erased single-value state handle, vended per event.
///
/// Wraps the boxed erased value handle plus the propagator used to open each
/// operation's span. Values cross as JSON; message collections cross as the
/// `Message` object.
#[napi]
pub struct NativeValueState {
    /// The wrapped erased value handle.
    pub(crate) state: ValueStateVariant,
    /// The registered collection name (a span field).
    pub(crate) name: String,
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("value.get", collection = %self.name),
        );
        match &self.state {
            ValueStateVariant::Json(handle) => handle
                .get()
                .instrument(span)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            ValueStateVariant::Message(handle) => handle
                .get()
                .instrument(span)
                .await
                .map(|item| item.map(|message| Either::B(Message::from(&message))))
                .map_err(|e| state_error(&e)),
        }
    }

    /// Buffers a write of the value.
    ///
    /// JSON null is rejected by core with a permanent error naming `clear` as
    /// the way to delete. A message-shaped payload cannot be stored in a JSON
    /// collection (and vice versa); such a mismatch is a permanent argument
    /// error.
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("value.set", collection = %self.name),
        );
        match (&self.state, item) {
            (ValueStateVariant::Json(handle), Either::B(JsonItem(value))) => {
                let value = value.map_err(permanent_error)?;
                handle
                    .set(value)
                    .instrument(span)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (ValueStateVariant::Message(handle), Either::A(message)) => {
                let message = consumer_message(message)?;
                handle
                    .set(message)
                    .instrument(span)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (ValueStateVariant::Json(_), Either::A(_)) => Err(permanent_error(
                "a Kafka-message payload cannot be stored in a JSON value collection".to_owned(),
            )),
            (ValueStateVariant::Message(_), Either::B(_)) => Err(permanent_error(
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("value.clear", collection = %self.name),
        );
        match &self.state {
            ValueStateVariant::Json(handle) => handle.clear().instrument(span).await,
            ValueStateVariant::Message(handle) => handle.clear().instrument(span).await,
        }
        .map_err(|e| state_error(&e))
    }

    /// Durably commits the buffered operations mid-handler.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the commit fails.
    #[napi(writable = false)]
    pub async fn commit(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("value.commit", collection = %self.name),
        );
        match &self.state {
            ValueStateVariant::Json(handle) => handle.commit().instrument(span).await,
            ValueStateVariant::Message(handle) => handle.commit().instrument(span).await,
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("value.rollback", collection = %self.name),
        );
        match &self.state {
            ValueStateVariant::Json(handle) => handle.rollback().instrument(span).await,
            ValueStateVariant::Message(handle) => handle.rollback().instrument(span).await,
        }
    }
}

/// Erased ordered-map state handle, keyed by `String`, vended per event.
#[napi]
pub struct NativeMapState {
    /// The wrapped erased map handle.
    pub(crate) state: MapStateVariant,
    /// The registered collection name (a span field).
    pub(crate) name: String,
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("map.get", collection = %self.name),
        );
        match &self.state {
            MapStateVariant::Json(handle) => handle
                .get(key)
                .instrument(span)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            MapStateVariant::Message(handle) => handle
                .get(key)
                .instrument(span)
                .await
                .map(|item| item.map(|message| Either::B(Message::from(&message))))
                .map_err(|e| state_error(&e)),
        }
    }

    /// Inserts or overwrites `key`.
    ///
    /// JSON null is rejected by core with a permanent error naming `remove` as
    /// the way to delete an entry. An item-shape mismatch is a permanent
    /// argument error.
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("map.set", collection = %self.name),
        );
        match (&self.state, item) {
            (MapStateVariant::Json(handle), Either::B(JsonItem(value))) => {
                let value = value.map_err(permanent_error)?;
                handle
                    .set(key, value)
                    .instrument(span)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (MapStateVariant::Message(handle), Either::A(message)) => {
                let message = consumer_message(message)?;
                handle
                    .set(key, message)
                    .instrument(span)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (MapStateVariant::Json(_), Either::A(_)) => Err(permanent_error(
                "a Kafka-message payload cannot be stored in a JSON map collection".to_owned(),
            )),
            (MapStateVariant::Message(_), Either::B(_)) => Err(permanent_error(
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("map.remove", collection = %self.name),
        );
        match &self.state {
            MapStateVariant::Json(handle) => handle.remove(key).instrument(span).await,
            MapStateVariant::Message(handle) => handle.remove(key).instrument(span).await,
        }
        .map_err(|e| state_error(&e))
    }

    /// Removes every entry.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("map.clear", collection = %self.name),
        );
        match &self.state {
            MapStateVariant::Json(handle) => handle.clear().instrument(span).await,
            MapStateVariant::Message(handle) => handle.clear().instrument(span).await,
        }
        .map_err(|e| state_error(&e))
    }

    /// Opens a demand-driven cursor over the live entries in key order.
    ///
    /// Synchronous — it performs no I/O and opens no span; each cursor `next()`
    /// opens its own span. Entries are yielded as `(key, value)` pairs.
    ///
    /// @param direction The scan direction (`"forward"` or `"backward"`).
    /// @returns A cursor over the map entries.
    /// @throws Error if the direction token is invalid.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn scan(&self, direction: String) -> napi::Result<NativeStateCursor> {
        let dir = parse_direction(&direction)?;
        let cursor = match &self.state {
            MapStateVariant::Json(handle) => CursorVariant::MapJson(handle.scan(dir)),
            MapStateVariant::Message(handle) => CursorVariant::MapMessage(handle.scan(dir)),
        };
        Ok(NativeStateCursor {
            cursor,
            name: self.name.clone(),
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Durably commits the buffered operations mid-handler.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the commit fails.
    #[napi(writable = false)]
    pub async fn commit(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("map.commit", collection = %self.name),
        );
        match &self.state {
            MapStateVariant::Json(handle) => handle.commit().instrument(span).await,
            MapStateVariant::Message(handle) => handle.commit().instrument(span).await,
        }
        .map_err(|e| state_error(&e))
    }

    /// Discards the buffered uncommitted operations.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    #[napi(writable = false)]
    pub async fn rollback(&self, otel_context: HashMap<String, String>) {
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("map.rollback", collection = %self.name),
        );
        match &self.state {
            MapStateVariant::Json(handle) => handle.rollback().instrument(span).await,
            MapStateVariant::Message(handle) => handle.rollback().instrument(span).await,
        }
    }
}

/// Erased deque state handle, vended per event.
#[napi]
pub struct NativeDequeState {
    /// The wrapped erased deque handle.
    pub(crate) state: DequeStateVariant,
    /// The registered collection name (a span field).
    pub(crate) name: String,
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("deque.len", collection = %self.name),
        );
        let len = match &self.state {
            DequeStateVariant::Json(handle) => handle.len().instrument(span).await,
            DequeStateVariant::Message(handle) => handle.len().instrument(span).await,
        }
        .map_err(|e| state_error(&e))?;
        u32::try_from(len).map_err(|_| {
            permanent_error(format!(
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("deque.is_empty", collection = %self.name),
        );
        match &self.state {
            DequeStateVariant::Json(handle) => handle.is_empty().instrument(span).await,
            DequeStateVariant::Message(handle) => handle.is_empty().instrument(span).await,
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("deque.get", collection = %self.name),
        );
        let index = index as usize;
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .get(index)
                .instrument(span)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            DequeStateVariant::Message(handle) => handle
                .get(index)
                .instrument(span)
                .await
                .map(|item| item.map(|message| Either::B(Message::from(&message))))
                .map_err(|e| state_error(&e)),
        }
    }

    /// Appends an element at the back.
    ///
    /// JSON null is rejected by core with a permanent error naming `clear`. An
    /// item-shape mismatch is a permanent argument error.
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("deque.push_back", collection = %self.name),
        );
        match (&self.state, item) {
            (DequeStateVariant::Json(handle), Either::B(JsonItem(value))) => {
                let value = value.map_err(permanent_error)?;
                handle
                    .push_back(value)
                    .instrument(span)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (DequeStateVariant::Message(handle), Either::A(message)) => {
                let message = consumer_message(message)?;
                handle
                    .push_back(message)
                    .instrument(span)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (DequeStateVariant::Json(_), Either::A(_)) => Err(permanent_error(
                "a Kafka-message payload cannot be stored in a JSON deque collection".to_owned(),
            )),
            (DequeStateVariant::Message(_), Either::B(_)) => Err(permanent_error(
                "a JSON payload cannot be stored in a Kafka-message deque collection".to_owned(),
            )),
        }
    }

    /// Prepends an element at the front.
    ///
    /// JSON null is rejected by core with a permanent error naming `clear`. An
    /// item-shape mismatch is a permanent argument error.
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("deque.push_front", collection = %self.name),
        );
        match (&self.state, item) {
            (DequeStateVariant::Json(handle), Either::B(JsonItem(value))) => {
                let value = value.map_err(permanent_error)?;
                handle
                    .push_front(value)
                    .instrument(span)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (DequeStateVariant::Message(handle), Either::A(message)) => {
                let message = consumer_message(message)?;
                handle
                    .push_front(message)
                    .instrument(span)
                    .await
                    .map_err(|e| state_error(&e))
            }
            (DequeStateVariant::Json(_), Either::A(_)) => Err(permanent_error(
                "a Kafka-message payload cannot be stored in a JSON deque collection".to_owned(),
            )),
            (DequeStateVariant::Message(_), Either::B(_)) => Err(permanent_error(
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("deque.pop_front", collection = %self.name),
        );
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .pop_front()
                .instrument(span)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            DequeStateVariant::Message(handle) => handle
                .pop_front()
                .instrument(span)
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("deque.pop_back", collection = %self.name),
        );
        match &self.state {
            DequeStateVariant::Json(handle) => handle
                .pop_back()
                .instrument(span)
                .await
                .map(|item| item.map(Either::A))
                .map_err(|e| state_error(&e)),
            DequeStateVariant::Message(handle) => handle
                .pop_back()
                .instrument(span)
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
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("deque.clear", collection = %self.name),
        );
        match &self.state {
            DequeStateVariant::Json(handle) => handle.clear().instrument(span).await,
            DequeStateVariant::Message(handle) => handle.clear().instrument(span).await,
        }
        .map_err(|e| state_error(&e))
    }

    /// Opens a demand-driven cursor over the live elements in index order.
    ///
    /// Synchronous — it performs no I/O and opens no span; each cursor `next()`
    /// opens its own span.
    ///
    /// @param direction The scan direction (`"forward"` or `"backward"`).
    /// @returns A cursor over the deque elements.
    /// @throws Error if the direction token is invalid.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn scan(&self, direction: String) -> napi::Result<NativeStateCursor> {
        let dir = parse_direction(&direction)?;
        let cursor = match &self.state {
            DequeStateVariant::Json(handle) => CursorVariant::DequeJson(handle.scan(dir)),
            DequeStateVariant::Message(handle) => CursorVariant::DequeMessage(handle.scan(dir)),
        };
        Ok(NativeStateCursor {
            cursor,
            name: self.name.clone(),
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Durably commits the buffered operations mid-handler.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the commit fails.
    #[napi(writable = false)]
    pub async fn commit(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("deque.commit", collection = %self.name),
        );
        match &self.state {
            DequeStateVariant::Json(handle) => handle.commit().instrument(span).await,
            DequeStateVariant::Message(handle) => handle.commit().instrument(span).await,
        }
        .map_err(|e| state_error(&e))
    }

    /// Discards the buffered uncommitted operations.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    #[napi(writable = false)]
    pub async fn rollback(&self, otel_context: HashMap<String, String>) {
        let span = op_span(
            &self.propagator,
            &otel_context,
            info_span!("deque.rollback", collection = %self.name),
        );
        match &self.state {
            DequeStateVariant::Json(handle) => handle.rollback().instrument(span).await,
            DequeStateVariant::Message(handle) => handle.rollback().instrument(span).await,
        }
    }
}

/// Demand-driven scan cursor over a map or deque collection.
///
/// Pulling is lazy: each `next()` opens its own span and drives the underlying
/// erased stream one step. Exhaustion, close-idempotence, and use-after-close
/// errors are all core-owned; this layer only transports.
#[napi]
pub struct NativeStateCursor {
    /// The wrapped erased cursor.
    cursor: CursorVariant,
    /// The scanned collection name (a span field).
    name: String,
    /// The propagator used to re-establish the event parent per pull.
    propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeStateCursor {
    /// Pulls the next scanned item.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The next item (a deque value/message, or a map `[key, value]`
    ///   entry), or null when the scan is exhausted.
    /// @throws Error carrying the category on `cause` if the pull fails or the
    ///   cursor was closed.
    #[napi(writable = false)]
    pub async fn next(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Either4<Value, (String, Value), Message, (String, Message)>>> {
        let span = match &self.cursor {
            CursorVariant::DequeJson(_) | CursorVariant::DequeMessage(_) => op_span(
                &self.propagator,
                &otel_context,
                info_span!("deque.stream.next", collection = %self.name),
            ),
            CursorVariant::MapJson(_) | CursorVariant::MapMessage(_) => op_span(
                &self.propagator,
                &otel_context,
                info_span!("map.stream.next", collection = %self.name),
            ),
        };
        match &self.cursor {
            CursorVariant::DequeJson(cursor) => cursor
                .next()
                .instrument(span)
                .await
                .map(|item| item.map(Either4::A))
                .map_err(|e| state_error(&e)),
            CursorVariant::MapJson(cursor) => cursor
                .next()
                .instrument(span)
                .await
                .map(|item| item.map(Either4::B))
                .map_err(|e| state_error(&e)),
            CursorVariant::DequeMessage(cursor) => cursor
                .next()
                .instrument(span)
                .await
                .map(|item| item.map(|message| Either4::C(Message::from(&message))))
                .map_err(|e| state_error(&e)),
            CursorVariant::MapMessage(cursor) => cursor
                .next()
                .instrument(span)
                .await
                .map(|item| item.map(|(key, message)| Either4::D((key, Message::from(&message)))))
                .map_err(|e| state_error(&e)),
        }
    }

    /// Closes the cursor, releasing the underlying stream.
    ///
    /// Idempotent; a subsequent `next()` errors. No span — pure teardown.
    ///
    /// @returns A promise that resolves when the cursor is closed.
    #[napi(writable = false)]
    pub async fn close(&self) {
        match &self.cursor {
            CursorVariant::DequeJson(cursor) => cursor.close().await,
            CursorVariant::MapJson(cursor) => cursor.close().await,
            CursorVariant::DequeMessage(cursor) => cursor.close().await,
            CursorVariant::MapMessage(cursor) => cursor.close().await,
        }
    }
}
