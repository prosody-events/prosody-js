const {
  ProsodyClient,
  PublishedDeque,
  PublishedMap,
  PublishedSet,
  PublishedValue,
  deque,
  map,
  messageDeque,
  set,
  value,
} = require("../index.js");
const {
  BOOTSTRAP_SERVERS,
  GROUP_NAME,
  SOURCE_NAME,
  STATE_COLLECTIONS,
} = require("./support");

// Infra-free configuration tests use mock mode and need no external services.
describe("keyed state configuration validation", () => {
  const clients = [];
  const makeConfig = (overrides) => ({
    bootstrapServers: BOOTSTRAP_SERVERS,
    groupId: GROUP_NAME,
    sourceSystem: SOURCE_NAME,
    subscribedTopics: "t",
    mock: true,
    ...overrides,
  });

  const makeClient = async (config) => {
    const client = await ProsodyClient.create(config);
    clients.push(client);
    return client;
  };
  const rejectsConfig = async (config, pattern) => {
    await expect(ProsodyClient.create(config)).rejects.toThrow(pattern);
  };

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.shutdown()));
  });

  // Regression: ttlSeconds arrives as f64, so a sub-second value reaches the
  // conversion instead of being truncated toward zero by a u32 coercion.
  // 0.5 (truncates to 0) and 2.5 (would truncate to 2) both throw.
  it.each([0.5, 2.5, 3.9])(
    "rejects fractional ttlSeconds %p",
    async (ttlSeconds) => {
      await rejectsConfig(
        makeConfig({ stateCollections: [value("v", { ttlSeconds })] }),
        /ttlSeconds: must be a non-negative whole number/,
      );
    },
  );

  // Regression: a negative ttlSeconds used to ToUint32-wrap to ~4.29e9 and
  // evade the `== 0` guard, silently registering a ~136-year TTL. It must now
  // throw a field-named error rather than being accepted.
  it.each([-1, -5])("rejects negative ttlSeconds %p", async (ttlSeconds) => {
    await rejectsConfig(
      makeConfig({ stateCollections: [value("v", { ttlSeconds })] }),
      /ttlSeconds: must be a non-negative whole number/,
    );
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite ttlSeconds %p",
    async (ttlSeconds) => {
      await rejectsConfig(
        makeConfig({ stateCollections: [value("v", { ttlSeconds })] }),
        /ttlSeconds: must be a non-negative whole number/,
      );
    },
  );

  // Regression: a fractional keysetLimit used to truncate (2.5 -> 2) and be
  // silently accepted; it must now throw.
  it.each([2.5, -1, NaN, Infinity])(
    "rejects non-whole keysetLimit %p",
    async (keysetLimit) => {
      await rejectsConfig(
        makeConfig({ stateCollections: [map("m", { keysetLimit })] }),
        /keysetLimit: must be a non-negative whole number/,
      );
    },
  );

  // keysetLimit 0 disables ordered-scan tracking and is a valid whole number.
  it("accepts keysetLimit of zero", async () => {
    await makeClient(
      makeConfig({ stateCollections: [map("m", { keysetLimit: 0 })] }),
    );
  });

  it("rejects keysetLimit on a non-map collection", async () => {
    await rejectsConfig(
      makeConfig({ stateCollections: [value("v", { keysetLimit: 5 })] }),
      /keysetLimit: only valid for map/,
    );
  });

  it("accepts set options and rejects set payloads and capacity", async () => {
    await makeClient(
      makeConfig({
        stateCollections: [
          set("s", { ttlSeconds: 60, keysetLimit: 0, readUncommitted: true }),
        ],
      }),
    );
    await rejectsConfig(
      makeConfig({
        stateCollections: [{ name: "s", kind: "set", payload: "json" }],
      }),
      "stateCollections[0].payload: not valid for set collections",
    );
    await rejectsConfig(
      makeConfig({ stateCollections: [set("s", { capacity: 5 })] }),
      /capacity: only valid for deque/,
    );
    await rejectsConfig(
      makeConfig({ stateCollections: [{ name: "v", kind: "value" }] }),
      "stateCollections[0].payload: required for value, map, and deque collections",
    );
  });

  it("rejects capacity on a non-deque collection", async () => {
    await rejectsConfig(
      makeConfig({ stateCollections: [value("v", { capacity: 5 })] }),
      /capacity: only valid for deque/,
    );
    await rejectsConfig(
      makeConfig({ stateCollections: [map("m", { capacity: 5 })] }),
      /capacity: only valid for deque/,
    );
  });

  // capacity is NonZeroUsize core-side: zero, fractional, negative, and
  // non-finite values are all rejected as non-whole at registration.
  it.each([0, 2.5, -1, NaN, Infinity])(
    "rejects non-whole/zero capacity %p",
    async (capacity) => {
      await rejectsConfig(
        makeConfig({ stateCollections: [deque("d", { capacity })] }),
        /capacity: must be a non-negative whole number in range/,
      );
    },
  );

  it("accepts a positive capacity on both deque flavours", async () => {
    await makeClient(
      makeConfig({
        stateCollections: [
          deque("d", { capacity: 100 }),
          messageDeque("md", { capacity: 100 }),
        ],
      }),
    );
  });

  it("rejects an unknown kind token", async () => {
    await rejectsConfig(
      makeConfig({
        stateCollections: [{ name: "x", kind: "bogus", payload: "json" }],
      }),
      /kind: expected/,
    );
  });

  it("rejects an unknown payload token", async () => {
    await rejectsConfig(
      makeConfig({
        stateCollections: [{ name: "x", kind: "value", payload: "bogus" }],
      }),
      'stateCollections[0].payload: expected "json" or "message", got "bogus"',
    );
  });

  it.each(["0", "-1 MiB", "nonsense"])(
    "rejects invalid stateOwnedCacheSize %p",
    async (stateOwnedCacheSize) => {
      await rejectsConfig(
        makeConfig({ stateOwnedCacheSize }),
        /stateOwnedCacheSize/,
      );
    },
  );

  it.each(["0", "-1 MiB", "nonsense"])(
    "rejects invalid stateMemtableSize %p",
    async (stateMemtableSize) => {
      await rejectsConfig(
        makeConfig({ stateMemtableSize }),
        /stateMemtableSize/,
      );
    },
  );

  // A client that only reads published state needs no topic list. The client
  // default and a definition's readCache take the same forms, and each form
  // crosses into the native reader of every kind.
  const READ_CACHES = [undefined, false, { ttlMs: 1 }, { ttlMs: 1500 }];
  it.each(READ_CACHES)(
    "opens published readers of every kind with readCache %p",
    async (readCache) => {
      const client = await makeClient(
        makeConfig({
          subscribedTopics: undefined,
          subsystem: "readers",
          stateReadCache: readCache,
        }),
      );
      const readers = await Promise.all(
        [value, map, set, deque].map((define) =>
          client.state("accounts", define("balances", { readCache })),
        ),
      );
      expect(readers.map((reader) => reader.constructor)).toEqual([
        PublishedValue,
        PublishedMap,
        PublishedSet,
        PublishedDeque,
      ]);
    },
  );

  it.each([true, { ttlMs: -1 }, { ttlMs: NaN }, { ttlMs: Infinity }])(
    "rejects readCache %p when a reader opens",
    async (readCache) => {
      const client = await makeClient(
        makeConfig({ subscribedTopics: undefined, subsystem: "readers" }),
      );
      await expect(
        client.state("accounts", map("balances", { readCache })),
      ).rejects.toThrow(/readCache/);
    },
  );

  it("accepts the full canonical collection set", async () => {
    await makeClient(makeConfig({ stateCollections: STATE_COLLECTIONS }));
  });
});
