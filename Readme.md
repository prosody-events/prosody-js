# Prosody: JavaScript Bindings for Kafka

Prosody offers JavaScript bindings to the [Prosody Kafka client](https://github.com/cincpro/prosody), providing
features for message production and consumption, including configurable retry mechanisms, failure handling
strategies, and integrated OpenTelemetry support for distributed tracing.

## Features

- Rust-powered Kafka client
- Message production and consumption support
- Configurable modes: pipeline and low-latency
- OpenTelemetry integration for distributed tracing
- Efficient parallel processing with key-based ordering
- Intelligent partition pausing for backpressure management
- Mock Kafka broker support for testing
- Event type filtering for selectively processing messages
- Source system tracking to prevent message processing loops

## Installation

```bash
npm install @cincpro/prosody
```

## Quick Start

```javascript
const {ProsodyClient} = require('@cincpro/prosody');

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
    subscribedTopics: "my-topic"
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
    }
};

// Subscribe to messages using the message handler
client.subscribe(messageHandler);

// Send a message to a topic
await client.send("my-topic", "message-key", {content: "Hello, Kafka!"});

// Ensure proper shutdown when done
await client.unsubscribe();
```

## Architecture

Prosody enables efficient, parallel processing of Kafka messages while maintaining order for messages with the same key:

- **Partition-Level Parallelism**: Separate management of each Kafka partition
- **Key-Based Queuing**: Ordered processing for each key within a partition
- **Concurrent Processing**: Simultaneous processing of different keys
- **Backpressure Management**: Pause consumption from backed-up partitions

## Configuration

The `ProsodyClient` constructor accepts these key parameters:

- `bootstrapServers` (string | string[]): Kafka bootstrap servers (required)
- `groupId` (string): Consumer group ID (required for consumption)
- `subscribedTopics` (string | string[]): Topics to subscribe to (required for consumption)
- `sourceSystem` (string): Identifier for the producing system to prevent loops (defaults to groupId)
- `allowedEvents` (string | string[]): Prefixes of event types to process (processes all if unspecified)
- `mode` (string): 'pipeline' (default) or 'low-latency'

Additional optional parameters control behavior like message committal, polling intervals, and retry logic. Most
parameters can be set via environment variables (e.g., `PROSODY_BOOTSTRAP_SERVERS`).

Refer to the API documentation for detailed information on all parameters and their default values.

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
    probePort: 8000,  // Set to null to disable
    stallThresholdMs: 15000  // 15 seconds before considering a partition stalled
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
    console.warn('Consumer has stalled partitions');
}
```

## Advanced Usage

### Pipeline Mode

Pipeline mode is the default mode. Ensures ordered processing, retrying failed operations indefinitely:

```javascript
const client = new ProsodyClient({
    mode: Mode.Pipeline,  // Explicitly set pipeline mode (this is the default)
    groupId: "my-consumer-group",
    subscribedTopics: "my-topic"
});
```

### Low-Latency Mode

Prioritizes quick processing, sending persistently failing messages to a failure topic:

```javascript
const client = new ProsodyClient({
    mode: Mode.LowLatency,  // Set low-latency mode
    groupId: "my-consumer-group",
    subscribedTopics: "my-topic",
    failureTopic: "failed-messages"  // Specify a topic for failed messages
});
```

### Best-Effort Mode

Optimized for development environments or services where message processing failures are acceptable:

```javascript
const client = new ProsodyClient({
    mode: Mode.BestEffort,  // Set best-effort mode
    groupId: "my-consumer-group",
    subscribedTopics: "my-topic"
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
    allowedEvents: ["user.", "account."]
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
    sourceSystem: "my-service-producer",  // Must differ from groupId to allow loopbacks; defaults to groupId
    subscribedTopics: "my-topic"
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

```javascript
// Messages with IDs are deduplicated per key
await client.send("my-topic", "key1", {
    id: "msg-123",      // Message will be processed
    content: "Hello!"
});

await client.send("my-topic", "key1", {
    id: "msg-123",      // Message will be skipped (duplicate)
    content: "Hello again!"
});

await client.send("my-topic", "key2", {
    id: "msg-123",      // Message will be processed (different key)
    content: "Hello!"
});
```

Deduplication can be disabled by setting:

```javascript
const client = new ProsodyClient({
    groupId: "my-consumer-group",
    subscribedTopics: "my-topic",
    idempotenceCacheSize: 0  // Disable deduplication
});
```

Or via environment variable:

```bash
PROSODY_IDEMPOTENCE_CACHE_SIZE=0
```

Note that this deduplication is best-effort and not guaranteed. Because identifiers are cached ephemerally in memory,
duplicates can still occur when instances rebalance or restart.

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
        console.log('Timer fired!');
        console.log(`Key: ${timer.key}`);
        console.log(`Scheduled time: ${timer.time}`);
    }
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
    cassandraNodes: "localhost:9042"  // Required unless mock: true
});
```

For testing, you can use mock mode to avoid Cassandra dependency:

```javascript
// Mock mode for testing (timers work but aren't persisted)
const client = new ProsodyClient({
    bootstrapServers: "localhost:9092",
    groupId: "my-application",
    subscribedTopics: "my-topic",
    mock: true  // No Cassandra required in mock mode
});
```

### Error Handling

Prosody classifies errors as transient (temporary, can be retried) or permanent (won't be resolved by retrying). By
default, all errors are considered transient.

#### Using Decorators

If you're using TypeScript or a JavaScript environment that supports decorators, you can use the `@permanent` decorator
to classify exceptions that should not be retried:

```javascript
import {permanent, ProsodyClient} from '@cincpro/prosody';

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
import {PermanentError, ProsodyClient} from '@cincpro/prosody';

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
    }
};

const client = new ProsodyClient(config);
client.subscribe(messageHandler);
```

#### Best Practices for Error Handling

- Use permanent errors for issues like malformed data or business logic violations.
- Use transient errors for temporary issues like network problems.
- Be cautious with permanent errors as they prevent retries and can result in data loss.
- Consider system reliability and data consistency when classifying errors.

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
const opentelemetry = require('@opentelemetry/api');
const {NodeSDK} = require('@opentelemetry/sdk-node');
const {OTLPTraceExporter} = require('@opentelemetry/exporter-trace-otlp-http');

const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    serviceName: 'my-service-name',
});

sdk.start();

// Creates a tracer from the global tracer provider
const tracer = opentelemetry.trace.getTracer('my-service-name');
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
const {ProsodyClient} = require('@cincpro/prosody');
const opentelemetry = require('@opentelemetry/api');

const tracer = opentelemetry.trace.getTracer('my-service-name');

const client = new ProsodyClient({
    groupId: "my-consumer-group",
    subscribedTopics: "my-topic"
});

const messageHandler = {
    onMessage: async (context, message, signal) => {
        const span = tracer.startSpan('process-message');
        try {
            // Process the received message
            console.log(`Received message: ${JSON.stringify(message)}`);
        } finally {
            span.end();
        }
    }
};

client.subscribe(messageHandler);
```

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
const {ProsodyClient} = require('@cincpro/prosody');

async function main() {
    const client = new ProsodyClient({
        groupId: "my-consumer-group",
        subscribedTopics: "my-topic"
    });

    const messageHandler = {
        onMessage: async (context, message, signal) => {
            // Process the message
        }
    };

    client.subscribe(messageHandler);

    // Create a promise that resolves when shutdown is signaled
    const shutdownPromise = new Promise((resolve) => {
        const shutdown = async (signal) => {
            console.log(`Received ${signal}. Initiating shutdown...`);
            await client.unsubscribe();
            resolve();
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGHUP', () => shutdown('SIGHUP'));
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
        const response = await fetch('https://api.example.com', {signal});
        const data = await response.json();

        // Pass the signal to database operations
        await db.query('INSERT INTO messages (payload) VALUES ($1)', [message.payload], {signal});

        // Process the data...

        // Send a message, passing the abort signal
        await client.send('topic', 'key', {data: 'value'}, signal);
    }
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
    - Linux builds for x86_64, aarch64, and armv7 architectures (both glibc and musl variants).
    - Windows build for x64 and aarch64 architectures.
    - macOS builds for x86_64 and aarch64 architectures.
    - Universal macOS binary creation.

4. **Testing**: The built binaries are tested on various platforms and Node.js versions:
    - Linux x64 (glibc and musl) with Node.js 18 and 20
    - Linux aarch64 (glibc and musl) with Node.js LTS
    - Linux armv7 (gnueabihf) with Node.js 18 and 20

5. **Artifact Upload**: Each build job uploads its artifacts (Node.js native addons) to GitHub Actions.

6. **Publication**: If all builds and tests are successful, the final step publishes the package to the GitHub Packages
   registry.

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

Remember, all releases are automatically published to the GitHub Packages registry. Ensure you have thoroughly tested
your changes before merging to `main`.

## API Reference

### ProsodyClient

- `constructor(config: Configuration)`: Initialize a new ProsodyClient with the given configuration.
- `send(topic: string, key: string, payload: any, signal?: AbortSignal): Promise<void>`: Send a message to a specified
  topic.
- `consumerState: ConsumerState`: Get the current state of the consumer.
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
- `offset: number`: The message offset within the partition.
- `timestamp: Date`: The timestamp when the message was created or sent.
- `key: string`: The message key.
- `payload: any`: The message payload as a JSON-serializable value.

### Context

Represents the context of message processing:

- `onShutdown(): Promise<void>`: A method that resolves when the context should shut down.
- `shouldShutdown: boolean`: A property indicating whether the context should shut down.

Timer scheduling methods:

- `schedule(time: Date): Promise<void>`: Schedules a timer to fire at the specified time
- `clearAndSchedule(time: Date): Promise<void>`: Clears all timers and schedules a new one
- `unschedule(time: Date): Promise<void>`: Removes a timer scheduled for the specified time
- `clearScheduled(): Promise<void>`: Removes all scheduled timers
- `scheduled(): Promise<Date[]>`: Returns an array of all scheduled timer times

### Timer

Represents a timer that has fired, provided to the `onTimer` method:

- `key: string`: The entity key identifying what this timer belongs to
- `time: Date`: The time when this timer was scheduled to fire
