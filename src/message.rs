//! The Kafka message handed to JavaScript.
//!
//! [`Message`] wraps prosody's [`ConsumerMessage`] and exposes its fields as
//! getters. It holds the message rather than copying out of it: a
//! [`ConsumerMessage`] shares its data through an `Arc`, so wrapping one costs
//! two reference-count bumps and no byte copies.
//!
//! The payload crosses as the raw JSON text decoded verbatim from the wire by
//! [`JsonBinaryCodec`], borrowed straight from the shared message. Rust never
//! parses it; `JSON.parse` on the JavaScript side does, once and lazily.
//!
//! [`JsonBinaryCodec`] still scans each payload for the `id` and `type` it uses
//! as event metadata, and that scan constrains what a payload may be. It must
//! be a JSON **object** whose `id` and `type`, if present, are strings or null,
//! and neither key may repeat. A payload that breaks those rules fails to
//! decode and the consumer discards it. The previous `JsonCodec` parsed any
//! JSON document and simply reported no metadata, so a payload with a numeric
//! `id`, or one that is a top-level array or scalar, used to be delivered.
//!
//! [`JsonBinaryCodec`]: prosody::codec::JsonBinaryCodec

use chrono::{DateTime, Utc};
use napi::bindgen_prelude::BigInt;
use napi::{Error, Status};
use napi_derive::napi;
use prosody::codec::BinaryPayload;
use prosody::consumer::Keyed;
use prosody::consumer::message::{ConsumerMessage, ConsumerMessageValue};
use std::sync::Arc;
use tokio::sync::Semaphore;

/// A Kafka message received from a consumer.
#[napi]
pub struct Message {
    /// The underlying prosody message, shared with core through its `Arc`.
    inner: ConsumerMessage<BinaryPayload>,
}

#[expect(
    clippy::multiple_inherent_impl,
    reason = "napi requires a separate impl block for exported vs internal methods"
)]
impl Message {
    /// Wraps the message the handler is processing.
    ///
    /// Safe to retain: the partition loop drops the event's process guard when
    /// the handler returns, which clears the message's processing state and
    /// releases its span and consumer permit. A `Message` outliving the handler
    /// therefore keeps only the message data alive.
    pub(crate) fn new(inner: ConsumerMessage<BinaryPayload>) -> Self {
        Self { inner }
    }

    /// Copies a loader-resolved message, leaving its permit behind.
    ///
    /// [`KafkaLoader`] takes a permit from a semaphore sized to
    /// `max_uncommitted` for every message it resolves, and nothing clears the
    /// processing state of a message read out of keyed state. Handing the
    /// resolved message itself to JavaScript would hold that permit until V8
    /// collected the wrapper, so a scan longer than the semaphore would stall
    /// the loader waiting on permits it is itself holding. Copying costs one
    /// payload clone and bounds the permit to this call.
    ///
    /// [`KafkaLoader`]: prosody::loader::KafkaLoader
    ///
    /// @param resolved The message the loader resolved.
    /// @returns The detached message.
    /// @throws Error (transient) if the standalone permit cannot be acquired.
    pub(crate) fn detached(resolved: &ConsumerMessage<BinaryPayload>) -> napi::Result<Self> {
        let permit = Arc::new(Semaphore::new(1))
            .try_acquire_owned()
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("failed to acquire message permit: {error}"),
                )
            })?;
        let value = ConsumerMessageValue {
            source_system: resolved.source_system().cloned(),
            topic: resolved.topic(),
            partition: resolved.partition(),
            offset: resolved.offset(),
            key: Arc::clone(resolved.key()),
            timestamp: *resolved.timestamp(),
            payload: resolved.payload().clone(),
        };
        Ok(Self {
            inner: ConsumerMessage::new(value, resolved.span(), permit),
        })
    }

    /// Clones the wrapped consumer message for a keyed-state message write.
    ///
    /// [`ConsumerMessage`] shares its value and processing state through
    /// `Arc`, so a message-collection write clones the wrapped message rather
    /// than rebuilding one field by field. The stored bytes are the wire bytes,
    /// unchanged.
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
    /// Borrowed from the shared message and copied once into a JavaScript
    /// string; no intermediate Rust buffer is allocated. The typed layer parses
    /// it lazily, so a handler that reads only metadata never pays for a parse.
    ///
    /// @throws Error if the payload is not valid UTF-8, which valid JSON always
    ///   is.
    #[napi(getter, writable = false, ts_return_type = "string")]
    pub fn payload(&self) -> napi::Result<&str> {
        str::from_utf8(&self.inner.payload().bytes).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("message payload is not valid UTF-8: {error}"),
            )
        })
    }
}
