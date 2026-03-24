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
      err?.code === "MODULE_NOT_FOUND" &&
      err.message?.includes("@sentry/node");
    if (isMissing) {
      getCurrentLogger()?.error(
        "SENTRY_DSN is set but @sentry/node is not installed. Run: npm install @sentry/node"
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
  error: (message, metadata) => metadata !== undefined ? console.error(message, metadata) : console.error(message),
  warn: (message, metadata) => metadata !== undefined ? console.warn(message, metadata) : console.warn(message),
  info: (message, metadata) => metadata !== undefined ? console.info(message, metadata) : console.info(message),
  debug: (message, metadata) => metadata !== undefined ? console.debug(message, metadata) : console.debug(message),
  trace: (message, metadata) => metadata !== undefined ? console.debug(message, metadata) : console.debug(message),
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
                controller.abort("message cancelled");
              }
            });

            try {
              const context = new Context(nativeContext);
              await onMessage(context, message, controller.signal);
            } catch (error) {
              getCurrentLogger()?.error("Message handler error", error.cause ?? error);
              span.recordException(error.cause ?? error);
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
                controller.abort("timer cancelled");
              }
            });

            try {
              const context = new Context(nativeContext);
              await onTimer(context, timer, controller.signal);
            } catch (error) {
              getCurrentLogger()?.error("Timer handler error", error.cause ?? error);
              span.recordException(error.cause ?? error);
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

/**
 * Creates a promise that rejects when the abort signal is triggered.
 * @param {AbortSignal} signal - The abort signal to monitor.
 * @returns {Promise<never>} A promise that rejects with the abort reason.
 * @private
 */
const onAbort = (signal) =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
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
 * Context class that automatically injects OpenTelemetry context for all operations.
 * This wraps the native Context with automatic OTEL context propagation.
 */
class Context {
  constructor(nativeContext) {
    this.nativeContext = nativeContext;
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
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);
    return this.nativeContext.schedule(time, carrier);
  }

  /**
   * Clear existing timers and schedule a new one at the given time.
   * @param {Date} time - The UTC timestamp to schedule.
   * @returns {Promise<void>} A promise that resolves when the timer has been scheduled.
   * @throws {Error} If time conversion or scheduling fails.
   */
  async clearAndSchedule(time) {
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);
    return this.nativeContext.clearAndSchedule(time, carrier);
  }

  /**
   * Unschedules the timer for the specified time.
   * @param {Date} time - The time to unschedule.
   * @returns {Promise<void>} A promise that resolves when the timer has been unscheduled.
   * @throws {Error} If unscheduling fails.
   */
  async unschedule(time) {
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);
    return this.nativeContext.unschedule(time, carrier);
  }

  /**
   * Clears all scheduled timers.
   * @returns {Promise<void>} A promise that resolves when all timers have been cleared.
   * @throws {Error} If clearing schedules fails.
   */
  async clearScheduled() {
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);
    return this.nativeContext.clearScheduled(carrier);
  }

  /**
   * Retrieves all scheduled times.
   * @returns {Promise<Date[]>} An array of scheduled times as Date objects.
   * @throws {Error} If retrieval fails.
   */
  async scheduled() {
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);
    return this.nativeContext.scheduled(carrier);
  }
}

module.exports = {
  ConsumerState,
  Context,
  EventHandlerError,
  Mode,
  PermanentError,
  ProsodyClient,
  TransientError,
  getCurrentLogger,
  initialize,
  loggerIsSet,
  permanent,
  setLogger,
  setLoggerIfUnset,
  transient,
};
