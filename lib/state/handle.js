/**
 * The base class of the keyed-state handles: commit and rollback.
 * @module lib/state/handle
 * @private
 */

const { stateOp } = require("./bridge");

/**
 * The base class of every keyed-state handle: commit and rollback.
 *
 * Each subclass keeps its own private copy of the native handle, because a
 * private field is visible only to the class that declares it.
 */
class StateHandle {
  #native;

  constructor(native) {
    this.#native = native;
  }

  commit() {
    return stateOp((carrier) => this.#native.commit(carrier));
  }

  rollback() {
    return stateOp((carrier) => this.#native.rollback(carrier));
  }
}

module.exports = {
  StateHandle,
};
