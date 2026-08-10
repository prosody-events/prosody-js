//! The Kafka message handed to JavaScript.
//!
//! [`Message`] wraps the [`ConsumerMessage`] core hands over and exposes its
//! fields as getters. It always holds the real message and never copies its
//! fields into some other shape, for two reasons.
//!
//! A message collection stores the message itself, so a handler must be able to
//! take a message it received — or one it read back out of a collection — and
//! write it straight into another. That only works while the underlying message
//! is still there.
//!
//! Holding it also keeps its consumer permit held, which is the point rather
//! than a cost. The permit is how the loader bounds how many messages are in
//! memory at once. A wrapper that copied the fields out and let the message
//! drop would hand the permit back while the payload bytes stayed alive in
//! JavaScript, so the loader would count memory as free that is still in use.
//!
//! Wrapping is also cheap: a [`ConsumerMessage`] keeps its data in an `Arc`, so
//! this costs two reference-count bumps and no byte copies. The payload crosses
//! as the raw JSON text read from the wire. Rust never parses it; `JSON.parse`
//! on the JavaScript side does, once and lazily.

use chrono::{DateTime, Utc};
use napi::bindgen_prelude::BigInt;
use napi::{Error, Status};
use napi_derive::napi;
use prosody::codec::BinaryPayload;
use prosody::consumer::Keyed;
use prosody::consumer::message::ConsumerMessage;
use prosody::consumer::message::Record;

/// A Kafka message received from a consumer.
#[napi]
pub struct Message {
    /// The message core shares, held rather than copied — see the module docs.
    inner: ConsumerMessage<BinaryPayload>,
}

#[expect(
    clippy::multiple_inherent_impl,
    reason = "napi requires a separate impl block for exported vs internal methods"
)]
impl Message {
    /// Wraps the message core handed over.
    ///
    /// Used for the handler's own message and for one read back out of keyed
    /// state; the two are the same thing to this wrapper.
    pub(crate) fn new(message: ConsumerMessage<BinaryPayload>) -> Self {
        Self { inner: message }
    }

    /// Clones the wrapped message for a keyed-state message write.
    ///
    /// [`ConsumerMessage`] shares its value and processing state through `Arc`,
    /// so this is a pair of reference-count bumps. The stored bytes are the
    /// wire bytes, unchanged.
    pub(crate) fn consumer_message(&self) -> ConsumerMessage<BinaryPayload> {
        self.inner.clone()
    }
}

#[napi]
impl Message {
    /// The Kafka topic this message was consumed from.
    #[napi(getter, writable = false)]
    pub fn topic(&self) -> &'static str {
        self.inner.topic().as_ref()
    }

    /// The partition number within the topic.
    #[napi(getter, writable = false)]
    pub fn partition(&self) -> i32 {
        self.inner.partition()
    }

    /// The offset of this message within its partition.
    #[napi(getter, writable = false)]
    pub fn offset(&self) -> BigInt {
        self.inner.offset().into()
    }

    /// The timestamp when the message was produced.
    #[napi(getter, writable = false)]
    pub fn timestamp(&self) -> DateTime<Utc> {
        *self.inner.timestamp()
    }

    /// The message key used for partitioning.
    #[napi(getter, writable = false)]
    pub fn key(&self) -> &str {
        self.inner.key()
    }

    /// The payload as the raw JSON text read from the wire.
    ///
    /// Borrowed from the wrapped message and copied once into a JavaScript
    /// string; no intermediate Rust buffer is allocated. The typed layer parses
    /// it lazily, so a handler that reads only metadata never pays for a parse.
    ///
    /// @throws Error if the payload is not valid UTF-8, which valid JSON always
    ///   is.
    #[napi(getter, writable = false, ts_return_type = "string")]
    pub fn payload(&self) -> napi::Result<Option<&str>> {
        let payload = match self.inner.record() {
            Record::Message(payload) => payload,
            Record::Excise => return Ok(None),
        };
        str::from_utf8(&payload.bytes).map(Some).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("message payload is not valid UTF-8: {error}"),
            )
        })
    }
}
