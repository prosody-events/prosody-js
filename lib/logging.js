/**
 * The JavaScript logger bridge and the optional Sentry reporter.
 * @module lib/logging
 * @private
 */

const { initialize, setLogger: setLoggerInternal } = require("../bindings");

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

// The logger that handlers use. It is the default console logger until the
// application sets one.
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
setLoggerInternal(transformLogger(defaultLogger));

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
 * Checks whether the application set a logger. The default console logger
 * does not count.
 *
 * @returns {boolean} True after a call to {@link setLogger} or a successful
 *   {@link setLoggerIfUnset}.
 */
function loggerIsSet() {
  return currentLogger !== defaultLogger;
}

/**
 * Sets a JavaScript logger only if the application has not set one.
 *
 * A library that embeds Prosody can use it to supply a logger without
 * replacing the logger of the host application.
 *
 * @param {Logger} logger - The JavaScript logger object.
 * @returns {boolean} True if the logger was set, false if the application
 *   already set one.
 * @throws {Error} If creating the new JavaScript logger fails.
 */
function setLoggerIfUnset(logger) {
  if (loggerIsSet()) return false;
  setLogger(logger);
  return true;
}

module.exports = {
  captureException,
  getCurrentLogger,
  loggerIsSet,
  setLogger,
  setLoggerIfUnset,
};
