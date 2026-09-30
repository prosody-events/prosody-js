/**
 * The event context passed to handlers, and the demand that started it.
 * @module lib/context
 */

import type { Message } from "./payload";
import type {
  DequeDefinition,
  MapDefinition,
  MessageDequeDefinition,
  MessageMapDefinition,
  MessageValueDefinition,
  SetDefinition,
  ValueDefinition,
} from "./state/definitions";
import type { DequeState } from "./state/deque";
import type { MapState } from "./state/map";
import type { SetState } from "./state/set";
import type { ValueState } from "./state/value";

/**
 * The demand that started a handler invocation.
 */
export interface Demand {
  /** `"normal"` for a first attempt, or `"failure"` for a retry. */
  readonly kind: "normal" | "failure";
  /**
   * The retry ordinal: 0 for normal demand and 1 on the first retry. It is
   * an estimate. Keep an exact attempt count in keyed state if you need one.
   */
  readonly retry: number;
}

/**
 * Wrapper around `MessageContext` for use in Node.js bindings.
 * Automatically injects OpenTelemetry context for all operations.
 */
export declare class Context {
  private constructor();

  /**
   * The demand that started this handler invocation. The value is frozen.
   */
  get demand(): Demand;

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
   * Binds a registered set collection of string members. Valid only within
   * this event attempt; throws {@link PermanentStateError} on an unregistered
   * name or identity mismatch.
   * @param definition - A definition from {@link set}.
   */
  state(definition: SetDefinition): SetState;
  /**
   * Binds a registered deque JSON collection. Valid only within this event
   * attempt; throws {@link PermanentStateError} on an unregistered name or
   * identity mismatch.
   * @param definition - A definition from {@link deque}.
   */
  state<T>(definition: DequeDefinition<T>): DequeState<T>;
}
