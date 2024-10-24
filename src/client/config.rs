use napi::bindgen_prelude::Null;
use napi::Either;
use napi_derive::napi;
use prosody::consumer::failure::retry::RetryConfigurationBuilder;
use prosody::consumer::failure::topic::FailureTopicConfigurationBuilder;
use prosody::consumer::ConsumerConfigurationBuilder;
use prosody::high_level::mode::Mode as ProsodyMode;
use prosody::producer::ProducerConfigurationBuilder;
use std::time::Duration;

/**
 * Configuration options for the Prosody client.
 */
#[napi(object)]
pub struct Configuration {
  /// Kafka servers for initial connection.
  pub bootstrap_servers: Option<Either<String, Vec<String>>>,

  /// Use mock client for testing if true.
  pub mock: Option<bool>,

  /// Timeout for message send operations in milliseconds.
  pub send_timeout_ms: Option<u32>,

  /// Consumer group name.
  pub group_id: Option<String>,

  /// Topics to subscribe to.
  pub subscribed_topics: Option<Either<String, Vec<String>>>,

  /// Max number of uncommitted messages.
  pub max_uncommitted: Option<u16>,

  /// Max enqueued messages per key.
  pub max_enqueued_per_key: Option<u16>,

  /// Threshold determining when message processing has stalled.
  /// During partition revocation, tasks are given 80% of this time to finish before being
  /// cancelled. The remaining 20% is used to wait for the cancellation hooks to complete.
  pub stall_threshold_ms: Option<u32>,

  /// Time between message polls in milliseconds.
  pub poll_interval_ms: Option<u32>,

  /// Time between offset commits in milliseconds.
  pub commit_interval_ms: Option<u32>,

  /// Operating mode.
  pub mode: Option<Mode>,

  /// Initial delay for exponential backoff in retries in milliseconds.
  pub retry_base_ms: Option<u32>,

  /// Maximum number of retries.
  pub max_retries: Option<u32>,

  /// Maximum delay between retries in milliseconds.
  pub max_retry_delay_ms: Option<u32>,

  /// Topic for failed messages in low-latency mode.
  pub failure_topic: Option<String>,

  /// Port for the probe server. Set to null to disable.
  pub probe_port: Option<Either<u16, Null>>,
}

/**
 * Enum representing the operating mode of the Prosody client.
 */
#[derive(Debug, Default)]
#[napi(string_enum)]
pub enum Mode {
  /// Pipeline mode for standard processing.
  #[default]
  Pipeline,
  /// Low-latency mode for faster processing with potential trade-offs.
  LowLatency,
}

impl From<Mode> for ProsodyMode {
  fn from(value: Mode) -> Self {
    match value {
      Mode::Pipeline => ProsodyMode::Pipeline,
      Mode::LowLatency => ProsodyMode::LowLatency,
    }
  }
}

/// Builds a `ProducerConfigurationBuilder` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `ProducerConfigurationBuilder` with the specified configuration options.
pub fn build_producer_config(config: &Configuration) -> ProducerConfigurationBuilder {
  let mut builder = ProducerConfigurationBuilder::default();

  if let Some(servers) = &config.bootstrap_servers {
    builder.bootstrap_servers(parse_string_or_vec(servers));
  }

  if let Some(mock) = config.mock {
    builder.mock(mock);
  }

  if let Some(timeout) = config.send_timeout_ms {
    builder.send_timeout(Some(Duration::from_millis(u64::from(timeout))));
  }

  builder
}

/// Builds a `ConsumerConfigurationBuilder` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `ConsumerConfigurationBuilder` with the specified configuration options.
pub fn build_consumer_config(config: &Configuration) -> ConsumerConfigurationBuilder {
  let mut builder = ConsumerConfigurationBuilder::default();

  if let Some(servers) = &config.bootstrap_servers {
    builder.bootstrap_servers(parse_string_or_vec(servers));
  }

  if let Some(mock) = config.mock {
    builder.mock(mock);
  }

  if let Some(group_id) = &config.group_id {
    builder.group_id(group_id);
  }

  if let Some(topics) = &config.subscribed_topics {
    builder.subscribed_topics(parse_string_or_vec(topics));
  }

  if let Some(max_uncommitted) = config.max_uncommitted {
    builder.max_uncommitted(max_uncommitted as usize);
  }

  if let Some(max_enqueued_per_key) = config.max_enqueued_per_key {
    builder.max_enqueued_per_key(max_enqueued_per_key as usize);
  }

  if let Some(timeout) = config.stall_threshold_ms {
    builder.stall_threshold(Duration::from_millis(u64::from(timeout)));
  }

  if let Some(interval) = config.poll_interval_ms {
    builder.poll_interval(Duration::from_millis(u64::from(interval)));
  }

  if let Some(interval) = config.commit_interval_ms {
    builder.commit_interval(Duration::from_millis(u64::from(interval)));
  }

  if let Some(probe_port) = config.probe_port {
    builder.probe_port(match probe_port {
      Either::A(port) => Some(port),
      Either::B(_) => None,
    });
  }

  builder
}

/// Builds a `RetryConfigurationBuilder` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `RetryConfigurationBuilder` with the specified configuration options.
pub fn build_retry_config(config: &Configuration) -> RetryConfigurationBuilder {
  let mut builder = RetryConfigurationBuilder::default();

  if let Some(base) = config.retry_base_ms {
    builder.base(Duration::from_millis(u64::from(base)));
  }

  if let Some(max_retries) = config.max_retries {
    builder.max_retries(max_retries);
  }

  if let Some(max_delay) = config.max_retry_delay_ms {
    builder.max_delay(Duration::from_millis(u64::from(max_delay)));
  }

  builder
}

/// Builds a `FailureTopicConfigurationBuilder` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `FailureTopicConfigurationBuilder` with the specified configuration options.
pub fn build_failure_topic_config(config: &Configuration) -> FailureTopicConfigurationBuilder {
  let mut builder = FailureTopicConfigurationBuilder::default();

  if let Some(topic) = &config.failure_topic {
    builder.failure_topic(topic);
  }

  builder
}

/// Parses a string or vector of strings into a vector of strings.
///
/// # Arguments
///
/// * `value` - The Either<String, Vec<String>> to parse.
///
/// # Returns
///
/// A Vec<String> containing the parsed values.
fn parse_string_or_vec(value: &Either<String, Vec<String>>) -> Vec<String> {
  match value {
    Either::A(s) => vec![s.clone()],
    Either::B(v) => v.clone(),
  }
}
