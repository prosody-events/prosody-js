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

The package ships TypeScript declarations for the public API.
`EventHandler<P>` carries an application payload type into `Message<P>`, and
keyed-state definitions carry their item types through `context.state()`.
Unparameterized handlers, messages, definitions, and state handles default to
`JsonValue`. See the [strict TypeScript examples](examples/) for IDE-ready
projects compiled by the repository typecheck.

## Quick Start

Run each example in an asynchronous function unless the example defines one.

```javascript
const { ProsodyClient } = require("@prosody-events/prosody");

async function main() {
  // Initialize the client with Kafka bootstrap servers, consumer group, and topics
  const client = await ProsodyClient.create({
    // Bootstrap servers should normally be set using the PROSODY_BOOTSTRAP_SERVERS environment variable
    bootstrapServers: "localhost:9092",

    // To allow loopbacks, sourceSystem must be different from groupId.
    // Normally, sourceSystem is omitted and defaults to groupId.
    sourceSystem: "my-application-source",

    // groupId should be set to the name of your application
    groupId: "my-consumer-group",

    // Topics the client should subscribe to
    subscribedTopics: "my-topic",
  });

  // Define a message handler
  const messageHandler = {
    onExcise: async (context, message, signal) => {
      console.log(`Excise key: ${message.key}`);
      return null;
    },

    onMessage: async (context, message, signal) => {
      // Process the received message
      console.log(`Received message: ${JSON.stringify(message)}`);

      // Schedule a timer for delayed processing
      if (message.payload.scheduleFollowup) {
        const followupTime = new Date(Date.now() + 30000); // 30 seconds from now
        await context.schedule(followupTime);
      }
      return null;
    },

    onTimer: async (context, timer, signal) => {
      // Handle timer firing
      console.log(`Timer fired for key: ${timer.key} at ${timer.time}`);
    },
  };

  // Subscribe to messages using the message handler
  await client.subscribe(messageHandler);

  // Send a message to a topic
  await client.send("my-topic", "message-key", { content: "Hello, Kafka!" });
  await client.excise("my-topic", "obsolete-key");

  // Shut down all client services when done
  await client.shutdown();
}

main().catch(console.error);
```

## Excise records

Call `excise(topic, key)` to send a Kafka record with a key and no payload. Use this record to delete the key from compacted views.

Each handler must implement `onMessage`, `onExcise`, and `onTimer`. Subscription fails before consumption if a method is missing.

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
const client = await ProsodyClient.create({
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
const client = await ProsodyClient.create({
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
const client = await ProsodyClient.create({
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
  timeoutMs: 30000, // Cancel after 30 seconds
  stallThresholdMs: 60000, // Report unhealthy after 60 seconds
});
```

When a handler times out, `context.shouldCancel` becomes `true` and `context.onCancel()` resolves. The handler should
exit promptly. If not specified, timeout defaults to 80% of `stallThresholdMs`.

## Configuration

For the complete configuration reference, see [CONFIGURATION.md](CONFIGURATION.md).

Constructor options take precedence. Unset options use environment variables, then library defaults.

Client construction is asynchronous. Replace `new ProsodyClient(config)` with `await ProsodyClient.create(config)`.

## Liveness and Readiness Probes

Prosody includes a built-in probe server for consumer-based applications that provides health check endpoints. The probe
server is tied to the consumer's lifecycle and offers two main endpoints:

1. `/readyz`: A readiness probe that checks if any partitions are assigned to the consumer. Returns a success status
   only when the consumer has at least one partition assigned, indicating it's ready to process messages.

2. `/livez`: A liveness probe that checks if any partitions have stalled (haven't processed a message within a
   configured time threshold).

Configure the probe server using either the client constructor:

```javascript
const client = await ProsodyClient.create({
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

## Requests

Requests return one outcome for each named subsystem. The result map uses the canonical subsystem names as keys.

Use `requestExcise` to send an excise record and collect the same outcome type.

Do not rely on map iteration order.

Prosody rejects the request if it cannot produce the complete result map.

Do not await a request from a handler for the same key and subsystem. The request cannot finish before that handler returns.

Message handler return values become successful request outcomes. Each return value must have a JSON representation.

Return a JSON response from each message handler:

```javascript
await client.subscribe({
  onMessage: async (_context, message) => ({ accepted: message.key }),
  onExcise: async (_context, message) => ({ accepted: message.key }),
  onTimer: async () => {},
});
```

Send a request without a subscription on the requester:

```javascript
const subsystems = ["inventory", "billing"];
const results = await client.request(
  "orders",
  "order-1",
  { type: "order.created" },
  { subsystems, timeoutMs: 2_000 },
);

for (const [subsystem, outcome] of results) {
  if (outcome.ok) console.log(`${subsystem}:`, outcome.value);
  else console.error(`${subsystem}: ${outcome.error.message}`);
}
```

The example can print these results:

```text
inventory: { accepted: 'order-1' }
billing: no response arrived before the deadline
```

Each map value is a `Success` or `Failure`. Each failure contains one typed response error.

Each response error has one message.

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
const client = await ProsodyClient.create({
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
const client = await ProsodyClient.create({
  mode: Mode.LowLatency,
  groupId: "my-consumer-group",
  subscribedTopics: "my-topic",
  failureTopic: "failed-messages", // Required for low-latency mode
  maxRetries: 3, // Retry up to 3 times after the initial attempt
});
```

### Best-Effort Mode

Logs failures and moves on.

- No retries; failed messages are logged and committed
- Fair scheduling still enforces concurrency limits
- Use for development or when message loss is acceptable

```javascript
const client = await ProsodyClient.create({
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
const client = await ProsodyClient.create({
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
const client = await ProsodyClient.create({
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
const client = await ProsodyClient.create({
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
    return null;
  },

  onTimer: async (context, timer, signal) => {
    console.log("Timer fired!");
    console.log(`Key: ${timer.key}`);
    console.log(`Scheduled time: ${timer.time}`);
  },

  onExcise: async () => null,
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
const client = await ProsodyClient.create({
  bootstrapServers: "localhost:9092",
  groupId: "my-application",
  subscribedTopics: "my-topic",
  cassandraNodes: "localhost:9042", // Required unless mock: true
});
```

For testing, you can use mock mode to avoid Cassandra dependency:

```javascript
// Mock mode for testing (timers work but aren't persisted)
const client = await ProsodyClient.create({
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
    return null;
  }

  async onExcise() {
    return null;
  }

  async onTimer() {}
}

const client = await ProsodyClient.create(config);
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
    return null;
  },
  onExcise: async () => null,
  onTimer: async () => {},
};

const client = await ProsodyClient.create(config);
client.subscribe(messageHandler);
```

#### Best Practices for Error Handling

- Use permanent errors for issues like malformed data or business logic violations.
- Use transient errors for temporary issues like network problems.
- Be cautious with permanent errors as they prevent retries and can result in data loss.
- Consider system reliability and data consistency when classifying errors.

## Keyed State

Keyed state gives every Kafka key its own durable working memory. Prosody automatically uses the current message or timer key, so a handler can relate the current event to earlier events for that key. State survives restarts and rebalances. By default, changes become visible only when the event succeeds.

Use keyed state for time-aware stream processing: counters, deduplication, rolling aggregates, pending work, and per-key workflows. Keep your relational database as the source of truth for business data and for work that needs joins or ad hoc queries. Reconstructing stream state with repeated database queries can be slow and expensive; keyed state is built for that job.

Most collections should have a TTL. Set it comfortably beyond the longest timer or workflow that uses the state; Prosody validates the minimum supported TTL. Omit it only when keeping inactive keys forever is intentional.

### Published state

Published state lets another client read a JSON value, map, or deque without subscribing to the owner's topics. Use the same typed definition for the owned collection and its read-only view. The owner sets `published: true`, names its `subsystem`, and registers the definition as usual:

```js
const CURRENT_ORDER = value("current-order", { published: true });
const owner = await ProsodyClient.create({
  ...config,
  subsystem: "checkout",
  stateCollections: [CURRENT_ORDER],
});

// Inside the owner's handler, the event supplies the user key.
const currentOrder = context.state(CURRENT_ORDER);
await currentOrder.set({ sku: "book" });
```

Another client opens a reader by naming the subsystem and passing that same definition. The reader is independent of subscriptions and only returns committed state:

```js
const orderReader = await client.state("checkout", CURRENT_ORDER);
const currentOrder = await orderReader.get("customer-123");
```

Published readers provide the owned collection's read operations without its mutations. An owned handle gets the user key from the current event; a published reader is outside a handler, so every operation takes that key explicitly. Map and deque iteration is asynchronous and reads in chunks rather than loading the entire collection.

The default cache window is five seconds unless the client configuration changes it. Set `readCache: { ttlMs }` on a definition to choose a different freshness window, or `readCache: false` to read durable storage on every operation. To stop publishing a collection, deploy its definition with `published: false` while keeping it registered and retaining `subsystem` for that deployment.

### A counter for each key

Declare each collection once, register it on the client, and ask the event context for the current key's state:

```typescript
const COUNT = value<number>("count", { ttlSeconds: 30 * 24 * 60 * 60 });

const client = await ProsodyClient.create({
  ...config,
  stateCollections: [COUNT],
});

client.subscribe({
  async onMessage(context) {
    const count = context.state(COUNT);
    await count.set(((await count.get()) ?? 0) + 1);
    return null;
  },
  async onExcise() {
    return null;
  },
  async onTimer() {},
});
```

Here, counters expire after 30 days without an update.

### Window activity into one notification

This example turns a burst of activity into two useful notifications. It sends the first event immediately, collects later events for five minutes, then sends one summary. Because the user ID is the Kafka key, every user gets an independent window.

```typescript
const WINDOW = value<boolean>("window", { ttlSeconds: 24 * 60 * 60 });
const PENDING = messageDeque<Activity>("pending", {
  capacity: 100,
  ttlSeconds: 24 * 60 * 60,
});

const handler = {
  async onMessage(context, message) {
    const window = context.state(WINDOW);
    const pending = context.state(PENDING);

    if (await window.get()) {
      await pending.push(message);
      return null;
    }

    await notify(message.key, [message]);
    await window.set(true);
    await context.clearAndSchedule(new Date(Date.now() + 5 * 60_000));
    return null;
  },

  async onTimer(context, timer) {
    const pending = context.state(PENDING);
    const batch: Message<Activity>[] = [];
    for await (const message of pending.values()) batch.push(message);

    if (batch.length > 0) await notify(timer.key, batch);
    await pending.clear();
    await context.state(WINDOW).clear();
  },
  async onExcise() {
    return null;
  },
} satisfies EventHandler<Activity>;
```

See the complete, type-checked example for imports, types, client setup, and `notify`: [`examples/windowing.ts`](examples/windowing.ts).

Why this works:

- Register both definitions in `stateCollections` before subscribing. Keyed state uses Cassandra unless `mock: true`.
- Use `clearAndSchedule`, not `schedule`, so a retried event does not add another timer for the same key.
- `capacity: 100` and the one-day TTL prevent an inactive or unusually busy key from retaining an unlimited backlog. Since this example only pushes, overflow drops the oldest saved message.
- A `messageDeque` requires the original Kafka messages to remain available for the whole window. Use a plain `deque` of payloads if topic retention or compaction cannot guarantee that.
- Prosody runs one handler at a time for each key, so a user's message and timer handlers cannot overlap.
- Sending a notification is outside Prosody's state transaction and may happen again after a retry. Give notifications a stable idempotency key, or send them through an outbox, when duplicates matter.

### Collections and handles

A definition gives a collection a stable name, kind, and options. Register it once on the client, then pass the same definition to `context.state` to access the current key. Do not reuse a persisted name for a different collection kind or payload type.

Create handles inside the handler and do not retain them or their iterators afterward.

| Collection         | JSON payload | Kafka message     | Main operations                                                      |
| ------------------ | ------------ | ----------------- | -------------------------------------------------------------------- |
| Value              | `value<T>`   | `messageValue<P>` | `get`, `set`, `clear`                                                |
| Ordered string map | `map<V>`     | `messageMap<P>`   | `get`, `getMany`, `has`, `set`, `delete`, `entries`, `keys`, `clear` |
| Deque              | `deque<T>`   | `messageDeque<P>` | `push`, `unshift`, `pop`, `shift`, `at`, `length`, `values`, `clear` |

All operations are async. Map and deque scans are async iterables; a `for await` loop may stop early safely. Map keys are strings. `null` and `undefined` mean absence and cannot be stored—use `clear()` or `delete()` instead.

### When changes become visible

Reads inside a handler see its earlier writes. The default behavior is the safest choice for most handlers: Prosody buffers those changes and publishes them together when the event succeeds. If the handler throws, none of its pending changes become visible.

Each collection also offers explicit controls for workflows that need different behavior:

- `readUncommitted: true` writes that collection's changes after the handler succeeds but before the event is recorded as complete. A crash in between can leave the changes visible even though the event is retried. Use it only for idempotent changes, where processing the same event again produces the same stored result.
- `commit()` immediately publishes this collection's pending changes. They remain visible even if the handler later throws and the event is retried.
- `rollback()` discards this collection's pending changes since its last `commit()`. It cannot undo changes that were already committed.

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

Call `flushTelemetry()` to export pending telemetry. Call `shutdownTelemetry()` before the process exits.

### Using Tracing in Your Application

After initializing tracing, you can define spans in your application, and they will be properly propagated through
Kafka:

```javascript
const { ProsodyClient } = require("@prosody-events/prosody");
const opentelemetry = require("@opentelemetry/api");

const tracer = opentelemetry.trace.getTracer("my-service-name");

const client = await ProsodyClient.create({
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
    return null;
  },
  onExcise: async () => null,
  onTimer: async () => {},
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

Shut down the client before your application exits:

```javascript
await client.shutdown();
```

This ensures:

1. Completion and commitment of all in-flight work
2. Quick rebalancing, allowing other consumers to take over partitions
3. Proper release of resources

Implement shutdown handling in your application:

```javascript
const { ProsodyClient } = require("@prosody-events/prosody");

async function main() {
  const client = await ProsodyClient.create({
    groupId: "my-consumer-group",
    subscribedTopics: "my-topic",
  });

  const messageHandler = {
    onMessage: async (context, message, signal) => {
      // Process the message
      return null;
    },
    onExcise: async () => null,
    onTimer: async () => {},
  };

  client.subscribe(messageHandler);

  // Create a promise that resolves when shutdown is signaled
  const shutdownPromise = new Promise((resolve) => {
    const shutdown = async (signal) => {
      console.log(`Received ${signal}. Initiating shutdown...`);
      await client.shutdown();
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
    return null;
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

4. **Testing**: The built binaries are tested on Linux (x86_64 and aarch64) with Node.js 24.

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

- `ProsodyClient.create(config: Configuration): Promise<ProsodyClient>`: Initialize a client without blocking the Node.js event loop.
- `send<P>(topic: string, key: string, payload: P & JsonCompatible<P>, signal?: AbortSignal): Promise<void>`: Send a statically checked JSON-compatible message to a specified
  topic.
- `excise(topic: string, key: string, signal?: AbortSignal): Promise<void>`: Send an excise record for a key.
- `request<R>(topic, key, payload, options): Promise<ReadonlyMap<string, Outcome<R>>>`: Request one response from each subsystem.
- `consumerState: ConsumerState`: Get the current state of the consumer.
- `sourceSystem: string`: Get the source system identifier configured for the client.
- `state<T>(subsystem: string, definition: ValueDefinition<T>): Promise<PublishedValue<T>>`: Open a read-only published value.
- `state<V>(subsystem: string, definition: MapDefinition<V>): Promise<PublishedMap<V>>`: Open a read-only published map.
- `state<T>(subsystem: string, definition: DequeDefinition<T>): Promise<PublishedDeque<T>>`: Open a read-only published deque.
- `subscribe<P = JsonValue, R = JsonValue>(eventHandler: EventHandler<P, R>): Promise<void>`: Subscribe with typed payload and response values.
- `unsubscribe(): Promise<void>`: Stop the consumer. You can subscribe again later.
- `shutdown(): Promise<void>`: Stop all client services. Concurrent and repeated calls await the same operation.

### AdminClient

- `new AdminClient(bootstrapServers)`: Create an admin client for the specified Kafka servers.
- `createTopic(name, partitions, replicationFactor)`: Create a Kafka topic.
- `deleteTopic(name)`: Delete a Kafka topic.

### Telemetry lifecycle

- `flushTelemetry()`: Export pending telemetry.
- `shutdownTelemetry()`: Export pending telemetry and stop its providers.

### EventHandler

Interface for handling messages and timers:

- `EventHandler<P = JsonValue, R = JsonValue>` carries the payload and response types through each callback.
- `onMessage: (context: Context, message: Message<P>, signal: AbortSignal) => Promise<R>`: Handles incoming messages.
- `onExcise: (context: Context, message: Message<null>, signal: AbortSignal) => Promise<R>`: Handles excise records.
- `onTimer: (context: Context, timer: Timer, signal: AbortSignal) => Promise<void>`: Handles timer events.

### Message

Represents a Kafka message with the following properties:

- `topic: string`: The name of the topic.
- `partition: number`: The partition number.
- `offset: bigint`: The message offset within the partition.
- `timestamp: Date`: The timestamp when the message was created or sent.
- `key: string`: The message key.
- `payload: P`: The statically typed message payload.

`Message` takes an optional payload type parameter, `Message<P>`, used by handlers and message-backed state collections to type `payload`. Unparameterized `Message` is `Message<JsonValue>`, preserving useful JSON safety without requiring an application-specific payload type.

`JsonValue` describes arbitrary JSON data. `JsonCompatible<T>` checks a known
application type recursively, so ordinary interfaces work with `send()` while
functions, `undefined`, `Date`, symbols, bigints, and invalid nested fields are
reported by TypeScript before the message reaches the serializer.

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

- `value<T = JsonValue>(name: string, options?: PublishedStateDefinitionOptions): ValueDefinition<T>`
- `map<V = JsonValue>(name: string, options?: MapDefinitionOptions): MapDefinition<V>`
- `deque<T = JsonValue>(name: string, options?: DequeDefinitionOptions): DequeDefinition<T>`
- `messageValue<P = JsonValue>(name: string, options?: StateDefinitionOptions): MessageValueDefinition<P>`
- `messageMap<P = JsonValue>(name: string, options?: MessageMapDefinitionOptions): MessageMapDefinition<P>`
- `messageDeque<P = JsonValue>(name: string, options?: MessageDequeDefinitionOptions): MessageDequeDefinition<P>`

`StateDefinitionOptions`: `{ ttlSeconds?: number; readUncommitted?: boolean }`. `PublishedStateDefinitionOptions` adds `{ published?: boolean; readCache?: { ttlMs: number } | false }` for JSON definitions. Map and deque option types add `keysetLimit` and `capacity`, respectively; their message equivalents omit publication options.

`ValueState<T>`:

- `get(): Promise<T | null>`
- `set(value: T): Promise<void>`
- `clear(): Promise<void>`
- `commit(): Promise<void>`
- `rollback(): Promise<void>`

`MapState<V>` (keys are `string`):

- `get(key: string): Promise<V | null>`
- `getMany(keys: readonly string[]): Promise<(V | null)[]>`
- `has(key: string): Promise<boolean>`
- `set(key: string, value: V): Promise<void>`
- `delete(key: string): Promise<void>`
- `clear(): Promise<void>`
- `entries(direction?: ScanDirection): AsyncIterableIterator<[string, V]>`
- `keys(direction?: ScanDirection): AsyncIterableIterator<string>`
- `values(direction?: ScanDirection): AsyncIterableIterator<V>`
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
- `clear(): Promise<void>`
- `at(index: number): Promise<T | null>`
- `values(direction?: ScanDirection): AsyncIterableIterator<T>`
- `[Symbol.asyncIterator](): AsyncIterableIterator<T>`
- `commit(): Promise<void>`
- `rollback(): Promise<void>`

`ScanDirection`: `"forward" | "backward"`.

Published readers take the user key as their first argument. `PublishedValue<T>` provides `get`. `PublishedMap<V>` provides `get`, `getMany`, `has`, `entries`, `keys`, and `values`. `PublishedDeque<T>` provides `at`, `length`, `isEmpty`, and `values`. The scan methods return `AsyncIterableIterator` directly.

`StateCollectionConfig` (a `stateCollections` entry): `{ name: string; kind: "value" | "map" | "deque"; payload: "json" | "message"; ttlSeconds?: number; readUncommitted?: boolean; published?: boolean; readCache?: { ttlMs: number } | false; keysetLimit?: number; capacity?: number }`. Publication and `readCache` are supported for JSON collections. The definition constructors produce objects assignable to this shape, so prefer them.

Errors:

- `TransientStateError extends TransientError`: the default — a temporary store read/write failure, or any caller mistake (a `null`/unrepresentable write, item-shape mismatch, non-integer deque index, invalid scan direction), rejected transient so it retries rather than discarding the message.
- `PermanentStateError extends PermanentError`: reserved for failures a retry cannot resolve in-process (unregistered/identity-mismatched collection, duplicate registration), or one a handler throws explicitly.
- `isStateError(error: unknown): error is PermanentStateError | TransientStateError`: type-guard narrowing an error to either state error class.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
