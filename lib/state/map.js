/**
 * The ordered-map keyed-state handle.
 * @module lib/state/map
 * @private
 */

const { stateOp } = require("./bridge");
const { StateHandle } = require("./handle");
const { stateIterator } = require("./iterator");
const { keyQuery } = require("./query");

/** Typed handle over an ordered-map keyed-state collection. */
class MapState extends StateHandle {
  #native;
  #items;

  constructor(native, items) {
    super(native);
    this.#native = native;
    this.#items = items;
  }

  get(key) {
    return stateOp((carrier) => this.#native.get(key, carrier)).then(
      this.#items.decode,
    );
  }

  getMany(keys) {
    return stateOp((carrier) => this.#native.getMany(keys, carrier)).then(
      (items) => items.map(this.#items.decode),
    );
  }

  has(key) {
    return stateOp((carrier) => this.#native.contains(key, carrier));
  }

  hasMany(keys) {
    return stateOp((carrier) => this.#native.containsMany(keys, carrier));
  }

  isEmpty() {
    return stateOp((carrier) => this.#native.isEmpty(carrier));
  }

  set(key, value) {
    return stateOp((carrier) =>
      this.#native.set(key, this.#items.encode(value), carrier),
    );
  }

  delete(key) {
    return stateOp((carrier) => this.#native.remove(key, carrier));
  }

  clear() {
    return stateOp((carrier) => this.#native.clear(carrier));
  }

  entries(options) {
    const query = keyQuery(options);
    return stateIterator(this.#native.entries(query), ([key, item]) => [
      key,
      this.#items.decode(item),
    ]);
  }

  keys(options) {
    const query = keyQuery(options);
    return stateIterator(this.#native.keys(query), (key) => key);
  }

  values(options) {
    const query = keyQuery(options);
    return stateIterator(this.#native.entries(query), ([, item]) =>
      this.#items.decode(item),
    );
  }

  [Symbol.asyncIterator]() {
    return this.entries();
  }
}

module.exports = {
  MapState,
};
