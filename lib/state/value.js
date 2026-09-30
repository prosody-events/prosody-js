/**
 * The single-value keyed-state handle.
 * @module lib/state/value
 * @private
 */

const { stateOp } = require("./bridge");
const { StateHandle } = require("./handle");

/**
 * Typed handle over a single-value keyed-state collection, vended by
 * {@link Context#state}. Core records one semantic span per operation; this
 * binding propagates context without adding an N-API span. Handles are valid
 * only within the handler invocation (attempt) that vended them.
 */
class ValueState extends StateHandle {
  #native;
  #items;

  /**
   * @param {object} native - The vended native handle.
   * @param {object} items - The item codec for the collection's payload flavour.
   */
  constructor(native, items) {
    super(native);
    this.#native = native;
    this.#items = items;
  }

  /**
   * Reads the current value.
   * @returns {Promise<*|null>} The stored value, or null when absent/cleared.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  get() {
    return stateOp((carrier) => this.#native.get(carrier)).then(
      this.#items.decode,
    );
  }

  /**
   * Buffers a write of the value. Prosody rejects JSON `null` with a
   * {@link PermanentStateError}; use {@link ValueState#clear} to delete. A
   * value with no JSON form is a {@link TransientStateError}.
   * @param {*} value - The value to store.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a rejected write or
   *   a categorized store failure.
   */
  set(value) {
    return stateOp((carrier) =>
      this.#native.set(this.#items.encode(value), carrier),
    );
  }

  /**
   * Deletes the stored value.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  clear() {
    return stateOp((carrier) => this.#native.clear(carrier));
  }
}

module.exports = {
  ValueState,
};
