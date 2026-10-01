const {
  MESSAGE_TIMEOUT,
  STATE_DEFS,
  liveSuite,
  nonce,
  waitForMessages,
} = require("./support");

describe("ProsodyClient", () => {
  describe("keyed state", () => {
    const env = liveSuite();
    const { makeStateClient } = env;

    // Live keyed-state FFI scenarios. Each test registers the
    // canonical collections via makeStateClient(), drives real Kafka + Cassandra,
    // and pushes observation objects into messageStream. State is per message key,
    // so multi-event scenarios drive two sends with the same key. A single-event
    // test runs through env.observe. A multi-event handler wraps its work in
    // try/catch that reports {tag:"error"}, so a throw never hangs the wait.

    // Value FFI boundary: a rich JSON value round-trips through set and get.
    // The value holds unicode, numbers, booleans, arrays, and a nested null.
    // An absent value reads as JS `null`. Core tests persistence and clear.
    it("value marshals a JSON payload faithfully and reads absent as null", async () => {
      const K = nonce();
      const rich = {
        s: "café 😀",
        n: 3.5,
        b: true,
        arr: [1, "x", null],
        nested: { z: [true, 2] },
      };
      const obs = await env.observe(async (ctx, msg) => {
        const c = ctx.state(STATE_DEFS.cart);
        const before = await c.get(); // never written -> null
        await c.set(rich);
        const after = await c.get(); // read-your-writes -> the marshalled value
        return { before, after };
      }, K);
      expect(obs.before).toBeNull();
      // The serde bridge round-trips the whole value, nested null included.
      expect(obs.after).toEqual(rich);
    });

    // Map FFI boundary: keys (including unicode) and values marshal through
    // set/get, an absent key reads as `null`, and `entries()` yields
    // `[key, value]` pairs over the native cursor. Key ordering (forward /
    // backward) is a collection concern covered in core; this asserts pair
    // marshalling + membership only (compared as a set, never a sequence).
    it("map marshals keys (incl. unicode) and values, and entries() yields pairs", async () => {
      const K = nonce();
      const entriesIn = { k1: 1, café: 9, "😀": 7 };
      const obs = await env.observe(async (ctx, msg) => {
        const m = ctx.state(STATE_DEFS.totals);
        for (const [k, v] of Object.entries(entriesIn)) await m.set(k, v);
        const collected = [];
        for await (const entry of m.entries()) collected.push(entry);
        return {
          collected,
          k1: await m.get("k1"),
          cafe: await m.get("café"),
          emoji: await m.get("😀"),
          absent: await m.get(nonce()),
        };
      }, K);
      // point reads marshal keys + values faithfully; absent -> null
      expect(obs.k1).toBe(1);
      expect(obs.cafe).toBe(9);
      expect(obs.emoji).toBe(7);
      expect(obs.absent).toBeNull();
      // entries() yields each [key, value] pair over the cursor (set-equality —
      // ordering is core's), and every entry is a [string, value] tuple.
      expect(obs.collected).toEqual(
        expect.arrayContaining(Object.entries(entriesIn)),
      );
      expect(obs.collected).toHaveLength(Object.keys(entriesIn).length);
      for (const entry of obs.collected) {
        expect(Array.isArray(entry)).toBe(true);
        expect(typeof entry[0]).toBe("string");
      }
    });

    // getMany returns a plain array with one entry per key. An absent key reads
    // as null, and an empty key list gives an empty array. The map test above
    // covers a single value. Core tests the key alignment, repeated keys, and
    // the single read moment.
    it("reads several keys at once, giving one array entry per key", async () => {
      const K = nonce();
      const missing = nonce();
      const obs = await env.observe(async (ctx, msg) => {
        const m = ctx.state(STATE_DEFS.totals);
        const emptyBefore = await m.isEmpty();
        await m.set("a", 1);
        await m.set("b", { v: 2 });
        return {
          result: await m.getMany(["a", missing, "b"]),
          empty: await m.getMany([]),
          present: await m.hasMany(["b", missing, "a"]),
          emptyBefore,
          emptyAfter: await m.isEmpty(),
        };
      }, K);
      // we get back an array with one entry per key we asked for; the values
      // come through unchanged and a missing key is null. We check what came
      // back and how many, not the order — the store decides the order.
      expect(Array.isArray(obs.result)).toBe(true);
      expect(obs.result).toHaveLength(3);
      expect(obs.result).toEqual(expect.arrayContaining([1, { v: 2 }, null]));
      // asking for no keys gives back an empty array.
      expect(obs.empty).toEqual([]);
      // hasMany answers each key in input order; isEmpty sees the writes.
      expect(obs.present).toEqual([true, false, true]);
      expect(obs.emptyBefore).toBe(true);
      expect(obs.emptyAfter).toBe(false);
    });

    // Deque FFI boundary: elements (rich JSON) marshal through push ->
    // values()/get, `values()` iterates over the native cursor, and pop/shift on
    // an empty deque read as `null` (the `Option::None` -> `null` mapping).
    // Core tests the element order, the pop ends, and the length. This test
    // checks the conversion, the cursor, and the null mapping. It compares
    // membership as a set.
    it("deque marshals elements through the cursor and reads empty as null", async () => {
      const Dfull = nonce();
      const Dempty = nonce();
      const items = ["a", { v: 1 }, [2, "😀"]];
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          const d = ctx.state(STATE_DEFS.backlog);
          try {
            if (msg.key === Dfull) {
              for (const it of items) await d.push(it);
              const collected = [];
              for await (const x of d.values()) collected.push(x);
              env.messageStream.push({
                tag: "full",
                collected,
                head: await d.at(0), // some marshalled element (not asserting which)
                popped: await d.pop(), // a marshalled element
              });
            } else if (msg.key === Dempty) {
              env.messageStream.push({
                tag: "empty",
                pf: await d.shift(),
                pb: await d.pop(),
              });
            }
          } catch (e) {
            env.messageStream.push({ tag: "error", error: e.message });
          }
        },
      });

      await env.client.send(env.topic, Dfull, { go: true });
      await env.client.send(env.topic, Dempty, { go: true });
      const obs = await waitForMessages(env.messageStream, 2, MESSAGE_TIMEOUT);
      const byTag = Object.fromEntries(obs.map((o) => [o.tag, o]));
      expect(byTag.error).toBeUndefined();

      // values() yields the pushed elements faithfully over the cursor
      // (set-equality — order is core's), including nested/rich JSON.
      expect(byTag.full.collected).toEqual(expect.arrayContaining(items));
      expect(byTag.full.collected).toHaveLength(items.length);
      // get(0)/pop() return marshalled elements that were among those pushed.
      expect(items).toContainEqual(byTag.full.head);
      expect(items).toContainEqual(byTag.full.popped);
      // empty deque: Option::None -> null across the boundary.
      expect(byTag.empty.pf).toBeNull();
      expect(byTag.empty.pb).toBeNull();
    });

    // Message collection (messageValue): record the handled message in
    // event1, read it back in event2, observing topic/partition/offset/key/
    // payload equal to the original.
    it("messageValue stores the handled message and reads it back intact", async () => {
      const MK = nonce();
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          const lm = ctx.state(STATE_DEFS.lastMsg);
          try {
            if (msg.payload.step === 1) {
              await lm.set(msg);
              env.messageStream.push({
                tag: "orig",
                topic: msg.topic,
                partition: msg.partition,
                offset: msg.offset.toString(),
                key: msg.key,
                payload: msg.payload,
              });
            } else if (msg.payload.step === 2) {
              const got = await lm.get();
              env.messageStream.push({
                tag: "got",
                topic: got.topic,
                partition: got.partition,
                offset: got.offset.toString(),
                key: got.key,
                payload: got.payload,
              });
            }
          } catch (e) {
            env.messageStream.push({ tag: "error", error: e.message });
          }
        },
      });

      await env.client.send(env.topic, MK, { step: 1 });
      await env.client.send(env.topic, MK, { step: 2 });
      const obs = await waitForMessages(env.messageStream, 2, MESSAGE_TIMEOUT);
      const byTag = Object.fromEntries(obs.map((o) => [o.tag, o]));
      expect(byTag.error).toBeUndefined();

      const orig = { ...byTag.orig };
      const got = { ...byTag.got };
      delete orig.tag;
      delete got.tag;
      // the stored item is event1's original message; its offset differs from
      // event2's, so equality proves the store returned the recorded message.
      expect(got).toEqual(orig);
      expect(orig.payload).toEqual({ step: 1 });
    });

    // Message collection (messageDeque): same-event push -> at(0) -> scan
    // round-trips the full Message.
    it("messageDeque round-trips the full message through push/at/scan", async () => {
      const MD = nonce();
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          const dl = ctx.state(STATE_DEFS.msgLog);
          try {
            await dl.push(msg);
            const head = await dl.at(0);
            const scanned = [];
            for await (const m of dl.values("forward")) scanned.push(m);
            env.messageStream.push({
              orig: {
                topic: msg.topic,
                partition: msg.partition,
                offset: msg.offset.toString(),
                key: msg.key,
                payload: msg.payload,
              },
              head: {
                topic: head.topic,
                partition: head.partition,
                offset: head.offset.toString(),
                key: head.key,
                payload: head.payload,
              },
              scannedLen: scanned.length,
              scannedFirstPayload: scanned[0].payload,
            });
          } catch (e) {
            env.messageStream.push({ error: e.message });
          }
        },
      });

      await env.client.send(env.topic, MD, { marker: MD });
      const [obs] = await waitForMessages(
        env.messageStream,
        1,
        MESSAGE_TIMEOUT,
      );
      expect(obs.error).toBeUndefined();
      expect(obs.head).toEqual(obs.orig);
      expect(obs.scannedLen).toBe(1);
      expect(obs.scannedFirstPayload).toEqual({ marker: MD });
    });

    // Message collection (messageMap): record the handled message under
    // string keys in event1; a later event with the same key gets/scans it back
    // with topic/partition/offset/key/payload intact. Covers the map x message
    // combination (the one canonical kind x payload pairing the two tests above leave
    // unexercised) and the distinct messageMapState vend + conversion branch.
    it("messageMap round-trips the full message under string keys across events", async () => {
      const MM = nonce();
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          const mi = ctx.state(STATE_DEFS.msgIndex);
          try {
            if (msg.payload.step === 1) {
              await mi.set("primary", msg);
              await mi.set("café", msg);
              env.messageStream.push({
                tag: "orig",
                topic: msg.topic,
                partition: msg.partition,
                offset: msg.offset.toString(),
                key: msg.key,
                payload: msg.payload,
              });
            } else if (msg.payload.step === 2) {
              const got = await mi.get("primary");
              const cafe = await mi.get("café");
              const missing = await mi.get("absent");
              const scannedKeys = [];
              for await (const [k] of mi.entries("forward"))
                scannedKeys.push(k);
              // read several keys at once from a message collection: each
              // entry comes back as the message that was stored, or null when
              // the key isn't there.
              const many = (
                await mi.getMany(["primary", "absent", "café"])
              ).map((m) =>
                m === null
                  ? null
                  : { offset: m.offset.toString(), pl: m.payload },
              );
              env.messageStream.push({
                tag: "got",
                topic: got.topic,
                partition: got.partition,
                offset: got.offset.toString(),
                key: got.key,
                payload: got.payload,
                cafePayload: cafe.payload,
                missing,
                scannedKeys,
                many,
              });
            }
          } catch (e) {
            env.messageStream.push({ tag: "error", error: e.message });
          }
        },
      });

      await env.client.send(env.topic, MM, { step: 1 });
      await env.client.send(env.topic, MM, { step: 2 });
      const obs = await waitForMessages(env.messageStream, 2, MESSAGE_TIMEOUT);
      const byTag = Object.fromEntries(obs.map((o) => [o.tag, o]));
      expect(byTag.error).toBeUndefined();

      const orig = { ...byTag.orig };
      delete orig.tag;
      const got = {
        topic: byTag.got.topic,
        partition: byTag.got.partition,
        offset: byTag.got.offset,
        key: byTag.got.key,
        payload: byTag.got.payload,
      };
      // event2's message carries a distinct offset, so equality proves the map
      // returned event1's recorded message rather than the live one.
      expect(got).toEqual(orig);
      expect(orig.payload).toEqual({ step: 1 });
      // the unicode key round-trips and maps to the same stored message.
      expect(byTag.got.cafePayload).toEqual({ step: 1 });
      // an absent key reads as null.
      expect(byTag.got.missing).toBeNull();
      // forward scan yields both string keys in ascending key order.
      expect(byTag.got.scannedKeys).toEqual([...byTag.got.scannedKeys].sort());
      expect(byTag.got.scannedKeys).toContain("primary");
      expect(byTag.got.scannedKeys).toContain("café");
      // reading several message keys at once gives back an array with one
      // entry per key: a stored key returns its saved message and a missing key
      // returns null. We check what came back and how many, not the order. Both
      // stored keys hold the same message.
      expect(byTag.got.many).toHaveLength(3);
      expect(byTag.got.many.filter((m) => m === null)).toHaveLength(1);
      for (const m of byTag.got.many.filter((m) => m !== null)) {
        expect(m).toEqual({ offset: orig.offset, pl: { step: 1 } });
      }
    });
  });
});
