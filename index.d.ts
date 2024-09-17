import type {
  Configuration,
  ConsumerState,
  Context,
  Logger,
  Message,
  Mode,
} from "./bindings";

export { Configuration, ConsumerState, Context, Logger, Message, Mode };

export interface EventHandler {
  /**
   * Callback function to handle incoming messages.
   *
   * @param context - The context of the message processing.
   * @param message - The received Kafka message.
   * @param signal - An AbortSignal that can be used to cancel the message processing.
   * @returns A promise that resolves when the message has been processed.
   */
  onMessage: (
    context: Context,
    message: Message,
    signal: AbortSignal,
  ) => Promise<void>;
}

export declare class ProsodyClient {
  /**
   * Creates a new ProsodyClient instance.
   *
   * @param config - The configuration options for the client.
   */
  constructor(config: Configuration);

  /**
   * Gets the current state of the consumer.
   *
   * @returns The current state of the consumer.
   */
  get consumerState(): ConsumerState;

  /**
   * Sends a message to a specified Kafka topic.
   *
   * @param topic - The name of the topic to send the message to.
   * @param key - The key of the message.
   * @param payload - The message payload.
   * @param signal - An optional AbortSignal that can be used to cancel the send operation.
   * @returns A promise that resolves when the message has been sent.
   */
  send(
    topic: string,
    key: string,
    payload: any,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Subscribes to receive messages using the provided event handler.
   *
   * @param eventHandler - The event handler to process received messages.
   */
  subscribe(eventHandler: EventHandler): void;

  /**
   * Unsubscribes from receiving messages and shuts down the consumer.
   *
   * @returns A promise that resolves when the unsubscribe operation is complete.
   */
  unsubscribe(): Promise<void>;
}

/**
 * Sets a new JavaScript logger.
 *
 * @param logger - The new JavaScript logger to set.
 */
export function setLogger(logger: Logger): void;

/**
 * Base class for event handler errors.
 * Extends the standard Error class with an isPermanent property.
 */
export declare class EventHandlerError extends Error {
  /**
   * Creates a new EventHandlerError instance.
   *
   * @param message - The error message.
   */
  constructor(message: string);

  /**
   * Indicates whether the error is permanent.
   * This getter must be implemented by subclasses.
   *
   * @throws {Error} Throws an error if not implemented by a subclass.
   */
  get isPermanent(): boolean;
}

/**
 * Represents a transient error in event handling.
 * Transient errors are temporary and can be retried.
 */
export declare class TransientError extends EventHandlerError {
  /**
   * Indicates that this error is not permanent.
   *
   * @returns Always returns false.
   */
  get isPermanent(): false;
}

/**
 * Represents a permanent error in event handling.
 * Permanent errors are not temporary and should not be retried.
 */
export declare class PermanentError extends EventHandlerError {
  /**
   * Indicates that this error is permanent.
   *
   * @returns Always returns true.
   */
  get isPermanent(): true;
}

/**
 * Type definition for an error decorator function.
 * This function is used to wrap a class method and handle specific error types.
 */
type ErrorDecorator = (
  target: any,
  key: string | symbol,
  descriptor: PropertyDescriptor,
) => PropertyDescriptor;

/**
 * Type definition for a function that creates an error decorator.
 * It takes exception types as arguments and returns an ErrorDecorator.
 */
type ErrorDecoratorFactory = (
  ...exceptionTypes: (new (...args: any[]) => Error)[]
) => ErrorDecorator;

/**
 * Decorator factory for marking errors as transient.
 * Methods decorated with this will have specified exceptions wrapped as TransientErrors.
 */
export declare const transient: ErrorDecoratorFactory;

/**
 * Decorator factory for marking errors as permanent.
 * Methods decorated with this will have specified exceptions wrapped as PermanentErrors.
 */
export declare const permanent: ErrorDecoratorFactory;
