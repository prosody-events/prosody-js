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
      getCurrentLogger().error(
        "SENTRY_DSN is set but @sentry/node is not installed. Run: npm install @sentry/node",
      );
    } else {
      getCurrentLogger().warn("Unexpected error loading @sentry/node", err);
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

// Passes the metadata to the console only when the caller gives it.
const write = (log) => (message, metadata) =>
  metadata === undefined ? log(message) : log(message, metadata);

const defaultLogger = {
  error: write(console.error),
  warn: write(console.warn),
  info: write(console.info),
  debug: write(console.debug),
  trace: write(console.debug),
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

function getCurrentLogger() {
  return currentLogger;
}

initialize();
setLoggerInternal(transformLogger(defaultLogger));

function setLogger(logger) {
  currentLogger = logger;
  setLoggerInternal(transformLogger(logger));
}

function loggerIsSet() {
  return currentLogger !== defaultLogger;
}

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
