import type {
  Configuration,
  ConsumerState,
  Context,
  Message,
  Mode,
  Timer,
} from "./bindings";

export { Configuration, ConsumerState, Context, Message, Timer, Mode };

/**
 * JavaScript logger interface for use with Prosody client.
 *
 * Each logging method receives a message string and optional metadata object.
 */
export interface Logger {
  /** Function for logging error messages. */
  error: (message: string | undefined | null, metadata?: any) => void;
  /** Function for logging warning messages. */
  warn: (message: string | undefined | null, metadata?: any) => void;
  /** Function for logging informational messages. */
  info: (message: string | undefined | null, metadata?: any) => void;
  /** Function for logging debug messages. */
  debug: (message: string | undefined | null, metadata?: any) => void;
  /** Function for logging trace messages. */
  trace: (message: string | undefined | null, metadata?: any) => void;
}

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
    timer: Timer,
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
  consumerState(): Promise<ConsumerState>;

  /**
   * Gets the number of partitions assigned to the consumer.
   *
   * @return The number of assigned partitions, or 0 if the consumer is not in the Running state
   */
  assignedPartitionCount(): Promise<number>;

  /**
   * Checks if the consumer is stalled.
   *
   * @return Whether the consumer is stalled, or false if the consumer is not in the Running state
   */
  isStalled(): Promise<boolean>;

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
  subscribe(eventHandler: EventHandler): Promise<void>;

  /**
   * Unsubscribes from receiving messages and shuts down the consumer.
   *
   * @returns A promise that resolves when the unsubscribe operation is complete.
   */
  unsubscribe(): Promise<void>;
}

/**
 * Initializes the logging system for the Prosody client.
 *
 * This function sets up the tracing infrastructure and prepares the logging system
 * to accept JavaScript loggers. It should be called once during application startup
 * before any other logging operations.
 */
export function initialize(): void;

/**
 * Checks if a logger has been set in the logging system.
 *
 * @returns True if a logger is currently configured, false otherwise.
 */
export function loggerIsSet(): boolean;

/**
 * Sets a new JavaScript logger for the Prosody client.
 *
 * This function configures the logging system to use the provided JavaScript logger
 * for all log output. The logger must implement all required log levels.
 *
 * @param logger - The JavaScript logger object with error, warn, info, debug, and trace methods.
 * @throws Error if creating the new JavaScript logger fails.
 */
export function setLogger(logger: Logger): void;

/**
 * Sets a JavaScript logger only if no logger is currently configured.
 *
 * This function is useful for providing a default logger without overriding
 * an existing one that may have been set earlier.
 *
 * @param logger - The JavaScript logger object with error, warn, info, debug, and trace methods.
 * @returns True if the logger was set (no previous logger existed), false if a logger was already configured.
 * @throws Error if creating the new JavaScript logger fails.
 */
export function setLoggerIfUnset(logger: Logger): boolean;

/**
 * Gets the current configured logger.
 *
 * @returns The current logger instance, or null/undefined if no logger is configured.
 */
export function getCurrentLogger(): Logger | null | undefined;

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
