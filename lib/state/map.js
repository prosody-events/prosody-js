/**
 * The ordered-map keyed-state handle.
 * @module lib/state/map
 * @private
 */

const { stateOp, stateSync } = require("./bridge");
const { StateHandle } = require("./handle");
const { stateIterator } = require("./iterator");
const { keyQuery } = require("./query");

/**
 * Typed handle over an ordered-map keyed-state collection, vended by
 * {@link Context#state}. Map keys are always strings. Core records one semantic
 * span per operation; this binding propagates context without adding an N-API
 * span. Handles and iterators are valid only within the handler invocation.
 */
class MapState extends StateHandle {
  /**
   * Reads the value for `key`.
   * @param {string} key - The map key.
   * @returns {Promise<*|null>} The value, or null when the key is absent.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  get(key) {
    return stateOp((carrier) => this.native.get(key, carrier)).then(
      this.items.decode,
    );
  }

  /**
   * Reads several keys in a single call. Returns an array with one entry per
   * key, in the same order you asked, so `result[i]` is the value for
   * `keys[i]`. A key that isn't there comes back as `null`, and a key you list
   * more than once is answered at each spot. The whole read happens as one
   * step, so no other change to this event's state can slip in partway through.
   * @param {string[]} keys - The keys to read, in order.
   * @returns {Promise<Array<*|null>>} One entry per key, in the order asked.
   * @throws {PermanentStateError|TransientStateError} If the read fails.
   */
  getMany(keys) {
    return stateOp((carrier) => this.native.getMany(keys, carrier)).then(
      (items) => items.map(this.items.decode),
    );
  }

  /**
   * Reports whether `key` currently has a stored value. A presence check that
   * skips the value decode and the resolver: for a message-backed map it
   * answers with zero Kafka fetches and can report `true` for a message that
   * can no longer be fetched. Not zero-I/O — a cache miss can still reach the
   * store — but cheaper than {@link MapState#get} when you only need presence.
   * @param {string} key - The map key.
   * @returns {Promise<boolean>} True when the key is present.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  has(key) {
    return stateOp((carrier) => this.native.contains(key, carrier));
  }

  /**
   * Tests several keys for presence in one read. `result[i]` answers
   * `keys[i]`. Like {@link MapState#has}, it skips the value decode.
   * @param {string[]} keys - The keys to test, in order.
   * @returns {Promise<boolean[]>} One presence result per key.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  hasMany(keys) {
    return stateOp((carrier) => this.native.containsMany(keys, carrier));
  }

  /**
   * Reports whether the map holds no live entries.
   * @returns {Promise<boolean>} True when the map is empty.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  isEmpty() {
    return stateOp((carrier) => this.native.isEmpty(carrier));
  }

  /**
   * Inserts or overwrites `key`. Writing JSON `null` (or an unrepresentable
   * value) is a caller mistake, rejected with a {@link TransientStateError} —
   * use {@link MapState#delete} to remove an entry instead. The error is
   * transient so it retries and stays visible rather than discarding the
   * message and losing data.
   * @param {string} key - The map key.
   * @param {*} value - The value to store.
   * @returns {Promise<void>}
   * @throws {TransientStateError} On a null/unrepresentable/shape mistake or a
   *   transient store failure; {@link PermanentStateError} only if the store
   *   reports one.
   */
  set(key, value) {
    return stateOp((carrier) =>
      this.items.setKey(this.native, key, value, carrier),
    );
  }

  /**
   * Removes `key`.
   *
   * Deliberate divergence from `Map#delete`: this returns void, NOT a boolean
   * "was present" flag — surfacing that boolean would force a hidden read on
   * every delete. The underlying native operation is named `remove`, which is
   * the verb core's null-write rejection message uses.
   * @param {string} key - The map key.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  delete(key) {
    return stateOp((carrier) => this.native.remove(key, carrier));
  }

  /**
   * Removes every entry.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  clear() {
    return stateOp((carrier) => this.native.clear(carrier));
  }

  /**
   * Opens an async iterator over the selected entries in key order. Each
   * yielded item is a `[key, value]` pair. Valid only within the handler
   * invocation (attempt) that opened it; early exit closes the underlying
   * cursor.
   * @param {"forward"|"backward"|object} [options] - A scan direction or a
   *   key query.
   * @returns {AsyncIterableIterator<[string, *]>} The entries iterator.
   * @throws {TypeError|RangeError} If a query option has the wrong shape.
   */
  entries(options) {
    const query = keyQuery(options);
    return stateIterator(
      stateSync(() => this.native.entries(query)),
      ([key, item]) => [key, this.items.decode(item)],
    );
  }

  /**
   * Opens an async iterator over the live keys in key order. Skips the value
   * decode and the resolver, so a message-backed map enumerates keys with zero
   * Kafka fetches; it still reads presence, so it is not zero-I/O. Valid only
   * within the handler invocation (attempt) that opened it; early exit closes
   * the underlying cursor.
   * @param {"forward"|"backward"|object} [options] - A scan direction or a
   *   key query.
   * @returns {AsyncIterableIterator<string>} The keys iterator.
   * @throws {TypeError|RangeError} If a query option has the wrong shape.
   */
  keys(options) {
    const query = keyQuery(options);
    return stateIterator(
      stateSync(() => this.native.keys(query)),
      (key) => key,
    );
  }

  /**
   * Opens an async iterator over the selected values in key order. Valid only
   * within the handler invocation (attempt) that opened it; early exit closes
   * the underlying cursor.
   * @param {"forward"|"backward"|object} [options] - A scan direction or a
   *   key query.
   * @returns {AsyncIterableIterator<*>} The values iterator.
   * @throws {TypeError|RangeError} If a query option has the wrong shape.
   */
  values(options) {
    const query = keyQuery(options);
    return stateIterator(
      stateSync(() => this.native.entries(query)),
      ([, item]) => this.items.decode(item),
    );
  }

  /**
   * Forward iteration over `[key, value]` entries — equivalent to
   * `entries()`. Valid only within the handler invocation (attempt).
   * @returns {AsyncIterableIterator<[string, *]>} The entries iterator.
   */
  [Symbol.asyncIterator]() {
    return this.entries();
  }
}

module.exports = {
  MapState,
};
