/**
 * The single-value keyed-state handle.
 * @module lib/state/value
 */

import type { JsonValue } from "../payload";
import type { StateTransaction } from "./handle";

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
   * Buffers a write of the value. The parameter type excludes `null` and
   * `undefined`, because a top-level `null` is not a storable value. At run
   * time Prosody rejects JSON `null` with a {@link PermanentStateError}; use
   * {@link ValueState#clear} to delete. A nested `null` is stored.
   */
  set(value: NonNullable<T>): Promise<void>;
  /** Deletes the stored value. */
  clear(): Promise<void>;
}

export interface ValueState<T = JsonValue> extends StateTransaction {}
