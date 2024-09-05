const {
  context: otelContext,
  propagation,
  trace,
} = require("@opentelemetry/api");

const {
  Mode,
  NativeClient,
  ConsumerState,
  Context,
  initialize,
  setLogger,
} = require("./bindings");

const defaultLogger = {
  error: (message, metadata) => console.error(message, metadata),
  warn: (message, metadata) => console.warn(message, metadata),
  info: (message, metadata) => console.info(message, metadata),
  debug: (message, metadata) => console.debug(message, metadata),
  trace: (message, metadata) => console.debug(message, metadata),
};

initialize(defaultLogger);

class ProsodyClient {
  constructor(config) {
    this.nativeClient = new NativeClient(config);
  }

  get consumerState() {
    return this.nativeClient.consumerState;
  }

  async send(topic, key, payload, signal) {
    const carrier = {};
    propagation.inject(otelContext.active(), carrier);

    await this.nativeClient.send(
      topic,
      key,
      payload,
      carrier,
      signal ? onAbort(signal) : new Promise(() => {}),
    );
  }

  subscribe(eventHandler) {
    const tracer = trace.getTracer("prosody");
    const { onMessage } = eventHandler;

    this.nativeClient.subscribe({
      onMessage: async (err, context, message, carrier) => {
        if (err) throw err;

        // Create a new context from the record
        const ctx = propagation.extract(otelContext.active(), carrier);
        await otelContext.with(ctx, async () => {
          const span = tracer.startSpan("javascript-receive");
          try {
            // register an abort controller to signal partition shutdown
            const controller = new AbortController();

            // signal abort controller on shutdown
            context
              .onShutdown()
              .then(() => {
                controller.abort("partition revoked");
                span.setAttribute("aborted", true);
              })
              .catch((error) => {
                span.recordException(error);
              });

            // process message
            await onMessage(context, message, controller.signal);
          } catch (error) {
            span.recordException(error);
            throw error;
          } finally {
            span.end();
          }
        });
      },
    });
  }

  async unsubscribe() {
    await this.nativeClient.unsubscribe();
  }
}

/**
 * @param {AbortSignal} signal
 * @return {Promise<never>}
 */
const onAbort = (signal) =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });

module.exports.ProsodyClient = ProsodyClient;
module.exports.Mode = Mode;
module.exports.ConsumerState = ConsumerState;
module.exports.Context = Context;
module.exports.setLogger = setLogger;
