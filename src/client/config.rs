use napi::bindgen_prelude::Null;
use napi::{Either, Error, Result};
use napi_derive::napi;
use prosody::cassandra::config::CassandraConfigurationBuilder;
use prosody::consumer::ConsumerConfigurationBuilder;
use prosody::consumer::middleware::deduplication::DeduplicationConfigurationBuilder;
use prosody::consumer::middleware::defer::DeferConfigurationBuilder;
use prosody::consumer::middleware::monopolization::MonopolizationConfigurationBuilder;
use prosody::consumer::middleware::retry::RetryConfigurationBuilder;
use prosody::consumer::middleware::scheduler::SchedulerConfigurationBuilder;
use prosody::consumer::middleware::timeout::TimeoutConfigurationBuilder;
use prosody::consumer::middleware::topic::FailureTopicConfigurationBuilder;
use prosody::high_level::ConsumerBuilders;
use prosody::consumer::SpanRelation;
use prosody::high_level::mode::Mode as ProsodyMode;
use std::str::FromStr;
use prosody::producer::ProducerConfigurationBuilder;
use prosody::telemetry::emitter::TelemetryEmitterConfiguration;
use std::time::Duration;

/// Configuration options for the Prosody client.
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

    /// Global shared cache capacity across all partitions for deduplicating
    /// messages. Set to 0 to disable deduplication entirely.
    pub idempotence_cache_size: Option<u32>,

    /// Version string for cache-busting deduplication hashes.
    ///
    /// Changing this value invalidates all previously recorded dedup entries,
    /// causing messages to be reprocessed.
    pub idempotence_version: Option<String>,

    /// TTL for deduplication records in Cassandra in seconds.
    ///
    /// Must be at least 1 minute. Defaults to 7 days.
    pub idempotence_ttl_s: Option<u32>,

    /// Topics to subscribe to.
    pub subscribed_topics: Option<Either<String, Vec<String>>>,

    /// Allowed event type prefixes. All event types are allowed if unset.
    pub allowed_events: Option<Either<String, Vec<String>>>,

    /// Identifier for the producing system, used to prevent loops.
    /// Defaults to the consumer group name.
    pub source_system: Option<String>,

    /// Maximum global concurrency limit.
    pub max_concurrency: Option<u32>,

    /// Max number of uncommitted messages.
    pub max_uncommitted: Option<u16>,

    /// Threshold determining when message processing has stalled.
    pub stall_threshold_ms: Option<u32>,

    /// Shutdown budget; handlers complete freely before cancellation fires
    /// near the deadline.
    pub shutdown_timeout_ms: Option<u32>,

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

    /// Timer slab partitioning duration in milliseconds.
    /// Controls how timers are grouped for storage and retrieval.
    pub slab_size_ms: Option<u32>,

    /// Cassandra contact nodes (hostnames or IPs).
    pub cassandra_nodes: Option<Either<String, Vec<String>>>,

    /// Cassandra keyspace to use for storing timer data.
    pub cassandra_keyspace: Option<String>,

    /// Preferred Cassandra datacenter for query routing.
    pub cassandra_datacenter: Option<String>,

    /// Preferred Cassandra rack identifier for topology-aware routing.
    pub cassandra_rack: Option<String>,

    /// Username for authenticating with Cassandra.
    pub cassandra_user: Option<String>,

    /// Password for authenticating with Cassandra.
    pub cassandra_password: Option<String>,

    /// Retention period for failed/unprocessed timer data in Cassandra in
    /// seconds.
    pub cassandra_retention_seconds: Option<u32>,

    // Scheduler configuration
    /// Target proportion of execution time for failure/retry task processing
    /// (0.0 to 1.0). Controls bandwidth allocation between Normal and
    /// Failure task classes. Higher values allocate more execution time to
    /// retrying failed tasks.
    pub scheduler_failure_weight: Option<f64>,

    /// Wait duration (in milliseconds) at which urgency boost reaches maximum
    /// intensity. Controls how quickly wait urgency ramps up for queued
    /// tasks. Shorter values make the scheduler more responsive to wait
    /// time.
    pub scheduler_max_wait_ms: Option<u32>,

    /// Maximum urgency boost (in seconds of virtual time) for waiting tasks.
    /// Higher values increase the importance of wait time relative to virtual
    /// time fairness.
    pub scheduler_wait_weight: Option<f64>,

    /// Cache capacity for tracking per-key virtual time in the scheduler.
    /// Larger caches provide more accurate long-term fairness across many keys.
    pub scheduler_cache_size: Option<u32>,

    // Monopolization configuration
    /// Whether monopolization detection is enabled.
    /// When disabled, the monopolization middleware is bypassed.
    pub monopolization_enabled: Option<bool>,

    /// Threshold for monopolization detection (0.0 to 1.0).
    /// If a key's execution time exceeds this fraction of the window duration,
    /// it is considered to be monopolizing execution.
    pub monopolization_threshold: Option<f64>,

    /// Rolling window duration (in milliseconds) for monopolization detection.
    pub monopolization_window_ms: Option<u32>,

    /// Cache size for tracking key execution intervals in monopolization
    /// detection.
    pub monopolization_cache_size: Option<u32>,

    // Defer configuration
    /// Whether deferral is enabled for new messages.
    /// When disabled, transient failures will not be deferred.
    pub defer_enabled: Option<bool>,

    /// Base exponential backoff delay for deferred retries in milliseconds.
    /// Handles persistent failures that need time to recover.
    pub defer_base_ms: Option<u32>,

    /// Maximum delay between deferred retries in milliseconds.
    /// Caps exponential backoff to prevent excessively long delays.
    pub defer_max_delay_ms: Option<u32>,

    /// Failure rate threshold for enabling deferral (0.0 to 1.0).
    /// When exceeded within the failure window, deferral is disabled.
    pub defer_failure_threshold: Option<f64>,

    /// Sliding window duration (in milliseconds) for failure rate tracking.
    pub defer_failure_window_ms: Option<u32>,

    /// Cache size for defer middleware.
    /// Controls capacity for store cache and loader cache.
    pub defer_cache_size: Option<u32>,

    /// Timeout for Kafka seek operations in milliseconds.
    pub defer_seek_timeout_ms: Option<u32>,

    /// Messages to read sequentially before seeking.
    /// If next offset is within this threshold, reads rather than seeks.
    pub defer_discard_threshold: Option<i32>,

    // Timeout configuration
    /// Fixed timeout duration for handler execution in milliseconds.
    /// If unset, defaults to 80% of stall threshold.
    pub timeout_ms: Option<u32>,

    // Telemetry emitter configuration
    /// Kafka topic to produce telemetry events to.
    pub telemetry_topic: Option<String>,

    /// Whether the telemetry emitter is enabled.
    pub telemetry_enabled: Option<bool>,

    // OTel span linking configuration
    /// Span linking for message execution spans.
    ///
    /// Controls how the receive span connects to the OTel context propagated
    /// from the Kafka message producer. Accepted values: `"child"` (child-of
    /// relationship) or `"follows_from"`. Default: `"child"`.
    pub message_spans: Option<String>,

    /// Span linking for timer execution spans.
    ///
    /// Controls how timer spans connect to the OTel context stored when the
    /// timer was scheduled. Accepted values: `"child"` (child-of relationship)
    /// or `"follows_from"`. Default: `"follows_from"`.
    pub timer_spans: Option<String>,
}

/// Enum representing the operating mode of the Prosody client.
#[derive(Debug, Default)]
#[napi(string_enum)]
pub enum Mode {
    /// Pipeline mode for standard processing.
    #[default]
    Pipeline,
    /// Low-latency mode for faster processing with potential trade-offs.
    LowLatency,
    /// Best-effort mode for development or when messages can be discarded when
    /// processing fails
    BestEffort,
}

impl From<Mode> for ProsodyMode {
    fn from(value: Mode) -> Self {
        match value {
            Mode::Pipeline => ProsodyMode::Pipeline,
            Mode::LowLatency => ProsodyMode::LowLatency,
            Mode::BestEffort => ProsodyMode::BestEffort,
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

    if let Some(source_system) = &config.source_system {
        builder.source_system(source_system);
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
pub fn build_consumer_config(config: &Configuration) -> Result<ConsumerConfigurationBuilder> {
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

    if let Some(allowed_event_types) = &config.allowed_events {
        builder.allowed_events(parse_string_or_vec(allowed_event_types));
    }

    if let Some(max_uncommitted) = config.max_uncommitted {
        builder.max_uncommitted(max_uncommitted as usize);
    }

    if let Some(timeout) = config.stall_threshold_ms {
        builder.stall_threshold(Duration::from_millis(u64::from(timeout)));
    }

    if let Some(timeout) = config.shutdown_timeout_ms {
        builder.shutdown_timeout(Duration::from_millis(u64::from(timeout)));
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

    if let Some(slab_size_ms) = config.slab_size_ms {
        builder.slab_size(Duration::from_millis(u64::from(slab_size_ms)));
    }

    if let Some(ref s) = config.message_spans {
        let relation = SpanRelation::from_str(s)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        builder.message_spans(relation);
    }

    if let Some(ref s) = config.timer_spans {
        let relation = SpanRelation::from_str(s)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        builder.timer_spans(relation);
    }

    Ok(builder)
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
/// A `FailureTopicConfigurationBuilder` with the specified configuration
/// options.
pub fn build_failure_topic_config(config: &Configuration) -> FailureTopicConfigurationBuilder {
    let mut builder = FailureTopicConfigurationBuilder::default();

    if let Some(topic) = &config.failure_topic {
        builder.failure_topic(topic);
    }

    builder
}

/// Builds a `SchedulerConfigurationBuilder` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `SchedulerConfigurationBuilder` with the specified configuration options.
fn build_scheduler_config(config: &Configuration) -> SchedulerConfigurationBuilder {
    let mut builder = SchedulerConfigurationBuilder::default();

    if let Some(max_concurrency) = config.max_concurrency {
        builder.max_concurrency(max_concurrency as usize);
    }

    if let Some(failure_weight) = config.scheduler_failure_weight {
        builder.failure_weight(failure_weight);
    }

    if let Some(max_wait_ms) = config.scheduler_max_wait_ms {
        builder.max_wait(Duration::from_millis(u64::from(max_wait_ms)));
    }

    if let Some(wait_weight) = config.scheduler_wait_weight {
        builder.wait_weight(wait_weight);
    }

    if let Some(cache_size) = config.scheduler_cache_size {
        builder.cache_size(cache_size as usize);
    }

    builder
}

/// Builds a `MonopolizationConfigurationBuilder` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `MonopolizationConfigurationBuilder` with the specified configuration
/// options.
fn build_monopolization_config(config: &Configuration) -> MonopolizationConfigurationBuilder {
    let mut builder = MonopolizationConfigurationBuilder::default();

    if let Some(enabled) = config.monopolization_enabled {
        builder.enabled(enabled);
    }

    if let Some(threshold) = config.monopolization_threshold {
        builder.monopolization_threshold(threshold);
    }

    if let Some(window_ms) = config.monopolization_window_ms {
        builder.window_duration(Duration::from_millis(u64::from(window_ms)));
    }

    if let Some(cache_size) = config.monopolization_cache_size {
        builder.cache_size(cache_size as usize);
    }

    builder
}

/// Builds a `DeferConfigurationBuilder` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `DeferConfigurationBuilder` with the specified configuration options.
fn build_defer_config(config: &Configuration) -> DeferConfigurationBuilder {
    let mut builder = DeferConfigurationBuilder::default();

    if let Some(enabled) = config.defer_enabled {
        builder.enabled(enabled);
    }

    if let Some(base_ms) = config.defer_base_ms {
        builder.base(Duration::from_millis(u64::from(base_ms)));
    }

    if let Some(max_delay_ms) = config.defer_max_delay_ms {
        builder.max_delay(Duration::from_millis(u64::from(max_delay_ms)));
    }

    if let Some(failure_threshold) = config.defer_failure_threshold {
        builder.failure_threshold(failure_threshold);
    }

    if let Some(failure_window_ms) = config.defer_failure_window_ms {
        builder.failure_window(Duration::from_millis(u64::from(failure_window_ms)));
    }

    if let Some(cache_size) = config.defer_cache_size {
        builder.cache_size(cache_size as usize);
    }

    if let Some(seek_timeout_ms) = config.defer_seek_timeout_ms {
        builder.seek_timeout(Duration::from_millis(u64::from(seek_timeout_ms)));
    }

    if let Some(discard_threshold) = config.defer_discard_threshold {
        builder.discard_threshold(i64::from(discard_threshold));
    }

    builder
}

/// Builds a `TimeoutConfigurationBuilder` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `TimeoutConfigurationBuilder` with the specified configuration options.
fn build_timeout_config(config: &Configuration) -> TimeoutConfigurationBuilder {
    let mut builder = TimeoutConfigurationBuilder::default();

    if let Some(timeout_ms) = config.timeout_ms {
        builder.timeout(Some(Duration::from_millis(u64::from(timeout_ms))));
    }

    builder
}

/// Builds a `TelemetryEmitterConfiguration` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `TelemetryEmitterConfiguration` with the specified configuration options.
fn build_emitter_config(config: &Configuration) -> Result<TelemetryEmitterConfiguration> {
    let mut builder = TelemetryEmitterConfiguration::builder();

    if let Some(topic) = &config.telemetry_topic {
        builder.topic(topic.clone());
    }

    if let Some(enabled) = config.telemetry_enabled {
        builder.enabled(enabled);
    }

    builder
        .build()
        .map_err(|e| Error::from_reason(e.to_string()))
}

/// Builds a `DeduplicationConfigurationBuilder` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `DeduplicationConfigurationBuilder` with the specified configuration
/// options.
fn build_dedup_config(config: &Configuration) -> DeduplicationConfigurationBuilder {
    let mut builder = DeduplicationConfigurationBuilder::default();

    if let Some(cache_capacity) = config.idempotence_cache_size {
        builder.cache_capacity(cache_capacity as usize);
    }

    if let Some(version) = &config.idempotence_version {
        builder.version(version.clone());
    }

    if let Some(ttl_s) = config.idempotence_ttl_s {
        builder.ttl(Duration::from_secs(u64::from(ttl_s)));
    }

    builder
}

/// Builds `ConsumerBuilders` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `ConsumerBuilders` containing all consumer-related configuration builders.
pub fn build_consumer_builders(config: &Configuration) -> Result<ConsumerBuilders> {
    Ok(ConsumerBuilders {
        consumer: build_consumer_config(config)?,
        dedup: build_dedup_config(config),
        retry: build_retry_config(config),
        failure_topic: build_failure_topic_config(config),
        scheduler: build_scheduler_config(config),
        monopolization: build_monopolization_config(config),
        defer: build_defer_config(config),
        timeout: build_timeout_config(config),
        emitter: build_emitter_config(config)?,
    })
}

/// Builds a `CassandraConfigurationBuilder` from the given Configuration.
///
/// # Arguments
///
/// * `config` - The Configuration to build from.
///
/// # Returns
///
/// A `CassandraConfigurationBuilder` with the specified configuration options.
pub fn build_cassandra_config(config: &Configuration) -> CassandraConfigurationBuilder {
    let mut builder = CassandraConfigurationBuilder::default();

    if let Some(nodes) = &config.cassandra_nodes {
        builder.nodes(parse_string_or_vec(nodes));
    }

    if let Some(keyspace) = &config.cassandra_keyspace {
        builder.keyspace(keyspace);
    }

    if let Some(datacenter) = &config.cassandra_datacenter {
        builder.datacenter(Some(datacenter.clone()));
    }

    if let Some(rack) = &config.cassandra_rack {
        builder.rack(Some(rack.clone()));
    }

    if let Some(user) = &config.cassandra_user {
        builder.user(Some(user.clone()));
    }

    if let Some(password) = &config.cassandra_password {
        builder.password(Some(password.clone()));
    }

    if let Some(retention_seconds) = config.cassandra_retention_seconds {
        builder.retention(Duration::from_secs(u64::from(retention_seconds)));
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
