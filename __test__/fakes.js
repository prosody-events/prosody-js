/**
 * Fake native scan cursors for the unit tests that drive the real state
 * classes without Kafka or Cassandra.
 */

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

// These handles are built directly over stub natives, so they need an item
// codec the way Context.state() supplies one. The stubs already speak decoded
// values, so the codec passes them through.
const RAW_ITEMS = { decode: (item) => item };

// A finite cursor that yields `items` then null (exhausted), closing on
// exhaustion.
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

module.exports = {
  RAW_ITEMS,
  makeFiniteCursor,
  makeGatedCursor,
};
