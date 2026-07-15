/**
 * @module prosody-js
 * @description A high-performance messaging client for Kafka with built-in OpenTelemetry support.
 * Provides functionality for sending messages, subscribing to topics, and managing consumer state.
 */

/**
 * @typedef {Object} Logger
 * @property {Function} error - Function for logging error messages. Called with (message, metadata).
 * @property {Function} warn - Function for logging warning messages. Called with (message, metadata).
 * @property {Function} info - Function for logging informational messages. Called with (message, metadata).
 * @property {Function} debug - Function for logging debug messages. Called with (message, metadata).
 * @property {Function} trace - Function for logging trace messages. Called with (message, metadata).
 */

/**
 * @typedef {Object} EventHandler
 * @property {Function} [onMessage] - Async callback function to handle incoming messages. Receives (context, message, signal).
 * @property {Function} [onTimer] - Async callback function to handle timer events. Receives (context, timer, signal).
 */

/**
 * @typedef {import('./bindings').Configuration} Configuration
 * @typedef {import('./bindings').ConsumerState} ConsumerState
 * @typedef {import('./bindings').Context} Context
 * @typedef {import('./bindings').Message} Message
 * @typedef {import('./bindings').Timer} Timer
 * @typedef {import('./bindings').Mode} Mode
 */

const { types } = require("node:util");

const {
  context: otelContext,
  propagation,
  trace,
  SpanStatusCode,
} = require("@opentelemetry/api");

const {
  Mode,
  NativeClient,
  ConsumerState,
  NativeContext,
  initialize,
  loggerIsSet,
  setLogger: setLoggerInternal,
  setLoggerIfUnset: setLoggerIfUnsetInternal,
} = require("./bindings");

let _sentry = undefined;
function getSentry() {
  if (_sentry !== undefined) return _sentry;
  _sentry = null;
  if (!process.env.SENTRY_DSN) return null;
  try {
    const Sentry = require("@sentry/node");
    if (!Sentry.isInitialized()) {
      Sentry.init({ dsn: process.env.SENTRY_DSN });
    }
    _sentry = Sentry;
    return Sentry;
  } catch (err) {
    const isMissing =
      err?.code === "MODULE_NOT_FOUND" && err.message?.includes("@sentry/node");
    if (isMissing) {
      getCurrentLogger()?.error(
        "SENTRY_DSN is set but @sentry/node is not installed. Run: npm install @sentry/node",
      );
    } else {
      getCurrentLogger()?.warn("Unexpected error loading @sentry/node", err);
    }
    return null;
  }
}

function captureException(error, eventType, context) {
  const Sentry = getSentry();
  if (!Sentry) return;
  Sentry.withScope((scope) => {
    scope.setTag("prosody.event_type", eventType);
    scope.setContext("prosody", context);
    Sentry.captureException(error.cause ?? error);
  });
}

const defaultLogger = {
  error: (message, metadata) =>
    metadata !== undefined
      ? console.error(message, metadata)
      : console.error(message),
  warn: (message, metadata) =>
    metadata !== undefined
      ? console.warn(message, metadata)
      : console.warn(message),
  info: (message, metadata) =>
    metadata !== undefined
      ? console.info(message, metadata)
      : console.info(message),
  debug: (message, metadata) =>
    metadata !== undefined
      ? console.debug(message, metadata)
      : console.debug(message),
  trace: (message, metadata) =>
    metadata !== undefined
      ? console.debug(message, metadata)
      : console.debug(message),
};

// Keep reference to current logger for use in handlers
let currentLogger = defaultLogger;

function transformLogger(logger) {
  return {
    info: ([msg, meta]) => logger.info(msg, meta),
    error: ([msg, meta]) => logger.error(msg, meta),
    debug: ([msg, meta]) => logger.debug(msg, meta),
    warn: ([msg, meta]) => logger.warn(msg, meta),
    trace: ([msg, meta]) => logger.trace(msg, meta),
  };
}

/**
 * Gets the current configured logger.
 * @returns {Logger|null|undefined} The current logger instance, or null/undefined if no logger is configured.
 */
function getCurrentLogger() {
  return currentLogger;
}

initialize();
setLoggerIfUnset(defaultLogger);

/**
 * Sets a new JavaScript logger for the Prosody client.
 *
 * This function configures the logging system to use the provided JavaScript logger
 * for all log output. The logger must implement all required log levels.
 *
 * @param {Logger} logger - The JavaScript logger object.
 * @throws {Error} If creating the new JavaScript logger fails.
 */
function setLogger(logger) {
  currentLogger = logger;
  setLoggerInternal(transformLogger(logger));
}

/**
 * Sets a JavaScript logger only if no logger is currently configured.
 *
 * This function is useful for providing a default logger without overriding
 * an existing one that may have been set earlier.
 *
 * @param {Logger} logger - The JavaScript logger object.
 * @returns {boolean} True if the logger was set (no previous logger existed), false if a logger was already configured.
 * @throws {Error} If creating the new JavaScript logger fails.
 */
function setLoggerIfUnset(logger) {
  const wasSet = setLoggerIfUnsetInternal(transformLogger(logger));
  if (wasSet) {
    currentLogger = logger;
  }
  return wasSet;
}

/**
 * Main client for interacting with Prosody messaging system.
 * Provides functionality for sending messages, subscribing to topics, and managing consumer state.
 */
class ProsodyClient {
  /**
   * Creates a new ProsodyClient instance.
   *
   * @param {Configuration} config - The configuration options for the client.
   */
  constructor(config) {
    this.nativeClient = new NativeClient(config);
  }

  /**
   * Gets the source system identifier configured for the client.
   *
   * @returns {string} The source system identifier.
   */
  get sourceSystem() {
    return this.nativeClient.sourceSystem;
  }

  /**
   * Gets the current state of the consumer.
   *
   * @returns {Promise<ConsumerState>} The current state of the consumer.
   * @throws {Error} If the operation fails.
   */
  consumerState() {
    return this.nativeClient.consumerState();
  }

  /**
   * Gets the number of partitions assigned to the consumer.
   *
   * @returns {Promise<number>} The number of assigned partitions, or 0 if the consumer is not in the Running state.
   * @throws {Error} If the operation fails.
   */
  assignedPartitionCount() {
    return this.nativeClient.assignedPartitionCount();
  }

  /**
   * Checks if the consumer is stalled.
   *
   * @returns {Promise<boolean>} Whether the consumer is stalled, or false if the consumer is not in the Running state.
   * @throws {Error} If the operation fails.
   */
  isStalled() {
    return this.nativeClient.isStalled();
  }

  /**
   * Sends a message to a specified topic.
   *
   * @param {string} topic - The topic to send the message to.
   * @param {string} key - The key of the message.
   * @param {*} payload - The payload of the message.
   * @param {AbortSignal} [signal] - Optional abort signal to cancel the send operation. When aborted, the promise will reject with the abort reason.
   * @returns {Promise<void>} A promise that resolves when the message has been successfully sent.
   * @throws {Error} If the send operation fails or is aborted.
   */
  async send(topic, key, payload, signal) {
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);

    await this.nativeClient.send(
      topic,
      key,
      payload,
      carrier,
      signal && onAbort(signal),
    );
  }

  /**
   * Subscribes to receive messages using the provided event handler.
   *
   * @param {EventHandler} eventHandler - The event handler to process received messages and timers.
   * @returns {Promise<void>} A promise that resolves when the subscription is successfully established and the consumer is ready to receive messages.
   * @throws {Error} If the subscription fails to establish.
   */
  async subscribe(eventHandler) {
    const tracer = trace.getTracer("prosody");
    const {
      onMessage = (context, message, _signal) => {
        getCurrentLogger()?.error(
          "ProsodyClient: Received a message but no onMessage handler was " +
            "provided in subscribe(). To handle messages, implement the onMessage " +
            "method in your EventHandler:",
          {
            topic: message.topic,
            partition: message.partition,
            offset: message.offset,
            key: message.key,
            solution:
              "Add onMessage: async (context, message, signal) => " +
              "{ /* your logic here */ } to your subscribe() call",
          },
        );
      },
      onTimer = (context, timer, _signal) => {
        getCurrentLogger()?.error(
          "ProsodyClient: Received a timer event but no onTimer handler was " +
            "provided in subscribe(). To handle timers, implement the onTimer " +
            "method in your EventHandler:",
          {
            key: timer.key,
            time: timer.time,
            solution:
              "Add onTimer: async (context, timer, signal) => " +
              "{ /* your logic here */ } to your subscribe() call",
          },
        );
      },
    } = eventHandler;

    await this.nativeClient.subscribe({
      isPermanent: ([err]) => {
        try {
          return err instanceof EventHandlerError && err.isPermanent;
        } catch {
          return false;
        }
      },

      onMessage: async (err, [nativeContext, message, carrier]) => {
        if (err) throw err;

        const ctx = propagation.extract(otelContext.active(), carrier);
        await otelContext.with(ctx, async () => {
          await tracer.startActiveSpan("onMessage", async (span) => {
            const controller = new AbortController();
            let completed = false;

            // Signal abort when cancellation occurs (before handler completes)
            nativeContext.onCancel().then(() => {
              if (!completed) {
                span.setAttribute("cancelled", true);
                controller.abort(new Error("message cancelled"));
              }
            });

            try {
              const context = new Context(nativeContext);
              await onMessage(context, message, controller.signal);
            } catch (error) {
              getCurrentLogger()?.error(
                "Message handler error",
                error.cause ?? error,
              );
              const cause = error.cause ?? error;
              span.recordException(cause);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: cause.message,
              });
              captureException(error, "message", {
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
          });
        });
      },

      onTimer: async (err, [nativeContext, timer, carrier]) => {
        if (err) throw err;

        const ctx = propagation.extract(otelContext.active(), carrier);
        await otelContext.with(ctx, async () => {
          await tracer.startActiveSpan("onTimer", async (span) => {
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
   * Unsubscribes from receiving messages and shuts down the consumer.
   *
   * @returns {Promise<void>} A promise that resolves when the unsubscribe operation is complete.
   * @throws {Error} If the unsubscribe operation fails.
   */
  async unsubscribe() {
    await this.nativeClient.unsubscribe();
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

/**
 * Base class for event handler errors.
 * Provides a common interface for determining if an error is permanent.
 * @extends Error
 */
class EventHandlerError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }

  /**
   * Indicates whether the error is permanent and should not be retried.
   * @abstract
   * @returns {boolean} True if permanent, false if transient.
   */
  get isPermanent() {
    throw new Error("Subclasses must implement isPermanent");
  }
}

/**
 * Represents a transient error that may be resolved by retrying.
 * @extends EventHandlerError
 */
class TransientError extends EventHandlerError {
  /**
   * @returns {boolean} Always returns false, indicating the error is not permanent.
   */
  get isPermanent() {
    return false;
  }
}

/**
 * Represents a permanent error that should not be retried.
 * @extends EventHandlerError
 */
class PermanentError extends EventHandlerError {
  /**
   * @returns {boolean} Always returns true, indicating the error is permanent.
   */
  get isPermanent() {
    return true;
  }
}

/**
 * Represents a transient keyed-state failure (e.g. a store read/write timeout)
 * that may succeed on a later attempt. Thrown by state handles and scan
 * iterators. Because it subclasses {@link TransientError}, rethrowing it from a
 * handler classifies the event transient through the existing error bridge with
 * no bridge change.
 * @extends TransientError
 */
class TransientStateError extends TransientError {}

/**
 * Represents a permanent keyed-state failure — an unregistered collection name,
 * a registered-identity mismatch, a duplicate registration, a null write (use
 * clear() on value/deque or delete() on map instead), or an item-shape mistake.
 * Because it subclasses {@link PermanentError}, rethrowing it from a handler
 * classifies the event permanent through the existing error bridge with no
 * bridge change.
 * @extends PermanentError
 */
class PermanentStateError extends PermanentError {}

const STATE_ERROR_NAMES = new Set([
  "PermanentStateError",
  "TransientStateError",
]);

/**
 * Checks whether a value is a keyed-state error of either category.
 *
 * Name-branded: it matches on the error's `name`, so it recognizes state errors
 * across both category classes (and across realms/duplicate module copies)
 * without caring which category the error carries. It uses a realm-neutral
 * native-error check so an error minted in another realm (a Node vm context,
 * worker thread, or duplicate module copy) is still recognized — a bare
 * `instanceof Error` would reject those.
 *
 * @param {unknown} error - The value to test.
 * @returns {boolean} True when the value is a keyed-state error.
 */
function isStateError(error) {
  return types.isNativeError(error) && STATE_ERROR_NAMES.has(error.name);
}

/**
 * Helper function to create error decorators.
 * @param {Function} ErrorClass - The error class to wrap exceptions with.
 * @returns {Function} A decorator function that wraps specified exceptions.
 * @private
 */
function createErrorDecorator(ErrorClass) {
  return function decorator(...exceptionTypes) {
    return function (originalMethod, context) {
      if (context.kind !== "method" && context.kind !== "function") {
        throw new TypeError(
          `@${ErrorClass.name} can only decorate methods or functions`,
        );
      }

      function handleError(error) {
        if (exceptionTypes.some((type) => error instanceof type)) {
          const wrapped = new ErrorClass(error.message);
          wrapped.cause = error;
          return wrapped;
        }
        return error;
      }

      if (originalMethod.constructor.name === "AsyncFunction") {
        return async function (...args) {
          try {
            return await originalMethod.apply(this, args);
          } catch (error) {
            throw handleError(error);
          }
        };
      } else {
        return function (...args) {
          try {
            return originalMethod.apply(this, args);
          } catch (error) {
            throw handleError(error);
          }
        };
      }
    };
  };
}

/**
 * Decorator factory for marking errors as transient.
 * Can be applied to methods to automatically wrap specified error types as transient.
 * @param {...(new(...args: any[]) => Error)} exceptionTypes - The error types to be treated as transient.
 * @returns {Function} A decorator function.
 */
const transient = createErrorDecorator(TransientError);

/**
 * Decorator factory for marking errors as permanent.
 * Can be applied to methods to automatically wrap specified error types as permanent.
 * @param {...(new(...args: any[]) => Error)} exceptionTypes - The error types to be treated as permanent.
 * @returns {Function} A decorator function.
 */
const permanent = createErrorDecorator(PermanentError);

/**
 * Injects the active OpenTelemetry context into a fresh carrier for one native
 * operation — the per-operation span pattern the timer and state methods use
 * (one carrier, and therefore one span, per call).
 * @returns {Record<string, string>} The populated carrier.
 * @private
 */
function injectedCarrier() {
  const carrier = {};
  propagation.inject(otelContext.active(), carrier);
  return carrier;
}

/**
 * Converts a category-tagged native state error into the matching typed state
 * error. The category crosses the FFI boundary structurally: the native layer
 * sets the error's `cause` to an error whose message is exactly `"permanent"`
 * or `"transient"` — a data channel distinct from the human-readable message,
 * which is never parsed. Untagged errors (e.g. an argument-conversion
 * TypeError) pass through unchanged.
 *
 * The native-error checks are realm-neutral (`util.types.isNativeError`) rather
 * than `instanceof Error`: a napi error is minted in the addon's realm, so under
 * a Node vm context, worker thread, or duplicate module copy a plain
 * `instanceof Error` would be false and the category tag would be missed. The
 * category is still matched exactly against the closed `"permanent"`/
 * `"transient"` token set on the cause.
 * @param {unknown} error - The error thrown by the native layer.
 * @returns {unknown} The typed state error, or the original error if untagged.
 * @private
 */
function toStateError(error) {
  if (!types.isNativeError(error)) return error;
  const cause = error.cause;
  const category = types.isNativeError(cause) ? cause.message : undefined;
  if (category !== "permanent" && category !== "transient") return error;
  const wrapped =
    category === "permanent"
      ? new PermanentStateError(error.message)
      : new TransientStateError(error.message);
  wrapped.cause = error;
  return wrapped;
}

/**
 * Runs one async native state operation with a fresh carrier, translating a
 * category-tagged failure into the matching typed state error.
 * @param {(carrier: Record<string, string>) => Promise<*>} operation - The native call.
 * @returns {Promise<*>} The operation's resolved value.
 * @private
 */
async function stateOp(operation) {
  try {
    return await operation(injectedCarrier());
  } catch (error) {
    throw toStateError(error);
  }
}

/**
 * Runs one synchronous native call (a handle vend or a scan open), translating
 * a category-tagged failure into the matching typed state error.
 * @param {() => *} operation - The native call.
 * @returns {*} The operation's return value.
 * @private
 */
function stateSync(operation) {
  try {
    return operation();
  } catch (error) {
    throw toStateError(error);
  }
}

/**
 * Builds a frozen state-collection definition. The definition is the single
 * source of typing: the same frozen object is placed in
 * `Configuration.stateCollections` (so the collection is registered once) and
 * passed to `Context.state()` to vend a typed handle. Validation (name/ttl/
 * keyset rules, duplicate names) is core-owned and happens at client
 * construction and registration — this layer only shapes and freezes.
 * @param {string} name - The collection name.
 * @param {string} kind - `"value"`, `"map"`, or `"deque"`.
 * @param {string} payload - `"json"` or `"message"`.
 * @param {object} [options] - Optional ttlSeconds / readUncommitted / keysetLimit.
 * @returns {Readonly<object>} The frozen definition.
 * @private
 */
function stateDefinition(name, kind, payload, options = {}) {
  const definition = { name, kind, payload };
  if (options.ttlSeconds !== undefined)
    definition.ttlSeconds = options.ttlSeconds;
  if (options.readUncommitted !== undefined)
    definition.readUncommitted = options.readUncommitted;
  if (options.keysetLimit !== undefined)
    definition.keysetLimit = options.keysetLimit;
  return Object.freeze(definition);
}

/**
 * Declares a single-value JSON collection. The type parameter annotates the
 * stored value; it is compile-time only — payloads cross as plain JSON with no
 * runtime validation.
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds` (whole seconds) and `readUncommitted`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function value(name, options) {
  return stateDefinition(name, "value", "json", options);
}

/**
 * Declares an ordered-map JSON collection. Map keys are always strings; the
 * type parameter annotates the stored value (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds`, `readUncommitted`, and map-only `keysetLimit`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function map(name, options) {
  return stateDefinition(name, "map", "json", options);
}

/**
 * Declares a double-ended-queue JSON collection. The type parameter annotates
 * the stored element (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds` (whole seconds) and `readUncommitted`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function deque(name, options) {
  return stateDefinition(name, "deque", "json", options);
}

/**
 * Declares a single-value message collection: each stored item is the full
 * Kafka {@link Message} the handler received. The type parameter annotates the
 * message payload (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds` (whole seconds) and `readUncommitted`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function messageValue(name, options) {
  return stateDefinition(name, "value", "message", options);
}

/**
 * Declares an ordered-map message collection. Map keys are always strings; each
 * stored value is the full Kafka {@link Message}. The type parameter annotates
 * the message payload (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds`, `readUncommitted`, and map-only `keysetLimit`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function messageMap(name, options) {
  return stateDefinition(name, "map", "message", options);
}

/**
 * Declares a double-ended-queue message collection: each stored element is the
 * full Kafka {@link Message}. The type parameter annotates the message payload
 * (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds` (whole seconds) and `readUncommitted`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function messageDeque(name, options) {
  return stateDefinition(name, "deque", "message", options);
}

/**
 * Adapts a native scan cursor to the JS async-iterator protocol. Each `next()`
 * injects a fresh carrier (one span per pull) and maps the native `null`
 * (exhausted) to `{ done: true }`. Early exit from a `for await` loop
 * (`break`/`return`/`throw`) invokes `return()`, which awaits the native
 * `close()`; exhaustion and a pull error also close the cursor. Once finished,
 * the cursor is never touched again, and a pull error is never masked by the
 * cleanup close.
 *
 * The iterator is valid only within the handler invocation (attempt) that
 * opened it; a cursor leaked past the attempt errors on its next pull.
 * @param {object} cursor - The native scan cursor.
 * @param {(item: *) => *} transform - Maps each raw item to the yielded value.
 * @returns {AsyncIterableIterator<*>} The async iterator.
 * @private
 */
function stateIterator(cursor, transform) {
  let finished = false;
  return {
    async next() {
      if (finished) return { value: undefined, done: true };
      let item;
      try {
        item = await cursor.next(injectedCarrier());
      } catch (error) {
        finished = true;
        await cursor.close().catch(() => {});
        throw toStateError(error);
      }
      if (item === null) {
        finished = true;
        await cursor.close();
        return { value: undefined, done: true };
      }
      return { value: transform(item), done: false };
    },
    async return(value) {
      if (!finished) {
        finished = true;
        await cursor.close();
      }
      return { value, done: true };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * Typed handle over a single-value keyed-state collection, vended by
 * {@link Context#state}. Every method opens its own per-operation span. Handles
 * are valid only within the handler invocation (attempt) that vended them.
 */
class ValueState {
  /**
   * @param {import('./bindings').NativeValueState} native - The vended native handle.
   */
  constructor(native) {
    this.native = native;
  }

  /**
   * Reads the current value.
   * @returns {Promise<*|null>} The stored value, or null when absent/cleared.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  get() {
    return stateOp((carrier) => this.native.get(carrier));
  }

  /**
   * Buffers a write of the value. Writing JSON `null` is rejected core-side with
   * a {@link PermanentStateError} naming `clear()` — use {@link ValueState#clear}
   * to delete instead.
   * @param {*} value - The value to store.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On null/shape/store failure.
   */
  set(value) {
    return stateOp((carrier) => this.native.set(value, carrier));
  }

  /**
   * Deletes the stored value.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  clear() {
    return stateOp((carrier) => this.native.clear(carrier));
  }

  /**
   * Durably commits the buffered operations mid-handler (at-least-once; the
   * committed floor survives a later rollback or a failed event).
   * @returns {Promise<void>} Resolves with no value — the erased seam drops the outcome.
   * @throws {PermanentStateError|TransientStateError} On a categorized commit failure.
   */
  commit() {
    return stateOp((carrier) => this.native.commit(carrier));
  }

  /**
   * Discards buffered uncommitted operations back to the last committed floor.
   * @returns {Promise<void>} Resolves with no value.
   */
  rollback() {
    return stateOp((carrier) => this.native.rollback(carrier));
  }
}

/**
 * Typed handle over an ordered-map keyed-state collection, vended by
 * {@link Context#state}. Map keys are always strings. Every method opens its
 * own per-operation span. Handles and iterators are valid only within the
 * handler invocation (attempt) that vended them.
 */
class MapState {
  /**
   * @param {import('./bindings').NativeMapState} native - The vended native handle.
   */
  constructor(native) {
    this.native = native;
  }

  /**
   * Reads the value for `key`.
   * @param {string} key - The map key.
   * @returns {Promise<*|null>} The value, or null when the key is absent.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  get(key) {
    return stateOp((carrier) => this.native.get(key, carrier));
  }

  /**
   * Inserts or overwrites `key`. Writing JSON `null` is rejected core-side with
   * a {@link PermanentStateError} — use {@link MapState#delete} to remove an
   * entry instead.
   * @param {string} key - The map key.
   * @param {*} value - The value to store.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On null/shape/store failure.
   */
  set(key, value) {
    return stateOp((carrier) => this.native.set(key, value, carrier));
  }

  /**
   * Removes `key`.
   *
   * Deliberate divergence from `Map#delete`: this returns void, NOT a boolean
   * "was present" flag — surfacing that boolean would force a hidden read on
   * every delete. The underlying native operation is named `remove`, which is
   * the verb core's null-write rejection message uses.
   * @param {string} key - The map key.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  delete(key) {
    return stateOp((carrier) => this.native.remove(key, carrier));
  }

  /**
   * Removes every entry.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  clear() {
    return stateOp((carrier) => this.native.clear(carrier));
  }

  /**
   * Opens an async iterator over the live entries in key order. Each yielded
   * item is a `[key, value]` pair. Valid only within the handler invocation
   * (attempt) that opened it; early exit closes the underlying cursor.
   * @param {"forward"|"backward"} [direction="forward"] - The scan direction.
   * @returns {AsyncIterableIterator<[string, *]>} The entries iterator.
   * @throws {PermanentStateError} If the direction token is invalid.
   */
  entries(direction = "forward") {
    return stateIterator(
      stateSync(() => this.native.scan(direction)),
      (entry) => entry,
    );
  }

  /**
   * Opens an async iterator over the live keys in forward key order. Valid only
   * within the handler invocation (attempt) that opened it.
   * @returns {AsyncIterableIterator<string>} The keys iterator.
   */
  keys() {
    return stateIterator(
      stateSync(() => this.native.scan("forward")),
      (entry) => entry[0],
    );
  }

  /**
   * Opens an async iterator over the live values in forward key order. Valid
   * only within the handler invocation (attempt) that opened it.
   * @returns {AsyncIterableIterator<*>} The values iterator.
   */
  values() {
    return stateIterator(
      stateSync(() => this.native.scan("forward")),
      (entry) => entry[1],
    );
  }

  /**
   * Forward iteration over `[key, value]` entries — equivalent to
   * `entries("forward")`. Valid only within the handler invocation (attempt).
   * @returns {AsyncIterableIterator<[string, *]>} The entries iterator.
   */
  [Symbol.asyncIterator]() {
    return this.entries();
  }

  /**
   * Durably commits the buffered operations mid-handler (at-least-once; the
   * committed floor survives a later rollback or a failed event).
   * @returns {Promise<void>} Resolves with no value — the erased seam drops the outcome.
   * @throws {PermanentStateError|TransientStateError} On a categorized commit failure.
   */
  commit() {
    return stateOp((carrier) => this.native.commit(carrier));
  }

  /**
   * Discards buffered uncommitted operations back to the last committed floor.
   * @returns {Promise<void>} Resolves with no value.
   */
  rollback() {
    return stateOp((carrier) => this.native.rollback(carrier));
  }
}

/**
 * Typed handle over a double-ended-queue keyed-state collection, vended by
 * {@link Context#state}. Every method opens its own per-operation span. Handles
 * and iterators are valid only within the handler invocation (attempt) that
 * vended them.
 */
class DequeState {
  /**
   * @param {import('./bindings').NativeDequeState} native - The vended native handle.
   */
  constructor(native) {
    this.native = native;
  }

  /**
   * Appends an element at the back. Writing JSON `null` is rejected with a
   * {@link PermanentStateError}.
   * @param {*} item - The element to append.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On null/shape/store failure.
   */
  push(item) {
    return stateOp((carrier) => this.native.pushBack(item, carrier));
  }

  /**
   * Prepends an element at the front. Writing JSON `null` is rejected with a
   * {@link PermanentStateError}.
   * @param {*} item - The element to prepend.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On null/shape/store failure.
   */
  unshift(item) {
    return stateOp((carrier) => this.native.pushFront(item, carrier));
  }

  /**
   * Removes and returns the back element.
   * @returns {Promise<*|null>} The removed element, or null when empty.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  pop() {
    return stateOp((carrier) => this.native.popBack(carrier));
  }

  /**
   * Removes and returns the front element.
   * @returns {Promise<*|null>} The removed element, or null when empty.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  shift() {
    return stateOp((carrier) => this.native.popFront(carrier));
  }

  /**
   * Returns the number of live elements.
   * @returns {Promise<number>} The element count.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  length() {
    return stateOp((carrier) => this.native.len(carrier));
  }

  /**
   * Reports whether the deque holds no live elements.
   * @returns {Promise<boolean>} True when the deque is empty.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  isEmpty() {
    return stateOp((carrier) => this.native.isEmpty(carrier));
  }

  /**
   * Reads the element at front-relative position `index`.
   *
   * `index` must be a non-negative integer. A fractional or negative number is
   * rejected with a {@link PermanentStateError}: the native `u32` argument
   * conversion would otherwise silently truncate `1.5` to `1` and wrap `-1` to a
   * huge index, so this guard types the argument at the boundary rather than
   * letting a mistaken index read the wrong element. A value above
   * `4294967295` (`u32::MAX`) is rejected for the same reason — it would wrap
   * modulo 2^32 and read the wrong element.
   * @param {number} index - The zero-based position from the front.
   * @returns {Promise<*|null>} The element, or null past the end.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  get(index) {
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
      return Promise.reject(
        new PermanentStateError(
          `get: index must be an integer in [0, 4294967295], got ${index}`,
        ),
      );
    }
    return stateOp((carrier) => this.native.get(index, carrier));
  }

  /**
   * Opens an async iterator over the live elements in index order. Valid only
   * within the handler invocation (attempt) that opened it; early exit closes
   * the underlying cursor.
   * @param {"forward"|"backward"} [direction="forward"] - The scan direction.
   * @returns {AsyncIterableIterator<*>} The values iterator.
   * @throws {PermanentStateError} If the direction token is invalid.
   */
  values(direction = "forward") {
    return stateIterator(
      stateSync(() => this.native.scan(direction)),
      (item) => item,
    );
  }

  /**
   * Forward iteration over the elements — equivalent to `values("forward")`.
   * Valid only within the handler invocation (attempt).
   * @returns {AsyncIterableIterator<*>} The values iterator.
   */
  [Symbol.asyncIterator]() {
    return this.values();
  }

  /**
   * Durably commits the buffered operations mid-handler (at-least-once; the
   * committed floor survives a later rollback or a failed event).
   * @returns {Promise<void>} Resolves with no value — the erased seam drops the outcome.
   * @throws {PermanentStateError|TransientStateError} On a categorized commit failure.
   */
  commit() {
    return stateOp((carrier) => this.native.commit(carrier));
  }

  /**
   * Discards buffered uncommitted operations back to the last committed floor.
   * @returns {Promise<void>} Resolves with no value.
   */
  rollback() {
    return stateOp((carrier) => this.native.rollback(carrier));
  }
}

/**
 * Context class that automatically injects OpenTelemetry context for all operations.
 * This wraps the native Context with automatic OTEL context propagation.
 */
class Context {
  constructor(nativeContext) {
    this.nativeContext = nativeContext;
    // Cache of vended state wrappers, keyed by collection name (names are
    // unique per registration), so repeated state(def) calls within one event
    // return the same handle.
    this.stateHandles = new Map();
  }

  /**
   * Checks whether cancellation has been signaled.
   * Cancellation includes both message-level cancellation (e.g., timeout) and partition shutdown.
   * @returns {boolean} True if cancellation was requested, otherwise false.
   */
  get shouldCancel() {
    return this.nativeContext.shouldCancel;
  }

  /**
   * Waits for a cancellation signal.
   * Cancellation includes both message-level cancellation (e.g., timeout) and partition shutdown.
   * @returns {Promise<void>} A promise that resolves when cancellation is signaled.
   */
  async onCancel() {
    return this.nativeContext.onCancel();
  }

  /**
   * Schedule a timer at the given time.
   * @param {Date} time - The UTC timestamp to schedule.
   * @returns {Promise<void>} A promise that resolves when the timer has been scheduled.
   * @throws {Error} If time conversion or scheduling fails.
   */
  async schedule(time) {
    return this.nativeContext.schedule(time, injectedCarrier());
  }

  /**
   * Clear existing timers and schedule a new one at the given time.
   * @param {Date} time - The UTC timestamp to schedule.
   * @returns {Promise<void>} A promise that resolves when the timer has been scheduled.
   * @throws {Error} If time conversion or scheduling fails.
   */
  async clearAndSchedule(time) {
    return this.nativeContext.clearAndSchedule(time, injectedCarrier());
  }

  /**
   * Unschedules the timer for the specified time.
   * @param {Date} time - The time to unschedule.
   * @returns {Promise<void>} A promise that resolves when the timer has been unscheduled.
   * @throws {Error} If unscheduling fails.
   */
  async unschedule(time) {
    return this.nativeContext.unschedule(time, injectedCarrier());
  }

  /**
   * Clears all scheduled timers.
   * @returns {Promise<void>} A promise that resolves when all timers have been cleared.
   * @throws {Error} If clearing schedules fails.
   */
  async clearScheduled() {
    return this.nativeContext.clearScheduled(injectedCarrier());
  }

  /**
   * Retrieves all scheduled times.
   * @returns {Promise<Date[]>} An array of scheduled times as Date objects.
   * @throws {Error} If retrieval fails.
   */
  async scheduled() {
    return this.nativeContext.scheduled(injectedCarrier());
  }

  /**
   * Binds a registered keyed-state collection for this event and returns a
   * typed handle over it.
   *
   * Pass a definition built by one of the definition constructors ({@link value},
   * {@link map}, {@link deque}, {@link messageValue}, {@link messageMap},
   * {@link messageDeque}) — the same frozen object placed in
   * `Configuration.stateCollections`. The returned handle (and any iterator it
   * opens) is scoped to this single event attempt; do not retain it past the
   * handler invocation. Handles are cached per context by definition identity
   * (kind, payload, and name), so repeated calls for the same definition return
   * the same wrapper; a mismatched definition reusing a name misses the cache
   * and is rejected core-side at vend.
   *
   * @param {object} definition - A frozen definition from a definition constructor.
   * @returns {ValueState|MapState|DequeState} The typed state handle.
   * @throws {PermanentStateError} If the collection name is unregistered, its
   *   registered identity (kind/payload) mismatches, or the kind is unknown.
   */
  state(definition) {
    const cacheKey = `${definition.kind}:${definition.payload}:${definition.name}`;
    const cached = this.stateHandles.get(cacheKey);
    if (cached !== undefined) return cached;
    const message = definition.payload === "message";
    let handle;
    switch (definition.kind) {
      case "value":
        handle = new ValueState(
          stateSync(() =>
            message
              ? this.nativeContext.messageValueState(definition.name)
              : this.nativeContext.valueState(definition.name),
          ),
        );
        break;
      case "map":
        handle = new MapState(
          stateSync(() =>
            message
              ? this.nativeContext.messageMapState(definition.name)
              : this.nativeContext.mapState(definition.name),
          ),
        );
        break;
      case "deque":
        handle = new DequeState(
          stateSync(() =>
            message
              ? this.nativeContext.messageDequeState(definition.name)
              : this.nativeContext.dequeState(definition.name),
          ),
        );
        break;
      default:
        throw new PermanentStateError(
          `state: unknown collection kind ${JSON.stringify(definition.kind)}`,
        );
    }
    this.stateHandles.set(cacheKey, handle);
    return handle;
  }
}

module.exports = {
  ConsumerState,
  Context,
  DequeState,
  EventHandlerError,
  MapState,
  Mode,
  PermanentError,
  PermanentStateError,
  ProsodyClient,
  TransientError,
  TransientStateError,
  ValueState,
  deque,
  getCurrentLogger,
  initialize,
  isStateError,
  loggerIsSet,
  map,
  messageDeque,
  messageMap,
  messageValue,
  permanent,
  setLogger,
  setLoggerIfUnset,
  transient,
  value,
};
