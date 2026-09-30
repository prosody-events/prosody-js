/**
 * The base class of the keyed-state handles: commit and rollback.
 * @module lib/state/handle
 * @private
 */

const { stateOp } = require("./bridge");

/**
 * What every keyed-state handle shares: the two transaction verbs.
 *
 * Core records one semantic span per operation; this binding propagates context
 * without adding an N-API span. Handles are valid only within the handler
 * invocation (attempt) that vended them. Each subclass keeps its own private
 * copy of the native handle, because a private field is visible only to the
 * class that declares it.
 */
class StateHandle {
  #native;

  /**
   * @param {object} native - The vended native handle.
   */
  constructor(native) {
    this.#native = native;
  }

  /**
   * Durably commits the buffered operations mid-handler (at-least-once; the
   * committed floor survives a later rollback or a failed event).
   * @returns {Promise<"applied"|"noOp">} `"applied"` when buffered operations
   *   were written, or `"noOp"` when nothing was buffered.
   * @throws {PermanentStateError|TransientStateError} On a categorized commit failure.
   */
  commit() {
    return stateOp((carrier) => this.#native.commit(carrier));
  }

  /**
   * Discards buffered uncommitted operations back to the last committed floor.
   * @returns {Promise<"applied"|"noOp">} `"applied"` when buffered operations
   *   were discarded, or `"noOp"` when nothing was buffered.
   */
  rollback() {
    return stateOp((carrier) => this.#native.rollback(carrier));
  }
}

module.exports = {
  StateHandle,
};
