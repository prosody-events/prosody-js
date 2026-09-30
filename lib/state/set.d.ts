/**
 * The ordered-set keyed-state handle.
 * @module lib/state/set
 */

import type { StoreOutcome } from "./handle";
import type { KeyQuery, ScanDirection } from "./query";

/**
 * Handle over a presence-only ordered set of string members, vended by
 * `Context.state()`. It mirrors the JavaScript `Set` with asynchronous
 * methods. Valid only within the handler invocation (attempt) that vended it.
 */
export declare class SetState {
  /** Vended only by {@link Context#state}; not constructible directly. */
  private constructor(native: unknown);
  /** Adds `member` to the set. */
  add(member: string): Promise<void>;
  /** Reports whether `member` belongs to the set. */
  has(member: string): Promise<boolean>;
  /**
   * Tests several members in one read. `result[i]` answers `members[i]`.
   */
  hasMany(members: readonly string[]): Promise<boolean[]>;
  /**
   * Removes `member`. An absent member is not an error. Unlike `Set#delete`,
   * this returns no "was present" flag, because that flag needs a read.
   */
  delete(member: string): Promise<void>;
  /** Removes every member. */
  clear(): Promise<void>;
  /** Reports whether the set has no live members. */
  isEmpty(): Promise<boolean>;
  /**
   * Async iterator over the members in order. Pass a direction or a
   * {@link KeyQuery} to select members. Early exit from a `for await` loop
   * closes the underlying cursor.
   */
  keys(options?: ScanDirection | KeyQuery): AsyncIterableIterator<string>;
  /** The same iterator as {@link SetState#keys}, as on the JavaScript `Set`. */
  values(options?: ScanDirection | KeyQuery): AsyncIterableIterator<string>;
  /** Forward iteration over the members. */
  [Symbol.asyncIterator](): AsyncIterableIterator<string>;
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
