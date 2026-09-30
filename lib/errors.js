/**
 * The handler error classes, the state error classes, and the error decorators.
 * @module lib/errors
 * @private
 */

const { types } = require("node:util");

/**
 * Base class for event handler errors.
 * Provides a common interface for determining if an error is permanent.
 * @extends Error
 */
class EventHandlerError extends Error {
  /**
   * @param {string} [message] - The error message.
   * @param {ErrorOptions} [options] - The standard error options, such as
   *   `cause`.
   */
  constructor(message, options) {
    super(message, options);
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
 * A keyed-state failure that a later attempt can resolve.
 *
 * A store timeout is transient. A caller mistake is transient too: a null or
 * unrepresentable write, a wrong item type, a bad index, or a bad scan
 * direction. The event then retries, so the mistake stays visible and no
 * message is discarded. State handles and scan iterators throw it. It extends
 * {@link TransientError}, so a handler that rethrows it retries the event.
 * @extends TransientError
 */
class TransientStateError extends TransientError {}

/**
 * A keyed-state failure that no retry in this process can resolve.
 *
 * Examples are an unregistered collection name, a registered identity that
 * does not match, and a stored value that cannot be decoded. A caller mistake
 * is a {@link TransientStateError} instead. A handler can also throw this
 * error to mark its own failure permanent. It extends {@link PermanentError},
 * so a handler that rethrows it does not retry the event.
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
 * It matches the error `name`, not the class. So it also recognizes a state
 * error from another realm, such as a vm context, a worker thread, or a second
 * copy of this module.
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

/**
 * Decorator factory for marking errors as transient.
 * Apply it to a method to wrap the named error types as transient. The wrapper
 * keeps the original error as its `cause`.
 * @param {...(new(...args: never[]) => Error)} exceptionTypes - The error types to be treated as transient.
 * @returns {Function} A decorator function.
 */
const transient = createErrorDecorator(TransientError);

/**
 * Decorator factory for marking errors as permanent.
 * Apply it to a method to wrap the named error types as permanent. The wrapper
 * keeps the original error as its `cause`.
 * @param {...(new(...args: never[]) => Error)} exceptionTypes - The error types to be treated as permanent.
 * @returns {Function} A decorator function.
 */
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
