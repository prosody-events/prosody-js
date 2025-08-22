/**
 * @module prosody-js
 * @description A high-performance messaging client for Kafka with built-in OpenTelemetry support.
 * Provides functionality for sending messages, subscribing to topics, and managing consumer state.
 */

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
  /** Logs error-level messages. */
  error: (message: string | undefined | null, metadata?: any) => void;
  /** Logs warning-level messages. */
  warn: (message: string | undefined | null, metadata?: any) => void;
  /** Logs info-level messages. */
  info: (message: string | undefined | null, metadata?: any) => void;
  /** Logs debug-level messages. */
  debug: (message: string | undefined | null, metadata?: any) => void;
  /** Logs trace-level messages. */
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
   * @throws Error if the operation fails.
   */
  consumerState(): Promise<ConsumerState>;

  /**
   * Gets the number of partitions assigned to the consumer.
   *
   * @returns The number of assigned partitions, or 0 if the consumer is not in the Running state.
   * @throws Error if the operation fails.
   */
  assignedPartitionCount(): Promise<number>;

  /**
   * Checks if the consumer is stalled.
   *
   * @returns Whether the consumer is stalled, or false if the consumer is not in the Running state.
   * @throws Error if the operation fails.
   */
  isStalled(): Promise<boolean>;

  /**
   * Sends a message to a specified topic.
   *
   * @param topic - The name of the topic to send the message to.
   * @param key - The key of the message.
   * @param payload - The message payload (must be JSON-serializable).
   * @param signal - An optional AbortSignal that can be used to cancel the send operation. When aborted, the promise will reject with the abort reason.
   * @returns A promise that resolves when the message has been successfully sent.
   * @throws Error if the send operation fails or is aborted.
   */
  send(
    topic: string,
    key: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Subscribes to receive messages using the provided event handler.
   *
   * @param eventHandler - The event handler to process received messages and timers.
   * @returns A promise that resolves when the subscription is successfully established and the consumer is ready to receive messages.
   * @throws Error if the subscription fails to establish.
   */
  subscribe(eventHandler: EventHandler): Promise<void>;

  /**
   * Unsubscribes from receiving messages and shuts down the consumer.
   *
   * @returns A promise that resolves when the unsubscribe operation is complete.
   * @throws Error if the unsubscribe operation fails.
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
