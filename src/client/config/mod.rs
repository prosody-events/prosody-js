//! Client configuration: the options object that JavaScript passes, and the
//! builders that map it onto Prosody configuration.
//!
//! The `state` module owns the keyed-state collections. The `consumer` module
//! owns the consumer and middleware builders.

mod consumer;
mod state;

pub use consumer::build_consumer_builders;
pub(crate) use state::read_cache_policy;
pub use state::{ReadCacheOption, StateCollectionConfig};

use crate::number::{milliseconds, seconds, whole};
use napi::bindgen_prelude::Null;
use napi::{Either, Result};
use napi_derive::napi;
use prosody::cassandra::config::CassandraConfigurationBuilder;
use prosody::high_level::mode::Mode as ProsodyMode;
use prosody::producer::ProducerConfigurationBuilder;

/// Configuration options for the Prosody client.
#[napi(object)]
pub struct Configuration {
    /// Kafka servers for initial connection.
    pub bootstrap_servers: Option<Either<String, Vec<String>>>,

    /// Use mock client for testing if true.
    pub mock: Option<bool>,

    /// Timeout for message send operations in milliseconds.
    pub send_timeout_ms: Option<f64>,

    /// Consumer group name.
    pub group_id: Option<String>,

    /// Capacity of both idempotence caches: the producer cache that skips a
    /// repeated event ID, and the consumer cache that drops a duplicate
    /// message. The consumer cache requires at least 1.
    pub idempotence_cache_size: Option<f64>,

    /// Version string for cache-busting deduplication hashes.
    ///
    /// Changing this value invalidates all previously recorded dedup entries,
    /// causing messages to be reprocessed.
    pub idempotence_version: Option<String>,

    /// TTL for deduplication records in Cassandra in seconds.
    ///
    /// Must be at least 1 minute. Defaults to 7 days.
    pub idempotence_ttl_seconds: Option<f64>,

    /// Topics to subscribe to.
    pub subscribed_topics: Option<Either<String, Vec<String>>>,

    /// Allowed event type prefixes. All event types are allowed if unset.
    pub allowed_events: Option<Either<String, Vec<String>>>,

    /// Identifier for the producing system, used to prevent loops.
    /// Defaults to the consumer group name.
    pub source_system: Option<String>,

    /// Maximum global concurrency limit.
    pub max_concurrency: Option<f64>,

    /// Max number of uncommitted messages.
    pub max_uncommitted: Option<f64>,

    /// Threshold determining when message processing has stalled.
    pub stall_threshold_ms: Option<f64>,

    /// Shutdown budget; handlers complete freely before cancellation fires
    /// near the deadline.
    pub shutdown_timeout_ms: Option<f64>,

    /// Time between message polls in milliseconds.
    pub poll_interval_ms: Option<f64>,

    /// Time between offset commits in milliseconds.
    pub commit_interval_ms: Option<f64>,

    /// Time between librdkafka statistics reports in milliseconds. Prosody
    /// accepts 1 ms to 24 hours. Uses `PROSODY_STATISTICS_INTERVAL` when
    /// omitted, then 5 seconds.
    pub statistics_interval_ms: Option<f64>,

    /// Operating mode.
    pub mode: Option<Mode>,

    /// Initial delay for exponential backoff in retries in milliseconds.
    pub retry_base_ms: Option<f64>,

    /// Maximum number of retries.
    pub max_retries: Option<f64>,

    /// Maximum delay between retries in milliseconds.
    pub max_retry_delay_ms: Option<f64>,

    /// Topic for failed messages in low-latency mode.
    pub failure_topic: Option<String>,

    /// Port for the probe server. Set to null to disable.
    pub probe_port: Option<Either<f64, Null>>,

    /// Timer slab partitioning duration in milliseconds.
    /// Controls how timers are grouped for storage and retrieval.
    pub slab_size_ms: Option<f64>,

    /// Cassandra contact nodes (hostnames or IPs).
    pub cassandra_nodes: Option<Either<String, Vec<String>>>,

    /// Cassandra keyspace used for persistent Prosody data.
    pub cassandra_keyspace: Option<String>,

    /// Preferred Cassandra datacenter for query routing.
    pub cassandra_datacenter: Option<String>,

    /// Preferred Cassandra rack identifier for topology-aware routing.
    pub cassandra_rack: Option<String>,

    /// Username for authenticating with Cassandra.
    pub cassandra_user: Option<String>,

    /// Password for authenticating with Cassandra.
    pub cassandra_password: Option<String>,

    /// Retention period for persistent timer and deferral data in Cassandra,
    /// in seconds.
    pub cassandra_retention_seconds: Option<f64>,

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
    pub scheduler_max_wait_ms: Option<f64>,

    /// Maximum urgency boost (in seconds of virtual time) for waiting tasks.
    /// Higher values increase the importance of wait time relative to virtual
    /// time fairness.
    pub scheduler_wait_weight: Option<f64>,

    /// Cache capacity for tracking per-key virtual time in the scheduler.
    /// Larger caches provide more accurate long-term fairness across many keys.
    pub scheduler_cache_size: Option<f64>,

    // Monopolization configuration
    /// Whether monopolization detection is enabled.
    /// When disabled, the monopolization middleware is bypassed.
    pub monopolization_enabled: Option<bool>,

    /// Threshold for monopolization detection (0.0 to 1.0).
    /// If a key's execution time exceeds this fraction of the window duration,
    /// it is considered to be monopolizing execution.
    pub monopolization_threshold: Option<f64>,

    /// Rolling window duration (in milliseconds) for monopolization detection.
    pub monopolization_window_ms: Option<f64>,

    /// Cache size for tracking key execution intervals in monopolization
    /// detection.
    pub monopolization_cache_size: Option<f64>,

    // Defer configuration
    /// Whether deferral is enabled for new messages.
    /// When disabled, transient failures will not be deferred.
    pub defer_enabled: Option<bool>,

    /// Base exponential backoff delay for deferred retries in milliseconds.
    /// Handles persistent failures that need time to recover.
    pub defer_base_ms: Option<f64>,

    /// Maximum delay between deferred retries in milliseconds.
    /// Caps exponential backoff to prevent excessively long delays.
    pub defer_max_delay_ms: Option<f64>,

    /// Failure rate threshold for disabling deferral (0.0 to 1.0).
    /// When exceeded within the failure window, deferral is disabled.
    pub defer_failure_threshold: Option<f64>,

    /// Sliding window duration (in milliseconds) for failure rate tracking.
    pub defer_failure_window_ms: Option<f64>,

    /// Maximum deferred store cache entries per Cassandra defer store.
    /// Env: `PROSODY_DEFER_STORE_CACHE_SIZE`. Default: 8192.
    pub defer_store_cache_size: Option<f64>,

    // Kafka message loader configuration
    /// Capacity of the shared Kafka message loader cache.
    /// Env: `PROSODY_LOADER_CACHE_SIZE`. Default: 1024.
    pub loader_cache_size: Option<f64>,

    /// Timeout for Kafka loader seek operations in milliseconds.
    /// Env: `PROSODY_LOADER_SEEK_TIMEOUT`. Default: 30 seconds.
    pub loader_seek_timeout_ms: Option<f64>,

    /// Messages to read sequentially before seeking.
    /// If next offset is within this threshold, reads rather than seeks.
    /// Env: `PROSODY_LOADER_DISCARD_THRESHOLD`. Default: 100.
    pub loader_discard_threshold: Option<f64>,

    // Timeout configuration
    /// Fixed timeout duration for handler execution in milliseconds.
    /// If unset, defaults to 80% of stall threshold.
    pub timeout_ms: Option<f64>,

    // Telemetry emitter configuration
    /// Kafka topic to produce telemetry events to.
    pub telemetry_topic: Option<String>,

    /// Whether the telemetry emitter is enabled.
    pub telemetry_enabled: Option<bool>,

    // OTel span linking configuration
    /// Span linking for message execution spans.
    ///
    /// Controls how the receive span connects to the `OTel` context propagated
    /// from the Kafka message producer. Accepted values: `"child"` (child-of
    /// relationship) or `"follows_from"`. Default: `"child"`.
    pub message_spans: Option<String>,

    /// Span linking for timer execution spans.
    ///
    /// Controls how timer spans connect to the `OTel` context stored when the
    /// timer was scheduled. Accepted values: `"child"` (child-of relationship)
    /// or `"follows_from"`. Default: `"follows_from"`.
    pub timer_spans: Option<String>,

    // Keyed-state configuration
    /// Keyed-state collections to register before subscribe.
    ///
    /// Each entry declares one collection by name, kind, and payload. Duplicate
    /// names within this set are rejected.
    pub state_collections: Option<Vec<StateCollectionConfig>>,

    /// Directory that holds the local keyed-state caches.
    ///
    /// Each consumer opens its cache in a fresh subdirectory and removes that
    /// subdirectory when the consumer drops. So clients can share the
    /// directory, and the mount needs no persistence. Production deployments
    /// must set a mounted path, for example a Kubernetes `emptyDir`. Falls
    /// back to the `PROSODY_STATE_CACHE_DIR` environment variable, then to
    /// `<temp>/prosody/keyed-state`. Must not be an empty string when set.
    pub state_cache_dir: Option<String>,

    /// Capacity of the owning keyed-state cache. Accepts a human-readable size.
    /// Uses `PROSODY_STATE_OWNED_CACHE_SIZE` when omitted. Otherwise, the
    /// storage engine selects its default.
    pub state_owned_cache_size: Option<String>,

    /// Bytes of in-memory writes the local keyed-state cache holds for each
    /// assigned partition before it flushes them to disk. Memory use scales
    /// with the number of assigned partitions. Accepts a human-readable size.
    /// Uses `PROSODY_STATE_MEMTABLE_SIZE` when omitted. Otherwise, the
    /// storage engine's default of 64 MiB applies.
    pub state_memtable_size: Option<String>,

    /// Capacity of the published-state read-through cache. Uses
    /// `PROSODY_STATE_READ_CACHE_SIZE` when omitted. It then uses the owning
    /// cache size when set, or 1 MiB when both sizes are unset.
    pub state_read_cache_size: Option<String>,

    /// Default cache policy for published-state reads: `false` turns the
    /// cache off, and `{ ttlMs }` sets the cache duration. The older form
    /// `{ disabled: true }` still turns the cache off. Uses
    /// `PROSODY_STATE_READ_CACHE_TTL` when omitted, then 5 seconds.
    #[napi(ts_type = "ReadCacheConfiguration | false")]
    pub state_read_cache: Option<ReadCacheOption>,

    /// Subsystem under which published JSON and set collections are
    /// advertised. Uses `PROSODY_SUBSYSTEM` when omitted. Published
    /// collections require it.
    pub subsystem: Option<String>,

    /// Socket address for the peer gRPC listener. Uses
    /// `PROSODY_PEER_BIND_ADDRESS` when omitted.
    pub peer_bind_address: Option<String>,

    /// gRPC connect URI that remote peers use. Uses
    /// `PROSODY_PEER_ADVERTISED_CONNECT` when omitted.
    pub peer_advertised_connect: Option<String>,

    /// Network name used to select direct peer routes. Uses
    /// `PROSODY_PEER_NETWORK_NAME` when omitted.
    pub peer_network_name: Option<String>,

    /// Maximum channels and peer records in each peer cache. Uses
    /// `PROSODY_PEER_CACHE_CAPACITY` when omitted.
    pub peer_cache_capacity: Option<f64>,

    /// Peer registration lease duration in seconds. Uses
    /// `PROSODY_PEER_REGISTRATION_TTL` when omitted.
    pub peer_registration_ttl_seconds: Option<f64>,
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
/// @param config The Configuration to build from.
/// @returns A `ProducerConfigurationBuilder` with the specified configuration
/// options.
/// @throws Error if a number cannot convert.
pub fn build_producer_config(config: &Configuration) -> Result<ProducerConfigurationBuilder> {
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

    if let Some(value) = config.send_timeout_ms {
        builder.send_timeout(Some(milliseconds(value, "sendTimeoutMs")?));
    }

    if let Some(value) = config.idempotence_cache_size {
        builder.idempotence_cache_size(whole::<usize>(value, "idempotenceCacheSize")?);
    }

    Ok(builder)
}

/// Builds a `CassandraConfigurationBuilder` from the given Configuration.
///
/// @param config The Configuration to build from.
/// @returns A `CassandraConfigurationBuilder` with the specified configuration
/// options.
/// @throws Error if a number cannot convert.
pub fn build_cassandra_config(config: &Configuration) -> Result<CassandraConfigurationBuilder> {
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

    if let Some(value) = config.cassandra_retention_seconds {
        builder.retention(seconds(value, "cassandraRetentionSeconds")?);
    }

    Ok(builder)
}

/// Parses a string or vector of strings into a vector of strings.
///
/// @param value The Either<String, Vec<String>> to parse.
/// @returns A Vec<String> containing the parsed values.
fn parse_string_or_vec(value: &Either<String, Vec<String>>) -> Vec<String> {
    match value {
        Either::A(s) => vec![s.clone()],
        Either::B(v) => v.clone(),
    }
}
