/**
 * @module prosody-js
 * @description A high-performance messaging client for Kafka with built-in OpenTelemetry support.
 * Provides functionality for sending messages, subscribing to topics, and managing consumer state.
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
