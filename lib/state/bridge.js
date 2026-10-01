/**
 * Calls into native keyed state: trace carriers, error categories, and value rendering.
 * @module lib/state/bridge
 * @private
 */

const { types } = require("node:util");
const { context: otelContext, propagation } = require("@opentelemetry/api");
const { PermanentStateError, TransientStateError } = require("../errors");

/**
 * Injects the active OpenTelemetry context into a fresh carrier for one native
 * operation. Native glue activates the carrier without recording a binding
 * span, so the core semantic operation span joins the JavaScript trace directly.
 * @returns {Record<string, string>} The populated carrier.
 * @private
 */
function injectedCarrier() {
  const carrier = {};
  propagation.inject(otelContext.active(), carrier);
  return carrier;
}

/**
 * Converts a category-tagged native state error into the matching typed state
 * error. The native layer sets the error's `cause` to an error whose message
 * is exactly `"permanent"` or `"transient"`. The human message is never
 * parsed. An untagged error, such as an argument conversion `TypeError`,
 * passes through unchanged.
 *
 * The checks use `util.types.isNativeError`, which works across realms. A napi
 * error comes from the addon's realm. Under a vm context, a worker thread, or a
 * second module copy, `instanceof Error` is false for it.
 * @param {unknown} error - The error thrown by the native layer.
 * @returns {unknown} The typed state error, or the original error if untagged.
 * @private
 */
function toStateError(error) {
  if (!types.isNativeError(error)) return error;
  const cause = error.cause;
  const category = types.isNativeError(cause) ? cause.message : undefined;
  if (category !== "permanent" && category !== "transient") return error;
  const StateError =
    category === "permanent" ? PermanentStateError : TransientStateError;
  return new StateError(error.message, { cause: error });
}

/**
 * Renders a value for a diagnostic message without ever throwing.
 * `JSON.stringify` throws on a BigInt or a cycle, and a template literal throws
 * on a Symbol. A raw `TypeError` from either would skip the state error
 * classes. The function returns the value's `typeof` when it cannot serialize
 * the value.
 * @param {*} value - The value to describe.
 * @returns {string} A safe, human-readable rendering.
 * @private
 */
function describeValue(value) {
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? typeof value : rendered;
  } catch {
    return typeof value;
  }
}

/**
 * Runs one async native state operation with a fresh carrier, translating a
 * category-tagged failure into the matching typed state error.
 * @param {(carrier: Record<string, string>) => Promise<*>} operation - The native call.
 * @returns {Promise<*>} The operation's resolved value.
 * @private
 */
async function stateOp(operation) {
  try {
    return await operation(injectedCarrier());
  } catch (error) {
    throw toStateError(error);
  }
}

module.exports = {
  describeValue,
  injectedCarrier,
  stateOp,
  toStateError,
};
