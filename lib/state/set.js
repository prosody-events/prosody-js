/**
 * The ordered-set keyed-state handle.
 * @module lib/state/set
 * @private
 */

const { stateOp } = require("./bridge");
const { StateHandle } = require("./handle");
const { stateIterator } = require("./iterator");
const { keyQuery } = require("./query");

/** Handle over a presence-only ordered set of string members. */
class SetState extends StateHandle {
  #native;

  constructor(native) {
    super(native);
    this.#native = native;
  }

  add(member) {
    return stateOp((carrier) => this.#native.insert(member, carrier));
  }

  has(member) {
    return stateOp((carrier) => this.#native.contains(member, carrier));
  }

  hasMany(members) {
    return stateOp((carrier) => this.#native.containsMany(members, carrier));
  }

  delete(member) {
    return stateOp((carrier) => this.#native.remove(member, carrier));
  }

  clear() {
    return stateOp((carrier) => this.#native.clear(carrier));
  }

  isEmpty() {
    return stateOp((carrier) => this.#native.isEmpty(carrier));
  }

  keys(options) {
    const query = keyQuery(options);
    return stateIterator(this.#native.keys(query), (member) => member);
  }

  values(options) {
    return this.keys(options);
  }

  [Symbol.asyncIterator]() {
    return this.values();
  }
}

module.exports = {
  SetState,
};
