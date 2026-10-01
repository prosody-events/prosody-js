const { EventEmitter } = require("events");
const {
  PermanentError,
  getCurrentLogger,
  setLogger,
  transient,
} = require("../index.js");
const {
  MESSAGE_TIMEOUT,
  liveSuite,
  waitForEvent,
  waitForMessages,
} = require("./support");

describe("ProsodyClient failures", () => {
  const env = liveSuite();

  it("handles transient errors with retry", async () => {
    let messageCount = 0;
    const demands = [];
    const retryEvent = new EventEmitter();

    class TransientErrorHandler {
      @transient(Error)
      async onMessage(context, message) {
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
  });

  it("handles explicit permanent errors without retry", async () => {
    let messageCount = 0;
    const errorEvent = new EventEmitter();

    await env.client.subscribe({
      onMessage: async (context, message) => {
        messageCount++;
        errorEvent.emit("error-event");
        throw new PermanentError("Explicit permanent error occurred");
      },
    });

    await env.client.send(env.topic, "test-key", {
      content: "Trigger explicit permanent error",
    });

    await waitForEvent(errorEvent, "error-event", MESSAGE_TIMEOUT);

    // Wait a bit to allow for any potential retries
    await new Promise((resolve) => setTimeout(resolve, 5000));

    expect(messageCount).toBe(1);
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
      { subsystems: ["inventory"], timeoutMs: 3_000 },
    );
    await waitForMessages(env.messageStream, 2, MESSAGE_TIMEOUT);

    expect((await results).get("inventory")).toMatchObject({
      ok: false,
      error: { kind: "timeout" },
    });
  });

  // A failed handler logs a text that names the event type. The JavaScript
  // layer and the native layer each log one text.
  it("logs a failed handler with the event text", async () => {
    const previous = getCurrentLogger();
    const logged = new EventEmitter();
    setLogger({ ...previous, error: (message) => logged.emit(message) });
    try {
      const texts = [
        "Timer handler error",
        "timer handler error",
        "record handler error",
      ].map((text) => waitForEvent(logged, text, MESSAGE_TIMEOUT));
      await env.client.subscribe({
        onMessage: async (context, message) => {
          if (message.key === "record-key") throw new Error("record failed");
          await context.schedule(new Date(Date.now() + 2000));
        },
        onTimer: async () => {
          throw new Error("timer failed");
        },
      });

      await env.client.send(env.topic, "timer-key", { content: "timer" });
      await env.client.send(env.topic, "record-key", { content: "record" });
      await Promise.all(texts);
    } finally {
      setLogger(previous);
    }
  });
});
