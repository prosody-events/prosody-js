const { trace } = require("@opentelemetry/api");
const { EventEmitter } = require("events");
const { PermanentStateError, TransientStateError } = require("../index.js");
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

    // C10c — a value with no JSON representation AT THE TOP LEVEL is a CALLER
    // MISTAKE, rejected TRANSIENT at the boundary (retry, stay visible, never
    // discard the message — discarding it would lose data; see CLAUDE.md).
    // `JSON.stringify` answers `undefined` for these, which the binding turns
    // into a transient state error.
    const unrepresentable = [
      ["a bare undefined", undefined],
      ["a bare function", () => 1],
    ];
    it.each(unrepresentable)(
      "rejects an unrepresentable write (%s) transient, not permanent",
      async (_label, bad) => {
        const V = nonce();
        env.client = await makeStateClient();
        await env.client.subscribe({
          onMessage: async (ctx, msg) => {
            const c = ctx.state(STATE_DEFS.cart);
            try {
              await c.set({ v: V });
              await c.commit();

              let outcome;
              try {
                await c.set(bad);
                outcome = { threw: false };
              } catch (e) {
                outcome = {
                  threw: true,
                  permanent: e instanceof PermanentStateError,
                  transient: e instanceof TransientStateError,
                };
              }

              env.messageStream.push({ outcome, after: (await c.get()).v });
            } catch (e) {
              env.messageStream.push({ error: e.message });
            }
          },
        });

        await env.client.send(env.topic, nonce(), { go: true });
        const [obs] = await waitForMessages(
          env.messageStream,
          1,
          MESSAGE_TIMEOUT,
        );
        expect(obs.error).toBeUndefined();
        expect(obs.outcome.threw).toBe(true);
        expect(obs.outcome.transient).toBe(true);
        expect(obs.outcome.permanent).toBe(false);
        // The rejected write left the committed value untouched.
        expect(obs.after).toBe(V);
      },
    );

    // C11 — Tracing (item 12), GREEN-IS-CORRECT. In-process JS cannot observe
    // the Rust collection span (separate OTLP pipeline), so this asserts only
    // that (a) a state op inside an active JS span resolves and (b) the JS event
    // context is active during the op. End-to-end span parentage
    // (core collection span -> per-op span -> event span) is verified at the
    // collector, not here.
    it("a state op runs under the active JS trace context (smoke)", async () => {
      const V = nonce();
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          await env.tracer.startActiveSpan("test.state_op", async (span) => {
            try {
              const c = ctx.state(STATE_DEFS.cart);
              await c.set({ v: V });
              const got = await c.get();
              env.messageStream.push({
                got,
                activeSpan: trace.getActiveSpan() !== undefined,
              });
            } finally {
              span.end();
            }
          });
        },
      });

      await env.client.send(env.topic, nonce(), { go: true });
      const [obs] = await waitForMessages(
        env.messageStream,
        1,
        MESSAGE_TIMEOUT,
      );
      expect(obs.got).toEqual({ v: V });
      expect(obs.activeSpan).toBe(true);
    });

    // C12 — Async bridging (item 13): while one handler is blocked awaiting a
    // barrier, a handler for a DIFFERENT key on the SAME partition makes
    // progress (the event loop / native bridge is not serialized). Two keys are
    // forced onto one partition by probing.
    it("a blocked handler does not block a different key on the same partition", async () => {
      // Probe: send 5 keys through the beforeEach client, collect partitions,
      // pick two distinct keys on the SAME partition (guaranteed with 5 keys /
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
