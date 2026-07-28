# Codec-boundary benchmark

Answers one question: **should `prosody-js` hand JavaScript raw bytes to
`JSON.parse` instead of walking a `serde_json::Value` across napi?**

`prosody-cs` already does the byte thing (`JsonBinaryCodec` → `Vec<u8>` →
`System.Text.Json`). `prosody-js` does the tree thing. This measures whether
copying the C# approach would actually be faster, and where it would not.

Nothing here is wired into the published package. It is a standalone addon in
its own workspace, depending on the released `prosody` crate from crates.io, so
no change to the core repo is needed to run it.

## Running

```sh
npm install
npm run build                       # builds the release addon (~1 min cold)
node --expose-gc run.mjs            # full sweep
node --expose-gc run.mjs --full     # per-benchmark histograms and boxplots
node --expose-gc run.mjs --shape=nested --size=8KiB
sudo node --expose-gc run.mjs       # adds hardware counters (IPC, cycles, cache)
```

`--expose-gc` matters. Without it mitata cannot control collection, and both
candidates allocate heavily enough for that to show up as noise.

## What is measured

The timed unit is the **whole per-message job**: Kafka wire bytes in, usable
JavaScript value out. Timing either half alone would flatter whichever candidate
pushes work into the other half, which is exactly the trap this comparison
exists to avoid.

Inbound candidates, all producing the same JavaScript value:

| candidate | what it models |
| --- | --- |
| `Value→napi (ships today)` | `JsonCodec` → `serde_json::Value` → the `payload().clone()` in `message.rs` → napi tree walk |
| `Value→napi (clone removed)` | the same, minus the deep clone — isolates a fix needing no codec change |
| `bytes→Buffer→JSON.parse` | `JsonBinaryCodec` → zero-copy `Buffer` → `JSON.parse` |
| `bytes→string→JSON.parse` | the same, returning a JS string so `JSON.parse` skips `toString` |
| `bytes, body never parsed` | the ceiling for a lazy `payload` getter, when a handler reads only metadata |

The binary candidates pay for the `id`/`type` metadata extraction, which is not
optional: dedup and `allowed_events` filtering need it, and the Value path gets
it free off the already-parsed tree. Omitting it would be measuring a decode
that cannot happen in production.

Outbound mirrors this: `JSON.stringify` in JS versus napi walking a JS object
into a `Value`.

## Why shape and not just size

Both axes are swept, and the shape axis is the one a size-only sweep would hide.

The Value path pays one N-API call per JSON node, so its cost tracks **node
count**. The byte path pays a full `JSON.parse` in V8, so its cost tracks **byte
count**. Fixtures therefore span 6.9 to ~75,000 bytes per node — four orders of
magnitude — because a payload that is large but node-poor (one big string) and
one that is small but node-rich (many tiny keys) sit at opposite ends of that
trade. Sizes run 256 B to 512 KiB, spanning small events to the Kafka default
message cap.

Note the swap does not delete the JSON parse; it moves it from `simd_json` to
V8, and `simd_json` is the faster raw parser. The win, where there is one, comes
from materialization, not parsing — so the shapes where materialization is cheap
are exactly where the swap can lose.

## How the measurement avoids lying

Measurement is [mitata](https://github.com/evanwashere/mitata)'s. Three of its
features do real work here, each guarding a specific failure mode:

- **Computed parameters** — `yield { [0]() {...}, bench(w) {...} }`. The payload
  is loop-invariant, so the naive `yield () => op(wire)` form invites the JIT to
  hoist the entire call out of the measurement loop. Computed parameters are
  mitata's documented defence against that.
- **`do_not_optimize`** — forces an observable side effect so a result nobody
  reads cannot be eliminated as dead code.
- **`.gc('inner')`** — collects before each batch. Both candidates allocate
  heavily; without this a collection landing inside one candidate's window gets
  charged to that candidate.

Three checks run before any timing, so that a broken harness fails loudly rather
than printing a plausible table:

1. **Equivalence** — every byte-producing candidate must `deepStrictEqual` the
   original value. A path that quietly did less work would otherwise score as a
   win.
2. **Allocation counter liveness** — the counter must move, so that a zero
   reading is a fact rather than a broken probe.
3. **Dead-code detection** — mitata's own test (`avg < 1.42 × noop`, against a
   gc-mode-matched noop) is applied to the collected results, not just its
   printed output. Any flagged row is reported as a warning.

Trials are joined back to fixtures by definition order with the trial alias
asserted at every step, so a wrong ordering assumption fails loudly instead of
mislabeling rows.

### Median, not mean

The comparison tables use `p50`. Across a 24-cell sweep some batch will
eventually be disturbed by something outside the process, and one pathological
batch moves the mean enough to invert a cell's verdict — during development one
did exactly that, reporting a measured 1.4x win as a 10x loss. The median
absorbs it.

Smoothing a number is only safe if you also say when you did it, so any cell
whose mean exceeds 1.5× its median is listed as lower-confidence at the end of
the run rather than silently cleaned up.

The median does not catch everything. A disturbance lasting longer than one
trial shifts the mean and the median together, so the cell reads as a clean,
consistent, wrong number — two cells in a 24-cell sweep did exactly that,
scoring 0.17x and 1.02x where an isolated re-run of the same fixture gives 1.47x
and 2.30x. The tell is the tail: both had `p99 ≈ 2.5 × p75` while their
neighbours sat near 1.1×, and both broke monotonicity against their own larger
sizes.

So a surprising cell is re-run alone before it is believed:

```sh
node --expose-gc run.mjs --shape=nested --size=1KiB
```

A genuine shape effect reproduces — `big_strings` loses by the same margin every
time. A disturbance does not.

## Reading the allocation table

Allocation is reported on **both** sides of the boundary, and it has to be.

The Rust columns come from a counting allocator wrapped around mimalloc (the
same allocator the real addon uses). The V8 columns are mitata's per-iteration
heap estimate.

The byte path does not remove object materialization — it **relocates** it from
the Rust heap into V8's. A Rust-only counter would score that relocation as a
pure win, which is why both columns are shown. The Rust drop is real and large;
judge it against what appears on the V8 side, not on its own.

## Caveats

- Apple Silicon results. The `simd_json` / `serde_json` split in `prosody` keys
  off `target_arch = "arm"`, which is false on `aarch64`, so this exercises the
  same `simd_json` backend as production on x86-64 and aarch64 Linux.
- Every candidate copies the wire bytes into a reusable scratch buffer first,
  because both codecs consume their input destructively. That copy is harness
  scaffolding charged identically to every candidate.
- This measures the codec boundary in isolation. It says nothing about what
  fraction of a real handler's time that boundary represents.
