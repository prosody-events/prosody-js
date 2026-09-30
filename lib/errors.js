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
 * @param {...(new(...args: never[]) => Error)} exceptionTypes - The error types to be treated as transient.
 * @returns {Function} A decorator function.
 */
const transient = createErrorDecorator(TransientError);

/**
 * Decorator factory for marking errors as permanent.
 * Can be applied to methods to automatically wrap specified error types as permanent.
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
