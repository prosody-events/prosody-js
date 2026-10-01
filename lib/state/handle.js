/**
 * The base class of the keyed-state handles: commit and rollback.
 * @module lib/state/handle
 * @private
 */

const { defineHidden, stateOp } = require("./bridge");

/** The base class of every keyed-state handle: commit and rollback. */
class StateHandle {
  constructor(native, items) {
    defineHidden(this, { native, items });
  }

  commit() {
    return stateOp((carrier) => this.native.commit(carrier));
  }

  rollback() {
    return stateOp((carrier) => this.native.rollback(carrier));
  }
}

module.exports = {
  StateHandle,
};
