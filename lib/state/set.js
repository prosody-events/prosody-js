/**
 * The ordered-set keyed-state handle.
 * @module lib/state/set
 * @private
 */

const { stateOp, stateSync } = require("./bridge");
const { StateHandle } = require("./handle");
const { stateIterator } = require("./iterator");
const { keyQuery } = require("./query");

/**
 * Handle over a presence-only ordered set of string members, vended by
 * {@link Context#state}. It mirrors the JavaScript `Set`: `add`, `has`,
 * `delete`, `clear`, `keys`, and `values`, all asynchronous. Handles and
 * iterators are valid only within the handler invocation that vended them.
 */
class SetState extends StateHandle {
  /**
   * @param {object} native - The vended native set handle.
   */
  constructor(native) {
    super(native, undefined);
  }

  /**
   * Adds `member` to the set.
   * @param {string} member - The member to add.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  add(member) {
    return stateOp((carrier) => this.native.insert(member, carrier));
  }

  /**
   * Reports whether `member` belongs to the set.
   * @param {string} member - The member to test.
   * @returns {Promise<boolean>} True when the set contains `member`.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  has(member) {
    return stateOp((carrier) => this.native.contains(member, carrier));
  }

  /**
   * Tests several members in one read. `result[i]` answers `members[i]`.
   * @param {string[]} members - The members to test, in order.
   * @returns {Promise<boolean[]>} One result per member.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  hasMany(members) {
    return stateOp((carrier) => this.native.containsMany(members, carrier));
  }

  /**
   * Removes `member`. An absent member is not an error. Unlike `Set#delete`,
   * this returns no "was present" flag, because that flag needs a read.
   * @param {string} member - The member to remove.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  delete(member) {
    return stateOp((carrier) => this.native.remove(member, carrier));
  }

  /**
   * Removes every member.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  clear() {
    return stateOp((carrier) => this.native.clear(carrier));
  }

  /**
   * Reports whether the set has no live members.
   * @returns {Promise<boolean>} True when the set is empty.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  isEmpty() {
    return stateOp((carrier) => this.native.isEmpty(carrier));
  }

  /**
   * Opens an async iterator over the selected members in order.
   * @param {"forward"|"backward"|object} [options] - A scan direction or a
   *   key query.
   * @returns {AsyncIterableIterator<string>} The members iterator.
   * @throws {TypeError|RangeError} If a query option has the wrong shape.
   */
  keys(options) {
    const query = keyQuery(options);
    return stateIterator(
      stateSync(() => this.native.keys(query)),
      (member) => member,
    );
  }

  /**
   * The same iterator as {@link SetState#keys}, as on the JavaScript `Set`.
   * @param {"forward"|"backward"|object} [options] - A scan direction or a
   *   key query.
   * @returns {AsyncIterableIterator<string>} The members iterator.
   */
  values(options) {
    return this.keys(options);
  }

  /**
   * Forward iteration over the members — equivalent to `values()`.
   * @returns {AsyncIterableIterator<string>} The members iterator.
   */
  [Symbol.asyncIterator]() {
    return this.values();
  }
}

module.exports = {
  SetState,
};
