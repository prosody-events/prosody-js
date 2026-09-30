/**
 * The keyed-state definition types, their options, and their constructors.
 * @module lib/state/definitions
 */

import type { JsonValue } from "../payload";
import type { ReadCacheOptions } from "./published";

/** Options accepted by every keyed-state definition constructor. */
export interface StateDefinitionOptions {
  /**
   * Optional per-write TTL in whole seconds. Must be at least 1 and must
   * stay within the Cassandra TTL limit.
   */
  ttlSeconds?: number;
  /**
   * Opt out of transactional staging (read-uncommitted, at-least-once).
   * Defaults to transactional.
   */
  readUncommitted?: boolean;
}

/** Options accepted by JSON collections that may be published. */
export interface PublishedStateDefinitionOptions extends StateDefinitionOptions {
  /** Allow read-only access from other consumer groups. */
  published?: boolean;
  /** Override caching when this descriptor opens a published reader. */
  readCache?: ReadCacheOptions | false;
}

/** Options accepted by the map definition constructors. */
export interface MapDefinitionOptions extends PublishedStateDefinitionOptions {
  /**
   * Keyset bound for ordered scans (`0..=4096`; default 128 core-side; `0`
   * disables ordered-scan tracking). Map and set collections only.
   */
  keysetLimit?: number;
}

/** Options accepted by the set definition constructor. */
export type SetDefinitionOptions = MapDefinitionOptions;

/** Options accepted by the deque definition constructors. */
export interface DequeDefinitionOptions extends PublishedStateDefinitionOptions {
  /**
   * Optional maximum element count (bounded backlog). Must be a whole number
   * >= 1. Runtime-only: not persisted, not part of collection identity, and
   * changeable across deploys. Enforced lazily on push — the opposite end is
   * evicted toward the bound (no decode, no fetch); a shrunk deque reports its
   * old length until the next push trims it. Deque collections only.
   */
  capacity?: number;
}

/** Options accepted by message-map definitions, which cannot be published. */
export interface MessageMapDefinitionOptions extends StateDefinitionOptions {
  /** Keyset bound for ordered scans (`0..=4096`; default 128 core-side). */
  keysetLimit?: number;
}

/** Options accepted by message-deque definitions, which cannot be published. */
export interface MessageDequeDefinitionOptions extends StateDefinitionOptions {
  /** Optional maximum element count. Must be a whole number >= 1. */
  capacity?: number;
}

/**
 * Phantom brand carrying a definition's item type. Never present at runtime —
 * it exists only so the item type survives on the frozen definition object and
 * flows into the vended handle.
 */
declare const StateItem: unique symbol;
declare const StateDescriptor: unique symbol;

interface DefinitionBrand {
  readonly [StateDescriptor]: true;
}

/** A frozen single-value JSON collection definition. */
export interface ValueDefinition<T = JsonValue> extends DefinitionBrand {
  readonly name: string;
  readonly kind: "value";
  readonly payload: "json";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly published?: boolean;
  readonly readCache?: ReadCacheOptions | false;
  readonly [StateItem]?: T;
}

/** A frozen ordered-map JSON collection definition (string keys). */
export interface MapDefinition<V = JsonValue> extends DefinitionBrand {
  readonly name: string;
  readonly kind: "map";
  readonly payload: "json";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly published?: boolean;
  readonly readCache?: ReadCacheOptions | false;
  readonly keysetLimit?: number;
  readonly [StateItem]?: V;
}

/** A frozen set collection definition. A set stores string members only. */
export interface SetDefinition extends DefinitionBrand {
  readonly name: string;
  readonly kind: "set";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly published?: boolean;
  readonly readCache?: ReadCacheOptions | false;
  readonly keysetLimit?: number;
}

/** A frozen deque JSON collection definition. */
export interface DequeDefinition<T = JsonValue> extends DefinitionBrand {
  readonly name: string;
  readonly kind: "deque";
  readonly payload: "json";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly published?: boolean;
  readonly readCache?: ReadCacheOptions | false;
  readonly capacity?: number;
  readonly [StateItem]?: T;
}

/** A frozen single-value message collection definition (items are `Message<P>`). */
export interface MessageValueDefinition<P = JsonValue> extends DefinitionBrand {
  readonly name: string;
  readonly kind: "value";
  readonly payload: "message";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly [StateItem]?: P;
}

/** A frozen ordered-map message collection definition (values are `Message<P>`). */
export interface MessageMapDefinition<P = JsonValue> extends DefinitionBrand {
  readonly name: string;
  readonly kind: "map";
  readonly payload: "message";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly keysetLimit?: number;
  readonly [StateItem]?: P;
}

/** A frozen deque message collection definition (elements are `Message<P>`). */
export interface MessageDequeDefinition<P = JsonValue> extends DefinitionBrand {
  readonly name: string;
  readonly kind: "deque";
  readonly payload: "message";
  readonly ttlSeconds?: number;
  readonly readUncommitted?: boolean;
  readonly capacity?: number;
  readonly [StateItem]?: P;
}

/**
 * Declares a single-value JSON collection. The returned frozen definition is
 * the single source of typing: place it in `Configuration.stateCollections` to
 * register the collection, and pass it to `Context.state()` to vend a typed
 * handle. The type parameter annotates the stored value and is compile-time
 * only — payloads cross as plain JSON with no runtime validation.
 * @param name - The collection name (unique per client).
 * @param options - Optional retention, transaction, publication, and read-cache
 *   settings.
 */
export function value<T = JsonValue>(
  name: string,
  options?: PublishedStateDefinitionOptions,
): ValueDefinition<T>;

/**
 * Declares an ordered-map JSON collection. Map keys are always `string`. The
 * returned frozen definition is used both in `Configuration.stateCollections`
 * and with `Context.state()`. The type parameter annotates the stored value
 * (compile-time only).
 * @param name - The collection name (unique per client).
 * @param options - Optional retention, transaction, publication, read-cache,
 *   and `keysetLimit` settings.
 */
export function map<V = JsonValue>(
  name: string,
  options?: MapDefinitionOptions,
): MapDefinition<V>;

/**
 * Declares a presence-only ordered set of string members. The returned frozen
 * definition is used both in `Configuration.stateCollections` and with
 * `Context.state()`. A set has no payload.
 * @param name - The collection name (unique per client).
 * @param options - Optional retention, transaction, publication, read-cache,
 *   and `keysetLimit` settings.
 */
export function set(
  name: string,
  options?: SetDefinitionOptions,
): SetDefinition;

/**
 * Declares a double-ended-queue JSON collection. The returned frozen definition
 * is used both in `Configuration.stateCollections` and with `Context.state()`.
 * The type parameter annotates the stored element (compile-time only).
 * @param name - The collection name (unique per client).
 * @param options - Optional retention, transaction, publication, read-cache,
 *   and `capacity` settings.
 */
export function deque<T = JsonValue>(
  name: string,
  options?: DequeDefinitionOptions,
): DequeDefinition<T>;

/**
 * Declares a single-value message collection: each stored item is the full
 * Kafka `Message<P>` the handler received. The type parameter annotates the
 * message payload (compile-time only).
 * @param name - The collection name (unique per client).
 * @param options - Optional `ttlSeconds` (whole seconds) and `readUncommitted`.
 */
export function messageValue<P = JsonValue>(
  name: string,
  options?: StateDefinitionOptions,
): MessageValueDefinition<P>;

/**
 * Declares an ordered-map message collection (string keys; values are the full
 * Kafka `Message<P>`). The type parameter annotates the message payload
 * (compile-time only).
 * @param name - The collection name (unique per client).
 * @param options - Optional `ttlSeconds`, `readUncommitted`, and `keysetLimit`.
 */
export function messageMap<P = JsonValue>(
  name: string,
  options?: MessageMapDefinitionOptions,
): MessageMapDefinition<P>;

/**
 * Declares a double-ended-queue message collection: each stored element is the
 * full Kafka `Message<P>`. The type parameter annotates the message payload
 * (compile-time only).
 * @param name - The collection name (unique per client).
 * @param options - Optional `ttlSeconds` (whole seconds), `readUncommitted`, and
 *   `capacity` (bounded backlog; enforced lazily on push).
 */
export function messageDeque<P = JsonValue>(
  name: string,
  options?: MessageDequeDefinitionOptions,
): MessageDequeDefinition<P>;
