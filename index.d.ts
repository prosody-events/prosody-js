/**
 * @module prosody-js
 * @description A high-performance messaging client for Kafka with built-in OpenTelemetry support.
 * Provides functionality for sending messages, subscribing to topics, and managing consumer state.
 */

import type {
  ConsumerState as ConsumerStateName,
  Mode as ModeName,
} from "./bindings";

export { AdminClient } from "./bindings";
export type {
  Configuration,
  ReadCacheConfiguration,
  Timer,
  TopicOptions,
} from "./bindings";

/** The consumer states, keyed by name: `ConsumerState.Running` is `"Running"`. */
export declare const ConsumerState: {
  readonly [State in ConsumerStateName]: State;
};
/** A consumer state that `consumerState()` reports. */
export type ConsumerState = ConsumerStateName;

/** The operating modes, keyed by name: `Mode.Pipeline` is `"Pipeline"`. */
export declare const Mode: { readonly [Name in ModeName]: Name };
/** The operating mode of a client. */
export type Mode = ModeName;

/** Exports all pending telemetry data. */
export function flushTelemetry(): void;

/** Stops the global telemetry providers after they export pending data. */
export function shutdownTelemetry(): void;

/**
 * Initializes the logging system for the Prosody client.
 *
 * This function sets up the tracing infrastructure and prepares the logging system
 * to accept JavaScript loggers. It should be called once during application startup
 * before any other logging operations.
 */
export function initialize(): void;

/**
 * Checks if a logger has been set in the logging system.
 *
 * @returns True if a logger is currently configured, false otherwise.
 */
export function loggerIsSet(): boolean;

export * from "./lib/payload";
export * from "./lib/context";
export * from "./lib/state/query";
export * from "./lib/state/handle";
export * from "./lib/state/definitions";
export * from "./lib/state/value";
export * from "./lib/state/map";
export * from "./lib/state/set";
export * from "./lib/state/deque";
export * from "./lib/state/published";
export * from "./lib/client";
export * from "./lib/logging";
export * from "./lib/errors";
