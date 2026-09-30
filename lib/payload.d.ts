/**
 * JSON payload types and the message types that carry them.
 * @module lib/payload
 */

import type {
  ExciseMessage as NativeExciseMessage,
  Message as NativeMessage,
} from "../bindings";

/** A primitive value representable in JSON. */
export type JsonPrimitive = null | boolean | number | string;

/**
 * Any value representable in JSON.
 *
 * This is a compile-time contract. Prosody serializes payloads at runtime but
 * does not validate them against a more specific application payload type.
 */
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Maps an application type to its JSON-compatible shape. This lets APIs
 * accept ordinary interfaces and type aliases without requiring an index
 * signature, while rejecting non-JSON members wherever they are nested.
 */
export type JsonCompatible<T> = T extends JsonPrimitive
  ? T
  : T extends bigint | symbol | undefined | ((...args: never[]) => unknown)
    ? never
    : T extends readonly (infer Item)[]
      ? readonly JsonCompatible<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: JsonCompatible<T[Key]> }
        : never;

/** A value that a handler can return now or through a promise. */
export type MaybePromise<T> = T | PromiseLike<T>;

/**
 * Represents a message consumed from a Kafka topic.
 *
 * The optional payload type parameter is annotation-level only: the runtime
 * payload is unchanged. An unparameterized `Message` uses {@link JsonValue};
 * provide an application payload type for precise field-level checking.
 * Message-backed keyed-state collections vend their items as `Message<P>`.
 *
 * A message can be stored into a message collection, whether it arrived from the
 * topic or was read back out of a collection. What is stored is the message
 * itself, so mutating its parsed `payload` does not change what is written.
 */
export interface Message<P = JsonValue> extends Omit<NativeMessage, "payload"> {
  /** The message payload as a JSON-serializable value. */
  payload: P;
}

/** An excise record with Kafka metadata and no payload. */
export type ExciseMessage = NativeExciseMessage;
