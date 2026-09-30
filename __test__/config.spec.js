const { ConsumerState, ProsodyClient } = require("../index.js");
const { BOOTSTRAP_SERVERS, GROUP_NAME, SOURCE_NAME } = require("./support");

// Infra-free client option tests use mock mode and need no external services.
describe("configuration validation", () => {
  const makeConfig = (overrides) => ({
    bootstrapServers: BOOTSTRAP_SERVERS,
    groupId: GROUP_NAME,
    sourceSystem: SOURCE_NAME,
    subscribedTopics: "test-topic",
    mock: true,
    probePort: null,
    ...overrides,
  });

  it("accepts valid messageSpans and timerSpans values", async () => {
    const configured = await ProsodyClient.create(
      makeConfig({ messageSpans: "child", timerSpans: "follows_from" }),
    );
    await configured.shutdown();
  });

  it("rejects invalid messageSpans with field name in error", async () => {
    await expect(
      ProsodyClient.create(makeConfig({ messageSpans: "invalid" })),
    ).rejects.toThrow(/message_spans/);
  });

  it("rejects invalid timerSpans with field name in error", async () => {
    await expect(
      ProsodyClient.create(makeConfig({ timerSpans: "invalid" })),
    ).rejects.toThrow(/timer_spans/);
  });

  // A number option converts to its Prosody type without loss, or the create
  // call names the option and fails. A negative, fractional, or non-finite
  // count must never wrap or truncate to a different valid count.
  const COUNT_OPTIONS = [
    "idempotenceCacheSize",
    "loaderCacheSize",
    "loaderDiscardThreshold",
    "maxConcurrency",
    "maxRetries",
    "maxUncommitted",
    "monopolizationCacheSize",
    "peerCacheCapacity",
    "probePort",
    "schedulerCacheSize",
    "deferStoreCacheSize",
  ];
  const DURATION_OPTIONS = [
    "cassandraRetentionSeconds",
    "commitIntervalMs",
    "deferBaseMs",
    "deferFailureWindowMs",
    "deferMaxDelayMs",
    "idempotenceTtlSeconds",
    "loaderSeekTimeoutMs",
    "maxRetryDelayMs",
    "monopolizationWindowMs",
    "peerRegistrationTtlSeconds",
    "pollIntervalMs",
    "retryBaseMs",
    "schedulerMaxWaitMs",
    "sendTimeoutMs",
    "shutdownTimeoutMs",
    "slabSizeMs",
    "stallThresholdMs",
    "statisticsIntervalMs",
    "timeoutMs",
  ];
  const cases = (options, values) =>
    options.flatMap((option) => values.map((value) => [option, value]));

  it.each(cases(COUNT_OPTIONS, [-1, 1.5, NaN, Infinity, 2 ** 64]))(
    "rejects %s = %p at conversion",
    async (option, value) => {
      await expect(
        ProsodyClient.create(makeConfig({ [option]: value })),
      ).rejects.toThrow(`${option}: must be a non-negative whole number`);
    },
  );

  it.each(cases(DURATION_OPTIONS, [-1, NaN, Infinity]))(
    "rejects %s = %p at conversion",
    async (option, value) => {
      await expect(
        ProsodyClient.create(makeConfig({ [option]: value })),
      ).rejects.toThrow(`${option}: `);
    },
  );

  it("rejects a probe port above the port range", async () => {
    await expect(
      ProsodyClient.create(makeConfig({ probePort: 70000 })),
    ).rejects.toThrow("probePort: must be a non-negative whole number");
  });

  // Prosody accepts a statistics interval from 1 ms to 24 hours. It checks
  // the consumer options when the consumer starts, so subscribe reports a
  // zero interval.
  it.each([
    [60000, "resolves"],
    [0, "rejects"],
  ])("passes statisticsIntervalMs %p to Prosody", async (value, outcome) => {
    const configured = await ProsodyClient.create(
      makeConfig({ statisticsIntervalMs: value }),
    );
    try {
      const subscribed = configured.subscribe({
        onMessage: () => null,
        onExcise: () => null,
        onTimer: () => {},
      });
      if (outcome === "resolves") {
        await expect(subscribed).resolves.toBeUndefined();
      } else {
        await expect(subscribed).rejects.toThrow(/statistics_interval/);
      }
    } finally {
      await configured.shutdown();
    }
  });

  // An await using block shuts the client down when it ends. A later
  // shutdown awaits the same operation.
  it("shuts down when an await using block ends", async () => {
    let escaped;
    {
      await using client = await ProsodyClient.create(makeConfig({}));
      escaped = client;
      await expect(client.consumerState()).resolves.toBe(
        ConsumerState.Configured,
      );
    }
    await expect(escaped.consumerState()).resolves.toBe(ConsumerState.Shutdown);
    await expect(escaped.shutdown()).resolves.toBeUndefined();
  });

  // null means no send timeout. The Rust tests check that it reaches the
  // producer configuration as no timeout.
  it("accepts a null sendTimeoutMs", async () => {
    const configured = await ProsodyClient.create(
      makeConfig({ sendTimeoutMs: null }),
    );
    await configured.shutdown();
  });

  it("accepts a maxUncommitted above the 16-bit range", async () => {
    const configured = await ProsodyClient.create(
      makeConfig({ maxUncommitted: 100000 }),
    );
    await configured.shutdown();
  });
});
