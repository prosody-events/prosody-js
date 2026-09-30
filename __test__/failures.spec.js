const { EventEmitter } = require("events");
const { PermanentError, permanent, transient } = require("../index.js");
const {
  MESSAGE_TIMEOUT,
  liveSuite,
  waitForEvent,
  waitForMessages,
} = require("./support");

describe("ProsodyClient failures", () => {
  const env = liveSuite();

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

  // A result with no JSON form is a handler mistake, so it is transient: the
  // event retries, and the requester sees a timeout instead of a response.
  it("retries a handler whose result cannot encode", async () => {
    await env.client.subscribe({
      onMessage: async () => {
        env.messageStream.push("attempt");
        return 1n;
      },
    });

    const results = env.client.request(
      env.topic,
      "order-1",
      { type: "order.created" },
      { subsystems: ["inventory"], timeoutMs: MESSAGE_TIMEOUT },
    );
    await waitForMessages(env.messageStream, 2, MESSAGE_TIMEOUT);

    expect((await results).get("inventory")).toMatchObject({
      ok: false,
      error: { kind: "timeout" },
    });
  });
});
