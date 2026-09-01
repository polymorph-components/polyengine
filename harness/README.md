# Conformance harness

The wast→JSON conformance pipeline from docs/architecture.md §11: an offline Rust step
(`crates/testgen`) converts the official Component Model `.wast` suite into
JSON command files plus extracted binaries, and a TypeScript runner (this
directory, Deno) executes the JSON. The component runtime does not exist yet;
every command that needs it is recorded as a skip with reason
`pending-runtime`, so the same harness runs green today and becomes the
conformance gate as the runtime lands.

## Running

```sh
deno task conformance   # regenerate harness/generated/ via testgen, then test
deno task gen           # just (re)convert the wast suite
deno task test          # just run the tests against harness/generated/
```

`deno task test` prints a per-directory summary at the end:
`{commands, executed, passed, failed, pending-runtime, unsupported-directive}`.

testgen can also be run directly (from anywhere in the repo):

```sh
cargo run -p testgen                          # whole suite -> harness/generated/
cargo run -p testgen -- binary validation     # subset of test subdirectories
cargo run -p testgen -- --test-dir D --out-dir D2
```

Output is deterministic: same suite + same testgen build → byte-identical
`harness/generated/` (sorted traversal, stable JSON field order, no
timestamps or absolute paths).

## Why our own converter instead of `wasm-tools json-from-wast`

`json-from-wast` (wasm-tools 1.247.0) *does* model component directives in
its JSON — the schema below is essentially its schema — but its bundled
`wast` parser predates the current test suite's text syntax
(`(dtor (core func ...))`, `async`/`(callback ...)` canon-lift options,
`(implements ...)` import attributes): 40 of 57 suite files fail to parse
with that CLI. testgen therefore uses the `wast` crate directly (pinned in
`Cargo.lock`, currently 255.0.0), which parses the entire suite, and emits
the same JSON model with two extensions noted below. This is the exact
fallback docs/architecture.md §11 anticipated.

## Generated layout

```
harness/generated/
  manifest.json            # {"files": ["async/cancel-stream.json", ...]}
  <suite-dir>/<stem>.json  # command file, one per .wast
  <suite-dir>/<stem>.<N>.wasm   # extracted binary (module or component)
  <suite-dir>/<stem>.<N>.wat    # only for quote forms kept as text
```

## JSON schema

Follows WABT's `wast2json` model
(<https://github.com/WebAssembly/wabt/blob/main/docs/wast2json.md>) as
emitted by `wasm-tools json-from-wast`. A file is
`{source_filename, commands: [...]}`; each command has a `type` and the
1-based source `line`. TypeScript definitions: `src/schema.ts`.

Command types and their fields:

| type | fields | meaning |
|---|---|---|
| `module` | `name?, filename, module_type, kind` | define+validate+instantiate; becomes default action target |
| `module_definition` | `name?, filename, module_type, kind` | define+validate only (`(component definition ...)`) |
| `module_instance` | `instance?, module?` | instantiate a prior definition (`module` absent = most recent); becomes default target |
| `register` | `as, name?` | make instance importable (unused by this suite) |
| `action` | `action` | run action, ignore results |
| `assert_return` | `action, expected` | action returns `expected` values |
| `assert_trap` | `action, text` | action traps, message matches `text` |
| `assert_invalid` | `filename, module_type, kind, text` | binary decodes but fails validation |
| `assert_malformed` | `filename, module_type, kind, text` | binary fails decoding (or text fails parsing) |
| `assert_uninstantiable` | `filename, module_type, kind, text` | valid, but instantiation traps (from `(assert_trap (component ...))`) |
| `assert_unlinkable` | `filename, module_type, kind, text` | valid, but linking fails (unused by this suite) |
| `assert_exhaustion` / `assert_exception` / `assert_suspension` | `action, text?` | core-suite directives, unused here |

Actions: `{"type":"invoke", "module"?, "field", "args":[Value]}` and
`{"type":"get", "module"?, "field"}`. `module` names a **named instance**;
absent means the current default instance (wast2json convention).

Extensions over `json-from-wast`:

1. **`kind`: `"module" | "component"`** on every artifact-bearing command, so
   consumers never sniff the 8-byte preamble to tell layers apart. (In the
   official suite every top-level artifact is a component; core modules only
   appear nested inside them.)
2. **Documented component value encoding** (below); `json-from-wast`'s
   encoding for compound values is unspecified.

### Values

Every value is `{"type": ..., "value": ...}` plus type-specific fields.
Scalars encode as decimal **strings**; floats are IEEE754 **bit patterns**
(f32→u32, f64→u64), with `nan:canonical` / `nan:arithmetic` allowed in
expectations; core `i32`/`i64` are printed unsigned (wast2json convention),
component `s8..s64` are signed.

| type | encoding |
|---|---|
| `bool` | `"true"` / `"false"` |
| `u8 s8 u16 s16 u32 s32 u64 s64 i32 i64 f32 f64` | decimal string |
| `char` | the single Unicode scalar value as a string |
| `string` | the string |
| `list`, `tuple` | `value` = array of Values |
| `record` | `value` = array of `{name, value: Value}` |
| `variant` | `case` = case name, `value` = payload Value or `null` |
| `enum` | `value` = case name |
| `option` | `value` = payload Value or `null` (= none) |
| `result` | `status` = `"ok"`/`"err"`, `value` = payload Value or `null` |
| `flags` | `value` = array of set flag names |
| `v128` | `lane_type` set, `value` = array of lane strings (core-suite only) |

### Text artifacts

`(component quote "...")` forms whose malformedness lives at the text level
are written as `.wat` with `module_type: "text"` (5 in the current suite,
all `assert_malformed`). They are only executable by a host with a text
parser; the runner records them as skip(`unsupported-directive`).

## Executor contract (provisional)

`src/executor.ts` defines `CommandExecutor` — the interface a future
polyengine runtime must implement to make this harness execute for
real. It is deliberately minimal and **will change**; it exists so runner
and runtime evolve against one concrete seam:

- `validate(artifact)` → verdict (never throws for bad input; malformed vs
  invalid need not be distinguished)
- `instantiate(artifact, expect)` → `InstanceRef`; `expect` (`"success"` /
  `"trap"` / `"link-error"`) lets a partial executor decline verdicts it
  cannot deliver honestly
- `define(name?, artifact)` / `instantiateDefinition(defName?, instanceName?)`
  — the `module_definition` / `module_instance` pair
- `register(as, instance?)`
- `invoke(target?, field, args)` / `get(target?, field)` → outcome
  (`returned values` | `trapped message`; traps are outcomes, not exceptions)
- `reset()` — drop all per-file state (executor state is per `.wast` file)

The runner owns instance *naming* and the "current default instance" rule;
the executor owns everything semantic. Anything the executor cannot do yet
throws `PendingRuntimeError`, which the runner records as a
skip(`pending-runtime`) rather than a failure.

`CoreOnlyExecutor` is the pipeline-sanity stub: core modules are validated
and compiled with the JS `WebAssembly` API; **all component-layer operations
throw `PendingRuntimeError`**. This is forced, not lazy: V8 rejects the
component preamble (`00 61 73 6d 0d 00 01 00`) outright, so
`WebAssembly.validate` returns `false` for valid and invalid components
alike — no component verdict can come from the JS API. That layer is
pinned by a unit test in `tests/runner_unit_test.ts`. It stays available via
`CONFORMANCE_EXECUTOR=core-only deno task test` for pipeline sanity (no shim
build required).

`RuntimeExecutor` (`src/runtime-executor.ts`) is the real thing, driving
`runtime/`'s public API (`@polyengine/runtime/{shim,exec,cabi,plan}`,
consumed read-only — this is Track A's territory):

- `validate` / component `instantiate`: `Translator.translate` (the wasm32
  shim under Deno) is the verdict — a structured `{error}` envelope (surfaced
  as a thrown `PlanError`) means invalid/malformed; the JS API can't
  distinguish the two either, so neither does this.
- successful translation feeds `instantiateComponent` (plan v0 → compiled
  core modules → task-model-backed export surface); its `Trap` /
  `UnsupportedFeatureError` / `PlanError` outcomes map to
  `TrapError`/`LinkError`/`PendingRuntimeError` by the command's expected
  outcome (`assert_uninstantiable` vs `assert_unlinkable` vs a plain
  instantiation gap).
- `module_definition`/`module_instance` reuse the same translate/instantiate
  path against a small per-file definition table (by name, or "most recent").
- `invoke` calls the export as a plain JS function
  (`component.exports[field](...)` — see `runtime/src/exec/boundary.ts`
  `createLiftedFunction`) with arguments converted from wast-JSON `Value` to
  the runtime's `ComponentValue` host shapes (`src/value-mapping.ts`); the
  arity of the raw JS return (`undefined`/bare-value/array, see
  `resultsToHost`) is reconstructed into a proper result list using the
  export's `FuncType.results.length` (recomputed from the plan, since a
  single `list`-typed result is otherwise indistinguishable from a
  multi-result array).
- `get` (a core `global.get` wast action) has no component-level equivalent
  in this suite; declined honestly as `pending-runtime` rather than guessed.
- capability gaps the sync executor is expected to hit (async canonical
  options, stream/future values, error-context — the task scheduler's scope)
  are recognized by message substring (`CAPABILITY_MARKERS` in
  `runtime-executor.ts`) and reported as skip(`pending-capability: ...`) — a
  precise subset of `pending-runtime` naming the exact missing feature,
  rather than a generic skip or a false failure.

### Value comparison

`src/value-mapping.ts` converts both directions against the runtime's
`ComponentValue` (definitions.py host shapes — variant/enum/option/result as
single-key `{label: payload}` objects, tuple as despecialized record,
flags as `{label: boolean}`, `list<u8>` as `Uint8Array`): `toComponentValue`
for invoke arguments, `compareValue`/`compareValues` for `assert_return`
(recursive, type-directed by the *expected* value's own tag — no separate
`FuncType` needed on either side, matching how the runtime itself never
exposes one across its export-call boundary).

Floats compare bit-exact: the expected bit-pattern string is decoded via a
shared `DataView` scratch buffer and compared against the actual value's
re-encoded bits, except `nan:canonical`/`nan:arithmetic` expectations, which
match by NaN pattern class instead of exact bits. In practice the runtime's
deterministic NaN profile (`runtime/src/cabi/float.ts`) always produces
exactly the canonical NaN bit pattern, so both classes are satisfied by
every NaN the runtime returns — but the pattern-class check is written
generally in case a less-deterministic engine's NaN ever needs it.

### Trap-message matching

`runner.ts`'s `trapMatches` compares by substring first (the suite's own
convention), then falls back to a small checked-in table
(`TRAP_MESSAGE_EQUIVALENTS`) of confirmed-equivalent wording pairs, e.g. the
suite's `"unknown handle index N"` vs. the runtime's
`"table index out of range"`/`"table entry empty"` (both are `trapIf(...)`
call sites in `runtime/src/cabi/handles.ts` — same semantic condition,
independently-authored text). A message pair not in the table is a plain
substring failure, not a silent pass — the table only encodes *confirmed*
equivalences, not a permissive fuzzy match.

### Triage: xfail list

`src/xfail.ts` is a checked-in `{file, line, reason}` list (line = the
command's 1-based source line, stable across regen) for commands that fail
today for a known, understood cause outside harness territory (a
translator-shim encoding gap, a sync-vs-task-scheduler semantic gap, etc.) — distinct
from "unexpected regression". `tests/conformance_test.ts` treats a failure
matched in `XFAIL` as `xfail` in the summary rather than `failed`, and it
does not fail the surrounding `Deno.test`. It is *not* auto-verified against
the actual outcome (an xfail'd command that starts passing again isn't
flagged) — periodically diff the summary's `xfail` column against
`XFAIL.length`.

`test/async/` and `test/values/` are deliberately **not** triaged into
`xfail.ts` — docs/architecture.md §7 excludes `test/values/` from parity scope entirely
(wasmtime doesn't implement component `value` imports/exports), and
`test/async/` is task-scheduler scope; both are expected to show real
failures against the sync-only executor and are left as visible `failed`
counts rather than suppressed, so the summary keeps signaling exactly how
much of the suite the current implementation should be judged against
(binary, linking, resources, validation).

### Wire-up

`deno task conformance` = `deno task gen` (testgen regen) + `deno task
shim-check` (build the wasm32 shim if the artifact is missing) + `deno task
test`. `CONFORMANCE_EXECUTOR=core-only` switches `deno task test` back to
the JS-API-only stub.
