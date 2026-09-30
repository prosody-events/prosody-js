/**
 * The keyed-state definition constructors and the handle and reader factories they carry.
 * @module lib/state/definitions
 * @private
 */

const { jsonItems, messageItems } = require("./codec");
const { DequeState } = require("./deque");
const { MapState } = require("./map");
const {
  PublishedDeque,
  PublishedMap,
  PublishedSet,
  PublishedValue,
} = require("./published");
const { SetState } = require("./set");
const { ValueState } = require("./value");

/**
 * Maps each frozen definition to the factories that open its owned handle and
 * its published reader. Only the definition constructors add entries.
 * @private
 */
const stateDefinitionAccess = new WeakMap();
const VALUE_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new ValueState(context.valueState(collection), jsonItems),
  published: async (client, subsystem, collection, readCache) =>
    new PublishedValue(
      await client.publishedValue(subsystem, collection, readCache),
    ),
});
const MAP_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new MapState(context.mapState(collection), jsonItems),
  published: async (client, subsystem, collection, readCache) =>
    new PublishedMap(
      await client.publishedMap(subsystem, collection, readCache),
    ),
});
const SET_ACCESS = Object.freeze({
  owned: (context, collection) => new SetState(context.setState(collection)),
  published: async (client, subsystem, collection, readCache) =>
    new PublishedSet(
      await client.publishedSet(subsystem, collection, readCache),
    ),
});
const DEQUE_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new DequeState(context.dequeState(collection), jsonItems),
  published: async (client, subsystem, collection, readCache) =>
    new PublishedDeque(
      await client.publishedDeque(subsystem, collection, readCache),
    ),
});
const MESSAGE_VALUE_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new ValueState(context.messageValueState(collection), messageItems),
});
const MESSAGE_MAP_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new MapState(context.messageMapState(collection), messageItems),
});
const MESSAGE_DEQUE_ACCESS = Object.freeze({
  owned: (context, collection) =>
    new DequeState(context.messageDequeState(collection), messageItems),
});

/**
 * Builds a frozen state-collection definition. The definition is the single
 * source of typing: the same frozen object is placed in
 * `Configuration.stateCollections` (so the collection is registered once) and
 * passed to `Context.state()` to vend a typed handle. Validation (name/ttl/
 * keyset rules, duplicate names) is core-owned and happens at client
 * construction and registration — this layer only shapes and freezes.
 * @param {string} name - The collection name.
 * @param {string} kind - `"value"`, `"map"`, `"set"`, or `"deque"`.
 * @param {string|undefined} payload - `"json"` or `"message"`; a set has none.
 * @param {Readonly<object>} access - The factories that open the owned handle
 *   and, for a JSON or set collection, the published reader.
 * @param {object} [options] - The definition options of the kind.
 * @returns {Readonly<object>} The frozen definition.
 * @private
 */
function stateDefinition(name, kind, payload, access, options = {}) {
  const definition = { name, kind };
  if (payload !== undefined) definition.payload = payload;
  if (options.ttlSeconds !== undefined)
    definition.ttlSeconds = options.ttlSeconds;
  if (options.readUncommitted !== undefined)
    definition.readUncommitted = options.readUncommitted;
  if (options.published !== undefined) definition.published = options.published;
  if (options.readCache !== undefined) definition.readCache = options.readCache;
  if (options.keysetLimit !== undefined)
    definition.keysetLimit = options.keysetLimit;
  if (options.capacity !== undefined) definition.capacity = options.capacity;
  const frozen = Object.freeze(definition);
  stateDefinitionAccess.set(frozen, access);
  return frozen;
}

/**
 * Declares a single-value JSON collection. The type parameter annotates the
 * stored value; it is compile-time only — payloads cross as plain JSON with no
 * runtime validation.
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds` (whole seconds), `readUncommitted`,
 *   `published`, and `readCache`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function value(name, options) {
  return stateDefinition(name, "value", "json", VALUE_ACCESS, options);
}

/**
 * Declares an ordered-map JSON collection. Map keys are always strings; the
 * type parameter annotates the stored value (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds`, `readUncommitted`, `published`,
 *   `readCache`, and map-only `keysetLimit`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function map(name, options) {
  return stateDefinition(name, "map", "json", MAP_ACCESS, options);
}

/**
 * Declares a presence-only ordered set of string members. A set has no
 * payload.
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds`, `readUncommitted`, `published`,
 *   `readCache`, and `keysetLimit`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function set(name, options) {
  return stateDefinition(name, "set", undefined, SET_ACCESS, options);
}

/**
 * Declares a double-ended-queue JSON collection. The type parameter annotates
 * the stored element (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds` (whole seconds), `readUncommitted`,
 *   `published`, `readCache`, and deque-only `capacity`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function deque(name, options) {
  return stateDefinition(name, "deque", "json", DEQUE_ACCESS, options);
}

/**
 * Declares a single-value message collection: each stored item is the full
 * Kafka {@link Message} the handler received. The type parameter annotates the
 * message payload (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds` (whole seconds) and `readUncommitted`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function messageValue(name, options) {
  return stateDefinition(
    name,
    "value",
    "message",
    MESSAGE_VALUE_ACCESS,
    options,
  );
}

/**
 * Declares an ordered-map message collection. Map keys are always strings; each
 * stored value is the full Kafka {@link Message}. The type parameter annotates
 * the message payload (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds`, `readUncommitted`, and map-only `keysetLimit`.
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function messageMap(name, options) {
  return stateDefinition(name, "map", "message", MESSAGE_MAP_ACCESS, options);
}

/**
 * Declares a double-ended-queue message collection: each stored element is the
 * full Kafka {@link Message}. The type parameter annotates the message payload
 * (compile-time only).
 * @param {string} name - The collection name (unique per client).
 * @param {object} [options] - `ttlSeconds` (whole seconds), `readUncommitted`,
 *   and deque-only `capacity` (bounded backlog; enforced lazily on push).
 * @returns {Readonly<object>} A frozen definition for `stateCollections` and `state()`.
 */
function messageDeque(name, options) {
  return stateDefinition(
    name,
    "deque",
    "message",
    MESSAGE_DEQUE_ACCESS,
    options,
  );
}

module.exports = {
  deque,
  map,
  messageDeque,
  messageMap,
  messageValue,
  set,
  stateDefinitionAccess,
  value,
};
