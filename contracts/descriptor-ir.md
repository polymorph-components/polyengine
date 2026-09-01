# Contract: CABI Descriptor IR

The **descriptor IR** is the type/options information that drives host-boundary
lift/lower — docs/architecture.md §8's "one IR, two executors." Producers: the
translator shim (inside `plan.json` `types` / `canonicalOptions` tables) and
tests. Consumers: the v1 interpreter (`runtime/src/cabi/`), the future
generated-JS executor, and the world-digest computation.

The normative in-memory model is `runtime/src/cabi/types.ts`; this document
defines its meaning and its JSON wire form inside the plan. Known
wire↔memory divergences are pinned below; any other divergence is a bug.

## Value type model

A `ValType` is a discriminated union (JSON: `{ "kind": … }` objects, nested
structurally). Kinds:

- Primitives: `bool`, `s8`, `u8`, `s16`, `u16`, `s32`, `u32`, `s64`, `u64`,
  `f32`, `f64`, `char`, `string`
- `list` (`element`, optional fixed `length`), `record` (`fields`:
  `{label, type}[]`), `tuple` (`elements`), `variant` (`cases`:
  `{label, type|null}[]`), `enum` (`labels`), `option` (`type`),
  `result` (`ok|null`, `err|null`), `flags` (`labels`), `map` (`key`,
  `value` — despecializes to `list<record{0,1}>` per the reference)
- Handles: `own` / `borrow` (`resource`: index into the plan's
  `resourceTables`)
- Async: `stream` / `future` (`element|null`), `error-context`

Specialized forms are preserved (tuple/enum/option/result/flags/map are not
pre-despecialized in the IR); `despecialize` is defined once, in the runtime,
mirroring `definitions.py`. Labels remain strings (interning is a
measured-need optimization).

`FuncType` is `{ params: {label, type}[], results: ValType[], async?: bool }`.

Pinned wire↔memory divergences (the plan loader maps): wire `result.err` ↔
types.ts `result.error`; wire `FuncType.params` are labeled
`{label, type}[]` while types.ts drops names — names live on the wire and in
bindgen, not in the interpreter's hot path.

## Canonical options

Per lifted/lowered function, referencing plan tables by index (see
plan-format.md): `stringEncoding` (`utf8` | `utf16` | `latin1+utf16`),
`memory?`, `realloc?`, `postReturn?`, `callback?`, `async`, `cancellable`,
and the expected flat `coreType` (`{params, results}` of `i32|i64|f32|f64`).
This mirrors `wasmtime_environ::component::CanonicalOptions` minus
runtime-irrelevant fields; `data_model` is fixed to linear memory (the GC
data model is rejected by the shim).

## Flattening

The plan does **not** precompute flat lane lists. Executors compute flattening
from `ValType` via the shared rules in `runtime/src/cabi/flatten.ts`, which is
tested against fixtures generated from `definitions.py` (`flatten_functype`,
MAX_FLAT_PARAMS=16, MAX_FLAT_RESULTS=1, async variants with their own
limits, spill-to-memory rules). Rationale: one implementation of the trickiest
rules, differentially anchored to the executable spec; smaller plans; less
shim logic. The consistency check between computed flattening and the
options' `coreType` is an instantiate-time assertion — validated across the
whole fixture corpus. (Precomputed lanes can be added later as a pure
optimization without changing this contract's semantics.)

## Host value shapes

Host-facing value conventions are `contracts/embedder-api.md`'s territory
(implemented by the bindgen-generated layer). The raw executor boundary
produces the `definitions.py` interpreter shapes — variant as single-key
`{label: payload}`, enum as `{label: null}`, option as
`{none: null} / {some: v}`, result error key `"error"`, tuple as
despecialized record — and is an internal surface with no stability
promise. Integer lanes wrap mod 2⁶⁴ at the raw boundary, matching
definitions.py's `% 2**64`; host-side range *asserts* (host-precondition
errors, not traps) exist only on the scalar `storeInt` path. NaN handling,
lane widening/padding (i64 lanes as `bigint`, `0n` padding), and
latin1(windows-1252) details follow the decisions recorded in
`runtime/README.md` and docs/architecture.md §7.

## Trap discipline

Lift/lower failures raise the runtime's `ComponentTrap` (not arbitrary
`Error`s), with the trap conditions of `definitions.py` (`trap_if`) as the
authority. Executors must produce the same trap/no-trap verdict for the same
inputs — this is part of the differential-testing contract.

## Executor contract

Interpreter (v1) and generated-JS executors consume this IR unchanged;
the differential test harness runs both over the same fixture corpus
(`runtime/tests/fixtures/`, regenerable from the Python reference). Any IR
extension must land with fixtures.

## Resource-type identity

The shim emits `resource` indices into the plan's `resourceTables`; the
runtime builds identity tokens (`ResourceTypeInfo`) at plan-load time.
**Tokens must be fresh per instantiation** (the executor re-runs plan
loading per instantiate), so resource-type identity never leaks across
instances.
