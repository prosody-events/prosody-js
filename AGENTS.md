# CLAUDE.md

Development patterns and practices for prosody-js: Node.js bindings for the
Prosody Kafka client library. A NAPI-RS v3 crate (`src/`) wraps the published
`prosody` Rust crate; a hand-written JavaScript layer (`index.js`,
`index.d.ts`) wraps the generated bindings.

## Design Principles

These come before everything else. Every change is judged against them.

**Write code that is simple, clear, well-factored, elegant, easy to
understand, correct, and idiomatic.** A reader should grasp the intent without
effort. If a change makes the code harder to read, the change is wrong, even
if it is faster or shorter. If two designs are correct, pick the one that is
easier to delete.

**Make invalid states unrepresentable in the type system.** When a compiler
or type checker can prove a contract, no test, comment, or convention has to.
In Rust, prefer distinct types for distinct concepts, restricted constructors,
and `enum` sum types over flag fields. In `index.d.ts`, give the public
surface precise types instead of loose ones. If a bug class can be made
uncompilable, do that instead of writing a runtime check.

**Delete more than you add.** Every change should leave the codebase smaller,
simpler, or both. If you must add code, look first for duplication you can
fold, abstractions that no longer pay rent, dead branches, and stale comments.
The end-state diff should net negative whenever the task allows. Line count is
not the only axis: plain duplicated arms often read better than generic
machinery.

**Identify, document, and enforce invariants.** For every load-bearing piece
of state: name the invariant, write it down near the type or function that
owns it, enforce it in the type system if you can, otherwise assert it at the
boundary, and cover it with a test. If you cannot name the invariant, you do
not yet understand the code well enough to change it.

**Leave the codebase better than you found it.** Drive-by simplifications are
encouraged when they are scoped to the area you are already touching. Do not
sprawl — but do not walk past obvious cleanup either.

## Definition of Done

No change is complete until every line below holds. These are acts, not
aspirations — perform each one; do not merely agree with it:

1. `cargo clippy` and `cargo clippy --tests` — zero warnings. `cargo doc` —
   zero warnings. `cargo +nightly fmt` and `npm run format` leave no changes.
2. `npm run typecheck` — zero errors. It checks `index.d.ts`,
   `bindings.d.ts`, the type tests, and the examples together.
3. `npm run build:debug && npm test 2>&1 | tee /tmp/test-output.txt` —
   re-running slow suites is expensive; grep the file, not the pipe.
4. Every new or converted test was proved falsifiable once: inject the
   failure, watch it go red, revert.
5. Every deleted test names its surviving stronger test in the commit message.
6. Everything the change replaces is gone — code, tests, type definitions,
   doc vocabulary (see Redesign hygiene). "The new thing works" is half done.
7. Every claim written this session — doc cross-reference, "covered by" note,
   exemplar path — was verified to resolve, not recalled from memory.
8. The diff is net-negative, or each addition is individually justified.

## Critical Rules

**Error Handling (Rust):**

- Never use `expect`, `unwrap`, `panic`, or `ok()` - forbidden by lints
- Propagate errors with `?` unless explicitly authorized to swallow
- Use `thiserror` for structured errors; box only when Clippy warns

**Memory (Rust):**

- **Never leak memory.** `std::mem::forget`, `Box::leak`, and `ManuallyDrop`
  without an explicit reclamation path are forbidden. If a test must simulate
  "Drop never ran", seed the underlying state directly; forgetting is never
  the shortcut.
- **No unbounded keyed RAM.** Any in-memory structure keyed by message key or
  collection must have a fixed capacity bound. Every in-memory map names its
  removal path; self-draining maps are fine, but the drain is still named.

**Allocation and layout (tiger style — https://tigerstyle.dev/):**

- No hot-path allocation that is not upfront and bounded. A steady-state path
  (per message, per timer fire, per handler call) must not allocate a buffer
  whose size is discovered at runtime and grown as needed.
- Pick the buffer by what is known about the size: compile-time constant →
  stack array; runtime-varying but almost always small → `SmallVec` sized to
  the common case; genuinely unbounded → `Vec::with_capacity` sized once.
- `with_capacity` excuses the sizing, never the allocation. A per-call heap
  allocation on a steady-state path is the defect itself.
- Never add a gratuitous allocation to satisfy the borrow checker. Reach for
  a function item, an index, or a borrow before a scratch `Vec`.
- No amortized resize buffers on the hot path. If a reusable scratch buffer
  is unavoidable, allocate it once at construction with a fixed bound.
- **Lay data out for the access pattern.** A hot path that scans one or two
  fields across many entries must find those fields contiguously. Reach the
  full record only for the entry the scan selects. An array of `Option<Arc<T>>`
  turns a two-word decision into one heap dereference per entry, and thrashes
  the CPU cache. Memory bandwidth is the bottleneck today, so the scan decides
  the layout, not the record. Don't thrash the cache. False sharing counts:
  keep atomics that different threads write off one line.
- Simplicity is not sacrificed for this. When zero-alloc and simple genuinely
  conflict, keep it simple and leave a comment naming the allocation.

**Code Quality:**

- Lint, doc, type, and format gates live in Definition of Done — zero
  warnings tolerated.
- Never suppress warnings with `#[allow(...)]` without permission.
- Never introduce `dyn` without permission — prefer generics and associated
  types. The type-erased surface this binding consumes already lives in the
  published `prosody` crate.

**JSON codec:**

- This binding never defines its own payload codec. Payload encoding and
  decoding belong to the `prosody` crate's codec; the binding passes payload
  bytes through it.
- `serde_json`, `simd_json`, and the `json!` macro are banned in Rust
  production code here for payload handling. Tests may use `serde_json::Value`
  as a concrete payload type.

**Redesign hygiene:**

When a design is replaced, remove _all_ of it in the same change —
half-deleted designs are where bloat and bug re-introduction live:

- Sweep the old design's vocabulary from every doc comment, type definition,
  and example. A stale doc can instruct a reader to re-introduce a fixed bug.
- Code whose only caller is its own test is dead — delete both together.
- Struct fields threaded through configs but only read at construction are
  residue from a superseded design — remove them end-to-end.
- Do not build surface ahead of a caller: delete zero-caller paths, or make
  them owner-confirmed, tested features.

**Debugging Discipline:**

- Never claim "found the issue" without rigorous proof
- Evidence first (logs, tests, reproducible behavior) → hypothesis → test → verify

**Style:**

- Prefer `use` statements over fully qualified prefixes
- Methods without `self` should be functions (except `new` and similar)
- Ask before large structural changes
- Default to `pub(crate)`/`pub(super)` in Rust; make something `pub` only as
  a deliberate API decision.
- Keep trait constraints as local as possible: put a constraint on the
  function that needs it, not the struct.
- When a proposed simplification is examined and rejected, record the ruling
  in one sentence at the site so the next pass does not re-litigate it.

**Git:**

- Never add self-attribution to branch names, commits, PR titles, PR
  descriptions, or code comments.
- Use conventional commits for commit titles and PR titles (e.g., `fix:`,
  `feat:`, `docs:`, `refactor:`).
- PR titles and descriptions are written for a reader who is not intimately
  familiar with the project. Lead with what changed and why.
- Never hard-wrap paragraphs in GitHub PR descriptions, PR comments, or issue
  text. Each prose paragraph is one single line; blank lines separate
  paragraphs.
- PR descriptions never include a test plan or a list of verification steps.
- Do not reference internal phase numbers, task IDs, or spec sections in
  commits or code comments.
- Never run `git reset` or `git checkout` that would destroy uncommitted or
  committed changes without explicit human permission. Prefer `git stash`, an
  explicit commit, or `git restore --staged <path>`.
- Use `gh` for GitHub operations (PRs, issues, API).

## Error Classification (data-loss safety)

**If the user (a handler / caller) causes an error, classify it as TRANSIENT,
not permanent — unless they explicitly tell us it is permanent.** A permanent
error discards the in-flight message, so misclassifying a _code mistake_ as
permanent silently drops data and can corrupt downstream state. A transient
error retries: the failure stays visible (logs/metrics/lag) so the developer
sees it and fixes their code, and no message is lost.

- Bad input to an API (an unrepresentable value, a `null`/`undefined` write, a
  wrong argument shape, an out-of-range index, an invalid enum token) is a
  **caller code error → transient**. Do NOT mint a permanent error for it.
- Permanent is reserved for cases the caller **explicitly declares** permanent
  (e.g. the handler itself throws a `PermanentError`/`PermanentStateError`).
- Startup/registration/config validation is separate: fail fast at build or
  subscribe (a thrown error that prevents the client from starting) — there is
  no in-flight message to lose, so failing loudly is correct.

## Concurrency Invariants (inherited from prosody)

- **One handler per key, system-wide.** The framework guarantees at most one
  message or timer handler for a given key executes anywhere in the cluster
  at any moment. Never design for concurrent writers on the same key — that
  scenario cannot occur.
- **At most one partition owner.** Kafka partition assignment guarantees one
  consumer group member owns each partition at a time.
- These invariants are why distributed locks and optimistic concurrency are
  never needed for per-key state. The framework provides the exclusivity;
  binding code and examples can assume it.

## Code Organization

**Maximum file size: 500 lines.** A file that exceeds it is subdivided into
modules. Split along a seam the code already has, and give each module a doc
comment naming what it owns. Re-export from the parent so the split is
invisible to callers. A split that only balances line counts is worse than
the long file; find the real seam.

**Prefer one-word module names** (`client`, `logging`, `handler`). A two-word
name usually means the module owns more than one concern, or the name
restates its parent's path. A compound name is right only when the compound
is the domain term.

**Order within Rust files (topological by dependencies):**
Constants → Statics → Types → Implementations → Functions → Errors (bottom)

## Types, Definitions, and Examples

The public typed surface is hand-written and must track the runtime exactly:

- `index.js` — the public runtime wrapper (JSDoc), over the generated
  `bindings.js`.
- `index.d.ts` — the hand-written public TypeScript surface. Every API change
  updates it in the same commit.
- `bindings.js` / `bindings.d.ts` — generated by `napi build`; never edit by
  hand. Regenerate with `npm run build:debug`.
- `__test__/types/*.type-test.ts` — compile-time type tests for the public
  surface.
- `examples/*.ts` — runnable examples, type-checked with the library.

`npm run typecheck` (`tsconfig.typecheck.json`) checks `index.d.ts`,
`bindings.d.ts`, the type tests, and the examples together. It must be green
in the same commit as any API change.

## Documentation Standards

**All written text for this project must conform to ASD-STE100 (Simplified
Technical English). No written text is exempt.** This rule applies to
documentation, comments, READMEs, plans, issues, reviews, chat responses,
commit messages, PR text, and user-facing text. Apply these primary STE rules:

- Use the active voice. Write instructions in the imperative.
- Write short sentences. Use 20 words or fewer for instructions. Use 25 words
  or fewer for descriptions.
- Write one instruction per sentence. Keep one topic per paragraph. Use a
  maximum of six sentences in each paragraph.
- Use a word with only one meaning. Use the same word for the same thing.
- Use simple verb tenses. Do not use an "-ing" form as a verb when a simple
  tense is correct.
- Do not use a noun cluster of more than three nouns.
- Use approved technical names and technical verbs consistently.

Further rules for doc comments and prose:

- Write doc comments for a reader unfamiliar with the codebase. Lead with
  what the thing is, how to use it, and what guarantee it gives — not the
  internal mechanism.
- Short declarative sentences, one idea each. At most one parenthetical aside
  per comment, never nested.
- Never argue with an imagined reviewer. State what the code does and the
  invariant it upholds. Mention a rejected alternative only when a maintainer
  would plausibly reintroduce it, as its own plain sentence.
- No invented compound jargon. Spell the idea out in ordinary words;
  established terms keep their standard form.
- State an invariant at the type or function that owns it, once. Reference
  the owning type elsewhere instead of restating.
- Be concise. Bad or needless docs hurt readability — prefer fewer, sharper
  words.
- Avoid vague metaphor filler in prose, comments, and commit/PR text ("north
  star", "surface area", "lean into", "double-click", "first-class citizen").
  Say the concrete thing instead.

### Rust Code with NAPI-RS v3

The format rules below govern how doc comments are written in Rust files that
use NAPI-RS v3; the STE rules above govern the prose inside them.

- **ALWAYS use standard Rust documentation format (`///`) for documentation in Rust files that use NAPI-RS v3**
- Do NOT use JSDoc format (`/** */`) in NAPI-RS v3 files
- NAPI-RS v3 expects standard Rust documentation comments and converts them to proper TypeScript definitions
- Use JSDoc-style tags inside the `///` comments, not Rust-style sections

### Example of CORRECT documentation in `src/client/mod.rs`:

```rust
/// Sends a message to a specified topic.
///
/// @param topic The topic to send the message to
/// @param key The key of the message
/// @param payload The payload of the message
/// @returns A promise that resolves when the message has been sent
/// @throws Error if the send operation fails
```

### Example of INCORRECT documentation (do not use):

```rust
/// Sends a message to a specified topic.
///
/// # Arguments
///
/// * `topic` - The topic to send the message to
/// * `key` - The key of the message
///
/// # Errors
///
/// Returns an error if the send operation fails.
```

## Testing

- Build debug and run tests: `npm run build:debug && npm test`
- Type check with: `npm run typecheck`
- Check formatting with: `npm run format:check`

**Important:** Integration tests take a long time to run. NEVER pipe test output to `head`, `tail`, `grep`, or similar commands. If you need to filter output, write the full output to a temp file first so you can investigate without re-running the entire test suite:

```bash
npm run build:debug && npm test 2>&1 | tee /tmp/test-output.txt
# Then filter the file as needed
grep "FAIL" /tmp/test-output.txt
```

**Test principles:**

- Drive tests by invariants, not by paths. Name the invariant (round-trip,
  parity, idempotence) and prefer few broad tests over many narrow example
  tests. Use realistic inputs, not happy-path toys.
- A test must be able to fail. When you write or convert a test, prove it can
  go red once: inject the failure, watch it fail, revert.
- Never delete a test without naming, in the commit, the surviving test that
  covers the same invariant at least as strongly.
- Never use `sleep` except for backpressure simulation. Wait on events,
  channels, or notifications with a deadline — the deadline is a hang-guard,
  never the assertion.
- Root-cause every intermittent failure. A passing re-run proves nothing.
  Extract the reproducer and land it as a deterministic regression test.
- In Rust tests, use `assert` or a `Result` with `?` — never
  `expect`/`unwrap`, never swallow errors.

## Common Patterns (Rust)

- Use `parking_lot` over `std::sync`
- For concurrent hash sets/maps, use `scc` (`scc::HashSet` / `scc::HashMap`),
  never a `Mutex<HashSet>` / `Mutex<HashMap>`; pair it with
  `ahash::RandomState`. In async code prefer its async interface.
- Use `tokio::sync` primitives (`Notify`, channels, `select!`) for async
- Independent I/O runs concurrently, never serially. Drive N independent
  reads through a bounded `buffered(N)` (order-preserving) or
  `buffer_unordered(N)` (unordered). Reserve serial `await` for genuinely
  dependent reads, where each result determines the next.
- Drive futures over non-tokio primitives through the cooperative budget:
  wrap each per-item future with `tokio::task::coop::cooperative` inside the
  producing closure, so a drain of ready items cannot starve the worker.
- Mark builders with `#[must_use]`
- Use `LazyLock` for expensive static initialization

## Tracing / OpenTelemetry

- Instrument with `#[instrument]`, never a hand-built `info_span!` +
  `.instrument(...)`. Use `skip_all` plus explicit `fields`, and `err` to
  record failures on the span.
- Span level is audience: spans the user's own code causes export at info;
  framework-internal spans use `level = "debug"`.
- Record unsigned integers as `i64` — the OTel layer stringifies
  `u64`/`usize`. Record attribute values with `%` (Display) where the type
  allows.
- Import tracing macros from `tracing` directly — never `use tracing::log::…`;
  no bridge is installed, so events logged through it silently vanish.
- Never cache a `Span` — cache an `opentelemetry::Context` and recreate spans
  on read. Cloning a span creates another reference to the same underlying
  span; finishing one finishes all.

## Workflows

When launching multi-agent workflows:

- Select model and effort per task by complexity — do not let every agent
  inherit the session model. Never downgrade a stage whose output gates a
  commit or ship decision.
- Disable the advisor in every agent prompt.
- Keep structured-output schemata trivially simple: flat objects with a few
  short bounded fields; put detail in report files.

## Research

- Automatically use context7 for code generation and library documentation.

## CI planning

- Check Cargo Rail after each CI path or repository layout change.
- Confirm that README-only changes select documentation jobs only.
- Confirm that source changes select all required build and test jobs.
- Add `rail.toml` only when the default rules classify a path incorrectly.
