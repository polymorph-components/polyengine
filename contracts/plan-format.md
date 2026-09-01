# Contract: Plan Format

The **plan** is the translator shim's output: everything the TS runtime needs
to instantiate and link one component, derived deterministically from the
component binary. This document is the interface between `crates/translator-shim`
(producer) and `runtime/` (consumer); see also
[descriptor-ir.md](descriptor-ir.md) and [intrinsics.md](intrinsics.md).

Current `formatVersion`: **4**. The compat rule is strict equality; any
change bumps `formatVersion` and updates producer and consumer in the same
commit. A stale cached artifact fails loudly rather than executing subtly
differently.

## Decisions (with rationale)

1. **Own schema, not wasmtime's.** `wasmtime_environ::component::Component`
   derives `Serialize`, which makes the *shim's mapping code* cheap — but its
   shape is an unstable internal API and is never exposed in the plan. The
   plan schema is defined here and owned by us (docs/architecture.md §4.2).
   The shim is the only code that sees both shapes.
2. **JSON encoding.** Debuggable, diffable, good enough. Revisit
   (postcard / custom section) only on measured need.
3. **No duplicate bytes.** Embedded core modules are referenced as
   `[offset, len)` byte ranges into the original component binary — the
   executor slices them itself. Only FACT adapter modules (bytes that don't
   exist in the input) ship as separate artifacts.
4. **Types, not precomputed lanes.** The plan carries component-level types
   (descriptor IR); flattening is computed in the runtime by shared,
   reference-tested rules. See descriptor-ir.md "Flattening".

## Artifact set

A translation produces, content-addressed by
`sha256(component) x shim version x feature flags`:

```
plan.json                 this document's schema
adapters/<idx>.wasm       FACT-generated core modules (kilobytes each)
```

The original component binary is the third input at instantiation time; the
plan never embeds it.

## plan.json schema

```jsonc
{
  "formatVersion": 4,
  "producer": {
    "shimVersion": "…",              // crates/translator-shim crate version
    "wasmtimeEnviron": "47.0.3",     // exact pinned version
    "features": ["cm-async", "…"]    // wasmparser feature set used
                                     // (incl. cm-fixed-length-lists, cm-map,
                                     //  cm-implements, cm-threading) —
                                     // artifact-cache key input
  },
  "component": { "sha256": "…", "len": 123 },

  // Static module index space: embedded modules first, then FACT adapters,
  // exactly as wasmtime-environ returns them (PrimaryMap<StaticModuleIndex>).
  "modules": [
    { "kind": "embedded", "offset": 10, "len": 52 },
    { "kind": "adapter",  "file": "adapters/2.wasm", "len": 290,
      "intrinsics": [ /* see intrinsics.md: required imports, categorized */ ]
    }
  ],

  // Ordered instantiation program. One entry per
  // wasmtime_environ::component::GlobalInitializer, tag-for-tag:
  //   instantiate-module | lower-import | extract-memory | extract-realloc |
  //   extract-callback | extract-post-return | extract-table | resource
  "initializers": [
    { "op": "instantiate-module", "module": 0,
      "instance": 0,               // RuntimeComponentInstanceIndex; null = adapter
      "args": [ /* CoreDef */ ] },
    { "op": "lower-import", "index": 0, "import": 0 },
    { "op": "extract-memory", "index": 0, "export": { /* CoreExport */ } },
    { "op": "extract-realloc", "index": 0, "def": { /* CoreDef */ } },
    { "op": "extract-callback", "index": 0, "def": { /* CoreDef */ } },
    { "op": "extract-post-return", "index": 0, "def": { /* CoreDef */ } },
    { "op": "extract-table", "index": 0, "export": { /* CoreExport */ } },
    { "op": "resource", "index": 0, "rep": "i32", "dtor": { /* CoreDef? */ },
      "instance": 0 }
  ],

  // CoreDef encoding (wasmtime_environ::component::CoreDef, tag-for-tag):
  //   { "kind": "export", "instance": n, "item": {…} }      core instance export
  //   { "kind": "instance-flags", "instance": n }           i32 flags global
  //   { "kind": "trampoline", "index": n }                  host trampoline
  //   { "kind": "task-may-block" }                          runtime-managed global
  //   { "kind": "unsafe-intrinsic", "intrinsic": "<symbol>" }
  // The unsafe-intrinsic symbol is wasmtime's stable UnsafeIntrinsic::name()
  // ("context-get-i32-0", …), never the #[repr(u32)] ordinal (unstable
  // internal). All 21 variants are wire-representable. Executor obligation:
  // implement context-{get,set}-i32-{0,1} as canonical context.{get,set}
  // over per-thread storage (definitions.py Thread.storage); refuse the 17
  // raw-host-memory symbols at instantiate time.
  //
  // CoreExport.item encoding (pinned): wasmtime's ExportItem is
  // Index(EntityIndex) | Name(String); a JS embedder can only address core
  // exports by *name*, so the shim resolves Index via Module::exports
  // inversion and always emits:
  //   { "name": "…", "space": "func" | "table" | "memory" | "global" | "tag" }

  // Host trampolines (ComponentTranslation::trampolines), one per
  // wasmtime_environ::component::Trampoline variant. Executors must fail
  // loudly (at *instantiate* time, not call time) on unimplemented kinds —
  // see the capability carve-out under "Executor obligations". Full kind
  // list: see intrinsics.md §B.
  "trampolines": [
    { "kind": "lower-import", "lowered": 0 /* LoweredIndex */,
      "options": 0 /* -> canonicalOptions */, "type": 0 /* -> types */ },
    { "kind": "resource-drop", "instance": 0, "resource": 0 },
    { "kind": "task-return",
      "results": 0,      // RAW wasmtime TypeTupleIndex — the FACT lookup key
                         // prepare-call passes at runtime
      "resultType": 0,   // interned plan.types index | null (null accepted on
                         // the wire; the producer always emits a tuple — a
                         // no-result task carries the empty tuple)
      "options": 0 }
    // …
  ],
  // The loader builds the raw→interned task-return dictionary and rejects
  // contradictory mappings; the executor runs canon_task_return's
  // result-type check for FACT tasks (structural comparison against the
  // task's declared result type, definitions.py:2395-2396).

  // Canonical options table (Component::options), referenced by index from
  // trampolines and exports. Mirrors wasmtime_environ CanonicalOptions;
  // memory/realloc are flattened from wasmtime's
  // data_model: CanonicalOptionsDataModel::LinearMemory{memory, realloc}
  // (the Gc data model is rejected per descriptor-ir.md):
  "canonicalOptions": [
    { "instance": 0, "stringEncoding": "utf8",   // utf8|utf16|latin1+utf16
      "memory": 0,          // RuntimeMemoryIndex | null
      "realloc": 0,         // RuntimeReallocIndex | null
      "postReturn": null,   // RuntimePostReturnIndex | null
      "callback": null,     // RuntimeCallbackIndex | null
      "async": false, "cancellable": false,
      "coreType": { "params": ["i32","i32"], "results": ["i32"] } }
  ],

  // Component-level type table: descriptor-ir.md ValType/FuncType JSON.
  // Referenced by index from trampolines, imports and exports. Carries two
  // families: ValTypes *and* function types tagged {"kind":"func",
  // "params": [{label,type}], "results": [...], "async": bool} — "func" is
  // not a ValType kind; consumers must discriminate.
  "types": [ /* descriptor IR */ ],

  // Resource tables, referenced by descriptor-IR own/borrow indices.
  // Index space = wasmtime TypeResourceTableIndex.
  "resourceTables": [
    { "kind": "concrete", "resource": 0, "instance": 0 },
    { "kind": "abstract", "id": 0 }
  ],

  // Imported resources, in ResourceIndex order; optional on the wire
  // (absent ⇒ empty). Executor obligation:
  // ResourceIndex = importedResources.length + DefinedResourceIndex.
  "importedResources": [ { "import": 0 /* RuntimeImportIndex */ } ],

  // Stream/future tables: index spaces = wasmtime TypeStreamTableIndex /
  // TypeFutureTableIndex. Stream/future trampolines carry table indices;
  // these sections are what lets a consumer size and lift a copy buffer.
  // Digest-neutral: table sections do not enter the world digest (element
  // types reach it only via function types on the world surface).
  "streamTables":  [ { "element": /* ValType | null */ null, "instance": 0 } ],
  "futureTables":  [ { "element": /* ValType | null */ null, "instance": 0 } ],

  // Error-context tables: index space =
  // wasmtime TypeComponentLocalErrorContextTableIndex, emitted from
  // environ's ComponentTypes.error_context_tables. The
  // error-context-transfer trampoline's srcTable/dstTable resolve through
  // this section via a dedicated errorContextTableInstance(i) accessor —
  // never through resourceTables (loud PlanError on out-of-range, no ?? 0
  // defaults). Digest-neutral.
  "errorContextTables": [ { "instance": 0 } ],

  // World surface. Import names use the component's exact import strings;
  // runtime import indices match wasmtime's RuntimeImportIndex order.
  // Import entries carry "path": string[] — wasmtime's RuntimeImportIndex
  // is (ImportIndex, Vec<String>) walking into instance imports.
  "imports": [ { "name": "…", "kind": "func", "type": 0, "path": [] } ],
  "exports": [
    { "kind": "lifted-func", "name": "greet",
      "coreDef": { /* CoreDef */ }, "options": 0, "type": 0 },
    // A component exporting one of its own embedded core modules
    // (wasmtime Export::ModuleStatic); n indexes plan.modules and names an
    // *embedded* entry by construction (FACT adapters are appended after
    // translation and are never component exports).
    { "kind": "module", "name": "…", "module": 0 }
  ],

  // Legacy shim-emitted digest, retained for wire compatibility; nothing
  // may depend on it. The normative digest is cewd:1 per digest.md,
  // computed by consumers from the plan's types/imports/exports at load
  // time.
  "worldDigest": "sha256:…"
}
```

Notes on specific entries:

- **Type exports index into `resourceTables`, not the `ResourceIndex`
  space.** An export/import entry `{"kind": "type", "resource": n}`
  carries a *resource-table* index (`TypeResourceTableIndex`, the same
  space as descriptor-IR `own`/`borrow`), **not** a `ResourceIndex`.
  Consequence: one resource type can be reachable through several distinct
  table indices — e.g. a type export pointing at table 1 while the
  functions' handles use table 0, both resolving to the same
  `ResourceIndex` via `resourceTables[n].resource`. Consumers keying
  per-resource state must key by the resolved `ResourceIndex`, treating
  table indices as aliases.
- **Module exports**: the executor surfaces the export as the platform's
  compiled-module value — `WebAssembly.Module` in the JS runtime — reusing
  the compilation the instantiation path already performs. Module exports
  are **excluded** from the canonical world digest (digest.md's item rule:
  only functions and resources contribute as export/import *items*; a
  module export is not WIT-expressible and does not affect
  positional-calling ABI shape, so a digest match stays ABI-sound). The
  WIT-shaped conventions facade skips them (the type-export precedent);
  they are available on the raw executor export surface only.
- **`Export::ModuleImport`** (re-export of an *imported* module) is
  rejected at translation with a precise message. No conformance test
  exercises it, and module *imports* have no instantiation story in the
  runtime; lift both together if a consumer ever needs them.
- **Structured error envelope**: translation failures emit
  `{"error": "<message>", "errorDetail": {"phase": "validation" |
  "unsupported" | "internal", "message", "detail"?}}`. `errorDetail` is
  additive (consumers tolerate its absence); only `phase: "validation"`
  may be scored as a correct
  `assert_invalid`/`assert_malformed` verdict. Body-validation failures in
  FACT-generated (non-embedded) modules classify as `internal`, never
  `validation`.
- Runtime instance/memory/realloc **counts are derivable, not carried**;
  executors create state lazily.
- Adapter naming = static-module index; embedded `wasm_module_offset`
  equals slice position (shim-asserted); `NameMap`/`IndexMap` iteration is
  insertion-ordered (determinism holds).

## Determinism

Byte-identical `plan.json` + adapters for identical
`(component bytes, shim build, features)`. JSON emission must use stable key
order and no floats-as-locale. This property is what makes the artifact cache
(docs/architecture.md §10) a pure content-address lookup — treat any
nondeterminism as a bug.

## Executor obligations

- Validate `formatVersion` (strict equality) and fail fast on mismatch.
- Execute `initializers` strictly in order; each op's semantics follow
  wasmtime-environ's documented behavior for the corresponding
  `GlobalInitializer` variant.
- Instantiate-time (not call-time) failure for any trampoline kind,
  intrinsic, or op the executor doesn't support — with one carve-out:
  capability-scoped built-ins whose absence affects only the exports that
  use them (stream / future / error-context) may instantiate successfully
  and fail at first call. That failure must be `PendingCapability`-shaped,
  never a `Trap` (so it can never satisfy a conformance trap assertion).
  Rationale: wit-bindgen guests routinely mix supported callback-ABI
  exports with stream exports; instantiate-time refusal would make
  supported exports unreachable over a capability their code never
  touches.
- Verify the canonical world digest when typed bindings are in play
  (docs/architecture.md §9, digest.md).
- The shim must fail translation with a clear error on any
  wasmtime-environ construct not representable in this format (never
  silently drop).

## Open items

- Resource table details beyond dtor wiring (borrow bookkeeping lives in
  the runtime; revisit when the shim emits resource-rich components).
- `values` section (the component-level value-definition feature): out of
  scope (wasmtime parity, docs/architecture.md §7).
- Imported-module instantiation (`InstantiateModule::Import`) — not
  emitted for our corpus; shim rejects with a clear error until
  implemented.
- The memory-identity half of `canon_task_return`'s options-equality check
  remains a named open gap: `prepare-call.memory` is the adapter's
  second-hand view and wasmtime's own check is one-sided — re-justified at
  the site (intrinsics/fact_calls.ts / async_builtins.ts CONTRACT notes).
