/**
 * Shared test support: service addresses, stream and event waiters, the
 * canonical state definitions, and the live suite harness.
 *
 * Jest runs only `*.spec.js` files, so this module is never a test itself.
 */

const { Readable } = require("stream");
const { EventEmitter, on, once } = require("events");
const { trace } = require("@opentelemetry/api");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-proto");
const {
  AdminClient,
  ConsumerState,
  Mode,
  ProsodyClient,
  deque,
  map,
  messageDeque,
  messageMap,
  messageValue,
  set,
  value,
} = require("../index.js");

// Handle unhandled promise rejections in CI environments
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Don't exit the process in tests, just log the error
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Don't exit the process in tests, just log the error
});

const MESSAGE_TIMEOUT = 30000;
const GROUP_NAME = "test-group";
const SOURCE_NAME = "test-source";
const BOOTSTRAP_SERVERS =
  process.env.PROSODY_BOOTSTRAP_SERVERS || "localhost:9094";
const CASSANDRA_NODES = process.env.PROSODY_CASSANDRA_NODES || "localhost:9042";
const CASSANDRA_KEYSPACE =
  process.env.PROSODY_CASSANDRA_KEYSPACE || "prosody_test";

const generateTopicName = () =>
  `test-topic-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

const createMessageStream = () =>
  new Readable({
    objectMode: true,
    read() {},
  });

// Waits for the first observation pushed into an object-mode stream that
// matches `predicate`.
const waitForObservation = async (stream, predicate, timeout) => {
  const signal = AbortSignal.timeout(timeout);
  for await (const [message] of on(stream, "data", { signal })) {
    if (predicate(message)) return message;
  }
};

const waitForMessages = async (stream, count, timeout) => {
  const messages = [];
  await waitForObservation(
    stream,
    (message) => messages.push(message) === count,
    timeout,
  );
  return messages;
};

const waitForEvent = (emitter, eventName, timeout) =>
  once(emitter, eventName, { signal: AbortSignal.timeout(timeout) });

// A mock-mode client configuration for the tests that need no services.
const mockConfig = (overrides) => ({
  bootstrapServers: BOOTSTRAP_SERVERS,
  groupId: GROUP_NAME,
  sourceSystem: SOURCE_NAME,
  subscribedTopics: "test-topic",
  mock: true,
  probePort: null,
  ...overrides,
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

/**
 * Registers the live suite hooks and returns the per-test environment.
 *
 * Each test gets a fresh topic, its own consumer group, a configured client,
 * and an empty message stream. Read them from the returned object inside a
 * test, because the hooks replace them before every test.
 * @returns {object} The live test environment.
 */
function liveSuite() {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    serviceName: "prosody-js-test",
  });
  sdk.start();

  const env = {
    admin: undefined,
    tracer: undefined,
    client: undefined,
    topic: undefined,
    groupId: undefined,
    messageStream: undefined,

    createTimerTestSetup() {
      const testEvents = new EventEmitter();
      const timerDelayMs = 2000; // 2 second delay to ensure full second boundaries
      return { testEvents, timerDelayMs };
    },

    createBasicTimerHandler(
      testEvents,
      customOnMessage = null,
      customOnTimer = null,
    ) {
      return class TimerHandler {
        async onMessage(context, message) {
          testEvents.emit("messageReceived", { context, message });
          if (customOnMessage) {
            await customOnMessage(context, message);
          }
        }

        async onTimer(context, timer) {
          testEvents.emit("timerFired", {
            context,
            timer,
            actualTime: new Date(),
          });
          if (customOnTimer) {
            await customOnTimer(context, timer);
          }
        }
      };
    },

    // Builds a pipeline client for the per-test topic and group. The options
    // override the shared defaults. Assign the result to `client`, which
    // afterEach shuts down.
    async makeClient(options) {
      return withCompleteHandlers(
        await ProsodyClient.create({
          bootstrapServers: BOOTSTRAP_SERVERS,
          groupId: env.groupId,
          sourceSystem: SOURCE_NAME,
          subscribedTopics: env.topic,
          probePort: null,
          mode: Mode.Pipeline,
          cassandraNodes: CASSANDRA_NODES,
          cassandraKeyspace: CASSANDRA_KEYSPACE,
          peerBindAddress: "127.0.0.1:0",
          ...options,
        }),
      );
    },

    // Builds a client with the canonical state collections registered.
    // maxConcurrency >= 2 so the async-bridging test can observe interleaving.
    makeStateClient() {
      return env.makeClient({
        stateCollections: STATE_COLLECTIONS,
        maxConcurrency: 4,
      });
    },

    // Runs `onMessage` for one message on a state client and returns the
    // value it returns. It rejects with the error when the handler throws.
    async observe(onMessage, key = nonce()) {
      env.client = await env.makeStateClient();
      await env.client.subscribe({
        onMessage: async (ctx, msg) => {
          try {
            env.messageStream.push({ value: await onMessage(ctx, msg) });
          } catch (error) {
            env.messageStream.push({ error });
          }
        },
      });
      await env.client.send(env.topic, key, { go: true });
      const [observation] = await waitForMessages(
        env.messageStream,
        1,
        MESSAGE_TIMEOUT,
      );
      if ("error" in observation) throw observation.error;
      return observation.value;
    },

    async sendTestMessage(key = "timer-test-key") {
      const testMessage = {
        key,
        payload: { content: "Trigger timer operations" },
      };
      await env.client.send(env.topic, testMessage.key, testMessage.payload);
      return testMessage;
    },

    expectTimerApproximatelyEqual(timerTime, expectedTime) {
      // Account for timer precision - round both times to seconds
      const timerSeconds = Math.floor(timerTime.getTime() / 1000);
      const expectedSeconds = Math.floor(expectedTime.getTime() / 1000);
      expect(Math.abs(timerSeconds - expectedSeconds)).toBeLessThanOrEqual(1);
    },
  };

  beforeAll(async () => {
    env.tracer = trace.getTracer("prosody-js-test");
    env.admin = new AdminClient(BOOTSTRAP_SERVERS);
  });

  beforeEach(async () => {
    env.topic = generateTopicName();
    // Each test joins its own consumer group. In a shared group, a member
    // that stops without leaving blocks every new member's partition
    // assignment until its session expires, which is longer than
    // MESSAGE_TIMEOUT.
    env.groupId = `${GROUP_NAME}-${nonce()}`;
    await env.admin.createTopic(env.topic, 4, 1);

    env.client = await env.makeClient({ subsystem: "inventory" });
    env.messageStream = createMessageStream();
  });

  afterEach(async () => {
    const { client, topic } = env;
    if (client && (await client.consumerState()) !== ConsumerState.Shutdown) {
      await client.shutdown();
    }

    try {
      if (topic) {
        await env.admin.deleteTopic(topic);
      }
    } catch (err) {
      console.error("Error deleting topic:", err);
    }
  });

  afterAll(async () => {
    env.admin = undefined;
    try {
      // Shutdown exports the pending spans before it resolves.
      await sdk.shutdown();
    } catch (err) {
      console.error("Error shutting down OpenTelemetry SDK:", err);
    }
  });

  return env;
}

module.exports = {
  BOOTSTRAP_SERVERS,
  GROUP_NAME,
  MESSAGE_TIMEOUT,
  SOURCE_NAME,
  STATE_COLLECTIONS,
  STATE_DEFS,
  createMessageStream,
  generateTopicName,
  liveSuite,
  mockConfig,
  nonce,
  waitForEvent,
  waitForMessages,
  waitForObservation,
};
