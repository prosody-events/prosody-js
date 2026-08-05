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

mod cursor;
mod deque;
mod map;
mod value;

pub(crate) use cursor::{
    NativeJsonDequeCursor, NativeJsonMapCursor, NativeMapKeyCursor, NativeMessageDequeCursor,
    NativeMessageMapCursor,
};
pub(crate) use deque::{NativeJsonDequeState, NativeMessageDequeState};
pub(crate) use map::{NativeJsonMapState, NativeMessageMapState};
pub(crate) use value::{NativeJsonValueState, NativeMessageValueState};

transaction_methods!(NativeJsonValueState);
transaction_methods!(NativeMessageValueState);
transaction_methods!(NativeJsonMapState);
transaction_methods!(NativeMessageMapState);
transaction_methods!(NativeJsonDequeState);
transaction_methods!(NativeMessageDequeState);
