//! The `stateCollections` entries and the keyed-state configuration: parsing,
//! validation, and collection registration.

use super::Configuration;
use napi::{Error, Result};
use napi_derive::napi;
use prosody::ByteSize;
use prosody::codec::{JsonBinaryCodec, JsonBinaryMessageCodec};
use prosody::consumer::KeyedStateConfiguration;
use prosody::consumer::kafka_state::{message_deque_state, message_map_state, message_state};
use prosody::loader::KafkaLoader;
use prosody::state::descriptor::{
    MapDescriptor, StateDescriptor, deque_state, map_state, set_state, value_state,
};
use prosody::state::order_codec::Utf8KeyCodec;
use prosody::subsystem::SubsystemName;
use prosody::timers::duration::CompactDuration;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::time::Duration;

/// Declares one keyed-state collection to register before subscribe.
#[napi(object)]
pub struct StateCollectionConfig {
    /// The collection name. Prosody requires it to be non-empty and unique
    /// within the definition set.
    pub name: String,

    /// The collection kind: `"value"`, `"map"`, `"set"`, or `"deque"`.
    pub kind: String,

    /// The item payload: `"json"` (JSON values) or `"message"` (the full Kafka
    /// message the handler received). Required for value, map, and deque
    /// collections. Set collections store members only and take no payload.
    pub payload: Option<String>,

    /// Optional per-write TTL in whole seconds. Must be a whole number >= 1
    /// (fractional, negative, and non-finite values are rejected) and must
    /// stay within the Cassandra TTL limit.
    pub ttl_seconds: Option<f64>,

    /// Optional opt-out of transactional staging (read-uncommitted, at-least
    /// once). Defaults to transactional.
    pub read_uncommitted: Option<bool>,

    /// Whether other consumer groups may read this collection.
    pub published: Option<bool>,

    /// Optional keyset bound for map and set collections (`0..=4096`; default
    /// 128 core-side; `0` disables ordered-scan tracking). The binding rejects
    /// values that cannot map to an unsigned integer. Prosody enforces the
    /// semantic ceiling. Invalid on value or deque collections.
    pub keyset_limit: Option<f64>,

    /// Optional deque-only capacity (bounded backlog). Must be a whole number
    /// >= 1 (fractional, zero, negative, and non-finite values are rejected).
    /// Runtime configuration only — not persisted, not part of collection
    /// identity, and freely changeable across deploys; enforced lazily on push.
    /// Invalid on value or map collections.
    pub capacity: Option<f64>,
}

/// Default cache policy for published-state reads.
#[napi(object)]
pub struct ReadCacheConfiguration {
    /// Cache duration in milliseconds.
    pub ttl_ms: Option<f64>,
    /// Read durable storage on every operation.
    pub disabled: Option<bool>,
}

/// The kind of a keyed-state collection.
#[derive(Clone, Copy)]
enum CollectionKind {
    /// A single-value collection.
    Value,
    /// A `String`-keyed ordered map.
    Map,
    /// A presence-only ordered set of `String` members.
    Set,
    /// A deque.
    Deque,
}

/// The item payload of a value, map, or deque collection. A set has none.
enum CollectionPayload {
    /// JSON values.
    Json,
    /// The full Kafka message the handler received.
    Message,
}

/// Parses a collection-kind token.
///
/// @param index The collection's index in `stateCollections`.
/// @param kind The kind token.
/// @returns The parsed kind.
/// @throws Error if the token is not `"value"`, `"map"`, `"set"`, or
///   `"deque"`.
fn parse_kind(index: usize, kind: &str) -> Result<CollectionKind> {
    match kind {
        "value" => Ok(CollectionKind::Value),
        "map" => Ok(CollectionKind::Map),
        "set" => Ok(CollectionKind::Set),
        "deque" => Ok(CollectionKind::Deque),
        other => Err(Error::from_reason(format!(
            "stateCollections[{index}].kind: expected \"value\", \"map\", \"set\", or \
             \"deque\", got {other:?}"
        ))),
    }
}

/// Parses a collection-payload token when configured.
///
/// @param index The collection's index in `stateCollections`.
/// @param payload The payload token, if any.
/// @returns The parsed payload, if any.
/// @throws Error if the token is not `"json"` or `"message"`.
fn parse_payload(index: usize, payload: Option<&str>) -> Result<Option<CollectionPayload>> {
    match payload {
        None => Ok(None),
        Some("json") => Ok(Some(CollectionPayload::Json)),
        Some("message") => Ok(Some(CollectionPayload::Message)),
        Some(other) => Err(Error::from_reason(format!(
            "stateCollections[{index}].payload: expected \"json\" or \"message\", got {other:?}"
        ))),
    }
}

/// Validates a JS number field as a whole number within `min..=max`.
///
/// The field arrives as an `f64` (the raw JS Number, un-coerced) so that
/// fractional, negative, and non-finite values reach this guard instead of
/// being silently truncated or wrapped by an earlier `u32` conversion. A
/// value that is not finite, not integral, or outside the inclusive range is
/// rejected with a permanent error naming the field.
///
/// @param value The raw JS number.
/// @param field The dotted field label named in the error message.
/// @param min The inclusive lower bound.
/// @param max The inclusive upper bound.
/// @returns The validated value as a `u32`.
/// @throws Error (permanent) if the value is not a whole number in range.
fn whole_number_field(value: f64, field: &str, min: u32, max: u32) -> Result<u32> {
    if value.is_finite()
        && value.fract() == 0.0
        && value >= f64::from(min)
        && value <= f64::from(max)
    {
        Ok(value as u32)
    } else {
        Err(Error::from_reason(format!(
            "{field}: must be a whole number in {min}..={max}"
        )))
    }
}

/// Applies the shared descriptor options (TTL, commit mode) fluently.
///
/// @param descriptor The descriptor to configure.
/// @param `ttl_seconds` The validated per-write TTL in whole seconds, if any.
/// @param `read_uncommitted` Whether the collection opts out of staging.
/// @returns The configured descriptor.
fn with_def<D: StateDescriptor>(
    descriptor: D,
    ttl_seconds: Option<u32>,
    read_uncommitted: Option<bool>,
    published: Option<bool>,
) -> D {
    let mut descriptor = descriptor;
    if let Some(ttl) = ttl_seconds {
        descriptor = descriptor.ttl(CompactDuration::new(ttl));
    }
    if read_uncommitted == Some(true) {
        descriptor = descriptor.read_uncommitted();
    }
    if let Some(published) = published {
        descriptor = descriptor.published(published);
    }
    descriptor
}

/// Applies the map-only keyset bound when configured.
///
/// @param descriptor The map descriptor to configure.
/// @param `keyset_limit` The validated keyset bound, if any.
/// @returns The configured map descriptor.
fn with_keyset<KC, V>(
    descriptor: MapDescriptor<KC, V>,
    keyset_limit: Option<u32>,
) -> MapDescriptor<KC, V> {
    match keyset_limit {
        Some(limit) => descriptor.keyset_limit(limit as usize),
        None => descriptor,
    }
}

/// Parses the keyset bound for map and set collections when configured.
///
/// @param index The collection's index (for error messages).
/// @param collection The collection configuration.
/// @param kind The parsed collection kind.
/// @returns The validated keyset bound, if any.
/// @throws Error (permanent) if the bound is set on a value or deque
///   collection or is not a whole number.
fn parse_keyset_limit(
    index: usize,
    collection: &StateCollectionConfig,
    kind: CollectionKind,
) -> Result<Option<u32>> {
    let Some(value) = collection.keyset_limit else {
        return Ok(None);
    };
    if !matches!(kind, CollectionKind::Map | CollectionKind::Set) {
        return Err(Error::from_reason(format!(
            "stateCollections[{index}].keysetLimit: only valid for map and set collections"
        )));
    }
    whole_number_field(
        value,
        &format!("stateCollections[{index}].keysetLimit"),
        0,
        u32::MAX,
    )
    .map(Some)
}

/// Parses the deque-only capacity bound when configured.
///
/// @param index The collection's index (for error messages).
/// @param collection The collection configuration.
/// @param kind The parsed collection kind; capacity is deque-only.
/// @returns The validated capacity bound, if any.
/// @throws Error (permanent) if capacity is set on a non-deque collection or is
///   not a positive whole number.
fn parse_capacity(
    index: usize,
    collection: &StateCollectionConfig,
    kind: CollectionKind,
) -> Result<Option<NonZeroUsize>> {
    let Some(value) = collection.capacity else {
        return Ok(None);
    };
    if !matches!(kind, CollectionKind::Deque) {
        return Err(Error::from_reason(format!(
            "stateCollections[{index}].capacity: only valid for deque collections"
        )));
    }
    let bound = whole_number_field(
        value,
        &format!("stateCollections[{index}].capacity"),
        1,
        u32::MAX,
    )?;
    // `whole_number_field` with min 1 already rejects zero, so the `NonZeroUsize`
    // conversion cannot fail; `ok_or_else` keeps it lint-clean (no unwrap).
    Ok(Some(NonZeroUsize::new(bound as usize).ok_or_else(
        || {
            Error::from_reason(format!(
                "stateCollections[{index}].capacity: must be positive"
            ))
        },
    )?))
}

/// Validates one collection and registers its descriptor.
///
/// Message collections monomorphize over `KafkaLoader<JsonBinaryMessageCodec>`.
/// Their stored identity is loader-independent (the message ref codec and
/// resolver carry fixed `"message-ref"` identifiers), so this matches the
/// identity the erased vend path asserts using the session's own loader.
///
/// @param keyed The keyed-state configuration to register into.
/// @param index The collection's index in `stateCollections`.
/// @param collection The collection configuration.
/// @throws Error (permanent) if a field is invalid (the field name is named in
///   the message).
fn register_state_collection(
    keyed: &mut KeyedStateConfiguration,
    index: usize,
    collection: &StateCollectionConfig,
) -> Result<()> {
    let kind = parse_kind(index, &collection.kind)?;
    let payload = parse_payload(index, collection.payload.as_deref())?;

    let ttl_seconds = match collection.ttl_seconds {
        Some(value) => Some(whole_number_field(
            value,
            &format!("stateCollections[{index}].ttlSeconds"),
            0,
            u32::MAX,
        )?),
        None => None,
    };

    let keyset_limit = parse_keyset_limit(index, collection, kind)?;

    let capacity = parse_capacity(index, collection, kind)?;

    let read_uncommitted = collection.read_uncommitted;
    let name = collection.name.as_str();
    match (kind, payload) {
        (CollectionKind::Set, None) => {
            let mut descriptor = with_def(
                set_state::<Utf8KeyCodec>(name),
                ttl_seconds,
                read_uncommitted,
                collection.published,
            );
            if let Some(limit) = keyset_limit {
                descriptor = descriptor.keyset_limit(limit as usize);
            }
            let _ = keyed.register(descriptor);
        }
        (CollectionKind::Set, Some(_)) => {
            return Err(Error::from_reason(format!(
                "stateCollections[{index}].payload: not valid for set collections"
            )));
        }
        (CollectionKind::Value | CollectionKind::Map | CollectionKind::Deque, None) => {
            return Err(Error::from_reason(format!(
                "stateCollections[{index}].payload: required for value, map, and deque collections"
            )));
        }
        (CollectionKind::Value, Some(CollectionPayload::Json)) => {
            let _ = keyed.register(with_def(
                value_state::<JsonBinaryCodec>(name),
                ttl_seconds,
                read_uncommitted,
                collection.published,
            ));
        }
        (CollectionKind::Map, Some(CollectionPayload::Json)) => {
            let descriptor = with_def(
                map_state::<Utf8KeyCodec, JsonBinaryCodec>(name),
                ttl_seconds,
                read_uncommitted,
                collection.published,
            );
            let _ = keyed.register(with_keyset(descriptor, keyset_limit));
        }
        (CollectionKind::Deque, Some(CollectionPayload::Json)) => {
            let mut descriptor = with_def(
                deque_state::<JsonBinaryCodec>(name),
                ttl_seconds,
                read_uncommitted,
                collection.published,
            );
            if let Some(bound) = capacity {
                descriptor = descriptor.capacity(bound);
            }
            let _ = keyed.register(descriptor);
        }
        (CollectionKind::Value, Some(CollectionPayload::Message)) => {
            let _ = keyed.register(with_def(
                message_state::<KafkaLoader<JsonBinaryMessageCodec>>(name),
                ttl_seconds,
                read_uncommitted,
                collection.published,
            ));
        }
        (CollectionKind::Map, Some(CollectionPayload::Message)) => {
            let descriptor = with_def(
                message_map_state::<Utf8KeyCodec, KafkaLoader<JsonBinaryMessageCodec>>(name),
                ttl_seconds,
                read_uncommitted,
                collection.published,
            );
            let _ = keyed.register(with_keyset(descriptor, keyset_limit));
        }
        (CollectionKind::Deque, Some(CollectionPayload::Message)) => {
            let mut descriptor = with_def(
                message_deque_state::<KafkaLoader<JsonBinaryMessageCodec>>(name),
                ttl_seconds,
                read_uncommitted,
                collection.published,
            );
            if let Some(bound) = capacity {
                descriptor = descriptor.capacity(bound);
            }
            let _ = keyed.register(descriptor);
        }
    }

    Ok(())
}

/// Builds the real `KeyedStateConfiguration` from the given Configuration.
///
/// Registers each declared collection synchronously before subscribe. Host
/// values are checked only while mapping them into Prosody types. The normal
/// Prosody construction path validates the resulting configuration.
///
/// @param config The Configuration to build from.
/// @returns The keyed-state configuration with every collection registered.
/// @throws Error if a host value cannot be mapped.
pub(super) fn build_keyed_state_config(config: &Configuration) -> Result<KeyedStateConfiguration> {
    let mut builder = KeyedStateConfiguration::builder();

    if let Some(dir) = &config.state_cache_dir {
        builder.cache_dir(PathBuf::from(dir));
    }

    if let Some(size) = &config.state_owned_cache_size {
        let size = size
            .parse::<ByteSize>()
            .map_err(|error| Error::from_reason(format!("stateOwnedCacheSize: {error}")))?;
        builder.owned_cache_size(Some(size));
    }

    if let Some(size) = &config.state_memtable_size {
        let size = size
            .parse::<ByteSize>()
            .map_err(|error| Error::from_reason(format!("stateMemtableSize: {error}")))?;
        builder.memtable_size(Some(size));
    }

    if let Some(size) = &config.state_read_cache_size {
        let size = size
            .parse::<ByteSize>()
            .map_err(|error| Error::from_reason(format!("stateReadCacheSize: {error}")))?;
        builder.read_cache_size(Some(size));
    }

    if let Some(cache) = &config.state_read_cache {
        match (cache.ttl_ms, cache.disabled.unwrap_or(false)) {
            (None, false) => {}
            (None, true) => {
                builder.read_cache_ttl(None);
            }
            (Some(milliseconds), false) => {
                let ttl = Duration::try_from_secs_f64(milliseconds / 1_000.0).map_err(|_| {
                    Error::from_reason("stateReadCache.ttlMs: must be a finite non-negative number")
                })?;
                builder.read_cache_ttl(Some(ttl));
            }
            (Some(_), true) => {
                return Err(Error::from_reason(
                    "stateReadCache: cannot set both ttlMs and disabled",
                ));
            }
        }
    }

    if let Some(subsystem) = &config.subsystem {
        builder.subsystem(Some(
            SubsystemName::try_new(subsystem)
                .map_err(|error| Error::from_reason(error.to_string()))?,
        ));
    }

    let mut keyed = builder
        .build()
        .map_err(|error| Error::from_reason(error.to_string()))?;

    if let Some(collections) = &config.state_collections {
        for (index, collection) in collections.iter().enumerate() {
            register_state_collection(&mut keyed, index, collection)?;
        }
    }

    Ok(keyed)
}
