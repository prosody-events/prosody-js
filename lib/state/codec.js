/**
 * Encodes and decodes the items of JSON and message collections.
 * @module lib/state/codec
 * @private
 */

const { Message: NativeMessage } = require("../../bindings");
const {
  PermanentError,
  PermanentStateError,
  TransientStateError,
} = require("../errors");

/**
 * The native `payload` getter, which answers the raw JSON text read from the
 * wire. Captured before {@link withParsedPayload} shadows it per instance.
 * @private
 */
const rawPayload = Object.getOwnPropertyDescriptor(
  NativeMessage.prototype,
  "payload",
).get;

/**
 * Replaces a message's raw-text `payload` with the parsed document.
 *
 * Rust hands the payload across as the bytes it read from the wire, never
 * parsing them; the parse happens here, on first read, and the result is kept.
 * A handler that only inspects metadata therefore never pays for one.
 *
 * A payload that is not JSON raises a permanent error: no retry makes bytes
 * parse. Reading `payload` is where that surfaces, since nothing before it
 * looks at the document. That outcome is kept too, so a handler reading a bad
 * payload twice re-raises rather than re-parsing.
 * @param {object} message - The native message.
 * @returns {object} The same message, with `payload` parsed on demand.
 * @private
 */
function withParsedPayload(message) {
  let document;
  let failure;
  let parsed = false;
  // Not enumerable, matching the five native getters: none of a message's
  // fields are own properties, so spread, `Object.keys`, and `JSON.stringify`
  // see none of them. An enumerable own `payload` would make `JSON.stringify`
  // of a message serialize the whole parsed document.
  Object.defineProperty(message, "payload", {
    configurable: true,
    enumerable: false,
    get() {
      if (!parsed) {
        // The native read fails for bytes that are not UTF-8, and JSON.parse
        // fails for text that is not JSON. Both are the same permanent error.
        try {
          document = JSON.parse(rawPayload.call(this));
        } catch (error) {
          failure = new PermanentError(
            `message payload is not JSON: ${error.message}`,
            { cause: error },
          );
        }
        parsed = true;
      }
      if (failure !== undefined) throw failure;
      return document;
    },
  });
  return message;
}

/**
 * Serializes a JSON value.
 *
 * It returns `undefined` for a function, a symbol, or `undefined` itself. It
 * throws for a BigInt or a cycle.
 * @param {*} value - The value to serialize.
 * @param {Function} ErrorClass - The error to raise on failure.
 * @returns {string} The JSON text.
 * @private
 */
function toJson(value, ErrorClass) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new ErrorClass(
      `value is not representable as JSON: ${error.message}`,
    );
  }
  if (json === undefined) {
    throw new ErrorClass(
      "value is not representable as JSON (functions, symbols, and " +
        "`undefined` have no JSON form)",
    );
  }
  return json;
}

/** Parses JSON text and maps invalid input onto the caller's error class. */
function parseJson(text, ErrorClass, context) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ErrorClass(`${context}: ${error.message}`);
  }
}

/**
 * Serializes a value for a JSON collection.
 *
 * A collection stores whatever JSON it is given, so the only rejections here
 * are values with no JSON form at all. Both are caller mistakes and reject
 * transient: the event retries and the mistake stays visible rather than
 * discarding the message.
 *
 * Everything else follows `JSON.stringify`, which is now the serializer of
 * record. Inside a container a function-valued property is dropped and an
 * `undefined` element becomes `null`. `NaN` and the infinities become `null`
 * anywhere they appear. A `toJSON` method decides what its value serializes to.
 * The previous Rust-side conversion rejected each of those instead.
 * @param {*} value - The value to store.
 * @returns {string} The document's JSON text.
 * @throws {TransientStateError} If the value has no JSON representation.
 * @private
 */
function encodeJson(value) {
  if (value instanceof NativeMessage) {
    throw new TransientStateError(
      "a Kafka message cannot be stored in a JSON collection; declare it with " +
        "messageValue/messageMap/messageDeque instead",
    );
  }
  return toJson(value, TransientStateError);
}

/**
 * Reads the event metadata a payload carries.
 *
 * When the payload is an object with a string `id` or `type`, prosody uses
 * them. Anything else carries no metadata. Each field is read once, so a getter
 * that answers differently on a second read cannot make the metadata disagree
 * with itself.
 * @param {*} payload - The payload about to be sent.
 * @returns {{eventId?: string, eventType?: string}} The metadata.
 * @private
 */
function eventMetadata(payload) {
  const id = payload?.id;
  const type = payload?.type;
  return {
    eventId: typeof id === "string" ? id : undefined,
    eventType: typeof type === "string" ? type : undefined,
  };
}

/**
 * Checks that a message collection is being handed an actual message.
 *
 * A message collection stores the Kafka message itself, so it accepts only a
 * `Message` — an object merely shaped like one is rejected. A message read back
 * out of a collection is a `Message` and stores fine.
 * What it stores is the message's own wire bytes, so assigning to a message's
 * fields, or mutating its parsed `payload`, does not change what is written.
 * @param {*} value - The value to store.
 * @returns {object} The message.
 * @throws {TransientStateError} If the value is not a Kafka message.
 * @private
 */
function requireMessage(value) {
  if (!(value instanceof NativeMessage)) {
    throw new TransientStateError(
      "expected a Kafka message; a JSON value cannot be stored in a message collection",
    );
  }
  return value;
}

/**
 * Builds the item codec for one collection payload type.
 *
 * The native handle has one payload type. Each write method accepts only that
 * type.
 * @param {(item: *) => *} encode - Prepares an item for a write.
 * @param {(item: *) => *} decode - Turns a read item into what the caller asked for.
 * @returns {Readonly<object>} The frozen codec.
 * @private
 */
function itemCodec(encode, decode) {
  return Object.freeze({
    decode: (item) => (item === null ? null : decode(item)),
    set: (native, item, carrier) => native.set(encode(item), carrier),
    setKey: (native, key, item, carrier) =>
      native.set(key, encode(item), carrier),
    pushBack: (native, item, carrier) => native.pushBack(encode(item), carrier),
    pushFront: (native, item, carrier) =>
      native.pushFront(encode(item), carrier),
  });
}

/** JSON documents cross as their text. @private */
const jsonItems = itemCodec(encodeJson, (text) =>
  parseJson(
    text,
    PermanentStateError,
    "stored JSON document could not be parsed",
  ),
);

/** Kafka messages cross as the `Message` object itself. @private */
const messageItems = itemCodec(requireMessage, withParsedPayload);

module.exports = {
  eventMetadata,
  jsonItems,
  messageItems,
  toJson,
  withParsedPayload,
};
