/**
 * @module prosody-js
 * @description A high-performance messaging client for Kafka with built-in OpenTelemetry support.
 * Provides functionality for sending messages, subscribing to topics, and managing consumer state.
 */

import type {
  Configuration,
  ConsumerState,
  Message as NativeMessage,
  Mode,
  Timer,
} from "./bindings";

export { Configuration, ConsumerState, Timer, Mode };

/**
 * Represents a message consumed from a Kafka topic.
 *
 * The optional payload type parameter is annotation-level only: the runtime
 * payload is unchanged, and an unparameterized `Message` means `Message<any>`
 * (identical to the previous, non-generic type), so existing code keeps
 * compiling. Message-backed keyed-state collections vend their items as
 * `Message<P>`.
 */
export interface Message<P = any> extends Omit<NativeMessage, "payload"> {
  /** The message payload as a JSON-serializable value. */
  payload: P;
}

/**
 * Wrapper around `MessageContext` for use in Node.js bindings.
 * Automatically injects OpenTelemetry context for all operations.
 */
export declare class Context {
  /**
   * Checks whether cancellation has been signaled.
   * Cancellation includes message-level cancellation (e.g., timeout) and partition shutdown. During shutdown, cancellation is delayed until near the end of the shutdown timeout to allow in-flight work to complete.
   *
   * @returns True if cancellation was requested, otherwise false.
   */
  get shouldCancel(): boolean;

  /**
   * Waits for a cancellation signal.
   * Cancellation includes message-level cancellation (e.g., timeout) and partition shutdown. During shutdown, cancellation is delayed until near the end of the shutdown timeout to allow in-flight work to complete.
   *
   * @returns A promise that resolves when cancellation is signaled.
   */
  onCancel(): Promise<void>;

  /**
   * Schedule a timer at the given time.
   *
   * @param time - The UTC timestamp to schedule.
   * @returns A promise that resolves when the timer has been scheduled.
   * @throws Error if time conversion or scheduling fails.
   */
  schedule(time: Date): Promise<void>;

  /**
   * Clear existing timers and schedule a new one at the given time.
   *
   * @param time - The UTC timestamp to schedule.
   * @returns A promise that resolves when the timer has been scheduled.
   * @throws Error if time conversion or scheduling fails.
   */
  clearAndSchedule(time: Date): Promise<void>;

  /**
   * Unschedules the timer for the specified time.
   * @param time - The time to unschedule.
   * @returns A promise that resolves when the timer has been unscheduled.
   * @throws Error if unscheduling fails.
   */
  unschedule(time: Date): Promise<void>;

  /**
   * Clears all scheduled timers.
   * @returns A promise that resolves when all timers have been cleared.
   * @throws Error if clearing schedules fails.
   */
  clearScheduled(): Promise<void>;

  /**
   * Retrieves all scheduled times.
   * @returns An array of scheduled times as Date objects.
   * @throws Error if retrieval fails.
   */
  scheduled(): Promise<Array<Date>>;

  /**
   * Binds a registered message single-value collection, vending a handle whose
   * item is the full `Message<P>`.
   *
   * The handle and any iterator it opens are valid only within this event
   * attempt. Throws a {@link PermanentStateError} if the collection name is
   * unregistered or its registered identity mismatches.
   * @param definition - A definition from {@link messageValue}.
   */
  state<P>(definition: MessageValueDefinition<P>): ValueState<Message<P>>;
  /**
   * Binds a registered message ordered-map collection, vending a handle whose
   * values are the full `Message<P>`. Valid only within this event attempt;
   * throws {@link PermanentStateError} on an unregistered name or identity
   * mismatch.
   * @param definition - A definition from {@link messageMap}.
   */
  state<P>(definition: MessageMapDefinition<P>): MapState<Message<P>>;
  /**
   * Binds a registered message deque collection, vending a handle whose
   * elements are the full `Message<P>`. Valid only within this event attempt;
   * throws {@link PermanentStateError} on an unregistered name or identity
   * mismatch.
   * @param definition - A definition from {@link messageDeque}.
   */
  state<P>(definition: MessageDequeDefinition<P>): DequeState<Message<P>>;
  /**
   * Binds a registered single-value JSON collection. Valid only within this
   * event attempt; throws {@link PermanentStateError} on an unregistered name
   * or identity mismatch.
   * @param definition - A definition from {@link value}.
   */
  state<T>(definition: ValueDefinition<T>): ValueState<T>;
  /**
   * Binds a registered ordered-map JSON collection (string keys). Valid only
   * within this event attempt; throws {@link PermanentStateError} on an
   * unregistered name or identity mismatch.
   * @param definition - A definition from {@link map}.
   */
  state<V>(definition: MapDefinition<V>): MapState<V>;
  /**
   * Binds a registered deque JSON collection. Valid only within this event
   * attempt; throws {@link PermanentStateError} on an unregistered name or
   * identity mismatch.
   * @param definition - A definition from {@link deque}.
   */
  state<T>(definition: DequeDefinition<T>): DequeState<T>;
}

/**
 * Scan direction over a map or deque collection. `"forward"` visits a map in
 * ascending key order and a deque from front to back; `"backward"` reverses
 * each. Defaults to `"forward"` wherever it is optional.
 */
export type ScanDirection = "forward" | "backward";

/** Options accepted by every keyed-state definition constructor. */
export interface StateDefinitionOptions {
  /**
   * Optional per-write TTL in whole seconds. Must be at least 1 and must
   * exceed the client's recovery delay (enforced core-side).
   */
  ttlSeconds?: number;
  /**
   * Opt out of transactional staging (read-uncommitted, at-least-once).
   * Defaults to transactional.
   */
  readUncommitted?: boolean;
}

/** Options accepted by the map definition constructors. */
export interface MapDefinitionOptions extends StateDefinitionOptions {
  /**
   * Keyset bound for ordered scans (`0..=4096`; default 128 core-side; `0`
   * disables ordered-scan tracking). Map collections only.
   */
  keysetLimit?: number;
}

/**
 * Phantom brand carrying a definition's item type. Never present at runtime —
 * it exists only so the item type survives on the frozen definition object and
 * flows into the vended handle.
 */
declare const StateItem: unique symbol;

/** A frozen single-value JSON collection definition. */
export interface ValueDefinition<T = any> {
  readonly name: string;
  readonly kind: "value";
  readonly payload: "json";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly [StateItem]?: T;
}

/** A frozen ordered-map JSON collection definition (string keys). */
export interface MapDefinition<V = any> {
  readonly name: string;
  readonly kind: "map";
  readonly payload: "json";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly keysetLimit?: number;
  readonly [StateItem]?: V;
}

/** A frozen deque JSON collection definition. */
export interface DequeDefinition<T = any> {
  readonly name: string;
  readonly kind: "deque";
  readonly payload: "json";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly [StateItem]?: T;
}

/** A frozen single-value message collection definition (items are `Message<P>`). */
export interface MessageValueDefinition<P = any> {
  readonly name: string;
  readonly kind: "value";
  readonly payload: "message";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly [StateItem]?: P;
}

/** A frozen ordered-map message collection definition (values are `Message<P>`). */
export interface MessageMapDefinition<P = any> {
  readonly name: string;
  readonly kind: "map";
  readonly payload: "message";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly keysetLimit?: number;
  readonly [StateItem]?: P;
}

/** A frozen deque message collection definition (elements are `Message<P>`). */
export interface MessageDequeDefinition<P = any> {
  readonly name: string;
  readonly kind: "deque";
  readonly payload: "message";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly [StateItem]?: P;
}

/**
 * Declares a single-value JSON collection. The returned frozen definition is
 * the single source of typing: place it in `Configuration.stateCollections` to
 * register the collection, and pass it to `Context.state()` to vend a typed
 * handle. The type parameter annotates the stored value and is compile-time
 * only — payloads cross as plain JSON with no runtime validation.
 * @param name - The collection name (unique per client).
 * @param options - Optional `ttlSeconds` (whole seconds) and `readUncommitted`.
 */
export function value<T = any>(
  name: string,
  options?: StateDefinitionOptions,
): ValueDefinition<T>;

/**
 * Declares an ordered-map JSON collection. Map keys are always `string`. The
 * returned frozen definition is used both in `Configuration.stateCollections`
 * and with `Context.state()`. The type parameter annotates the stored value
 * (compile-time only).
 * @param name - The collection name (unique per client).
 * @param options - Optional `ttlSeconds`, `readUncommitted`, and `keysetLimit`.
 */
export function map<V = any>(
  name: string,
  options?: MapDefinitionOptions,
): MapDefinition<V>;

/**
 * Declares a double-ended-queue JSON collection. The returned frozen definition
 * is used both in `Configuration.stateCollections` and with `Context.state()`.
 * The type parameter annotates the stored element (compile-time only).
 * @param name - The collection name (unique per client).
 * @param options - Optional `ttlSeconds` (whole seconds) and `readUncommitted`.
 */
export function deque<T = any>(
  name: string,
  options?: StateDefinitionOptions,
): DequeDefinition<T>;

/**
 * Declares a single-value message collection: each stored item is the full
 * Kafka `Message<P>` the handler received. The type parameter annotates the
 * message payload (compile-time only).
 * @param name - The collection name (unique per client).
 * @param options - Optional `ttlSeconds` (whole seconds) and `readUncommitted`.
 */
export function messageValue<P = any>(
  name: string,
  options?: StateDefinitionOptions,
): MessageValueDefinition<P>;

/**
 * Declares an ordered-map message collection (string keys; values are the full
 * Kafka `Message<P>`). The type parameter annotates the message payload
 * (compile-time only).
 * @param name - The collection name (unique per client).
 * @param options - Optional `ttlSeconds`, `readUncommitted`, and `keysetLimit`.
 */
export function messageMap<P = any>(
  name: string,
  options?: MapDefinitionOptions,
): MessageMapDefinition<P>;

/**
 * Declares a double-ended-queue message collection: each stored element is the
 * full Kafka `Message<P>`. The type parameter annotates the message payload
 * (compile-time only).
 * @param name - The collection name (unique per client).
 * @param options - Optional `ttlSeconds` (whole seconds) and `readUncommitted`.
 */
export function messageDeque<P = any>(
  name: string,
  options?: StateDefinitionOptions,
): MessageDequeDefinition<P>;

/**
 * Typed handle over a single-value keyed-state collection, vended by
 * `Context.state()`. Valid only within the handler invocation (attempt) that
 * vended it. Every method opens its own per-operation trace span.
 */
export declare class ValueState<T = any> {
  /** Vended only by {@link Context#state}; not constructible directly. */
  private constructor(native: unknown);
  /** Reads the current value, or null when absent/cleared. */
  get(): Promise<T | null>;
  /**
   * Buffers a write of the value. The parameter type excludes `null`/`undefined`
   * (via {@link !NonNullable}) because a top-level `null` is not a storable
   * value — writing one (or an unrepresentable value) is a caller mistake,
   * rejected at runtime with a {@link TransientStateError} naming `clear()` —
   * use {@link ValueState#clear}. Transient so it retries and stays visible
   * rather than discarding the message. (Nested `null`, e.g. inside an object or
   * array, is permitted and round-trips.) The compile-time ban applies to
   * explicitly-typed collections; an untyped (`any`) collection relies on the
   * runtime rejection, since `NonNullable<any>` is `any`.
   */
  set(value: NonNullable<T>): Promise<void>;
  /** Deletes the stored value. */
  clear(): Promise<void>;
  /**
   * Durably commits the buffered operations mid-handler (at-least-once).
   * Resolves with no value — the erased seam drops the store outcome.
   */
  commit(): Promise<void>;
  /** Discards buffered uncommitted operations back to the committed floor. */
  rollback(): Promise<void>;
}

/**
 * Typed handle over an ordered-map keyed-state collection, vended by
 * `Context.state()`. Map keys are always `string`. Valid only within the
 * handler invocation (attempt) that vended it. Every method opens its own
 * per-operation trace span.
 */
export declare class MapState<V = any> {
  /** Vended only by {@link Context#state}; not constructible directly. */
  private constructor(native: unknown);
  /** Reads the value for `key`, or null when the key is absent. */
  get(key: string): Promise<V | null>;
  /**
   * Reads several keys in a single call. Returns an array with one entry per
   * key, in the same order you asked, so `result[i]` is the value for
   * `keys[i]`. A key that isn't there comes back as `null`, and a key you list
   * more than once is answered at each spot. The whole read happens as one
   * step, so no other change to this event's state can slip in partway through.
   */
  getMany(keys: readonly string[]): Promise<(V | null)[]>;
  /**
   * Reports whether `key` currently has a value. This is a genuine read — no
   * cheaper than {@link MapState#get} today — so reach for it to express intent
   * (or to avoid materializing a large value you don't need), not to save work.
   */
  has(key: string): Promise<boolean>;
  /**
   * Inserts or overwrites `key`. The value type excludes `null`/`undefined`
   * (via {@link !NonNullable}) because a top-level `null` is not a storable
   * value — writing one (or an unrepresentable value) is a caller mistake,
   * rejected at runtime with a {@link TransientStateError} — use
   * {@link MapState#delete} to remove. Transient so it retries and stays visible
   * rather than discarding the message. (Nested `null` is permitted.)
   */
  set(key: string, value: NonNullable<V>): Promise<void>;
  /**
   * Removes `key`.
   *
   * Deliberate divergence from `Map#delete`: returns void, NOT a boolean
   * "was present" flag — surfacing that boolean would force a hidden read on
   * every delete. (The underlying native operation is named `remove`.)
   */
  delete(key: string): Promise<void>;
  /** Removes every entry. */
  clear(): Promise<void>;
  /**
   * Async iterator over the live `[key, value]` entries in key order. Valid
   * only within the handler invocation (attempt) that opened it; early exit
   * from a `for await` loop closes the underlying cursor.
   */
  entries(direction?: ScanDirection): AsyncIterableIterator<[string, V]>;
  /**
   * Async iterator over the live keys in key order. Valid only within the
   * handler invocation (attempt) that opened it; early exit from a `for await`
   * loop closes the underlying cursor.
   */
  keys(direction?: ScanDirection): AsyncIterableIterator<string>;
  /**
   * Async iterator over the live values in key order. Valid only within the
   * handler invocation (attempt) that opened it; early exit from a `for await`
   * loop closes the underlying cursor.
   */
  values(direction?: ScanDirection): AsyncIterableIterator<V>;
  /**
   * Forward iteration over `[key, value]` entries. Valid only within the
   * handler invocation (attempt) that opened it.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, V]>;
  /**
   * Durably commits the buffered operations mid-handler (at-least-once).
   * Resolves with no value — the erased seam drops the store outcome.
   */
  commit(): Promise<void>;
  /** Discards buffered uncommitted operations back to the committed floor. */
  rollback(): Promise<void>;
}

/**
 * Typed handle over a double-ended-queue keyed-state collection, vended by
 * `Context.state()`. Valid only within the handler invocation (attempt) that
 * vended it. Every method opens its own per-operation trace span.
 */
export declare class DequeState<T = any> {
  /** Vended only by {@link Context#state}; not constructible directly. */
  private constructor(native: unknown);
  /**
   * Appends an element at the back. The item type excludes `null`/`undefined`
   * (via {@link !NonNullable}) because a top-level `null` is not a storable
   * element — writing one (or an unrepresentable value) is a caller mistake,
   * rejected at runtime with a {@link TransientStateError} so it retries and
   * stays visible rather than discarding the message. (Nested `null` is
   * permitted.)
   */
  push(item: NonNullable<T>): Promise<void>;
  /**
   * Prepends an element at the front. The item type excludes `null`/`undefined`
   * (via {@link !NonNullable}); see {@link DequeState#push}.
   */
  unshift(item: NonNullable<T>): Promise<void>;
  /** Removes and returns the back element, or null when empty. */
  pop(): Promise<T | null>;
  /** Removes and returns the front element, or null when empty. */
  shift(): Promise<T | null>;
  /** Returns the number of live elements. */
  length(): Promise<number>;
  /** Reports whether the deque holds no live elements. */
  isEmpty(): Promise<boolean>;
  /** Removes every element. */
  clear(): Promise<void>;
  /**
   * Reads the element at `index`, like `Array.prototype.at`: a non-negative
   * `index` counts from the front (`0` is the front), a negative `index` counts
   * back from the end (`-1` is the back). Any out-of-range position — including
   * every index on an empty deque — resolves to null. `index` must be a safe
   * integer; a fractional, `NaN`, or infinite value is a caller mistake,
   * rejected with a {@link TransientStateError} (it retries and stays visible).
   * A negative `index` is resolved against the current {@link DequeState#length},
   * so it makes an extra boundary crossing that a non-negative one does not.
   */
  at(index: number): Promise<T | null>;
  /**
   * Async iterator over the live elements in index order. Valid only within
   * the handler invocation (attempt) that opened it; early exit from a
   * `for await` loop closes the underlying cursor.
   */
  values(direction?: ScanDirection): AsyncIterableIterator<T>;
  /**
   * Forward iteration over the elements. Valid only within the handler
   * invocation (attempt) that opened it.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
  /**
   * Durably commits the buffered operations mid-handler (at-least-once).
   * Resolves with no value — the erased seam drops the store outcome.
   */
  commit(): Promise<void>;
  /** Discards buffered uncommitted operations back to the committed floor. */
  rollback(): Promise<void>;
}

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
