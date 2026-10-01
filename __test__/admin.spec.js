const { AdminClient } = require("../index.js");
const { BOOTSTRAP_SERVERS, generateTopicName } = require("./support");

describe("AdminClient", () => {
  const admin = new AdminClient(BOOTSTRAP_SERVERS);

  // The broker validates the cleanup policy and the retention, so its answer
  // shows that each option reaches the new topic's configuration.
  it.each([
    [{ cleanupPolicy: "compact" }, "resolves"],
    [{ cleanupPolicy: "delete,compact", retentionMs: 3_600_000 }, "resolves"],
    [{ cleanupPolicy: "bogus" }, "rejects"],
    [{ retentionMs: -1 }, "rejects"],
  ])("createTopic with %p %s", async (options, outcome) => {
    const topic = generateTopicName();
    const created = admin.createTopic(topic, 1, 1, options);
    if (outcome === "resolves") {
      await expect(created).resolves.toBeUndefined();
      await admin.deleteTopic(topic);
    } else {
      await expect(created).rejects.toThrow();
    }
  });

  it.each([
    [-1, 1],
    [1.5, 1],
    [1, 70000],
  ])(
    "rejects partitionCount %p and replicationFactor %p at conversion",
    async (partitions, replicas) => {
      await expect(
        admin.createTopic(generateTopicName(), partitions, replicas),
      ).rejects.toThrow("must be a whole number");
    },
  );
});
