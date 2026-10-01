/**
 * The ProsodyClient class, the event handler it runs, and request outcomes.
 * @module lib/client
 */

import type { Configuration, ConsumerState, Timer } from "../bindings";
import type { Context } from "./context";
import type {
  ExciseMessage,
  JsonCompatible,
  JsonValue,
  MaybePromise,
  Message,
} from "./payload";
import type {
  DequeDefinition,
  MapDefinition,
  SetDefinition,
  ValueDefinition,
} from "./state/definitions";
import type {
  PublishedDeque,
  PublishedMap,
  PublishedSet,
  PublishedValue,
} from "./state/published";

/** The callbacks that a subscription runs for each message, excise, and timer. */
export interface EventHandler<P = JsonValue, R = JsonValue> {
  /** Handles an excise record. */
  onExcise: (
    context: Context,
    message: ExciseMessage,
    signal: AbortSignal,
  ) => MaybePromise<R & JsonCompatible<R>>;
  /**
   * Callback function to handle incoming messages.
   *
   * @param context - The context of the message processing.
   * @param message - The received Kafka message.
   * @param signal - An AbortSignal that can be used to cancel the message processing.
   * @returns A JSON response for subsystem requests. JSON null is valid.
   */
  onMessage: (
    context: Context,
    message: Message<P>,
    signal: AbortSignal,
  ) => MaybePromise<R & JsonCompatible<R>>;

  /**
   * Callback function to handle timers.
   *
   * @param context - The context of the message processing.
   * @param timer - The triggered timer.
   * @param signal - An AbortSignal that can be used to cancel the message processing.
   * @returns No value.
   */
  onTimer: (
    context: Context,
    timer: Timer,
    signal: AbortSignal,
  ) => MaybePromise<void>;
}

/** One successful subsystem outcome. */
export interface Success<T> {
  readonly ok: true;
  readonly value: T;
}

/** One failed subsystem outcome. */
export interface Failure {
  readonly ok: false;
  readonly error: ResponseError;
}

/** One subsystem outcome. */
export type Outcome<T> = Success<T> | Failure;

/** One subsystem failure. */
export type ResponseError =
  | { readonly kind: "handler"; readonly message: string }
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "formatMismatch"; readonly message: string }
  | { readonly kind: "malformedResponse"; readonly message: string };

/** Request targets, deadline, and cancellation. */
export interface RequestOptions {
  /** The subsystems that must respond. */
  readonly subsystems: readonly string[];
  /** The response deadline in milliseconds. */
  readonly timeoutMs: number;
  /** Cancels the local wait. */
  readonly signal?: AbortSignal;
}

/** The Prosody client: send, request, subscribe, and shut down. */
export declare class ProsodyClient implements AsyncDisposable {
  private constructor();

  /**
   * Creates a Prosody client without blocking the Node.js event loop.
   *
   * @param config - The configuration options for the client.
   */
  static create(config: Configuration): Promise<ProsodyClient>;

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

  /** Opens a read-only view of a published JSON value collection. */
  state<T>(
    subsystem: string,
    definition: ValueDefinition<T>,
  ): Promise<PublishedValue<T>>;
  /** Opens a read-only view of a published JSON map collection. */
  state<V>(
    subsystem: string,
    definition: MapDefinition<V>,
  ): Promise<PublishedMap<V>>;
  /** Opens a read-only view of a published set collection. */
  state(subsystem: string, definition: SetDefinition): Promise<PublishedSet>;
  /** Opens a read-only view of a published JSON deque collection. */
  state<T>(
    subsystem: string,
    definition: DequeDefinition<T>,
  ): Promise<PublishedDeque<T>>;

  /**
   * Gets the source system identifier configured for the client.
   *
   * @returns The source system identifier.
   */
  get sourceSystem(): string;

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
  send<P>(
    topic: string,
    key: string,
    payload: P & JsonCompatible<P>,
    signal?: AbortSignal,
  ): Promise<void>;

  /** Sends an excise record for a key. */
  excise(topic: string, key: string, signal?: AbortSignal): Promise<void>;

  /**
   * Sends a request and returns one outcome for each subsystem.
   *
   * The map contains every selected subsystem. A missing response has a timeout outcome.
   * `R` types the response. `P` types the payload and is inferred when you give no type arguments.
   * @throws Error if the input is invalid, sending fails, shutdown starts, or the signal aborts.
   */
  request<R = JsonValue, P = JsonValue>(
    topic: string,
    key: string,
    payload: P & JsonCompatible<P>,
    options: RequestOptions,
  ): Promise<ReadonlyMap<string, Outcome<R>>>;

  /** Sends an excise request and returns one outcome for each subsystem. */
  requestExcise<R = JsonValue>(
    topic: string,
    key: string,
    options: RequestOptions,
  ): Promise<ReadonlyMap<string, Outcome<R>>>;

  /**
   * Subscribes to receive messages using the provided event handler.
   *
   * @param eventHandler - The event handler to process received messages and timers.
   * @returns A promise that resolves when the subscription is successfully established and the consumer is ready to receive messages.
   * @throws TypeError if any required handler method is missing.
   * @throws Error if the subscription fails to establish.
   */
  subscribe<P = JsonValue, R = JsonValue>(
    eventHandler: EventHandler<P, R>,
  ): Promise<void>;

  /**
   * Stops the consumer. You can subscribe again later.
   *
   * @returns A promise that resolves when the unsubscribe operation is complete.
   * @throws Error if the unsubscribe operation fails.
   */
  unsubscribe(): Promise<void>;

  /**
   * Shuts down the client and all its services.
   * Concurrent and repeated calls await the same shutdown operation.
   *
   * @returns A promise that resolves when shutdown is complete.
   * @throws Error if shutdown fails.
   */
  shutdown(): Promise<void>;

  /**
   * Shuts down the client when an `await using` block ends. It calls
   * {@link ProsodyClient.shutdown}.
   */
  [Symbol.asyncDispose](): Promise<void>;
}
