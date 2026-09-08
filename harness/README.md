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
