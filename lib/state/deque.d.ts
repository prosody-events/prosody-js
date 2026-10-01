/**
 * The double-ended-queue keyed-state handle.
 * @module lib/state/deque
 */

import type { JsonValue } from "../payload";
import type { StateTransaction } from "./handle";
import type { PositionQuery, ScanDirection } from "./query";

/**
 * Typed handle over a double-ended-queue keyed-state collection, vended by
 * `Context.state()`. Valid only within the handler invocation (attempt) that
 * vended it. Every method opens its own per-operation trace span.
 * A failed call rejects with a {@link PermanentStateError} or a
 * {@link TransientStateError}. A write of a value with no JSON form rejects
 * with a {@link TransientStateError}.
 */
export declare class DequeState<T = JsonValue> {
  /** Vended only by {@link Context#state}; not constructible directly. */
  private constructor(native: unknown);
  /**
   * Appends an element at the back. The item type excludes `null` and
   * `undefined`, because a top-level `null` is not a storable element. At run
   * time Prosody rejects JSON `null` with a {@link PermanentStateError}. A
   * nested `null` is stored.
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
   *
   * A non-negative `index` and `at(-1)` make a single read. Any other negative
   * `index` is resolved against the current {@link DequeState#length}, so it
   * makes an extra read.
   *
   * Under a TTL, an expired element reads as null. This is also true for an
   * expired front or back element when live elements remain inside the deque.
   */
  at(index: number): Promise<T | null>;
  /**
   * Async iterator over the live elements in index order. Pass a direction or
   * a {@link PositionQuery} to select elements. Valid only within the handler
   * invocation (attempt) that opened it; early exit from a `for await` loop
   * closes the underlying cursor.
   */
  values(options?: ScanDirection | PositionQuery): AsyncIterableIterator<T>;
  /**
   * Forward iteration over the elements. Valid only within the handler
   * invocation (attempt) that opened it.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

export interface DequeState<T = JsonValue> extends StateTransaction {}
