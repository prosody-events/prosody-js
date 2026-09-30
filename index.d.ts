/**
 * @module prosody-js
 * @description A high-performance messaging client for Kafka with built-in OpenTelemetry support.
 * Provides functionality for sending messages, subscribing to topics, and managing consumer state.
 */

import type {
  AdminClient,
  Configuration,
  ConsumerState,
  Mode,
  ReadCacheConfiguration,
  Timer,
  TopicOptions,
} from "./bindings";

export {
  AdminClient,
  Configuration,
  ConsumerState,
  ReadCacheConfiguration,
  Timer,
  TopicOptions,
  Mode,
};

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
