const {
  ProsodyClient,
  PublishedDeque,
  PublishedMap,
  PublishedSet,
  PublishedValue,
  TransientStateError,
  deque,
  map,
  messageDeque,
  set,
  value,
} = require("../index.js");
const { STATE_COLLECTIONS, mockConfig } = require("./support");

// Infra-free configuration tests use mock mode and need no external services.
describe("keyed state configuration validation", () => {
  const clients = [];
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

  // A count option converts without loss, or registration names the option
  // and fails. A u32 coercion once truncated 0.5 to 0 and wrapped -1 to a
  // 136-year TTL, and a fractional keysetLimit once truncated to a valid one.
  it.each([
    ...[0.5, 2.5, -1, NaN, Infinity, -Infinity].map((v) => [
      "ttlSeconds",
      v,
      value,
    ]),
    ...[2.5, -1, NaN, Infinity].map((v) => ["keysetLimit", v, map]),
    ...[0, 2.5, -1, NaN, Infinity].map((v) => ["capacity", v, deque]),
  ])("rejects %s = %p", async (option, bad, define) => {
    await rejectsConfig(
      mockConfig({ stateCollections: [define("c", { [option]: bad })] }),
      `${option}: must be a non-negative whole number`,
    );
  });

  // keysetLimit 0 disables ordered-scan tracking and is a valid whole number.
  it("accepts keysetLimit of zero", async () => {
    await makeClient(
      mockConfig({ stateCollections: [map("m", { keysetLimit: 0 })] }),
    );
  });

  it.each([
    [value("v", { keysetLimit: 5 }), "keysetLimit: only valid for map"],
    [value("v", { capacity: 5 }), "capacity: only valid for deque"],
    [map("m", { capacity: 5 }), "capacity: only valid for deque"],
    [set("s", { capacity: 5 }), "capacity: only valid for deque"],
  ])("rejects an option on the wrong kind %#", async (definition, message) => {
    await rejectsConfig(
      mockConfig({ stateCollections: [definition] }),
      message,
    );
  });

  it("accepts set options and rejects set payloads", async () => {
    await makeClient(
      mockConfig({
        stateCollections: [
          set("s", { ttlSeconds: 60, keysetLimit: 0, readUncommitted: true }),
        ],
      }),
    );
    await rejectsConfig(
      mockConfig({
        stateCollections: [{ name: "s", kind: "set", payload: "json" }],
      }),
      "stateCollections[0].payload: not valid for set collections",
    );
    await rejectsConfig(
      mockConfig({ stateCollections: [{ name: "v", kind: "value" }] }),
      "stateCollections[0].payload: required for value, map, and deque collections",
    );
  });

  it("accepts a positive capacity on both deque flavours", async () => {
    await makeClient(
      mockConfig({
        stateCollections: [
          deque("d", { capacity: 100 }),
          messageDeque("md", { capacity: 100 }),
        ],
      }),
    );
  });

  it("rejects an unknown kind token", async () => {
    await rejectsConfig(
      mockConfig({
        stateCollections: [{ name: "x", kind: "bogus", payload: "json" }],
      }),
      /kind: expected/,
    );
  });

  it("rejects an unknown payload token", async () => {
    await rejectsConfig(
      mockConfig({
        stateCollections: [{ name: "x", kind: "value", payload: "bogus" }],
      }),
      'stateCollections[0].payload: expected "json" or "message", got "bogus"',
    );
  });

  it.each([
    ...["0", "-1 MiB", "nonsense"].flatMap((size) => [
      ["stateOwnedCacheSize", size],
      ["stateMemtableSize", size],
    ]),
    ["stateReadCacheSize", "0"],
  ])("rejects %s = %p", async (option, size) => {
    await rejectsConfig(mockConfig({ [option]: size }), `${option}: `);
  });

  // A client that only reads published state needs no topic list. The client
  // default and a definition's readCache take the same forms, and each form
  // crosses into the native reader of every kind. Mock mode holds no
  // publication, so each read fails with the typed error of an owned read.
  const READ_CACHES = [undefined, false, { ttlMs: 1 }, { ttlMs: 1500 }];
  it.each(READ_CACHES)(
    "opens published readers of every kind with readCache %p",
    async (readCache) => {
      const client = await makeClient(
        mockConfig({
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
      const [valueReader, mapReader, setReader, dequeReader] = readers;
      const reads = [
        valueReader.get("k"),
        mapReader.get("k", "a"),
        setReader.has("k", "a"),
        dequeReader.length("k"),
      ];
      await Promise.all(
        reads.map((read) => expect(read).rejects.toThrow(TransientStateError)),
      );
    },
  );

  it.each([true, { ttlMs: -1 }, { ttlMs: NaN }, { ttlMs: Infinity }])(
    "rejects readCache %p when a reader opens",
    async (readCache) => {
      const client = await makeClient(
        mockConfig({ subscribedTopics: undefined, subsystem: "readers" }),
      );
      await expect(
        client.state("accounts", map("balances", { readCache })),
      ).rejects.toThrow(/readCache/);
    },
  );

  it("accepts the full canonical collection set", async () => {
    await makeClient(mockConfig({ stateCollections: STATE_COLLECTIONS }));
  });
});
