/**
 * The single-value keyed-state handle.
 * @module lib/state/value
 */

import type { JsonValue } from "../payload";
import type { StoreOutcome } from "./handle";

/**
 * Typed handle over a single-value keyed-state collection, vended by
 * `Context.state()`. Valid only within the handler invocation (attempt) that
 * vended it. Every method opens its own per-operation trace span.
 */
export declare class ValueState<T = JsonValue> {
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
   * array, is permitted and round-trips.)
   */
  set(value: NonNullable<T>): Promise<void>;
  /** Deletes the stored value. */
  clear(): Promise<void>;
  /**
   * Durably commits the buffered operations mid-handler (at-least-once).
   * Resolves to `"applied"` when it wrote buffered operations, or `"noOp"`.
   */
  commit(): Promise<StoreOutcome>;
  /**
   * Discards buffered uncommitted operations back to the committed floor.
   * Resolves to `"applied"` when it discarded buffered operations, or `"noOp"`.
   */
  rollback(): Promise<StoreOutcome>;
}
