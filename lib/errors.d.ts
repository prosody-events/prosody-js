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
 * Represents a transient keyed-state failure that may succeed on a later
 * attempt — a store read/write timeout, AND every caller mistake (a
 * null/unrepresentable write, an item-shape mismatch, an out-of-range index, an
 * invalid scan direction). Caller mistakes are transient on purpose so they
 * retry and stay visible rather than discarding the message. Subclasses
 * {@link TransientError}, so rethrowing it from a handler classifies the event
 * transient through the existing error bridge unchanged.
 */
export class TransientStateError extends TransientError {}

/**
 * Represents a permanent keyed-state failure a retry cannot resolve in-process
 * — an unregistered collection name, a registered-identity mismatch, or a
 * duplicate registration (or one a handler throws explicitly). Caller mistakes
 * are NOT permanent; they are {@link TransientStateError}. Subclasses
 * {@link PermanentError}, so rethrowing it from a handler classifies the event
 * permanent through the existing error bridge unchanged.
 */
export class PermanentStateError extends PermanentError {}

/**
 * Name-branded predicate that narrows to either keyed-state error class,
 * regardless of category.
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
