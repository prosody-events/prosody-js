const { getEventListeners } = require("node:events");
const {
  Context,
  PublishedDeque,
  PublishedMap,
  PublishedSet,
  SetState,
  deque,
  map,
  messageDeque,
  messageMap,
  messageValue,
  set,
  value,
} = require("../index.js");
const { wrapNative } = require("../lib/client");
const { collect } = require("./fakes");

test.each(["onMessage", "onExcise", "onTimer"])(
  "rejects a missing %s handler before native subscription",
  async (missing) => {
    const nativeSubscribe = jest.fn();
    const client = wrapNative({ subscribe: nativeSubscribe });
    const handler = {
      onMessage: () => null,
      onExcise: () => null,
      onTimer: () => {},
    };
    delete handler[missing];

    await expect(client.subscribe(handler)).rejects.toThrow(
      `EventHandler.${missing} must be a function`,
    );
    expect(nativeSubscribe).not.toHaveBeenCalled();
  },
);

test.each([
  ["onMessage", { payload: "{}" }],
  ["onExcise", {}],
])("%s converts an undefined response to JSON null", async (name, record) => {
  let nativeHandler;
  const client = wrapNative({
    subscribe: jest.fn(async (handler) => {
      nativeHandler = handler;
    }),
  });
  const handler = {
    onMessage: () => undefined,
    onExcise: () => undefined,
    onTimer: () => {},
  };
  await client.subscribe(handler);
  const context = { onCancel: () => new Promise(() => {}) };
  const message = {
    topic: "orders",
    key: "order-1",
    partition: 0,
    offset: 1,
    ...record,
  };

  await expect(nativeHandler[name](null, [context, message, {}])).resolves.toBe(
    "null",
  );
});

test("published state uses the owned read method names", async () => {
  const mapNative = {
    contains: jest.fn().mockResolvedValue(true),
    containsMany: jest.fn().mockResolvedValue([true, false]),
    isEmpty: jest.fn().mockResolvedValue(true),
  };
  const dequeNative = {
    isEmpty: jest.fn().mockResolvedValue(false),
    peekFront: jest.fn().mockResolvedValue(JSON.stringify("first")),
    peekBack: jest.fn().mockResolvedValue(JSON.stringify("last")),
  };

  const mapState = new PublishedMap(mapNative);
  expect(await mapState.has("user-1", "item")).toBe(true);
  expect(await mapState.hasMany("user-1", ["item", "gone"])).toEqual([
    true,
    false,
  ]);
  expect(mapNative.containsMany).toHaveBeenCalledWith(
    "user-1",
    ["item", "gone"],
    expect.any(Object),
  );
  expect(await mapState.isEmpty("user-1")).toBe(true);
  expect(mapNative.isEmpty).toHaveBeenCalledWith("user-1", expect.any(Object));
  const dequeState = new PublishedDeque(dequeNative);
  expect(await dequeState.isEmpty("user-1")).toBe(false);
  expect(await dequeState.at("user-1", 0)).toBe("first");
  expect(await dequeState.at("user-1", -1)).toBe("last");
});

test("published scans open the cursor at the call", async () => {
  const cursor = {
    nextChunk: jest
      .fn()
      .mockResolvedValueOnce([["item", 7]])
      .mockResolvedValueOnce(null),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const scan = jest.fn().mockReturnValue(cursor);
  const entries = new PublishedMap({ entries: scan }).entries("user-1");

  expect(scan).toHaveBeenCalledTimes(1);
  expect(entries[Symbol.asyncIterator]()).toBe(entries);
  await expect(entries.next()).resolves.toEqual({
    value: ["item", 7],
    done: false,
  });
  await expect(entries.next()).resolves.toEqual({
    value: undefined,
    done: true,
  });
});

test("descriptors retain their owned and published access strategies", async () => {
  const publishedCalls = [];
  const client = wrapNative({
    publishedValue: async (...args) => {
      publishedCalls.push(["value", ...args]);
      return {};
    },
    publishedMap: async (...args) => {
      publishedCalls.push(["map", ...args]);
      return {};
    },
    publishedDeque: async (...args) => {
      publishedCalls.push(["deque", ...args]);
      return {};
    },
    publishedSet: async (...args) => {
      publishedCalls.push(["set", ...args]);
      return {};
    },
  });

  const definitions = [
    value("cart"),
    map("items"),
    deque("jobs"),
    set("tags", { readCache: { ttlMs: 250 } }),
  ];
  await Promise.all(
    definitions.map((definition) => client.state("accounts", definition)),
  );
  expect(
    publishedCalls.map(([kind, subsystem, name]) => [kind, subsystem, name]),
  ).toEqual([
    ["value", "accounts", "cart"],
    ["map", "accounts", "items"],
    ["deque", "accounts", "jobs"],
    ["set", "accounts", "tags"],
  ]);
  expect(publishedCalls[3]).toEqual([
    "set",
    "accounts",
    "tags",
    { ttlMs: 250 },
  ]);

  const ownedCalls = [];
  const nativeContext = {};
  for (const method of [
    "valueState",
    "mapState",
    "dequeState",
    "setState",
    "messageValueState",
    "messageMapState",
    "messageDequeState",
  ]) {
    nativeContext[method] = (name) => {
      ownedCalls.push([method, name]);
      return {};
    };
  }
  const context = new Context(nativeContext);
  [
    value("value"),
    map("map"),
    deque("deque"),
    set("set"),
    messageValue("message-value"),
    messageMap("message-map"),
    messageDeque("message-deque"),
  ].forEach((definition) => context.state(definition));
  expect(ownedCalls).toEqual([
    ["valueState", "value"],
    ["mapState", "map"],
    ["dequeState", "deque"],
    ["setState", "set"],
    ["messageValueState", "message-value"],
    ["messageMapState", "message-map"],
    ["messageDequeState", "message-deque"],
  ]);
});

test("definitions keep their options and are frozen", () => {
  expect(
    value("cart", { published: true, readCache: { ttlMs: 2_000 } }),
  ).toEqual({
    name: "cart",
    kind: "value",
    payload: "json",
    published: true,
    readCache: { ttlMs: 2_000 },
  });
  expect(
    set("tags", { ttlSeconds: 60, keysetLimit: 8, published: true }),
  ).toEqual({
    name: "tags",
    kind: "set",
    ttlSeconds: 60,
    keysetLimit: 8,
    published: true,
  });
  expect(Object.isFrozen(set("tags"))).toBe(true);
});

test("set handles and published sets call the native set methods", async () => {
  const calls = [];
  const record =
    (name, result) =>
    (...args) => {
      calls.push([name, ...args.slice(0, -1)]);
      return Promise.resolve(result);
    };
  const members = new SetState({
    insert: record("insert"),
    contains: record("contains", true),
    containsMany: record("containsMany", [true, false]),
    remove: record("remove"),
    clear: record("clear"),
    isEmpty: record("isEmpty", false),
  });
  await expect(members.add("a")).resolves.toBeUndefined();
  await expect(members.has("a")).resolves.toBe(true);
  await expect(members.hasMany(["a", "b"])).resolves.toEqual([true, false]);
  await expect(members.delete("a")).resolves.toBeUndefined();
  await expect(members.clear()).resolves.toBeUndefined();
  await expect(members.isEmpty()).resolves.toBe(false);

  const reader = new PublishedSet({
    contains: record("published.contains", false),
    containsMany: record("published.containsMany", [false]),
    isEmpty: record("published.isEmpty", true),
  });
  await expect(reader.has("u", "a")).resolves.toBe(false);
  await expect(reader.hasMany("u", ["a"])).resolves.toEqual([false]);
  await expect(reader.isEmpty("u")).resolves.toBe(true);

  expect(calls).toEqual([
    ["insert", "a"],
    ["contains", "a"],
    ["containsMany", ["a", "b"]],
    ["remove", "a"],
    ["clear"],
    ["isEmpty"],
    ["published.contains", "u", "a"],
    ["published.containsMany", "u", ["a"]],
    ["published.isEmpty", "u"],
  ]);
});

test("set iterators yield bare members through the key cursor", async () => {
  const opened = [];
  const cursor = (items) => {
    let done = false;
    return {
      nextChunk: async () => {
        if (done) return null;
        done = true;
        return items;
      },
      close: async () => {},
    };
  };
  const keys = (...args) => {
    opened.push(args);
    return cursor(["apple", "berry"]);
  };
  const members = new SetState({ keys });
  const reader = new PublishedSet({ keys });

  expect(await collect(members)).toEqual(["apple", "berry"]);
  expect(await collect(members.values({ prefix: "a" }))).toEqual([
    "apple",
    "berry",
  ]);
  expect(await collect(members.keys("backward"))).toEqual(["apple", "berry"]);
  expect(await collect(reader.values("u", { limit: 1 }))).toEqual([
    "apple",
    "berry",
  ]);
  expect(await collect(reader.keys("u"))).toEqual(["apple", "berry"]);
  expect(opened).toEqual([
    [{}],
    [{ prefix: "a" }],
    [{ direction: "backward" }],
    ["u", { limit: 1 }],
    ["u", {}],
  ]);
  expect(() => members.keys({ limit: 0 })).toThrow(RangeError);
  expect(() => reader.values("u", { from: "a", after: "b" })).toThrow(
    TypeError,
  );
});

test("request maps native subsystem outcomes", async () => {
  const request = jest.fn().mockResolvedValue([
    {
      subsystem: "inventory",
      outcome: JSON.stringify({ accepted: true }),
    },
    {
      subsystem: "billing",
      outcome: { kind: "handler", message: "rejected" },
    },
    { subsystem: "search", outcome: "{" },
  ]);
  const client = wrapNative({ request });

  const results = await client.request(
    "orders",
    "order-1",
    { type: "order.created" },
    {
      subsystems: ["inventory", "billing", "search"],
      timeoutMs: 2_000,
    },
  );

  expect(results.get("inventory")).toEqual({
    ok: true,
    value: { accepted: true },
  });
  expect(results.get("billing")).toEqual({
    ok: false,
    error: { kind: "handler", message: "rejected" },
  });
  expect(results.get("search").error.kind).toBe("malformedResponse");
  expect(request).toHaveBeenCalledWith(
    {
      topic: "orders",
      key: "order-1",
      payload: JSON.stringify({ type: "order.created" }),
      metadata: { eventId: undefined, eventType: "order.created" },
      subsystems: ["inventory", "billing", "search"],
      timeoutMs: 2_000,
    },
    expect.any(Object),
    undefined,
  );
});

test("requestExcise maps native subsystem outcomes", async () => {
  const requestExcise = jest.fn().mockResolvedValue([
    { subsystem: "inventory", outcome: JSON.stringify({ deleted: true }) },
    {
      subsystem: "billing",
      outcome: { kind: "handler", message: "rejected" },
    },
  ]);
  const client = wrapNative({ requestExcise });

  const results = await client.requestExcise("orders", "order-1", {
    subsystems: ["inventory", "billing"],
    timeoutMs: 2_000,
  });

  expect(results.get("inventory")).toEqual({
    ok: true,
    value: { deleted: true },
  });
  expect(results.get("billing")).toEqual({
    ok: false,
    error: { kind: "handler", message: "rejected" },
  });
  expect(requestExcise).toHaveBeenCalledWith(
    {
      topic: "orders",
      key: "order-1",
      subsystems: ["inventory", "billing"],
      timeoutMs: 2_000,
    },
    expect.any(Object),
    undefined,
  );
});

// One long-lived signal can serve any number of calls: each call removes its
// abort listener when it settles.
test("client calls remove their abort listener when they settle", async () => {
  const { signal } = new AbortController();
  const client = wrapNative({
    send: async () => undefined,
    excise: async () => undefined,
    request: async () => [],
    requestExcise: async () => [],
  });
  const options = { subsystems: [], timeoutMs: 1, signal };
  for (let call = 0; call < 3; call += 1) {
    await client.send("orders", "order-1", {}, signal);
    await client.excise("orders", "order-1", signal);
    await client.request("orders", "order-1", {}, options);
    await client.requestExcise("orders", "order-1", options);
  }
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
});
