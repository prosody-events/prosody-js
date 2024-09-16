# Prosody: JavaScript Bindings for Kafka

Prosody offers JavaScript bindings to the [Prosody Kafka client](https://github.com/RealGeeks/prosody), providing
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

## Installation

```bash
npm install @realgeeks/prosody
```

## Quick Start

```javascript
const {ProsodyClient} = require('@realgeeks/prosody');

// Initialize the client with Kafka bootstrap servers, consumer group, and topics
const client = new ProsodyClient({
    bootstrapServers: "localhost:9092",
    groupId: "my-consumer-group",
    subscribedTopics: "my-topic"
});

// Define a message handler
const messageHandler = {
    onMessage: async (context, message, signal) => {
        // Process the received message
        console.log(`Received message: ${JSON.stringify(message)}`);
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
- `mode` (string): 'pipeline' (default) or 'low-latency'

Additional optional parameters control behavior like message committal, polling intervals, and retry logic. Most
parameters can be set via environment variables (e.g., `PROSODY_BOOTSTRAP_SERVERS`).

Refer to the API documentation for detailed information on all parameters and their default values.

## Advanced Usage

### Pipeline Mode

Pipeline mode is the default mode. Ensures ordered processing, retrying failed operations indefinitely:

```javascript
const {ProsodyClient} = require('@realgeeks/prosody');

// Initialize client in pipeline mode
const client = new ProsodyClient({
    bootstrapServers: "localhost:9092",
    mode: "pipeline",  // Explicitly set pipeline mode (this is the default)
    groupId: "my-consumer-group",
    subscribedTopics: "my-topic"
});

const messageHandler = {
    onMessage: async (context, message, signal) => {
        // Process the message
    }
};

client.subscribe(messageHandler);
```

### Low-Latency Mode

Prioritizes quick processing, sending persistently failing messages to a failure topic:

```javascript
const {ProsodyClient} = require('@realgeeks/prosody');

// Initialize client in low-latency mode
const client = new ProsodyClient({
    bootstrapServers: "localhost:9092",
    mode: "low-latency",  // Set low-latency mode
    groupId: "my-consumer-group",
    subscribedTopics: "my-topic",
    failureTopic: "failed-messages"  // Specify a topic for failed messages
});

const messageHandler = {
    onMessage: async (context, message, signal) => {
        // Process the message
    }
};

client.subscribe(messageHandler);
```

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
const {ProsodyClient} = require('@realgeeks/prosody');
const opentelemetry = require('@opentelemetry/api');

const tracer = opentelemetry.trace.getTracer('my-service-name');

const client = new ProsodyClient({
    bootstrapServers: "localhost:9092",
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
const {ProsodyClient} = require('@realgeeks/prosody');

async function main() {
    const client = new ProsodyClient({
        bootstrapServers: "localhost:9092",
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
-

`subscribe(eventHandler: { onMessage: (context: Context, message: Message, signal: AbortSignal) => Promise<void> }): void`:
Subscribe to messages using the provided handler.

- `unsubscribe(): Promise<void>`: Unsubscribe from messages and shut down the consumer.

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