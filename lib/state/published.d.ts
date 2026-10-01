/**
 * The read-only readers of published value, map, set, and deque collections.
 *
 * `ProsodyClient.state(subsystem, definition)` opens a reader. A reader reads
 * the committed state of another consumer group, so every read takes the
 * partition key. It is independent of subscription and stays valid while its
 * client runs. A failed read rejects with a {@link TransientStateError} or a
 * {@link PermanentStateError}, like a read through an owned handle. A reader
 * error at open, such as a zero `readCache` TTL, rejects `state()` the same way.
 * @module lib/state/published
 */

import type { JsonValue } from "../payload";
import type { PermanentStateError, TransientStateError } from "../errors";
import type {
  KeyQueryOptions,
  PositionQueryOptions,
  ScanDirection,
} from "./query";

/** Per-collection cache override for published reads. */
export interface ReadCacheOptions {
  /** Cache duration in milliseconds. */
  ttlMs: number;
}

/** Read-only published value collection. */
export declare class PublishedValue<T = JsonValue> {
  private constructor();

  /** Reads the committed value for `key`, or null when it is absent. */
  get(key: string): Promise<T | null>;
}

/** Read-only published map collection. */
export declare class PublishedMap<V = JsonValue> {
  private constructor();

  /** Reads the committed value of `mapKey` for `key`, or null when absent. */
  get(key: string, mapKey: string): Promise<V | null>;
  /**
   * Reads several map keys in one call. The result has one entry per map key,
   * in the order given, and an absent map key reads as null.
   */
  getMany(key: string, mapKeys: readonly string[]): Promise<Array<V | null>>;
  /** Reports whether the map for `key` holds `mapKey`. */
  has(key: string, mapKey: string): Promise<boolean>;
  /** Tests several map keys in one call. `result[i]` answers `mapKeys[i]`. */
  hasMany(key: string, mapKeys: readonly string[]): Promise<boolean[]>;
  /** Reports whether the map for `key` holds no entries. */
  isEmpty(key: string): Promise<boolean>;
  /** Iterates the selected `[mapKey, value]` entries in key order. */
  entries(
    key: string,
    options?: ScanDirection | KeyQueryOptions,
  ): AsyncIterableIterator<[string, V]>;
  /** Iterates the selected map keys in key order. */
  keys(
    key: string,
    options?: ScanDirection | KeyQueryOptions,
  ): AsyncIterableIterator<string>;
  /** Iterates the values of the selected entries in key order. */
  values(
    key: string,
    options?: ScanDirection | KeyQueryOptions,
  ): AsyncIterableIterator<V>;
}

/** Read-only published set collection. */
export declare class PublishedSet {
  private constructor();

  /** Reports whether the set for `key` holds `member`. */
  has(key: string, member: string): Promise<boolean>;
  /** Tests several members in one call. `result[i]` answers `members[i]`. */
  hasMany(key: string, members: readonly string[]): Promise<boolean[]>;
  /** Reports whether the set for `key` holds no members. */
  isEmpty(key: string): Promise<boolean>;
  /** Iterates the selected members in order. */
  keys(
    key: string,
    options?: ScanDirection | KeyQueryOptions,
  ): AsyncIterableIterator<string>;
  /** The same iterator as `keys`, as on the JavaScript `Set`. */
  values(
    key: string,
    options?: ScanDirection | KeyQueryOptions,
  ): AsyncIterableIterator<string>;
}

/** Read-only published deque collection. */
export declare class PublishedDeque<T = JsonValue> {
  private constructor();

  /** Reads the number of values in the deque for `key`. */
  length(key: string): Promise<number>;
  /** Reports whether the deque for `key` holds no values. */
  isEmpty(key: string): Promise<boolean>;
  /**
   * Reads the value at `index`, or null when the position is out of range.
   * `0` is the front and `-1` is the back. A negative index other than `-1`
   * also reads the length, so it makes two reads. Under a TTL, an expired
   * element reads as null. This is also true for an expired front or back
   * element when live elements remain inside the deque.
   * @throws TransientStateError if `index` is not a safe integer.
   */
  at(key: string, index: number): Promise<T | null>;
  /** Iterates the selected values from the front. */
  values(
    key: string,
    options?: ScanDirection | PositionQueryOptions,
  ): AsyncIterableIterator<T>;
}
