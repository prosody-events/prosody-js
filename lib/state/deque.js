/**
 * The double-ended-queue keyed-state handle.
 * @module lib/state/deque
 * @private
 */

const { TransientStateError } = require("../errors");
const { describeValue, stateOp, stateSync } = require("./bridge");
const { StateHandle } = require("./handle");
const { stateIterator } = require("./iterator");
const { positionQuery } = require("./query");

/** Typed handle over a double-ended-queue keyed-state collection. */
class DequeState extends StateHandle {
  #native;
  #items;

  constructor(native, items) {
    super(native);
    this.#native = native;
    this.#items = items;
  }

  push(item) {
    return stateOp((carrier) =>
      this.#native.pushBack(this.#items.encode(item), carrier),
    );
  }

  unshift(item) {
    return stateOp((carrier) =>
      this.#native.pushFront(this.#items.encode(item), carrier),
    );
  }

  pop() {
    return stateOp((carrier) => this.#native.popBack(carrier)).then(
      this.#items.decode,
    );
  }

  shift() {
    return stateOp((carrier) => this.#native.popFront(carrier)).then(
      this.#items.decode,
    );
  }

  length() {
    return stateOp((carrier) => this.#native.len(carrier));
  }

  isEmpty() {
    return stateOp((carrier) => this.#native.isEmpty(carrier));
  }

  clear() {
    return stateOp((carrier) => this.#native.clear(carrier));
  }

  async at(index) {
    if (!Number.isSafeInteger(index)) {
      throw new TransientStateError(
        `at: index must be a safe integer, got ${describeValue(index)}`,
      );
    }
    if (index === 0)
      return stateOp((carrier) => this.#native.peekFront(carrier)).then(
        this.#items.decode,
      );
    if (index === -1)
      return stateOp((carrier) => this.#native.peekBack(carrier)).then(
        this.#items.decode,
      );
    let position = index;
    if (position < 0) {
      // The handler owns the deque, so nothing changes it between the reads.
      position += await this.length();
      // Still negative: the deque is shorter than |index|, so nothing is there.
      if (position < 0) return null;
    }
    // Beyond the addressable u32 range can only be past the end, never a wrap.
    if (position > 0xffffffff) return null;
    return stateOp((carrier) => this.#native.get(position, carrier)).then(
      this.#items.decode,
    );
  }

  values(options) {
    const query = positionQuery(options);
    return stateIterator(
      stateSync(() => this.#native.values(query)),
      (item) => this.#items.decode(item),
    );
  }

  [Symbol.asyncIterator]() {
    return this.values();
  }
}

module.exports = {
  DequeState,
};
