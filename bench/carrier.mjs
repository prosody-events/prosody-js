/**
 * Measures what it costs to carry OpenTelemetry context across the boundary.
 *
 * Thirty-nine operations take a carrier — every keyed-state read, write,
 * commit, rollback, and scan pull, and every timer call — and the handler hands
 * one out per message and per timer fire. None of that is work the operation
 * asked for; it is paid before anything happens.
 *
 * Three shapes are compared. The object today's code passes, which napi
 * converts to a `HashMap<String, String>`. A fixed struct naming the three
 * headers prosody's composite propagator actually emits (baggage, traceparent,
 * tracestate). And a bare `traceparent`, which is the floor but drops baggage
 * and tracestate, so it is a bound rather than a proposal.
 *
 *   node --expose-gc carrier.mjs
 */

import { barplot, bench, do_not_optimize, run, summary } from "mitata";
import { createRequire } from "node:module";

const native = createRequire(import.meta.url)("./index.js");

/** A real W3C traceparent: version, 32-hex trace id, 16-hex span id, flags. */
const TRACEPARENT =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/** Rust allocations charged to one call of `op`, averaged. */
function allocations(op) {
  for (let i = 0; i < 1000; i += 1) op(); // settle any one-time growth
  native.allocReset();
  const runs = 10_000;
  for (let i = 0; i < runs; i += 1) op();
  return {
    count: native.allocCount() / runs,
    bytes: native.allocBytes() / runs,
  };
}

const INBOUND = [
  ["object → HashMap (ships today)", (t) => native.carrierMap({ traceparent: t })],
  ["object → 3-field struct", (t) => native.carrierStruct({ traceparent: t })],
  ["bare traceparent string", (t) => native.carrierText(t)],
];

const OUTBOUND = [
  ["object (ships today)", () => native.carrierOutMap()],
  ["traceparent string", () => native.carrierOutText()],
];

barplot(() => {
  summary(() => {
    for (const [label, op] of INBOUND) {
      const b = bench(`in · ${label}`, function* () {
        yield { [0]: () => TRACEPARENT, bench: (t) => do_not_optimize(op(t)) };
      });
      if (label.includes("ships today")) b.baseline(true);
    }
  });
});

barplot(() => {
  summary(() => {
    for (const [label, op] of OUTBOUND) {
      const b = bench(`out · ${label}`, function* () {
        yield () => do_not_optimize(op());
      });
      if (label.includes("ships today")) b.baseline(true);
    }
  });
});

await run();

const rows = [
  ...INBOUND.map(([label, op]) => [`in  ${label}`, allocations(() => op(TRACEPARENT))]),
  ...OUTBOUND.map(([label, op]) => [`out ${label}`, allocations(op)]),
];

console.log("\n=== RUST ALLOCATIONS PER CARRIER ===\n");
console.log("  direction and shape                   allocs     bytes");
for (const [label, a] of rows) {
  console.log(
    `  ${label.padEnd(36)}${a.count.toFixed(2).padStart(6)}   ${a.bytes.toFixed(0).padStart(7)}`,
  );
}
console.log(
  "\n  A HashMap allocates a Rust String for every key. Named struct fields\n" +
    "  do not, which is where the allocation difference comes from.\n",
);
