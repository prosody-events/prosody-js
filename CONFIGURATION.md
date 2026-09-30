# Configuration

Configure via constructor options or environment variables. Options fall back to environment variables when unset.

The JavaScript client rejects a number that has no exact form in the Prosody type, such as a negative, fractional, or non-finite count. Prosody validates the converted values when the client is built.

## Core

| Option / Environment Variable                    | Description                                                                                                                                                                                                                       | Default                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `bootstrapServers` / `PROSODY_BOOTSTRAP_SERVERS` | Kafka servers to connect to                                                                                                                                                                                                       | -                                                      |
| `groupId` / `PROSODY_GROUP_ID`                   | Consumer group name                                                                                                                                                                                                               | -                                                      |
| `subscribedTopics` / `PROSODY_SUBSCRIBED_TOPICS` | Topics to read from. Omit it for a client that only reads published state                                                                                                                                                         | -                                                      |
| `allowedEvents` / `PROSODY_ALLOWED_EVENTS`       | Only process events matching these prefixes                                                                                                                                                                                       | (all)                                                  |
| `sourceSystem` / `PROSODY_SOURCE_SYSTEM`         | Tag for outgoing messages (prevents reprocessing)                                                                                                                                                                                 | `<groupId>`                                            |
| `mock` / `PROSODY_MOCK`                          | Use in-memory Kafka for testing                                                                                                                                                                                                   | false                                                  |
| `mode` / -                                       | Processing mode: `Mode.Pipeline`, `Mode.LowLatency`, or `Mode.BestEffort`                                                                                                                                                         | `Mode.Pipeline`                                        |
| - / `PROSODY_LOG`                                | Rust log filter, such as `info` or `prosody=debug`. A directive replaces the default for its own target only, so naming one target keeps the rest at their default. Set `opentelemetry=info` to restore OpenTelemetry info events | `info`, except `warn` for `scylla` and `opentelemetry` |

## Consumer

| Option / Environment Variable                             | Description                                                                                                   | Default                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `maxConcurrency` / `PROSODY_MAX_CONCURRENCY`              | Max messages being processed simultaneously                                                                   | 32                     |
| `maxUncommitted` / `PROSODY_MAX_UNCOMMITTED`              | Max queued messages before pausing consumption                                                                | 64                     |
| `timeoutMs` / `PROSODY_TIMEOUT`                           | Cancel handler if it runs longer than this                                                                    | 80% of stall threshold |
| `commitIntervalMs` / `PROSODY_COMMIT_INTERVAL`            | How often to save progress to Kafka                                                                           | 1s                     |
| `pollIntervalMs` / `PROSODY_POLL_INTERVAL`                | How often to fetch new messages from Kafka                                                                    | 100ms                  |
| `shutdownTimeoutMs` / `PROSODY_SHUTDOWN_TIMEOUT`          | Shutdown budget; handlers run freely until cancellation near the deadline                                     | 30s                    |
| `stallThresholdMs` / `PROSODY_STALL_THRESHOLD`            | Report unhealthy if no progress for this long                                                                 | 5m                     |
| `probePort` / `PROSODY_PROBE_PORT`                        | HTTP port for health checks; use `null` or the environment value `none` to disable                            | 8000                   |
| `statisticsIntervalMs` / `PROSODY_STATISTICS_INTERVAL`    | How often librdkafka reports client statistics; must be between 1ms and 24h                                   | 5s                     |
| `failureTopic` / `PROSODY_FAILURE_TOPIC`                  | Send unprocessable messages here (dead letter queue)                                                          | -                      |
| `idempotenceCacheSize` / `PROSODY_IDEMPOTENCE_CACHE_SIZE` | Capacity of the producer cache of sent event IDs and of the consumer deduplication cache. Must be at least 1. | 8192                   |
| `idempotenceVersion` / `PROSODY_IDEMPOTENCE_VERSION`      | Version string for cache-busting dedup hashes                                                                 | `"1"`                  |
| `idempotenceTtlSeconds` / `PROSODY_IDEMPOTENCE_TTL`       | TTL for dedup records in Cassandra in seconds                                                                 | 604800                 |
| `slabSizeMs` / `PROSODY_SLAB_SIZE`                        | Timer storage granularity (rarely needs changing)                                                             | 1h                     |
| `messageSpans` / `PROSODY_MESSAGE_SPANS`                  | Span linking for message execution: `child` (child-of) or `follows_from`                                      | `child`                |
| `timerSpans` / `PROSODY_TIMER_SPANS`                      | Span linking for timer execution: `child` (child-of) or `follows_from`                                        | `follows_from`         |

## Producer

| Option / Environment Variable            | Description                     | Default |
| ---------------------------------------- | ------------------------------- | ------- |
| `sendTimeoutMs` / `PROSODY_SEND_TIMEOUT` | Give up sending after this long | 1s      |

## Requests

Requests work with the defaults on one network. Without a network name, peers always use the direct listener address.
With a network name, peers with the same name use the direct address. Other peers use the advertised connect URI.
Use a different bind address for each client that shares a host.

| Option / Environment Variable                                  | Description                                              | Default                                        |
| -------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `peerBindAddress` / `PROSODY_PEER_BIND_ADDRESS`                | Socket address for the peer gRPC listener                | Default network interface address on port 9099 |
| `peerAdvertisedConnect` / `PROSODY_PEER_ADVERTISED_CONNECT`    | gRPC connect URI that peers on another network use       | (none)                                         |
| `peerNetworkName` / `PROSODY_PEER_NETWORK_NAME`                | Nonempty network name for direct peer routes             | (none)                                         |
| `peerCacheCapacity` / `PROSODY_PEER_CACHE_CAPACITY`            | Maximum channels and peer records in each peer cache     | 256                                            |
| `peerRegistrationTtlSeconds` / `PROSODY_PEER_REGISTRATION_TTL` | Directory lease duration; use 5 seconds through 20 years | 30s                                            |

Set `subsystem` to make this client answer requests. Without it, the client consumes messages but does not answer requests.

## Retry

Retry backoff applies in pipeline and low-latency modes. `maxRetries` controls how many retries low-latency mode performs before routing the failure to `failureTopic`. Pipeline mode uses deferral and does not use this limit.

| Option / Environment Variable                 | Description                                             | Default |
| --------------------------------------------- | ------------------------------------------------------- | ------- |
| `maxRetries` / `PROSODY_MAX_RETRIES`          | Low-latency retries before routing to the failure topic | 3       |
| `retryBaseMs` / `PROSODY_RETRY_BASE`          | Wait this long before first retry                       | 20ms    |
| `maxRetryDelayMs` / `PROSODY_RETRY_MAX_DELAY` | Never wait longer than this                             | 5m      |

## Deferral (Pipeline Mode)

| Option / Environment Variable                               | Description                                                    | Default |
| ----------------------------------------------------------- | -------------------------------------------------------------- | ------- |
| `deferEnabled` / `PROSODY_DEFER_ENABLED`                    | Enable deferral for new messages                               | true    |
| `deferBaseMs` / `PROSODY_DEFER_BASE`                        | Wait this long before first deferred retry                     | 1s      |
| `deferMaxDelayMs` / `PROSODY_DEFER_MAX_DELAY`               | Never wait longer than this                                    | 24h     |
| `deferFailureThreshold` / `PROSODY_DEFER_FAILURE_THRESHOLD` | Disable deferral when failure rate exceeds this                | 0.9     |
| `deferFailureWindowMs` / `PROSODY_DEFER_FAILURE_WINDOW`     | Measure failure rate over this time window                     | 5m      |
| `deferStoreCacheSize` / `PROSODY_DEFER_STORE_CACHE_SIZE`    | Maximum deferred store cache entries per Cassandra defer store | 8192    |

## Kafka Message Loader (All Modes)

The shared loader resolves Kafka messages for deferral and keyed state:

| Option / Environment Variable                                 | Description                                          | Default |
| ------------------------------------------------------------- | ---------------------------------------------------- | ------- |
| `loaderCacheSize` / `PROSODY_LOADER_CACHE_SIZE`               | Maximum messages retained by the shared Kafka loader | 1024    |
| `loaderSeekTimeoutMs` / `PROSODY_LOADER_SEEK_TIMEOUT`         | Timeout for Kafka loader seek operations             | 30s     |
| `loaderDiscardThreshold` / `PROSODY_LOADER_DISCARD_THRESHOLD` | Sequential-read distance before the loader seeks     | 100     |

## Monopolization Detection (Pipeline Mode)

| Option / Environment Variable                                   | Description                            | Default |
| --------------------------------------------------------------- | -------------------------------------- | ------- |
| `monopolizationEnabled` / `PROSODY_MONOPOLIZATION_ENABLED`      | Enable hot key protection              | true    |
| `monopolizationThreshold` / `PROSODY_MONOPOLIZATION_THRESHOLD`  | Max handler time as fraction of window | 0.9     |
| `monopolizationWindowMs` / `PROSODY_MONOPOLIZATION_WINDOW`      | Measurement window                     | 5m      |
| `monopolizationCacheSize` / `PROSODY_MONOPOLIZATION_CACHE_SIZE` | Max distinct keys to track             | 8192    |

## Fair Scheduling (All Modes)

| Option / Environment Variable                                 | Description                                                    | Default |
| ------------------------------------------------------------- | -------------------------------------------------------------- | ------- |
| `schedulerFailureWeight` / `PROSODY_SCHEDULER_FAILURE_WEIGHT` | Fraction of processing time reserved for retries               | 0.3     |
| `schedulerMaxWaitMs` / `PROSODY_SCHEDULER_MAX_WAIT`           | Messages waiting this long get maximum priority                | 2m      |
| `schedulerWaitWeight` / `PROSODY_SCHEDULER_WAIT_WEIGHT`       | Priority boost for waiting messages (higher = more aggressive) | 200.0   |
| `schedulerCacheSize` / `PROSODY_SCHEDULER_CACHE_SIZE`         | Max distinct keys to track                                     | 8192    |

## Telemetry

Prosody emits message, timer, and producer lifecycle events to a Kafka topic for observability:

| Option / Environment Variable                    | Description                       | Default                  |
| ------------------------------------------------ | --------------------------------- | ------------------------ |
| `telemetryEnabled` / `PROSODY_TELEMETRY_ENABLED` | Produce lifecycle events to Kafka | true                     |
| `telemetryTopic` / `PROSODY_TELEMETRY_TOPIC`     | Kafka topic for telemetry events  | prosody.telemetry-events |

Mock mode disables telemetry automatically, regardless of `telemetryEnabled`.

## Cassandra

Persistent storage for timers, deferral, deduplication, and keyed state. It is not needed when `mock: true`.

| Option / Environment Variable                               | Description                        | Default |
| ----------------------------------------------------------- | ---------------------------------- | ------- |
| `cassandraNodes` / `PROSODY_CASSANDRA_NODES`                | Servers to connect to (host:port)  | -       |
| `cassandraKeyspace` / `PROSODY_CASSANDRA_KEYSPACE`          | Keyspace name                      | prosody |
| `cassandraUser` / `PROSODY_CASSANDRA_USER`                  | Username                           | -       |
| `cassandraPassword` / `PROSODY_CASSANDRA_PASSWORD`          | Password                           | -       |
| `cassandraDatacenter` / `PROSODY_CASSANDRA_DATACENTER`      | Prefer this datacenter for queries | -       |
| `cassandraRack` / `PROSODY_CASSANDRA_RACK`                  | Prefer this rack for queries       | -       |
| `cassandraRetentionSeconds` / `PROSODY_CASSANDRA_RETENTION` | Delete data older than this        | 1y      |

## Keyed State

Register keyed-state collections before you subscribe. Persistence is backed by Cassandra and is not needed when `mock: true`. See [Keyed State](README.md#keyed-state) for handler usage. Where an option and an environment variable are paired, an explicitly set option wins. Otherwise, the environment variable applies, then the default.

| Option / Environment Variable                            | Description                                                                                                                                                                                                      | Default                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `stateCollections` / -                                   | Keyed-state collections to register before subscribe (array of collection configs; duplicate names are rejected)                                                                                                 | (none)                                                                              |
| `subsystem` / `PROSODY_SUBSYSTEM`                        | Subsystem name used to advertise JSON and set collections whose definitions set `published: true`                                                                                                                | (none)                                                                              |
| `stateCacheDir` / `PROSODY_STATE_CACHE_DIR`              | Directory that holds the local keyed-state caches. Each consumer uses a fresh subdirectory and removes it when it drops, so clients can share the directory. Set a mounted path in production                    | `<temp>/prosody/keyed-state`                                                        |
| `stateOwnedCacheSize` / `PROSODY_STATE_OWNED_CACHE_SIZE` | Capacity of the owning keyed-state cache; accepts sizes such as `64 MiB` or `500 MB`                                                                                                                             | storage-engine default                                                              |
| `stateMemtableSize` / `PROSODY_STATE_MEMTABLE_SIZE`      | Bytes of in-memory writes the local keyed-state cache holds for each assigned partition before it flushes them to disk. Memory use scales with the number of assigned partitions. Accepts sizes such as `16 MiB` | storage-engine default of 64 MiB                                                    |
| `stateReadCacheSize` / `PROSODY_STATE_READ_CACHE_SIZE`   | Capacity of the published-state read-through cache; accepts sizes such as `1 MiB`                                                                                                                                | `stateOwnedCacheSize` or `PROSODY_STATE_OWNED_CACHE_SIZE` when set; otherwise 1 MiB |
| `stateReadCache` / `PROSODY_STATE_READ_CACHE_TTL`        | Default published-read cache policy. Use `{ ttlMs }` or `{ disabled: true }`; the environment value `none` disables it                                                                                           | 5s                                                                                  |

Each `stateCollections` entry (a `StateCollectionConfig`) has these fields. Prefer the definition constructors from the [API reference](README.md#api-reference). They serialize into `stateCollections`, so you can reuse the same object with `context.state()`.

Published collections require `subsystem`. Keep it configured for one deployment after removing `published: true` so readers can observe the collection's retirement.

| Field             | Description                                                                                                      | Default    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ---------- |
| `name`            | Collection name; non-empty and unique within the client                                                          | (required) |
| `kind`            | `"value"`, `"map"`, `"set"`, or `"deque"`                                                                        | (required) |
| `payload`         | `"json"` (JSON values) or `"message"` (the full Kafka message the handler received). Omit it for a set           | (required) |
| `ttlSeconds`      | Per-write TTL in whole seconds (at least 1)                                                                      | (none)     |
| `readUncommitted` | Opt out of transactional staging (read-uncommitted)                                                              | false      |
| `published`       | Allow other clients to read this JSON or set collection without subscribing                                      | false      |
| `readCache`       | Published-read cache override: `{ ttlMs }`, `false`, or inherit when omitted                                     | inherit    |
| `keysetLimit`     | Map and set only; ordered-scan bound in `0..=4096` (`0` disables ordered-scan tracking)                          | 128        |
| `capacity`        | Deque-only; maximum slot count (at least 1), enforced lazily on push. Runtime-only and may change across deploys | unbounded  |
