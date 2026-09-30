//! The consumer and middleware configuration builders.

use super::state::build_keyed_state_config;
use super::{Configuration, parse_string_or_vec};
use crate::number::{milliseconds, seconds, whole};
use napi::{Either, Error, Result};
use prosody::PeerConfiguration;
use prosody::PeerEndpoint;
use prosody::consumer::ConsumerConfigurationBuilder;
use prosody::consumer::SpanRelation;
use prosody::consumer::middleware::deduplication::DeduplicationConfigurationBuilder;
use prosody::consumer::middleware::defer::DeferConfigurationBuilder;
use prosody::consumer::middleware::monopolization::MonopolizationConfigurationBuilder;
use prosody::consumer::middleware::retry::RetryConfigurationBuilder;
use prosody::consumer::middleware::scheduler::SchedulerConfigurationBuilder;
use prosody::consumer::middleware::timeout::TimeoutConfigurationBuilder;
use prosody::consumer::middleware::topic::FailureTopicConfigurationBuilder;
use prosody::high_level::ConsumerBuilders;
use prosody::loader::KafkaLoaderConfiguration;
use prosody::telemetry::emitter::TelemetryEmitterConfiguration;
use std::net::SocketAddr;
use std::num::NonZeroUsize;
use std::str::FromStr;

/// Builds a `ConsumerConfigurationBuilder` from the given Configuration.
///
/// @param config The Configuration to build from.
/// @returns A `Result` containing the `ConsumerConfigurationBuilder` with the
/// specified configuration options, or an error if a configuration value is
/// invalid.
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

    if let Some(value) = config.max_uncommitted {
        builder.max_uncommitted(whole::<usize>(value, "maxUncommitted")?);
    }

    if let Some(value) = config.stall_threshold_ms {
        builder.stall_threshold(milliseconds(value, "stallThresholdMs")?);
    }

    if let Some(value) = config.shutdown_timeout_ms {
        builder.shutdown_timeout(milliseconds(value, "shutdownTimeoutMs")?);
    }

    if let Some(value) = config.poll_interval_ms {
        builder.poll_interval(milliseconds(value, "pollIntervalMs")?);
    }

    if let Some(value) = config.commit_interval_ms {
        builder.commit_interval(milliseconds(value, "commitIntervalMs")?);
    }

    if let Some(value) = config.statistics_interval_ms {
        builder.statistics_interval(milliseconds(value, "statisticsIntervalMs")?);
    }

    if let Some(probe_port) = config.probe_port {
        builder.probe_port(match probe_port {
            Either::A(port) => Some(whole::<u16>(port, "probePort")?),
            Either::B(_) => None,
        });
    }

    if let Some(value) = config.slab_size_ms {
        builder.slab_size(milliseconds(value, "slabSizeMs")?);
    }

    if let Some(ref s) = config.message_spans {
        let relation = SpanRelation::from_str(s)
            .map_err(|e| Error::from_reason(format!("message_spans: {e}")))?;
        builder.message_spans(relation);
    }

    if let Some(ref s) = config.timer_spans {
        let relation = SpanRelation::from_str(s)
            .map_err(|e| Error::from_reason(format!("timer_spans: {e}")))?;
        builder.timer_spans(relation);
    }

    if config.loader_cache_size.is_some()
        || config.loader_seek_timeout_ms.is_some()
        || config.loader_discard_threshold.is_some()
    {
        let mut loader = KafkaLoaderConfiguration::builder();
        if let Some(value) = config.loader_cache_size {
            loader.cache_size(whole::<usize>(value, "loaderCacheSize")?);
        }
        if let Some(value) = config.loader_seek_timeout_ms {
            loader.seek_timeout(milliseconds(value, "loaderSeekTimeoutMs")?);
        }
        if let Some(value) = config.loader_discard_threshold {
            loader.discard_threshold(whole::<i64>(value, "loaderDiscardThreshold")?);
        }
        let loader = loader
            .build()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        builder.loader(loader);
    }

    Ok(builder)
}

/// Builds a `RetryConfigurationBuilder` from the given Configuration.
///
/// @param config The Configuration to build from.
/// @returns A `RetryConfigurationBuilder` with the specified configuration
/// options.
/// @throws Error if a number cannot convert.
pub fn build_retry_config(config: &Configuration) -> Result<RetryConfigurationBuilder> {
    let mut builder = RetryConfigurationBuilder::default();

    if let Some(value) = config.retry_base_ms {
        builder.base(milliseconds(value, "retryBaseMs")?);
    }

    if let Some(value) = config.max_retries {
        builder.max_retries(whole::<u32>(value, "maxRetries")?);
    }

    if let Some(value) = config.max_retry_delay_ms {
        builder.max_delay(milliseconds(value, "maxRetryDelayMs")?);
    }

    Ok(builder)
}

/// Builds a `FailureTopicConfigurationBuilder` from the given Configuration.
///
/// @param config The Configuration to build from.
/// @returns A `FailureTopicConfigurationBuilder` with the specified
/// configuration options.
pub fn build_failure_topic_config(config: &Configuration) -> FailureTopicConfigurationBuilder {
    let mut builder = FailureTopicConfigurationBuilder::default();

    if let Some(topic) = &config.failure_topic {
        builder.failure_topic(topic);
    }

    builder
}

/// Builds a `SchedulerConfigurationBuilder` from the given Configuration.
///
/// @param config The Configuration to build from.
/// @returns A `SchedulerConfigurationBuilder` with the specified configuration
/// options.
/// @throws Error if a number cannot convert.
fn build_scheduler_config(config: &Configuration) -> Result<SchedulerConfigurationBuilder> {
    let mut builder = SchedulerConfigurationBuilder::default();

    if let Some(value) = config.max_concurrency {
        builder.max_concurrency(whole::<usize>(value, "maxConcurrency")?);
    }

    if let Some(failure_weight) = config.scheduler_failure_weight {
        builder.failure_weight(failure_weight);
    }

    if let Some(value) = config.scheduler_max_wait_ms {
        builder.max_wait(milliseconds(value, "schedulerMaxWaitMs")?);
    }

    if let Some(wait_weight) = config.scheduler_wait_weight {
        builder.wait_weight(wait_weight);
    }

    if let Some(value) = config.scheduler_cache_size {
        builder.cache_size(whole::<usize>(value, "schedulerCacheSize")?);
    }

    Ok(builder)
}

/// Builds a `MonopolizationConfigurationBuilder` from the given Configuration.
///
/// @param config The Configuration to build from.
/// @returns A `MonopolizationConfigurationBuilder` with the specified
/// configuration options.
/// @throws Error if a number cannot convert.
fn build_monopolization_config(
    config: &Configuration,
) -> Result<MonopolizationConfigurationBuilder> {
    let mut builder = MonopolizationConfigurationBuilder::default();

    if let Some(enabled) = config.monopolization_enabled {
        builder.enabled(enabled);
    }

    if let Some(threshold) = config.monopolization_threshold {
        builder.monopolization_threshold(threshold);
    }

    if let Some(value) = config.monopolization_window_ms {
        builder.window_duration(milliseconds(value, "monopolizationWindowMs")?);
    }

    if let Some(value) = config.monopolization_cache_size {
        builder.cache_size(whole::<usize>(value, "monopolizationCacheSize")?);
    }

    Ok(builder)
}

/// Builds a `DeferConfigurationBuilder` from the given Configuration.
///
/// @param config The Configuration to build from.
/// @returns A `DeferConfigurationBuilder` with the specified configuration
/// options.
/// @throws Error if a number cannot convert.
fn build_defer_config(config: &Configuration) -> Result<DeferConfigurationBuilder> {
    let mut builder = DeferConfigurationBuilder::default();

    if let Some(enabled) = config.defer_enabled {
        builder.enabled(enabled);
    }

    if let Some(value) = config.defer_base_ms {
        builder.base(milliseconds(value, "deferBaseMs")?);
    }

    if let Some(value) = config.defer_max_delay_ms {
        builder.max_delay(milliseconds(value, "deferMaxDelayMs")?);
    }

    if let Some(failure_threshold) = config.defer_failure_threshold {
        builder.failure_threshold(failure_threshold);
    }

    if let Some(value) = config.defer_failure_window_ms {
        builder.failure_window(milliseconds(value, "deferFailureWindowMs")?);
    }

    if let Some(value) = config.defer_store_cache_size {
        builder.store_cache_size(whole::<usize>(value, "deferStoreCacheSize")?);
    }

    Ok(builder)
}

/// Builds a `TimeoutConfigurationBuilder` from the given Configuration.
///
/// @param config The Configuration to build from.
/// @returns A `TimeoutConfigurationBuilder` with the specified configuration
/// options.
/// @throws Error if the number cannot convert.
fn build_timeout_config(config: &Configuration) -> Result<TimeoutConfigurationBuilder> {
    let mut builder = TimeoutConfigurationBuilder::default();

    if let Some(value) = config.timeout_ms {
        builder.timeout(Some(milliseconds(value, "timeoutMs")?));
    }

    Ok(builder)
}

/// Builds a `TelemetryEmitterConfiguration` from the given Configuration.
///
/// @param config The Configuration to build from.
/// @returns A `TelemetryEmitterConfiguration` with the specified configuration
/// options.
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
/// @param config The Configuration to build from.
/// @returns A `DeduplicationConfigurationBuilder` with the specified
/// configuration options.
fn build_dedup_config(config: &Configuration) -> Result<DeduplicationConfigurationBuilder> {
    let mut builder = DeduplicationConfigurationBuilder::default();

    if let Some(value) = config.idempotence_cache_size {
        let capacity =
            NonZeroUsize::new(whole(value, "idempotenceCacheSize")?).ok_or_else(|| {
                Error::from_reason("idempotenceCacheSize: must be a positive whole number, got 0")
            })?;
        builder.cache_capacity(capacity);
    }

    if let Some(version) = &config.idempotence_version {
        builder.version(version.clone());
    }

    if let Some(value) = config.idempotence_ttl_seconds {
        builder.ttl(seconds(value, "idempotenceTtlSeconds")?);
    }

    Ok(builder)
}

/// Builds `ConsumerBuilders` from the given Configuration.
///
/// @param config The Configuration to build from.
/// @returns A `ConsumerBuilders` containing all consumer-related configuration
/// builders.
pub fn build_consumer_builders(config: &Configuration) -> Result<ConsumerBuilders> {
    Ok(ConsumerBuilders {
        consumer: build_consumer_config(config)?,
        dedup: build_dedup_config(config)?,
        retry: build_retry_config(config)?,
        failure_topic: build_failure_topic_config(config),
        scheduler: build_scheduler_config(config)?,
        monopolization: build_monopolization_config(config)?,
        defer: build_defer_config(config)?,
        timeout: build_timeout_config(config)?,
        emitter: build_emitter_config(config)?,
        keyed_state: build_keyed_state_config(config)?,
        peer: build_peer_config(config)?,
    })
}

fn build_peer_config(config: &Configuration) -> Result<PeerConfiguration> {
    let mut builder = PeerConfiguration::builder();
    if let Some(value) = &config.peer_bind_address {
        builder.bind_address(
            value
                .parse::<SocketAddr>()
                .map_err(|error| Error::from_reason(format!("peerBindAddress: {error}")))?,
        );
    }
    if let Some(value) = &config.peer_advertised_connect {
        builder.advertised_connect(
            PeerEndpoint::try_from(value.clone())
                .map_err(|error| Error::from_reason(format!("peerAdvertisedConnect: {error}")))?,
        );
    }
    if let Some(value) = &config.peer_network_name {
        builder.network_name(value.clone());
    }
    if let Some(value) = config.peer_cache_capacity {
        builder.peer_cache_capacity(whole::<usize>(value, "peerCacheCapacity")?);
    }
    if let Some(value) = config.peer_registration_ttl_seconds {
        builder.registration_ttl(seconds(value, "peerRegistrationTtlSeconds")?);
    }
    builder
        .build()
        .map_err(|error| Error::from_reason(error.to_string()))
}
