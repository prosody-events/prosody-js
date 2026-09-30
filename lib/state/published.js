/**
 * The read-only readers of published value, map, set, and deque collections.
 * @module lib/state/published
 * @private
 */

const { TransientStateError } = require("../errors");
const { describeValue, stateOp, stateSync } = require("./bridge");
const { jsonItems } = require("./codec");
const { stateIterator } = require("./iterator");
const { keyQuery, positionQuery } = require("./query");

/**
 * Read-only handle over a published single-value collection. It is independent
 * of subscription and remains valid for the lifetime of its client. A failed
 * store read rejects with a plain `Error`; the other published readers share
 * this error model.
 */
class PublishedValue {
  #native;

  constructor(native) {
    this.#native = native;
  }

  async get(key) {
    return jsonItems.decode(
      await stateOp((carrier) => this.#native.get(key, carrier)),
    );
  }
}

/**
 * Read-only handle over a published map collection. Every read takes the
 * partition key, then the map keys.
 */
class PublishedMap {
  #native;

  constructor(native) {
    this.#native = native;
  }

  async get(key, mapKey) {
    return jsonItems.decode(
      await stateOp((carrier) => this.#native.get(key, mapKey, carrier)),
    );
  }

  async getMany(key, mapKeys) {
    const values = await stateOp((carrier) =>
      this.#native.getMany(key, mapKeys, carrier),
    );
    return values.map(jsonItems.decode);
  }

  has(key, mapKey) {
    return stateOp((carrier) => this.#native.contains(key, mapKey, carrier));
  }

  hasMany(key, mapKeys) {
    return stateOp((carrier) =>
      this.#native.containsMany(key, mapKeys, carrier),
    );
  }

  isEmpty(key) {
    return stateOp((carrier) => this.#native.isEmpty(key, carrier));
  }

  entries(key, options) {
    const query = keyQuery(options);
    return stateIterator(
      () => stateSync(() => this.#native.entries(key, query)),
      ([mapKey, value]) => [mapKey, jsonItems.decode(value)],
    );
  }

  keys(key, options) {
    const query = keyQuery(options);
    return stateIterator(
      () => stateSync(() => this.#native.keys(key, query)),
      (mapKey) => mapKey,
    );
  }

  values(key, options) {
    const query = keyQuery(options);
    return stateIterator(
      () => stateSync(() => this.#native.entries(key, query)),
      (entry) => jsonItems.decode(entry[1]),
    );
  }
}

/**
 * Read-only handle over a published set collection. It is independent of
 * subscription and remains valid for the lifetime of its client.
 */
class PublishedSet {
  #native;

  constructor(native) {
    this.#native = native;
  }

  has(key, member) {
    return stateOp((carrier) => this.#native.contains(key, member, carrier));
  }

  hasMany(key, members) {
    return stateOp((carrier) =>
      this.#native.containsMany(key, members, carrier),
    );
  }

  isEmpty(key) {
    return stateOp((carrier) => this.#native.isEmpty(key, carrier));
  }

  keys(key, options) {
    const query = keyQuery(options);
    return stateIterator(
      () => stateSync(() => this.#native.keys(key, query)),
      (member) => member,
    );
  }

  values(key, options) {
    return this.keys(key, options);
  }
}

/**
 * Read-only handle over a published deque collection. Every read takes the
 * partition key. {@link PublishedDeque#at} counts a negative index from the
 * back.
 */
class PublishedDeque {
  #native;

  constructor(native) {
    this.#native = native;
  }

  length(key) {
    return stateOp((carrier) => this.#native.length(key, carrier));
  }

  isEmpty(key) {
    return stateOp((carrier) => this.#native.isEmpty(key, carrier));
  }

  async at(key, index) {
    if (!Number.isSafeInteger(index)) {
      throw new TransientStateError(
        `at: index must be a safe integer, got ${describeValue(index)}`,
      );
    }
    if (index === 0) {
      return jsonItems.decode(
        await stateOp((carrier) => this.#native.peekFront(key, carrier)),
      );
    }
    if (index === -1) {
      return jsonItems.decode(
        await stateOp((carrier) => this.#native.peekBack(key, carrier)),
      );
    }
    let position = index;
    if (position < 0) {
      position += await this.length(key);
      if (position < 0) return null;
    }
    if (position > 0xffffffff) return null;
    return jsonItems.decode(
      await stateOp((carrier) => this.#native.get(key, position, carrier)),
    );
  }

  values(key, options) {
    const query = positionQuery(options);
    return stateIterator(
      () => stateSync(() => this.#native.values(key, query)),
      jsonItems.decode,
    );
  }
}

module.exports = {
  PublishedDeque,
  PublishedMap,
  PublishedSet,
  PublishedValue,
};
