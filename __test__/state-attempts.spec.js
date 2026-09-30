const { TransientStateError, isStateError } = require("../index.js");
const {
  MESSAGE_TIMEOUT,
  STATE_DEFS,
  liveSuite,
  nonce,
  waitForMessages,
  waitForObservation,
} = require("./support");

describe("ProsodyClient", () => {
  describe("keyed state", () => {
    const env = liveSuite();
    const { makeStateClient } = env;

    // C5a — commit(): the committed floor survives an attempt that subsequently
    // fails; a fresh handle on redelivery observes it.
    it("commit floor survives a failed attempt and is visible on retry", async () => {
      const V = nonce();
      let attempt = 0;
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          attempt += 1;
          const c = ctx.state(STATE_DEFS.cart);
          if (attempt === 1) {
            await c.set({ v: V });
            await c.commit();
            throw new TransientStateError("fail after commit");
          }
          env.messageStream.push({ attempt, got: await c.get() });
        },
      });

      await env.client.send(env.topic, nonce(), { go: true });
      const [obs] = await waitForMessages(
        env.messageStream,
        1,
        MESSAGE_TIMEOUT,
      );
      expect(obs.attempt).toBe(2);
      expect(obs.got).toEqual({ v: V });
    });

    // C5b — rollback(): discards uncommitted ops back to the committed floor.
    it("rollback discards uncommitted writes back to the committed floor", async () => {
      const A = nonce();
      const B = nonce();
      const obs = await env.observe(async (ctx, msg) => {
        const c = ctx.state(STATE_DEFS.cart);
        const outcomes = [];
        await c.set({ v: A });
        outcomes.push(await c.commit());
        outcomes.push(await c.commit());
        await c.set({ v: B });
        const before = await c.get();
        outcomes.push(await c.rollback());
        outcomes.push(await c.rollback());
        const after = await c.get();
        return {
          before: before.v,
          after: after.v,
          outcomes,
        };
      });
      expect(obs.before).toBe(B);
      expect(obs.after).toBe(A);
      // Each call reports whether it drained buffered operations.
      expect(obs.outcomes).toEqual(["applied", "noOp", "applied", "noOp"]);
    });

    // C5c — commit()/rollback() on a MAP handle exercise the distinct native
    // BoxMapState commit/rollback branch (C5a/C5b only reach ValueState). A
    // committed entry survives a rollback that discards a later uncommitted one.
    it("map commit floor survives a rollback of later uncommitted writes", async () => {
      const obs = await env.observe(async (ctx, msg) => {
        const m = ctx.state(STATE_DEFS.totals);
        await m.set("kept", 1);
        await m.commit();
        await m.set("kept", 2);
        await m.set("dropped", 9);
        const before = {
          kept: await m.get("kept"),
          dropped: await m.get("dropped"),
        };
        await m.rollback();
        const after = {
          kept: await m.get("kept"),
          dropped: await m.get("dropped"),
        };
        return { before, after };
      });
      // before rollback: the uncommitted overwrite and insert are both visible.
      expect(obs.before).toEqual({ kept: 2, dropped: 9 });
      // after rollback: reverts to the committed floor — kept=1, dropped gone.
      expect(obs.after).toEqual({ kept: 1, dropped: null });
    });

    // C6a — a state op from a handle LEAKED past a failed attempt fails with the
    // terminated (transient) error, and the failed attempt's uncommitted write
    // is not visible on retry.
    it("a handle leaked across a failed attempt rejects transient and leaves no state", async () => {
      const bad = nonce();
      let attempt = 0;
      let leaked = null;
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          attempt += 1;
          const c = ctx.state(STATE_DEFS.cart);
          if (attempt === 1) {
            leaked = c;
            await c.set({ v: bad });
            throw new TransientStateError("fail attempt 1");
          }
          // attempt 2: catch-and-report so the expected leaked rejection never
          // escapes the handler and re-triggers retry.
          let leakedOutcome;
          try {
            leakedOutcome = { status: "resolved", value: await leaked.get() };
          } catch (e) {
            leakedOutcome = {
              status: "rejected",
              transient: e instanceof TransientStateError,
            };
          }
          env.messageStream.push({ leakedOutcome, fresh: await c.get() });
        },
      });

      await env.client.send(env.topic, nonce(), { go: true });
      const [obs] = await waitForMessages(
        env.messageStream,
        1,
        MESSAGE_TIMEOUT,
      );
      expect(obs.leakedOutcome.status).toBe("rejected");
      expect(obs.leakedOutcome.transient).toBe(true);
      expect(obs.fresh).toBeNull();
    });

    // C6b — a leaked CONTEXT binding a fresh collection after the attempt fails
    // also fails (a leaked context cannot mint a working handle).
    it("a context leaked across a failed attempt cannot bind a working handle", async () => {
      let attempt = 0;
      let leakedCtx = null;
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          attempt += 1;
          if (attempt === 1) {
            leakedCtx = ctx;
            throw new TransientStateError("fail attempt 1");
          }
          let result;
          try {
            const m = leakedCtx.state(STATE_DEFS.totals);
            result = { status: "resolved", value: await m.get("x") };
          } catch (e) {
            result = {
              status: "rejected",
              transient: e instanceof TransientStateError,
              stateError: isStateError(e),
            };
          }
          env.messageStream.push(result);
        },
      });

      await env.client.send(env.topic, nonce(), { go: true });
      const [obs] = await waitForMessages(
        env.messageStream,
        1,
        MESSAGE_TIMEOUT,
      );
      expect(obs.status).toBe("rejected");
      expect(obs.stateError).toBe(true);
      expect(obs.transient).toBe(true);
    });

    // C6c — a leaked read after a SUCCESSFUL handler also fails (no post-handler
    // read window). A second SAME-KEY sentinel message guarantees, via per-key
    // serialization, that the first event fully tore down before we call the
    // leaked handle from the test body.
    it("a handle leaked past a successful handler rejects transient", async () => {
      const K = nonce();
      let leaked = null;
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          try {
            if (msg.payload.step === 1) {
              leaked = ctx.state(STATE_DEFS.cart);
              await leaked.set({ v: nonce() });
              env.messageStream.push({ ev: "captured" });
              return;
            }
            if (msg.payload.step === 2) {
              env.messageStream.push({ ev: "sentinel-started" });
              return;
            }
          } catch (e) {
            env.messageStream.push({ ev: "error", error: e.message });
          }
        },
      });

      await env.client.send(env.topic, K, { step: 1 });
      await waitForObservation(
        env.messageStream,
        (o) => o.ev === "captured",
        MESSAGE_TIMEOUT,
      );
      await env.client.send(env.topic, K, { step: 2 });
      await waitForObservation(
        env.messageStream,
        (o) => o.ev === "sentinel-started",
        MESSAGE_TIMEOUT,
      );

      await expect(leaked.get()).rejects.toBeInstanceOf(TransientStateError);
    });

    // C7a — early break from an iterator does not wedge later access on the same
    // collection (integration-level; GREEN-IS-CORRECT — the strong close
    // assertion is the fake-cursor unit test). A follow-up op succeeds.
    it("breaking out of a scan leaves the collection usable", async () => {
      const K = nonce();
      const obs = await env.observe(async (ctx, msg) => {
        const m = ctx.state(STATE_DEFS.totals);
        await m.set("a", 1);
        await m.set("b", 2);
        await m.set("c", 3);
        // eslint-disable-next-line no-unused-vars
        for await (const _entry of m.entries()) break;
        await m.set("after", 99);
        return { ok: (await m.get("after")) === 99 };
      }, K);
      expect(obs.ok).toBe(true);
    });
  });
});
