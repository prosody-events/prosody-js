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
const { jsonItems, withParsedPayload } = require("../lib/state/codec");
const { RAW_ITEMS, collect, makeFiniteCursor } = require("./fakes");

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

  // The public objects keep their native handles in properties that do not
  // enumerate, so `console.log` and object spreads show no internals.
  it("public objects expose no enumerable own properties", () => {
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
      expect(Object.keys(object)).toEqual([]);
    }
    expect(() => new ProsodyClient()).toThrow(TypeError);
  });

  // A Proxy that forwards the receiver runs each getter and method with the
  // Proxy as `this`. The context must still reach its native handle.
  it("a context works through a forwarding Proxy", async () => {
    const native = {
      shouldCancel: true,
      demand: { kind: "failure", retry: 1 },
      scheduled: async () => [],
    };
    const context = new Proxy(new Context(native), {
      get: (target, prop, receiver) => Reflect.get(target, prop, receiver),
      set: () => false,
    });
    expect(context.shouldCancel).toBe(true);
    expect(context.demand).toEqual({ kind: "failure", retry: 1 });
    expect(context.demand).toBe(context.demand);
    expect(Object.isFrozen(context.demand)).toBe(true);
    await expect(context.scheduled()).resolves.toEqual([]);
  });

  // Error classes carry category as data and subclass the existing bridge
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

  // A value with no JSON form is a caller mistake. Every JSON write rejects
  // it transient before the native call, so the event retries.
  it.each([
    ["undefined", undefined],
    ["a function", () => 1],
  ])("a JSON write of %s rejects transient", async (_label, bad) => {
    const native = {
      set: jest.fn(),
      pushBack: jest.fn(),
      pushFront: jest.fn(),
    };
    const deque = new DequeState(native, jsonItems);
    const writes = [
      new ValueState(native, jsonItems).set(bad),
      new MapState(native, jsonItems).set("k", bad),
      deque.push(bad),
      deque.unshift(bad),
    ];
    await Promise.all(
      writes.map((write) =>
        expect(write).rejects.toBeInstanceOf(TransientStateError),
      ),
    );
    expect(Object.values(native).flatMap((call) => call.mock.calls)).toEqual(
      [],
    );
  });

  // A JSON null has a JSON form. The client adds no check, so core decides.
  it("a JSON write of null reaches the native method as null", async () => {
    const write = jest.fn();
    const native = { set: write, pushBack: write, pushFront: write };
    const deque = new DequeState(native, jsonItems);
    await new ValueState(native, jsonItems).set(null);
    await new MapState(native, jsonItems).set("k", null);
    await deque.push(null);
    await deque.unshift(null);
    const texts = write.mock.calls.map((call) => call.at(-2));
    expect(texts).toEqual(["null", "null", "null", "null"]);
  });

  // DequeState.at() rejects a non-integer index as a caller mistake
  // (TransientStateError), because the native u32 conversion would truncate a
  // fraction. It reads an out-of-range position as null. It routes -1 to the
  // back peek and every other index through get. A negative index other than
  // -1 resolves against the length.
  it("deque at() validates the index and routes each read", async () => {
    const d = new DequeState(
      {
        peekBack: async () => "B",
        get: async (i) => i,
        len: async () => 3,
      },
      RAW_ITEMS,
    );
    await expect(d.at(1.5)).rejects.toBeInstanceOf(TransientStateError);
    await expect(d.at(1.5)).rejects.toThrow(/index/);
    await expect(d.at(NaN)).rejects.toBeInstanceOf(TransientStateError);
    await expect(d.at(Infinity)).rejects.toBeInstanceOf(TransientStateError);
    // A Symbol must reject, not throw while the message is built.
    await expect(d.at(Symbol("x"))).rejects.toBeInstanceOf(TransientStateError);
    await expect(d.at(-4)).resolves.toBeNull();
    await expect(d.at(2 ** 32)).resolves.toBeNull();
    await expect(d.at(0)).resolves.toBe(0);
    await expect(d.at(-1)).resolves.toBe("B");
    await expect(d.at(2)).resolves.toBe(2);
    await expect(d.at(-2)).resolves.toBe(1);
  });

  // MapState.has() rides the cheap presence path (native.contains), which
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

  // Query options reach every native cursor opener as given. A bare
  // direction stands for { direction }, and no options mean an empty query.
  it("query options reach every native cursor opener", async () => {
    const opened = [];
    const opener =
      (name) =>
      (...args) => {
        opened.push([name, ...args]);
        return makeFiniteCursor([]).cursor;
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

    await collect(m.entries(keys));
    await collect(m.keys("backward"));
    await collect(m.values());
    await collect(d.values(positions));
    await collect(d.values("backward"));
    await collect(pm.entries("u", keys));
    await collect(pm.keys("u", { from: "a", to: "b" }));
    await collect(pm.values("u", { after: "a" }));
    await collect(pd.values("u", positions));
    await collect(m.keys({ range: ["a", "m"], direction: "backward" }));
    await collect(pd.values("u", { range: [2, 5] }));
    await collect(m.keys({ range: ["a", "m"], from: "b", before: "k" }));
    await collect(pd.values("u", { range: [1, 9], after: 2, to: 6 }));
    await collect(pm.keys("u", { range: ["a", null] }));
    await collect(d.values({ range: [null, 4] }));
    await collect(pm.entries("u", { range: [null, null], prefix: "user-" }));

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

  // Every query copies its options at the call, so a later change to
  // the caller's object must not reach the native layer.
  it("queries snapshot their options at the call", async () => {
    const opened = [];
    const opener =
      (name) =>
      (...args) => {
        opened.push([name, ...args]);
        return makeFiniteCursor([]).cursor;
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
    for (const iterator of iterators) await collect(iterator);

    expect(opened).toEqual([
      ["entries", "u", { after: "b" }],
      ["keys", "u", { after: "b" }],
      ["entries", "u", { after: "b" }],
      ["set.keys", "u", { after: "b" }],
      ["values", "u", { after: 1 }],
      ["owned.keys", { after: "b" }],
      ["set.keys", "u", { range: ["a", "m"] }],
    ]);
  });

  // Option shapes that core cannot represent throw at the call, before
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

  // Context.state() rejects an object that no definition constructor made.
  // The error is transient, and the native context is never reached.
  it("state() rejects a foreign definition as a transient error", () => {
    const ctx = new Context({});
    expect(() =>
      ctx.state({ name: "x", kind: "value", payload: "json" }),
    ).toThrow(TransientStateError);
  });
});
