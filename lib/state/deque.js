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

/**
 * Typed handle over a double-ended-queue keyed-state collection, vended by
 * {@link Context#state}. Core records one semantic span per operation; this
 * binding propagates context without adding an N-API span. Handles and
 * iterators are valid only within the handler invocation that vended them.
 */
class DequeState extends StateHandle {
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
   * Appends an element at the back. Prosody rejects a JSON `null` element with
   * a {@link PermanentStateError}. A value with no JSON form is a
   * {@link TransientStateError}.
   * @param {*} item - The element to append.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  push(item) {
    return stateOp((carrier) =>
      this.#native.pushBack(this.#items.encode(item), carrier),
    );
  }

  /**
   * Prepends an element at the front. Prosody rejects a JSON `null` element
   * with a {@link PermanentStateError}. A value with no JSON form is a
   * {@link TransientStateError}.
   * @param {*} item - The element to prepend.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  unshift(item) {
    return stateOp((carrier) =>
      this.#native.pushFront(this.#items.encode(item), carrier),
    );
  }

  /**
   * Removes and returns the back element.
   * @returns {Promise<*|null>} The removed element, or null when empty.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  pop() {
    return stateOp((carrier) => this.#native.popBack(carrier)).then(
      this.#items.decode,
    );
  }

  /**
   * Removes and returns the front element.
   * @returns {Promise<*|null>} The removed element, or null when empty.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  shift() {
    return stateOp((carrier) => this.#native.popFront(carrier)).then(
      this.#items.decode,
    );
  }

  /**
   * Returns the number of live elements.
   * @returns {Promise<number>} The element count.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  length() {
    return stateOp((carrier) => this.#native.len(carrier));
  }

  /**
   * Reports whether the deque holds no live elements.
   * @returns {Promise<boolean>} True when the deque is empty.
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  isEmpty() {
    return stateOp((carrier) => this.#native.isEmpty(carrier));
  }

  /**
   * Removes every element.
   * @returns {Promise<void>}
   * @throws {PermanentStateError|TransientStateError} On a categorized store failure.
   */
  clear() {
    return stateOp((carrier) => this.#native.clear(carrier));
  }

  /**
   * Reads the element at `index`, like `Array.prototype.at`. A non-negative
   * `index` counts from the front (`0` is the front element); a negative
   * `index` counts back from the end (`-1` is the back element). Any in-range
   * position resolves to its element; any out-of-range position — including
   * every index on an empty deque — resolves to null, the same absence sentinel
   * `pop`/`shift` use.
   *
   * `index` must be a safe integer; a fractional, `NaN`, or infinite value is a
   * caller mistake, rejected with a {@link TransientStateError} so it retries
   * and stays visible rather than silently reading the wrong element (a bare
   * `u32` conversion would truncate `1.5` to `1`). The error is transient — a
   * caller mistake never discards the message.
   *
   * The endpoints `at(0)` and `at(-1)` ride the front/back peeks — a single
   * read, the same core primitive the other clients use; `at(-1)` makes no
   * length read. Any other negative index is resolved against the current
   * {@link DequeState#length}, so it makes two boundary crossings (a length
   * read, then the element read); any other non-negative index makes one.
   * Within a handler attempt the deque has a single owner, so nothing else
   * mutates it between the two reads.
   * @param {number} index - The position: front-relative if `>= 0`, else back-relative.
   * @returns {Promise<*|null>} The element, or null when the position is out of range.
   * @throws {TransientStateError} On an index mistake or a transient store
   *   failure; {@link PermanentStateError} only if the store reports one.
   */
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

  /**
   * Opens an async iterator over the selected elements in index order. Valid
   * only within the handler invocation (attempt) that opened it; early exit
   * closes the underlying cursor.
   * @param {"forward"|"backward"|object} [options] - A scan direction or a
   *   position query.
   * @returns {AsyncIterableIterator<*>} The values iterator.
   * @throws {TypeError|RangeError} If a query option has the wrong shape.
   */
  values(options) {
    const query = positionQuery(options);
    return stateIterator(
      stateSync(() => this.#native.values(query)),
      (item) => this.#items.decode(item),
    );
  }

  /**
   * Forward iteration over the elements — equivalent to `values()`.
   * Valid only within the handler invocation (attempt).
   * @returns {AsyncIterableIterator<*>} The values iterator.
   */
  [Symbol.asyncIterator]() {
    return this.values();
  }
}

module.exports = {
  DequeState,
};
