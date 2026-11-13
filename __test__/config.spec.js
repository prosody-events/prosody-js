const { ConsumerState, ProsodyClient } = require("../index.js");
const { mockConfig } = require("./support");

// Infra-free client option tests use mock mode and need no external services.
describe("configuration validation", () => {
  it("accepts valid messageSpans and timerSpans values", async () => {
    const configured = await ProsodyClient.create(
      mockConfig({ messageSpans: "child", timerSpans: "follows_from" }),
    );
    await configured.shutdown();
  });

  it.each(["messageSpans", "timerSpans"])(
    "rejects an invalid %s and names it in the error",
    async (option) => {
      await expect(
        ProsodyClient.create(mockConfig({ [option]: "invalid" })),
      ).rejects.toThrow(`${option}: `);
    },
  );

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
    "fetchWaitMs",
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
  const SIZE_OPTIONS = ["fetchMaxBytes", "partitionPrefetch"];
  const cases = (options, values) =>
    options.flatMap((option) => values.map((value) => [option, value]));

  it.each(cases(COUNT_OPTIONS, [-1, 1.5, NaN, Infinity, 2 ** 64]))(
    "rejects %s = %p at conversion",
    async (option, value) => {
      await expect(
        ProsodyClient.create(mockConfig({ [option]: value })),
      ).rejects.toThrow(`${option}: must be a whole number`);
    },
  );

  it.each(cases(DURATION_OPTIONS, [-1, NaN, Infinity]))(
    "rejects %s = %p at conversion",
    async (option, value) => {
      await expect(
        ProsodyClient.create(mockConfig({ [option]: value })),
      ).rejects.toThrow(`${option}: `);
    },
  );

  it.each(cases(SIZE_OPTIONS, ["-1 MiB", "nonsense"]))(
    "rejects %s = %p at conversion",
    async (option, value) => {
      await expect(
        ProsodyClient.create(mockConfig({ [option]: value })),
      ).rejects.toThrow(`${option}: `);
    },
  );

  it("rejects a probe port above the port range", async () => {
    await expect(
      ProsodyClient.create(mockConfig({ probePort: 70000 })),
    ).rejects.toThrow("probePort: must be a whole number");
  });

  // Prosody checks the range of these consumer options when the consumer
  // starts. So subscribe accepts the first value and reports the second, which
  // proves that the option reaches Prosody.
  it.each([
    ["statisticsIntervalMs", 60000, 0, /statistics_interval/],
    ["partitionPrefetch", "1 MiB", "1 TiB", /partition_prefetch/],
    ["fetchMaxBytes", "16 MiB", "1 TiB", /fetch_max_bytes/],
    ["fetchWaitMs", 100, 0, /fetch_wait/],
  ])("passes %s to Prosody", async (option, accepted, rejected, error) => {
    const subscribe = async (value) => {
      const configured = await ProsodyClient.create(
        mockConfig({ [option]: value }),
      );
      try {
        await configured.subscribe({
          onMessage: () => null,
          onExcise: () => null,
          onTimer: () => {},
        });
      } finally {
        await configured.shutdown();
      }
    };
    await expect(subscribe(accepted)).resolves.toBeUndefined();
    await expect(subscribe(rejected)).rejects.toThrow(error);
  });

  // An await using block shuts the client down when it ends. A later
  // shutdown awaits the same operation.
  it("shuts down when an await using block ends", async () => {
    let escaped;
    {
      await using client = await ProsodyClient.create(mockConfig({}));
      escaped = client;
      await expect(client.consumerState()).resolves.toBe(
        ConsumerState.Configured,
      );
    }
    await expect(escaped.consumerState()).resolves.toBe(ConsumerState.Shutdown);
    await expect(escaped.shutdown()).resolves.toBeUndefined();
  });

  it("accepts a maxUncommitted above the 16-bit range", async () => {
    const configured = await ProsodyClient.create(
      mockConfig({ maxUncommitted: 100000 }),
    );
    await configured.shutdown();
  });
});
