/**
 * Payload fixtures for the codec benchmark: a shape × size matrix.
 *
 * Both axes matter, and for different reasons.
 *
 * *Size* is the obvious one — Kafka payloads run from a few hundred bytes to
 * the ~1 MiB default cap, and the two candidate paths scale differently across
 * that range.
 *
 * *Shape* is the axis a size-only sweep would hide. The Value path pays one
 * N-API call per JSON node, so its cost tracks **node count**. The binary path
 * pays a full `JSON.parse` in V8, so its cost tracks **byte count**. A payload
 * that is large but node-poor (one big string) and one that is small but
 * node-rich (many tiny keys) therefore sit at opposite ends of the trade. Each
 * shape below is generated at every size so the two axes can be read apart.
 */

/** Deterministic PRNG (mulberry32) — keeps every run comparing identical bytes. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function word(next, length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(next() * alphabet.length)];
  return out;
}

/**
 * Shapes, each driven by one integer `scale` that grows the payload. The
 * envelope keys `id` and `type` are always present: the binary path's metadata
 * extractor reads them, so a fixture without them would benchmark a decode that
 * cannot happen in production.
 */
const SHAPES = {
  /** Flat object, many small keys. Maximum node count per byte. */
  many_keys: {
    blurb: "flat object, many small keys — node-dense",
    min: 1,
    build(scale, seed) {
      const next = rng(seed);
      const out = { id: `evt-${seed}`, type: "bench.many_keys" };
      for (let i = 0; i < scale; i += 1) {
        out[`field_${i}`] = i % 3 === 0 ? Math.floor(next() * 100000) : word(next, 12);
      }
      return out;
    },
  },

  /** Fixed-depth tree, widening. Node-dense plus pointer chasing on both sides. */
  nested: {
    blurb: "depth-4 tree, widening — node-dense, deep",
    min: 1,
    build(scale, seed) {
      const next = rng(seed);
      const breadth = Math.max(1, scale);
      function build(level) {
        if (level === 0) return { leaf: word(next, 8), n: Math.floor(next() * 1000) };
        const node = {};
        for (let i = 0; i < breadth; i += 1) node[`child_${i}`] = build(level - 1);
        return node;
      }
      return { id: `evt-${seed}`, type: "bench.nested", body: build(3) };
    },
  },

  /** A few large string values. Byte-heavy, node-poor — the Value path's best case. */
  big_strings: {
    blurb: "four large string values — byte-heavy, node-poor",
    min: 1,
    build(scale, seed) {
      const next = rng(seed);
      const out = { id: `evt-${seed}`, type: "bench.big_strings" };
      for (let i = 0; i < 4; i += 1) out[`blob_${i}`] = word(next, scale);
      return out;
    },
  },

  /** Flat numeric array. Node-dense, but with no key strings at all. */
  num_array: {
    blurb: "flat numeric array — node-dense, no keys",
    min: 1,
    build(scale, seed) {
      const next = rng(seed);
      const values = new Array(scale);
      for (let i = 0; i < scale; i += 1) values[i] = Math.floor(next() * 1000000);
      return { id: `evt-${seed}`, type: "bench.num_array", values };
    },
  },

  /** A plausible domain event, scaled by line-item count. Closest to real traffic. */
  realistic: {
    blurb: "order event, scaled by line items — mixed",
    min: 1,
    build(scale, seed) {
      const next = rng(seed);
      const items = [];
      for (let i = 0; i < scale; i += 1) {
        items.push({
          sku: word(next, 10).toUpperCase(),
          quantity: Math.floor(next() * 5) + 1,
          unitPrice: Math.round(next() * 20000) / 100,
          discount: next() > 0.7 ? Math.round(next() * 1000) / 100 : null,
        });
      }
      return {
        id: `evt-${seed}`,
        type: "orders.updated",
        occurredAt: "2026-07-27T14:03:21.884Z",
        version: 3,
        actor: { kind: "user", id: word(next, 16), tenant: word(next, 8) },
        order: {
          orderId: word(next, 20),
          status: "PENDING_FULFILMENT",
          currency: "USD",
          total: Math.round(next() * 100000) / 100,
          items,
          shipping: {
            method: "ground",
            address: {
              line1: `${Math.floor(next() * 9999)} ${word(next, 9)} st`,
              city: word(next, 10),
              region: "CO",
              postalCode: "80202",
              country: "US",
            },
          },
        },
        metadata: { source: "checkout-web", correlationId: word(next, 24), retries: 0 },
      };
    },
  },
};

/** Byte sizes swept per shape, spanning small events to the Kafka default cap. */
export const SIZES = [
  { label: "256B", bytes: 256 },
  { label: "1KiB", bytes: 1024 },
  { label: "8KiB", bytes: 8 * 1024 },
  { label: "64KiB", bytes: 64 * 1024 },
  { label: "512KiB", bytes: 512 * 1024 },
];

/** Counts JSON nodes — the quantity the Value path's napi walk scales with. */
function countNodes(value) {
  if (Array.isArray(value)) return 1 + value.reduce((sum, item) => sum + countNodes(item), 0);
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce((sum, item) => sum + countNodes(item), 1);
  }
  return 1;
}

/**
 * Finds the smallest `scale` whose encoding reaches `targetBytes`.
 *
 * Exponential probe then binary search. Shapes grow in discrete jumps (one more
 * key, one more tree level of width), so an exact hit is not always available;
 * the closest scale on either side of the target wins. A shape whose minimum
 * encoding already exceeds the target is skipped by the caller.
 */
function fitToBytes(shape, targetBytes, seed) {
  const encodedLength = (scale) => Buffer.byteLength(JSON.stringify(shape.build(scale, seed)), "utf8");

  if (encodedLength(shape.min) > targetBytes * 1.35) return null;

  let hi = shape.min;
  while (encodedLength(hi) < targetBytes && hi < 4_000_000) hi *= 2;

  let lo = Math.max(shape.min, Math.floor(hi / 2));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (encodedLength(mid) < targetBytes) lo = mid + 1;
    else hi = mid;
  }

  const under = Math.max(shape.min, lo - 1);
  return Math.abs(encodedLength(under) - targetBytes) < Math.abs(encodedLength(lo) - targetBytes)
    ? under
    : lo;
}

function buildMatrix() {
  const fixtures = [];
  let seed = 1;

  for (const [name, shape] of Object.entries(SHAPES)) {
    for (const size of SIZES) {
      seed += 1;
      const scale = fitToBytes(shape, size.bytes, seed);
      if (scale === null) continue; // shape's floor overshoots this size

      const value = shape.build(scale, seed);
      const json = JSON.stringify(value);
      fixtures.push({
        shape: name,
        blurb: shape.blurb,
        size: size.label,
        targetBytes: size.bytes,
        scale,
        value,
        json,
        wire: Buffer.from(json, "utf8"),
        bytes: Buffer.byteLength(json, "utf8"),
        nodes: countNodes(value),
      });
    }
  }

  return fixtures;
}

export const FIXTURES = buildMatrix();
export const SHAPE_NAMES = Object.keys(SHAPES);
