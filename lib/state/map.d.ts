/**
 * The ordered-map keyed-state handle.
 * @module lib/state/map
 */

import type { JsonValue } from "../payload";
import type { StoreOutcome } from "./handle";
import type { KeyQuery, ScanDirection } from "./query";

/**
 * Typed handle over an ordered-map keyed-state collection, vended by
 * `Context.state()`. Map keys are always `string`. Valid only within the
 * handler invocation (attempt) that vended it. Every method opens its own
 * per-operation trace span.
 */
export declare class MapState<V = JsonValue> {
  /** Vended only by {@link Context#state}; not constructible directly. */
  private constructor(native: unknown);
  /** Reads the value for `key`, or null when the key is absent. */
  get(key: string): Promise<V | null>;
  /**
   * Reads several keys in one call. The result has one entry per key, in the
   * order given, so `result[i]` is the value for `keys[i]`. An absent key reads
   * as `null`. A repeated key gets an entry at each position. No other change
   * to the state of this event occurs during the read.
   */
  getMany(keys: readonly string[]): Promise<(V | null)[]>;
  /**
   * Reports whether `key` currently has a stored value. A presence check that
   * skips the value decode and the resolver: for a message-backed map it
   * answers with zero Kafka fetches and can report `true` for a message that
   * can no longer be fetched. Not zero-I/O — a cache miss can still reach the
   * store — but cheaper than {@link MapState#get} when you only need presence.
   */
  has(key: string): Promise<boolean>;
  /**
   * Tests several keys for presence in one read. `result[i]` answers
   * `keys[i]`. Like {@link MapState#has}, it skips the value decode.
   */
  hasMany(keys: readonly string[]): Promise<boolean[]>;
  /** Reports whether the map holds no live entries. */
  isEmpty(): Promise<boolean>;
  /**
   * Inserts or overwrites `key`. The value type excludes `null` and
   * `undefined`, because a top-level `null` is not a storable value. At run
   * time Prosody rejects JSON `null` with a {@link PermanentStateError}; use
   * {@link MapState#delete} to remove an entry. A nested `null` is stored.
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
   * Async iterator over the live `[key, value]` entries in key order. Pass a
   * direction or a {@link KeyQuery} to select entries. Valid only within the
   * handler invocation (attempt) that opened it; early exit from a
   * `for await` loop closes the underlying cursor.
   */
  entries(
    options?: ScanDirection | KeyQuery,
  ): AsyncIterableIterator<[string, V]>;
  /**
   * Async iterator over the live keys in key order. Takes the same options as
   * {@link MapState#entries}. Skips the value decode and the resolver, so a message-backed map enumerates keys with zero Kafka
   * fetches; it still reads presence, so it is not zero-I/O. Valid only within
   * the handler invocation (attempt) that opened it; early exit from a
   * `for await` loop closes the underlying cursor.
   */
  keys(options?: ScanDirection | KeyQuery): AsyncIterableIterator<string>;
  /**
   * Async iterator over the live values in key order. Takes the same options
   * as {@link MapState#entries}. Valid only within the handler invocation
   * (attempt) that opened it; early exit from a `for await` loop closes the
   * underlying cursor.
   */
  values(options?: ScanDirection | KeyQuery): AsyncIterableIterator<V>;
  /**
   * Forward iteration over `[key, value]` entries. Valid only within the
   * handler invocation (attempt) that opened it.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, V]>;
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
