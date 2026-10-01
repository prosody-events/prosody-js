/**
 * The double-ended-queue keyed-state handle.
 * @module lib/state/deque
 * @private
 */

const { stateOp } = require("./bridge");
const { StateHandle } = require("./handle");
const { stateIterator } = require("./iterator");
const { dequePosition, positionQuery } = require("./query");

/** Typed handle over a double-ended-queue keyed-state collection. */
class DequeState extends StateHandle {
  push(item) {
    return stateOp((carrier) =>
      this.native.pushBack(this.items.encode(item), carrier),
    );
  }

  unshift(item) {
    return stateOp((carrier) =>
      this.native.pushFront(this.items.encode(item), carrier),
    );
  }

  pop() {
    return stateOp((carrier) => this.native.popBack(carrier)).then(
      this.items.decode,
    );
  }

  shift() {
    return stateOp((carrier) => this.native.popFront(carrier)).then(
      this.items.decode,
    );
  }

  length() {
    return stateOp((carrier) => this.native.len(carrier));
  }

  isEmpty() {
    return stateOp((carrier) => this.native.isEmpty(carrier));
  }

  clear() {
    return stateOp((carrier) => this.native.clear(carrier));
  }

  async at(index) {
    if (index === -1) {
      return this.items.decode(
        await stateOp((carrier) => this.native.peekBack(carrier)),
      );
    }
    const position = await dequePosition(index, () => this.length());
    if (position === null) return null;
    return this.items.decode(
      await stateOp((carrier) => this.native.get(position, carrier)),
    );
  }

  values(options) {
    const query = positionQuery(options);
    return stateIterator(this.native.values(query), (item) =>
      this.items.decode(item),
    );
  }

  [Symbol.asyncIterator]() {
    return this.values();
  }
}

module.exports = {
  DequeState,
};
