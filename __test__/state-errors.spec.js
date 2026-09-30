const { trace } = require("@opentelemetry/api");
const { EventEmitter } = require("events");
const {
  MESSAGE_TIMEOUT,
  STATE_DEFS,
  createMessageStream,
  liveSuite,
  nonce,
  waitForEvent,
  waitForMessages,
} = require("./support");

describe("ProsodyClient", () => {
  describe("keyed state", () => {
    const env = liveSuite();
    const { makeStateClient } = env;

    // Tracing. JS cannot see the Rust collection span, which has its own OTLP
    // pipeline. This test checks that a state op inside an active JS span
    // resolves, and that the JS event context is active during the op. The
    // collector shows the full span parentage.
    it("a state op runs under the active JS trace context (smoke)", async () => {
      const V = nonce();
      const obs = await env.observe((ctx) =>
        env.tracer.startActiveSpan("test.state_op", async (span) => {
          try {
            const c = ctx.state(STATE_DEFS.cart);
            await c.set({ v: V });
            return {
              got: await c.get(),
              activeSpan: trace.getActiveSpan() !== undefined,
            };
          } finally {
            span.end();
          }
        }),
      );
      expect(obs.got).toEqual({ v: V });
      expect(obs.activeSpan).toBe(true);
    });

    // Async bridging: while one handler is blocked awaiting a
    // barrier, a handler for a different key on the same partition makes
    // progress (the event loop / native bridge is not serialized). Two keys are
    // forced onto one partition by probing.
    it("a blocked handler does not block a different key on the same partition", async () => {
      // Probe: send 5 keys through the beforeEach client, collect partitions,
      // pick two distinct keys on the same partition (guaranteed with 5 keys /
      // 4 partitions).
      const probeStream = createMessageStream();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          probeStream.push({ key: msg.key, partition: msg.partition });
        },
      });
      const probeKeys = [0, 1, 2, 3, 4].map((i) => `probe-${nonce()}-${i}`);
      for (const k of probeKeys)
        await env.client.send(env.topic, k, { probe: true });
      const probes = await waitForMessages(probeStream, 5, MESSAGE_TIMEOUT);
      await env.client.shutdown();

      const seen = {};
      let keyA = null;
      let keyB = null;
      for (const p of probes) {
        if (seen[p.partition] !== undefined) {
          keyA = seen[p.partition];
          keyB = p.key;
          break;
        }
        seen[p.partition] = p.key;
      }
      expect(keyA).not.toBeNull();
      expect(keyB).not.toBeNull();

      let release;
      const gate = new Promise((r) => (release = r));
      let aStarted = false;
      let aFinished = false;
      const events = new EventEmitter();

      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          if (msg.key === keyA) {
            aStarted = true;
            events.emit("A-blocked");
            try {
              await gate;
            } finally {
              aFinished = true;
            }
            events.emit("A-done");
            return;
          }
          if (msg.key === keyB) {
            events.emit("B-done", { aStarted, aFinished });
          }
        },
      });

      try {
        await env.client.send(env.topic, keyA, { n: 1 });
        await waitForEvent(events, "A-blocked", MESSAGE_TIMEOUT);
        await env.client.send(env.topic, keyB, { n: 2 });
        const [bInfo] = await waitForEvent(events, "B-done", MESSAGE_TIMEOUT);
        expect(bInfo.aStarted).toBe(true);
        expect(bInfo.aFinished).toBe(false);
      } finally {
        release();
      }
      await waitForEvent(events, "A-done", MESSAGE_TIMEOUT);
    });
  });
});
