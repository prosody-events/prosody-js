/**
 * The ProsodyClient class: producing, requests, subscription, and shutdown.
 * @module lib/client
 * @private
 */

const {
  context: otelContext,
  propagation,
  trace,
  SpanStatusCode,
} = require("@opentelemetry/api");
const { NativeClient } = require("../bindings");
const { Context } = require("./context");
const { EventHandlerError, TransientError } = require("./errors");
const { captureException, getCurrentLogger } = require("./logging");
const {
  defineHidden,
  injectedCarrier,
  toStateError,
} = require("./state/bridge");
const { eventMetadata, toJson, withParsedPayload } = require("./state/codec");
const { stateDefinitionAccess } = require("./state/definitions");

/** Proves that a constructor call comes from {@link wrapNative}. @private */
const CONSTRUCT = Symbol("ProsodyClient");

/** The Prosody client: send, request, subscribe, and shut down. */
class ProsodyClient {
  constructor(token, nativeClient) {
    if (token !== CONSTRUCT) {
      throw new TypeError("Use await ProsodyClient.create(config)");
    }
    // `shutdownPromise` is the one shutdown operation that every shutdown
    // call awaits.
    defineHidden(this, { nativeClient, shutdownPromise: undefined });
  }

  static async create(config) {
    return wrapNative(await NativeClient.create(config));
  }

  get sourceSystem() {
    return this.nativeClient.sourceSystem;
  }

  consumerState() {
    return this.nativeClient.consumerState();
  }

  assignedPartitionCount() {
    return this.nativeClient.assignedPartitionCount();
  }

  isStalled() {
    return this.nativeClient.isStalled();
  }

  async state(subsystem, definition) {
    const access = stateDefinitionAccess.get(definition);
    if (access?.published === undefined) {
      throw new TypeError(
        "definition must be a JSON value, map, or deque definition, or a set definition",
      );
    }
    try {
      return await access.published(
        this.nativeClient,
        subsystem,
        definition.name,
        definition.readCache,
      );
    } catch (error) {
      throw toStateError(error);
    }
  }

  async send(topic, key, payload, signal) {
    const carrier = injectedCarrier();
    const json = toJson(payload, TransientError);

    await withAbort(signal, (aborted) =>
      this.nativeClient.send(
        topic,
        key,
        json,
        eventMetadata(payload),
        carrier,
        aborted,
      ),
    );
  }

  async excise(topic, key, signal) {
    const carrier = injectedCarrier();
    await withAbort(signal, (aborted) =>
      this.nativeClient.excise(topic, key, carrier, aborted),
    );
  }

  async request(topic, key, payload, options) {
    const carrier = injectedCarrier();
    const request = {
      topic,
      key,
      payload: toJson(payload, TransientError),
      metadata: eventMetadata(payload),
      subsystems: options.subsystems,
      timeoutMs: options.timeoutMs,
    };
    const results = await withAbort(options.signal, (aborted) =>
      this.nativeClient.request(request, carrier, aborted),
    );
    return responseOutcomes(results);
  }

  async requestExcise(topic, key, options) {
    const carrier = injectedCarrier();
    const request = {
      topic,
      key,
      subsystems: options.subsystems,
      timeoutMs: options.timeoutMs,
    };
    const results = await withAbort(options.signal, (aborted) =>
      this.nativeClient.requestExcise(request, carrier, aborted),
    );
    return responseOutcomes(results);
  }

  async subscribe(eventHandler) {
    for (const name of ["onMessage", "onExcise", "onTimer"]) {
      if (typeof eventHandler?.[name] !== "function") {
        throw new TypeError(`EventHandler.${name} must be a function`);
      }
    }

    const tracer = trace.getTracer("prosody");
    const { onExcise, onMessage, onTimer } = eventHandler;
    // Runs one handler call under its span. `run` returns the response text.
    const runHandler = (
      nativeContext,
      carrier,
      spanName,
      eventType,
      captureContext,
      run,
    ) => {
      const ctx = propagation.extract(otelContext.active(), carrier);
      return otelContext.with(ctx, () =>
        tracer.startActiveSpan(spanName, async (span) => {
          const controller = new AbortController();
          let completed = false;
          nativeContext.onCancel().then(() => {
            if (!completed) {
              span.setAttribute("cancelled", true);
              controller.abort(new Error(`${eventType} cancelled`));
            }
          });

          try {
            return await run(new Context(nativeContext), controller.signal);
          } catch (error) {
            const cause = error.cause ?? error;
            getCurrentLogger().error(`${eventType} handler error`, cause);
            span.recordException(cause);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: cause.message,
            });
            captureException(error, eventType, captureContext);
            throw error;
          } finally {
            completed = true;
            span.end();
          }
        }),
      );
    };

    // A result with no JSON form is a handler mistake. It is transient, so
    // the event retries and the mistake stays visible.
    const handleRecord = (
      nativeContext,
      message,
      carrier,
      handler,
      spanName,
      eventType,
    ) =>
      runHandler(
        nativeContext,
        carrier,
        spanName,
        eventType,
        {
          topic: message.topic,
          partition: message.partition,
          key: message.key,
          offset: message.offset,
        },
        async (context, signal) =>
          toJson(
            (await handler(context, message, signal)) ?? null,
            TransientError,
          ),
      );

    await this.nativeClient.subscribe({
      isPermanent: ([err]) => {
        try {
          return err instanceof EventHandlerError && err.isPermanent;
        } catch {
          return false;
        }
      },

      onMessage: async (err, [nativeContext, message, carrier]) => {
        if (err) throw err;
        return handleRecord(
          nativeContext,
          withParsedPayload(message),
          carrier,
          onMessage,
          "onMessage",
          "message",
        );
      },

      onExcise: async (err, [nativeContext, message, carrier]) => {
        if (err) throw err;
        return handleRecord(
          nativeContext,
          message,
          carrier,
          onExcise,
          "onExcise",
          "excise",
        );
      },

      onTimer: async (err, [nativeContext, timer, carrier]) => {
        if (err) throw err;
        return runHandler(
          nativeContext,
          carrier,
          "onTimer",
          "timer",
          { key: timer.key, time: timer.time },
          async (context, signal) => {
            await onTimer(context, timer, signal);
            return "null";
          },
        );
      },
    });
  }

  async unsubscribe() {
    await this.nativeClient.unsubscribe();
  }

  async shutdown() {
    this.shutdownPromise ??= this.nativeClient.shutdown();
    await this.shutdownPromise;
  }

  [Symbol.asyncDispose]() {
    return this.shutdown();
  }
}

// napi-rs can only surface rejections whose value is an object, function, or
// symbol — napi_create_reference fails on primitives and the rejection becomes
// an opaque `InvalidArg: Create Error reference failed`. Coerce primitive
// reasons into Error instances so the original reason is preserved across the
// napi boundary.
const toAbortError = (reason) =>
  reason instanceof Error
    ? reason
    : new Error(reason === undefined ? "aborted" : String(reason));

/**
 * Runs a native call that stops when an optional abort signal fires.
 *
 * The call receives a promise that rejects with the abort reason. The abort
 * listener is removed when the call settles, so one long-lived signal can
 * serve any number of calls.
 * @param {AbortSignal|undefined} signal - The abort signal to watch.
 * @param {(aborted: Promise<never>|undefined) => Promise<*>} call - The
 *   native call.
 * @returns {Promise<*>} The result of the call.
 * @private
 */
async function withAbort(signal, call) {
  if (signal === undefined) return call(undefined);
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(toAbortError(signal.reason));
  });
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    return await call(aborted);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function responseOutcome(outcome) {
  if (typeof outcome !== "string") return { ok: false, error: outcome };

  try {
    return { ok: true, value: JSON.parse(outcome) };
  } catch (cause) {
    return {
      ok: false,
      error: { kind: "malformedResponse", message: cause.message },
    };
  }
}

function responseOutcomes(results) {
  const outcomes = new Map();
  for (const { subsystem, outcome } of results)
    outcomes.set(subsystem, responseOutcome(outcome));
  return outcomes;
}

/**
 * Wraps a native client. The unit tests wrap a stub through it.
 * @param {object} native - The native client.
 * @returns {ProsodyClient} The client.
 * @private
 */
function wrapNative(native) {
  return new ProsodyClient(CONSTRUCT, native);
}

module.exports = {
  ProsodyClient,
  wrapNative,
};
