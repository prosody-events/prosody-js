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
  Message: NativeMessage,
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
   * Opens a read-only view of another consumer group's published collection.
   * @param {string} subsystem - The publisher's subsystem.
   * @param {Readonly<object>} definition - A JSON value, map, or deque definition.
   * @returns {Promise<PublishedValue|PublishedMap|PublishedDeque>} The reader.
   */
  async state(subsystem, definition) {
    const access = stateDefinitionAccess.get(definition);
    if (access?.published === undefined) {
      throw new TypeError(
        "definition must be a JSON value, map, or deque definition",
      );
    }
    const readCache = definition.readCache;
    return access.published(
      this.nativeClient,
      subsystem,
      definition.name,
      readCache && readCache.ttlMs,
      readCache === false,
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

    await this.nativeClient.send(
      topic,
      key,
      toJson(payload, TransientError),
      eventMetadata(payload),
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
              await onMessage(
                context,
                withParsedPayload(message),
                controller.signal,
              );
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
 * Represents a transient keyed-state failure that may succeed on a later
 * attempt — a store read/write timeout, AND every caller mistake (a
 * null/unrepresentable write, an item-shape mismatch, an out-of-range index, an
 * invalid scan direction). Caller mistakes are transient on purpose: retrying
 * keeps the failure visible and never discards the message (see the
 * error-classification rule in CLAUDE.md). Thrown by state handles and scan
 * iterators. Because it subclasses {@link TransientError}, rethrowing it from a
 * handler classifies the event transient through the existing error bridge with
 * no bridge change.
 * @extends TransientError
 */
class TransientStateError extends TransientError {}

/**
 * Represents a permanent keyed-state failure — one a retry cannot resolve in
 * the running process: an unregistered collection name, a registered-identity
 * mismatch, or a duplicate registration. Caller mistakes (a null/unrepresentable
 * write, an item-shape mismatch, a bad index, an invalid direction) are NOT
 * permanent — they are {@link TransientStateError} so they retry and stay
 * visible rather than discarding the message (see the error-classification rule
 * in CLAUDE.md). A handler may also throw this to declare its own failure
 * permanent. Because it subclasses {@link PermanentError}, rethrowing it from a
 * handler classifies the event permanent through the existing error bridge with
 * no bridge change.
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
 * operation. Native glue activates the carrier without recording a binding
 * span, so the core semantic operation span joins the JavaScript trace directly.
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
/**
 * Renders a value for a diagnostic message without ever throwing. `JSON.stringify`
 * throws on a BigInt or a cyclic object and a template literal throws on a
 * Symbol, so interpolating a hostile argument directly would raise a raw
 * `TypeError` — bypassing the promise/state-error contract. Falls back to the
 * value's `typeof` when it cannot be serialized.
 * @param {*} value - The value to describe.
 * @returns {string} A safe, human-readable rendering.
 * @private
 */
function describeValue(value) {
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? typeof value : rendered;
  } catch {
    return typeof value;
  }
}

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
 * @param {object} [options] - Optional ttlSeconds / readUncommitted, map-only
 *   keysetLimit, and deque-only capacity.
 * @returns {Readonly<object>} The frozen definition.
 * @private
 */
const stateDefinitionAccess = new WeakMap();
const VALUE_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new ValueState(context.valueState(collection), jsonItems),
  published: async (client, subsystem, collection, ttl, disabled) =>
    new PublishedValue(
      await client.publishedValue(subsystem, collection, ttl, disabled),
    ),
});
const MAP_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new MapState(context.mapState(collection), jsonItems),
  published: async (client, subsystem, collection, ttl, disabled) =>
    new PublishedMap(
      await client.publishedMap(subsystem, collection, ttl, disabled),
    ),
});
const DEQUE_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new DequeState(context.dequeState(collection), jsonItems),
  published: async (client, subsystem, collection, ttl, disabled) =>
    new PublishedDeque(
      await client.publishedDeque(subsystem, collection, ttl, disabled),
    ),
});
const MESSAGE_VALUE_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new ValueState(context.messageValueState(collection), messageItems),
});
const MESSAGE_MAP_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new MapState(context.messageMapState(collection), messageItems),
});
const MESSAGE_DEQUE_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new DequeState(context.messageDequeState(collection), messageItems),
});

function stateDefinition(name, kind, payload, access, options = {}) {
  const definition = { name, kind, payload };
  if (options.ttlSeconds !== undefined)
    definition.ttlSeconds = options.ttlSeconds;
  if (options.readUncommitted !== undefined)
    definition.readUncommitted = options.readUncommitted;
  if (options.published !== undefined) definition.published = options.published;
  if (options.readCache !== undefined) definition.readCache = options.readCache;
  if (options.keysetLimit !== undefined)
    definition.keysetLimit = options.keysetLimit;
  if (options.capacity !== undefined) definition.capacity = options.capacity;
  const frozen = Object.freeze(definition);
  stateDefinitionAccess.set(frozen, access);
  return frozen;
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
  return stateDefinition(name, "value", "json", VALUE_ACCESS, options);
}

/**
 * Declares an ordered-map JSON collection. Map keys are always strings; the
 * type parameter annotates the stored value (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds`, `readUncommitted`, and map-only `keysetLimit`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function map(name, options) {
  return stateDefinition(name, "map", "json", MAP_ACCESS, options);
}

/**
 * Declares a double-ended-queue JSON collection. The type parameter annotates
 * the stored element (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds` (whole seconds), `readUncommitted`,
 *   and deque-only `capacity` (bounded backlog; enforced lazily on push).
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function deque(name, options) {
  return stateDefinition(name, "deque", "json", DEQUE_ACCESS, options);
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
  return stateDefinition(
    name,
    "value",
    "message",
    MESSAGE_VALUE_ACCESS,
    options,
  );
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
  return stateDefinition(name, "map", "message", MESSAGE_MAP_ACCESS, options);
}

/**
 * Declares a double-ended-queue message collection: each stored element is the
 * full Kafka {@link Message}. The type parameter annotates the message payload
 * (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds` (whole seconds), `readUncommitted`,
 *   and deque-only `capacity` (bounded backlog; enforced lazily on push).
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function messageDeque(name, options) {
  return stateDefinition(
    name,
    "deque",
    "message",
    MESSAGE_DEQUE_ACCESS,
    options,
  );
}

/**
 * Adapts a chunked native scan cursor to the item-oriented JS async-iterator
 * protocol. A fresh carrier is propagated per native chunk without recording
 * a span, while individual `next()` calls drain the retained chunk without
 * crossing N-API.
 * Native `null` (exhausted) maps to `{ done: true }`. Early exit from a `for await` loop
 * (`break`/`return`/`throw`) invokes `return()`, which awaits the native
 * `close()`; exhaustion and a pull error also close the cursor. Once finished,
 * the cursor is never touched again. A pull error is never masked by the
 * cleanup close (that close is best-effort). A close failure on the exhaustion
 * or early-exit path is normalized through `toStateError`, so every keyed-state
 * failure a caller can observe is a `PermanentStateError`/`TransientStateError`.
 *
 * Owned cursors remain attempt-fenced. Published cursors remain valid with
 * their standalone reader.
 * @param {object|(() => Promise<object>)} source - The native scan cursor, or
 *   a lazy asynchronous cursor opener.
 * @param {(item: *) => *} transform - Maps each raw item to the yielded value.
 * @returns {AsyncIterableIterator<*>} The async iterator.
 * @private
 */
function stateIterator(source, transform) {
  let cursor;
  let finished = false;
  let chunk = [];
  let offset = 0;
  let queue = Promise.resolve();
  const openCursor = async () => {
    if (cursor === undefined) {
      cursor = typeof source === "function" ? await source() : source;
    }
    return cursor;
  };
  // Serialize the complete iterator protocol, not just native pulls. Without
  // this queue, concurrent next() continuations can both reset `offset` after
  // awaiting the same chunk and yield the same first item. return() shares the
  // queue so it cannot close the cursor underneath an active next().
  const enqueue = (operation) => {
    const result = queue.then(operation, operation);
    // A rejected operation must not poison later cleanup or done checks.
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  // Best-effort close used after a pull or transform failure: it must never
  // mask the primary error. `try/catch` (not `.catch()`) so a synchronous throw
  // from `close()` is swallowed too.
  const closeQuietly = async () => {
    if (cursor === undefined) return;
    try {
      await cursor.close();
    } catch {
      /* the primary error is already propagating */
    }
  };
  // Close on clean exhaustion / early exit, where there is no primary error to
  // mask: a close failure surfaces through the state-error model.
  const closeOrThrow = async () => {
    if (cursor === undefined) return;
    try {
      await cursor.close();
    } catch (error) {
      throw toStateError(error);
    }
  };
  return {
    next() {
      return enqueue(async () => {
        if (finished) return { value: undefined, done: true };
        while (offset >= chunk.length) {
          chunk = [];
          offset = 0;
          try {
            chunk = await (await openCursor()).nextChunk(injectedCarrier());
          } catch (error) {
            finished = true;
            await closeQuietly();
            throw toStateError(error);
          }
          if (chunk === null) {
            chunk = [];
            finished = true;
            await closeOrThrow();
            return { value: undefined, done: true };
          }
        }
        const item = chunk[offset];
        // Release consumed values even while the rest of a large chunk remains.
        chunk[offset] = undefined;
        offset += 1;
        try {
          return { value: transform(item), done: false };
        } catch (error) {
          // A transform failure is a binding defect, not a store error; close the
          // cursor and mark the iterator done rather than leaving it live.
          finished = true;
          await closeQuietly();
          throw error;
        }
      });
    },
    return(value) {
      return enqueue(async () => {
        if (!finished) {
          finished = true;
          chunk = [];
          offset = 0;
          await closeOrThrow();
        }
        return { value, done: true };
      });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * Read-only handle over a published single-value collection. It is independent
 * of subscription and remains valid for the lifetime of its client.
 */
class PublishedValue {
  constructor(native) {
    this.native = native;
  }

  async get(key) {
    return jsonItems.decode(
      await stateOp((carrier) => this.native.get(key, carrier)),
    );
  }
}

class PublishedMap {
  constructor(native) {
    this.native = native;
  }

  async get(key, mapKey) {
    return jsonItems.decode(
      await stateOp((carrier) => this.native.get(key, mapKey, carrier)),
    );
  }

  async getMany(key, mapKeys) {
    const values = await stateOp((carrier) =>
      this.native.getMany(key, mapKeys, carrier),
    );
    return values.map(jsonItems.decode);
  }

  has(key, mapKey) {
    return stateOp((carrier) => this.native.contains(key, mapKey, carrier));
  }

  entries(key, direction = "forward") {
    return stateIterator(
      () => stateOp((carrier) => this.native.scan(key, direction, carrier)),
      ([mapKey, value]) => [mapKey, jsonItems.decode(value)],
    );
  }

  keys(key, direction = "forward") {
    return stateIterator(
      () => stateOp((carrier) => this.native.keys(key, direction, carrier)),
      (mapKey) => mapKey,
    );
  }

  values(key, direction = "forward") {
    return stateIterator(
      () => stateOp((carrier) => this.native.scan(key, direction, carrier)),
      (entry) => jsonItems.decode(entry[1]),
    );
  }
}

/**
 * The native `payload` getter, which answers the raw JSON text read from the
 * wire. Captured before {@link withParsedPayload} shadows it per instance.
 * @private
 */
const rawPayload = Object.getOwnPropertyDescriptor(
  NativeMessage.prototype,
  "payload",
).get;

/**
 * Replaces a message's raw-text `payload` with the parsed document.
 *
 * Rust hands the payload across as the bytes it read from the wire, never
 * parsing them; the parse happens here, on first read, and the result is kept.
 * A handler that only inspects metadata therefore never pays for one.
 *
 * A payload that is not JSON raises a permanent error: no retry makes bytes
 * parse. Reading `payload` is where that surfaces, since nothing before it
 * looks at the document. That outcome is kept too, so a handler reading a bad
 * payload twice re-raises rather than re-parsing.
 * @param {object} message - The native message.
 * @returns {object} The same message, with `payload` parsed on demand.
 * @private
 */
function withParsedPayload(message) {
  let document;
  let failure;
  let parsed = false;
  // Not enumerable, matching the five native getters: none of a message's
  // fields are own properties, so spread, `Object.keys`, and `JSON.stringify`
  // see none of them. An enumerable own `payload` would make `JSON.stringify`
  // of a message serialize the whole parsed document.
  Object.defineProperty(message, "payload", {
    configurable: true,
    enumerable: false,
    get() {
      if (!parsed) {
        try {
          document = parseJson(
            rawPayload.call(this),
            PermanentError,
            "message payload is not JSON",
          );
        } catch (error) {
          failure = error;
        }
        parsed = true;
      }
      if (failure !== undefined) throw failure;
      return document;
    },
  });
  return message;
}

/**
 * Serializes a value, mapping the two ways `JSON.stringify` can fail onto the
 * caller's error class.
 *
 * It answers `undefined` for a function, a symbol, or `undefined` itself, and
 * throws outright on a BigInt or a cycle.
 * @param {*} value - The value to serialize.
 * @param {Function} ErrorClass - The error to raise on failure.
 * @returns {string} The JSON text.
 * @private
 */
function toJson(value, ErrorClass) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new ErrorClass(
      `value is not representable as JSON: ${error.message}`,
    );
  }
  if (json === undefined) {
    throw new ErrorClass(
      "value is not representable as JSON (functions, symbols, and " +
        "`undefined` have no JSON form)",
    );
  }
  return json;
}

/** Parses JSON text and maps invalid input onto the caller's error class. */
function parseJson(text, ErrorClass, context) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ErrorClass(`${context}: ${error.message}`);
  }
}

/**
 * Serializes a value for a JSON collection.
 *
 * A collection stores whatever JSON it is given, so the only rejections here
 * are values with no JSON form at all. Both are caller mistakes and reject
 * transient: the event retries and the mistake stays visible rather than
 * discarding the message.
 *
 * Everything else follows `JSON.stringify`, which is now the serializer of
 * record. Inside a container a function-valued property is dropped and an
 * `undefined` element becomes `null`. `NaN` and the infinities become `null`
 * anywhere they appear. A `toJSON` method decides what its value serializes to.
 * The previous Rust-side conversion rejected each of those instead.
 * @param {*} value - The value to store.
 * @returns {string} The document's JSON text.
 * @throws {TransientStateError} If the value has no JSON representation.
 * @private
 */
function encodeJson(value) {
  if (value instanceof NativeMessage) {
    throw new TransientStateError(
      "a Kafka message cannot be stored in a JSON collection; declare it with " +
        "messageValue/messageMap/messageDeque instead",
    );
  }
  return toJson(value, TransientStateError);
}

/**
 * Reads the event metadata a payload carries.
 *
 * When the payload is an object with a string `id` or `type`, prosody uses
 * them. Anything else carries no metadata. Each field is read once, so a getter
 * that answers differently on a second read cannot make the metadata disagree
 * with itself.
 * @param {*} payload - The payload about to be sent.
 * @returns {{eventId?: string, eventType?: string}} The metadata.
 * @private
 */
function eventMetadata(payload) {
  const id = payload?.id;
  const type = payload?.type;
  return {
    eventId: typeof id === "string" ? id : undefined,
    eventType: typeof type === "string" ? type : undefined,
  };
}

/**
 * Checks that a message collection is being handed an actual message.
 *
 * A message collection stores the Kafka message itself, so it accepts only a
 * `Message` — an object merely shaped like one is rejected. A message read back
 * out of a collection is a `Message` and stores fine.
 * What it stores is the message's own wire bytes, so assigning to a message's
 * fields, or mutating its parsed `payload`, does not change what is written.
 * @param {*} value - The value to store.
 * @returns {object} The message.
 * @throws {TransientStateError} If the value is not a Kafka message.
 * @private
 */
function requireMessage(value) {
  if (!(value instanceof NativeMessage)) {
    throw new TransientStateError(
      "expected a Kafka message; a JSON value cannot be stored in a message collection",
    );
  }
  return value;
}

/**
 * Builds the item codec for one collection payload flavour.
 *
 * Native names each write verb after the flavour it accepts — `setJson` versus
 * `setMessage` — so one factory covers both: `encode` prepares an item for the
 * wire and `flavour` selects the verb. The definition's payload picks a codec
 * when the handle is vended, so no operation tests the flavour again.
 * @param {string} flavour - `"Json"` or `"Message"`, the native verb suffix.
 * @param {(item: *) => *} encode - Prepares an item for a write.
 * @param {(item: *) => *} decode - Turns a read item into what the caller asked for.
 * @returns {Readonly<object>} The frozen codec.
 * @private
 */
function itemCodec(flavour, encode, decode) {
  const set = `set${flavour}`;
  const pushBack = `pushBack${flavour}`;
  const pushFront = `pushFront${flavour}`;
  return Object.freeze({
    decode: (item) => (item === null ? null : decode(item)),
    set: (native, item, carrier) => native[set](encode(item), carrier),
    setKey: (native, key, item, carrier) =>
      native[set](key, encode(item), carrier),
    pushBack: (native, item, carrier) =>
      native[pushBack](encode(item), carrier),
    pushFront: (native, item, carrier) =>
      native[pushFront](encode(item), carrier),
  });
}

class PublishedDeque {
  constructor(native) {
    this.native = native;
  }

  length(key) {
    return stateOp((carrier) => this.native.length(key, carrier));
  }

  isEmpty(key) {
    return stateOp((carrier) => this.native.isEmpty(key, carrier));
  }

  async at(key, index) {
    if (!Number.isSafeInteger(index)) {
      throw new TransientStateError(
        `at: index must be a safe integer, got ${describeValue(index)}`,
      );
    }
    if (index === 0) {
      return jsonItems.decode(
        await stateOp((carrier) => this.native.peekFront(key, carrier)),
      );
    }
    if (index === -1) {
      return jsonItems.decode(
        await stateOp((carrier) => this.native.peekBack(key, carrier)),
      );
    }
    let position = index;
    if (position < 0) {
      position += await this.length(key);
      if (position < 0) return null;
    }
    if (position > 0xffffffff) return null;
    return jsonItems.decode(
      await stateOp((carrier) => this.native.get(key, position, carrier)),
    );
  }

  values(key, direction = "forward") {
    return stateIterator(
      () => stateOp((carrier) => this.native.scan(key, direction, carrier)),
      jsonItems.decode,
    );
  }
}

/** JSON documents cross as their text. @private */
const jsonItems = itemCodec("Json", encodeJson, (text) =>
  parseJson(
    text,
    PermanentStateError,
    "stored JSON document could not be parsed",
  ),
);

/** Kafka messages cross as the `Message` object itself. @private */
const messageItems = itemCodec("Message", requireMessage, withParsedPayload);

/**
 * What every keyed-state handle shares: the native handle it wraps, the item
 * codec for its payload flavour, and the two transaction verbs.
 *
 * Core records one semantic span per operation; this binding propagates context
 * without adding an N-API span. Handles are valid only within the handler
 * invocation (attempt) that vended them.
 */
class StateHandle {
  /**
   * @param {object} native - The vended native handle.
   * @param {object} items - The item codec for the collection's payload flavour.
   */
  constructor(native, items) {
    this.native = native;
    this.items = items;
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
 * Typed handle over a single-value keyed-state collection, vended by
 * {@link Context#state}. Core records one semantic span per operation; this
 * binding propagates context without adding an N-API span. Handles are valid
 * only within the handler invocation (attempt) that vended them.
 */
class ValueState extends StateHandle {
  /**
   * Reads the current value.
   * @returns {Promise<*|null>} The stored value, or null when absent/cleared.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  get() {
    return stateOp((carrier) => this.native.get(carrier)).then(
      this.items.decode,
    );
  }

  /**
   * Buffers a write of the value. Writing JSON `null` (or an unrepresentable
   * value) is a caller mistake, rejected with a {@link TransientStateError}
   * naming `clear()` — use {@link ValueState#clear} to delete instead. The
   * error is transient so it retries and stays visible rather than discarding
   * the message and losing data.
   * @param {*} value - The value to store.
   * @returns {Promise<void>}
   * @throws {TransientStateError} On a null/unrepresentable/shape mistake or a
   *   transient store failure; {@link PermanentStateError} only if the store
   *   reports one.
   */
  set(value) {
    return stateOp((carrier) => this.items.set(this.native, value, carrier));
  }

  /**
   * Deletes the stored value.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  clear() {
    return stateOp((carrier) => this.native.clear(carrier));
  }
}

/**
 * Typed handle over an ordered-map keyed-state collection, vended by
 * {@link Context#state}. Map keys are always strings. Core records one semantic
 * span per operation; this binding propagates context without adding an N-API
 * span. Handles and iterators are valid only within the handler invocation.
 */
class MapState extends StateHandle {
  /**
   * Reads the value for `key`.
   * @param {string} key - The map key.
   * @returns {Promise<*|null>} The value, or null when the key is absent.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  get(key) {
    return stateOp((carrier) => this.native.get(key, carrier)).then(
      this.items.decode,
    );
  }

  /**
   * Reads several keys in a single call. Returns an array with one entry per
   * key, in the same order you asked, so `result[i]` is the value for
   * `keys[i]`. A key that isn't there comes back as `null`, and a key you list
   * more than once is answered at each spot. The whole read happens as one
   * step, so no other change to this event's state can slip in partway through.
   * @param {string[]} keys - The keys to read, in order.
   * @returns {Promise<Array<*|null>>} One entry per key, in the order asked.
   * @throws {PermanentStateError|TransientStateError} If the read fails.
   */
  getMany(keys) {
    return stateOp((carrier) => this.native.getMany(keys, carrier)).then(
      (items) => items.map(this.items.decode),
    );
  }

  /**
   * Reports whether `key` currently has a stored value. A presence check that
   * skips the value decode and the resolver: for a message-backed map it
   * answers with zero Kafka fetches and can report `true` for a message that
   * can no longer be fetched. Not zero-I/O — a cache miss can still reach the
   * store — but cheaper than {@link MapState#get} when you only need presence.
   * @param {string} key - The map key.
   * @returns {Promise<boolean>} True when the key is present.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  has(key) {
    return stateOp((carrier) => this.native.contains(key, carrier));
  }

  /**
   * Inserts or overwrites `key`. Writing JSON `null` (or an unrepresentable
   * value) is a caller mistake, rejected with a {@link TransientStateError} —
   * use {@link MapState#delete} to remove an entry instead. The error is
   * transient so it retries and stays visible rather than discarding the
   * message and losing data.
   * @param {string} key - The map key.
   * @param {*} value - The value to store.
   * @returns {Promise<void>}
   * @throws {TransientStateError} On a null/unrepresentable/shape mistake or a
   *   transient store failure; {@link PermanentStateError} only if the store
   *   reports one.
   */
  set(key, value) {
    return stateOp((carrier) =>
      this.items.setKey(this.native, key, value, carrier),
    );
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
   * @throws {TransientStateError} If the direction token is invalid (a caller
   *   mistake — retries, not discarded).
   */
  entries(direction = "forward") {
    return stateIterator(
      stateSync(() => this.native.scan(direction, injectedCarrier())),
      ([key, item]) => [key, this.items.decode(item)],
    );
  }

  /**
   * Opens an async iterator over the live keys in key order. Skips the value
   * decode and the resolver, so a message-backed map enumerates keys with zero
   * Kafka fetches; it still reads presence, so it is not zero-I/O. Valid only
   * within the handler invocation (attempt) that opened it; early exit closes
   * the underlying cursor.
   * @param {"forward"|"backward"} [direction="forward"] - The scan direction.
   * @returns {AsyncIterableIterator<string>} The keys iterator.
   * @throws {TransientStateError} If the direction token is invalid (a caller
   *   mistake — retries, not discarded).
   */
  keys(direction = "forward") {
    return stateIterator(
      stateSync(() => this.native.keys(direction, injectedCarrier())),
      (key) => key,
    );
  }

  /**
   * Opens an async iterator over the live values in key order. Valid only
   * within the handler invocation (attempt) that opened it; early exit closes
   * the underlying cursor.
   * @param {"forward"|"backward"} [direction="forward"] - The scan direction.
   * @returns {AsyncIterableIterator<*>} The values iterator.
   * @throws {TransientStateError} If the direction token is invalid (a caller
   *   mistake — retries, not discarded).
   */
  values(direction = "forward") {
    return stateIterator(
      stateSync(() => this.native.scan(direction, injectedCarrier())),
      ([, item]) => this.items.decode(item),
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
}

/**
 * Typed handle over a double-ended-queue keyed-state collection, vended by
 * {@link Context#state}. Core records one semantic span per operation; this
 * binding propagates context without adding an N-API span. Handles and
 * iterators are valid only within the handler invocation that vended them.
 */
class DequeState extends StateHandle {
  /**
   * Appends an element at the back. Writing JSON `null` is a caller mistake
   * rejected with a {@link TransientStateError}, so an uncaught handler bug
   * retries instead of committing the offset and losing the message.
   * @param {*} item - The element to append.
   * @returns {Promise<void>}
   * @throws {TransientStateError} If `item` is JSON `null` or otherwise invalid.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  push(item) {
    return stateOp((carrier) =>
      this.items.pushBack(this.native, item, carrier),
    );
  }

  /**
   * Prepends an element at the front. Writing JSON `null` is a caller mistake
   * rejected with a {@link TransientStateError}, so an uncaught handler bug
   * retries instead of committing the offset and losing the message.
   * @param {*} item - The element to prepend.
   * @returns {Promise<void>}
   * @throws {TransientStateError} If `item` is JSON `null` or otherwise invalid.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  unshift(item) {
    return stateOp((carrier) =>
      this.items.pushFront(this.native, item, carrier),
    );
  }

  /**
   * Removes and returns the back element.
   * @returns {Promise<*|null>} The removed element, or null when empty.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  pop() {
    return stateOp((carrier) => this.native.popBack(carrier)).then(
      this.items.decode,
    );
  }

  /**
   * Removes and returns the front element.
   * @returns {Promise<*|null>} The removed element, or null when empty.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  shift() {
    return stateOp((carrier) => this.native.popFront(carrier)).then(
      this.items.decode,
    );
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
   * Removes every element.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  clear() {
    return stateOp((carrier) => this.native.clear(carrier));
  }

  /**
   * Reads the element at `index`, like `Array.prototype.at`. A non-negative
   * `index` counts from the front (`0` is the front element); a negative
   * `index` counts back from the end (`-1` is the back element). Any in-range
   * position resolves to its element; any out-of-range position — including
   * every index on an empty deque — resolves to null, the same absence sentinel
   * `pop`/`shift` use.
   *
   * `index` must be a safe integer; a fractional, `NaN`, or infinite value is a
   * caller mistake, rejected with a {@link TransientStateError} so it retries
   * and stays visible rather than silently reading the wrong element (a bare
   * `u32` conversion would truncate `1.5` to `1`). The error is transient — a
   * caller mistake never discards the message.
   *
   * The endpoints `at(0)` and `at(-1)` ride the front/back peeks — a single
   * read, the same core primitive the other clients use; `at(-1)` makes no
   * length read. Any other negative index is resolved against the current
   * {@link DequeState#length}, so it makes two boundary crossings (a length
   * read, then the element read); any other non-negative index makes one.
   * Within a handler attempt the deque has a single owner, so nothing else
   * mutates it between the two reads.
   * @param {number} index - The position: front-relative if `>= 0`, else back-relative.
   * @returns {Promise<*|null>} The element, or null when the position is out of range.
   * @throws {TransientStateError} On an index mistake or a transient store
   *   failure; {@link PermanentStateError} only if the store reports one.
   */
  async at(index) {
    if (!Number.isSafeInteger(index)) {
      throw new TransientStateError(
        `at: index must be a safe integer, got ${describeValue(index)}`,
      );
    }
    if (index === 0)
      return stateOp((carrier) => this.native.peekFront(carrier)).then(
        this.items.decode,
      );
    if (index === -1)
      return stateOp((carrier) => this.native.peekBack(carrier)).then(
        this.items.decode,
      );
    let position = index;
    if (position < 0) {
      position += await this.length();
      // Still negative: the deque is shorter than |index|, so nothing is there.
      if (position < 0) return null;
    }
    // Beyond the addressable u32 range can only be past the end, never a wrap.
    if (position > 0xffffffff) return null;
    return stateOp((carrier) => this.native.get(position, carrier)).then(
      this.items.decode,
    );
  }

  /**
   * Opens an async iterator over the live elements in index order. Valid only
   * within the handler invocation (attempt) that opened it; early exit closes
   * the underlying cursor.
   * @param {"forward"|"backward"} [direction="forward"] - The scan direction.
   * @returns {AsyncIterableIterator<*>} The values iterator.
   * @throws {TransientStateError} If the direction token is invalid (a caller
   *   mistake — retries, not discarded).
   */
  values(direction = "forward") {
    return stateIterator(
      stateSync(() => this.native.scan(direction, injectedCarrier())),
      (item) => this.items.decode(item),
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
   * @throws {TransientStateError} If the definition is malformed — a missing or
   *   non-string `name`, or an unrecognized `kind`/`payload` (a caller mistake,
   *   so transient rather than a message-discarding permanent).
   * @throws {PermanentStateError} If the collection name is unregistered or its
   *   durably-registered schema (kind/payload) mismatches (rejected core-side).
   */
  state(definition) {
    const access = stateDefinitionAccess.get(definition);
    if (access === undefined) {
      throw new TransientStateError(
        "state: definition must come from a Prosody state definition constructor",
      );
    }
    const cacheKey = definition;
    const cached = this.stateHandles.get(cacheKey);
    if (cached !== undefined) return cached;
    const handle = stateSync(() =>
      access.owned(this.nativeContext, definition.name),
    );
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
  PublishedDeque,
  PublishedMap,
  PublishedValue,
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
