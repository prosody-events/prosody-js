const { PermanentStateError, value } = require("../index.js");
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

    // C7b — query options cross the native layer into core queries. Each case
    // changes the result when its option is dropped or mistranslated, so every
    // option and the direction are checked end to end. Selection semantics
    // beyond this mapping are core's and are tested there.
    it("queries select keys and positions with every option", async () => {
      const K = nonce();
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx) => {
          const m = ctx.state(STATE_DEFS.totals);
          const d = ctx.state(STATE_DEFS.backlog);
          const collect = async (iterator) => {
            const items = [];
            for await (const item of iterator) items.push(item);
            return items;
          };
          try {
            for (const [i, key] of ["a1", "a2", "a3", "b1"].entries()) {
              await m.set(key, i);
            }
            for (const item of [0, 1, 2, 3, 4]) await d.push(item);
            env.messageStream.push({
              keys: {
                none: await collect(m.keys()),
                backward: await collect(m.keys("backward")),
                prefix: await collect(m.keys({ prefix: "a" })),
                from: await collect(m.keys({ from: "a2" })),
                after: await collect(m.keys({ after: "a2" })),
                to: await collect(m.keys({ to: "a2" })),
                before: await collect(m.keys({ before: "a2" })),
                limit: await collect(m.keys({ limit: 2 })),
                page: await collect(
                  m.keys({ direction: "backward", after: "b1", limit: 2 }),
                ),
                range: await collect(m.keys({ range: ["a2", "b1"] })),
                rangeOpen: await collect(m.keys({ range: ["a2", null] })),
                rangeEdge: await collect(
                  m.keys({ range: ["a1", "b1"], after: "a1" }),
                ),
              },
              entries: await collect(m.entries({ prefix: "b" })),
              values: await collect(m.values({ from: "a3" })),
              positions: {
                from: await collect(d.values({ from: 1 })),
                after: await collect(d.values({ after: 1 })),
                to: await collect(d.values({ to: 1 })),
                before: await collect(d.values({ before: 1 })),
                limit: await collect(d.values({ limit: 2 })),
                page: await collect(
                  d.values({ direction: "backward", after: 3, limit: 2 }),
                ),
                range: await collect(d.values({ range: [1, 3] })),
                rangeOpen: await collect(d.values({ range: [null, 2] })),
                rangeEdge: await collect(d.values({ range: [1, null], to: 3 })),
              },
            });
          } catch (e) {
            env.messageStream.push({ error: e.message });
          }
        },
      });

      await env.client.send(env.topic, K, { go: true });
      const [obs] = await waitForMessages(
        env.messageStream,
        1,
        MESSAGE_TIMEOUT,
      );
      expect(obs.error).toBeUndefined();
      expect(obs.keys).toEqual({
        none: ["a1", "a2", "a3", "b1"],
        backward: ["b1", "a3", "a2", "a1"],
        prefix: ["a1", "a2", "a3"],
        from: ["a2", "a3", "b1"],
        after: ["a3", "b1"],
        to: ["a1", "a2"],
        before: ["a1"],
        limit: ["a1", "a2"],
        page: ["a3", "a2"],
        range: ["a2", "a3"],
        rangeOpen: ["a2", "a3", "b1"],
        rangeEdge: ["a2", "a3"],
      });
      expect(obs.entries).toEqual([["b1", 3]]);
      expect(obs.values).toEqual([2, 3]);
      expect(obs.positions).toEqual({
        from: [1, 2, 3, 4],
        after: [2, 3, 4],
        to: [0, 1],
        before: [0],
        limit: [0, 1],
        page: [2, 1],
        range: [1, 2],
        rangeOpen: [0, 1],
        rangeEdge: [1, 2, 3],
      });
    });

    // C7d — a range is ascending and half-open in both directions. A null
    // bound leaves its end open, and edges narrow the range to the overlap.
    // For each case, the forward scan equals the oracle slice, and the
    // backward scan yields the same items in the opposite order. The backward
    // scan spells each edge in its own query order: forward `after` is
    // backward `before`, and forward `to` is backward `from`. Empty, inverted,
    // and disjoint cases select nothing.
    it("forward and backward range scans select the same items", async () => {
      const K = nonce();
      const members = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"];
      const positions = [0, 1, 2, 3, 4, 5, 6, 7];
      const keyCases = [
        { range: ["m2", "m5"] },
        { range: ["a", "z"] },
        { range: ["m6", "n"] },
        { range: ["a", "m0"] },
        { range: ["m4", "m4"] },
        { range: ["m6", "m2"] },
        { range: ["m5", null] },
        { range: [null, "m2"] },
        { range: [null, null] },
        { range: ["m1", "m6"], above: "m2" },
        { range: ["m1", null], atMost: "m4" },
        { range: ["m5", null], atMost: "m3" },
      ];
      const positionCases = [
        { range: [2, 5] },
        { range: [0, 100] },
        { range: [6, 8] },
        { range: [8, 20] },
        { range: [4, 4] },
        { range: [6, 2] },
        { range: [5, null] },
        { range: [null, 2] },
        { range: [null, null] },
        { range: [1, 6], above: 2 },
        { range: [1, null], atMost: 4 },
        { range: [5, null], atMost: 3 },
      ];
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx) => {
          const s = ctx.state(STATE_DEFS.members);
          const d = ctx.state(STATE_DEFS.backlog);
          const collect = async (iterator) => {
            const items = [];
            for await (const item of iterator) items.push(item);
            return items;
          };
          const scans = async (open, { range, above, atMost }) => ({
            forward: await collect(open({ range, after: above, to: atMost })),
            backward: await collect(
              open({
                range,
                direction: "backward",
                before: above,
                from: atMost,
              }),
            ),
          });
          try {
            for (const member of members) await s.add(member);
            for (const position of positions) await d.push(position);
            const keys = [];
            for (const scan of keyCases) {
              keys.push(await scans((query) => s.keys(query), scan));
            }
            const values = [];
            for (const scan of positionCases) {
              values.push(await scans((query) => d.values(query), scan));
            }
            env.messageStream.push({ keys, values });
          } catch (e) {
            env.messageStream.push({ error: e.message });
          }
        },
      });

      await env.client.send(env.topic, K, { go: true });
      const [obs] = await waitForMessages(
        env.messageStream,
        1,
        MESSAGE_TIMEOUT,
      );
      expect(obs.error).toBeUndefined();
      const check = (cases, scans, all) => {
        cases.forEach(({ range: [start, end], above, atMost }, index) => {
          const oracle = all.filter(
            (item) =>
              (start === null || item >= start) &&
              (end === null || item < end) &&
              (above === undefined || item > above) &&
              (atMost === undefined || item <= atMost),
          );
          expect(scans[index].forward).toEqual(oracle);
          expect(scans[index].backward).toEqual([...oracle].reverse());
        });
      };
      check(keyCases, obs.keys, members);
      check(positionCases, obs.values, positions);
      // The table covers non-empty and empty selections on each side.
      const lengths = [3, 8, 2, 0, 0, 0, 3, 2, 8, 3, 4, 0];
      expect(obs.keys.map((scan) => scan.forward.length)).toEqual(lengths);
      expect(obs.values.map((scan) => scan.forward.length)).toEqual(lengths);
    });

    // C7c — set FFI boundary: every set method reaches core and answers in
    // the JS shapes. Members round-trip as strings, batch presence aligns with
    // its input, and iteration yields bare members in key order.
    it("set adds, tests, removes, and iterates members", async () => {
      const K = nonce();
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx) => {
          const s = ctx.state(STATE_DEFS.members);
          const collect = async (iterator) => {
            const items = [];
            for await (const item of iterator) items.push(item);
            return items;
          };
          try {
            const emptyBefore = await s.isEmpty();
            for (const member of ["b", "a", "café", "c"]) await s.add(member);
            await s.delete("c");
            await s.delete("never-added");
            env.messageStream.push({
              emptyBefore,
              emptyAfter: await s.isEmpty(),
              has: [await s.has("a"), await s.has("c")],
              hasMany: await s.hasMany(["café", "c", "a", "a"]),
              all: await collect(s),
              backward: await collect(s.values("backward")),
              page: await collect(s.keys({ after: "a", limit: 1 })),
            });
            await s.clear();
          } catch (e) {
            env.messageStream.push({ error: e.message });
          }
        },
      });

      await env.client.send(env.topic, K, { go: true });
      const [obs] = await waitForMessages(
        env.messageStream,
        1,
        MESSAGE_TIMEOUT,
      );
      expect(obs.error).toBeUndefined();
      expect(obs.emptyBefore).toBe(true);
      expect(obs.emptyAfter).toBe(false);
      expect(obs.has).toEqual([true, false]);
      expect(obs.hasMany).toEqual([true, false, true, true]);
      expect(obs.all).toEqual(["a", "b", "café"]);
      expect(obs.backward).toEqual(["café", "b", "a"]);
      expect(obs.page).toEqual(["b"]);
    });

    // C8a — binding an unregistered name rejects PermanentStateError at vend.
    it("binding an unregistered collection name throws PermanentStateError", async () => {
      env.client = await makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          let result;
          try {
            ctx.state(value("never-registered-" + nonce()));
            result = { permanent: false, threw: false };
          } catch (e) {
            result = {
              threw: true,
              permanent: e instanceof PermanentStateError,
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
      expect(obs.threw).toBe(true);
      expect(obs.permanent).toBe(true);
    });
  });
});
