const { ProsodyClient } = require("../index.js");
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

  it("accepts a maxUncommitted above the 16-bit range", async () => {
    const configured = await ProsodyClient.create(
      makeConfig({ maxUncommitted: 100000 }),
    );
    await configured.shutdown();
  });
});
