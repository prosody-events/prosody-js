/**
 * The event context passed to handlers: cancellation, timers, and state.
 * @module lib/context
 * @private
 */

const { TransientStateError } = require("./errors");
const {
  defineHidden,
  injectedCarrier,
  toStateError,
} = require("./state/bridge");
const { stateDefinitionAccess } = require("./state/definitions");

// The frozen demand of each native context, read on first access. The key is
// the native context, so the cache also works through a Proxy with a `set`
// trap. An entry goes away with its native context.
const demands = new WeakMap();

/** The event context that handlers receive. Each call propagates the trace. */
class Context {
  constructor(nativeContext) {
    // The vended state handles, cached by definition object, so repeated
    // state(definition) calls within one event return the same handle.
    defineHidden(this, { nativeContext, stateHandles: new Map() });
  }

  get shouldCancel() {
    return this.nativeContext.shouldCancel;
  }

  get demand() {
    let demand = demands.get(this.nativeContext);
    if (demand === undefined) {
      demand = Object.freeze({ ...this.nativeContext.demand });
      demands.set(this.nativeContext, demand);
    }
    return demand;
  }

  async onCancel() {
    return this.nativeContext.onCancel();
  }

  async schedule(time) {
    return this.nativeContext.schedule(time, injectedCarrier());
  }

  async clearAndSchedule(time) {
    return this.nativeContext.clearAndSchedule(time, injectedCarrier());
  }

  async unschedule(time) {
    return this.nativeContext.unschedule(time, injectedCarrier());
  }

  async clearScheduled() {
    return this.nativeContext.clearScheduled(injectedCarrier());
  }

  async scheduled() {
    return this.nativeContext.scheduled(injectedCarrier());
  }

  state(definition) {
    const access = stateDefinitionAccess.get(definition);
    if (access === undefined) {
      throw new TransientStateError(
        "state: definition must come from a Prosody state definition constructor",
      );
    }
    const cached = this.stateHandles.get(definition);
    if (cached !== undefined) return cached;
    try {
      const handle = access.owned(this.nativeContext, definition.name);
      this.stateHandles.set(definition, handle);
      return handle;
    } catch (error) {
      throw toStateError(error);
    }
  }
}

module.exports = {
  Context,
};
