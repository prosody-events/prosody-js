const {
  MESSAGE_TIMEOUT,
  liveSuite,
  nonce,
  waitForObservation,
} = require("./support");

describe("producer", () => {
  const env = liveSuite();

  // idempotenceCacheSize sizes the producer cache of sent event IDs. A cache
  // of one entry forgets "a" after the send of "b", so the producer sends the
  // repeat of "a". The consumer drops that duplicate, but it still takes an
  // offset between "b" and "c". A large cache skips the repeat.
  it.each([
    [1, 2n],
    [8192, 1n],
  ])(
    "idempotenceCacheSize %p sizes the producer cache",
    async (idempotenceCacheSize, gap) => {
      env.client = await env.makeClient({ idempotenceCacheSize });
      const key = nonce();
      const offsets = new Map();
      await env.client.subscribe({
        onMessage: (_, message) => {
          offsets.set(message.payload.id, message.offset);
          env.messageStream.push(message.payload.id);
        },
      });

      for (const id of ["a", "b", "a", "c"]) {
        await env.client.send(env.topic, key, { id: `${key}-${id}` });
      }
      await waitForObservation(
        env.messageStream,
        (id) => id === `${key}-c`,
        MESSAGE_TIMEOUT,
      );

      expect(offsets.get(`${key}-c`) - offsets.get(`${key}-b`)).toBe(gap);
    },
  );
});
