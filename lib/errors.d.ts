/**
 * The handler error classes, the state error classes, and the error decorators.
 * @module lib/errors
 */

/**
 * Base class for event handler errors.
 * Provides a common interface for determining if an error is permanent.
 */
export abstract class EventHandlerError extends Error {
  /**
   * @param message - The error message.
   * @param options - The standard error options, such as `cause`.
   */
  constructor(message?: string, options?: ErrorOptions);

  /**
   * Indicates whether the error is permanent and should not be retried.
   */
  abstract get isPermanent(): boolean;
}

/**
 * Represents a transient error that may be resolved by retrying.
 * These errors are temporary and the operation should be retried.
 */
export class TransientError extends EventHandlerError {
  /**
   * @returns Always false, indicating the error is not permanent.
   */
  get isPermanent(): false;
}

/**
 * Represents a permanent error that should not be retried.
 * These errors indicate unrecoverable failures.
 */
export class PermanentError extends EventHandlerError {
  /**
   * @returns Always true, indicating the error is permanent.
   */
  get isPermanent(): true;
}

/**
 * A keyed-state failure that a later attempt can resolve.
 *
 * A store timeout is transient. A caller mistake is transient too: an
 * unrepresentable write, a wrong item type, a bad index, or a bad scan
 * direction. The event then retries, so the mistake stays visible and no
 * message is discarded. It extends {@link TransientError}, so a handler that
 * rethrows it retries the event.
 */
export class TransientStateError extends TransientError {}

/**
 * A keyed-state failure that no retry in this process can resolve.
 *
 * Examples are an unregistered collection name, a registered identity that
 * does not match, a JSON `null` write, and a stored value that cannot be
 * decoded. A caller mistake
 * is a {@link TransientStateError} instead. A handler can also throw this
 * error to mark its own failure permanent. It extends {@link PermanentError},
 * so a handler that rethrows it does not retry the event.
 */
export class PermanentStateError extends PermanentError {}

/**
 * Checks whether a value is a keyed-state error of either category. It
 * matches the error `name`, so it also recognizes an error from another realm.
 *
 * @param error - The value to test.
 * @returns True when the value is a keyed-state error.
 */
export function isStateError(
  error: unknown,
): error is PermanentStateError | TransientStateError;

/** Type alias for a constructor of an Error subclass. */
type ErrorClass<T extends Error> = new (...args: never[]) => T;

/** A decorator for a class method. */
type DecoratorFunction = (
  target: Function,
  context: ClassMethodDecoratorContext,
) => Function | void;

/**
 * Decorator factory for marking errors as transient.
 * Apply it to a method. The wrapper keeps the original error as its `cause`.
 * @param exceptionTypes The error types to be treated as transient.
 */
export declare function transient<E extends Error>(
  ...exceptionTypes: ErrorClass<E>[]
): DecoratorFunction;

/**
 * Decorator factory for marking errors as permanent.
 * Apply it to a method. The wrapper keeps the original error as its `cause`.
 * @param exceptionTypes The error types to be treated as permanent.
 */
export declare function permanent<E extends Error>(
  ...exceptionTypes: ErrorClass<E>[]
): DecoratorFunction;
