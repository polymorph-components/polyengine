# Conformance harness

`crates/testgen` converts the pinned Component Model WAST suite into JSON commands
and extracted binaries. This directory executes those commands under Deno;
browser and engine-shell runners reuse the harness with lane-specific
expectations. See [architecture](../docs/architecture.md) for the parity policy
and platform scope.

A green run means no unexpected failures or passing stale xfails in the
executed corpus. It is **not proof of full conformance**: known failures, skipped
directives, capability gaps, and scheduling-profile exclusions remain visible
and must be included when reporting results.

## Running

From the repository root:

```sh
just shim          # rebuild the translator for the current source
just conformance   # regenerate the corpus and run the Deno harness
```

From `harness/`:

```sh
deno task gen          # regenerate harness/generated/ with testgen
deno task test         # run against existing corpus and shim
deno task conformance  # gen + shim-check + test
```

`shim-check` builds only when the artifact is absent; it does not detect a stale
shim. `CONFORMANCE_EXECUTOR=core-only deno task test` selects the JS-WebAssembly
pipeline-sanity stub, not a component conformance run. It needs no shim.

Testgen also accepts directory subsets and explicit locations, from the repo root:

```sh
cargo run -p testgen -- binary validation
cargo run -p testgen -- --test-dir D --out-dir D2
```

## Results and exclusions

The per-directory summary reports `commands`, `executed`, `passed`, `failed`,
`xfail`, `pending-runtime`, `pending-capability`, and `unsupported-directive`.
`executed` includes passes and both known and unexpected failures; skips are
separate.

- `src/xfail.ts` records known failures by generated file and WAST source line,
  with a reason and tracking issue. A matching failure is an xfail, not a pass.
  The Deno summary fails if an xfailed command passes. This check does not prove
  that every listed entry was reached, or that a failure still has its original
  cause; review the reason when triaging a changed result.
- `PendingRuntimeError` becomes a skip. A `pending-capability:` prefix selects
  the more specific counter. `RuntimeExecutor` retains message-based capability
  classification in `CAPABILITY_MARKERS`; these skips are not validation
  verdicts or evidence that all async behavior is unsupported.
- Text/quote artifacts and unimplemented directives are recorded as
  `unsupported-directive` rather than passed.
- Under `POLYENGINE_SCHED_SEED`, files in `DETERMINISTIC_PROFILE_ONLY` are ignored
  by Deno because their guests assert reference-profile scheduling order. They
  are absent from the command summary, so report the ignored-test count too.
- Browser and shell deltas live in `browser/expectations/` and
  `shell/expectations/`. Their lane runners check for unexpected deviations and
  stale deltas; a lane with accepted deltas is not an all-pass corpus.

All generated suite directories, including `async/` and `values/`, are run.
Component-level value imports/exports remain outside the runtime's stated
parity scope; do not confuse that feature with ordinary canonical-ABI values.

## Supplementary Wasmtime coverage

`tools/wasmtime/` converts Wasmtime's own `tests/misc_testsuite/component-model`
WAST at the same `wasmtime-environ` revision pinned in `Cargo.lock`, and runs it
through this harness under a separate classifier
(`src/wasmtime-classifier.ts`, `src/wasmtime-expectations.ts`). It is
supplementary reference material (docs/architecture.md §11), not the official
Component Model corpus above: its expectations, exclusions, and results never
mix with `src/xfail.ts` or `generated/`.

```sh
just test-wasmtime          # from the repo root
just test-wasmtime-guests   # public API scenarios, FIFO and seeded
```

From `harness/`, `deno task wasmtime` runs generation, shim-check, focused
harness tests, and the classifying runner. Guest builds require the Rust
`wasm32-wasip1` and `wasm32-unknown-unknown` targets plus `wasm-tools`.

Results, including full per-class and per-file counts, are written to
`harness/generated-wasmtime/results.json` — read that file rather than a fixed
number from this document; counts shift as the pinned revision or translator
changes. As of the pinned revision above, the run classifies every command
executed: no unexpected failures or unexplained skips. Known-failure classes
and their tracking issues are declared in
`harness/src/wasmtime-expectations.ts` (`WASMTIME_FAILURE_CLASSES`); most map
to [#372](https://github.com/polymorph-components/polyengine/issues/372)
(runtime-semantics, diagnostic-mismatch, imported-module, cascade,
provider-control, exception-handling — plan v0 / diagnostic gaps against
Wasmtime's own assertions, not the spec corpus above). The supplementary thread
fixtures now execute rather than being skipped.

One thread-transparency row is classified separately as a specification
conflict under [#380](https://github.com/polymorph-components/polyengine/issues/380).
Wasmtime permits an outer-instance ready thread to progress a nested synchronous
lift, while the pinned Component Model `canon_lift` loop restricts candidates to
the synchronous callee instance. The row still executes and its exact failure is
checked; it is neither excluded nor treated as a diagnostic equivalence.

This does not imply
unrestricted explicit-thread conformance: valid non-final or derived
start-function signatures can be rejected by the runtime's nominal `ref.test`
validator, as documented in `contracts/intrinsics.md`; the current Wasmtime
fixtures use the supported canonical-final signatures and do not test that
interface restriction
([#12](https://github.com/polymorph-components/polyengine/issues/12)).
A handful of files are excluded outright; see `WASMTIME_EXCLUSIONS` for the
current list and reasons. In particular, `streams-massive-send.wast` asserts
Wasmtime's host-defined 128 MiB per-hostcall transfer-fuel policy using an
exponentially expanded nested-list value. The Component Model specifies no such
fuel limit, and executing it in this in-process V8 harness can exhaust the
bounded heap before a catchable result. This exclusion is not a claim that the
runtime has an equivalent production resource limit. The run fails if an
exclusion goes stale (the file gone from the manifest).

Two Wasmtime-private controls are treated by purpose rather than name. The
`context-in-resource-drop.wast` `wasmtime/gc` import is supplied only for that
file as a real synchronous host call. Wasmtime uses GC to force a deferred
destructor frame; polyengine eagerly materializes the logical task/thread, so
the boundary itself exercises context preservation and no JavaScript GC is
forced. Conversely, `set-max-table-capacity` is not emulated: its leak-detection
purpose is covered by
`runtime/tests/wasmtime/cancel_starting_reuse_test.ts`, which performs 1,000
STARTING-cancel-deliver-drop cycles and asserts bounded handle-slot reuse.

Some exact supplementary trap strings describe the same rejected operation at
different levels of detail. `runner.ts` records exact-only equivalents for the
five non-thread `task-return-traps.wast` diagnostic rows. Eleven future-write
rows remain classified instead: in each named fixture the reader was dropped,
but Wasmtime retains separate local/transmit completion guards while
polyengine's reference-shaped `WritableFutureEnd` has one `CopyState.DONE` and
reports its broader “previous write succeeded or readable end dropped” text.
That row-specific diagnostic divergence is spec-compatible, but it is not a
global message equivalence because the runtime text also covers a distinct
successful-prior-write condition.

Variant lifting reports the rejected discriminant and case-count range exactly.
Link-error assertions accept native link failures and host-resource import type
mismatches; native start traps, translation failures, and generic plan errors
remain distinct.

At the current pin, the remaining async subset is 13 classified failures and
zero skips: those eleven diagnostic rows, the unavailable native
`set-max-table-capacity` provider row, and its one no-current-instance cascade.
The capacity knob is intentionally not a production capability; the bounded
reuse test above covers its leak-detection purpose without pretending to
reproduce Wasmtime's host configuration surface.

The official Deno, Chromium, and Firefox aggregate at the current Component Model pin is
1,622 commands, 1,617 executed, 1,593 passed, 24 exact xfails, zero
runtime/capability skips, and five unsupported text directives. Seeded runs
omit the three-command `async-calls-sync` deterministic-profile fixture, giving
1,619 commands, 1,614 executed, and 1,590 passed with the same 24 xfails and
five unsupported directives.

`just test-wasmtime-guests` builds the two upstream async guest binaries this
WAST corpus doesn't cover as executables — `async_round_trip_stackless` and
`async_short_reads` from `crates/test-programs/src/bin/` at the same locked
revision — and drives them through the public embedder API
(`runtime/tests/wasmtime/public_guests.ts`), once under FIFO scheduling and
once under `POLYENGINE_SCHED_SEED=1`. `just wasmtime-guests`
(`tools/wasmtime-guests/build.ts`) does the build alone: it clones the locked
revision into an ignored scratch checkout, builds with a separate
`CARGO_TARGET_DIR`, and refuses dirty source inputs, replacing a clean scratch
checkout when the pin changes. The cached
upstream checkout under cargo's git cache is read, never written. One of the
two guest scenarios asserts resource `own<T>` ownership transfer across a
short-read stream (source wrappers invalidated after transfer, returned
wrappers exclusively own the value, drop is idempotent); this exercises the
public wrapper API's ownership bookkeeping, not Wasmtime's internal
resource-table representation, which this project makes no claim about.

The WAST host provider uses raw resource reps, which do not expose the Rust
`Resource::owned()` flag. Its corresponding host-side ownership assertions
are not reproduced; the guest scenarios exercise public ownership transfer.

Both gates report source provenance (`Cargo.lock`'s `wasmtime-environ` git
revision) and fail on drift — a stale locked revision, a modified guest
checkout, or a guest artifact that doesn't hash-match its build's own
provenance — rather than silently running an unreviewed rebuild.

## Execution

[`CommandExecutor`](src/executor.ts) separates command bookkeeping from engine
semantics. The runner owns instance names and the current default instance, and
resets executor state after each file. The Deno test gives each file a timeout;
a stalled file is recorded as failed rather than disappearing from the summary.

[`RuntimeExecutor`](src/runtime-executor.ts) translates components, loads the
current plan format, and calls the internal plan executor. It exercises the raw
canonical value boundary, not the public embedder facade. Async exports are
awaited; WAST calls use `trapOnIdle: true` so an unresolved blocking call that
goes idle is a deadlock verdict rather than a permanently pending Promise.

Only a structured `TranslateError` with phase `validation` counts as component
rejection for `assert_invalid` or `assert_malformed`. Translation does not
distinguish those two phases; `unsupported` and `internal` errors are not valid
rejection evidence. Instantiation errors are mapped separately according to the
command's expected trap or link failure.

The plain core-module path delegates to `CoreOnlyExecutor`, which validates and
compiles but does not instantiate the module. The separate core definition/
instance path can instantiate a compiled module with empty imports. General
core invocation and component `get` are not implemented. `register` records
instances but does not wire them into component host imports. These are harness
limits, not claims about the embedder API.

## Generated data and comparison

```text
harness/generated/
  manifest.json              # list of generated command files
  <suite-dir>/<stem>.json     # one command file per WAST file
  <suite-dir>/<stem>.<N>.wasm  # extracted binary
  <suite-dir>/<stem>.<N>.wat   # quoted text artifact
```

Generation is deterministic for the same suite and testgen build. The schema
comes from `json-from-wast`; [`src/schema.ts`](src/schema.ts) mirrors the subset
used by this harness. Assertion `line` values identify the inner form's 1-based
source line, not necessarily the enclosing assertion. They remain stable only
while the WAST source does.

The JSON artifact metadata does not identify core module versus component.
`artifactKind` in [`src/runner.ts`](src/runner.ts) recognizes the exact core
preamble and sends everything else to the component translator. Quoted text is
not compiled by this runner.

[`src/value-mapping.ts`](src/value-mapping.ts) converts WAST values to the raw
runtime shapes and compares results recursively. Export arity comes from the
plan, so a single list result is not confused with multiple results. Floats
compare by bits, with NaN-pattern classes handled separately. Trap messages use
substring matching plus the explicit `TRAP_MESSAGE_EQUIVALENTS` table in the
runner; unmatched wording fails rather than being accepted by fuzzy matching.
