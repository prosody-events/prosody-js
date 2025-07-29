//! Provides types and conversions for working with Kafka messages.
//!
//! This module defines the `Message` struct, which represents a message consumed from a Kafka topic.
//! It also provides an implementation to convert a `ConsumerMessage` from the `prosody` crate
//! into a `Message` struct.

use chrono::{DateTime, Utc};
use napi_derive::napi;
use prosody::consumer::message::{ConsumerMessage, ConsumerMessageValue};
use serde_json::Value;

/**
 * Represents a message consumed from a Kafka topic.
 *
 * This object contains all the relevant information about a Kafka message,
 * including its topic, partition, offset, timestamp, key, and payload.
 */
#[napi(object)]
pub struct Message {
  /// The name of the topic from which the message was consumed.
  pub topic: String,

  /// The partition number from which the message was consumed.
  pub partition: i32,

  /// The message offset within the partition.
  pub offset: i64,

  /// The timestamp when the message was created or sent to Kafka.
  pub timestamp: DateTime<Utc>,

  /// The message key.
  pub key: String,

  /// The message payload as a JSON-serializable value.
  pub payload: Value,
}

impl From<ConsumerMessage> for Message {
  /// Converts a `ConsumerMessage` into a `Message`.
  ///
  /// This implementation extracts the relevant fields from the `ConsumerMessage`
  /// and constructs a new `Message` instance.
  ///
  /// # Arguments
  ///
  /// * `message` - The `ConsumerMessage` to convert.
  ///
  /// # Returns
  ///
  /// A new `Message` instance containing the data from the `ConsumerMessage`.
  fn from(message: ConsumerMessage) -> Self {
    let ConsumerMessageValue {
      topic,
      partition,
      offset,
      key,
      timestamp,
      payload,
      ..
    } = message.into_value();

    Self {
      topic: topic.to_string(),
      partition,
      offset,
      timestamp,
      key: key.to_string(),
      payload,
    }
  }
}
