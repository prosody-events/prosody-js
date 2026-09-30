/**
 * The handler error classes, the state error classes, and the error decorators.
 * @module lib/errors
 * @private
 */

const { types } = require("node:util");

/** Base class for event handler errors. */
class EventHandlerError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
  }

  get isPermanent() {
    throw new Error("Subclasses must implement isPermanent");
  }
}

/** An event handler error that a retry can resolve. */
class TransientError extends EventHandlerError {
  get isPermanent() {
    return false;
  }
}

/** An event handler error that no retry can resolve. */
class PermanentError extends EventHandlerError {
  get isPermanent() {
    return true;
  }
}

/** A keyed-state failure that a later attempt can resolve. */
class TransientStateError extends TransientError {}

/** A keyed-state failure that no retry in this process can resolve. */
class PermanentStateError extends PermanentError {}

const STATE_ERROR_NAMES = new Set([
  "PermanentStateError",
  "TransientStateError",
]);

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
      if (context.kind !== "method") {
        throw new TypeError(`@${ErrorClass.name} can only decorate methods`);
      }

      function handleError(error) {
        if (exceptionTypes.some((type) => error instanceof type)) {
          return new ErrorClass(error.message, { cause: error });
        }
        return error;
      }

      // A method that returns a promise is classified the same way whether
      // or not it is a native async function, because a transpiler can
      // compile an async method into a plain function.
      return function (...args) {
        let result;
        try {
          result = originalMethod.apply(this, args);
        } catch (error) {
          throw handleError(error);
        }
        if (typeof result?.then !== "function") return result;
        return result.then(undefined, (error) => {
          throw handleError(error);
        });
      };
    };
  };
}

const transient = createErrorDecorator(TransientError);

const permanent = createErrorDecorator(PermanentError);

module.exports = {
  EventHandlerError,
  PermanentError,
  PermanentStateError,
  TransientError,
  TransientStateError,
  isStateError,
  permanent,
  transient,
};
