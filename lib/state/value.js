/**
 * The single-value keyed-state handle.
 * @module lib/state/value
 * @private
 */

const { stateOp } = require("./bridge");
const { StateHandle } = require("./handle");

/** Typed handle over a single-value keyed-state collection. */
class ValueState extends StateHandle {
  #native;
  #items;

  constructor(native, items) {
    super(native);
    this.#native = native;
    this.#items = items;
  }

  get() {
    return stateOp((carrier) => this.#native.get(carrier)).then(
      this.#items.decode,
    );
  }

  set(value) {
    return stateOp((carrier) =>
      this.#native.set(this.#items.encode(value), carrier),
    );
  }

  clear() {
    return stateOp((carrier) => this.#native.clear(carrier));
  }
}

module.exports = {
  ValueState,
};
