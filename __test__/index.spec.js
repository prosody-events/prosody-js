const { Readable } = require("stream");
const { EventEmitter } = require("events");

const {
  ConsumerState,
  Context,
  ProsodyClient,
  PermanentError,
  TransientError,
  permanent,
  transient,
  value,
  map,
  deque,
  messageValue,
  messageMap,
  messageDeque,
  set,
  MapState,
  SetState,
  DequeState,
  PublishedMap,
  PublishedSet,
  PublishedDeque,
  PermanentStateError,
  TransientStateError,
  flushTelemetry,
  isStateError,
  shutdownTelemetry,
} = require("../index.js");
const { AdminClient } = require("../index.js");
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { trace } = require("@opentelemetry/api");
const { Mode } = require("../index");
const opentelemetry = require("@opentelemetry/api");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-proto");

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  serviceName: "prosody-js-test",
});

sdk.start();

// Handle unhandled promise rejections in CI environments
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Don't exit the process in tests, just log the error
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Don't exit the process in tests, just log the error
});

// Creates a tracer from the global tracer provider
const tracer = opentelemetry.trace.getTracer("prosody-js-test");

// Constants
const MESSAGE_TIMEOUT = 30000;
const GROUP_NAME = "test-group";
const SOURCE_NAME = "test-source";
const BOOTSTRAP_SERVERS =
  process.env.PROSODY_BOOTSTRAP_SERVERS || "localhost:9094";
const CASSANDRA_NODES = process.env.PROSODY_CASSANDRA_NODES || "localhost:9042";
const CASSANDRA_KEYSPACE =
  process.env.PROSODY_CASSANDRA_KEYSPACE || "prosody_test";

test("exports utility APIs", () => {
  expect(AdminClient).toBeDefined();
  expect(flushTelemetry).toEqual(expect.any(Function));
  expect(shutdownTelemetry).toEqual(expect.any(Function));
});

test.each(["onMessage", "onExcise", "onTimer"])(
  "rejects a missing %s handler before native subscription",
  async (missing) => {
    const nativeSubscribe = jest.fn();
    const client = Object.create(ProsodyClient.prototype);
    client.nativeClient = { subscribe: nativeSubscribe };
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
  const client = Object.create(ProsodyClient.prototype);
  client.nativeClient = {
    subscribe: jest.fn(async (handler) => {
      nativeHandler = handler;
    }),
  };
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

test("published state options stay on the descriptor", () => {
  expect(
    value("cart", { published: true, readCache: { ttlMs: 2_000 } }),
  ).toMatchObject({
    name: "cart",
    kind: "value",
    payload: "json",
    published: true,
    readCache: { ttlMs: 2_000 },
  });
});

test.each([
  { stateReadCache: { disabled: true, ttlMs: 1 } },
  { stateReadCacheSize: "0" },
])("rejects invalid published read cache config %p", async (options) => {
  await expect(
    ProsodyClient.create({
      mock: true,
      groupId: GROUP_NAME,
      bootstrapServers: [BOOTSTRAP_SERVERS],
      ...options,
    }),
  ).rejects.toThrow(/stateReadCache/);
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

test("published scans return an async iterator and open lazily", async () => {
  const cursor = {
    nextChunk: jest
      .fn()
      .mockResolvedValueOnce([["item", 7]])
      .mockResolvedValueOnce(null),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const scan = jest.fn().mockReturnValue(cursor);
  const entries = new PublishedMap({ entries: scan }).entries("user-1");

  expect(scan).not.toHaveBeenCalled();
  expect(entries[Symbol.asyncIterator]()).toBe(entries);
  await expect(entries.next()).resolves.toEqual({
    value: ["item", 7],
    done: false,
  });
  expect(scan).toHaveBeenCalledTimes(1);
  await expect(entries.next()).resolves.toEqual({
    value: undefined,
    done: true,
  });
});

test("descriptors retain their owned and published access strategies", async () => {
  const publishedCalls = [];
  const client = Object.create(ProsodyClient.prototype);
  client.nativeClient = {
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
  };

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
  expect(publishedCalls[3]).toEqual(["set", "accounts", "tags", 250, false]);

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

test("set definitions carry set options and no payload", () => {
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
  const collect = async (iterator) => {
    const items = [];
    for await (const item of iterator) items.push(item);
    return items;
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
    {
      subsystem: "email",
      outcome: {
        kind: "timeout",
        message: "no response arrived before the deadline",
      },
    },
    {
      subsystem: "shipping",
      outcome: {
        kind: "formatMismatch",
        message: "the responder answered in another format",
      },
    },
    {
      subsystem: "crm",
      outcome: {
        kind: "malformedResponse",
        message: "the response did not decode",
      },
    },
    { subsystem: "search", outcome: "{" },
  ]);
  const client = Object.create(ProsodyClient.prototype);
  client.nativeClient = { request };

  const results = await client.request(
    "orders",
    "order-1",
    { type: "order.created" },
    {
      subsystems: [
        "inventory",
        "billing",
        "email",
        "shipping",
        "crm",
        "search",
      ],
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
  expect(results.get("email").error.kind).toBe("timeout");
  expect(results.get("shipping").error.kind).toBe("formatMismatch");
  expect(results.get("crm").error.kind).toBe("malformedResponse");
  expect(results.get("search").error.kind).toBe("malformedResponse");
  expect(request).toHaveBeenCalledWith(
    {
      topic: "orders",
      key: "order-1",
      payload: JSON.stringify({ type: "order.created" }),
      metadata: { eventId: undefined, eventType: "order.created" },
      subsystems: [
        "inventory",
        "billing",
        "email",
        "shipping",
        "crm",
        "search",
      ],
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
  const client = Object.create(ProsodyClient.prototype);
  client.nativeClient = { requestExcise };

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

// Helper functions
const generateTopicName = () =>
  `test-topic-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

const createMessageStream = () =>
  new Readable({
    objectMode: true,
    read() {},
  });

const waitForMessages = (stream, count, timeout) =>
  new Promise((resolve, reject) => {
    const messages = [];
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        stream.removeListener("data", dataHandler);
        reject(new Error(`Timeout waiting for ${count} messages`));
      }
    }, timeout);

    const dataHandler = (message) => {
      if (!resolved) {
        messages.push(message);
        if (messages.length === count) {
          resolved = true;
          clearTimeout(timer);
          stream.removeListener("data", dataHandler);
          resolve(messages);
        }
      }
    };

    stream.on("data", dataHandler);
  });

// Waits for the first observation pushed into an object-mode sink that matches
// `predicate`. Used by the live keyed-state tests that need to key off a
// specific observation rather than a fixed count.
const waitForObservation = (stream, predicate, timeout) =>
  new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        stream.removeListener("data", dataHandler);
        reject(new Error("Timeout waiting for matching observation"));
      }
    }, timeout);
    const dataHandler = (message) => {
      if (!resolved && predicate(message)) {
        resolved = true;
        clearTimeout(timer);
        stream.removeListener("data", dataHandler);
        resolve(message);
      }
    };
    stream.on("data", dataHandler);
  });

// Canonical registered collection set reused by the live keyed-state tests, one
// of every kind × payload. `state()` binds these same frozen definitions.
const STATE_DEFS = {
  cart: value("cart"),
  totals: map("totals", { keysetLimit: 256 }),
  backlog: deque("backlog"),
  members: set("members", { keysetLimit: 64 }),
  lastMsg: messageValue("last-msg"),
  msgIndex: messageMap("msg-index"),
  msgLog: messageDeque("msg-log"),
};
const STATE_COLLECTIONS = Object.values(STATE_DEFS);

// Fresh random token per call — defeats pre-existing Cassandra state so an
// assertion can only pass on a value this test wrote.
const nonce = () => Math.random().toString(36).slice(2);

const withCompleteHandlers = (client) => {
  const subscribe = client.subscribe.bind(client);
  client.subscribe = (handler) =>
    subscribe({
      onMessage: handler.onMessage?.bind(handler) ?? (() => null),
      onExcise: handler.onExcise?.bind(handler) ?? (() => null),
      onTimer: handler.onTimer?.bind(handler) ?? (() => {}),
    });
  return client;
};

describe("ProsodyClient", () => {
  let admin;
  let tracer;
  let client;
  let topic;
  let messageStream;

  // Helper methods for timer tests
  const createTimerTestSetup = () => {
    const testEvents = new EventEmitter();
    const timerDelayMs = 2000; // 2 second delay to ensure full second boundaries
    const toleranceMs = 500; // Allow 500ms tolerance
    return { testEvents, timerDelayMs, toleranceMs };
  };

  const createBasicTimerHandler = (
    testEvents,
    customOnMessage = null,
    customOnTimer = null,
  ) => {
    return class TimerHandler {
      async onMessage(context, message) {
        return tracer.startActiveSpan("test.onMessage", async (span) => {
          try {
            testEvents.emit("messageReceived", { context, message });
            if (customOnMessage) {
              await customOnMessage(context, message);
            }
          } finally {
            span.end();
          }
        });
      }

      async onTimer(context, timer) {
        return tracer.startActiveSpan("test.onTimer", async (span) => {
          try {
            testEvents.emit("timerFired", {
              context,
              timer,
              actualTime: new Date(),
            });
            if (customOnTimer) {
              await customOnTimer(context, timer);
            }
          } finally {
            span.end();
          }
        });
      }
    };
  };

  // Builds a client with the canonical state collections registered against the
  // per-test topic. It replaces `client`, which afterEach shuts down.
  // maxConcurrency >= 2 so the async-bridging test can observe interleaving.
  const makeStateClient = async () =>
    withCompleteHandlers(
      await ProsodyClient.create({
        bootstrapServers: BOOTSTRAP_SERVERS,
        groupId: GROUP_NAME,
        sourceSystem: SOURCE_NAME,
        subscribedTopics: topic,
        probePort: null,
        mode: Mode.Pipeline,
        cassandraNodes: CASSANDRA_NODES,
        cassandraKeyspace: CASSANDRA_KEYSPACE,
        stateCollections: STATE_COLLECTIONS,
        maxConcurrency: 4,
        peerBindAddress: "127.0.0.1:0",
      }),
    );

  const sendTestMessage = async (key = "timer-test-key") => {
    const testMessage = {
      key,
      payload: { content: "Trigger timer operations" },
    };
    await client.send(topic, testMessage.key, testMessage.payload);
    return testMessage;
  };

  const expectTimerApproximatelyEqual = (
    timerTime,
    expectedTime,
    toleranceMs = 1000,
  ) => {
    // Account for timer precision - round both times to seconds
    const timerSeconds = Math.floor(timerTime.getTime() / 1000);
    const expectedSeconds = Math.floor(expectedTime.getTime() / 1000);
    expect(Math.abs(timerSeconds - expectedSeconds)).toBeLessThanOrEqual(1);
  };

  beforeAll(async () => {
    tracer = trace.getTracer("prosody-js-test");
    admin = new AdminClient(BOOTSTRAP_SERVERS);
  });

  beforeEach(async () => {
    topic = generateTopicName();
    await admin.createTopic(topic, 4, 1);

    client = withCompleteHandlers(
      await ProsodyClient.create({
        bootstrapServers: BOOTSTRAP_SERVERS,
        groupId: GROUP_NAME,
        sourceSystem: SOURCE_NAME,
        subscribedTopics: topic,
        probePort: null,
        mode: Mode.Pipeline,
        cassandraNodes: CASSANDRA_NODES,
        cassandraKeyspace: CASSANDRA_KEYSPACE,
        subsystem: "inventory",
        peerBindAddress: "127.0.0.1:0",
      }),
    );
    messageStream = createMessageStream();
  });

  afterEach(async () => {
    if (client && (await client.consumerState()) !== ConsumerState.Shutdown) {
      await client.shutdown();
    }

    try {
      if (topic) {
        await admin.deleteTopic(topic);
      }
    } catch (err) {
      console.error("Error deleting topic:", err);
    }
  });

  afterAll(async () => {
    try {
      if (admin) {
        // Clean up admin client resources if possible
        admin = null;
      }
    } catch (err) {
      console.error("Error cleaning up admin client:", err);
    }

    try {
      // Wait 6 seconds to allow traces to be exported
      await new Promise((resolve) => setTimeout(resolve, 6000));
      await sdk.shutdown();
    } catch (err) {
      console.error("Error shutting down OpenTelemetry SDK:", err);
    }
  });

  it("initializes correctly", async () => {
    return tracer.startActiveSpan("test.initialize", async (span) => {
      try {
        expect(client).toBeInstanceOf(ProsodyClient);
        expect(await client.consumerState()).toBe(ConsumerState.Configured);
      } finally {
        span.end();
      }
    });
  });

  it("exposes source system identifier", async () => {
    return tracer.startActiveSpan("test.source_system", async (span) => {
      try {
        expect(client.sourceSystem).toBe(SOURCE_NAME);
        expect(typeof client.sourceSystem).toBe("string");
      } finally {
        span.end();
      }
    });
  });

  it("subscribes and unsubscribes", async () => {
    return tracer.startActiveSpan(
      "test.subscribe_unsubscribe",
      async (span) => {
        try {
          await client.subscribe({
            onMessage: (_, message) => {
              return tracer.startActiveSpan("test.onMessage", async (span) => {
                try {
                  messageStream.push(message);
                } finally {
                  span.end();
                }
              });
            },
          });
          expect(await client.consumerState()).toBe(ConsumerState.Running);

          await client.unsubscribe();
          expect(await client.consumerState()).toBe(ConsumerState.Configured);
        } finally {
          span.end();
        }
      },
    );
  });

  it("sends and receives a message", async () => {
    return tracer.startActiveSpan("test.send_receive", async (span) => {
      try {
        await client.subscribe({
          onMessage: (_, message) => {
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                messageStream.push(message);
              } finally {
                span.end();
              }
            });
          },
        });

        const testMessage = {
          key: "test-key",
          payload: { content: "Hello, Kafka!" },
        };

        await client.send(topic, testMessage.key, testMessage.payload);

        const [receivedMessage] = await waitForMessages(
          messageStream,
          1,
          MESSAGE_TIMEOUT,
        );

        expect(receivedMessage.topic).toBe(topic);
        expect(receivedMessage.key).toBe(testMessage.key);
        expect(receivedMessage.payload).toEqual(testMessage.payload);
      } finally {
        span.end();
      }
    });
  });

  it("sends and receives an excise record", async () => {
    await client.subscribe({
      onExcise: async (_, message) => messageStream.push(message),
    });

    await client.excise(topic, "obsolete-key");
    const [message] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);

    expect(message.key).toBe("obsolete-key");
    expect("payload" in message).toBe(false);
  });

  it("handles multiple messages with correct ordering", async () => {
    return tracer.startActiveSpan("test.multiple_messages", async (span) => {
      try {
        await client.subscribe({
          onMessage: (_, message) => {
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                messageStream.push(message);
              } finally {
                span.end();
              }
            });
          },
        });

        const messagesToSend = [
          { key: "key1", payload: { content: "Message 1", sequence: 1 } },
          { key: "key2", payload: { content: "Message 2", sequence: 1 } },
          { key: "key1", payload: { content: "Message 3", sequence: 2 } },
          { key: "key3", payload: { content: "Message 4", sequence: 1 } },
          { key: "key2", payload: { content: "Message 5", sequence: 2 } },
        ];

        for (const msg of messagesToSend) {
          await client.send(topic, msg.key, msg.payload);
        }

        const receivedMessages = await waitForMessages(
          messageStream,
          messagesToSend.length,
          MESSAGE_TIMEOUT,
        );

        expect(receivedMessages).toHaveLength(messagesToSend.length);

        const groupMessagesByKey = (messages) =>
          messages.reduce((acc, msg) => {
            if (!acc[msg.key]) acc[msg.key] = [];
            acc[msg.key].push(msg);
            return acc;
          }, {});

        const sentMessagesByKey = groupMessagesByKey(messagesToSend);
        const receivedMessagesByKey = groupMessagesByKey(receivedMessages);

        expect(Object.keys(sentMessagesByKey)).toEqual(
          expect.arrayContaining(Object.keys(receivedMessagesByKey)),
        );

        Object.keys(sentMessagesByKey).forEach((key) => {
          const sentMessages = sentMessagesByKey[key];
          const receivedMessages = receivedMessagesByKey[key];

          expect(receivedMessages).toHaveLength(sentMessages.length);

          sentMessages.forEach((sent, index) => {
            expect(receivedMessages[index].payload).toEqual(sent.payload);
          });
        });

        Object.values(receivedMessagesByKey).forEach((messages) => {
          const sequences = messages.map((msg) => msg.payload.sequence);
          expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
        });

        receivedMessages.forEach((msg) => {
          expect(msg.topic).toBe(topic);
        });
      } finally {
        span.end();
      }
    });
  });

  it("supports abort controller in onMessage handler", async () => {
    await tracer.startActiveSpan(
      "test.abort_controller_onMessage",
      async (span) => {
        try {
          const testEvents = new EventEmitter();
          let messageAborted = false;

          await client.subscribe({
            onMessage: (context, message, signal) => {
              return tracer.startActiveSpan("test.onMessage", async (span) => {
                try {
                  const result = new Promise((resolve) => {
                    signal.addEventListener(
                      "abort",
                      () => {
                        messageAborted = true;
                        testEvents.emit("processingAborted", message);
                        resolve();
                      },
                      { once: true },
                    );
                  });

                  testEvents.emit("processingStarted", message);
                  return result;
                } finally {
                  span.end();
                }
              });
            },
          });

          await client.send(topic, "hanging-key", {
            content: "I will hang until aborted",
          });

          await waitForEvent(testEvents, "processingStarted", MESSAGE_TIMEOUT);
          const unsubscribePromise = client.unsubscribe();
          await waitForEvent(testEvents, "processingAborted", MESSAGE_TIMEOUT);
          await unsubscribePromise;

          expect(messageAborted).toBe(true);
          expect(await client.consumerState()).toBe(ConsumerState.Configured);
        } finally {
          span.end();
        }
      },
    );
  });

  it("preserves non-Error abort reasons when send rejects", async () => {
    return tracer.startActiveSpan(
      "test.abort_non_error_reason",
      async (span) => {
        try {
          const controller = new AbortController();
          controller.abort("timer cancelled");

          await expect(
            client.send(
              topic,
              "aborted-key",
              { content: "ignored" },
              controller.signal,
            ),
          ).rejects.toEqual(
            expect.objectContaining({ message: "timer cancelled" }),
          );
        } finally {
          span.end();
        }
      },
    );
  });

  it("handles transient errors with retry", async () => {
    return tracer.startActiveSpan("test.transient_error", async (span) => {
      try {
        let messageCount = 0;
        const demands = [];
        const retryEvent = new EventEmitter();

        class TransientErrorHandler {
          @transient(Error)
          async onMessage(context, message) {
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                messageCount++;
                demands.push({
                  demand: context.demand,
                  frozen: Object.isFrozen(context.demand),
                  stable: context.demand === context.demand,
                });
                if (messageCount === 1) {
                  throw new Error("Transient error occurred");
                } else {
                  retryEvent.emit("retry");
                }
              } finally {
                span.end();
              }
            });
          }
        }

        await client.subscribe(new TransientErrorHandler());

        await client.send(topic, "test-key", {
          content: "Trigger transient error",
        });

        await waitForEvent(retryEvent, "retry", MESSAGE_TIMEOUT);
        // The first attempt is normal demand; the retry carries ordinal 1.
        expect(demands.slice(0, 2)).toEqual([
          { demand: { kind: "normal", retry: 0 }, frozen: true, stable: true },
          { demand: { kind: "failure", retry: 1 }, frozen: true, stable: true },
        ]);
      } finally {
        span.end();
      }
    });
  });

  it("handles permanent errors without retry", async () => {
    return tracer.startActiveSpan("test.permanent_error", async (span) => {
      try {
        let messageCount = 0;
        const errorEvent = new EventEmitter();

        class PermanentErrorHandler {
          @permanent(Error)
          async onMessage(_, message) {
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                messageCount++;
                errorEvent.emit("error-event");
                throw new Error("Permanent error occurred");
              } finally {
                span.end();
              }
            });
          }
        }

        await client.subscribe(new PermanentErrorHandler());

        await client.send(topic, "test-key", {
          content: "Trigger permanent error",
        });

        await waitForEvent(errorEvent, "error-event", MESSAGE_TIMEOUT);

        // Wait a bit to allow for any potential retries
        await new Promise((resolve) => setTimeout(resolve, 5000));

        expect(messageCount).toBe(1);
      } finally {
        span.end();
      }
    });
  });

  it("handles explicit permanent errors without retry", async () => {
    return tracer.startActiveSpan(
      "test.explicit_permanent_error",
      async (span) => {
        try {
          let messageCount = 0;
          const errorEvent = new EventEmitter();

          await client.subscribe({
            onMessage: async (context, message) => {
              return tracer.startActiveSpan("test.onMessage", async (span) => {
                try {
                  messageCount++;
                  errorEvent.emit("error-event");
                  throw new PermanentError("Explicit permanent error occurred");
                } finally {
                  span.end();
                }
              });
            },
          });

          await client.send(topic, "test-key", {
            content: "Trigger explicit permanent error",
          });

          await waitForEvent(errorEvent, "error-event", MESSAGE_TIMEOUT);

          // Wait a bit to allow for any potential retries
          await new Promise((resolve) => setTimeout(resolve, 5000));

          expect(messageCount).toBe(1);
        } finally {
          span.end();
        }
      },
    );
  });

  it("schedules and fires timers at correct time", async () => {
    return tracer.startActiveSpan("test.timer_scheduling", async (span) => {
      try {
        const { testEvents, timerDelayMs, toleranceMs } =
          createTimerTestSetup();
        let scheduledTime;

        const TimerHandler = createBasicTimerHandler(
          testEvents,
          async (context, message) => {
            scheduledTime = new Date(Date.now() + timerDelayMs);
            await context.schedule(scheduledTime);
            testEvents.emit("timerScheduled", scheduledTime);
          },
        );

        await client.subscribe(new TimerHandler());
        const testMessage = await sendTestMessage();

        await waitForEvent(testEvents, "messageReceived", MESSAGE_TIMEOUT);
        await waitForEvent(testEvents, "timerScheduled", MESSAGE_TIMEOUT);

        expect(scheduledTime).toBeDefined();

        const [timerResult] = await waitForEvent(
          testEvents,
          "timerFired",
          timerDelayMs + 5000,
        );
        const { timer, actualTime } = timerResult;

        expect(timer.key).toBe(testMessage.key);
        expectTimerApproximatelyEqual(timer.time, scheduledTime);
        expectTimerApproximatelyEqual(actualTime, scheduledTime, toleranceMs);
      } finally {
        span.end();
      }
    });
  });

  it("clears and reschedules timers correctly", async () => {
    return tracer.startActiveSpan("test.clear_and_schedule", async (span) => {
      try {
        const { testEvents, timerDelayMs } = createTimerTestSetup();
        let firstScheduledTime;
        let secondScheduledTime;
        let timerCount = 0;

        const TimerHandler = createBasicTimerHandler(
          testEvents,
          async (context, message) => {
            // Schedule first timer (4 seconds from now)
            firstScheduledTime = new Date(Date.now() + timerDelayMs * 2);
            await context.schedule(firstScheduledTime);
            testEvents.emit("firstTimerScheduled");

            // Clear and schedule a new timer (2 seconds from now - sooner)
            secondScheduledTime = new Date(Date.now() + timerDelayMs);
            await context.clearAndSchedule(secondScheduledTime);
            testEvents.emit("secondTimerScheduled");
          },
          async (context, timer) => {
            timerCount++;
            testEvents.emit("timerFired", { timer, timerCount });
          },
        );

        await client.subscribe(new TimerHandler());
        await sendTestMessage();

        await waitForEvent(testEvents, "firstTimerScheduled", MESSAGE_TIMEOUT);
        await waitForEvent(testEvents, "secondTimerScheduled", MESSAGE_TIMEOUT);

        // Wait for timer to fire - only the second one should fire
        const [timerResult] = await waitForEvent(
          testEvents,
          "timerFired",
          timerDelayMs + 5000,
        );
        const { timer } = timerResult;

        expect(timerCount).toBe(1); // Only one timer should have fired
        expectTimerApproximatelyEqual(timer.time, secondScheduledTime);
      } finally {
        span.end();
      }
    });
  });

  it("unschedules specific timers", async () => {
    return tracer.startActiveSpan("test.unschedule", async (span) => {
      try {
        const { testEvents, timerDelayMs } = createTimerTestSetup();
        let firstScheduledTime;
        let secondScheduledTime;
        let timerCount = 0;

        // Use different keys to avoid upsert behavior, and ensure full second separation
        const TimerHandler = createBasicTimerHandler(
          testEvents,
          async (context, message) => {
            // Schedule two timers with different times (2 and 4 seconds from now)
            firstScheduledTime = new Date(Date.now() + timerDelayMs); // 2 seconds
            secondScheduledTime = new Date(Date.now() + timerDelayMs * 2); // 4 seconds

            await context.schedule(firstScheduledTime);
            await context.schedule(secondScheduledTime);
            testEvents.emit("timersScheduled");

            // Unschedule the first timer
            await context.unschedule(firstScheduledTime);
            testEvents.emit("firstTimerUnscheduled");
          },
          async (context, timer) => {
            timerCount++;
            testEvents.emit("timerFired", { timer, timerCount });
          },
        );

        await client.subscribe(new TimerHandler());
        await sendTestMessage();

        await waitForEvent(testEvents, "timersScheduled", MESSAGE_TIMEOUT);
        await waitForEvent(
          testEvents,
          "firstTimerUnscheduled",
          MESSAGE_TIMEOUT,
        );

        // Wait for remaining timer to fire (should be the second one)
        const maxWaitTime = timerDelayMs * 2 + 5000;
        const [timerResult] = await waitForEvent(
          testEvents,
          "timerFired",
          maxWaitTime,
        );
        const { timer } = timerResult;

        expect(timerCount).toBe(1); // Only second timer should fire
        expectTimerApproximatelyEqual(timer.time, secondScheduledTime);
      } finally {
        span.end();
      }
    });
  });

  it("clears all scheduled timers", async () => {
    return tracer.startActiveSpan("test.clear_scheduled", async (span) => {
      try {
        const { testEvents, timerDelayMs } = createTimerTestSetup();
        let timerCount = 0;

        const TimerHandler = createBasicTimerHandler(
          testEvents,
          async (context, message) => {
            // Schedule multiple timers with full second separation
            // Each timer is for a different second, so all would normally be kept
            // But we'll clear them all to test clearScheduled()
            const time1 = new Date(Date.now() + timerDelayMs); // 2 seconds
            const time2 = new Date(Date.now() + timerDelayMs + 1000); // 3 seconds
            const time3 = new Date(Date.now() + timerDelayMs + 2000); // 4 seconds

            await context.schedule(time1);
            await context.schedule(time2);
            await context.schedule(time3);
            testEvents.emit("timersScheduled");

            // Clear all timers
            await context.clearScheduled();
            testEvents.emit("allTimersCleared");
          },
          async (context, timer) => {
            timerCount++;
            testEvents.emit("timerFired");
          },
        );

        await client.subscribe(new TimerHandler());
        await sendTestMessage();

        await waitForEvent(testEvents, "timersScheduled", MESSAGE_TIMEOUT);
        await waitForEvent(testEvents, "allTimersCleared", MESSAGE_TIMEOUT);

        // Wait longer than all timers would have fired
        await new Promise((resolve) =>
          setTimeout(resolve, timerDelayMs + 3000),
        );

        expect(timerCount).toBe(0); // No timers should have fired
      } finally {
        span.end();
      }
    });
  });

  it("retrieves scheduled timer times", async () => {
    return tracer.startActiveSpan("test.scheduled", async (span) => {
      try {
        const { testEvents, timerDelayMs } = createTimerTestSetup();
        let scheduledTimes;

        const TimerHandler = createBasicTimerHandler(
          testEvents,
          async (context, message) => {
            // Schedule multiple timers with full second separation
            // Since each timer is for a different second, all should be kept
            // (timers are keyed by message key + time rounded to seconds)
            const time1 = new Date(Date.now() + timerDelayMs); // 2 seconds
            const time2 = new Date(Date.now() + timerDelayMs + 1000); // 3 seconds
            const time3 = new Date(Date.now() + timerDelayMs + 2000); // 4 seconds

            await context.schedule(time1);
            await context.schedule(time2);
            await context.schedule(time3);

            // Get scheduled times
            scheduledTimes = await context.scheduled();
            testEvents.emit("scheduledRetrieved", {
              scheduledTimes,
              expectedTimes: [time1, time2, time3],
            });
          },
        );

        await client.subscribe(new TimerHandler());
        await sendTestMessage();

        const [retrievalResult] = await waitForEvent(
          testEvents,
          "scheduledRetrieved",
          MESSAGE_TIMEOUT,
        );
        const { scheduledTimes: retrievedTimes, expectedTimes } =
          retrievalResult;

        // All scheduled timers should be returned
        expect(retrievedTimes).toHaveLength(3);

        // Sort both arrays for comparison (scheduled() might return in different order)
        const sortedRetrieved = retrievedTimes.sort(
          (a, b) => a.getTime() - b.getTime(),
        );
        const sortedExpected = expectedTimes.sort(
          (a, b) => a.getTime() - b.getTime(),
        );

        sortedExpected.forEach((expectedTime, index) => {
          expectTimerApproximatelyEqual(sortedRetrieved[index], expectedTime);
        });
      } finally {
        span.end();
      }
    });
  });

  it("resolves onCancel for each message (no promise accumulation)", async () => {
    return tracer.startActiveSpan("test.oncancel_per_message", async (span) => {
      try {
        const testEvents = new EventEmitter();
        let onCancelCount = 0;
        let messageCount = 0;
        const numMessages = 5;

        await client.subscribe({
          onMessage: async (context, message, signal) => {
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                messageCount++;

                // Track when onCancel resolves for this message
                context.onCancel().then(() => {
                  onCancelCount++;
                  if (onCancelCount === numMessages) {
                    testEvents.emit("allCancelsResolved");
                  }
                });

                // Complete handler normally
                messageStream.push(message);
                if (messageCount === numMessages) {
                  testEvents.emit("allMessagesProcessed");
                }
              } finally {
                span.end();
              }
            });
          },
        });

        // Send multiple messages
        for (let i = 0; i < numMessages; i++) {
          await client.send(topic, `key-${i}`, { content: `Message ${i}` });
        }

        // Wait for all messages to be processed
        await waitForEvent(testEvents, "allMessagesProcessed", MESSAGE_TIMEOUT);

        // Give time for onCancel promises to resolve
        await waitForEvent(testEvents, "allCancelsResolved", MESSAGE_TIMEOUT);

        // All onCancel promises should have resolved (one per message)
        expect(onCancelCount).toBe(numMessages);
      } finally {
        span.end();
      }
    });
  });

  it("demonstrates upsert behavior for timers at same time", async () => {
    return tracer.startActiveSpan("test.timer_upsert", async (span) => {
      try {
        const { testEvents, timerDelayMs } = createTimerTestSetup();
        let scheduledTimes;
        let timerCount = 0;

        class TimerHandler {
          async onMessage(context, message) {
            return tracer.startActiveSpan("test.onMessage", async (span) => {
              try {
                testEvents.emit("messageReceived", { context, message });

                // Schedule multiple timers at the exact same time (same second)
                // Due to upsert behavior (one timer per key per second), only one should remain
                const sameTime = new Date(Date.now() + timerDelayMs);

                await context.schedule(sameTime);
                await context.schedule(sameTime); // This should replace the first one
                await context.schedule(sameTime); // This should replace the second one

                // Get scheduled times to verify only one remains
                scheduledTimes = await context.scheduled();
                testEvents.emit("scheduledRetrieved", {
                  scheduledTimes,
                  expectedTime: sameTime,
                });
              } finally {
                span.end();
              }
            });
          }

          async onTimer(context, timer) {
            return tracer.startActiveSpan("test.onTimer", async (span) => {
              try {
                timerCount++;
                testEvents.emit("timerFired", { timer, timerCount });
              } finally {
                span.end();
              }
            });
          }
        }

        await client.subscribe(new TimerHandler());
        await sendTestMessage();

        const [retrievalResult] = await waitForEvent(
          testEvents,
          "scheduledRetrieved",
          MESSAGE_TIMEOUT,
        );
        const { scheduledTimes: retrievedTimes, expectedTime } =
          retrievalResult;

        // Due to upsert behavior, only one timer should remain
        expect(retrievedTimes).toHaveLength(1);
        expectTimerApproximatelyEqual(retrievedTimes[0], expectedTime);

        // Wait for the timer to fire
        const [timerResult] = await waitForEvent(
          testEvents,
          "timerFired",
          timerDelayMs + 5000,
        );

        // Only one timer should have fired due to upsert behavior
        expect(timerResult.timerCount).toBe(1);
      } finally {
        span.end();
      }
    });
  });

  describe("configuration validation", () => {
    it("accepts valid messageSpans and timerSpans values", async () => {
      const configured = await ProsodyClient.create({
        bootstrapServers: BOOTSTRAP_SERVERS,
        groupId: GROUP_NAME,
        sourceSystem: SOURCE_NAME,
        subscribedTopics: "test-topic",
        mock: true,
        messageSpans: "child",
        timerSpans: "follows_from",
      });
      await configured.shutdown();
    });

    it("rejects invalid messageSpans with field name in error", async () => {
      await expect(
        ProsodyClient.create({
          bootstrapServers: BOOTSTRAP_SERVERS,
          groupId: GROUP_NAME,
          sourceSystem: SOURCE_NAME,
          subscribedTopics: "test-topic",
          mock: true,
          messageSpans: "invalid",
        }),
      ).rejects.toThrow(/message_spans/);
    });

    it("rejects invalid timerSpans with field name in error", async () => {
      await expect(
        ProsodyClient.create({
          bootstrapServers: BOOTSTRAP_SERVERS,
          groupId: GROUP_NAME,
          sourceSystem: SOURCE_NAME,
          subscribedTopics: "test-topic",
          mock: true,
          timerSpans: "invalid",
        }),
      ).rejects.toThrow(/timer_spans/);
    });
  });

  it("returns a handler failure when a result cannot encode", async () => {
    await client.subscribe({ onMessage: async () => 1n });

    const results = await client.request(
      topic,
      "order-1",
      { type: "order.created" },
      { subsystems: ["inventory"], timeoutMs: MESSAGE_TIMEOUT },
    );

    expect(results.get("inventory")).toMatchObject({
      ok: false,
      error: { kind: "handler" },
    });
  });

  // Live keyed-state FFI scenarios (Appendix 1). Each test registers the
  // canonical collections via makeStateClient(), drives real Kafka + Cassandra,
  // and pushes observation objects into messageStream. State is per message key,
  // so multi-event scenarios drive two sends with the SAME key. Every handler
  // wraps its work in try/catch that reports {tag:"error"} so a throw never
  // silently hangs the wait — except where a throw is the intended stimulus.
  describe("keyed state", () => {
    // C1 — Value FFI boundary: a JSON payload marshals through set -> get
    // byte-identical (a rich nested value: unicode, numbers, booleans, arrays,
    // a NESTED null), and an absent value reads as JS `null` (the erased
    // `Option::None` -> `null` mapping). Cross-event PERSISTENCE and clear
    // SEMANTICS are the collection's job (covered in core); this asserts only
    // the boundary marshalling + the null mapping.
    it("value marshals a JSON payload faithfully and reads absent as null", async () => {
      const K = nonce();
      const rich = {
        s: "café 😀",
        n: 3.5,
        b: true,
        arr: [1, "x", null],
        nested: { z: [true, 2] },
      };
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const c = ctx.state(STATE_DEFS.cart);
          try {
            const before = await c.get(); // never written -> null
            await c.set(rich);
            const after = await c.get(); // read-your-writes -> the marshalled value
            messageStream.push({ before, after });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, K, { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      expect(obs.before).toBeNull();
      // The serde bridge round-trips the whole value, nested null included.
      expect(obs.after).toEqual(rich);
    });

    // C2 — Map FFI boundary: keys (including unicode) and values marshal through
    // set/get, an absent key reads as `null`, and `entries()` yields
    // `[key, value]` pairs over the native cursor. Key ORDERING (forward /
    // backward) is a collection concern covered in core; this asserts pair
    // marshalling + membership only (compared as a set, never a sequence).
    it("map marshals keys (incl. unicode) and values, and entries() yields pairs", async () => {
      const K = nonce();
      const entriesIn = { k1: 1, café: 9, "😀": 7 };
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const m = ctx.state(STATE_DEFS.totals);
          try {
            for (const [k, v] of Object.entries(entriesIn)) await m.set(k, v);
            const collected = [];
            for await (const entry of m.entries()) collected.push(entry);
            messageStream.push({
              collected,
              k1: await m.get("k1"),
              cafe: await m.get("café"),
              emoji: await m.get("😀"),
              absent: await m.get(nonce()),
            });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, K, { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
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

    // C2b — reading several keys at once. This checks only the part that is
    // specific to getMany: you ask for a list of keys and get back a plain
    // array with one entry per key, a key that isn't there comes back as null,
    // and asking for nothing gives back an empty array. Getting a single value
    // back correctly is already covered by C2. Which entry lines up with which
    // key, how repeated keys are handled, and reading the whole batch at one
    // moment are all promises the underlying store makes and tests itself, so
    // they are not repeated here.
    it("reads several keys at once, giving one array entry per key", async () => {
      const K = nonce();
      const missing = nonce();
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const m = ctx.state(STATE_DEFS.totals);
          try {
            const emptyBefore = await m.isEmpty();
            await m.set("a", 1);
            await m.set("b", { v: 2 });
            messageStream.push({
              result: await m.getMany(["a", missing, "b"]),
              empty: await m.getMany([]),
              present: await m.hasMany(["b", missing, "a"]),
              emptyBefore,
              emptyAfter: await m.isEmpty(),
            });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, K, { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
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

    // C3 — Deque FFI boundary: elements (rich JSON) marshal through push ->
    // values()/get, `values()` iterates over the native cursor, and pop/shift on
    // an empty deque read as `null` (the `Option::None` -> `null` mapping).
    // Element ORDERING, which end a pop removes, and length COUNTING are
    // collection concerns covered in core; this asserts boundary marshalling +
    // cursor iteration + the null mapping (membership compared as a set).
    it("deque marshals elements through the cursor and reads empty as null", async () => {
      const Dfull = nonce();
      const Dempty = nonce();
      const items = ["a", { v: 1 }, [2, "😀"]];
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const d = ctx.state(STATE_DEFS.backlog);
          try {
            if (msg.key === Dfull) {
              for (const it of items) await d.push(it);
              const collected = [];
              for await (const x of d.values()) collected.push(x);
              messageStream.push({
                tag: "full",
                collected,
                head: await d.at(0), // some marshalled element (not asserting which)
                popped: await d.pop(), // a marshalled element
              });
            } else if (msg.key === Dempty) {
              messageStream.push({
                tag: "empty",
                pf: await d.shift(),
                pb: await d.pop(),
              });
            }
          } catch (e) {
            messageStream.push({ tag: "error", error: e.message });
          }
        },
      });

      await client.send(topic, Dfull, { go: true });
      await client.send(topic, Dempty, { go: true });
      const obs = await waitForMessages(messageStream, 2, MESSAGE_TIMEOUT);
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

    // C4 — Message collection (messageValue): record the handled message in
    // event1, read it back in event2, observing topic/partition/offset/key/
    // payload equal to the original.
    it("messageValue stores the handled message and reads it back intact", async () => {
      const MK = nonce();
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const lm = ctx.state(STATE_DEFS.lastMsg);
          try {
            if (msg.payload.step === 1) {
              await lm.set(msg);
              messageStream.push({
                tag: "orig",
                topic: msg.topic,
                partition: msg.partition,
                offset: msg.offset.toString(),
                key: msg.key,
                payload: msg.payload,
              });
            } else if (msg.payload.step === 2) {
              const got = await lm.get();
              messageStream.push({
                tag: "got",
                topic: got.topic,
                partition: got.partition,
                offset: got.offset.toString(),
                key: got.key,
                payload: got.payload,
              });
            }
          } catch (e) {
            messageStream.push({ tag: "error", error: e.message });
          }
        },
      });

      await client.send(topic, MK, { step: 1 });
      await client.send(topic, MK, { step: 2 });
      const obs = await waitForMessages(messageStream, 2, MESSAGE_TIMEOUT);
      const byTag = Object.fromEntries(obs.map((o) => [o.tag, o]));
      expect(byTag.error).toBeUndefined();

      const orig = { ...byTag.orig };
      const got = { ...byTag.got };
      delete orig.tag;
      delete got.tag;
      // the stored item is event1's ORIGINAL message; its offset differs from
      // event2's, so equality proves the store returned the recorded message.
      expect(got).toEqual(orig);
      expect(orig.payload).toEqual({ step: 1 });
    });

    // C4b — Message collection (messageDeque): same-event push -> at(0) -> scan
    // round-trips the full Message.
    it("messageDeque round-trips the full message through push/at/scan", async () => {
      const MD = nonce();
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const dl = ctx.state(STATE_DEFS.msgLog);
          try {
            await dl.push(msg);
            const head = await dl.at(0);
            const scanned = [];
            for await (const m of dl.values("forward")) scanned.push(m);
            messageStream.push({
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
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, MD, { marker: MD });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      expect(obs.head).toEqual(obs.orig);
      expect(obs.scannedLen).toBe(1);
      expect(obs.scannedFirstPayload).toEqual({ marker: MD });
    });

    // C4c — Message collection (messageMap): record the handled message under
    // string keys in event1; a later event with the same key gets/scans it back
    // with topic/partition/offset/key/payload intact. Covers the map x message
    // combination (the one canonical kind x payload pairing C4/C4b leave
    // unexercised) and the distinct messageMapState vend + conversion branch.
    it("messageMap round-trips the full message under string keys across events", async () => {
      const MM = nonce();
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const mi = ctx.state(STATE_DEFS.msgIndex);
          try {
            if (msg.payload.step === 1) {
              await mi.set("primary", msg);
              await mi.set("café", msg);
              messageStream.push({
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
              messageStream.push({
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
            messageStream.push({ tag: "error", error: e.message });
          }
        },
      });

      await client.send(topic, MM, { step: 1 });
      await client.send(topic, MM, { step: 2 });
      const obs = await waitForMessages(messageStream, 2, MESSAGE_TIMEOUT);
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
      // returned event1's RECORDED message rather than the live one.
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

    // C5a — commit(): the committed floor survives an attempt that subsequently
    // fails; a fresh handle on redelivery observes it.
    it("commit floor survives a failed attempt and is visible on retry", async () => {
      const V = nonce();
      let attempt = 0;
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          attempt += 1;
          const c = ctx.state(STATE_DEFS.cart);
          if (attempt === 1) {
            await c.set({ v: V });
            await c.commit();
            throw new TransientStateError("fail after commit");
          }
          messageStream.push({ attempt, got: await c.get() });
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.attempt).toBe(2);
      expect(obs.got).toEqual({ v: V });
    });

    // C5b — rollback(): discards uncommitted ops back to the committed floor.
    it("rollback discards uncommitted writes back to the committed floor", async () => {
      const A = nonce();
      const B = nonce();
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const c = ctx.state(STATE_DEFS.cart);
          try {
            const outcomes = [];
            await c.set({ v: A });
            outcomes.push(await c.commit());
            outcomes.push(await c.commit());
            await c.set({ v: B });
            const before = await c.get();
            outcomes.push(await c.rollback());
            outcomes.push(await c.rollback());
            const after = await c.get();
            messageStream.push({ before: before.v, after: after.v, outcomes });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      expect(obs.before).toBe(B);
      expect(obs.after).toBe(A);
      // Each call reports whether it drained buffered operations.
      expect(obs.outcomes).toEqual(["applied", "noOp", "applied", "noOp"]);
    });

    // C5c — commit()/rollback() on a MAP handle exercise the distinct native
    // BoxMapState commit/rollback branch (C5a/C5b only reach ValueState). A
    // committed entry survives a rollback that discards a later uncommitted one.
    it("map commit floor survives a rollback of later uncommitted writes", async () => {
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const m = ctx.state(STATE_DEFS.totals);
          try {
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
            messageStream.push({ before, after });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
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
      client = await makeStateClient();
      await client.subscribe({
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
          messageStream.push({ leakedOutcome, fresh: await c.get() });
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.leakedOutcome.status).toBe("rejected");
      expect(obs.leakedOutcome.transient).toBe(true);
      expect(obs.fresh).toBeNull();
    });

    // C6b — a leaked CONTEXT binding a fresh collection after the attempt fails
    // also fails (a leaked context cannot mint a working handle).
    it("a context leaked across a failed attempt cannot bind a working handle", async () => {
      let attempt = 0;
      let leakedCtx = null;
      client = await makeStateClient();
      await client.subscribe({
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
          messageStream.push(result);
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
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
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          try {
            if (msg.payload.step === 1) {
              leaked = ctx.state(STATE_DEFS.cart);
              await leaked.set({ v: nonce() });
              messageStream.push({ ev: "captured" });
              return;
            }
            if (msg.payload.step === 2) {
              messageStream.push({ ev: "sentinel-started" });
              return;
            }
          } catch (e) {
            messageStream.push({ ev: "error", error: e.message });
          }
        },
      });

      await client.send(topic, K, { step: 1 });
      await waitForObservation(
        messageStream,
        (o) => o.ev === "captured",
        MESSAGE_TIMEOUT,
      );
      await client.send(topic, K, { step: 2 });
      await waitForObservation(
        messageStream,
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
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const m = ctx.state(STATE_DEFS.totals);
          try {
            await m.set("a", 1);
            await m.set("b", 2);
            await m.set("c", 3);
            // eslint-disable-next-line no-unused-vars
            for await (const _entry of m.entries()) break;
            await m.set("after", 99);
            messageStream.push({ ok: (await m.get("after")) === 99 });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, K, { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      expect(obs.ok).toBe(true);
    });

    // C7b — query options cross the native layer into core queries. Each case
    // changes the result when its option is dropped or mistranslated, so every
    // option and the direction are checked end to end. Selection semantics
    // beyond this mapping are core's and are tested there.
    it("queries select keys and positions with every option", async () => {
      const K = nonce();
      client = await makeStateClient();
      await client.subscribe({
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
            messageStream.push({
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
              },
            });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, K, { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
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
      });
    });

    // C7c — set FFI boundary: every set method reaches core and answers in
    // the JS shapes. Members round-trip as strings, batch presence aligns with
    // its input, and iteration yields bare members in key order.
    it("set adds, tests, removes, and iterates members", async () => {
      const K = nonce();
      client = await makeStateClient();
      await client.subscribe({
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
            messageStream.push({
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
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, K, { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
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
      client = await makeStateClient();
      await client.subscribe({
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
          messageStream.push(result);
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.threw).toBe(true);
      expect(obs.permanent).toBe(true);
    });

    // C8b — an invalid scan-direction token is a caller mistake, rejected
    // TransientStateError (retry, stay visible, never discard the message).
    it("an invalid scan direction throws TransientStateError", async () => {
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const m = ctx.state(STATE_DEFS.totals);
          let result;
          try {
            m.entries("sideways");
            result = { threw: false };
          } catch (e) {
            result = {
              threw: true,
              transient: e instanceof TransientStateError,
              msg: e.message,
            };
          }
          messageStream.push(result);
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.threw).toBe(true);
      expect(obs.transient).toBe(true);
      expect(obs.msg).toMatch(/forward.*backward/);
    });

    // C8c-permanent — a rethrown PermanentStateError classifies permanent
    // through the EXISTING bridge (no retry).
    it("rethrowing a PermanentStateError classifies permanent (no retry)", async () => {
      let count = 0;
      const errorEvent = new EventEmitter();
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          count += 1;
          errorEvent.emit("handled");
          throw new PermanentStateError("permanent state boom");
        },
      });

      await client.send(topic, nonce(), { go: true });
      await waitForEvent(errorEvent, "handled", MESSAGE_TIMEOUT);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      expect(count).toBe(1);
    });

    // C8c-transient — a rethrown TransientStateError classifies transient
    // through the EXISTING bridge (retries, never surfaces terminal).
    it("rethrowing a TransientStateError classifies transient (retries)", async () => {
      let count = 0;
      const retryEvent = new EventEmitter();
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          count += 1;
          if (count === 1) {
            throw new TransientStateError("transient state later");
          }
          retryEvent.emit("retry");
        },
      });

      await client.send(topic, nonce(), { go: true });
      await waitForEvent(retryEvent, "retry", MESSAGE_TIMEOUT);
      expect(count).toBe(2);
    });

    // C10a — set(null)/push(null) are caller mistakes: they reject
    // TransientStateError (retry, stay visible, never discard) and leave the
    // store untouched. The value message names clear() as the way to delete.
    it("null-item writes reject transient and leave the store untouched", async () => {
      const V = nonce();
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          const c = ctx.state(STATE_DEFS.cart);
          const d = ctx.state(STATE_DEFS.backlog);
          try {
            await c.set({ v: V });
            await c.commit();

            let valueOutcome;
            try {
              await c.set(null);
              valueOutcome = { transient: false, threw: false };
            } catch (e) {
              valueOutcome = {
                threw: true,
                transient: e instanceof TransientStateError,
                msg: e.message,
              };
            }

            let dequeOutcome;
            try {
              await d.push(null);
              dequeOutcome = { transient: false, threw: false };
            } catch (e) {
              dequeOutcome = {
                threw: true,
                transient: e instanceof TransientStateError,
              };
            }

            messageStream.push({
              valueOutcome,
              dequeOutcome,
              after: (await c.get()).v,
            });
          } catch (e) {
            messageStream.push({ error: e.message });
          }
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
      expect(obs.error).toBeUndefined();
      expect(obs.valueOutcome.threw).toBe(true);
      expect(obs.valueOutcome.transient).toBe(true);
      expect(obs.valueOutcome.msg).toMatch(/clear/);
      expect(obs.dequeOutcome.threw).toBe(true);
      expect(obs.dequeOutcome.transient).toBe(true);
      expect(obs.after).toBe(V);
    });

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
        client = await makeStateClient();
        await client.subscribe({
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

              messageStream.push({ outcome, after: (await c.get()).v });
            } catch (e) {
              messageStream.push({ error: e.message });
            }
          },
        });

        await client.send(topic, nonce(), { go: true });
        const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
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
      client = await makeStateClient();
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          await tracer.startActiveSpan("test.state_op", async (span) => {
            try {
              const c = ctx.state(STATE_DEFS.cart);
              await c.set({ v: V });
              const got = await c.get();
              messageStream.push({
                got,
                activeSpan: opentelemetry.trace.getActiveSpan() !== undefined,
              });
            } finally {
              span.end();
            }
          });
        },
      });

      await client.send(topic, nonce(), { go: true });
      const [obs] = await waitForMessages(messageStream, 1, MESSAGE_TIMEOUT);
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
      await client.subscribe({
        onMessage: async (ctx, msg) => {
          probeStream.push({ key: msg.key, partition: msg.partition });
        },
      });
      const probeKeys = [0, 1, 2, 3, 4].map((i) => `probe-${nonce()}-${i}`);
      for (const k of probeKeys) await client.send(topic, k, { probe: true });
      const probes = await waitForMessages(probeStream, 5, MESSAGE_TIMEOUT);
      await client.shutdown();

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

      client = await makeStateClient();
      await client.subscribe({
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
        await client.send(topic, keyA, { n: 1 });
        await waitForEvent(events, "A-blocked", MESSAGE_TIMEOUT);
        await client.send(topic, keyB, { n: 2 });
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

const waitForEvent = (emitter, eventName, timeout) => {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        emitter.removeListener(eventName, eventHandler);
        reject(new Error(`Timeout waiting for ${eventName}`));
      }
    }, timeout);

    const eventHandler = (...args) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(args);
      }
    };

    emitter.once(eventName, eventHandler);
  });
};

// Infra-free unit tests over the real state classes driven by FAKE native
// handles. These are the STRONG home for cursor-lifecycle and argument-typing
// targets that are only green-is-correct at the integration level (a released
// permit masks a missing close between pulls).
describe("keyed state (unit)", () => {
  // A gated cursor whose close() blocks until releaseClose() — lets a test prove
  // that return() AWAITS the native close().
  const makeGatedCursor = () => {
    let releaseClose;
    const closeGate = new Promise((r) => (releaseClose = r));
    const counts = { closed: 0, nextCalls: 0 };
    return {
      cursor: {
        async nextChunk() {
          counts.nextCalls += 1;
          return [["k" + counts.nextCalls, counts.nextCalls]];
        },
        async close() {
          counts.closed += 1;
          await closeGate;
        },
      },
      releaseClose: () => releaseClose(),
      closedCount: () => counts.closed,
    };
  };

  // A finite cursor that yields `items` then null (exhausted), closing on
  // exhaustion.
  // These handles are built directly over stub natives, so they need an item
  // codec the way Context.state() supplies one. The stubs already speak decoded
  // values, so the codec passes them through.
  const RAW_ITEMS = { decode: (item) => item };

  const makeFiniteCursor = (items, chunkSize = 1) => {
    let i = 0;
    const counts = { closed: 0, pulls: 0 };
    return {
      cursor: {
        async nextChunk() {
          counts.pulls += 1;
          if (i >= items.length) return null;
          const chunk = items.slice(i, i + chunkSize);
          i += chunk.length;
          return chunk;
        },
        async close() {
          counts.closed += 1;
        },
      },
      closedCount: () => counts.closed,
      pullCount: () => counts.pulls,
    };
  };

  // A1 — return() (early break) awaits the native close() exactly once.
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

  // A2 — exhaustion maps native null -> done and closes the cursor once.
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

  // A3 — a pull error closes the cursor, wraps to the typed state error, and
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
  // whole-number guard instead of being truncated toward zero by a u32
  // coercion. 0.5 (truncates to 0) and 2.5 (would truncate to 2) both throw.
  it.each([0.5, 2.5, 3.9])(
    "rejects fractional ttlSeconds %p",
    async (ttlSeconds) => {
      await rejectsConfig(
        makeConfig({ stateCollections: [value("v", { ttlSeconds })] }),
        /ttlSeconds: must be a whole number/,
      );
    },
  );

  // Regression: a negative ttlSeconds used to ToUint32-wrap to ~4.29e9 and
  // evade the `== 0` guard, silently registering a ~136-year TTL. It must now
  // throw a field-named error rather than being accepted.
  it.each([-1, -5])("rejects negative ttlSeconds %p", async (ttlSeconds) => {
    await rejectsConfig(
      makeConfig({ stateCollections: [value("v", { ttlSeconds })] }),
      /ttlSeconds: must be a whole number/,
    );
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite ttlSeconds %p",
    async (ttlSeconds) => {
      await rejectsConfig(
        makeConfig({ stateCollections: [value("v", { ttlSeconds })] }),
        /ttlSeconds: must be a whole number/,
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
        /keysetLimit: must be a whole number/,
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
      /payload: not valid for set collections/,
    );
    await rejectsConfig(
      makeConfig({ stateCollections: [set("s", { capacity: 5 })] }),
      /capacity: only valid for deque/,
    );
    await rejectsConfig(
      makeConfig({ stateCollections: [{ name: "v", kind: "value" }] }),
      /payload: expected/,
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
        /capacity: must be a whole number in 1..=/,
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
      /payload: expected/,
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

  it("accepts the full canonical collection set", async () => {
    await makeClient(makeConfig({ stateCollections: STATE_COLLECTIONS }));
  });
});
