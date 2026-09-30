/**
 * Checks and copies the query options of map, set, and deque scans.
 * @module lib/state/query
 * @private
 */

const { describeValue } = require("./bridge");

/** The options a map or set query accepts. @private */
const KEY_QUERY_FIELDS = new Set([
  "direction",
  "limit",
  "prefix",
  "from",
  "after",
  "to",
  "before",
  "range",
]);

/** The options a deque query accepts. @private */
const POSITION_QUERY_FIELDS = new Set([
  "direction",
  "limit",
  "from",
  "after",
  "to",
  "before",
  "range",
]);

/** The query edges, which `range` excludes. @private */
const QUERY_EDGES = ["from", "after", "to", "before"];

/**
 * Checks the shared query options and copies them into a fresh object. A
 * bare direction string stands for `{ direction }` and gets the same checks.
 * The copy holds only the set, checked fields, so a later change to the
 * caller's object cannot reach the native layer. The copy also holds its own
 * copy of the `range` array.
 * @param {string|object} [options] - A scan direction or a query object.
 * @param {Set<string>} fields - The option names this query accepts.
 * @returns {object} The checked query.
 * @throws {TypeError} If `options` has the wrong type, has an unknown option,
 *   sets both edges of an exclusive pair, sets `range` with an edge, sets a
 *   `range` that is not an array of two bounds, or sets an unknown direction.
 * @throws {RangeError} If `limit` is not a positive safe integer.
 * @private
 */
function queryOptions(options, fields) {
  if (options === undefined) return {};
  const source = typeof options === "string" ? { direction: options } : options;
  if (source === null || typeof source !== "object") {
    throw new TypeError(
      `query: expected a scan direction or an options object, got ${describeValue(options)}`,
    );
  }
  const query = {};
  for (const [field, value] of Object.entries(source)) {
    if (!fields.has(field)) {
      throw new TypeError(`query: unknown option ${describeValue(field)}`);
    }
    if (value !== undefined) query[field] = value;
  }
  for (const [start, end] of [
    ["from", "after"],
    ["to", "before"],
  ]) {
    if (query[start] !== undefined && query[end] !== undefined) {
      throw new TypeError(`query: set ${start} or ${end}, not both`);
    }
  }
  if (query.range !== undefined) {
    const edge = QUERY_EDGES.find((field) => query[field] !== undefined);
    if (edge !== undefined) {
      throw new TypeError(`query: set range or ${edge}, not both`);
    }
    if (
      !Array.isArray(query.range) ||
      query.range.length !== 2 ||
      query.range.includes(undefined)
    ) {
      throw new TypeError(
        `range: expected a [start, end] array, got ${describeValue(query.range)}`,
      );
    }
    query.range = [...query.range];
  }
  const { direction } = query;
  if (
    direction !== undefined &&
    direction !== "forward" &&
    direction !== "backward"
  ) {
    throw new TypeError(
      `direction: expected "forward" or "backward", got ${describeValue(direction)}`,
    );
  }
  checkCount(query.limit, "limit", 1);
  return query;
}

/**
 * Checks a whole-number query option.
 * @param {*} count - The option value, or `undefined` when it is not set.
 * @param {string} field - The option name.
 * @param {number} min - The smallest valid value.
 * @throws {TypeError} If the value is not a number.
 * @throws {RangeError} If the value is not a safe integer of at least `min`.
 * @private
 */
function checkCount(count, field, min) {
  if (count === undefined) return;
  if (typeof count !== "number") {
    throw new TypeError(
      `${field}: expected a number, got ${describeValue(count)}`,
    );
  }
  if (!Number.isSafeInteger(count) || count < min) {
    throw new RangeError(
      `${field}: expected a safe integer of at least ${min}, got ${count}`,
    );
  }
}

/**
 * Checks the options of a map or set query.
 * @param {string|object} [options] - A scan direction or a key query.
 * @returns {object} The key query.
 * @throws {TypeError|RangeError} If an option is invalid.
 * @private
 */
function keyQuery(options) {
  const query = queryOptions(options, KEY_QUERY_FIELDS);
  for (const field of ["prefix", ...QUERY_EDGES]) {
    checkKey(query[field], field);
  }
  for (const key of query.range ?? []) checkKey(key, "range");
  return query;
}

/**
 * Checks a string-key query option.
 * @param {*} key - The option value, or `undefined` when it is not set.
 * @param {string} field - The option name.
 * @throws {TypeError} If the value is not a string.
 * @private
 */
function checkKey(key, field) {
  if (key !== undefined && typeof key !== "string") {
    throw new TypeError(
      `${field}: expected a string key, got ${describeValue(key)}`,
    );
  }
}

/**
 * Checks the options of a deque query. Positions count from the front and
 * must be non-negative.
 * @param {string|object} [options] - A scan direction or a position query.
 * @returns {object} The position query.
 * @throws {TypeError|RangeError} If an option is invalid.
 * @private
 */
function positionQuery(options) {
  const query = queryOptions(options, POSITION_QUERY_FIELDS);
  for (const field of QUERY_EDGES) checkCount(query[field], field, 0);
  for (const position of query.range ?? []) checkCount(position, "range", 0);
  return query;
}

module.exports = {
  keyQuery,
  positionQuery,
};
