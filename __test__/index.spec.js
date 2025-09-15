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
        testEvents.emit("messageReceived", { context, message });
        if (customOnMessage) {
          await customOnMessage(context, message);
        }
      }

      async onTimer(context, timer) {
        testEvents.emit("timerFired", {
          context,
          timer,
          actualTime: new Date(),
        });
        if (customOnTimer) {
          await customOnTimer(context, timer);
        }
      }
    };
  };

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
            onMessage: (_, message) => messageStream.push(message),
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
        await client.subscribe({
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

          await client.subscribe({
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
          expect(await client.consumerState()).toBe(ConsumerState.Configured);
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
            messageCount++;
            if (messageCount === 1) {
              throw new Error("Transient error occurred");
            } else {
              retryEvent.emit("retry");
            }
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
            messageCount++;
            errorEvent.emit("error-event");
            throw new Error("Permanent error occurred");
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

  it("demonstrates upsert behavior for timers at same time", async () => {
    return tracer.startActiveSpan("test.timer_upsert", async (span) => {
      try {
        const { testEvents, timerDelayMs } = createTimerTestSetup();
        let scheduledTimes;
        let timerCount = 0;

        class TimerHandler {
          async onMessage(context, message) {
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
          }

          async onTimer(context, timer) {
            timerCount++;
            testEvents.emit("timerFired", { timer, timerCount });
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
