const { Readable } = require("stream");
const { EventEmitter } = require("events");
const {
  ConsumerState,
  Context,
  ProsodyClient,
  PermanentError,
  TransientError,
  permanent,
  transient,
  value,
  map,
  deque,
  messageValue,
  messageMap,
  messageDeque,
  MapState,
  DequeState,
  PermanentStateError,
  TransientStateError,
  isStateError,
} = require("../index.js");
const { AdminClient } = require("../bindings.js");
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { trace } = require("@opentelemetry/api");
const { Mode } = require("../index");
const opentelemetry = require("@opentelemetry/api");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-proto");

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  serviceName: "prosody-js-test",
});

sdk.start();

// Handle unhandled promise rejections in CI environments
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Don't exit the process in tests, just log the error
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Don't exit the process in tests, just log the error
});

// Creates a tracer from the global tracer provider
const tracer = opentelemetry.trace.getTracer("prosody-js-test");

// Constants
const MESSAGE_TIMEOUT = 30000;
const GROUP_NAME = "test-group";
const SOURCE_NAME = "test-source";
const BOOTSTRAP_SERVERS =
  process.env.PROSODY_BOOTSTRAP_SERVERS || "localhost:9094";
const CASSANDRA_NODES = process.env.PROSODY_CASSANDRA_NODES || "localhost:9042";
const CASSANDRA_KEYSPACE =
  process.env.PROSODY_CASSANDRA_KEYSPACE || "prosody_test";

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
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        stream.removeListener("data", dataHandler);
        reject(new Error(`Timeout waiting for ${count} messages`));
      }
    }, timeout);

    const dataHandler = (message) => {
      if (!resolved) {
        messages.push(message);
        if (messages.length === count) {
          resolved = true;
          clearTimeout(timer);
          stream.removeListener("data", dataHandler);
          resolve(messages);
        }
      }
    };

    stream.on("data", dataHandler);
  });

// Waits for the first observation pushed into an object-mode sink that matches
// `predicate`. Used by the live keyed-state tests that need to key off a
// specific observation rather than a fixed count.
const waitForObservation = (stream, predicate, timeout) =>
  new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        stream.removeListener("data", dataHandler);
        reject(new Error("Timeout waiting for matching observation"));
      }
    }, timeout);
    const dataHandler = (message) => {
      if (!resolved && predicate(message)) {
        resolved = true;
        clearTimeout(timer);
        stream.removeListener("data", dataHandler);
        resolve(message);
      }
    };
    stream.on("data", dataHandler);
  });

// Canonical registered collection set reused by the live keyed-state tests, one
// of every kind × payload. `state()` binds these same frozen definitions.
const STATE_DEFS = {
  cart: value("cart"),
  totals: map("totals", { keysetLimit: 256 }),
  backlog: deque("backlog"),
  lastMsg: messageValue("last-msg"),
  msgIndex: messageMap("msg-index"),
  msgLog: messageDeque("msg-log"),
};
const STATE_COLLECTIONS = Object.values(STATE_DEFS);

// Fresh random token per call — defeats pre-existing Cassandra state so an
// assertion can only pass on a value this test wrote.
const nonce = () => Math.random().toString(36).slice(2);

describe("ProsodyClient", () => {
  let admin;
  let tracer;
  let client;
  let topic;
  let messageStream;

  // Helper methods for timer tests
  const createTimerTestSetup = () => {
    const testEvents = new EventEmitter();
    const timerDelayMs = 2000; // 2 second delay to ensure full second boundaries
    const toleranceMs = 500; // Allow 500ms tolerance
    return { testEvents, timerDelayMs, toleranceMs };
  };

  const createBasicTimerHandler = (
    testEvents,
    customOnMessage = null,
    customOnTimer = null,
  ) => {
    return class TimerHandler {
      async onMessage(context, message) {
        return tracer.startActiveSpan("test.onMessage", async (span) => {
          try {
            testEvents.emit("messageReceived", { context, message });
            if (customOnMessage) {
              await customOnMessage(context, message);
            }
          } finally {
            span.end();
          }
        });
      }

      async onTimer(context, timer) {
        return tracer.startActiveSpan("test.onTimer", async (span) => {
          try {
            testEvents.emit("timerFired", {
              context,
              timer,
              actualTime: new Date(),
            });
            if (customOnTimer) {
              await customOnTimer(context, timer);
            }
          } finally {
            span.end();
          }
        });
      }
    };
  };

  // Builds a client with the canonical state collections registered against the
  // per-test topic, and reassigns the outer `client` so afterEach unsubscribes
  // it. maxConcurrency >= 2 so the async-bridging test can observe interleaving.
  const makeStateClient = () =>
    new ProsodyClient({
      bootstrapServers: BOOTSTRAP_SERVERS,
      groupId: GROUP_NAME,
      sourceSystem: SOURCE_NAME,
      subscribedTopics: topic,
      probePort: null,
      mode: Mode.Pipeline,
      cassandraNodes: CASSANDRA_NODES,
      cassandraKeyspace: CASSANDRA_KEYSPACE,
      stateCollections: STATE_COLLECTIONS,
      maxConcurrency: 4,
    });

  const sendTestMessage = async (key = "timer-test-key") => {
    const testMessage = {
      key,
      payload: { content: "Trigger timer operations" },
    };
    await client.send(topic, testMessage.key, testMessage.payload);
    return testMessage;
  };

  const expectTimerApproximatelyEqual = (
    timerTime,
    expectedTime,
    toleranceMs = 1000,
  ) => {
    // Account for timer precision - round both times to seconds
    const timerSeconds = Math.floor(timerTime.getTime() / 1000);
    const expectedSeconds = Math.floor(expectedTime.getTime() / 1000);
    expect(Math.abs(timerSeconds - expectedSeconds)).toBeLessThanOrEqual(1);
  };

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
          cassandraNodes: CASSANDRA_NODES,
          cassandraKeyspace: CASSANDRA_KEYSPACE,
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
    try {
      if (client && (await client.consumerState()) === ConsumerState.Running) {
        await client.unsubscribe();
      }
    } catch (err) {
      console.error("Error during client cleanup:", err);
    }

    try {
      if (topic) {
        await admin.deleteTopic(topic);
      }
    } catch (err) {
      console.error("Error deleting topic:", err);
    }
  });

  afterAll(async () => {
    try {
      if (admin) {
        // Clean up admin client resources if possible
        admin = null;
      }
    } catch (err) {
      console.error("Error cleaning up admin client:", err);
    }

    try {
      // Wait 6 seconds to allow traces to be exported
      await new Promise((resolve) => setTimeout(resolve, 6000));
      await sdk.shutdown();
    } catch (err) {
      console.error("Error shutting down OpenTelemetry SDK:", err);
    }
  });

  it("initializes correctly", async () => {
    return tracer.startActiveSpan("test.initialize", async (span) => {
      try {
        expect(client).toBeInstanceOf(ProsodyClient);
        expect(await client.consumerState()).toBe(ConsumerState.Configured);
      } finally {
        span.end();
      }
    });
  });

  it("exposes source system identifier", async () => {
    return tracer.startActiveSpan("test.source_system", async (span) => {
      try {
        expect(client.sourceSystem).toBe(SOURCE_NAME);
        expect(typeof client.sourceSystem).toBe("string");
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
          await client.subscribe({
            onMessage: (_, message) => {
              return tracer.startActiveSpan("test.onMessage", async (span) => {
                try {
                  messageStream.push(message);
                } finally {
                  span.end();
                }
              });
            },
          });
          expect(await client.consumerState()).toBe(ConsumerState.Running);

          await client.unsubscribe();
          expect(await client.consumerState()).toBe(ConsumerState.Configured);
        } finally {
          span.end();
        }
      },
    );
  });

  it("sends and receives a message", async () => {
    return tracer.startActiveSpan("test.send_receive", async (span) => {
      try {
        await client.subscribe({
          onMessage: (_, message) => {
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                messageStream.push(message);
              } finally {
                span.end();
              }
            });
          },
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
        await client.subscribe({
          onMessage: (_, message) => {
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                messageStream.push(message);
              } finally {
                span.end();
              }
            });
          },
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

          await client.subscribe({
            onMessage: (context, message, signal) => {
              return tracer.startActiveSpan("test.onMessage", async (span) => {
                try {
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
                } finally {
                  span.end();
                }
              });
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
          expect(await client.consumerState()).toBe(ConsumerState.Configured);
        } finally {
          span.end();
        }
      },
    );
  });

  it("preserves non-Error abort reasons when send rejects", async () => {
    return tracer.startActiveSpan(
      "test.abort_non_error_reason",
      async (span) => {
        try {
          const controller = new AbortController();
          controller.abort("timer cancelled");

          await expect(
            client.send(
              topic,
              "aborted-key",
              { content: "ignored" },
              controller.signal,
            ),
          ).rejects.toEqual(
            expect.objectContaining({ message: "timer cancelled" }),
          );
        } finally {
          span.end();
        }
      },
    );
  });

  it("handles transient errors with retry", async () => {
    return tracer.startActiveSpan("test.transient_error", async (span) => {
      try {
        let messageCount = 0;
        const retryEvent = new EventEmitter();

        class TransientErrorHandler {
          @transient(Error)
          async onMessage(context, message) {
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                messageCount++;
                if (messageCount === 1) {
                  throw new Error("Transient error occurred");
                } else {
                  retryEvent.emit("retry");
                }
              } finally {
                span.end();
              }
            });
          }
        }

        await client.subscribe(new TransientErrorHandler());

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
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                messageCount++;
                errorEvent.emit("error-event");
                throw new Error("Permanent error occurred");
              } finally {
                span.end();
              }
            });
          }
        }

        await client.subscribe(new PermanentErrorHandler());

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

  it("handles explicit permanent errors without retry", async () => {
    return tracer.startActiveSpan(
      "test.explicit_permanent_error",
      async (span) => {
        try {
          let messageCount = 0;
          const errorEvent = new EventEmitter();

          await client.subscribe({
            onMessage: async (context, message) => {
              return tracer.startActiveSpan("test.onMessage", async (span) => {
                try {
                  messageCount++;
                  errorEvent.emit("error-event");
                  throw new PermanentError("Explicit permanent error occurred");
                } finally {
                  span.end();
                }
              });
            },
          });

          await client.send(topic, "test-key", {
            content: "Trigger explicit permanent error",
          });

          await waitForEvent(errorEvent, "error-event", MESSAGE_TIMEOUT);

          // Wait a bit to allow for any potential retries
          await new Promise((resolve) => setTimeout(resolve, 5000));

          expect(messageCount).toBe(1);
        } finally {
          span.end();
        }
      },
    );
  });

  it("schedules and fires timers at correct time", async () => {
    return tracer.startActiveSpan("test.timer_scheduling", async (span) => {
      try {
        const { testEvents, timerDelayMs, toleranceMs } =
          createTimerTestSetup();
        let scheduledTime;

        const TimerHandler = createBasicTimerHandler(
          testEvents,
          async (context, message) => {
            scheduledTime = new Date(Date.now() + timerDelayMs);
            await context.schedule(scheduledTime);
            testEvents.emit("timerScheduled", scheduledTime);
          },
        );

        await client.subscribe(new TimerHandler());
        const testMessage = await sendTestMessage();

        await waitForEvent(testEvents, "messageReceived", MESSAGE_TIMEOUT);
        await waitForEvent(testEvents, "timerScheduled", MESSAGE_TIMEOUT);

        expect(scheduledTime).toBeDefined();

        const [timerResult] = await waitForEvent(
          testEvents,
          "timerFired",
          timerDelayMs + 5000,
        );
        const { timer, actualTime } = timerResult;

        expect(timer.key).toBe(testMessage.key);
        expectTimerApproximatelyEqual(timer.time, scheduledTime);
        expectTimerApproximatelyEqual(actualTime, scheduledTime, toleranceMs);
      } finally {
        span.end();
      }
    });
  });

  it("clears and reschedules timers correctly", async () => {
    return tracer.startActiveSpan("test.clear_and_schedule", async (span) => {
      try {
        const { testEvents, timerDelayMs } = createTimerTestSetup();
        let firstScheduledTime;
        let secondScheduledTime;
        let timerCount = 0;

        const TimerHandler = createBasicTimerHandler(
          testEvents,
          async (context, message) => {
            // Schedule first timer (4 seconds from now)
            firstScheduledTime = new Date(Date.now() + timerDelayMs * 2);
            await context.schedule(firstScheduledTime);
            testEvents.emit("firstTimerScheduled");

            // Clear and schedule a new timer (2 seconds from now - sooner)
            secondScheduledTime = new Date(Date.now() + timerDelayMs);
            await context.clearAndSchedule(secondScheduledTime);
            testEvents.emit("secondTimerScheduled");
          },
          async (context, timer) => {
            timerCount++;
            testEvents.emit("timerFired", { timer, timerCount });
          },
        );

        await client.subscribe(new TimerHandler());
        await sendTestMessage();

        await waitForEvent(testEvents, "firstTimerScheduled", MESSAGE_TIMEOUT);
        await waitForEvent(testEvents, "secondTimerScheduled", MESSAGE_TIMEOUT);

        // Wait for timer to fire - only the second one should fire
        const [timerResult] = await waitForEvent(
          testEvents,
          "timerFired",
          timerDelayMs + 5000,
        );
        const { timer } = timerResult;

        expect(timerCount).toBe(1); // Only one timer should have fired
        expectTimerApproximatelyEqual(timer.time, secondScheduledTime);
      } finally {
        span.end();
      }
    });
  });

  it("unschedules specific timers", async () => {
    return tracer.startActiveSpan("test.unschedule", async (span) => {
      try {
        const { testEvents, timerDelayMs } = createTimerTestSetup();
        let firstScheduledTime;
        let secondScheduledTime;
        let timerCount = 0;

        // Use different keys to avoid upsert behavior, and ensure full second separation
        const TimerHandler = createBasicTimerHandler(
          testEvents,
          async (context, message) => {
            // Schedule two timers with different times (2 and 4 seconds from now)
            firstScheduledTime = new Date(Date.now() + timerDelayMs); // 2 seconds
            secondScheduledTime = new Date(Date.now() + timerDelayMs * 2); // 4 seconds

            await context.schedule(firstScheduledTime);
            await context.schedule(secondScheduledTime);
            testEvents.emit("timersScheduled");

            // Unschedule the first timer
            await context.unschedule(firstScheduledTime);
            testEvents.emit("firstTimerUnscheduled");
          },
          async (context, timer) => {
            timerCount++;
            testEvents.emit("timerFired", { timer, timerCount });
          },
        );

        await client.subscribe(new TimerHandler());
        await sendTestMessage();

        await waitForEvent(testEvents, "timersScheduled", MESSAGE_TIMEOUT);
        await waitForEvent(
          testEvents,
          "firstTimerUnscheduled",
          MESSAGE_TIMEOUT,
        );

        // Wait for remaining timer to fire (should be the second one)
        const maxWaitTime = timerDelayMs * 2 + 5000;
        const [timerResult] = await waitForEvent(
          testEvents,
          "timerFired",
          maxWaitTime,
        );
        const { timer } = timerResult;

        expect(timerCount).toBe(1); // Only second timer should fire
        expectTimerApproximatelyEqual(timer.time, secondScheduledTime);
      } finally {
        span.end();
      }
    });
  });

  it("clears all scheduled timers", async () => {
    return tracer.startActiveSpan("test.clear_scheduled", async (span) => {
      try {
        const { testEvents, timerDelayMs } = createTimerTestSetup();
        let timerCount = 0;

        const TimerHandler = createBasicTimerHandler(
          testEvents,
          async (context, message) => {
            // Schedule multiple timers with full second separation
            // Each timer is for a different second, so all would normally be kept
            // But we'll clear them all to test clearScheduled()
            const time1 = new Date(Date.now() + timerDelayMs); // 2 seconds
            const time2 = new Date(Date.now() + timerDelayMs + 1000); // 3 seconds
            const time3 = new Date(Date.now() + timerDelayMs + 2000); // 4 seconds

            await context.schedule(time1);
            await context.schedule(time2);
            await context.schedule(time3);
            testEvents.emit("timersScheduled");

            // Clear all timers
            await context.clearScheduled();
            testEvents.emit("allTimersCleared");
          },
          async (context, timer) => {
            timerCount++;
            testEvents.emit("timerFired");
          },
        );

        await client.subscribe(new TimerHandler());
        await sendTestMessage();

        await waitForEvent(testEvents, "timersScheduled", MESSAGE_TIMEOUT);
        await waitForEvent(testEvents, "allTimersCleared", MESSAGE_TIMEOUT);

        // Wait longer than all timers would have fired
        await new Promise((resolve) =>
          setTimeout(resolve, timerDelayMs + 3000),
        );

        expect(timerCount).toBe(0); // No timers should have fired
      } finally {
        span.end();
      }
    });
  });

  it("retrieves scheduled timer times", async () => {
    return tracer.startActiveSpan("test.scheduled", async (span) => {
      try {
        const { testEvents, timerDelayMs } = createTimerTestSetup();
        let scheduledTimes;

        const TimerHandler = createBasicTimerHandler(
          testEvents,
          async (context, message) => {
            // Schedule multiple timers with full second separation
            // Since each timer is for a different second, all should be kept
            // (timers are keyed by message key + time rounded to seconds)
            const time1 = new Date(Date.now() + timerDelayMs); // 2 seconds
            const time2 = new Date(Date.now() + timerDelayMs + 1000); // 3 seconds
            const time3 = new Date(Date.now() + timerDelayMs + 2000); // 4 seconds

            await context.schedule(time1);
            await context.schedule(time2);
            await context.schedule(time3);

            // Get scheduled times
            scheduledTimes = await context.scheduled();
            testEvents.emit("scheduledRetrieved", {
              scheduledTimes,
              expectedTimes: [time1, time2, time3],
            });
          },
        );

        await client.subscribe(new TimerHandler());
        await sendTestMessage();

        const [retrievalResult] = await waitForEvent(
          testEvents,
          "scheduledRetrieved",
          MESSAGE_TIMEOUT,
        );
        const { scheduledTimes: retrievedTimes, expectedTimes } =
          retrievalResult;

        // All scheduled timers should be returned
        expect(retrievedTimes).toHaveLength(3);

        // Sort both arrays for comparison (scheduled() might return in different order)
        const sortedRetrieved = retrievedTimes.sort(
          (a, b) => a.getTime() - b.getTime(),
        );
        const sortedExpected = expectedTimes.sort(
          (a, b) => a.getTime() - b.getTime(),
        );

        sortedExpected.forEach((expectedTime, index) => {
          expectTimerApproximatelyEqual(sortedRetrieved[index], expectedTime);
        });
      } finally {
        span.end();
      }
    });
  });

  it("resolves onCancel for each message (no promise accumulation)", async () => {
    return tracer.startActiveSpan("test.oncancel_per_message", async (span) => {
      try {
        const testEvents = new EventEmitter();
        let onCancelCount = 0;
        let messageCount = 0;
        const numMessages = 5;

        await client.subscribe({
          onMessage: async (context, message, signal) => {
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                messageCount++;

                // Track when onCancel resolves for this message
                context.onCancel().then(() => {
                  onCancelCount++;
                  if (onCancelCount === numMessages) {
                    testEvents.emit("allCancelsResolved");
                  }
                });

                // Complete handler normally
                messageStream.push(message);
                if (messageCount === numMessages) {
                  testEvents.emit("allMessagesProcessed");
                }
              } finally {
                span.end();
              }
            });
          },
        });

        // Send multiple messages
        for (let i = 0; i < numMessages; i++) {
          await client.send(topic, `key-${i}`, { content: `Message ${i}` });
        }

        // Wait for all messages to be processed
        await waitForEvent(testEvents, "allMessagesProcessed", MESSAGE_TIMEOUT);

        // Give time for onCancel promises to resolve
        await waitForEvent(testEvents, "allCancelsResolved", MESSAGE_TIMEOUT);

        // All onCancel promises should have resolved (one per message)
        expect(onCancelCount).toBe(numMessages);
      } finally {
        span.end();
      }
    });
  });

  it("demonstrates upsert behavior for timers at same time", async () => {
    return tracer.startActiveSpan("test.timer_upsert", async (span) => {
      try {
        const { testEvents, timerDelayMs } = createTimerTestSetup();
        let scheduledTimes;
        let timerCount = 0;

        class TimerHandler {
          async onMessage(context, message) {
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                testEvents.emit("messageReceived", { context, message });

                // Schedule multiple timers at the exact same time (same second)
                // Due to upsert behavior (one timer per key per second), only one should remain
                const sameTime = new Date(Date.now() + timerDelayMs);

                await context.schedule(sameTime);
                await context.schedule(sameTime); // This should replace the first one
                await context.schedule(sameTime); // This should replace the second one

                // Get scheduled times to verify only one remains
                scheduledTimes = await context.scheduled();
                testEvents.emit("scheduledRetrieved", {
                  scheduledTimes,
                  expectedTime: sameTime,
                });
              } finally {
                span.end();
              }
            });
          }

          async onTimer(context, timer) {
            return tracer.startActiveSpan("test.onTimer", async (span) => {
              try {
                timerCount++;
                testEvents.emit("timerFired", { timer, timerCount });
              } finally {
                span.end();
              }
            });
          }
        }

        await client.subscribe(new TimerHandler());
        await sendTestMessage();

        const [retrievalResult] = await waitForEvent(
          testEvents,
          "scheduledRetrieved",
          MESSAGE_TIMEOUT,
        );
        const { scheduledTimes: retrievedTimes, expectedTime } =
          retrievalResult;

        // Due to upsert behavior, only one timer should remain
        expect(retrievedTimes).toHaveLength(1);
        expectTimerApproximatelyEqual(retrievedTimes[0], expectedTime);

        // Wait for the timer to fire
        const [timerResult] = await waitForEvent(
          testEvents,
          "timerFired",
          timerDelayMs + 5000,
        );

        // Only one timer should have fired due to upsert behavior
        expect(timerResult.timerCount).toBe(1);
      } finally {
        span.end();
      }
    });
  });

  describe("configuration validation", () => {
    it("accepts valid messageSpans and timerSpans values", () => {
      expect(
        () =>
          new ProsodyClient({
            bootstrapServers: BOOTSTRAP_SERVERS,
            groupId: GROUP_NAME,
            sourceSystem: SOURCE_NAME,
            subscribedTopics: "test-topic",
            mock: true,
            messageSpans: "child",
            timerSpans: "follows_from",
          }),
      ).not.toThrow();
    });

    it("rejects invalid messageSpans with field name in error", () => {
      expect(
        () =>
          new ProsodyClient({
            bootstrapServers: BOOTSTRAP_SERVERS,
            groupId: GROUP_NAME,
            sourceSystem: SOURCE_NAME,
            subscribedTopics: "test-topic",
            mock: true,
            messageSpans: "invalid",
          }),
      ).toThrow(/message_spans/);
    });

    it("rejects invalid timerSpans with field name in error", () => {
      expect(
        () =>
          new ProsodyClient({
            bootstrapServers: BOOTSTRAP_SERVERS,
            groupId: GROUP_NAME,
            sourceSystem: SOURCE_NAME,
            subscribedTopics: "test-topic",
            mock: true,
            timerSpans: "invalid",
          }),
      ).toThrow(/timer_spans/);
    });
  });

  // Live keyed-state FFI scenarios (Appendix 1). Each test registers the
  // canonical collections via makeStateClient(), drives real Kafka + Cassandra,
  // and pushes observation objects into messageStream. State is per message key,
  // so multi-event scenarios drive two sends with the SAME key. Every handler
  // wraps its work in try/catch that reports {tag:"error"} so a throw never
  // silently hangs the wait — except where a throw is the intended stimulus.
  describe("keyed state", () => {
    // C1 — Value FFI boundary: a JSON payload marshals through set -> get
    // byte-identical (a rich nested value: unicode, numbers, booleans, arrays,
    // a NESTED null), and an absent value reads as JS `null` (the erased
    // `Option::None` -> `null` mapping). Cross-event PERSISTENCE and clear
    // SEMANTICS are the collection's job (covered in core); this asserts only
    // the boundary marshalling + the null mapping.
    it("value marshals a JSON payload faithfully and reads absent as null", async () => {
      const K = nonce();
      const rich = {
        s: "café 😀",
        n: 3.5,
        b: true,
        arr: [1, "x", null],
        nested: { z: [true, 2] },
      };
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const c = ctx.state(STATE_DEFS.cart);
          try {
            const before = await c.get(); // never written -> null
            await c.set(rich);
            const after = await c.get(); // read-your-writes -> the marshalled value
            messageStream.push({ before, after });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, K, { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      expect(obs.before).toBeNull();
      // The serde bridge round-trips the whole value, nested null included.
      expect(obs.after).toEqual(rich);
    });

    // C2 — Map FFI boundary: keys (including unicode) and values marshal through
    // set/get, an absent key reads as `null`, and `entries()` yields
    // `[key, value]` pairs over the native cursor. Key ORDERING (forward /
    // backward) is a collection concern covered in core; this asserts pair
    // marshalling + membership only (compared as a set, never a sequence).
    it("map marshals keys (incl. unicode) and values, and entries() yields pairs", async () => {
      const K = nonce();
      const entriesIn = { k1: 1, café: 9, "😀": 7 };
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const m = ctx.state(STATE_DEFS.totals);
          try {
            for (const [k, v] of Object.entries(entriesIn)) await m.set(k, v);
            const collected = [];
            for await (const entry of m.entries()) collected.push(entry);
            messageStream.push({
              collected,
              k1: await m.get("k1"),
              cafe: await m.get("café"),
              emoji: await m.get("😀"),
              absent: await m.get(nonce()),
            });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, K, { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      // point reads marshal keys + values faithfully; absent -> null
      expect(obs.k1).toBe(1);
      expect(obs.cafe).toBe(9);
      expect(obs.emoji).toBe(7);
      expect(obs.absent).toBeNull();
      // entries() yields each [key, value] pair over the cursor (set-equality —
      // ordering is core's), and every entry is a [string, value] tuple.
      expect(obs.collected).toEqual(
        expect.arrayContaining(Object.entries(entriesIn)),
      );
      expect(obs.collected).toHaveLength(Object.keys(entriesIn).length);
      for (const entry of obs.collected) {
        expect(Array.isArray(entry)).toBe(true);
        expect(typeof entry[0]).toBe("string");
      }
    });

    // C3 — Deque FFI boundary: elements (rich JSON) marshal through push ->
    // values()/get, `values()` iterates over the native cursor, and pop/shift on
    // an empty deque read as `null` (the `Option::None` -> `null` mapping).
    // Element ORDERING, which end a pop removes, and length COUNTING are
    // collection concerns covered in core; this asserts boundary marshalling +
    // cursor iteration + the null mapping (membership compared as a set).
    it("deque marshals elements through the cursor and reads empty as null", async () => {
      const Dfull = nonce();
      const Dempty = nonce();
      const items = ["a", { v: 1 }, [2, "😀"]];
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const d = ctx.state(STATE_DEFS.backlog);
          try {
            if (msg.key === Dfull) {
              for (const it of items) await d.push(it);
              const collected = [];
              for await (const x of d.values()) collected.push(x);
              messageStream.push({
                tag: "full",
                collected,
                head: await d.get(0), // some marshalled element (not asserting which)
                popped: await d.pop(), // a marshalled element
              });
            } else if (msg.key === Dempty) {
              messageStream.push({
                tag: "empty",
                pf: await d.shift(),
                pb: await d.pop(),
              });
            }
          } catch (e) {
            messageStream.push({ tag: "error", error: e.message });
          }
        },
      });

      await client.send(topic, Dfull, { go: true });
      await client.send(topic, Dempty, { go: true });
      const obs = await waitForMessages(messageStream, 2, MESSAGE_TIMEOUT);
      const byTag = Object.fromEntries(obs.map((o) => [o.tag, o]));
      expect(byTag.error).toBeUndefined();

      // values() yields the pushed elements faithfully over the cursor
      // (set-equality — order is core's), including nested/rich JSON.
      expect(byTag.full.collected).toEqual(expect.arrayContaining(items));
      expect(byTag.full.collected).toHaveLength(items.length);
      // get(0)/pop() return marshalled elements that were among those pushed.
      expect(items).toContainEqual(byTag.full.head);
      expect(items).toContainEqual(byTag.full.popped);
      // empty deque: Option::None -> null across the boundary.
      expect(byTag.empty.pf).toBeNull();
      expect(byTag.empty.pb).toBeNull();
    });

    // C4 — Message collection (messageValue): record the handled message in
    // event1, read it back in event2, observing topic/partition/offset/key/
    // payload equal to the original.
    it("messageValue stores the handled message and reads it back intact", async () => {
      const MK = nonce();
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const lm = ctx.state(STATE_DEFS.lastMsg);
          try {
            if (msg.payload.step === 1) {
              await lm.set(msg);
              messageStream.push({
                tag: "orig",
                topic: msg.topic,
                partition: msg.partition,
                offset: msg.offset.toString(),
                key: msg.key,
                payload: msg.payload,
              });
            } else if (msg.payload.step === 2) {
              const got = await lm.get();
              messageStream.push({
                tag: "got",
                topic: got.topic,
                partition: got.partition,
                offset: got.offset.toString(),
                key: got.key,
                payload: got.payload,
              });
            }
          } catch (e) {
            messageStream.push({ tag: "error", error: e.message });
          }
        },
      });

      await client.send(topic, MK, { step: 1 });
      await client.send(topic, MK, { step: 2 });
      const obs = await waitForMessages(messageStream, 2, MESSAGE_TIMEOUT);
      const byTag = Object.fromEntries(obs.map((o) => [o.tag, o]));
      expect(byTag.error).toBeUndefined();

      const orig = { ...byTag.orig };
      const got = { ...byTag.got };
      delete orig.tag;
      delete got.tag;
      // the stored item is event1's ORIGINAL message; its offset differs from
      // event2's, so equality proves the store returned the recorded message.
      expect(got).toEqual(orig);
      expect(orig.payload).toEqual({ step: 1 });
    });

    // C4b — Message collection (messageDeque): same-event push -> get(0) -> scan
    // round-trips the full Message.
    it("messageDeque round-trips the full message through push/get/scan", async () => {
      const MD = nonce();
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const dl = ctx.state(STATE_DEFS.msgLog);
          try {
            await dl.push(msg);
            const head = await dl.get(0);
            const scanned = [];
            for await (const m of dl.values("forward")) scanned.push(m);
            messageStream.push({
              orig: {
                topic: msg.topic,
                partition: msg.partition,
                offset: msg.offset.toString(),
                key: msg.key,
                payload: msg.payload,
              },
              head: {
                topic: head.topic,
                partition: head.partition,
                offset: head.offset.toString(),
                key: head.key,
                payload: head.payload,
              },
              scannedLen: scanned.length,
              scannedFirstPayload: scanned[0].payload,
            });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, MD, { marker: MD });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      expect(obs.head).toEqual(obs.orig);
      expect(obs.scannedLen).toBe(1);
      expect(obs.scannedFirstPayload).toEqual({ marker: MD });
    });

    // C4c — Message collection (messageMap): record the handled message under
    // string keys in event1; a later event with the same key gets/scans it back
    // with topic/partition/offset/key/payload intact. Covers the map x message
    // combination (the one canonical kind x payload pairing C4/C4b leave
    // unexercised) and the distinct messageMapState vend + conversion branch.
    it("messageMap round-trips the full message under string keys across events", async () => {
      const MM = nonce();
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const mi = ctx.state(STATE_DEFS.msgIndex);
          try {
            if (msg.payload.step === 1) {
              await mi.set("primary", msg);
              await mi.set("café", msg);
              messageStream.push({
                tag: "orig",
                topic: msg.topic,
                partition: msg.partition,
                offset: msg.offset.toString(),
                key: msg.key,
                payload: msg.payload,
              });
            } else if (msg.payload.step === 2) {
              const got = await mi.get("primary");
              const cafe = await mi.get("café");
              const missing = await mi.get("absent");
              const scannedKeys = [];
              for await (const [k] of mi.entries("forward"))
                scannedKeys.push(k);
              messageStream.push({
                tag: "got",
                topic: got.topic,
                partition: got.partition,
                offset: got.offset.toString(),
                key: got.key,
                payload: got.payload,
                cafePayload: cafe.payload,
                missing,
                scannedKeys,
              });
            }
          } catch (e) {
            messageStream.push({ tag: "error", error: e.message });
          }
        },
      });

      await client.send(topic, MM, { step: 1 });
      await client.send(topic, MM, { step: 2 });
      const obs = await waitForMessages(messageStream, 2, MESSAGE_TIMEOUT);
      const byTag = Object.fromEntries(obs.map((o) => [o.tag, o]));
      expect(byTag.error).toBeUndefined();

      const orig = { ...byTag.orig };
      delete orig.tag;
      const got = {
        topic: byTag.got.topic,
        partition: byTag.got.partition,
        offset: byTag.got.offset,
        key: byTag.got.key,
        payload: byTag.got.payload,
      };
      // event2's message carries a distinct offset, so equality proves the map
      // returned event1's RECORDED message rather than the live one.
      expect(got).toEqual(orig);
      expect(orig.payload).toEqual({ step: 1 });
      // the unicode key round-trips and maps to the same stored message.
      expect(byTag.got.cafePayload).toEqual({ step: 1 });
      // an absent key reads as null.
      expect(byTag.got.missing).toBeNull();
      // forward scan yields both string keys in ascending key order.
      expect(byTag.got.scannedKeys).toEqual([...byTag.got.scannedKeys].sort());
      expect(byTag.got.scannedKeys).toContain("primary");
      expect(byTag.got.scannedKeys).toContain("café");
    });

    // C5a — commit(): the committed floor survives an attempt that subsequently
    // fails; a fresh handle on redelivery observes it.
    it("commit floor survives a failed attempt and is visible on retry", async () => {
      const V = nonce();
      let attempt = 0;
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          attempt += 1;
          const c = ctx.state(STATE_DEFS.cart);
          if (attempt === 1) {
            await c.set({ v: V });
            await c.commit();
            throw new TransientStateError("fail after commit");
          }
          messageStream.push({ attempt, got: await c.get() });
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.attempt).toBe(2);
      expect(obs.got).toEqual({ v: V });
    });

    // C5b — rollback(): discards uncommitted ops back to the committed floor.
    it("rollback discards uncommitted writes back to the committed floor", async () => {
      const A = nonce();
      const B = nonce();
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const c = ctx.state(STATE_DEFS.cart);
          try {
            await c.set({ v: A });
            await c.commit();
            await c.set({ v: B });
            const before = await c.get();
            await c.rollback();
            const after = await c.get();
            messageStream.push({ before: before.v, after: after.v });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      expect(obs.before).toBe(B);
      expect(obs.after).toBe(A);
    });

    // C5c — commit()/rollback() on a MAP handle exercise the distinct native
    // BoxMapState commit/rollback branch (C5a/C5b only reach ValueState). A
    // committed entry survives a rollback that discards a later uncommitted one.
    it("map commit floor survives a rollback of later uncommitted writes", async () => {
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const m = ctx.state(STATE_DEFS.totals);
          try {
            await m.set("kept", 1);
            await m.commit();
            await m.set("kept", 2);
            await m.set("dropped", 9);
            const before = {
              kept: await m.get("kept"),
              dropped: await m.get("dropped"),
            };
            await m.rollback();
            const after = {
              kept: await m.get("kept"),
              dropped: await m.get("dropped"),
            };
            messageStream.push({ before, after });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      // before rollback: the uncommitted overwrite and insert are both visible.
      expect(obs.before).toEqual({ kept: 2, dropped: 9 });
      // after rollback: reverts to the committed floor — kept=1, dropped gone.
      expect(obs.after).toEqual({ kept: 1, dropped: null });
    });

    // C6a — a state op from a handle LEAKED past a failed attempt fails with the
    // terminated (transient) error, and the failed attempt's uncommitted write
    // is not visible on retry.
    it("a handle leaked across a failed attempt rejects transient and leaves no state", async () => {
      const bad = nonce();
      let attempt = 0;
      let leaked = null;
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          attempt += 1;
          const c = ctx.state(STATE_DEFS.cart);
          if (attempt === 1) {
            leaked = c;
            await c.set({ v: bad });
            throw new TransientStateError("fail attempt 1");
          }
          // attempt 2: catch-and-report so the expected leaked rejection never
          // escapes the handler and re-triggers retry.
          let leakedOutcome;
          try {
            leakedOutcome = { status: "resolved", value: await leaked.get() };
          } catch (e) {
            leakedOutcome = {
              status: "rejected",
              transient: e instanceof TransientStateError,
            };
          }
          messageStream.push({ leakedOutcome, fresh: await c.get() });
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.leakedOutcome.status).toBe("rejected");
      expect(obs.leakedOutcome.transient).toBe(true);
      expect(obs.fresh).toBeNull();
    });

    // C6b — a leaked CONTEXT binding a fresh collection after the attempt fails
    // also fails (a leaked context cannot mint a working handle).
    it("a context leaked across a failed attempt cannot bind a working handle", async () => {
      let attempt = 0;
      let leakedCtx = null;
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          attempt += 1;
          if (attempt === 1) {
            leakedCtx = ctx;
            throw new TransientStateError("fail attempt 1");
          }
          let result;
          try {
            const m = leakedCtx.state(STATE_DEFS.totals);
            result = { status: "resolved", value: await m.get("x") };
          } catch (e) {
            result = {
              status: "rejected",
              transient: e instanceof TransientStateError,
              stateError: isStateError(e),
            };
          }
          messageStream.push(result);
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.status).toBe("rejected");
      expect(obs.stateError).toBe(true);
      expect(obs.transient).toBe(true);
    });

    // C6c — a leaked read after a SUCCESSFUL handler also fails (no post-handler
    // read window). A second SAME-KEY sentinel message guarantees, via per-key
    // serialization, that the first event fully tore down before we call the
    // leaked handle from the test body.
    it("a handle leaked past a successful handler rejects transient", async () => {
      const K = nonce();
      let leaked = null;
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          try {
            if (msg.payload.step === 1) {
              leaked = ctx.state(STATE_DEFS.cart);
              await leaked.set({ v: nonce() });
              messageStream.push({ ev: "captured" });
              return;
            }
            if (msg.payload.step === 2) {
              messageStream.push({ ev: "sentinel-started" });
              return;
            }
          } catch (e) {
            messageStream.push({ ev: "error", error: e.message });
          }
        },
      });

      await client.send(topic, K, { step: 1 });
      await waitForObservation(
        messageStream,
        (o) => o.ev === "captured",
        MESSAGE_TIMEOUT,
      );
      await client.send(topic, K, { step: 2 });
      await waitForObservation(
        messageStream,
        (o) => o.ev === "sentinel-started",
        MESSAGE_TIMEOUT,
      );

      await expect(leaked.get()).rejects.toBeInstanceOf(TransientStateError);
    });

    // C7a — early break from an iterator does not wedge later access on the same
    // collection (integration-level; GREEN-IS-CORRECT — the strong close
    // assertion is the fake-cursor unit test). A follow-up op succeeds.
    it("breaking out of a scan leaves the collection usable", async () => {
      const K = nonce();
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const m = ctx.state(STATE_DEFS.totals);
          try {
            await m.set("a", 1);
            await m.set("b", 2);
            await m.set("c", 3);
            // eslint-disable-next-line no-unused-vars
            for await (const _entry of m.entries()) break;
            await m.set("after", 99);
            messageStream.push({ ok: (await m.get("after")) === 99 });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, K, { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      expect(obs.ok).toBe(true);
    });

    // C8a — binding an unregistered name rejects PermanentStateError at vend.
    it("binding an unregistered collection name throws PermanentStateError", async () => {
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          let result;
          try {
            ctx.state(value("never-registered-" + nonce()));
            result = { permanent: false, threw: false };
          } catch (e) {
            result = {
              threw: true,
              permanent: e instanceof PermanentStateError,
            };
          }
          messageStream.push(result);
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.threw).toBe(true);
      expect(obs.permanent).toBe(true);
    });

    // C8b — an invalid scan-direction token is a caller mistake, rejected
    // TransientStateError (retry, stay visible, never discard the message).
    it("an invalid scan direction throws TransientStateError", async () => {
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const m = ctx.state(STATE_DEFS.totals);
          let result;
          try {
            m.entries("sideways");
            result = { threw: false };
          } catch (e) {
            result = {
              threw: true,
              transient: e instanceof TransientStateError,
              msg: e.message,
            };
          }
          messageStream.push(result);
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.threw).toBe(true);
      expect(obs.transient).toBe(true);
      expect(obs.msg).toMatch(/forward.*backward/);
    });

    // C8c-permanent — a rethrown PermanentStateError classifies permanent
    // through the EXISTING bridge (no retry).
    it("rethrowing a PermanentStateError classifies permanent (no retry)", async () => {
      let count = 0;
      const errorEvent = new EventEmitter();
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          count += 1;
          errorEvent.emit("handled");
          throw new PermanentStateError("permanent state boom");
        },
      });

      await client.send(topic, nonce(), { go: true });
      await waitForEvent(errorEvent, "handled", MESSAGE_TIMEOUT);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      expect(count).toBe(1);
    });

    // C8c-transient — a rethrown TransientStateError classifies transient
    // through the EXISTING bridge (retries, never surfaces terminal).
    it("rethrowing a TransientStateError classifies transient (retries)", async () => {
      let count = 0;
      const retryEvent = new EventEmitter();
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          count += 1;
          if (count === 1) {
            throw new TransientStateError("transient state later");
          }
          retryEvent.emit("retry");
        },
      });

      await client.send(topic, nonce(), { go: true });
      await waitForEvent(retryEvent, "retry", MESSAGE_TIMEOUT);
      expect(count).toBe(2);
    });

    // C10a — set(null)/push(null) are caller mistakes: they reject
    // TransientStateError (retry, stay visible, never discard) and leave the
    // store untouched. The value message names clear() as the way to delete.
    it("null-item writes reject transient and leave the store untouched", async () => {
      const V = nonce();
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const c = ctx.state(STATE_DEFS.cart);
          const d = ctx.state(STATE_DEFS.backlog);
          try {
            await c.set({ v: V });
            await c.commit();

            let valueOutcome;
            try {
              await c.set(null);
              valueOutcome = { transient: false, threw: false };
            } catch (e) {
              valueOutcome = {
                threw: true,
                transient: e instanceof TransientStateError,
                msg: e.message,
              };
            }

            let dequeOutcome;
            try {
              await d.push(null);
              dequeOutcome = { transient: false, threw: false };
            } catch (e) {
              dequeOutcome = {
                threw: true,
                transient: e instanceof TransientStateError,
              };
            }

            messageStream.push({
              valueOutcome,
              dequeOutcome,
              after: (await c.get()).v,
            });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      expect(obs.valueOutcome.threw).toBe(true);
      expect(obs.valueOutcome.transient).toBe(true);
      expect(obs.valueOutcome.msg).toMatch(/clear/);
      expect(obs.dequeOutcome.threw).toBe(true);
      expect(obs.dequeOutcome.transient).toBe(true);
      expect(obs.after).toBe(V);
    });

    // C10c — a value with no JSON representation is a CALLER MISTAKE, rejected
    // TRANSIENT at the FFI boundary (retry, stay visible, never discard the
    // message — discarding it would lose data; see CLAUDE.md). Core never
    // receives the value, so the glue owns the classification: it captures the
    // failed conversion and re-raises a transient-tagged error on the async
    // promise-rejection path where the category `cause` survives. Covers the
    // top-level kinds (a bare `undefined`, a bare function) and the nested kinds
    // the serde bridge rejects rather than drops (a function nested in an
    // object; `undefined` as an array element). (A nested `undefined` OBJECT
    // property is the one exception — it is dropped, matching `JSON.stringify` —
    // so it is not exercised here.)
    const unrepresentable = [
      ["a bare undefined", undefined],
      ["a bare function", () => 1],
      ["a function nested in an object", { v: () => 1, keep: 1 }],
      ["undefined as an array element", [1, undefined, 2]],
    ];
    it.each(unrepresentable)(
      "rejects an unrepresentable write (%s) transient, not permanent",
      async (_label, bad) => {
        const V = nonce();
        client = makeStateClient();
        await client.subscribe({
          onMessage: async (ctx, msg) => {
            const c = ctx.state(STATE_DEFS.cart);
            try {
              await c.set({ v: V });
              await c.commit();

              let outcome;
              try {
                await c.set(bad);
                outcome = { threw: false };
              } catch (e) {
                outcome = {
                  threw: true,
                  permanent: e instanceof PermanentStateError,
                  transient: e instanceof TransientStateError,
                };
              }

              messageStream.push({ outcome, after: (await c.get()).v });
            } catch (e) {
              messageStream.push({ error: e.message });
            }
          },
        });

        await client.send(topic, nonce(), { go: true });
        const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
        expect(obs.error).toBeUndefined();
        expect(obs.outcome.threw).toBe(true);
        expect(obs.outcome.transient).toBe(true);
        expect(obs.outcome.permanent).toBe(false);
        // The rejected write left the committed value untouched.
        expect(obs.after).toBe(V);
      },
    );

    // C11 — Tracing (item 12), GREEN-IS-CORRECT. In-process JS cannot observe
    // the Rust collection span (separate OTLP pipeline), so this asserts only
    // that (a) a state op inside an active JS span resolves and (b) the JS event
    // context is active during the op. End-to-end span parentage
    // (core collection span -> per-op span -> event span) is verified at the
    // collector, not here.
    it("a state op runs under the active JS trace context (smoke)", async () => {
      const V = nonce();
      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          await tracer.startActiveSpan("test.state_op", async (span) => {
            try {
              const c = ctx.state(STATE_DEFS.cart);
              await c.set({ v: V });
              const got = await c.get();
              messageStream.push({
                got,
                activeSpan: opentelemetry.trace.getActiveSpan() !== undefined,
              });
            } finally {
              span.end();
            }
          });
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.got).toEqual({ v: V });
      expect(obs.activeSpan).toBe(true);
    });

    // C12 — Async bridging (item 13): while one handler is blocked awaiting a
    // barrier, a handler for a DIFFERENT key on the SAME partition makes
    // progress (the event loop / native bridge is not serialized). Two keys are
    // forced onto one partition by probing.
    it("a blocked handler does not block a different key on the same partition", async () => {
      // Probe: send 5 keys through the beforeEach client, collect partitions,
      // pick two distinct keys on the SAME partition (guaranteed with 5 keys /
      // 4 partitions).
      const probeStream = createMessageStream();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          probeStream.push({ key: msg.key, partition: msg.partition });
        },
      });
      const probeKeys = [0, 1, 2, 3, 4].map((i) => `probe-${nonce()}-${i}`);
      for (const k of probeKeys) await client.send(topic, k, { probe: true });
      const probes = await waitForMessages(probeStream, 5, MESSAGE_TIMEOUT);
      await client.unsubscribe();

      const seen = {};
      let keyA = null;
      let keyB = null;
      for (const p of probes) {
        if (seen[p.partition] !== undefined) {
          keyA = seen[p.partition];
          keyB = p.key;
          break;
        }
        seen[p.partition] = p.key;
      }
      expect(keyA).not.toBeNull();
      expect(keyB).not.toBeNull();

      let release;
      const gate = new Promise((r) => (release = r));
      let aStarted = false;
      let aFinished = false;
      const events = new EventEmitter();

      client = makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          if (msg.key === keyA) {
            aStarted = true;
            events.emit("A-blocked");
            try {
              await gate;
            } finally {
              aFinished = true;
            }
            events.emit("A-done");
            return;
          }
          if (msg.key === keyB) {
            events.emit("B-done", { aStarted, aFinished });
          }
        },
      });

      try {
        await client.send(topic, keyA, { n: 1 });
        await waitForEvent(events, "A-blocked", MESSAGE_TIMEOUT);
        await client.send(topic, keyB, { n: 2 });
        const [bInfo] = await waitForEvent(events, "B-done", MESSAGE_TIMEOUT);
        expect(bInfo.aStarted).toBe(true);
        expect(bInfo.aFinished).toBe(false);
      } finally {
        release();
      }
      await waitForEvent(events, "A-done", MESSAGE_TIMEOUT);
    });
  });
});

const waitForEvent = (emitter, eventName, timeout) => {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        emitter.removeListener(eventName, eventHandler);
        reject(new Error(`Timeout waiting for ${eventName}`));
      }
    }, timeout);

    const eventHandler = (...args) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(args);
      }
    };

    emitter.once(eventName, eventHandler);
  });
};

// Infra-free unit tests over the real state classes driven by FAKE native
// handles. These are the STRONG home for cursor-lifecycle and argument-typing
// targets that are only green-is-correct at the integration level (a released
// permit masks a missing close between pulls).
describe("keyed state (unit)", () => {
  // A gated cursor whose close() blocks until releaseClose() — lets a test prove
  // that return() AWAITS the native close().
  const makeGatedCursor = () => {
    let releaseClose;
    const closeGate = new Promise((r) => (releaseClose = r));
    const counts = { closed: 0, nextCalls: 0 };
    return {
      cursor: {
        async next() {
          counts.nextCalls += 1;
          return ["k" + counts.nextCalls, counts.nextCalls];
        },
        async close() {
          counts.closed += 1;
          await closeGate;
        },
      },
      releaseClose: () => releaseClose(),
      closedCount: () => counts.closed,
    };
  };

  // A finite cursor that yields `items` then null (exhausted), closing on
  // exhaustion.
  const makeFiniteCursor = (items) => {
    let i = 0;
    const counts = { closed: 0 };
    return {
      cursor: {
        async next() {
          return i < items.length ? items[i++] : null;
        },
        async close() {
          counts.closed += 1;
        },
      },
      closedCount: () => counts.closed,
    };
  };

  // A1 — return() (early break) awaits the native close() exactly once.
  it("iterator return() awaits the native cursor close exactly once", async () => {
    const fake = makeGatedCursor();
    const m = new MapState({ scan: () => fake.cursor });
    const it = m.entries();
    await it.next();

    const ret = it.return();
    let settled = false;
    ret.then(() => {
      settled = true;
    });
    // Yield the microtask queue: return() must still be pending on close().
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fake.closedCount()).toBe(1);

    fake.releaseClose();
    await ret;
    expect(fake.closedCount()).toBe(1);
  });

  // A2 — exhaustion maps native null -> done and closes the cursor once.
  it("iterator exhaustion ends the loop and closes the cursor", async () => {
    const fake = makeFiniteCursor([
      ["a", "v1"],
      ["b", "v2"],
    ]);
    const m = new MapState({ scan: () => fake.cursor });
    const collected = [];
    for await (const v of m.values()) collected.push(v);
    expect(collected).toEqual(["v1", "v2"]);
    expect(fake.closedCount()).toBe(1);
  });

  // A3 — a pull error closes the cursor, wraps to the typed state error, and
  // finishes the iterator (no further pulls).
  it("iterator pull error closes, wraps to a state error, and finishes", async () => {
    const counts = { closed: 0 };
    const cursor = {
      async next() {
        const e = new Error("scan boom");
        e.cause = new Error("transient");
        throw e;
      },
      async close() {
        counts.closed += 1;
      },
    };
    const m = new MapState({ scan: () => cursor });
    const it = m.entries();
    await expect(it.next()).rejects.toBeInstanceOf(TransientStateError);
    expect(counts.closed).toBe(1);
    await expect(it.next()).resolves.toEqual({ value: undefined, done: true });
  });

  // A4 — error classes carry category as data and subclass the existing bridge
  // hierarchy so a rethrow classifies with no state-specific bridge path.
  it("state error classes carry category and subclass the bridge hierarchy", () => {
    expect(new PermanentStateError("x").isPermanent).toBe(true);
    expect(new TransientStateError("x").isPermanent).toBe(false);
    expect(new PermanentStateError("x")).toBeInstanceOf(PermanentError);
    expect(new TransientStateError("x")).toBeInstanceOf(TransientError);
    expect(isStateError(new PermanentStateError("x"))).toBe(true);
    expect(isStateError(new TransientStateError("x"))).toBe(true);
    expect(isStateError(new Error("x"))).toBe(false);
  });

  // A5 — DequeState.get rejects a fractional or negative index as a caller
  // mistake (TransientStateError — retry, never discard; Appendix-2 deque-index
  // row; the native u32 conversion would otherwise truncate/wrap).
  it("deque get rejects a fractional or negative index but allows valid ones", async () => {
    const d = new DequeState({ get: async () => 99 });
    await expect(d.get(1.5)).rejects.toBeInstanceOf(TransientStateError);
    await expect(d.get(1.5)).rejects.toThrow(/index/);
    await expect(d.get(-1)).rejects.toBeInstanceOf(TransientStateError);
    await expect(d.get(2)).resolves.toBe(99);
    await expect(d.get(2 ** 32)).rejects.toBeInstanceOf(TransientStateError);
    // A hostile non-number (Symbol) must REJECT, not throw synchronously while
    // building the diagnostic — get() is declared to return a Promise.
    await expect(d.get(Symbol("x"))).rejects.toBeInstanceOf(TransientStateError);
  });

  // A6 — a malformed definition (bad kind/payload/name) is a caller mistake:
  // Context.state() rejects it TRANSIENT (never permanent), before touching the
  // native context, so a typo never silently vends the wrong collection.
  it("state() rejects a malformed definition as a transient error", () => {
    const ctx = new Context({}); // native never reached — validation precedes vend
    expect(() =>
      ctx.state({ name: "x", kind: "bogus", payload: "json" }),
    ).toThrow(TransientStateError);
    expect(() =>
      ctx.state({ name: "x", kind: "value", payload: "bogus" }),
    ).toThrow(TransientStateError);
    expect(() =>
      ctx.state({ name: "", kind: "value", payload: "json" }),
    ).toThrow(TransientStateError);
    // A non-string name that JSON.stringify cannot serialize (BigInt) must still
    // yield TransientStateError, not a raw TypeError from building the message.
    expect(() =>
      ctx.state({ name: 1n, kind: "value", payload: "json" }),
    ).toThrow(TransientStateError);
  });
});

// Infra-free config-validation tests: state-collection rules run synchronously
// at client construction (mock:true), so an invalid definition THROWS from the
// constructor with the offending field named in the message.
describe("keyed state configuration validation", () => {
  const makeConfig = (overrides) => ({
    bootstrapServers: BOOTSTRAP_SERVERS,
    groupId: GROUP_NAME,
    sourceSystem: SOURCE_NAME,
    subscribedTopics: "t",
    mock: true,
    ...overrides,
  });

  // A valid mock:true client spins up a mock cluster that logs its startup
  // asynchronously; drain it before teardown so the log does not fire after the
  // test module is torn down (mirrors the ProsodyClient afterAll drain).
  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  });

  it("rejects an empty collection name", () => {
    expect(
      () => new ProsodyClient(makeConfig({ stateCollections: [value("")] })),
    ).toThrow(/name: must not be empty/);
  });

  it("rejects a duplicate collection name", () => {
    expect(
      () =>
        new ProsodyClient(
          makeConfig({ stateCollections: [value("dup"), map("dup")] }),
        ),
    ).toThrow(/duplicate collection name/);
  });

  it("rejects ttlSeconds of zero", () => {
    expect(
      () =>
        new ProsodyClient(
          makeConfig({ stateCollections: [value("v", { ttlSeconds: 0 })] }),
        ),
    ).toThrow(/ttlSeconds/);
  });

  // Regression: ttlSeconds arrives as f64, so a sub-second value reaches the
  // whole-number guard instead of being truncated toward zero by a u32
  // coercion. 0.5 (truncates to 0) and 2.5 (would truncate to 2) both throw.
  it.each([0.5, 2.5, 3.9])("rejects fractional ttlSeconds %p", (ttlSeconds) => {
    expect(
      () =>
        new ProsodyClient(
          makeConfig({ stateCollections: [value("v", { ttlSeconds })] }),
        ),
    ).toThrow(/ttlSeconds: must be a whole number/);
  });

  // Regression: a negative ttlSeconds used to ToUint32-wrap to ~4.29e9 and
  // evade the `== 0` guard, silently registering a ~136-year TTL. It must now
  // throw a field-named error rather than being accepted.
  it.each([-1, -5])("rejects negative ttlSeconds %p", (ttlSeconds) => {
    expect(
      () =>
        new ProsodyClient(
          makeConfig({ stateCollections: [value("v", { ttlSeconds })] }),
        ),
    ).toThrow(/ttlSeconds: must be a whole number/);
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite ttlSeconds %p",
    (ttlSeconds) => {
      expect(
        () =>
          new ProsodyClient(
            makeConfig({ stateCollections: [value("v", { ttlSeconds })] }),
          ),
      ).toThrow(/ttlSeconds: must be a whole number/);
    },
  );

  // The u32::MAX boundary is a valid whole second and must be accepted.
  it("accepts ttlSeconds at the u32 ceiling", () => {
    expect(
      () =>
        new ProsodyClient(
          makeConfig({
            stateCollections: [value("v", { ttlSeconds: 4294967295 })],
          }),
        ),
    ).not.toThrow();
  });

  it("rejects ttlSeconds above the u32 ceiling", () => {
    expect(
      () =>
        new ProsodyClient(
          makeConfig({
            stateCollections: [value("v", { ttlSeconds: 4294967296 })],
          }),
        ),
    ).toThrow(/ttlSeconds: must be a whole number/);
  });

  it("rejects keysetLimit above the ceiling", () => {
    expect(
      () =>
        new ProsodyClient(
          makeConfig({ stateCollections: [map("m", { keysetLimit: 5000 })] }),
        ),
    ).toThrow(/keysetLimit: must be a whole number in 0..=4096/);
  });

  // Regression: a fractional keysetLimit used to truncate (2.5 -> 2) and be
  // silently accepted; it must now throw.
  it.each([2.5, -1, NaN, Infinity])(
    "rejects non-whole keysetLimit %p",
    (keysetLimit) => {
      expect(
        () =>
          new ProsodyClient(
            makeConfig({ stateCollections: [map("m", { keysetLimit })] }),
          ),
      ).toThrow(/keysetLimit: must be a whole number/);
    },
  );

  // keysetLimit 0 disables ordered-scan tracking and is a valid whole number.
  it("accepts keysetLimit of zero", () => {
    expect(
      () =>
        new ProsodyClient(
          makeConfig({ stateCollections: [map("m", { keysetLimit: 0 })] }),
        ),
    ).not.toThrow();
  });

  it("rejects keysetLimit on a non-map collection", () => {
    expect(
      () =>
        new ProsodyClient(
          makeConfig({ stateCollections: [value("v", { keysetLimit: 5 })] }),
        ),
    ).toThrow(/keysetLimit: only valid for map/);
  });

  it("rejects an unknown kind token", () => {
    expect(
      () =>
        new ProsodyClient(
          makeConfig({
            stateCollections: [{ name: "x", kind: "bogus", payload: "json" }],
          }),
        ),
    ).toThrow(/kind: expected/);
  });

  it("rejects an unknown payload token", () => {
    expect(
      () =>
        new ProsodyClient(
          makeConfig({
            stateCollections: [{ name: "x", kind: "value", payload: "bogus" }],
          }),
        ),
    ).toThrow(/payload: expected/);
  });

  it("rejects stateDefaultTtlSeconds of zero", () => {
    expect(
      () => new ProsodyClient(makeConfig({ stateDefaultTtlSeconds: 0 })),
    ).toThrow(/stateDefaultTtlSeconds/);
  });

  // Regression: stateDefaultTtlSeconds arrives as f64, so negative and
  // fractional values reach the whole-number guard instead of wrapping or
  // truncating through a u32 coercion.
  it.each([-1, 2.5, NaN, Infinity])(
    "rejects non-whole stateDefaultTtlSeconds %p",
    (stateDefaultTtlSeconds) => {
      expect(
        () => new ProsodyClient(makeConfig({ stateDefaultTtlSeconds })),
      ).toThrow(/stateDefaultTtlSeconds: must be a whole number/);
    },
  );

  it("rejects stateRecoveryDelaySeconds of zero", () => {
    expect(
      () => new ProsodyClient(makeConfig({ stateRecoveryDelaySeconds: 0 })),
    ).toThrow(/stateRecoveryDelaySeconds/);
  });

  // Regression: same f64 boundary hazard as stateDefaultTtlSeconds.
  it.each([-1, 2.5, NaN, Infinity])(
    "rejects non-whole stateRecoveryDelaySeconds %p",
    (stateRecoveryDelaySeconds) => {
      expect(
        () => new ProsodyClient(makeConfig({ stateRecoveryDelaySeconds })),
      ).toThrow(/stateRecoveryDelaySeconds: must be a whole number/);
    },
  );

  it("accepts the full canonical collection set", () => {
    expect(
      () =>
        new ProsodyClient(makeConfig({ stateCollections: STATE_COLLECTIONS })),
    ).not.toThrow();
  });
});
