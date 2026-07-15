//! Provides types and conversions for working with Kafka messages.
//!
//! This module defines the `Message` struct, which represents a message
//! consumed from a Kafka topic. It also provides an implementation to convert a
//! `ConsumerMessage` from the `prosody` crate into a `Message` struct.

use chrono::{DateTime, Utc};
use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use prosody::consumer::Keyed;
use prosody::consumer::message::ConsumerMessage;
use serde_json::Value;

/// Represents a message consumed from a Kafka topic.
///
/// This object contains all the relevant information about a Kafka message,
/// including its topic, partition, offset, timestamp, key, and payload.
#[napi(object)]
pub struct Message {
    /// The name of the topic from which the message was consumed.
    pub topic: String,

    /// The partition number from which the message was consumed.
    pub partition: i32,

    /// The message offset within the partition.
    pub offset: BigInt,

    /// The timestamp when the message was created or sent to Kafka.
    pub timestamp: DateTime<Utc>,

    /// The message key.
    pub key: String,

    /// The message payload as a JSON-serializable value.
    pub payload: Value,
}

/// Builds the JavaScript `Message` object from a borrowed `ConsumerMessage`.
///
/// Shared by the consumer handler bridge and the keyed-state layer, which both
/// hand JavaScript the same message shape. Borrows the source so message-item
/// reads (value/map/deque scans) do not consume the resolved message.
///
/// @param message The consumer message to project.
/// @returns The JavaScript-facing `Message` object.
impl From<&ConsumerMessage<Value>> for Message {
    fn from(message: &ConsumerMessage<Value>) -> Self {
        Self {
            topic: message.topic().to_string(),
            partition: message.partition(),
            offset: message.offset().into(),
            timestamp: *message.timestamp(),
            key: message.key().to_string(),
            payload: message.payload().clone(),
        }
    }
}
