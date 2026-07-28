/**
 * Codec-boundary benchmark: does handing raw bytes to `JSON.parse` beat walking
 * a `serde_json::Value` across napi?
 *
 * The timed unit is the whole per-message job — Kafka wire bytes in, usable
 * JavaScript value out. Timing either half alone would flatter whichever
 * candidate pushes work into the other half, which is the trap this comparison
 * exists to avoid.
 *
 * Three mitata features carry the measurement's credibility, each guarding a
 * specific way a JavaScript microbenchmark lies:
 *
 * - **Computed parameters** (`yield { [0]() {...}, bench(w) {...} }`) stop the
 *   JIT from hoisting a loop-invariant call out of the measurement loop. The
 *   payload is a constant, so the naive `yield () => op(wire)` form invites
 *   exactly that.
 * - **`do_not_optimize`** forces an observable side effect, so a result nobody
 *   reads cannot be eliminated as dead code.
 * - **`.gc('inner')`** collects before each batch. Both candidates allocate
 *   heavily, and without this a collection landing inside one candidate's
 *   window would be charged to that candidate.
 *
 * Usage:
 *   node --expose-gc run.mjs               full sweep
 *   node --expose-gc run.mjs --full        per-benchmark histograms and boxplots
 *   node --expose-gc run.mjs --shape=nested
 *   sudo node --expose-gc run.mjs          adds hardware counters (IPC, cycles)
 */

import assert from "node:assert";
import { createRequire } from "node:module";
import { bench, boxplot, do_not_optimize, group, run, summary } from "mitata";

import { FIXTURES, SHAPE_NAMES, SIZES } from "./fixtures.mjs";

const native = createRequire(import.meta.url)("./index.js");

const argv = process.argv.slice(2);
const flag = (name) => argv.some((a) => a === `--${name}`);
const option = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const FULL = flag("full");
const shapeFilter = option("shape");
const sizeFilter = option("size");

const selected = FIXTURES.filter(
  (f) => (!shapeFilter || f.shape === shapeFilter) && (!sizeFilter || f.size === sizeFilter),
);

if (selected.length === 0) {
  console.error(`no fixtures matched --shape=${shapeFilter ?? "*"} --size=${sizeFilter ?? "*"}`);
  console.error(`shapes: ${SHAPE_NAMES.join(", ")}\nsizes:  ${SIZES.map((s) => s.label).join(", ")}`);
  process.exit(1);
}

const byKey = new Map(selected.map((f) => [`${f.shape}/${f.size}`, f]));
const shapes = SHAPE_NAMES.filter((s) => selected.some((f) => f.shape === s));
const sizesFor = (shape) => selected.filter((f) => f.shape === shape).map((f) => f.size);

/**
 * The candidates. Each `op` goes from wire bytes to the value a handler would
 * actually be handed, so all of them are charged for the full journey.
 *
 * `equivalent: false` marks the lazy-getter ceiling, which deliberately skips
 * body parsing and so cannot be checked for output equality.
 */
const INBOUND = [
  {
    key: "value+clone",
    label: "Value→napi (ships today)",
    baseline: true,
    equivalent: true,
    op: (wire) => native.inboundValueClone(wire),
  },
  {
    key: "value",
    label: "Value→napi (clone removed)",
    equivalent: true,
    op: (wire) => native.inboundValueNoclone(wire),
  },
  {
    key: "buffer+parse",
    label: "bytes→Buffer→JSON.parse",
    equivalent: true,
    op: (wire) => JSON.parse(native.inboundBinaryBuffer(wire).toString("utf8")),
  },
  {
    key: "string+parse",
    label: "bytes→string→JSON.parse",
    equivalent: true,
    op: (wire) => JSON.parse(native.inboundBinaryString(wire)),
  },
  {
    key: "meta-only",
    label: "bytes, body never parsed",
    equivalent: false,
    op: (wire) => native.inboundBinaryMeta(wire),
  },
];

const OUTBOUND = [
  {
    key: "value-out",
    label: "JS obj→napi→Value→encode (ships today)",
    baseline: true,
    op: (value) => native.outboundValue(value),
  },
  {
    key: "stringify-out",
    label: "JSON.stringify→bytes",
    op: (value) => native.outboundBinary(Buffer.from(JSON.stringify(value), "utf8")),
  },
];

/**
 * Proves every byte-producing candidate really reconstructs the original value.
 * Without this the sweep could be timing a path that quietly does less work and
 * reporting it as a win.
 */
function verifyEquivalence() {
  for (const fixture of selected) {
    const expected = JSON.parse(fixture.json);
    for (const path of INBOUND) {
      if (!path.equivalent) continue;
      assert.deepStrictEqual(
        path.op(fixture.wire),
        expected,
        `${path.key} disagreed with JSON.parse on ${fixture.shape}/${fixture.size}`,
      );
    }
    assert.strictEqual(
      native.outboundValue(fixture.value),
      Buffer.byteLength(fixture.json, "utf8"),
      `outbound encode length mismatch on ${fixture.shape}/${fixture.size}`,
    );
  }
}

/** Confirms the allocation counter moves, so that a zero reading is a fact. */
function verifyAllocCounter() {
  native.allocReset();
  native.inboundValueClone(selected[0].wire);
  assert.ok(native.allocCount() > 0, "allocation counter never moved — counters are not wired up");
}

/**
 * Definition-order record of what each mitata trial measures. One trial per
 * (shape, path); the size axis lives inside the trial as mitata args, so each
 * run carries its own `args.size` and no positional guessing is needed there.
 */
const REGISTRY = [];

function defineBenchmarks() {
  const scope = FULL ? (fn) => boxplot(fn) : (fn) => fn();

  for (const shape of shapes) {
    const sizes = sizesFor(shape);

    group(`IN · ${shape}`, () => {
      scope(() => {
        summary(() => {
          for (const path of INBOUND) {
            REGISTRY.push({ kind: "in", shape, path });

            const b = bench(`${path.label} · $size`, function* (state) {
              const fixture = byKey.get(`${shape}/${state.get("size")}`);
              const wire = fixture.wire;

              // Computed parameter: recomputed outside the timed region, which
              // is what denies the JIT its loop-invariant hoist.
              yield {
                [0]() {
                  return wire;
                },
                bench(w) {
                  return do_not_optimize(path.op(w));
                },
              };
            })
              .args("size", sizes)
              .gc("inner");

            if (path.baseline) b.baseline(true);
            if (!FULL) b.compact();
          }
        });
      });
    });
  }

  for (const shape of shapes) {
    const sizes = sizesFor(shape);

    group(`OUT · ${shape}`, () => {
      summary(() => {
        for (const path of OUTBOUND) {
          REGISTRY.push({ kind: "out", shape, path });

          const b = bench(`${path.label} · $size`, function* (state) {
            const fixture = byKey.get(`${shape}/${state.get("size")}`);
            const value = fixture.value;

            yield {
              [0]() {
                return value;
              },
              bench(v) {
                return do_not_optimize(path.op(v));
              },
            };
          })
            .args("size", sizes)
            .gc("inner");

          if (path.baseline) b.baseline(true);
          if (!FULL) b.compact();
        }
      });
    });
  }
}

/**
 * Joins mitata trials to their fixtures, keyed `kind/shape/size/pathKey`.
 *
 * Trials pair to the registry by definition order and each pairing is asserted
 * against the trial's alias, so a broken ordering assumption fails loudly
 * instead of producing a plausible-looking table. Within a trial the size comes
 * from `run.args`, not from position.
 */
function zipResults(benchmarks, ctx) {
  assert.strictEqual(
    benchmarks.length,
    REGISTRY.length,
    `expected ${REGISTRY.length} trials, mitata returned ${benchmarks.length}`,
  );

  const results = new Map();
  const eliminated = [];
  const disturbed = [];

  benchmarks.forEach((trial, index) => {
    const entry = REGISTRY[index];
    assert.strictEqual(
      trial.alias,
      `${entry.path.label} · $size`,
      `trial ${index} is "${trial.alias}" but the registry expected "${entry.path.label}" — ordering assumption broken`,
    );

    for (const r of trial.runs) {
      if (!r.stats) continue;
      const size = r.args?.size;
      assert.ok(size, `trial "${trial.alias}" produced a run with no size arg`);

      // Ratios are taken from p50, not avg. A 24-cell sweep will occasionally
      // catch a batch disturbed by something outside the process, and a single
      // pathological batch moves avg enough to invert a cell's verdict — one
      // did exactly that here, reporting a 1.4x win as a 10x loss. The median
      // shrugs it off, and `disturbed` below reports any cell where the two
      // disagree badly rather than quietly smoothing it away.
      results.set(`${entry.kind}/${entry.shape}/${size}/${entry.path.key}`, {
        ns: r.stats.p50,
        avg: r.stats.avg,
        heap: r.stats.heap?.avg ?? null,
      });

      if (r.stats.avg > 1.5 * r.stats.p50) {
        disturbed.push(
          `${entry.shape}/${size}/${entry.path.key} (avg ${(r.stats.avg / 1000).toFixed(1)}µs vs p50 ${(r.stats.p50 / 1000).toFixed(1)}µs)`,
        );
      }

      // mitata's own dead-code test, applied to our results rather than only to
      // its printed output: a run indistinguishable from an empty function was
      // optimized away and is not measuring what it claims. The noop baseline
      // has to match the gc mode, since every bench here runs `.gc('inner')`.
      const noop =
        r.stats.kind === "iter" ? ctx.noop.iter : (ctx.noop.fn_gc ?? ctx.noop.fn);
      if (noop && r.stats.avg < 1.42 * noop.avg) {
        eliminated.push(`${entry.shape}/${size}/${entry.path.key}`);
      }
    }
  });

  return { results, eliminated, disturbed };
}

function pad(text, width, right = false) {
  const s = String(text);
  return right ? s.padStart(width) : s.padEnd(width);
}

const micros = (ns) => (ns >= 1000 ? (ns / 1000).toFixed(1) : (ns / 1000).toFixed(2));

/**
 * Reduces the raw trials to the question that motivated the sweep: at each
 * shape and size, is the byte path faster than what ships, and by how much.
 */
function reportInbound(results) {
  process.stdout.write("\n\n=== INBOUND — wire bytes to usable JS value, vs. what ships today ===\n");
  process.stdout.write("  >1.00x means the byte path WINS.   <1.00x means it LOSES.  (median of samples)\n\n");
  process.stdout.write(
    `  ${pad("shape", 13)}${pad("size", 8)}${pad("bytes", 10, true)}${pad("nodes", 9, true)}` +
      `${pad("B/node", 8, true)}${pad("today µs", 11, true)}${pad("-clone", 9, true)}` +
      `${pad("buffer", 9, true)}${pad("string", 9, true)}${pad("lazy", 9, true)}\n`,
  );

  let lastShape = null;
  for (const fixture of selected) {
    const at = (key) => results.get(`in/${fixture.shape}/${fixture.size}/${key}`)?.ns;
    const base = at("value+clone");
    if (!base) continue;

    if (lastShape && lastShape !== fixture.shape) process.stdout.write("\n");
    lastShape = fixture.shape;

    const ratio = (key) => (at(key) ? `${(base / at(key)).toFixed(2)}x` : "—");

    process.stdout.write(
      `  ${pad(fixture.shape, 13)}${pad(fixture.size, 8)}` +
        `${pad(fixture.bytes.toLocaleString(), 10, true)}${pad(fixture.nodes.toLocaleString(), 9, true)}` +
        `${pad((fixture.bytes / fixture.nodes).toFixed(0), 8, true)}` +
        `${pad(micros(base), 11, true)}` +
        `${pad(ratio("value"), 9, true)}${pad(ratio("buffer+parse"), 9, true)}` +
        `${pad(ratio("string+parse"), 9, true)}${pad(ratio("meta-only"), 9, true)}\n`,
    );
  }
}

/** Outbound is the mirror image: does `JSON.stringify` beat the napi walk? */
function reportOutbound(results) {
  process.stdout.write("\n\n=== OUTBOUND — JS value to wire bytes ===\n\n");
  process.stdout.write(
    `  ${pad("shape", 13)}${pad("size", 8)}${pad("today µs", 11, true)}` +
      `${pad("stringify µs", 14, true)}${pad("speedup", 10, true)}\n`,
  );

  let lastShape = null;
  for (const fixture of selected) {
    const base = results.get(`out/${fixture.shape}/${fixture.size}/value-out`)?.ns;
    const proposed = results.get(`out/${fixture.shape}/${fixture.size}/stringify-out`)?.ns;
    if (!base || !proposed) continue;

    if (lastShape && lastShape !== fixture.shape) process.stdout.write("\n");
    lastShape = fixture.shape;

    process.stdout.write(
      `  ${pad(fixture.shape, 13)}${pad(fixture.size, 8)}${pad(micros(base), 11, true)}` +
        `${pad(micros(proposed), 14, true)}${pad(`${(base / proposed).toFixed(2)}x`, 10, true)}\n`,
    );
  }
}

/**
 * Allocation cost per message on **both** sides of the boundary — the axis that
 * prompted the question.
 *
 * The Rust columns come from a counting allocator wrapped around mimalloc,
 * measured outside mitata because counting is not timing. The V8 columns are
 * mitata's own per-iteration heap estimate. Both are needed: the byte path does
 * not remove object materialization, it relocates it from the Rust heap to
 * V8's, and a Rust-only counter would score that relocation as a pure win.
 */
function reportAllocations(results) {
  process.stdout.write("\n\n=== ALLOCATION PER MESSAGE — both sides of the boundary ===\n\n");
  process.stdout.write(
    `  ${pad("", 21)}${pad("── ships today ──", 34, true)}${pad("── bytes→JSON.parse ──", 36, true)}\n`,
  );
  process.stdout.write(
    `  ${pad("shape", 13)}${pad("size", 8)}${pad("rust #", 10, true)}${pad("rust KiB", 11, true)}` +
      `${pad("v8 KiB", 11, true)}${pad("rust #", 12, true)}${pad("rust KiB", 11, true)}` +
      `${pad("v8 KiB", 11, true)}\n`,
  );

  const measure = (op, wire, iterations) => {
    for (let i = 0; i < 200; i += 1) do_not_optimize(op(wire)); // settle reusable buffers
    native.allocReset();
    for (let i = 0; i < iterations; i += 1) do_not_optimize(op(wire));
    return { count: native.allocCount() / iterations, bytes: native.allocBytes() / iterations };
  };

  const kib = (bytes) => (bytes === null ? "—" : (bytes / 1024).toFixed(1));

  let lastShape = null;
  for (const fixture of selected) {
    const iterations = fixture.bytes > 100_000 ? 300 : 3_000;
    const current = measure(INBOUND[0].op, fixture.wire, iterations);
    const proposed = measure(INBOUND[2].op, fixture.wire, iterations);
    const heapOf = (key) => results.get(`in/${fixture.shape}/${fixture.size}/${key}`)?.heap ?? null;

    if (lastShape && lastShape !== fixture.shape) process.stdout.write("\n");
    lastShape = fixture.shape;

    process.stdout.write(
      `  ${pad(fixture.shape, 13)}${pad(fixture.size, 8)}` +
        `${pad(current.count.toFixed(0), 10, true)}${pad(kib(current.bytes), 11, true)}` +
        `${pad(kib(heapOf("value+clone")), 11, true)}` +
        `${pad(proposed.count.toFixed(0), 12, true)}${pad(kib(proposed.bytes), 11, true)}` +
        `${pad(kib(heapOf("buffer+parse")), 11, true)}\n`,
    );
  }
}

async function main() {
  process.stdout.write(
    `node ${process.version} · ${process.arch} · ` +
      `gc ${globalThis.gc ? "exposed" : "NOT exposed — rerun with --expose-gc"}\n`,
  );
  process.stdout.write(
    `${selected.length} fixtures · ${INBOUND.length} inbound paths · ${OUTBOUND.length} outbound paths\n`,
  );

  verifyEquivalence();
  verifyAllocCounter();
  process.stdout.write("equivalence: every byte-producing path reconstructs the original value ✓\n\n");

  defineBenchmarks();
  const { benchmarks, context } = await run({ throw: true });

  const { results, eliminated, disturbed } = zipResults(benchmarks, context);

  reportInbound(results);
  reportOutbound(results);
  reportAllocations(results);

  if (disturbed.length > 0) {
    process.stdout.write(
      `\n\nNOTE — ${disturbed.length} cell(s) had a mean well above their median, meaning at least\n` +
        "one batch was disturbed. The tables above use the median and are unaffected,\n" +
        `but treat these cells as lower-confidence:\n  ${disturbed.join("\n  ")}\n`,
    );
  }

  if (eliminated.length > 0) {
    process.stdout.write(
      `\n\nWARNING — mitata flagged possible dead-code elimination in: ${eliminated.join(", ")}\n` +
        "Those rows do not measure what they claim. Fix the barrier before trusting them.\n",
    );
  }
}

await main();
