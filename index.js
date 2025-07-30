const {
  context: otelContext,
  propagation,
  trace,
} = require("@opentelemetry/api");

const {
  Mode,
  NativeClient,
  ConsumerState,
  Context,
  initialize,
  loggerIsSet,
  setLogger: setLoggerInternal,
  setLoggerIfUnset: setLoggerIfUnsetInternal,
} = require("./bindings");

const defaultLogger = {
  error: (message, metadata) => console.error(message, metadata),
  warn: (message, metadata) => console.warn(message, metadata),
  info: (message, metadata) => console.info(message, metadata),
  debug: (message, metadata) => console.debug(message, metadata),
  trace: (message, metadata) => console.debug(message, metadata),
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
 * @param {Object} logger - The JavaScript logger object with error, warn, info, debug, and trace methods.
 * @param {Function} logger.error - Function for logging error messages. Called with (message, metadata).
 * @param {Function} logger.warn - Function for logging warning messages. Called with (message, metadata).
 * @param {Function} logger.info - Function for logging informational messages. Called with (message, metadata).
 * @param {Function} logger.debug - Function for logging debug messages. Called with (message, metadata).
 * @param {Function} logger.trace - Function for logging trace messages. Called with (message, metadata).
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
 * @param {Object} logger - The JavaScript logger object with error, warn, info, debug, and trace methods.
 * @param {Function} logger.error - Function for logging error messages. Called with (message, metadata).
 * @param {Function} logger.warn - Function for logging warning messages. Called with (message, metadata).
 * @param {Function} logger.info - Function for logging informational messages. Called with (message, metadata).
 * @param {Function} logger.debug - Function for logging debug messages. Called with (message, metadata).
 * @param {Function} logger.trace - Function for logging trace messages. Called with (message, metadata).
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

class ProsodyClient {
  constructor(config) {
    this.nativeClient = new NativeClient(config);
  }

  consumerState() {
    return this.nativeClient.consumerState();
  }

  assignedPartitionCount() {
    return this.nativeClient.assignedPartitionCount();
  }

  isStalled() {
    return this.nativeClient.isStalled();
  }

  async send(topic, key, payload, signal) {
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);

    await this.nativeClient.send(
      topic,
      key,
      payload,
      carrier,
      signal ? onAbort(signal) : new Promise(() => {}),
    );
  }

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

      onMessage: async (err, [context, message, carrier]) => {
        if (err) throw err;

        // Create a new context from the record
        const ctx = propagation.extract(otelContext.active(), carrier);
        await otelContext.with(ctx, async () => {
          const span = tracer.startSpan("javascript-receive");
          try {
            // register an abort controller to signal partition shutdown
            const controller = new AbortController();

            // signal abort controller on shutdown
            context
              .onShutdown()
              .then(() => {
                controller.abort("partition revoked");
                span.setAttribute("aborted", true);
              })
              .catch((error) => {
                span.recordException(error);
              });

            // process message
            await onMessage(context, message, controller.signal);
          } catch (error) {
            getCurrentLogger()?.error("Message handler error", error);
            span.recordException(error);
            throw error;
          } finally {
            span.end();
          }
        });
      },

      onTimer: async (err, [context, timer, carrier]) => {
        if (err) throw err;

        // Create a new context from the record
        const ctx = propagation.extract(otelContext.active(), carrier);
        await otelContext.with(ctx, async () => {
          const span = tracer.startSpan("javascript-timer");
          try {
            // register an abort controller to signal partition shutdown
            const controller = new AbortController();

            // signal abort controller on shutdown
            context
              .onShutdown()
              .then(() => {
                controller.abort("partition revoked");
                span.setAttribute("aborted", true);
              })
              .catch((error) => {
                span.recordException(error);
              });

            // process timer
            await onTimer(context, timer, controller.signal);
          } catch (error) {
            getCurrentLogger()?.error("Timer handler error", error);
            span.recordException(error);
            throw error;
          } finally {
            span.end();
          }
        });
      },
    });
  }

  async unsubscribe() {
    await this.nativeClient.unsubscribe();
  }
}

/**
 * @param {AbortSignal} signal
 * @return {Promise<never>}
 */
const onAbort = (signal) =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });

class EventHandlerError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }

  get isPermanent() {
    throw new Error("Subclasses must implement isPermanent");
  }
}

class TransientError extends EventHandlerError {
  get isPermanent() {
    return false;
  }
}

class PermanentError extends EventHandlerError {
  get isPermanent() {
    return true;
  }
}

// Helper function to create error decorators
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

// Create transient and permanent decorators
const transient = createErrorDecorator(TransientError);
const permanent = createErrorDecorator(PermanentError);

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
