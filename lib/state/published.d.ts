/**
 * The read-only readers of published value, map, set, and deque collections.
 * @module lib/state/published
 */

import type { JsonValue } from "../payload";
import type { KeyQuery, PositionQuery, ScanDirection } from "./query";

/** Per-collection cache override for published reads. */
export interface ReadCacheOptions {
  /** Cache duration in milliseconds. */
  ttlMs: number;
}

/** Read-only published value collection. */
export declare class PublishedValue<T = JsonValue> {
  get(key: string): Promise<T | null>;
}

/** Read-only published map collection. */
export declare class PublishedMap<V = JsonValue> {
  get(key: string, mapKey: string): Promise<V | null>;
  getMany(key: string, mapKeys: string[]): Promise<Array<V | null>>;
  has(key: string, mapKey: string): Promise<boolean>;
  hasMany(key: string, mapKeys: readonly string[]): Promise<boolean[]>;
  isEmpty(key: string): Promise<boolean>;
  entries(
    key: string,
    options?: ScanDirection | KeyQuery,
  ): AsyncIterableIterator<[string, V]>;
  keys(
    key: string,
    options?: ScanDirection | KeyQuery,
  ): AsyncIterableIterator<string>;
  values(
    key: string,
    options?: ScanDirection | KeyQuery,
  ): AsyncIterableIterator<V>;
}

/** Read-only published set collection. */
export declare class PublishedSet {
  has(key: string, member: string): Promise<boolean>;
  hasMany(key: string, members: readonly string[]): Promise<boolean[]>;
  isEmpty(key: string): Promise<boolean>;
  keys(
    key: string,
    options?: ScanDirection | KeyQuery,
  ): AsyncIterableIterator<string>;
  values(
    key: string,
    options?: ScanDirection | KeyQuery,
  ): AsyncIterableIterator<string>;
}

/** Read-only published deque collection. */
export declare class PublishedDeque<T = JsonValue> {
  length(key: string): Promise<number>;
  isEmpty(key: string): Promise<boolean>;
  at(key: string, index: number): Promise<T | null>;
  values(
    key: string,
    options?: ScanDirection | PositionQuery,
  ): AsyncIterableIterator<T>;
}
