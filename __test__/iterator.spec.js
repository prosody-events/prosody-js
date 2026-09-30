const { MapState, TransientStateError } = require("../index.js");
const { RAW_ITEMS, makeFiniteCursor, makeGatedCursor } = require("./fakes");

describe("keyed state (unit)", () => {
  // Infra-free unit tests over the real state classes driven by FAKE native
  // handles. These are the STRONG home for cursor-lifecycle and argument-typing
  // targets that are only green-is-correct at the integration level (a released
  // permit masks a missing close between pulls).

  // Return() (early break) awaits the native close() exactly once.
  it("iterator return() awaits the native cursor close exactly once", async () => {
    const fake = makeGatedCursor();
    const m = new MapState({ entries: () => fake.cursor }, RAW_ITEMS);
    const it = m.entries();
    await it.next();

    const ret = it.return();
    let settled = false;
    ret.then(() => {
      settled = true;
    });
    // Yield the microtask queue: return() must still be pending on close().
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fake.closedCount()).toBe(1);

    fake.releaseClose();
    await ret;
    expect(fake.closedCount()).toBe(1);
  });

  // Exhaustion maps native null -> done and closes the cursor once.
  it("iterator exhaustion ends the loop and closes the cursor", async () => {
    const fake = makeFiniteCursor([
      ["a", "v1"],
      ["b", "v2"],
    ]);
    const m = new MapState({ entries: () => fake.cursor }, RAW_ITEMS);
    const collected = [];
    for await (const v of m.values()) collected.push(v);
    expect(collected).toEqual(["v1", "v2"]);
    expect(fake.closedCount()).toBe(1);
  });

  it("iterator flattens native ready chunks without pulling per item", async () => {
    const fake = makeFiniteCursor(
      [
        ["a", 1],
        ["b", 2],
        ["c", 3],
        ["d", 4],
      ],
      3,
    );
    const m = new MapState({ entries: () => fake.cursor }, RAW_ITEMS);
    const collected = [];
    for await (const entry of m.entries()) collected.push(entry);
    expect(collected).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ]);
    // Two data chunks plus the exhaustion pull, not one native pull per item.
    expect(fake.pullCount()).toBe(3);
    expect(fake.closedCount()).toBe(1);
  });

  it("iterator serializes concurrent next calls without duplicates or concurrent pulls", async () => {
    let activePulls = 0;
    let maxActivePulls = 0;
    const fake = makeFiniteCursor(
      [
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ],
      2,
    );
    const cursor = {
      async nextChunk(...args) {
        activePulls += 1;
        maxActivePulls = Math.max(maxActivePulls, activePulls);
        try {
          await Promise.resolve();
          return await fake.cursor.nextChunk(...args);
        } finally {
          activePulls -= 1;
        }
      },
      close: (...args) => fake.cursor.close(...args),
    };
    const it = new MapState({ entries: () => cursor }, RAW_ITEMS).entries();

    await expect(
      Promise.all([it.next(), it.next(), it.next()]),
    ).resolves.toEqual([
      { value: ["a", 1], done: false },
      { value: ["b", 2], done: false },
      { value: ["c", 3], done: false },
    ]);
    expect(maxActivePulls).toBe(1);
    await expect(it.next()).resolves.toEqual({ value: undefined, done: true });
    expect(fake.closedCount()).toBe(1);
  });

  it("iterator queues return behind an active next and closes exactly once", async () => {
    let releasePull;
    const pullGate = new Promise((resolve) => (releasePull = resolve));
    let closed = 0;
    const cursor = {
      async nextChunk() {
        await pullGate;
        return [["a", 1]];
      },
      async close() {
        closed += 1;
      },
    };
    const it = new MapState({ entries: () => cursor }, RAW_ITEMS).entries();
    const next = it.next();
    const returned = it.return("stop");

    await Promise.resolve();
    expect(closed).toBe(0);
    releasePull();
    await expect(next).resolves.toEqual({ value: ["a", 1], done: false });
    await expect(returned).resolves.toEqual({ value: "stop", done: true });
    expect(closed).toBe(1);
    await expect(it.next()).resolves.toEqual({ value: undefined, done: true });
  });

  // A pull error closes the cursor, wraps to the typed state error, and
  // finishes the iterator (no further pulls).
  it("iterator pull error closes, wraps to a state error, and finishes", async () => {
    const counts = { closed: 0 };
    const cursor = {
      async nextChunk() {
        const e = new Error("scan boom");
        e.cause = new Error("transient");
        throw e;
      },
      async close() {
        counts.closed += 1;
      },
    };
    const m = new MapState({ entries: () => cursor }, RAW_ITEMS);
    const it = m.entries();
    await expect(it.next()).rejects.toBeInstanceOf(TransientStateError);
    expect(counts.closed).toBe(1);
    await expect(it.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
