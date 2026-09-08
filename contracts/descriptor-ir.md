# Contract: CABI Descriptor IR

The **descriptor IR** supplies types and canonical options for host-boundary
lift/lower. The translator emits it in the plan's `types` and `canonicalOptions`
tables. The runtime interpreter (`runtime/src/cabi/`) and world-digest
computation consume it. A generated-JS executor is planned, not implemented; see
[architecture §8](../docs/architecture.md#8-performance-strategy).

The normative in-memory model is `runtime/src/cabi/types.ts`; this document
defines its meaning and its JSON wire form inside the plan. Known wire↔memory
divergences are pinned below; any other divergence is a bug.

## Value type model

A `ValType` is a discriminated union (JSON: `{ "kind": … }` objects, nested
structurally). Kinds:

- Primitives: `bool`, `s8`, `u8`, `s16`, `u16`, `s32`, `u32`, `s64`, `u64`,
  `f32`, `f64`, `char`, `string`
- `list` (`element`, optional fixed `length`), `record` (`fields`:
  `{label, type}[]`), `tuple` (`elements`), `variant` (`cases`:
  `{label, type|null}[]`), `enum` (`labels`), `option` (`type`), `result`
  (`ok|null`, `err|null`), `flags` (`labels`), `map` (`key`, `value` —
  despecializes to `list<record{0,1}>` per the reference)
- Handles: `own` / `borrow` (`resource`: index into the plan's `resourceTables`)
- Async: `stream` / `future` (`element|null`), `error-context`

Specialized forms are preserved (tuple/enum/option/result/flags/map are not
pre-despecialized in the IR); `despecialize` is defined once, in the runtime,
mirroring `definitions.py`. Labels remain strings.

Wire function declarations are
`{ kind: "func", params: {label, type}[], results: ValType[], async: bool }`.

Pinned wire↔memory divergences (the plan loader maps): wire `result.err` ↔
types.ts `result.error`; wire `FuncType.params` are labeled `{label, type}[]`
while types.ts drops names — names live on the wire and in bindgen, not in the
interpreter's hot path.

## Canonical options

Per lifted/lowered function, referencing plan tables by index (see
plan-format.md): `stringEncoding` (`utf8` | `utf16` | `latin1+utf16`), nullable
`memory`, `realloc`, `postReturn`, `callback`, plus `async`, `cancellable`, and
the expected flat `coreType` (`{params, results}` of `i32|i64|f32|f64`). This
mirrors `wasmtime_environ::component::CanonicalOptions` minus runtime-irrelevant
fields; `data_model` is fixed to linear memory (the GC data model is rejected by
the shim).

## Flattening

The plan does **not** precompute flat lane lists. Executors compute flattening
from `ValType` via the shared rules in `runtime/src/cabi/flatten.ts`, which is
tested against fixtures generated from `definitions.py` (`flatten_functype`,
MAX_FLAT_PARAMS=16, MAX_FLAT_RESULTS=1, async variants with their own limits,
spill-to-memory rules). Rationale: one implementation of the trickiest rules,
differentially anchored to the executable spec; smaller plans; less shim logic.
The consistency check between computed flattening and the options' `coreType` is
an instantiate-time assertion — validated across the fixture corpus.

## Host value shapes

The runtime facade implements [embedder-api.md](embedder-api.md); bindgen emits
types and typed wrappers for that facade. The raw executor preserves the
reference's value semantics in these internal shapes: variant as
`{kind: label, value: payload}`, enum as `{kind: label, value: null}`, option as
`{kind: "none", value: null} / {kind: "some", value: v}`, result error kind
`"error"`, tuple as despecialized record. It is an internal surface with no
stability promise.

Core integer lanes are normalized to unsigned values of their width before
lifting; narrower component integers wrap according to `definitions.py`. i64
values use `bigint`, including `0n` padding. The public facade validates host
values before lowering. At the raw internal boundary, scalar `storeInt` asserts
range while bulk numeric stores wrap; neither is a substitute for facade
validation. NaNs are canonicalized. Latin-1 decoding uses the ISO-8859-1 byte
mapping, not WHATWG `TextDecoder`'s Windows-1252 alias. See
[architecture §7](../docs/architecture.md#7-canonical-abi-decisions).

Fixed `kind`/`value` properties avoid per-case object shapes and key
enumeration. `value` is always present, with `null` for a payloadless case.
Despite shared property names, raw and facade values are not interchangeable;
see [the adaptation table](embedder-api.md#implementation-strategy).

## Trap discipline

Guest lift/lower violations raise `Trap`, following the reference's `trap_if`
conditions. Internal/precondition assertions use `AssertionError`; invalid
public host values are rejected by facade validation. These failure classes must
not be conflated with unsupported capabilities or translator errors.

## Executor contract

The interpreter is checked against fixtures generated from the Python reference
(`runtime/tests/fixtures/`). A future generated-JS executor must consume the
same IR and agree on values and trap conditions. Any IR extension must land with
fixtures.

## Resource-type identity

The shim emits `resource` indices into the plan's `resourceTables`. Preserve two
identities when loading these descriptors:

- **Underlying resource identity**, keyed by concrete `ResourceIndex`, owns
  implementation/destructor metadata in `ResourceTypeInfo`. Legitimate
  cross-component aliases and host resource wrappers compare this identity.
- **Local handle type identity**, keyed by `TypeResourceTableIndex`, governs
  guest handle access through `ResourceTableInfo`, which references its
  underlying resource. Distinct abstract imports can share an underlying
  resource and a component instance while retaining different local identities.

Both are scoped to a runtime instantiation of the plan, not just its reusable
JSON object. Guest-defined identities are fresh on every instantiation.
Transferring a handle validates the source local type and tags the destination
handle with its destination local type; it does not change the resource origin.
Stream/future endpoints likewise retain their local element descriptors for
guest access checks, while rendezvous compatibility uses underlying identities.
Sharing origin metadata must not erase the child's abstract type distinctions
(pinned Explainer, type imports and substitution).
