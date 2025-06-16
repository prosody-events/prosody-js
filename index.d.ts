import type {
  Configuration,
  ConsumerState,
  Context,
  Logger,
  Message,
  Mode,
  Timer,
} from "./bindings";

export { Configuration, ConsumerState, Context, Logger, Message, Timer, Mode };

export interface EventHandler {
  /**
   * Callback function to handle incoming messages.
   *
   * @param context - The context of the message processing.
   * @param message - The received Kafka message.
   * @param signal - An AbortSignal that can be used to cancel the message processing.
   * @returns A promise that resolves when the message has been processed.
   */
  onMessage?: (
    context: Context,
    message: Message,
    signal: AbortSignal,
  ) => Promise<void>;

  /**
   * Callback function to handle timers.
   *
   * @param context - The context of the message processing.
   * @param timer - The triggered timer.
   * @param signal - An AbortSignal that can be used to cancel the message processing.
   * @returns A promise that resolves when the timer has been processed.
   */
  onTimer?: (
    context: Context,
    message: Timer,
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
   * Gets the number of partitions assigned to the consumer.
   *
   * @return The number of assigned partitions, or 0 if the consumer is not in the Running state
   */
  get assignedPartitionCount(): number;

  /**
   * Checks if the consumer is stalled.
   *
   * @return Whether the consumer is stalled, or false if the consumer is not in the Running state
   */
  get isStalled(): boolean;

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
 * Provides a common interface for determining if an error is permanent.
 */
export abstract class EventHandlerError extends Error {
  /** Indicates whether the error is permanent and should not be retried. */
  abstract get isPermanent(): boolean;
}

/**
 * Represents a transient error that may be resolved by retrying.
 */
export class TransientError extends EventHandlerError {
  /** @returns Always false, indicating the error is not permanent. */
  get isPermanent(): false;
}

/**
 * Represents a permanent error that should not be retried.
 */
export class PermanentError extends EventHandlerError {
  /** @returns Always true, indicating the error is permanent. */
  get isPermanent(): true;
}

/** Type alias for a constructor of an Error subclass. */
type ErrorClass<T extends Error> = new (...args: any[]) => T;

/**
 * Type for a decorator function that can be applied to both methods and standalone functions.
 */
type DecoratorFunction = (
  target: Function,
  context: ClassMethodDecoratorContext | ClassFieldDecoratorContext,
) => Function | void;

/**
 * Decorator factory for marking errors as transient.
 * Can be applied to both methods and standalone functions.
 * @param exceptionTypes The error types to be treated as transient.
 */
export declare function transient<E extends Error>(
  ...exceptionTypes: ErrorClass<E>[]
): DecoratorFunction;

/**
 * Decorator factory for marking errors as permanent.
 * Can be applied to both methods and standalone functions.
 * @param exceptionTypes The error types to be treated as permanent.
 */
export declare function permanent<E extends Error>(
  ...exceptionTypes: ErrorClass<E>[]
): DecoratorFunction;
