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
//! event trace without an extra N-API binding span. Opening a scan performs no
//! read and takes no carrier. Each pull activates its own carrier and
//! transports a vector of up to 256 immediately-ready items without creating
//! per-chunk binding spans.
//!
//! Errors carry their category (`"permanent"` / `"transient"`) as the message
//! of the JavaScript error's `cause`, a machine-readable data channel the
//! typed layer branches on without parsing the human message. No fencing or
//! cursor safety lives here: those are core-owned and this layer only
//! transports and types. `lib/state` checks the caller's arguments before a
//! native call.

use crate::message::Message;
use napi::bindgen_prelude::{FromNapiValue, TypeName, ValueType, sys};
use napi::{Error, Status};
use napi_derive::napi;
use opentelemetry::propagation::{TextMapCompositePropagator, TextMapPropagator};
use opentelemetry::trace::FutureExt;
use prosody::codec::BinaryPayload;
use prosody::consumer::event_context::{
    BoxDequeState, BoxMapState, BoxSetState, BoxValueState, ErasedCategory, ErasedStateError,
    StateCursor,
};
use prosody::consumer::message::ConsumerMessage;
use prosody::state::StoreOutcome;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Arc;

/// Maximum number of immediately-ready scan items transported through N-API
/// in one vector. Core owns ready draining, error ordering, and pull
/// serialization; this binding owns only the transport cap and conversion.
const SCAN_READY_CHUNK_SIZE: NonZeroUsize = NonZeroUsize::new(256).unwrap();

/// A Kafka message crossing into a state handle.
///
/// Unwraps the JavaScript `Message` to the [`ConsumerMessage`] it shares: two
/// reference-count bumps, no byte copies. Owned and `'static`, so it survives
/// the awaits inside the async write methods — a borrowed class reference
/// cannot.
///
/// Accepts any message a handler holds, whether it arrived from the topic or
/// was read back out of a collection — both wrap a real consumer message.
pub struct MessageItem(ConsumerMessage<BinaryPayload>);

/// The effect of a commit or a rollback.
///
/// `"applied"` means the call wrote or discarded buffered operations.
/// `"noOp"` means nothing was buffered.
#[napi(string_enum = "camelCase")]
pub enum NativeStoreOutcome {
    /// The call wrote or discarded buffered operations.
    Applied,
    /// Nothing was buffered.
    NoOp,
}

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
    #[expect(
        unsafe_code,
        reason = "napi declares FromNapiValue::from_napi_value as an unsafe fn"
    )]
    unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> napi::Result<Self> {
        let message = unsafe { <&Message>::from_napi_value(env, napi_val) }?;
        Ok(Self(message.consumer_message()))
    }
}

impl From<StoreOutcome> for NativeStoreOutcome {
    fn from(outcome: StoreOutcome) -> Self {
        match outcome {
            StoreOutcome::Applied => Self::Applied,
            StoreOutcome::NoOp => Self::NoOp,
        }
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

/// Builds a permanent-category napi error for a stored value that cannot be
/// decoded.
///
/// Corruption is not a caller mistake and no retry resolves it, so it is the
/// one condition this layer raises permanent. It surfaces on the read that
/// touched the value rather than being swallowed, which is the only place a
/// caller can see which collection and key went bad.
///
/// @param message The human-readable error message.
/// @returns The structured napi error tagged permanent.
fn permanent_error(message: String) -> Error {
    tagged_error("permanent", message)
}

/// Polls a core state operation under the event's trace context.
///
/// A failure becomes an error that carries its category on `cause`.
///
/// @param propagator The OpenTelemetry propagator for context extraction.
/// @param otelContext The propagated OpenTelemetry carrier.
/// @param operation The core state operation.
/// @returns The operation's result.
pub(crate) async fn run<T, F>(
    propagator: &TextMapCompositePropagator,
    otel_context: &HashMap<String, String>,
    operation: F,
) -> napi::Result<T>
where
    F: Future<Output = Result<T, ErasedStateError>>,
{
    operation
        .with_context(propagator.extract(otel_context))
        .await
        .map_err(|error| state_error(&error))
}

/// Converts a deque length for JavaScript.
///
/// @param len The deque length.
/// @returns The same length as a `u32`.
/// @throws Error (transient) if the length exceeds the `u32` range.
pub(crate) fn length(len: usize) -> napi::Result<u32> {
    u32::try_from(len).map_err(|_| {
        tagged_error(
            "transient",
            format!("deque length {len} exceeds the u32 range representable to JavaScript"),
        )
    })
}

/// Prepares JSON text for a write.
///
/// Takes the string's buffer, so the document is stored verbatim with no copy.
/// Prosody rejects a JSON `null` document with a permanent error.
///
/// @param json The document's JSON text.
/// @returns The payload to hand core.
fn json_payload(json: String) -> BinaryPayload {
    BinaryPayload::new(json.into_bytes(), None::<String>, None::<String>)
}

/// Hands a stored JSON document to JavaScript as its raw text.
///
/// Takes the payload's bytes; UTF-8 validation is a scan, not a copy. Every
/// document this layer stores came from `JSON.stringify`, so invalid UTF-8
/// means a corrupt value — see [`permanent_error`] for why that is the one
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

pub(crate) fn json_value(item: Option<BinaryPayload>) -> napi::Result<Option<String>> {
    item.map(json_text).transpose()
}

fn message_value(item: Option<ConsumerMessage<BinaryPayload>>) -> Option<Message> {
    item.map(Message::new)
}

macro_rules! transaction_methods {
    ($name:ident) => {
        #[napi]
        impl $name {
            /// Durably commits the buffered operations.
            #[napi(writable = false)]
            pub async fn commit(
                &self,
                otel_context: HashMap<String, String>,
            ) -> napi::Result<NativeStoreOutcome> {
                run(&self.propagator, &otel_context, self.state.commit())
                    .await
                    .map(NativeStoreOutcome::from)
            }

            /// Discards the buffered operations.
            #[napi(writable = false)]
            pub async fn rollback(
                &self,
                otel_context: HashMap<String, String>,
            ) -> NativeStoreOutcome {
                let context = self.propagator.extract(&otel_context);
                self.state.rollback().with_context(context).await.into()
            }
        }
    };
}

mod cursor;
mod deque;
mod map;
mod query;
mod set;
mod value;

pub(crate) use cursor::{
    NativeJsonDequeCursor, NativeJsonMapCursor, NativeKeyCursor, NativeMessageDequeCursor,
    NativeMessageMapCursor,
};
pub(crate) use deque::{NativeJsonDequeState, NativeMessageDequeState};
pub(crate) use map::{NativeJsonMapState, NativeMessageMapState};
pub(crate) use query::{NativeKeyQuery, NativePositionQuery};
pub(crate) use set::NativeSetState;
pub(crate) use value::{NativeJsonValueState, NativeMessageValueState};

transaction_methods!(NativeJsonValueState);
transaction_methods!(NativeMessageValueState);
transaction_methods!(NativeJsonMapState);
transaction_methods!(NativeSetState);
transaction_methods!(NativeMessageMapState);
transaction_methods!(NativeJsonDequeState);
transaction_methods!(NativeMessageDequeState);
