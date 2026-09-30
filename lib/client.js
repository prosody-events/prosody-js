/**
 * The ProsodyClient class: producing, requests, subscription, and shutdown.
 * @module lib/client
 * @private
 */

const {
  context: otelContext,
  propagation,
  trace,
  SpanStatusCode,
} = require("@opentelemetry/api");
const { NativeClient } = require("../bindings");
const { Context } = require("./context");
const { EventHandlerError, TransientError } = require("./errors");
const { captureException, getCurrentLogger } = require("./logging");
const { eventMetadata, toJson, withParsedPayload } = require("./state/codec");
const { stateDefinitionAccess } = require("./state/definitions");

/** Proves that a constructor call comes from {@link wrapNative}. @private */
const CONSTRUCT = Symbol("ProsodyClient");

/**
 * Main client for interacting with Prosody messaging system.
 * Provides functionality for sending messages, subscribing to topics, and managing consumer state.
 */
class ProsodyClient {
  #native;
  // The one shutdown operation that every shutdown call awaits.
  #shutdown;

  /**
   * Use {@link ProsodyClient.create}.
   * @param {symbol} token - The module token that only {@link wrapNative} has.
   * @param {object} native - The native client.
   * @private
   */
  constructor(token, native) {
    if (token !== CONSTRUCT) {
      throw new TypeError("Use await ProsodyClient.create(config)");
    }
    this.#native = native;
  }

  /**
   * Creates a Prosody client without blocking the Node.js event loop.
   *
   * @param {Configuration} config - The client configuration.
   * @returns {Promise<ProsodyClient>} The initialized client.
   */
  static async create(config) {
    return wrapNative(await NativeClient.create(config));
  }

  /**
   * Gets the source system identifier configured for the client.
   *
   * @returns {string} The source system identifier.
   */
  get sourceSystem() {
    return this.#native.sourceSystem;
  }

  /**
   * Gets the current state of the consumer.
   *
   * @returns {Promise<ConsumerState>} The current state of the consumer.
   * @throws {Error} If the operation fails.
   */
  consumerState() {
    return this.#native.consumerState();
  }

  /**
   * Gets the number of partitions assigned to the consumer.
   *
   * @returns {Promise<number>} The number of assigned partitions, or 0 if the consumer is not in the Running state.
   * @throws {Error} If the operation fails.
   */
  assignedPartitionCount() {
    return this.#native.assignedPartitionCount();
  }

  /**
   * Checks if the consumer is stalled.
   *
   * @returns {Promise<boolean>} Whether the consumer is stalled, or false if the consumer is not in the Running state.
   * @throws {Error} If the operation fails.
   */
  isStalled() {
    return this.#native.isStalled();
  }

  /**
   * Opens a read-only view of another consumer group's published collection.
   * @param {string} subsystem - The publisher's subsystem.
   * @param {Readonly<object>} definition - A JSON value, map, or deque
   *   definition, or a set definition.
   * @returns {Promise<PublishedValue|PublishedMap|PublishedSet|PublishedDeque>} The reader.
   */
  async state(subsystem, definition) {
    const access = stateDefinitionAccess.get(definition);
    if (access?.published === undefined) {
      throw new TypeError(
        "definition must be a JSON value, map, or deque definition, or a set definition",
      );
    }
    return access.published(
      this.#native,
      subsystem,
      definition.name,
      definition.readCache,
    );
  }

  /**
   * Sends a message to a specified topic.
   *
   * @param {string} topic - The topic to send the message to.
   * @param {string} key - The key of the message.
   * @param {*} payload - The payload of the message. Serialized here; Kafka
   *   receives the bytes verbatim.
   * @param {AbortSignal} [signal] - Optional abort signal to cancel the send operation. When aborted, the promise will reject with the abort reason.
   * @returns {Promise<void>} A promise that resolves when the message has been successfully sent.
   * @throws {Error} If the send operation fails or is aborted.
   */
  async send(topic, key, payload, signal) {
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);

    await this.#native.send(
      topic,
      key,
      toJson(payload, TransientError),
      eventMetadata(payload),
      carrier,
      signal && onAbort(signal),
    );
  }

  /**
   * Sends an excise record for a key.
   *
   * @param {string} topic - The topic name.
   * @param {string} key - The key to delete from compacted views.
   * @param {AbortSignal} [signal] - An optional abort signal.
   * @returns {Promise<void>} A promise that resolves after Prosody sends the record.
   */
  async excise(topic, key, signal) {
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);
    await this.#native.excise(topic, key, carrier, signal && onAbort(signal));
  }

  /**
   * Sends a request and returns one outcome for each subsystem.
   *
   * @param {string} topic - The Kafka topic.
   * @param {string} key - The message key.
   * @param {*} payload - The JSON request payload.
   * @param {{subsystems: readonly string[], timeoutMs: number, signal?: AbortSignal}} options - Request policy.
   * @returns {Promise<ReadonlyMap<string, {ok: true, value: *}|{ok: false, error: {kind: "handler"|"timeout"|"formatMismatch"|"malformedResponse", message: string}}>>} One outcome per subsystem.
   * @throws {Error} If the input is invalid, sending fails, shutdown starts, or the signal aborts.
   */
  async request(topic, key, payload, options) {
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);
    const results = await this.#native.request(
      {
        topic,
        key,
        payload: toJson(payload, TransientError),
        metadata: eventMetadata(payload),
        subsystems: options.subsystems,
        timeoutMs: options.timeoutMs,
      },
      carrier,
      options.signal && onAbort(options.signal),
    );
    return responseOutcomes(results);
  }

  /** Sends an excise request and returns one outcome for each subsystem. */
  async requestExcise(topic, key, options) {
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);
    const results = await this.#native.requestExcise(
      {
        topic,
        key,
        subsystems: options.subsystems,
        timeoutMs: options.timeoutMs,
      },
      carrier,
      options.signal && onAbort(options.signal),
    );
    return responseOutcomes(results);
  }

  /**
   * Subscribes to receive messages using the provided event handler.
   *
   * @param {EventHandler} eventHandler - The event handler to process received messages and timers.
   * @returns {Promise<void>} A promise that resolves when the subscription is successfully established and the consumer is ready to receive messages.
   * @throws {TypeError} If any required handler method is missing.
   * @throws {Error} If the subscription fails to establish.
   */
  async subscribe(eventHandler) {
    for (const name of ["onMessage", "onExcise", "onTimer"]) {
      if (typeof eventHandler?.[name] !== "function") {
        throw new TypeError(`EventHandler.${name} must be a function`);
      }
    }

    const tracer = trace.getTracer("prosody");
    const { onExcise, onMessage, onTimer } = eventHandler;
    const handleRecord = async (
      nativeContext,
      message,
      carrier,
      handler,
      spanName,
      eventType,
    ) => {
      const ctx = propagation.extract(otelContext.active(), carrier);
      return otelContext.with(ctx, () =>
        tracer.startActiveSpan(spanName, async (span) => {
          const controller = new AbortController();
          let completed = false;
          nativeContext.onCancel().then(() => {
            if (!completed) {
              span.setAttribute("cancelled", true);
              controller.abort(new Error(`${eventType} cancelled`));
            }
          });

          try {
            const result = await handler(
              new Context(nativeContext),
              message,
              controller.signal,
            );
            // A result with no JSON form is a handler mistake. It is
            // transient, so the event retries and the mistake stays visible.
            return toJson(result ?? null, TransientError);
          } catch (error) {
            const cause = error.cause ?? error;
            getCurrentLogger()?.error(`${eventType} handler error`, cause);
            span.recordException(cause);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: cause.message,
            });
            captureException(error, eventType, {
              topic: message.topic,
              partition: message.partition,
              key: message.key,
              offset: message.offset,
            });
            throw error;
          } finally {
            completed = true;
            span.end();
          }
        }),
      );
    };

    await this.#native.subscribe({
      isPermanent: ([err]) => {
        try {
          return err instanceof EventHandlerError && err.isPermanent;
        } catch {
          return false;
        }
      },

      onMessage: async (err, [nativeContext, message, carrier]) => {
        if (err) throw err;
        return handleRecord(
          nativeContext,
          withParsedPayload(message),
          carrier,
          onMessage,
          "onMessage",
          "message",
        );
      },

      onExcise: async (err, [nativeContext, message, carrier]) => {
        if (err) throw err;
        return handleRecord(
          nativeContext,
          message,
          carrier,
          onExcise,
          "onExcise",
          "excise",
        );
      },

      onTimer: async (err, [nativeContext, timer, carrier]) => {
        if (err) throw err;

        const ctx = propagation.extract(otelContext.active(), carrier);
        return otelContext.with(ctx, async () => {
          return tracer.startActiveSpan("onTimer", async (span) => {
            const controller = new AbortController();
            let completed = false;

            // Signal abort when cancellation occurs (before handler completes)
            nativeContext.onCancel().then(() => {
              if (!completed) {
                span.setAttribute("cancelled", true);
                controller.abort(new Error("timer cancelled"));
              }
            });

            try {
              const context = new Context(nativeContext);
              await onTimer(context, timer, controller.signal);
              return "null";
            } catch (error) {
              getCurrentLogger()?.error(
                "Timer handler error",
                error.cause ?? error,
              );
              const cause = error.cause ?? error;
              span.recordException(cause);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: cause.message,
              });
              captureException(error, "timer", {
                key: timer.key,
                time: timer.time,
              });
              throw error;
            } finally {
              completed = true;
              span.end();
            }
          });
        });
      },
    });
  }

  /**
   * Stops the consumer. You can subscribe again later.
   *
   * @returns {Promise<void>} A promise that resolves when the unsubscribe operation is complete.
   * @throws {Error} If the unsubscribe operation fails.
   */
  async unsubscribe() {
    await this.#native.unsubscribe();
  }

  /**
   * Shuts down the client and all its services.
   * Concurrent and repeated calls await the same shutdown operation.
   *
   * @returns {Promise<void>} A promise that resolves when shutdown is complete.
   * @throws {Error} If shutdown fails.
   */
  async shutdown() {
    this.#shutdown ??= this.#native.shutdown();
    await this.#shutdown;
  }

  /**
   * Shuts down the client when an `await using` block ends.
   *
   * @returns {Promise<void>} A promise that resolves when shutdown is complete.
   * @throws {Error} If shutdown fails.
   */
  [Symbol.asyncDispose]() {
    return this.shutdown();
  }
}

// napi-rs can only surface rejections whose value is an object, function, or
// symbol — napi_create_reference fails on primitives and the rejection becomes
// an opaque `InvalidArg: Create Error reference failed`. Coerce primitive
// reasons into Error instances so the original reason is preserved across the
// napi boundary.
const toAbortError = (reason) =>
  reason instanceof Error
    ? reason
    : new Error(reason === undefined ? "aborted" : String(reason));

/**
 * Creates a promise that rejects when the abort signal is triggered.
 * @param {AbortSignal} signal - The abort signal to monitor.
 * @returns {Promise<never>} A promise that rejects with the abort reason.
 * @private
 */
const onAbort = (signal) =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(toAbortError(signal.reason));
    else
      signal.addEventListener(
        "abort",
        () => reject(toAbortError(signal.reason)),
        { once: true },
      );
  });

function responseOutcome(outcome) {
  if (typeof outcome !== "string") return { ok: false, error: outcome };

  try {
    return { ok: true, value: JSON.parse(outcome) };
  } catch (cause) {
    return {
      ok: false,
      error: { kind: "malformedResponse", message: cause.message },
    };
  }
}

function responseOutcomes(results) {
  const outcomes = new Map();
  for (const { subsystem, outcome } of results)
    outcomes.set(subsystem, responseOutcome(outcome));
  return outcomes;
}

/**
 * Wraps a native client. The unit tests wrap a stub through it.
 * @param {object} native - The native client.
 * @returns {ProsodyClient} The client.
 * @private
 */
function wrapNative(native) {
  return new ProsodyClient(CONSTRUCT, native);
}

module.exports = {
  ProsodyClient,
  wrapNative,
};
