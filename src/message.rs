//! The Kafka message handed to JavaScript.
//!
//! [`Message`] exposes a message's fields as getters. The handler's own message
//! is held exactly as core shares it: a [`ConsumerMessage`] keeps its data in
//! an `Arc`, so wrapping one costs two reference-count bumps and no byte
//! copies. A message read back out of keyed state is copied instead — see
//! [`Source`] for why.
//!
//! The payload crosses as the raw JSON text read from the wire. Rust never
//! parses it; `JSON.parse` on the JavaScript side does, once and lazily.

use chrono::{DateTime, Utc};
use napi::bindgen_prelude::BigInt;
use napi::{Error, Status};
use napi_derive::napi;
use prosody::codec::BinaryPayload;
use prosody::consumer::Keyed;
use prosody::consumer::message::{ConsumerMessage, ConsumerMessageValue};
use std::sync::Arc;

/// A Kafka message received from a consumer.
#[napi]
pub struct Message {
    source: Source,
}

/// Where a message came from, which decides whether it can be stored again.
enum Source {
    /// The message the handler is processing, shared with core.
    ///
    /// Safe to retain past the handler. The partition loop drops the event's
    /// process guard when the handler returns, which clears the message's
    /// processing state and releases its span and consumer permit, leaving only
    /// the message data alive.
    Live(ConsumerMessage<BinaryPayload>),

    /// A message read back out of keyed state, copied field by field.
    ///
    /// [`KafkaLoader`] takes a permit from a semaphore sized to
    /// `max_uncommitted` for every message it resolves, and nothing clears the
    /// processing state of a message read out of keyed state. Copying the
    /// fields lets the resolved message drop when the read returns, which
    /// releases the permit. Retaining the message would instead pin one
    /// permit until V8 collected this wrapper, and a scan longer than the
    /// semaphore would stall the loader on permits it is itself holding.
    ///
    /// [`KafkaLoader`]: prosody::loader::KafkaLoader
    Stored(ConsumerMessageValue<BinaryPayload>),
}

#[expect(
    clippy::multiple_inherent_impl,
    reason = "napi requires a separate impl block for exported vs internal methods"
)]
impl Message {
    /// Wraps the message the handler is processing.
    pub(crate) fn new(message: ConsumerMessage<BinaryPayload>) -> Self {
        Self {
            source: Source::Live(message),
        }
    }

    /// Copies a message the loader resolved for a keyed-state read.
    ///
    /// @param resolved The message the loader resolved.
    /// @returns The copied message, holding no processing resources.
    pub(crate) fn stored(resolved: &ConsumerMessage<BinaryPayload>) -> Self {
        Self {
            source: Source::Stored(ConsumerMessageValue {
                source_system: resolved.source_system().cloned(),
                topic: resolved.topic(),
                partition: resolved.partition(),
                offset: resolved.offset(),
                key: Arc::clone(resolved.key()),
                timestamp: *resolved.timestamp(),
                payload: resolved.payload().clone(),
            }),
        }
    }

    /// The consumer message to store in a message collection.
    ///
    /// A message collection stores the message's Kafka coordinates, which live
    /// on the [`ConsumerMessage`] core shares. [`Source::Stored`] holds none,
    /// so a message read out of keyed state answers `None`.
    pub(crate) fn consumer_message(&self) -> Option<ConsumerMessage<BinaryPayload>> {
        match &self.source {
            Source::Live(message) => Some(message.clone()),
            Source::Stored(_) => None,
        }
    }
}

#[napi]
impl Message {
    /// The Kafka topic this message was consumed from.
    #[napi(getter, writable = false)]
    pub fn topic(&self) -> &'static str {
        match &self.source {
            Source::Live(message) => message.topic().as_ref(),
            Source::Stored(value) => value.topic.as_ref(),
        }
    }

    /// The partition number within the topic.
    #[napi(getter, writable = false)]
    pub fn partition(&self) -> i32 {
        match &self.source {
            Source::Live(message) => message.partition(),
            Source::Stored(value) => value.partition,
        }
    }

    /// The offset of this message within its partition.
    #[napi(getter, writable = false)]
    pub fn offset(&self) -> BigInt {
        match &self.source {
            Source::Live(message) => message.offset(),
            Source::Stored(value) => value.offset,
        }
        .into()
    }

    /// The timestamp when the message was produced.
    #[napi(getter, writable = false)]
    pub fn timestamp(&self) -> DateTime<Utc> {
        match &self.source {
            Source::Live(message) => *message.timestamp(),
            Source::Stored(value) => value.timestamp,
        }
    }

    /// The message key used for partitioning.
    #[napi(getter, writable = false)]
    pub fn key(&self) -> &str {
        match &self.source {
            Source::Live(message) => message.key(),
            Source::Stored(value) => &value.key,
        }
    }

    /// The payload as the raw JSON text read from the wire.
    ///
    /// Copied once into a JavaScript string; no intermediate Rust buffer is
    /// allocated. The typed layer parses it lazily, so a handler that reads
    /// only metadata never pays for a parse.
    ///
    /// @throws Error if the payload is not valid UTF-8, which valid JSON always
    ///   is.
    #[napi(getter, writable = false, ts_return_type = "string")]
    pub fn payload(&self) -> napi::Result<&str> {
        let bytes = match &self.source {
            Source::Live(message) => &message.payload().bytes,
            Source::Stored(value) => &value.payload.bytes,
        };
        str::from_utf8(bytes).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("message payload is not valid UTF-8: {error}"),
            )
        })
    }
}
