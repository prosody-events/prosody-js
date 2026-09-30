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
   * Buffers a write of the value. Writing JSON `null` (or an unrepresentable
   * value) is a caller mistake, rejected with a {@link TransientStateError}
   * naming `clear()` — use {@link ValueState#clear} to delete instead. The
   * error is transient so it retries and stays visible rather than discarding
   * the message and losing data.
   * @param {*} value - The value to store.
   * @returns {Promise<void>}
   * @throws {TransientStateError} On a null/unrepresentable/shape mistake or a
   *   transient store failure; {@link PermanentStateError} only if the store
   *   reports one.
   */
  set(value) {
    return stateOp((carrier) => this.#items.set(this.#native, value, carrier));
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
