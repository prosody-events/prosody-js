const {
  Context,
  DequeState,
  MapState,
  PermanentError,
  PermanentStateError,
  ProsodyClient,
  PublishedDeque,
  PublishedMap,
  PublishedSet,
  PublishedValue,
  SetState,
  TransientError,
  TransientStateError,
  ValueState,
  isStateError,
} = require("../index.js");
const { Message: NativeMessage } = require("../bindings");
const { wrapNative } = require("../lib/client");
const { withParsedPayload } = require("../lib/state/codec");
const { RAW_ITEMS, makeFiniteCursor } = require("./fakes");

describe("keyed state (unit)", () => {
  // The native payload getter throws for bytes that are not UTF-8, before any
  // JSON parse. A native object with no message behind it makes the same
  // getter throw. The read must still be the permanent payload error, and a
  // second read must throw the same error.
  it("a payload that the native getter cannot read is a permanent error", () => {
    const message = withParsedPayload(Object.create(NativeMessage.prototype));
    const read = () => {
      try {
        return message.payload;
      } catch (error) {
        return error;
      }
    };
    const first = read();
    expect(first).toBeInstanceOf(PermanentError);
    expect(first.message).toMatch(/^message payload is not JSON: /);
    expect(first.cause.message).toMatch(/Message/);
    expect(read()).toBe(first);
  });

  // The public objects keep their native handles in private fields, so user
  // code cannot read, replace, or call them.
  it("public objects expose no own properties", () => {
    const objects = [
      wrapNative({}),
      new Context({}),
      new ValueState({}, RAW_ITEMS),
      new MapState({}, RAW_ITEMS),
      new SetState({}),
      new DequeState({}, RAW_ITEMS),
      new PublishedValue({}),
      new PublishedMap({}),
      new PublishedSet({}),
      new PublishedDeque({}),
    ];
    for (const object of objects) {
      expect(Reflect.ownKeys(object)).toEqual([]);
    }
    expect(() => new ProsodyClient()).toThrow(TypeError);
  });

  // A4 — error classes carry category as data and subclass the existing bridge
  // hierarchy so a rethrow classifies with no state-specific bridge path.
  it("state error classes carry category and subclass the bridge hierarchy", () => {
    expect(new PermanentStateError("x").isPermanent).toBe(true);
    expect(new TransientStateError("x").isPermanent).toBe(false);
    expect(new PermanentStateError("x")).toBeInstanceOf(PermanentError);
    expect(new TransientStateError("x")).toBeInstanceOf(TransientError);
    expect(isStateError(new PermanentStateError("x"))).toBe(true);
    expect(isStateError(new TransientStateError("x"))).toBe(true);
    expect(isStateError(new Error("x"))).toBe(false);
  });

  // A5 — DequeState.at() rejects a non-integer index as a caller mistake
  // (TransientStateError — retry, never discard; the native u32 conversion would
  // otherwise truncate a fraction) and treats any out-of-range position as a
  // normal absent read (null) rather than an error. Endpoint routing to the
  // peeks and the negative-index length path are covered in A5d.
  it("deque at() validates the index and returns null out of range", async () => {
    // native.len reports a length of 3; get echoes its index for any read.
    const d = new DequeState(
      { get: async (i) => i, len: async () => 3 },
      RAW_ITEMS,
    );
    // Fractional / NaN / infinite indices are caller mistakes -> transient reject.
    await expect(d.at(1.5)).rejects.toBeInstanceOf(TransientStateError);
    await expect(d.at(1.5)).rejects.toThrow(/index/);
    await expect(d.at(NaN)).rejects.toBeInstanceOf(TransientStateError);
    await expect(d.at(Infinity)).rejects.toBeInstanceOf(TransientStateError);
    // A negative index past the front is out of range -> null, no native read.
    await expect(d.at(-4)).resolves.toBeNull();
    // Beyond the u32 range is out of range -> null, never a wrapped read.
    await expect(d.at(2 ** 32)).resolves.toBeNull();
    // A hostile non-number (Symbol) must REJECT, not throw synchronously while
    // building the diagnostic — at() is declared to return a Promise.
    await expect(d.at(Symbol("x"))).rejects.toBeInstanceOf(TransientStateError);
  });

  // A5b — MapState.has() rides the cheap presence path (native.contains), which
  // returns the boolean directly — no value decode. DequeState.clear() passes
  // straight through to the native clear.
  it("map has() rides native contains and deque clear() passes through", async () => {
    const m = new MapState(
      {
        contains: async (key) => key === "present",
        containsMany: async (keys) => keys.map((key) => key === "present"),
        isEmpty: async () => false,
      },
      RAW_ITEMS,
    );
    await expect(m.has("present")).resolves.toBe(true);
    await expect(m.has("absent")).resolves.toBe(false);
    await expect(m.hasMany(["absent", "present"])).resolves.toEqual([
      false,
      true,
    ]);
    await expect(m.isEmpty()).resolves.toBe(false);

    let cleared = false;
    const d = new DequeState(
      {
        clear: async () => {
          cleared = true;
        },
      },
      RAW_ITEMS,
    );
    await expect(d.clear()).resolves.toBeUndefined();
    expect(cleared).toBe(true);
  });

  // A5c — MapState.keys() rides the cheap key cursor (native.keys), yielding
  // bare keys with no value decode. The transform is identity, not the old
  // pair-projection (entry[0]) — multi-char keys catch a stray `[0]` that a
  // single-character key would hide.
  it("map keys() iterates the key cursor and yields bare keys", async () => {
    const fake = makeFiniteCursor(["apple", "berry", "cherry"]);
    const m = new MapState({ keys: () => fake.cursor }, RAW_ITEMS);
    const collected = [];
    for await (const key of m.keys()) collected.push(key);
    expect(collected).toEqual(["apple", "berry", "cherry"]);
    expect(fake.closedCount()).toBe(1);
  });

  // A5e — query options reach every native cursor opener as given. A bare
  // direction stands for { direction }, and no options mean an empty query.
  it("query options reach every native cursor opener", async () => {
    const opened = [];
    const opener =
      (name) =>
      (...args) => {
        opened.push([name, ...args]);
        return makeFiniteCursor([]).cursor;
      };
    const drain = async (iterator) => {
      // eslint-disable-next-line no-unused-vars
      for await (const _item of iterator);
    };
    const keys = {
      direction: "backward",
      prefix: "user-",
      after: "user-9",
      before: "user-1",
      limit: 2,
    };
    const positions = { direction: "backward", from: 9, to: 1, limit: 3 };
    const m = new MapState(
      { entries: opener("entries"), keys: opener("keys") },
      RAW_ITEMS,
    );
    const d = new DequeState({ values: opener("values") }, RAW_ITEMS);
    const pm = new PublishedMap({
      entries: opener("published.entries"),
      keys: opener("published.keys"),
    });
    const pd = new PublishedDeque({ values: opener("published.values") });

    await drain(m.entries(keys));
    await drain(m.keys("backward"));
    await drain(m.values());
    await drain(d.values(positions));
    await drain(d.values("backward"));
    await drain(pm.entries("u", keys));
    await drain(pm.keys("u", { from: "a", to: "b" }));
    await drain(pm.values("u", { after: "a" }));
    await drain(pd.values("u", positions));
    await drain(m.keys({ range: ["a", "m"], direction: "backward" }));
    await drain(pd.values("u", { range: [2, 5] }));
    await drain(m.keys({ range: ["a", "m"], from: "b", before: "k" }));
    await drain(pd.values("u", { range: [1, 9], after: 2, to: 6 }));
    await drain(pm.keys("u", { range: ["a", null] }));
    await drain(d.values({ range: [null, 4] }));
    await drain(pm.entries("u", { range: [null, null], prefix: "user-" }));

    expect(opened).toEqual([
      ["entries", keys],
      ["keys", { direction: "backward" }],
      ["entries", {}],
      ["values", positions],
      ["values", { direction: "backward" }],
      ["published.entries", "u", keys],
      ["published.keys", "u", { from: "a", to: "b" }],
      ["published.entries", "u", { after: "a" }],
      ["published.values", "u", positions],
      ["keys", { range: ["a", "m"], direction: "backward" }],
      ["published.values", "u", { range: [2, 5] }],
      ["keys", { range: ["a", "m"], from: "b", before: "k" }],
      ["published.values", "u", { range: [1, 9], after: 2, to: 6 }],
      ["published.keys", "u", { range: ["a", null] }],
      ["values", { range: [null, 4] }],
      ["published.entries", "u", { range: [null, null], prefix: "user-" }],
    ]);
  });

  // A5g — every query copies its options at the call. Published readers open
  // their cursor on the first pull, so a later change to the caller's object
  // must not reach the native layer.
  it("queries snapshot their options at the call", async () => {
    const opened = [];
    const opener =
      (name) =>
      (...args) => {
        opened.push([name, ...args]);
        return makeFiniteCursor([]).cursor;
      };
    const drain = async (iterator) => {
      // eslint-disable-next-line no-unused-vars
      for await (const _item of iterator);
    };
    const pm = new PublishedMap({
      entries: opener("entries"),
      keys: opener("keys"),
    });
    const ps = new PublishedSet({ keys: opener("set.keys") });
    const pd = new PublishedDeque({ values: opener("values") });
    const m = new MapState({ keys: opener("owned.keys") }, RAW_ITEMS);

    const keys = { after: "b" };
    const positions = { after: 1 };
    const range = ["a", "m"];
    const iterators = [
      pm.entries("u", keys),
      pm.keys("u", keys),
      pm.values("u", keys),
      ps.values("u", keys),
      pd.values("u", positions),
      m.keys(keys),
      ps.keys("u", { range }),
    ];
    Object.assign(keys, { from: "a", limit: 1.5 });
    Object.assign(positions, { from: 0, limit: 1.5 });
    range.splice(0, 2, 5);
    for (const iterator of iterators) await drain(iterator);

    expect(opened).toEqual([
      ["owned.keys", { after: "b" }],
      ["entries", "u", { after: "b" }],
      ["keys", "u", { after: "b" }],
      ["entries", "u", { after: "b" }],
      ["set.keys", "u", { after: "b" }],
      ["values", "u", { after: 1 }],
      ["set.keys", "u", { range: ["a", "m"] }],
    ]);
  });

  // A5f — option shapes that core cannot represent throw at the call, before
  // any native cursor opens. Setting both edges of a pair is rejected because
  // an options object has no call order to pick a winner.
  it.each([
    ["zero limit", { limit: 0 }, RangeError],
    ["negative limit", { limit: -1 }, RangeError],
    ["fractional limit", { limit: 2.5 }, RangeError],
    ["string limit", { limit: "5" }, TypeError],
    ["from with after", { from: "a", after: "b" }, TypeError],
    ["to with before", { to: "a", before: "b" }, TypeError],
    ["numeric key bound", { from: 1 }, TypeError],
    ["numeric prefix", { prefix: 1 }, TypeError],
    ["number options", 42, TypeError],
    ["null options", null, TypeError],
    ["misspelled option", { befor: "a" }, TypeError],
    [
      "edge pair beside a range",
      { range: ["a", "m"], from: "b", after: "c" },
      TypeError,
    ],
    ["range of one bound", { range: ["a"] }, TypeError],
    ["range of three bounds", { range: ["a", "b", "c"] }, TypeError],
    ["range with a hole", { range: ["a", undefined] }, TypeError],
    ["range object", { range: { start: "a", end: "b" } }, TypeError],
    ["numeric range key", { range: ["a", 1] }, TypeError],
    ["unknown direction", { direction: "reverse" }, TypeError],
    ["unknown direction string", "reverse", TypeError],
    ["numeric direction", { direction: 5 }, TypeError],
  ])("key query rejects %s", (_label, options, ErrorClass) => {
    const native = { entries: jest.fn(), keys: jest.fn() };
    const m = new MapState(native, RAW_ITEMS);
    const pm = new PublishedMap(native);
    expect(() => m.entries(options)).toThrow(ErrorClass);
    expect(() => m.keys(options)).toThrow(ErrorClass);
    expect(() => m.values(options)).toThrow(ErrorClass);
    expect(() => pm.entries("u", options)).toThrow(ErrorClass);
    expect(() => pm.keys("u", options)).toThrow(ErrorClass);
    expect(() => pm.values("u", options)).toThrow(ErrorClass);
    expect(native.entries).not.toHaveBeenCalled();
    expect(native.keys).not.toHaveBeenCalled();
  });

  it.each([
    ["negative position", { from: -1 }, RangeError],
    ["fractional position", { after: 1.5 }, RangeError],
    ["unsafe position", { to: 2 ** 53 }, RangeError],
    ["infinite position", { from: Infinity }, RangeError],
    ["NaN position", { after: NaN }, RangeError],
    ["string position", { before: "1" }, TypeError],
    ["from with after", { from: 1, after: 2 }, TypeError],
    ["to with before", { to: 1, before: 2 }, TypeError],
    ["zero limit", { limit: 0 }, RangeError],
    ["prefix option", { prefix: "a" }, TypeError],
    [
      "edge pair beside a range",
      { range: [1, 4], to: 2, before: 3 },
      TypeError,
    ],
    ["range with an undefined end", { range: [1, undefined] }, TypeError],
    ["range of one bound", { range: [1] }, TypeError],
    ["range string", { range: "1..4" }, TypeError],
    ["string range position", { range: [1, "4"] }, TypeError],
    ["negative range position", { range: [-1, 4] }, RangeError],
    ["fractional range position", { range: [1, 2.5] }, RangeError],
    ["unknown direction", { direction: "sideways" }, TypeError],
    ["unknown direction string", "sideways", TypeError],
  ])("position query rejects %s", (_label, options, ErrorClass) => {
    const native = { values: jest.fn() };
    expect(() => new DequeState(native, RAW_ITEMS).values(options)).toThrow(
      ErrorClass,
    );
    expect(() => new PublishedDeque(native).values("u", options)).toThrow(
      ErrorClass,
    );
    expect(native.values).not.toHaveBeenCalled();
  });

  // A5d — DequeState.at() routes the endpoints to the peeks (native.peekFront /
  // peekBack, one read each) and every other index through native.get; negative
  // indices past -1 still resolve against native.len.
  it("deque at() routes endpoints to peeks and other indices to get", async () => {
    const d = new DequeState(
      {
        peekFront: async () => "F",
        peekBack: async () => "B",
        get: async (i) => i,
        len: async () => 3,
      },
      RAW_ITEMS,
    );
    await expect(d.at(0)).resolves.toBe("F");
    await expect(d.at(-1)).resolves.toBe("B");
    // A non-endpoint non-negative index reads through get.
    await expect(d.at(2)).resolves.toBe(2);
    // A negative index past -1 resolves against len (3): -2 -> position 1.
    await expect(d.at(-2)).resolves.toBe(1);
  });

  // A6 — a malformed definition (bad kind/payload/name) is a caller mistake:
  // Context.state() rejects it TRANSIENT (never permanent), before touching the
  // native context, so a typo never silently vends the wrong collection.
  it("state() rejects a malformed definition as a transient error", () => {
    const ctx = new Context({}); // native never reached — validation precedes vend
    expect(() =>
      ctx.state({ name: "x", kind: "bogus", payload: "json" }),
    ).toThrow(TransientStateError);
    expect(() =>
      ctx.state({ name: "x", kind: "value", payload: "bogus" }),
    ).toThrow(TransientStateError);
    expect(() =>
      ctx.state({ name: "", kind: "value", payload: "json" }),
    ).toThrow(TransientStateError);
    // A non-string name that JSON.stringify cannot serialize (BigInt) must still
    // yield TransientStateError, not a raw TypeError from building the message.
    expect(() =>
      ctx.state({ name: 1n, kind: "value", payload: "json" }),
    ).toThrow(TransientStateError);
    // A hostile definition whose property getter throws must still classify as a
    // caller mistake, not surface the raw synchronous throw.
    expect(() =>
      ctx.state({
        get name() {
          throw new Error("boom");
        },
      }),
    ).toThrow(TransientStateError);
  });
});
