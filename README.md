# Prosody: JavaScript Bindings for Kafka

Prosody offers JavaScript bindings to the [Prosody Kafka client](https://github.com/prosody-events/prosody), providing
features for message production and consumption, including configurable retry mechanisms, failure handling
strategies, and integrated OpenTelemetry support for distributed tracing.

## Features

- **Kafka Consumer**: Per-key ordering with cross-key concurrency, offset management, consumer groups
- **Kafka Producer**: Idempotent delivery with configurable retries
- **Timer System**: Persistent scheduled execution backed by Cassandra or in-memory store
- **Quality of Service**: Fair scheduling limits concurrency and prevents failures from starving fresh traffic. Pipeline mode adds deferred retry and monopolization detection
- **Distributed Tracing**: OpenTelemetry integration for tracing message flow across services
- **Backpressure**: Pauses partitions when handlers fall behind
- **Mocking**: In-memory Kafka broker for tests (`mock: true`)
- **Failure Handling**: Pipeline (retry forever), Low-Latency (dead letter), Best-Effort (log and skip)

## Installation

```bash
npm install @prosody-events/prosody
```

## Quick Start

```javascript
const { ProsodyClient } = require("@prosody-events/prosody");

// Initialize the client with Kafka bootstrap servers, consumer group, and topics
const client = new ProsodyClient({
  // Bootstrap servers should normally be set using the PROSODY_BOOTSTRAP_SERVERS environment variable
  bootstrapServers: "localhost:9092",

  // To allow loopbacks, the source_system must be different from the group_id.
  // Normally, the source_system would be left unspecified, which would default to the group_id.
  sourceSystem: "my-application-source",

  // The group_id should be set to the name of your application
  groupId: "my-consumer-group",

  // Topics the client should subscribe to
  subscribedTopics: "my-topic",
});

// Define a message handler
const messageHandler = {
  onMessage: async (context, message, signal) => {
    // Process the received message
    console.log(`Received message: ${JSON.stringify(message)}`);

    // Schedule a timer for delayed processing
    if (message.payload.scheduleFollowup) {
      const followupTime = new Date(Date.now() + 30000); // 30 seconds from now
      await context.schedule(followupTime);
    }
  },

  onTimer: async (context, timer, signal) => {
    // Handle timer firing
    console.log(`Timer fired for key: ${timer.key} at ${timer.time}`);
  },
};

// Subscribe to messages using the message handler
client.subscribe(messageHandler);

// Send a message to a topic
await client.send("my-topic", "message-key", { content: "Hello, Kafka!" });

// Ensure proper shutdown when done
await client.unsubscribe();
```

## Architecture

Prosody enables efficient, parallel processing of Kafka messages while maintaining order for messages with the same key:

- **Partition-Level Parallelism**: Separate management of each Kafka partition
- **Key-Based Queuing**: Ordered processing for each key within a partition
- **Concurrent Processing**: Simultaneous processing of different keys
- **Backpressure Management**: Pause consumption from backed-up partitions

## Quality of Service

All modes use **fair scheduling** to limit concurrency and distribute execution time. Pipeline mode adds **deferred
retry** and **monopolization detection**.

### Fair Scheduling (All Modes)

The scheduler controls which message runs next and how many run concurrently.

**Virtual Time (VT):** Each key accumulates VT equal to its handler execution time. The scheduler picks the key with the
lowest VT. A key that runs for 500ms accumulates 500ms of VT; a key that hasn't run recently has zero VT and gets
priority.

**Two-Class Split:** Normal messages and failure retries have separate VT pools. The scheduler allocates execution time
between them (default: 70% normal, 30% failure). During a failure spike, retries get at most 30% of execution time—fresh
messages continue processing.

**Starvation Prevention:** Tasks receive a quadratic priority boost based on wait time. A task waiting 2 minutes
(configurable) gets maximum boost, overriding VT disadvantage.

### Deferred Retry (Pipeline Mode)

Moves failing keys to timer-based retry so the partition can continue processing other keys.

On transient failure: store the message offset in Cassandra, schedule a timer, return success. The partition advances.
When the timer fires, reload the message from Kafka and retry.

```javascript
// Configure defer behavior
const client = new ProsodyClient({
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
  deferEnabled: true, // Enable deferral (default: true)
  deferBaseMs: 1000, // Wait 1s before first retry
  deferMaxDelayMs: 86400000, // Cap at 24 hours
  deferFailureThreshold: 0.9, // Disable when >90% failing
});
```

**Failure Rate Gating:** When >90% of recent messages fail, deferral disables. The retry middleware blocks the
partition, applying backpressure upstream.

### Monopolization Detection (Pipeline Mode)

Rejects keys that consume too much execution time.

The middleware tracks per-key execution time in 5-minute rolling windows. Keys exceeding 90% of window time are rejected
with a transient error, routing them through defer.

```javascript
// Configure monopolization detection
const client = new ProsodyClient({
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
  monopolizationEnabled: true, // Enable detection (default: true)
  monopolizationThreshold: 0.9, // Reject keys using >90% of window
  monopolizationWindowMs: 300000, // 5-minute window
});
```

### Handler Timeout

Handlers are automatically cancelled if they exceed a deadline:

```javascript
const client = new ProsodyClient({
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
  timeoutMs: 30000, // Cancel after 30 seconds
  stallThresholdMs: 60000, // Report unhealthy after 60 seconds
});
```

When a handler times out, `context.shouldCancel` becomes `true` and `context.onCancel()` resolves. The handler should
exit promptly. If not specified, timeout defaults to 80% of `stallThresholdMs`.

## Configuration

Configure via constructor options or environment variables. Options fall back to environment variables when unset.

### Core

| Option / Environment Variable                    | Description                                       | Default     |
| ------------------------------------------------ | ------------------------------------------------- | ----------- |
| `bootstrapServers` / `PROSODY_BOOTSTRAP_SERVERS` | Kafka servers to connect to                       | -           |
| `groupId` / `PROSODY_GROUP_ID`                   | Consumer group name                               | -           |
| `subscribedTopics` / `PROSODY_SUBSCRIBED_TOPICS` | Topics to read from                               | -           |
| `allowedEvents` / `PROSODY_ALLOWED_EVENTS`       | Only process events matching these prefixes       | (all)       |
| `sourceSystem` / `PROSODY_SOURCE_SYSTEM`         | Tag for outgoing messages (prevents reprocessing) | `<groupId>` |
| `mock` / `PROSODY_MOCK`                          | Use in-memory Kafka for testing                   | false       |

### Consumer

| Option / Environment Variable                             | Description                                                                                                                       | Default                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `maxConcurrency` / `PROSODY_MAX_CONCURRENCY`              | Max messages being processed simultaneously                                                                                       | 32                     |
| `maxUncommitted` / `PROSODY_MAX_UNCOMMITTED`              | Max queued messages before pausing consumption                                                                                    | 64                     |
| `timeoutMs` / `PROSODY_TIMEOUT`                           | Cancel handler if it runs longer than this                                                                                        | 80% of stall threshold |
| `commitIntervalMs` / `PROSODY_COMMIT_INTERVAL`            | How often to save progress to Kafka                                                                                               | 1s                     |
| `pollIntervalMs` / `PROSODY_POLL_INTERVAL`                | How often to fetch new messages from Kafka                                                                                        | 100ms                  |
| `shutdownTimeoutMs` / `PROSODY_SHUTDOWN_TIMEOUT`          | Wait this long for in-flight work before force-quit                                                                               | 30s                    |
| `stallThresholdMs` / `PROSODY_STALL_THRESHOLD`            | Report unhealthy if no progress for this long                                                                                     | 5m                     |
| `probePort` / `PROSODY_PROBE_PORT`                        | HTTP port for health checks (null to disable)                                                                                     | 8000                   |
| `failureTopic` / `PROSODY_FAILURE_TOPIC`                  | Send unprocessable messages here (dead letter queue)                                                                              | -                      |
| `idempotenceCacheSize` / `PROSODY_IDEMPOTENCE_CACHE_SIZE` | Global shared cache capacity across all partitions for deduplicating messages. Must be greater than 0 (a value of 0 is rejected). | 8192                   |
| `idempotenceVersion` / `PROSODY_IDEMPOTENCE_VERSION`      | Version string for cache-busting dedup hashes                                                                                     | `"1"`                  |
| `idempotenceTtlS` / `PROSODY_IDEMPOTENCE_TTL`             | TTL for dedup records in Cassandra in seconds                                                                                     | 604800                 |
| `slabSizeMs` / `PROSODY_SLAB_SIZE`                        | Timer storage granularity (rarely needs changing)                                                                                 | 1h                     |
| `messageSpans` / `PROSODY_MESSAGE_SPANS`                  | Span linking for message execution: `child` (child-of) or `follows_from`                                                          | `child`                |
| `timerSpans` / `PROSODY_TIMER_SPANS`                      | Span linking for timer execution: `child` (child-of) or `follows_from`                                                            | `follows_from`         |

### Producer

| Option / Environment Variable            | Description                     | Default |
| ---------------------------------------- | ------------------------------- | ------- |
| `sendTimeoutMs` / `PROSODY_SEND_TIMEOUT` | Give up sending after this long | 1s      |

### Retry

When a handler fails, retry with exponential backoff:

| Option / Environment Variable                 | Description                       | Default |
| --------------------------------------------- | --------------------------------- | ------- |
| `maxRetries` / `PROSODY_MAX_RETRIES`          | Give up after this many attempts  | 3       |
| `retryBaseMs` / `PROSODY_RETRY_BASE`          | Wait this long before first retry | 20ms    |
| `maxRetryDelayMs` / `PROSODY_RETRY_MAX_DELAY` | Never wait longer than this       | 5m      |

### Deferral (Pipeline Mode)

| Option / Environment Variable                                | Description                                                    | Default |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ------- |
| `deferEnabled` / `PROSODY_DEFER_ENABLED`                     | Enable deferral for new messages                               | true    |
| `deferBaseMs` / `PROSODY_DEFER_BASE`                         | Wait this long before first deferred retry                     | 1s      |
| `deferMaxDelayMs` / `PROSODY_DEFER_MAX_DELAY`                | Never wait longer than this                                    | 24h     |
| `deferFailureThreshold` / `PROSODY_DEFER_FAILURE_THRESHOLD`  | Disable deferral when failure rate exceeds this                | 0.9     |
| `deferFailureWindowMs` / `PROSODY_DEFER_FAILURE_WINDOW`      | Measure failure rate over this time window                     | 5m      |
| `deferCacheSize` / `PROSODY_LOADER_CACHE_SIZE`               | Track this many deferred keys in memory                        | 1024    |
| `deferStoreCacheSize` / `PROSODY_DEFER_STORE_CACHE_SIZE`     | Maximum deferred store cache entries per Cassandra defer store | 8192    |
| `deferSeekTimeoutMs` / `PROSODY_LOADER_SEEK_TIMEOUT`         | Timeout when loading deferred messages                         | 30s     |
| `deferDiscardThreshold` / `PROSODY_LOADER_DISCARD_THRESHOLD` | Read optimization (rarely needs changing)                      | 100     |

### Monopolization Detection (Pipeline Mode)

| Option / Environment Variable                                   | Description                            | Default |
| --------------------------------------------------------------- | -------------------------------------- | ------- |
| `monopolizationEnabled` / `PROSODY_MONOPOLIZATION_ENABLED`      | Enable hot key protection              | true    |
| `monopolizationThreshold` / `PROSODY_MONOPOLIZATION_THRESHOLD`  | Max handler time as fraction of window | 0.9     |
| `monopolizationWindowMs` / `PROSODY_MONOPOLIZATION_WINDOW`      | Measurement window                     | 5m      |
| `monopolizationCacheSize` / `PROSODY_MONOPOLIZATION_CACHE_SIZE` | Max distinct keys to track             | 8192    |

### Fair Scheduling (All Modes)

| Option / Environment Variable                                 | Description                                                    | Default |
| ------------------------------------------------------------- | -------------------------------------------------------------- | ------- |
| `schedulerFailureWeight` / `PROSODY_SCHEDULER_FAILURE_WEIGHT` | Fraction of processing time reserved for retries               | 0.3     |
| `schedulerMaxWaitMs` / `PROSODY_SCHEDULER_MAX_WAIT`           | Messages waiting this long get maximum priority                | 2m      |
| `schedulerWaitWeight` / `PROSODY_SCHEDULER_WAIT_WEIGHT`       | Priority boost for waiting messages (higher = more aggressive) | 200.0   |
| `schedulerCacheSize` / `PROSODY_SCHEDULER_CACHE_SIZE`         | Max distinct keys to track                                     | 8192    |

### Telemetry Emitter

Produces message and timer lifecycle events to a Kafka topic for observability:

| Option / Environment Variable                    | Description                       | Default                  |
| ------------------------------------------------ | --------------------------------- | ------------------------ |
| `telemetryEnabled` / `PROSODY_TELEMETRY_ENABLED` | Produce lifecycle events to Kafka | true                     |
| `telemetryTopic` / `PROSODY_TELEMETRY_TOPIC`     | Kafka topic for telemetry events  | prosody.telemetry-events |

### Cassandra

Persistent storage for timers and deferred retries (not needed if `mock: true`):

| Option / Environment Variable                               | Description                        | Default |
| ----------------------------------------------------------- | ---------------------------------- | ------- |
| `cassandraNodes` / `PROSODY_CASSANDRA_NODES`                | Servers to connect to (host:port)  | -       |
| `cassandraKeyspace` / `PROSODY_CASSANDRA_KEYSPACE`          | Keyspace name                      | prosody |
| `cassandraUser` / `PROSODY_CASSANDRA_USER`                  | Username                           | -       |
| `cassandraPassword` / `PROSODY_CASSANDRA_PASSWORD`          | Password                           | -       |
| `cassandraDatacenter` / `PROSODY_CASSANDRA_DATACENTER`      | Prefer this datacenter for queries | -       |
| `cassandraRack` / `PROSODY_CASSANDRA_RACK`                  | Prefer this rack for queries       | -       |
| `cassandraRetentionSeconds` / `PROSODY_CASSANDRA_RETENTION` | Delete data older than this        | 1y      |

### Keyed State

Register keyed-state collections before you subscribe. Persistence is backed by Cassandra and is not needed when `mock: true`. See the [Keyed State](#keyed-state-1) feature section for handler usage; the client-level knobs and per-collection fields are below. Where an option and an environment variable are paired, an explicitly set option wins; otherwise the environment variable applies, then the default.

| Option / Environment Variable                                      | Description                                                                                                                                                                                                                                           | Default             |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `stateCollections` / -                                             | Keyed-state collections to register before subscribe (array of collection configs; duplicate names are rejected)                                                                                                                                      | (none)              |
| `stateCacheDir` / `PROSODY_FJALL_CACHE_DIR`                        | Root directory for the local committed-value cache; each live client needs its own directory (it is locked exclusively)                                                                                                                               | per-client temp dir |
| `stateRecoveryDelaySeconds` / `PROSODY_KEYED_STATE_RECOVERY_DELAY` | Delay between staging a provisional cell and the recovery sweep; every collection TTL must strictly exceed this. The option is whole seconds (e.g. `30`); the env var is a duration string (e.g. `30s`), second-granularity, min `1s`.                | 30s                 |
| `stateDefaultTtlSeconds` / `PROSODY_KEYED_STATE_DEFAULT_TTL`       | Fallback TTL for rows whose collection is no longer registered; registered collections never inherit it. The option is whole seconds; the env var is a duration string (e.g. `7d`), second-granularity, min `1s`, or `none` for indefinite retention. | none (kept forever) |

Each `stateCollections` entry (a `StateCollectionConfig`) has these fields. Prefer the definition constructors (`value` / `map` / `deque` and their `message*` variants, documented below): they serialize into `stateCollections` so you declare each collection once and reuse the same object with `context.state()`.

| Field             | Description                                                                         | Default    |
| ----------------- | ----------------------------------------------------------------------------------- | ---------- |
| `name`            | Collection name; non-empty and unique within the client                             | (required) |
| `kind`            | `"value"`, `"map"`, or `"deque"`                                                    | (required) |
| `payload`         | `"json"` (JSON values) or `"message"` (the full Kafka message the handler received) | (required) |
| `ttlSeconds`      | Per-write TTL in whole seconds (at least 1; must exceed the recovery delay)         | (none)     |
| `readUncommitted` | Opt out of transactional staging (read-uncommitted)                                 | false      |
| `keysetLimit`     | Map-only; ordered-scan bound in `0..=4096` (`0` disables ordered-scan tracking)     | 128        |

## Liveness and Readiness Probes

Prosody includes a built-in probe server for consumer-based applications that provides health check endpoints. The probe
server is tied to the consumer's lifecycle and offers two main endpoints:

1. `/readyz`: A readiness probe that checks if any partitions are assigned to the consumer. Returns a success status
   only when the consumer has at least one partition assigned, indicating it's ready to process messages.

2. `/livez`: A liveness probe that checks if any partitions have stalled (haven't processed a message within a
   configured time threshold).

Configure the probe server using either the client constructor:

```javascript
const client = new ProsodyClient({
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
  probePort: 8000, // Set to null to disable
  stallThresholdMs: 15000, // 15 seconds before considering a partition stalled
});
```

Or via environment variables:

```bash
PROSODY_PROBE_PORT=8000  # Set to 'none' to disable
PROSODY_STALL_THRESHOLD=15s  # Default stall detection threshold
```

### Important Notes

1. The probe server starts automatically when the consumer is subscribed and stops when unsubscribed.
2. A partition is considered "stalled" if it hasn't processed a message within the `stallThreshold` duration.
3. The stall threshold should be set based on your application's message processing latency and expected message
   frequency.
4. Setting the threshold too low might cause false positives, while setting it too high could delay detection of actual
   issues.
5. The probe server is only active when consuming messages (not for producer-only usage).

You can monitor the stall state programmatically using the client's properties:

```javascript
// Get the number of partitions currently assigned to this consumer
const partitionCount = client.assignedPartitionCount;

// You can use these in your own health checks or monitoring
if (client.isStalled) {
  console.warn("Consumer has stalled partitions");
}
```

## Advanced Usage

### Pipeline Mode

All messages must be processed. Retries indefinitely. Uses defer and monopolization detection.

**Middleware stack:**

```
Kafka → Deduplication → Retry → Defer → Monopolization → Shutdown → Scheduler → Timeout → Telemetry → Handler
```

| Layer          | Purpose                                           |
| -------------- | ------------------------------------------------- |
| Deduplication  | Skips messages whose ID was already processed     |
| Retry          | Retries transient errors indefinitely             |
| Defer          | Stores failing messages for timer-based retry     |
| Monopolization | Rejects keys exceeding execution time threshold   |
| Shutdown       | Drains in-flight work on partition revocation     |
| Scheduler      | Enforces concurrency limits and VT-based priority |
| Timeout        | Cancels handlers exceeding deadline               |
| Telemetry      | Emits handler lifecycle events                    |

```javascript
const client = new ProsodyClient({
  mode: Mode.Pipeline, // Default mode
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
});
```

### Low-Latency Mode

Tries a few times, then routes failures to a dead letter topic.

- Retries up to `maxRetries` times, then writes to failure topic
- Fair scheduling limits how much time retries consume
- Use when you need to keep moving and can reprocess failures later

```javascript
const client = new ProsodyClient({
  mode: Mode.LowLatency,
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
  failureTopic: "failed-messages", // Required for low-latency mode
  maxRetries: 3, // Give up after 3 attempts
});
```

### Best-Effort Mode

Logs failures and moves on.

- No retries; failed messages are logged and committed
- Fair scheduling still enforces concurrency limits
- Use for development or when message loss is acceptable

```javascript
const client = new ProsodyClient({
  mode: Mode.BestEffort,
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
});
```

## Event Type Filtering

Prosody supports filtering messages based on event type prefixes, allowing your consumer to process only specific types
of events:

```javascript
// Process only events with types starting with "user." or "account."
const client = new ProsodyClient({
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
  allowedEvents: ["user.", "account."],
});
```

Or via environment variables:

```bash
PROSODY_ALLOWED_EVENTS=user.,account.
```

### Matching Behavior

Prefixes must match exactly from the start of the event type:

✓ Matches:

- `{"type": "user.created"}` matches prefix `user.`
- `{"type": "account.deleted"}` matches prefix `account.`

✗ No Match:

- `{"type": "admin.user.created"}` doesn't match `user.`
- `{"type": "my.account.deleted"}` doesn't match `account.`
- `{"type": "notification"}` doesn't match any prefix

If no prefixes are configured, all messages are processed. Messages without a `type` field are always processed.

## Source System Deduplication

Prosody prevents processing loops in distributed systems by tracking the source of each message:

```javascript
// Consumer and producer in one application
const client = new ProsodyClient({
  groupId: "my-service",
  sourceSystem: "my-service-producer", // Must differ from groupId to allow loopbacks; defaults to groupId
  subscribedTopics: "my-topic",
});
```

Or via environment variable:

```bash
PROSODY_SOURCE_SYSTEM=my-service-producer
```

### How It Works

1. **Producers** add a `source-system` header to all outgoing messages.
2. **Consumers** check this header on incoming messages.
3. If a message's source system matches the consumer's group ID, the message is skipped.

This prevents endless loops where a service consumes its own produced messages.

### Message Deduplication

Prosody automatically deduplicates messages using the `id` field in their JSON payload. Consecutive messages with the
same ID and key are processed only once.

Deduplication uses a two-tier approach:

- **Global in-memory cache**: A single cache shared across all partitions within the same consumer instance. Survives
  partition reassignments within the same process. Controlled by `idempotenceCacheSize` (default 8192).
- **Cassandra-backed persistent store**: Survives restarts and rebalances across instances. TTL controlled by
  `idempotenceTtlS` (default 7 days, i.e. 604800s).

Deduplication is always active. `idempotenceCacheSize` must be greater than `0`; a value of `0` (via either the option
or `PROSODY_IDEMPOTENCE_CACHE_SIZE=0`) is rejected when the client is constructed.

```javascript
// Messages with IDs are deduplicated per key
await client.send("my-topic", "key1", {
  id: "msg-123", // Message will be processed
  content: "Hello!",
});

await client.send("my-topic", "key1", {
  id: "msg-123", // Message will be skipped (duplicate)
  content: "Hello again!",
});

await client.send("my-topic", "key2", {
  id: "msg-123", // Message will be processed (different key)
  content: "Hello!",
});
```

To invalidate all previously recorded dedup entries (forcing reprocessing of messages), change the version:

```javascript
const client = new ProsodyClient({
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
  idempotenceVersion: "2", // Changing this invalidates all previously recorded entries
});
```

Or via environment variable:

```bash
PROSODY_IDEMPOTENCE_VERSION=2
```

## Timer Functionality

Prosody supports timer-based delayed execution within message handlers. When a timer fires, your handler's `onTimer` method will be called:

```javascript
const messageHandler = {
  onMessage: async (context, message, signal) => {
    // Schedule a timer to fire in 30 seconds
    const futureTime = new Date(Date.now() + 30000);
    await context.schedule(futureTime);

    // Schedule multiple timers
    const oneMinute = new Date(Date.now() + 60000);
    const twoMinutes = new Date(Date.now() + 120000);
    await context.schedule(oneMinute);
    await context.schedule(twoMinutes);

    // Check what's scheduled
    const scheduled = await context.scheduled();
    console.log(`Scheduled timers: ${scheduled.length}`);
  },

  onTimer: async (context, timer, signal) => {
    console.log("Timer fired!");
    console.log(`Key: ${timer.key}`);
    console.log(`Scheduled time: ${timer.time}`);
  },
};
```

### Timer Methods

The context provides timer scheduling methods that allow you to delay execution or implement timeout behavior:

- `schedule(time)`: Schedules a timer to fire at the specified time
- `clearAndSchedule(time)`: Clears all timers and schedules a new one
- `unschedule(time)`: Removes a timer scheduled for the specified time
- `clearScheduled()`: Removes all scheduled timers
- `scheduled()`: Returns an array of all scheduled timer times

### Timer Object

When a timer fires, the `onTimer` method receives a timer object with these properties:

- `key` (string): The entity key identifying what this timer belongs to
- `time` (Date): The time when this timer was scheduled to fire

**Note**: Timer precision is limited to seconds due to the underlying storage format. Sub-second precision in scheduled times will be rounded to the nearest second.

### Timer Configuration

Timer functionality requires Cassandra for persistence unless running in mock mode. Configure Cassandra connection via environment variable:

```bash
PROSODY_CASSANDRA_NODES=localhost:9042  # Required for timer persistence
```

Or programmatically when creating the client:

```javascript
const client = new ProsodyClient({
  bootstrapServers: "localhost:9092",
  groupId: "my-application",
  subscribedTopics: "my-topic",
  cassandraNodes: "localhost:9042", // Required unless mock: true
});
```

For testing, you can use mock mode to avoid Cassandra dependency:

```javascript
// Mock mode for testing (timers work but aren't persisted)
const client = new ProsodyClient({
  bootstrapServers: "localhost:9092",
  groupId: "my-application",
  subscribedTopics: "my-topic",
  mock: true, // No Cassandra required in mock mode
});
```

### Error Handling

Prosody classifies errors as transient (temporary, can be retried) or permanent (won't be resolved by retrying). By
default, all errors are considered transient.

#### Using Decorators

If you're using TypeScript or a JavaScript environment that supports decorators, you can use the `@permanent` decorator
to classify exceptions that should not be retried:

```javascript
import { permanent, ProsodyClient } from "@prosody-events/prosody";

class MyHandler {
  @permanent(TypeError, AttributeError)
  async onMessage(context, message, signal) {
    // Your message handling logic here
    // TypeError and AttributeError will be treated as permanent
    // All other exceptions will be treated as transient (default behavior)
  }
}

const client = new ProsodyClient(config);
client.subscribe(new MyHandler());
```

#### Without Decorators

If you're not using decorators, you can still classify errors as permanent by throwing a `PermanentError`:

```javascript
import { PermanentError, ProsodyClient } from "@prosody-events/prosody";

const messageHandler = {
  onMessage: async (context, message, signal) => {
    try {
      // Your message handling logic here
    } catch (error) {
      if (error instanceof TypeError || error instanceof AttributeError) {
        throw new PermanentError(error.message);
      }
      // All other exceptions will be treated as transient (default behavior)
      throw error;
    }
  },
};

const client = new ProsodyClient(config);
client.subscribe(messageHandler);
```

#### Best Practices for Error Handling

- Use permanent errors for issues like malformed data or business logic violations.
- Use transient errors for temporary issues like network problems.
- Be cautious with permanent errors as they prevent retries and can result in data loss.
- Consider system reliability and data consistency when classifying errors.

## Keyed State

Prosody supports keyed state: per-key data that a handler reads and writes and that survives across events. State is partitioned by the message key, so each key has a single writer at a time, and by default writes settle atomically with the event — a handler that throws leaves no partial state. Values are either JSON payloads or the full Kafka `Message` the handler received. Register collections on the client before subscribing, then bind them inside the handler with `context.state(definition)`:

```typescript
import {
  ProsodyClient,
  value,
  map,
  messageDeque,
  Message,
} from "@prosody-events/prosody";

interface Cart {
  items: string[];
}
interface OrderEvent {
  orderId: string;
  total: number;
}

const cart = value<Cart>("cart", { ttlSeconds: 30 * 86400 });
const totals = map<number>("totals"); // keys are always string
const backlog = messageDeque<OrderEvent>("backlog");

const client = new ProsodyClient({
  ...config,
  stateCollections: [cart, totals, backlog],
});

client.subscribe({
  async onMessage(context, message: Message<OrderEvent>, signal) {
    const c = context.state(cart); // ValueState<Cart>
    const current = (await c.get()) ?? { items: [] }; // Cart | null
    await c.set({ items: [...current.items, message.payload.orderId] });

    await context.state(totals).set(message.key, message.payload.total);
    for await (const [key, total] of context.state(totals).entries()) {
      // key: string, total: number
      void key;
      void total;
    }

    const b = context.state(backlog); // DequeState<Message<OrderEvent>>
    await b.push(message);
    const oldest = await b.get(0); // Message<OrderEvent> | null
    void oldest;
  },
});
```

### Definitions

A definition constructor declares one collection and returns a frozen definition object carrying its `name`, `kind`, and `payload`. Reference that definition both in `Configuration.stateCollections` (registration) and in `context.state()` (binding) — declare each collection once and reuse it. (Reuse is a convenience, not a requirement: binding matches a definition to a registered collection by its `name`/`kind`/`payload` fields, not by object identity, so a structurally-equal definition also works.) Three kinds, each with a JSON variant (values are your JSON payload) and a message variant (values are the full Kafka `Message<P>`):

- `value<T>(name, options?)`: single value. Vends `ValueState<T>`.
- `map<V>(name, options?)`: ordered map with **string** keys. Vends `MapState<V>`.
- `deque<T>(name, options?)`: double-ended queue. Vends `DequeState<T>`.
- `messageValue<P>(name, options?)`: single value holding a `Message<P>`. Vends `ValueState<Message<P>>`.
- `messageMap<P>(name, options?)`: ordered map of `Message<P>` (string keys). Vends `MapState<Message<P>>`.
- `messageDeque<P>(name, options?)`: deque of `Message<P>`. Vends `DequeState<Message<P>>`.

`options` accepts `ttlSeconds` and `readUncommitted` on every kind, plus `keysetLimit` on maps only. The type parameter is annotation-level only: payloads cross the boundary as plain JSON with no runtime validation, so the parameter guides your TypeScript but does not enforce a shape at runtime.

### Registration

Put the definitions in `Configuration.stateCollections` when constructing the client, before calling `subscribe`. Each definition serializes into a collection config entry, so passing the definition object is all that is required. Collection names must be unique within a client — duplicate names are rejected. Keyed state needs Cassandra unless the client runs with `mock: true`. See the [Keyed State configuration](#keyed-state) subsection above for the client-level knobs and per-collection fields.

### State Handles

`context.state(definition)` vends a typed handle bound to the collection for the current event attempt. The handle — and any iterator it opens — is valid only within the handler invocation that created it; there is no post-handler read window. Binding an unregistered name throws a `PermanentStateError`; so does a definition whose `kind` or `payload` disagrees with what was durably registered under that name in the consumer group (the collection's stored schema identity, which core validates at first use — this is a schema conflict across deploys, not a JavaScript object-identity check).

`ValueState<T>`:

- `get(): Promise<T | null>`: reads the current value, or `null` when absent.
- `set(value: T): Promise<void>`: buffers a write. Writing JSON `null` is rejected — call `clear()`.
- `clear(): Promise<void>`: deletes the stored value.
- `commit(): Promise<void>` / `rollback(): Promise<void>`: see [Commit and Rollback](#commit-and-rollback).

`MapState<V>` (keys are always `string`):

- `get(key: string): Promise<V | null>`: reads the value for `key`, or `null` when absent.
- `set(key: string, value: V): Promise<void>`: inserts or overwrites. Writing JSON `null` is rejected — call `delete(key)`.
- `delete(key: string): Promise<void>`: removes `key`. Deliberately returns `void`, not a boolean "was present" flag (surfacing that would force a hidden read on every delete).
- `clear(): Promise<void>`: removes every entry.
- `entries(direction?)` / `keys()` / `values()` / `[Symbol.asyncIterator]`: see [Scan Iteration](#scan-iteration).
- `commit(): Promise<void>` / `rollback(): Promise<void>`.

`DequeState<T>`:

- `push(item: T): Promise<void>`: appends at the back. Writing JSON `null` is rejected.
- `unshift(item: T): Promise<void>`: prepends at the front. Writing JSON `null` is rejected.
- `pop(): Promise<T | null>`: removes and returns the back element, or `null` when empty.
- `shift(): Promise<T | null>`: removes and returns the front element, or `null` when empty.
- `length(): Promise<number>`: number of live elements.
- `isEmpty(): Promise<boolean>`: whether the deque holds no live elements.
- `get(index: number): Promise<T | null>`: reads the element at front-relative `index`, or `null` past the end. `index` must be a non-negative integer; a fractional, negative, or out-of-range value is a caller mistake, rejected with a `TransientStateError` (it retries and stays visible rather than discarding the message).
- `values(direction?)` / `[Symbol.asyncIterator]`: see [Scan Iteration](#scan-iteration).
- `commit(): Promise<void>` / `rollback(): Promise<void>`.

### Scan Iteration

Maps expose `entries(direction?)`, `keys()`, and `values()`; deques expose `values(direction?)`. Each returns an `AsyncIterableIterator`, so you can drive it with `for await`. `direction` is `"forward"` (default) or `"backward"`. On a map, `keys()` and `values()` are always forward-only; only `entries()` accepts a direction. Both classes also implement `[Symbol.asyncIterator]` as forward iteration (map: `[key, value]` entries; deque: elements), so the handle itself is iterable.

Iterators are valid only within the attempt that opened them. Exiting a `for await` loop early closes the underlying cursor (the iterator's `return()` calls the native `close()`), so an early `break` releases the scan promptly:

```typescript
for await (const [key, total] of context.state(totals).entries("backward")) {
  if (total > 1000) break; // early exit closes the cursor
}
```

### Commit and Rollback

Every handle exposes `commit(): Promise<void>` and `rollback(): Promise<void>`. By default a handler's writes are buffered and settle atomically when the event completes; commit and rollback are the explicit mid-handler escape hatch.

- `commit()` durably flushes this collection's buffered operations mid-handler. It is at-least-once: the flush becomes visible even if the event later fails and is redelivered, and it establishes a floor that a later `rollback()` cannot cross.
- `rollback()` discards this collection's buffered uncommitted operations back to the last commit floor. It is infallible.

Both resolve with no value. The erased core seam deliberately drops the store outcome, so there is **no** `"applied"` / `"noop"` return — do not expect one.

### Semantics

- **Per-key single writer.** State is keyed by the message key; only one handler invocation writes a given key at a time.
- **Transactional by default.** A handler's writes settle atomically with the event. A handler that throws leaves no partial state (unless you opted a collection into `readUncommitted`, or flushed explicitly with `commit()`).
- **At-least-once.** Redelivery re-runs the handler; reads reflect committed prior attempts. Keep handlers idempotent.
- **Attempt-scoped.** The context, the handles it vends, and any iterators those handles open are valid only within the handler invocation that created them. Do not retain them past the handler.

### Error Handling

Keyed-state failures surface as structured errors that flow through the same handler-error bridge as everything else (the transient/permanent category is carried as data, never parsed from the message):

- `TransientStateError` (subclasses `TransientError`): the default. A temporary store read/write failure (for example a timeout), **and every caller mistake** — a rejected `null`/`undefined`/unrepresentable write (use `clear()` / `delete()` instead), an item-shape mismatch, an out-of-range deque index, or an invalid scan direction. Caller mistakes are transient on purpose: a permanent error discards the in-flight message and can silently lose data, so a code error retries and stays visible (logs/metrics/lag) until you fix it.
- `PermanentStateError` (subclasses `PermanentError`): reserved for failures a retry genuinely cannot resolve within the running process — an unregistered or identity-mismatched collection, or a duplicate registration. (A handler may also throw one explicitly to declare its own failure permanent.)

Because they subclass the existing error hierarchy, rethrowing them from a handler classifies the event exactly like a plain `PermanentError` / `TransientError`. Use `isStateError(error)` to narrow an error to either state error class.

## OpenTelemetry Tracing

Prosody supports OpenTelemetry tracing, allowing you to monitor and analyze the performance of your Kafka-based
applications. The library will emit traces using the OTLP protocol if the `OTEL_EXPORTER_OTLP_ENDPOINT` environment
variable is defined.

Note: Prosody emits its own traces separately because it uses its own tracing runtime, as it would be expensive to send
all traces to JavaScript.

### Required Packages

To use OpenTelemetry tracing with Prosody, you need to install the following packages:

```
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

### Initializing Tracing

To initialize tracing in your application:

```javascript
const opentelemetry = require("@opentelemetry/api");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-http");

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  serviceName: "my-service-name",
});

sdk.start();

// Creates a tracer from the global tracer provider
const tracer = opentelemetry.trace.getTracer("my-service-name");
```

### Setting OpenTelemetry Environment Variables

Set the following standard OpenTelemetry environment variables:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=my-service-name
```

For more information on these and other OpenTelemetry environment variables, refer to
the [OpenTelemetry specification](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#general-sdk-configuration).

### Using Tracing in Your Application

After initializing tracing, you can define spans in your application, and they will be properly propagated through
Kafka:

```javascript
const { ProsodyClient } = require("@prosody-events/prosody");
const opentelemetry = require("@opentelemetry/api");

const tracer = opentelemetry.trace.getTracer("my-service-name");

const client = new ProsodyClient({
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
});

const messageHandler = {
  onMessage: async (context, message, signal) => {
    const span = tracer.startSpan("process-message");
    try {
      // Process the received message
      span.addEvent("message.received", {
        "message.payload": JSON.stringify(message),
      });
    } finally {
      span.end();
    }
  },
};

client.subscribe(messageHandler);
```

### Span Linking

By default, message execution spans use **`child`** (child-of relationship — the execution span is part of
the same trace as the producer). Timer execution spans use **`follows_from`** (the execution span starts a
new trace with a span link back to the scheduling span, since timer execution is causally related but not part of
the same operation).

Both strategies are configurable via the `messageSpans` / `PROSODY_MESSAGE_SPANS` and `timerSpans` /
`PROSODY_TIMER_SPANS` options. Accepted values: `'child'`, `'follows_from'`.

## Best Practices

### Ensuring Idempotent Message Handlers

Idempotent message handlers are crucial for maintaining data consistency, fault tolerance, and scalability when working
with distributed, event-based systems. They ensure that processing a message multiple times has the same effect as
processing it once, which is essential for recovering from failures.

Strategies for achieving idempotence:

1. **Natural Idempotence**: Use inherently idempotent operations (e.g., setting a value in a key-value store).

2. **Deduplication with Unique Identifiers**:

- Kafka messages can be uniquely identified by their partition and offset.
- Before processing, check if the message has been handled before.
- Store processed message identifiers with an appropriate TTL.

3. **Database Upserts**: Use upsert operations for database writes.

4. **Partition Offset Tracking**:

- Store the latest processed offset for each partition.
- Only process messages with higher offsets than the last processed one.
- Critically, store these offsets transactionally with other state updates to ensure consistency.

5. **Idempotency Keys for External APIs**: Utilize idempotency keys when supported by external APIs.

6. **Check-then-Act Pattern**:

- For non-idempotent external systems, verify if an operation was previously completed before execution.
- Maintain a record of completed operations, keyed by a unique message identifier.

7. **Saga Pattern**:

- Implement a state machine in your database for multi-step operations.
- Each message advances the state machine, allowing for idempotent processing and easy failure recovery.
- Particularly useful for complex, distributed transactions across multiple services.

### Proper Shutdown

Always unsubscribe from topics before exiting your application:

```javascript
// Ensure proper shutdown
await client.unsubscribe();
```

This ensures:

1. Completion and commitment of all in-flight work
2. Quick rebalancing, allowing other consumers to take over partitions
3. Proper release of resources

Implement shutdown handling in your application:

```javascript
const { ProsodyClient } = require("@prosody-events/prosody");

async function main() {
  const client = new ProsodyClient({
    groupId: "my-consumer-group",
    subscribedTopics: "my-topic",
  });

  const messageHandler = {
    onMessage: async (context, message, signal) => {
      // Process the message
    },
  };

  client.subscribe(messageHandler);

  // Create a promise that resolves when shutdown is signaled
  const shutdownPromise = new Promise((resolve) => {
    const shutdown = async (signal) => {
      console.log(`Received ${signal}. Initiating shutdown...`);
      await client.unsubscribe();
      resolve();
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGHUP", () => shutdown("SIGHUP"));
  });

  // Wait for shutdown to be signaled
  await shutdownPromise;
}

main().catch(console.error);
```

### Handling Task Cancellation

Prosody cancels tasks during partition rebalancing or shutdown. How you handle cancellation is critical:

- Prosody interprets task success based on exception propagation.
- A task that exits without an exception is considered successful.
- Any exception signals task failure.

The library uses AbortSignals in both the `send` method and `onMessage` handler. It's crucial to pass this abort signal
to any I/O operations, fetch calls, or database queries to ensure prompt task cancellation.

Best practices:

1. Exit promptly when cancelled to avoid rebalancing delays.
2. Use try/catch blocks to handle cancellation gracefully.
3. Use try/finally or equivalent constructs for clean resource handling.
4. Pass the AbortSignal to all async operations that support it.

Example of using AbortSignal in message processing:

```javascript
const messageHandler = {
  onMessage: async (context, message, signal) => {
    // Pass the signal to fetch calls
    const response = await fetch("https://api.example.com", { signal });
    const data = await response.json();

    // Pass the signal to database operations
    await db.query(
      "INSERT INTO messages (payload) VALUES ($1)",
      [message.payload],
      { signal },
    );

    // Process the data...

    // Send a message, passing the abort signal
    await client.send("topic", "key", { data: "value" }, signal);
  },
};
```

For the `send` method, note that while an abort signal will cause the method to return early, it may not cancel the
message being sent, depending on when the abort is signaled. If the abort occurs after the message has been handed off
to the Kafka client, the message may still be sent.

Failing to follow these practices can lead to:

- Slower message processing due to delayed rebalancing.
- Data loss from missed messages when cancellation errors are suppressed.
- Resource leaks if long-running operations aren't properly cancelled.

## Release Process

Prosody uses an automated release process managed by GitHub Actions. Here's an overview of how releases are handled:

1. **Trigger**: The release process is triggered automatically on pushes to the `main` branch.

2. **Release Please**: The process starts with the "Release Please" action, which:
   - Analyzes commit messages since the last release.
   - Creates or updates a release pull request with changelog updates and version bumps.
   - When the PR is merged, it creates a GitHub release and a git tag.

3. **Build Process**: If a new release is created, the following build jobs are triggered:
   - Linux builds for x86_64 and aarch64 (glibc).
   - Windows build for x64.
   - macOS build for aarch64 (Apple Silicon).

4. **Testing**: The built binaries are tested on Linux (x86_64 and aarch64) with Node.js 20 and 22.

5. **Artifact Upload**: Each build job uploads its artifacts (Node.js native addons) to GitHub Actions.

6. **Publication**: If all builds and tests are successful, the final step publishes the package to the npm registry.

### Contributing to Releases

To contribute to a release:

1. Make your changes in a feature branch.
2. Use [Conventional Commits](https://www.conventionalcommits.org/) syntax for your commit messages. This helps Release
   Please determine the next version number and generate the changelog.
3. Create a pull request to merge your changes into the `main` branch.
4. Once your PR is approved and merged, Release Please will include your changes in the next release PR.

### Manual Releases

While the process is automated, manual intervention may sometimes be necessary:

- You can manually trigger the release workflow from the GitHub Actions tab if needed.
- If you need to make changes to the release PR created by Release Please, you can do so before merging it.

Remember, all releases are automatically published to the npm registry. Ensure you have thoroughly tested
your changes before merging to `main`.

## API Reference

### ProsodyClient

- `constructor(config: Configuration)`: Initialize a new ProsodyClient with the given configuration.
- `send(topic: string, key: string, payload: any, signal?: AbortSignal): Promise<void>`: Send a message to a specified
  topic.
- `consumerState: ConsumerState`: Get the current state of the consumer.
- `sourceSystem: string`: Get the source system identifier configured for the client.
- `subscribe(eventHandler: EventHandler): void`: Subscribe to messages using the provided handler.
- `unsubscribe(): Promise<void>`: Unsubscribe from messages and shut down the consumer.

### EventHandler

Interface for handling messages and timers:

- `onMessage?: (context: Context, message: Message, signal: AbortSignal) => Promise<void>`: Handles incoming messages
- `onTimer?: (context: Context, timer: Timer, signal: AbortSignal) => Promise<void>`: Handles timer events

### Message

Represents a Kafka message with the following properties:

- `topic: string`: The name of the topic.
- `partition: number`: The partition number.
- `offset: bigint`: The message offset within the partition.
- `timestamp: Date`: The timestamp when the message was created or sent.
- `key: string`: The message key.
- `payload: any`: The message payload as a JSON-serializable value.

`Message` takes an optional payload type parameter, `Message<P>`, used by message-backed state collections to type `payload`. Unparameterized `Message` is `Message<any>`.

### Context

Represents the context of message processing:

- `onCancel(): Promise<void>`: A method that resolves when the context is cancelled.
- `shouldCancel: boolean`: A property indicating whether the context has been cancelled.

Timer scheduling methods:

- `schedule(time: Date): Promise<void>`: Schedules a timer to fire at the specified time
- `clearAndSchedule(time: Date): Promise<void>`: Clears all timers and schedules a new one
- `unschedule(time: Date): Promise<void>`: Removes a timer scheduled for the specified time
- `clearScheduled(): Promise<void>`: Removes all scheduled timers
- `scheduled(): Promise<Date[]>`: Returns an array of all scheduled timer times

Keyed-state binding:

- `state(definition): ValueState<T> | MapState<V> | DequeState<T>`: Binds a registered collection for the current event attempt, returning a typed handle (message definitions vend `*State<Message<P>>`). Throws `PermanentStateError` when the name was never registered, or when the definition's `kind`/`payload` disagrees with the collection's durably-registered schema. See the [Keyed State](#keyed-state-2) API reference below.

### Timer

Represents a timer that has fired, provided to the `onTimer` method:

- `key: string`: The entity key identifying what this timer belongs to
- `time: Date`: The time when this timer was scheduled to fire

### Keyed State

Definition constructors (each returns a frozen definition object used both in `Configuration.stateCollections` and with `context.state()`):

- `value<T = any>(name: string, options?: StateDefinitionOptions): ValueDefinition<T>`
- `map<V = any>(name: string, options?: MapDefinitionOptions): MapDefinition<V>`
- `deque<T = any>(name: string, options?: StateDefinitionOptions): DequeDefinition<T>`
- `messageValue<P = any>(name: string, options?: StateDefinitionOptions): MessageValueDefinition<P>`
- `messageMap<P = any>(name: string, options?: MapDefinitionOptions): MessageMapDefinition<P>`
- `messageDeque<P = any>(name: string, options?: StateDefinitionOptions): MessageDequeDefinition<P>`

`StateDefinitionOptions`: `{ ttlSeconds?: number; readUncommitted?: boolean }`. `MapDefinitionOptions` extends it with `keysetLimit?: number`.

`ValueState<T>`:

- `get(): Promise<T | null>`
- `set(value: T): Promise<void>`
- `clear(): Promise<void>`
- `commit(): Promise<void>`
- `rollback(): Promise<void>`

`MapState<V>` (keys are `string`):

- `get(key: string): Promise<V | null>`
- `set(key: string, value: V): Promise<void>`
- `delete(key: string): Promise<void>`
- `clear(): Promise<void>`
- `entries(direction?: ScanDirection): AsyncIterableIterator<[string, V]>`
- `keys(): AsyncIterableIterator<string>`
- `values(): AsyncIterableIterator<V>`
- `[Symbol.asyncIterator](): AsyncIterableIterator<[string, V]>`
- `commit(): Promise<void>`
- `rollback(): Promise<void>`

`DequeState<T>`:

- `push(item: T): Promise<void>`
- `unshift(item: T): Promise<void>`
- `pop(): Promise<T | null>`
- `shift(): Promise<T | null>`
- `length(): Promise<number>`
- `isEmpty(): Promise<boolean>`
- `get(index: number): Promise<T | null>`
- `values(direction?: ScanDirection): AsyncIterableIterator<T>`
- `[Symbol.asyncIterator](): AsyncIterableIterator<T>`
- `commit(): Promise<void>`
- `rollback(): Promise<void>`

`ScanDirection`: `"forward" | "backward"`.

`StateCollectionConfig` (a `stateCollections` entry): `{ name: string; kind: "value" | "map" | "deque"; payload: "json" | "message"; ttlSeconds?: number; readUncommitted?: boolean; keysetLimit?: number }`. The definition constructors produce objects assignable to this shape, so prefer them.

Errors:

- `TransientStateError extends TransientError`: the default — a temporary store read/write failure, or any caller mistake (a `null`/unrepresentable write, item-shape mismatch, out-of-range index, invalid scan direction), rejected transient so it retries rather than discarding the message.
- `PermanentStateError extends PermanentError`: reserved for failures a retry cannot resolve in-process (unregistered/identity-mismatched collection, duplicate registration), or one a handler throws explicitly.
- `isStateError(error: unknown): error is PermanentStateError | TransientStateError`: type-guard narrowing an error to either state error class.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
