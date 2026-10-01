//! The `stateCollections` entries and the keyed-state configuration: parsing,
//! validation, and collection registration.

use super::Configuration;
use crate::number::{milliseconds, whole};
use napi::{Either, Error, Result};
use napi_derive::napi;
use prosody::ByteSize;
use prosody::codec::{JsonBinaryCodec, JsonBinaryMessageCodec};
use prosody::consumer::KeyedStateConfiguration;
use prosody::consumer::kafka_state::{message_deque_state, message_map_state, message_state};
use prosody::high_level::erased::ErasedReadCache as ReadCachePolicy;
use prosody::loader::KafkaLoader;
use prosody::state::descriptor::{StateDescriptor, deque_state, map_state, set_state, value_state};
use prosody::state::order_codec::Utf8KeyCodec;
use prosody::subsystem::SubsystemName;
use prosody::timers::duration::CompactDuration;
use std::num::NonZeroUsize;
use std::path::PathBuf;

/// Declares one keyed-state collection to register before subscribe.
#[napi(object)]
pub struct StateCollectionConfig {
    /// The collection name. Prosody requires it to be non-empty and unique
    /// within the definition set.
    pub name: String,

    /// The collection kind.
    pub kind: CollectionKind,

    /// The item payload. Required for value, map, and deque collections. Set
    /// collections store members only and take no payload.
    pub payload: Option<CollectionPayload>,

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

/// The cache duration for published-state reads.
#[napi(object)]
pub struct ReadCacheConfiguration {
    /// Cache duration in milliseconds.
    pub ttl_ms: f64,
}

/// A read cache option: `false` turns the cache off, and
/// `{ ttlMs }` sets the cache duration.
#[napi]
pub type ReadCacheOption = Either<bool, ReadCacheConfiguration>;

/// The kind of a keyed-state collection.
#[derive(Clone, Copy)]
#[napi(string_enum = "lowercase")]
pub enum CollectionKind {
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
#[derive(Clone, Copy)]
#[napi(string_enum = "lowercase")]
pub enum CollectionPayload {
    /// JSON values.
    Json,
    /// The full Kafka message the handler received.
    Message,
}

/// Applies the shared descriptor options: TTL, commit mode, and publication.
///
/// @param descriptor The descriptor to configure.
/// @param `ttl_seconds` The validated per-write TTL in whole seconds, if any.
/// @param collection The collection configuration.
/// @returns The configured descriptor.
fn with_def<D: StateDescriptor>(
    mut descriptor: D,
    ttl_seconds: Option<u32>,
    collection: &StateCollectionConfig,
) -> D {
    if let Some(ttl) = ttl_seconds {
        descriptor = descriptor.ttl(CompactDuration::new(ttl));
    }
    if collection.read_uncommitted == Some(true) {
        descriptor = descriptor.read_uncommitted();
    }
    if let Some(published) = collection.published {
        descriptor = descriptor.published(published);
    }
    descriptor
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
) -> Result<Option<usize>> {
    let Some(value) = collection.keyset_limit else {
        return Ok(None);
    };
    if !matches!(kind, CollectionKind::Map | CollectionKind::Set) {
        return Err(Error::from_reason(format!(
            "stateCollections[{index}].keysetLimit: only valid for map and set collections"
        )));
    }
    whole(value, &format!("stateCollections[{index}].keysetLimit")).map(Some)
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
    whole(value, &format!("stateCollections[{index}].capacity")).map(Some)
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
    let ttl_seconds = collection
        .ttl_seconds
        .map(|value| whole(value, &format!("stateCollections[{index}].ttlSeconds")))
        .transpose()?;

    let keyset_limit = parse_keyset_limit(index, collection, collection.kind)?;

    let capacity = parse_capacity(index, collection, collection.kind)?;

    let name = collection.name.as_str();
    match (collection.kind, collection.payload) {
        (CollectionKind::Set, None) => {
            let mut descriptor = with_def(set_state::<Utf8KeyCodec>(name), ttl_seconds, collection);
            if let Some(limit) = keyset_limit {
                descriptor = descriptor.keyset_limit(limit);
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
                collection,
            ));
        }
        (CollectionKind::Map, Some(CollectionPayload::Json)) => {
            let mut descriptor = with_def(
                map_state::<Utf8KeyCodec, JsonBinaryCodec>(name),
                ttl_seconds,
                collection,
            );
            if let Some(limit) = keyset_limit {
                descriptor = descriptor.keyset_limit(limit);
            }
            let _ = keyed.register(descriptor);
        }
        (CollectionKind::Deque, Some(CollectionPayload::Json)) => {
            let mut descriptor = with_def(
                deque_state::<JsonBinaryCodec>(name),
                ttl_seconds,
                collection,
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
                collection,
            ));
        }
        (CollectionKind::Map, Some(CollectionPayload::Message)) => {
            let mut descriptor = with_def(
                message_map_state::<Utf8KeyCodec, KafkaLoader<JsonBinaryMessageCodec>>(name),
                ttl_seconds,
                collection,
            );
            if let Some(limit) = keyset_limit {
                descriptor = descriptor.keyset_limit(limit);
            }
            let _ = keyed.register(descriptor);
        }
        (CollectionKind::Deque, Some(CollectionPayload::Message)) => {
            let mut descriptor = with_def(
                message_deque_state::<KafkaLoader<JsonBinaryMessageCodec>>(name),
                ttl_seconds,
                collection,
            );
            if let Some(bound) = capacity {
                descriptor = descriptor.capacity(bound);
            }
            let _ = keyed.register(descriptor);
        }
    }

    Ok(())
}

/// Converts a read cache option into the Prosody cache policy.
///
/// The client option and a definition's `readCache` share this rule. An
/// absent option inherits the default policy.
///
/// @param option The option, if set.
/// @param field The option name for the error message.
/// @returns The cache policy.
/// @throws Error if the option is `true` or its `ttlMs` cannot convert.
pub(crate) fn read_cache_policy(
    option: Option<&ReadCacheOption>,
    field: &str,
) -> Result<ReadCachePolicy> {
    match option {
        None => Ok(ReadCachePolicy::Inherit),
        Some(Either::A(false)) => Ok(ReadCachePolicy::Disabled),
        Some(Either::A(true)) => Err(Error::from_reason(format!(
            "{field}: expected false or {{ ttlMs }}, got true"
        ))),
        Some(Either::B(cache)) => {
            milliseconds(cache.ttl_ms, &format!("{field}.ttlMs")).map(ReadCachePolicy::Ttl)
        }
    }
}

/// Parses a byte size option, such as `"64 MiB"`, and names `field` in the
/// error.
fn byte_size(option: Option<&str>, field: &str) -> Result<Option<ByteSize>> {
    option
        .map(|size| {
            size.parse::<ByteSize>()
                .map_err(|error| Error::from_reason(format!("{field}: {error}")))
        })
        .transpose()
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

    if let Some(size) = byte_size(
        config.state_owned_cache_size.as_deref(),
        "stateOwnedCacheSize",
    )? {
        builder.owned_cache_size(Some(size));
    }

    if let Some(size) = byte_size(config.state_memtable_size.as_deref(), "stateMemtableSize")? {
        builder.memtable_size(Some(size));
    }

    if let Some(size) = byte_size(
        config.state_read_cache_size.as_deref(),
        "stateReadCacheSize",
    )? {
        builder.read_cache_size(Some(size));
    }

    match read_cache_policy(config.state_read_cache.as_ref(), "stateReadCache")? {
        ReadCachePolicy::Inherit => {}
        ReadCachePolicy::Disabled => {
            builder.read_cache_ttl(None);
        }
        ReadCachePolicy::Ttl(ttl) => {
            builder.read_cache_ttl(Some(ttl));
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
