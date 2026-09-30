/**
 * The event context passed to handlers: cancellation, timers, and state.
 * @module lib/context
 * @private
 */

const { TransientStateError } = require("./errors");
const { injectedCarrier, stateSync } = require("./state/bridge");
const { stateDefinitionAccess } = require("./state/definitions");

/**
 * Context class that automatically injects OpenTelemetry context for all operations.
 * This wraps the native Context with automatic OTEL context propagation.
 */
class Context {
  #native;
  // The frozen demand, read from the native context on first access.
  #demand;
  // The vended state handles, cached by definition object, so repeated
  // state(definition) calls within one event return the same handle.
  #handles = new Map();

  /**
   * @param {object} nativeContext - The native event context.
   * @private
   */
  constructor(nativeContext) {
    this.#native = nativeContext;
  }

  /**
   * Checks whether cancellation has been signaled.
   * Cancellation includes both message-level cancellation (e.g., timeout) and partition shutdown.
   * @returns {boolean} True if cancellation was requested, otherwise false.
   */
  get shouldCancel() {
    return this.#native.shouldCancel;
  }

  /**
   * The demand that started this handler invocation. `kind` is `"normal"` for
   * a first attempt and `"failure"` for a retry after a failure. `retry` is
   * the retry ordinal: 0 for normal demand and 1 on the first retry. The
   * ordinal is an estimate. Keep an exact attempt count in keyed state if you
   * need one.
   * @returns {Readonly<{kind: "normal"|"failure", retry: number}>} The frozen demand.
   */
  get demand() {
    this.#demand ??= Object.freeze({ ...this.#native.demand });
    return this.#demand;
  }

  /**
   * Waits for a cancellation signal.
   * Cancellation includes both message-level cancellation (e.g., timeout) and partition shutdown.
   * @returns {Promise<void>} A promise that resolves when cancellation is signaled.
   */
  async onCancel() {
    return this.#native.onCancel();
  }

  /**
   * Schedule a timer at the given time.
   * @param {Date} time - The UTC timestamp to schedule.
   * @returns {Promise<void>} A promise that resolves when the timer has been scheduled.
   * @throws {Error} If time conversion or scheduling fails.
   */
  async schedule(time) {
    return this.#native.schedule(time, injectedCarrier());
  }

  /**
   * Clear existing timers and schedule a new one at the given time.
   * @param {Date} time - The UTC timestamp to schedule.
   * @returns {Promise<void>} A promise that resolves when the timer has been scheduled.
   * @throws {Error} If time conversion or scheduling fails.
   */
  async clearAndSchedule(time) {
    return this.#native.clearAndSchedule(time, injectedCarrier());
  }

  /**
   * Unschedules the timer for the specified time.
   * @param {Date} time - The time to unschedule.
   * @returns {Promise<void>} A promise that resolves when the timer has been unscheduled.
   * @throws {Error} If unscheduling fails.
   */
  async unschedule(time) {
    return this.#native.unschedule(time, injectedCarrier());
  }

  /**
   * Clears all scheduled timers.
   * @returns {Promise<void>} A promise that resolves when all timers have been cleared.
   * @throws {Error} If clearing schedules fails.
   */
  async clearScheduled() {
    return this.#native.clearScheduled(injectedCarrier());
  }

  /**
   * Retrieves all scheduled times.
   * @returns {Promise<Date[]>} An array of scheduled times as Date objects.
   * @throws {Error} If retrieval fails.
   */
  async scheduled() {
    return this.#native.scheduled(injectedCarrier());
  }

  /**
   * Binds a registered keyed-state collection for this event and returns a
   * typed handle over it.
   *
   * Pass a definition built by one of the definition constructors ({@link value},
   * {@link map}, {@link set}, {@link deque}, {@link messageValue}, {@link messageMap},
   * {@link messageDeque}) — the same frozen object placed in
   * `Configuration.stateCollections`. The returned handle (and any iterator it
   * opens) is scoped to this single event attempt; do not retain it past the
   * handler invocation. Handles are cached per context by definition object,
   * so repeated calls with the same definition return the same handle. Two
   * equal definition objects get two handles over the same collection.
   *
   * @param {object} definition - A frozen definition from a definition constructor.
   * @returns {ValueState|MapState|SetState|DequeState} The typed state handle.
   * @throws {TransientStateError} If the definition is malformed — a missing or
   *   non-string `name`, or an unrecognized `kind`/`payload` (a caller mistake,
   *   so transient rather than a message-discarding permanent).
   * @throws {PermanentStateError} If the collection name is unregistered or its
   *   durably-registered schema (kind/payload) mismatches (rejected core-side).
   */
  state(definition) {
    const access = stateDefinitionAccess.get(definition);
    if (access === undefined) {
      throw new TransientStateError(
        "state: definition must come from a Prosody state definition constructor",
      );
    }
    const cached = this.#handles.get(definition);
    if (cached !== undefined) return cached;
    const handle = stateSync(() => access.owned(this.#native, definition.name));
    this.#handles.set(definition, handle);
    return handle;
  }
}

module.exports = {
  Context,
};
