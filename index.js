/**
 * @module prosody-js
 * @description A high-performance messaging client for Kafka with built-in OpenTelemetry support.
 * Provides functionality for sending messages, subscribing to topics, and managing consumer state.
 */

/**
 * @typedef {Object} Logger
 * @property {Function} error - Function for logging error messages. Called with (message, metadata).
 * @property {Function} warn - Function for logging warning messages. Called with (message, metadata).
 * @property {Function} info - Function for logging informational messages. Called with (message, metadata).
 * @property {Function} debug - Function for logging debug messages. Called with (message, metadata).
 * @property {Function} trace - Function for logging trace messages. Called with (message, metadata).
 */

/**
 * @typedef {Object} EventHandler
 * @property {Function} onMessage - Handles a message and returns its response.
 * @property {Function} onExcise - Handles an excise record and returns its response.
 * @property {Function} onTimer - Handles a timer and returns no value.
 */

/**
 * @typedef {import('./bindings').Configuration} Configuration
 * @typedef {import('./bindings').ConsumerState} ConsumerState
 * @typedef {import('./bindings').Context} Context
 * @typedef {import('./bindings').ExciseMessage} ExciseMessage
 * @typedef {import('./bindings').Message} Message
 * @typedef {import('./bindings').Timer} Timer
 * @typedef {import('./bindings').Mode} Mode
 */

const {
  AdminClient,
  ConsumerState,
  Mode,
  flushTelemetry,
  initialize,
  shutdownTelemetry,
} = require("./bindings");
const {
  getCurrentLogger,
  loggerIsSet,
  setLogger,
  setLoggerIfUnset,
} = require("./lib/logging");
const {
  EventHandlerError,
  PermanentError,
  PermanentStateError,
  TransientError,
  TransientStateError,
  isStateError,
  permanent,
  transient,
} = require("./lib/errors");
const {
  deque,
  map,
  messageDeque,
  messageMap,
  messageValue,
  set,
  value,
} = require("./lib/state/definitions");
const { ValueState } = require("./lib/state/value");
const { MapState } = require("./lib/state/map");
const { SetState } = require("./lib/state/set");
const { DequeState } = require("./lib/state/deque");
const {
  PublishedDeque,
  PublishedMap,
  PublishedSet,
  PublishedValue,
} = require("./lib/state/published");
const { Context } = require("./lib/context");
const { ProsodyClient } = require("./lib/client");

module.exports = {
  AdminClient,
  ConsumerState,
  Context,
  DequeState,
  EventHandlerError,
  MapState,
  Mode,
  PermanentError,
  PermanentStateError,
  ProsodyClient,
  PublishedDeque,
  PublishedMap,
  PublishedSet,
  PublishedValue,
  TransientError,
  SetState,
  TransientStateError,
  ValueState,
  deque,
  getCurrentLogger,
  flushTelemetry,
  initialize,
  isStateError,
  loggerIsSet,
  map,
  messageDeque,
  messageMap,
  messageValue,
  permanent,
  set,
  setLogger,
  setLoggerIfUnset,
  shutdownTelemetry,
  transient,
  value,
};
