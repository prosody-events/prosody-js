/**
 * The event context passed to handlers: cancellation, timers, and state.
 * @module lib/context
 * @private
 */

const { TransientStateError } = require("./errors");
const { injectedCarrier, toStateError } = require("./state/bridge");
const { stateDefinitionAccess } = require("./state/definitions");

/** The event context that handlers receive. Each call propagates the trace. */
class Context {
  #native;
  // The frozen demand, read from the native context on first access.
  #demand;
  // The vended state handles, cached by definition object, so repeated
  // state(definition) calls within one event return the same handle.
  #handles = new Map();

  constructor(nativeContext) {
    this.#native = nativeContext;
  }

  get shouldCancel() {
    return this.#native.shouldCancel;
  }

  get demand() {
    this.#demand ??= Object.freeze({ ...this.#native.demand });
    return this.#demand;
  }

  async onCancel() {
    return this.#native.onCancel();
  }

  async schedule(time) {
    return this.#native.schedule(time, injectedCarrier());
  }

  async clearAndSchedule(time) {
    return this.#native.clearAndSchedule(time, injectedCarrier());
  }

  async unschedule(time) {
    return this.#native.unschedule(time, injectedCarrier());
  }

  async clearScheduled() {
    return this.#native.clearScheduled(injectedCarrier());
  }

  async scheduled() {
    return this.#native.scheduled(injectedCarrier());
  }

  state(definition) {
    const access = stateDefinitionAccess.get(definition);
    if (access === undefined) {
      throw new TransientStateError(
        "state: definition must come from a Prosody state definition constructor",
      );
    }
    const cached = this.#handles.get(definition);
    if (cached !== undefined) return cached;
    try {
      const handle = access.owned(this.#native, definition.name);
      this.#handles.set(definition, handle);
      return handle;
    } catch (error) {
      throw toStateError(error);
    }
  }
}

module.exports = {
  Context,
};
