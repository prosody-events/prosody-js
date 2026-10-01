/**
 * The query options of map, set, and deque scans. The runtime checks stay private.
 * @module lib/state/query
 */

/**
 * Scan direction over a map or deque collection. `"forward"` visits a map in
 * ascending key order and a deque from front to back; `"backward"` reverses
 * each. Defaults to `"forward"` wherever it is optional.
 */
export type ScanDirection = "forward" | "backward";

/**
 * The start of a query. `from` includes its bound and `after` excludes it.
 * Set at most one. The start is in query order, so a backward query starts
 * at the high end.
 */
export type QueryStart<B> =
  | { readonly from?: B; readonly after?: never }
  | { readonly from?: never; readonly after?: B };

/**
 * The end of a query. `to` includes its bound and `before` excludes it. Set
 * at most one. The end is in query order.
 */
export type QueryEnd<B> =
  | { readonly to?: B; readonly before?: never }
  | { readonly to?: never; readonly before?: B };

/**
 * An ascending, half-open range: `[start, end]` keeps the keys or positions
 * from `start` up to, but not including, `end`. A `null` bound leaves its end
 * open, so `[2, null]` keeps position 2 and every later one. The range applies
 * in both directions, so a backward query yields the same items in the
 * opposite order. A range whose `start` is not below its `end` selects
 * nothing.
 */
export type QueryRange<B> = readonly [start: B | null, end: B | null];

/**
 * The bounds of a query: the edges and an optional range. A query that sets
 * both keeps their overlap.
 */
export type QueryBounds<B> = QueryStart<B> &
  QueryEnd<B> & {
    /** Keeps the items within this ascending range. See {@link QueryRange}. */
    readonly range?: QueryRange<B>;
  };

/** The options that every query accepts. */
export interface QueryOptions {
  /** The query order. Defaults to `"forward"`. */
  readonly direction?: ScanDirection;
  /**
   * The maximum number of results. Must be a positive safe integer. A
   * `RangeError` reports any other number.
   */
  readonly limit?: number;
}

/**
 * Query options for map entries, map keys, and set members. Every option is
 * optional. Bounds and `prefix` narrow the selection and never widen it.
 * Setting both edges of a pair, a malformed range, an unknown option, or an
 * unknown direction throws a `TypeError`. The call
 * copies the options, so a later change to the object has no effect on the
 * query.
 *
 * For keyset paging, set `after` to the last key of the previous page and
 * `limit` to the page size. To read the keys from `"a"` up to `"m"` in either
 * direction, set `range: ["a", "m"]`.
 */
export type KeyQueryOptions = QueryOptions & {
  /** Keeps keys that start with this prefix. */
  readonly prefix?: string;
} & QueryBounds<string>;

/**
 * Query options for deque values. Positions count from the front. Each
 * position must be a non-negative safe integer; a `RangeError` reports any
 * other number. Negative positions are not resolved against the length. To
 * read the last N elements, use `values({ direction: "backward", limit: N })`.
 * To read positions 2, 3, and 4 in either direction, set `range: [2, 5]`.
 */
export type PositionQueryOptions = QueryOptions & QueryBounds<number>;
