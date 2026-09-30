const { EventEmitter } = require("events");
const {
  ConsumerState,
  PermanentError,
  ProsodyClient,
  permanent,
  transient,
} = require("../index.js");
const {
  MESSAGE_TIMEOUT,
  SOURCE_NAME,
  liveSuite,
  waitForEvent,
  waitForMessages,
} = require("./support");

describe("ProsodyClient", () => {
  const env = liveSuite();

  it("initializes correctly", async () => {
    return env.tracer.startActiveSpan("test.initialize", async (span) => {
      try {
        expect(env.client).toBeInstanceOf(ProsodyClient);
        expect(await env.client.consumerState()).toBe(ConsumerState.Configured);
      } finally {
        span.end();
      }
    });
  });

  it("exposes source system identifier", async () => {
    return env.tracer.startActiveSpan("test.source_system", async (span) => {
      try {
        expect(env.client.sourceSystem).toBe(SOURCE_NAME);
        expect(typeof env.client.sourceSystem).toBe("string");
      } finally {
        span.end();
      }
    });
  });

  it("subscribes and unsubscribes", async () => {
    return env.tracer.startActiveSpan(
      "test.subscribe_unsubscribe",
      async (span) => {
        try {
          await env.client.subscribe({
            onMessage: (_, message) => {
              return env.tracer.startActiveSpan(
                "test.onMessage",
                async (span) => {
                  try {
                    env.messageStream.push(message);
                  } finally {
                    span.end();
                  }
                },
              );
            },
          });
          expect(await env.client.consumerState()).toBe(ConsumerState.Running);

          await env.client.unsubscribe();
          expect(await env.client.consumerState()).toBe(
            ConsumerState.Configured,
          );
        } finally {
          span.end();
        }
      },
    );
  });

  it("sends and receives a message", async () => {
    return env.tracer.startActiveSpan("test.send_receive", async (span) => {
      try {
        await env.client.subscribe({
          onMessage: (_, message) => {
            return env.tracer.startActiveSpan(
              "test.onMessage",
              async (span) => {
                try {
                  env.messageStream.push(message);
                } finally {
                  span.end();
                }
              },
            );
          },
        });

        const testMessage = {
          key: "test-key",
          payload: { content: "Hello, Kafka!" },
        };

        await env.client.send(env.topic, testMessage.key, testMessage.payload);

        const [receivedMessage] = await waitForMessages(
          env.messageStream,
          1,
          MESSAGE_TIMEOUT,
        );

        expect(receivedMessage.topic).toBe(env.topic);
        expect(receivedMessage.key).toBe(testMessage.key);
        expect(receivedMessage.payload).toEqual(testMessage.payload);
      } finally {
        span.end();
      }
    });
  });

  it("sends and receives an excise record", async () => {
    await env.client.subscribe({
      onExcise: async (_, message) => env.messageStream.push(message),
    });

    await env.client.excise(env.topic, "obsolete-key");
    const [message] = await waitForMessages(
      env.messageStream,
      1,
      MESSAGE_TIMEOUT,
    );

    expect(message.key).toBe("obsolete-key");
    expect("payload" in message).toBe(false);
  });

  it("handles multiple messages with correct ordering", async () => {
    return env.tracer.startActiveSpan(
      "test.multiple_messages",
      async (span) => {
        try {
          await env.client.subscribe({
            onMessage: (_, message) => {
              return env.tracer.startActiveSpan(
                "test.onMessage",
                async (span) => {
                  try {
                    env.messageStream.push(message);
                  } finally {
                    span.end();
                  }
                },
              );
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
            await env.client.send(env.topic, msg.key, msg.payload);
          }

          const receivedMessages = await waitForMessages(
            env.messageStream,
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
            expect(msg.topic).toBe(env.topic);
          });
        } finally {
          span.end();
        }
      },
    );
  });

  it("supports abort controller in onMessage handler", async () => {
    await env.tracer.startActiveSpan(
      "test.abort_controller_onMessage",
      async (span) => {
        try {
          const testEvents = new EventEmitter();
          let messageAborted = false;

          await env.client.subscribe({
            onMessage: (context, message, signal) => {
              return env.tracer.startActiveSpan(
                "test.onMessage",
                async (span) => {
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
                },
              );
            },
          });

          await env.client.send(env.topic, "hanging-key", {
            content: "I will hang until aborted",
          });

          await waitForEvent(testEvents, "processingStarted", MESSAGE_TIMEOUT);
          const unsubscribePromise = env.client.unsubscribe();
          await waitForEvent(testEvents, "processingAborted", MESSAGE_TIMEOUT);
          await unsubscribePromise;

          expect(messageAborted).toBe(true);
          expect(await env.client.consumerState()).toBe(
            ConsumerState.Configured,
          );
        } finally {
          span.end();
        }
      },
    );
  });

  it("preserves non-Error abort reasons when send rejects", async () => {
    return env.tracer.startActiveSpan(
      "test.abort_non_error_reason",
      async (span) => {
        try {
          const controller = new AbortController();
          controller.abort("timer cancelled");

          await expect(
            env.client.send(
              env.topic,
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
    return env.tracer.startActiveSpan("test.transient_error", async (span) => {
      try {
        let messageCount = 0;
        const demands = [];
        const retryEvent = new EventEmitter();

        class TransientErrorHandler {
          @transient(Error)
          async onMessage(context, message) {
            return env.tracer.startActiveSpan(
              "test.onMessage",
              async (span) => {
                try {
                  messageCount++;
                  demands.push({
                    demand: context.demand,
                    frozen: Object.isFrozen(context.demand),
                    stable: context.demand === context.demand,
                  });
                  if (messageCount === 1) {
                    throw new Error("Transient error occurred");
                  } else {
                    retryEvent.emit("retry");
                  }
                } finally {
                  span.end();
                }
              },
            );
          }
        }

        await env.client.subscribe(new TransientErrorHandler());

        await env.client.send(env.topic, "test-key", {
          content: "Trigger transient error",
        });

        await waitForEvent(retryEvent, "retry", MESSAGE_TIMEOUT);
        // The first attempt is normal demand; the retry carries ordinal 1.
        expect(demands.slice(0, 2)).toEqual([
          { demand: { kind: "normal", retry: 0 }, frozen: true, stable: true },
          { demand: { kind: "failure", retry: 1 }, frozen: true, stable: true },
        ]);
      } finally {
        span.end();
      }
    });
  });

  it("handles permanent errors without retry", async () => {
    return env.tracer.startActiveSpan("test.permanent_error", async (span) => {
      try {
        let messageCount = 0;
        const errorEvent = new EventEmitter();

        class PermanentErrorHandler {
          @permanent(Error)
          async onMessage(_, message) {
            return env.tracer.startActiveSpan(
              "test.onMessage",
              async (span) => {
                try {
                  messageCount++;
                  errorEvent.emit("error-event");
                  throw new Error("Permanent error occurred");
                } finally {
                  span.end();
                }
              },
            );
          }
        }

        await env.client.subscribe(new PermanentErrorHandler());

        await env.client.send(env.topic, "test-key", {
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
    return env.tracer.startActiveSpan(
      "test.explicit_permanent_error",
      async (span) => {
        try {
          let messageCount = 0;
          const errorEvent = new EventEmitter();

          await env.client.subscribe({
            onMessage: async (context, message) => {
              return env.tracer.startActiveSpan(
                "test.onMessage",
                async (span) => {
                  try {
                    messageCount++;
                    errorEvent.emit("error-event");
                    throw new PermanentError(
                      "Explicit permanent error occurred",
                    );
                  } finally {
                    span.end();
                  }
                },
              );
            },
          });

          await env.client.send(env.topic, "test-key", {
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

  it("returns a handler failure when a result cannot encode", async () => {
    await env.client.subscribe({ onMessage: async () => 1n });

    const results = await env.client.request(
      env.topic,
      "order-1",
      { type: "order.created" },
      { subsystems: ["inventory"], timeoutMs: MESSAGE_TIMEOUT },
    );

    expect(results.get("inventory")).toMatchObject({
      ok: false,
      error: { kind: "handler" },
    });
  });
});
