const { Readable } = require("stream");
const { EventEmitter } = require("events");
const {
  ConsumerState,
  ProsodyClient,
  permanent,
  transient,
} = require("../index.js");
const { AdminClient } = require("../bindings.js");
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { trace } = require("@opentelemetry/api");
const { Mode } = require("../index");
const opentelemetry = require("@opentelemetry/api");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-http");

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  serviceName: "prosody-js-test",
});

sdk.start();

// Creates a tracer from the global tracer provider
const tracer = opentelemetry.trace.getTracer("prosody-js-test");

// Constants
const MESSAGE_TIMEOUT = 5000;
const GROUP_NAME = "test-group";
const SOURCE_NAME = "test-source";
const BOOTSTRAP_SERVERS =
  process.env.PROSODY_BOOTSTRAP_SERVERS || "localhost:9094";

// Helper functions
const generateTopicName = () =>
  `test-topic-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

const createMessageStream = () =>
  new Readable({
    objectMode: true,
    read() {},
  });

const waitForMessages = (stream, count, timeout) =>
  new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${count} messages`)),
      timeout,
    );

    const dataHandler = (message) => {
      messages.push(message);
      if (messages.length === count) {
        clearTimeout(timer);
        stream.removeListener("data", dataHandler);
        resolve(messages);
      }
    };

    stream.on("data", dataHandler);
  });

describe("ProsodyClient", () => {
  let admin;
  let tracer;
  let client;
  let topic;
  let messageStream;

  beforeAll(async () => {
    tracer = trace.getTracer("prosody-js-test");
    admin = new AdminClient(BOOTSTRAP_SERVERS);
  });

  beforeEach(async () => {
    topic = generateTopicName();
    await admin.createTopic(topic, 4, 1);

    for (let i = 0; i < 5; i++) {
      try {
        client = new ProsodyClient({
          bootstrapServers: BOOTSTRAP_SERVERS,
          groupId: GROUP_NAME,
          sourceSystem: SOURCE_NAME,
          subscribedTopics: topic,
          probePort: null,
          mode: Mode.Pipeline,
        });
        break;
      } catch (err) {
        if (i >= 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    messageStream = createMessageStream();
  });

  afterEach(async () => {
    if (client.consumerState === ConsumerState.Running) {
      await client.unsubscribe();
      await admin.deleteTopic(topic);
    }
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  it("initializes correctly", () => {
    return tracer.startActiveSpan("test.initialize", async (span) => {
      try {
        expect(client).toBeInstanceOf(ProsodyClient);
        expect(client.consumerState).toBe(ConsumerState.Configured);
      } finally {
        span.end();
      }
    });
  });

  it("subscribes and unsubscribes", async () => {
    return tracer.startActiveSpan(
      "test.subscribe_unsubscribe",
      async (span) => {
        try {
          client.subscribe({
            onMessage: (_, message) => messageStream.push(message),
          });
          expect(client.consumerState).toBe(ConsumerState.Running);

          await client.unsubscribe();
          expect(client.consumerState).toBe(ConsumerState.Configured);
        } finally {
          span.end();
        }
      },
    );
  });

  it("sends and receives a message", async () => {
    return tracer.startActiveSpan("test.send_receive", async (span) => {
      try {
        client.subscribe({
          onMessage: (_, message) => messageStream.push(message),
        });

        const testMessage = {
          key: "test-key",
          payload: { content: "Hello, Kafka!" },
        };

        await client.send(topic, testMessage.key, testMessage.payload);

        const [receivedMessage] = await waitForMessages(
          messageStream,
          1,
          MESSAGE_TIMEOUT,
        );

        expect(receivedMessage.topic).toBe(topic);
        expect(receivedMessage.key).toBe(testMessage.key);
        expect(receivedMessage.payload).toEqual(testMessage.payload);
      } finally {
        span.end();
      }
    });
  });

  it("handles multiple messages with correct ordering", async () => {
    return tracer.startActiveSpan("test.multiple_messages", async (span) => {
      try {
        client.subscribe({
          onMessage: (_, message) => messageStream.push(message),
        });

        const messagesToSend = [
          { key: "key1", payload: { content: "Message 1", sequence: 1 } },
          { key: "key2", payload: { content: "Message 2", sequence: 1 } },
          { key: "key1", payload: { content: "Message 3", sequence: 2 } },
          { key: "key3", payload: { content: "Message 4", sequence: 1 } },
          { key: "key2", payload: { content: "Message 5", sequence: 2 } },
        ];

        for (const msg of messagesToSend) {
          await client.send(topic, msg.key, msg.payload);
        }

        const receivedMessages = await waitForMessages(
          messageStream,
          messagesToSend.length,
          MESSAGE_TIMEOUT,
        );

        expect(receivedMessages).toHaveLength(messagesToSend.length);

        const groupMessagesByKey = (messages) =>
          messages.reduce((acc, msg) => {
            if (!acc[msg.key]) acc[msg.key] = [];
            acc[msg.key].push(msg);
            return acc;
          }, {});

        const sentMessagesByKey = groupMessagesByKey(messagesToSend);
        const receivedMessagesByKey = groupMessagesByKey(receivedMessages);

        expect(Object.keys(sentMessagesByKey)).toEqual(
          expect.arrayContaining(Object.keys(receivedMessagesByKey)),
        );

        Object.keys(sentMessagesByKey).forEach((key) => {
          const sentMessages = sentMessagesByKey[key];
          const receivedMessages = receivedMessagesByKey[key];

          expect(receivedMessages).toHaveLength(sentMessages.length);

          sentMessages.forEach((sent, index) => {
            expect(receivedMessages[index].payload).toEqual(sent.payload);
          });
        });

        Object.values(receivedMessagesByKey).forEach((messages) => {
          const sequences = messages.map((msg) => msg.payload.sequence);
          expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
        });

        receivedMessages.forEach((msg) => {
          expect(msg.topic).toBe(topic);
        });
      } finally {
        span.end();
      }
    });
  });

  it("supports abort controller in onMessage handler", async () => {
    await tracer.startActiveSpan(
      "test.abort_controller_onMessage",
      async (span) => {
        try {
          const testEvents = new EventEmitter();
          let messageAborted = false;

          client.subscribe({
            onMessage: (context, message, signal) => {
              const result = new Promise((resolve) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    messageAborted = true;
                    testEvents.emit("processingAborted", message);
                    resolve();
                  },
                  { once: true },
                );
              });

              testEvents.emit("processingStarted", message);
              return result;
            },
          });

          await client.send(topic, "hanging-key", {
            content: "I will hang until aborted",
          });

          await waitForEvent(testEvents, "processingStarted", MESSAGE_TIMEOUT);
          const unsubscribePromise = client.unsubscribe();
          await waitForEvent(testEvents, "processingAborted", MESSAGE_TIMEOUT);
          await unsubscribePromise;

          expect(messageAborted).toBe(true);
          expect(client.consumerState).toBe(ConsumerState.Configured);
        } finally {
          span.end();
        }
      },
    );
  });

  it("handles abort signal in send method", async () => {
    return tracer.startActiveSpan("test.send_abort_signal", async (span) => {
      try {
        const abortController = new AbortController();
        const testEvents = new EventEmitter();
        let messageReceived = false;

        const testMessage = {
          key: "abort-test-key",
          payload: { content: "This message should be aborted" },
        };

        client.subscribe({
          onMessage: (_, message) => {
            messageReceived = true;
            testEvents.emit("messageReceived", message);
          },
        });

        // Abort the controller immediately to ensure the send operation is aborted
        abortController.abort();

        const sendPromise = client.send(
          topic,
          testMessage.key,
          testMessage.payload,
          abortController.signal,
        );

        await expect(sendPromise).rejects.toThrow("Abort signal received");
      } finally {
        span.end();
      }
    });
  });

  it("handles transient errors with retry", async () => {
    return tracer.startActiveSpan("test.transient_error", async (span) => {
      try {
        let messageCount = 0;
        const retryEvent = new EventEmitter();

        class TransientErrorHandler {
          @transient(Error)
          async onMessage(context, message) {
            messageCount++;
            if (messageCount === 1) {
              throw new Error("Transient error occurred");
            } else {
              retryEvent.emit("retry");
            }
          }
        }

        client.subscribe(new TransientErrorHandler());

        await client.send(topic, "test-key", {
          content: "Trigger transient error",
        });

        await waitForEvent(retryEvent, "retry", MESSAGE_TIMEOUT);
      } finally {
        span.end();
      }
    });
  });

  it("handles permanent errors without retry", async () => {
    return tracer.startActiveSpan("test.permanent_error", async (span) => {
      try {
        let messageCount = 0;
        const errorEvent = new EventEmitter();

        class PermanentErrorHandler {
          @permanent(Error)
          async onMessage(_, message) {
            messageCount++;
            errorEvent.emit("error-event");
            throw new Error("Permanent error occurred");
          }
        }

        client.subscribe(new PermanentErrorHandler());

        await client.send(topic, "test-key", {
          content: "Trigger permanent error",
        });

        await waitForEvent(errorEvent, "error-event", MESSAGE_TIMEOUT);

        // Wait a bit to allow for any potential retries
        await new Promise((resolve) => setTimeout(resolve, 5000));

        expect(messageCount).toBe(1);
      } finally {
        span.end();
      }
    });
  });
});

const waitForEvent = (emitter, eventName, timeout) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${eventName}`));
    }, timeout);

    emitter.once(eventName, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
};
