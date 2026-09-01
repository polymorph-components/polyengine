// Plan v0 wire format (contracts/plan-format.md) — TypeScript mirror of the
// shim's serde schema (crates/translator-shim/src/plan.rs). Field names and
// shapes must track the Rust side tag-for-tag; the shim is the producer of
// record.

/**
 * Core wasm lane types as emitted in `coreType` and `rep` fields.
 * @internal
 */
export type WireCoreType = "i32" | "i64" | "f32" | "f64";

/** @internal */
export interface WirePlan {
  formatVersion: number;
  producer: {
    shimVersion: string;
    wasmtimeEnviron: string;
    features: string[];
  };
  component: { sha256: string; len: number };
  modules: WireModule[];
  initializers: WireInitializer[];
  trampolines: WireTrampoline[];
  canonicalOptions: WireCanonicalOptions[];
  types: WireTypeDecl[];
  resourceTables: WireResourceTable[];
  /**
   * Stream-table metadata (plan v2), index space == wasmtime's
   * `TypeStreamTableIndex`; referenced by the `streamTable` field of every
   * `stream.*` trampoline. `element` is the `T` of `stream<T>`, `null` for the
   * zero-width payload.
   *
   * ISSUE #94(2): the shim never `skip_serializing_if`s this field
   * (crates/translator-shim/src/plan.rs), so every v2 plan the producer
   * emits carries it (`[]` when empty). Required, not optional: the loader
   * only ever accepts `formatVersion === 2` (strict equality,
   * `SUPPORTED_FORMAT_VERSION`), so there is no live v1-compat path that
   * needs this to be absent.
   */
  streamTables: WireAsyncTable[];
  /** Future-table metadata (plan v2); see `streamTables`. */
  futureTables: WireAsyncTable[];
  /**
   * Error-context-table metadata (plan v3), index space == wasmtime's
   * `TypeComponentLocalErrorContextTableIndex` — the space the
   * `error-context-transfer` trampoline's `srcTable`/`dstTable` *runtime*
   * arguments live in. No element type: wasmtime's `TypeErrorContextTable`
   * is `{ instance }` and nothing else.
   *
   * Required for the same reason as `streamTables`/`futureTables`: the shim
   * always serializes it and the loader accepts only `formatVersion === 3`.
   */
  errorContextTables: WireErrorContextTable[];

  /**
   * Resource types the component imports, in `ResourceIndex` order:
   * `ResourceIndex = importedResources.length + DefinedResourceIndex`
   * (wasmtime `Component::resource_index`).
   *
   * The `importedResources` field (contracts/plan-format.md schema); optional
   * here so plans produced by an older shim still load — absent is read as
   * "no imported resources".
   */
  importedResources?: WireImportedResource[];
  imports: WireImport[];
  exports: WireExport[];
  worldDigest: string;
}

/** @internal */
export type WireModule =
  | { kind: "embedded"; offset: number; len: number }
  | {
    kind: "adapter";
    file: string;
    len: number;
    intrinsics: WireIntrinsicEntry[];
  };

/** @internal */
export interface WireIntrinsicEntry {
  module: string;
  name: string;
  category: string;
  def: WireCoreDef;
}

/** @internal */
export type WireInitializer =
  | {
    op: "instantiate-module";
    module: number;
    instance: number | null;
    args: WireCoreDef[];
  }
  | { op: "lower-import"; index: number; import: number }
  | { op: "extract-memory"; index: number; export: WireCoreExport }
  | { op: "extract-realloc"; index: number; def: WireCoreDef }
  | { op: "extract-callback"; index: number; def: WireCoreDef }
  | { op: "extract-post-return"; index: number; def: WireCoreDef }
  | { op: "extract-table"; index: number; export: WireCoreExport }
  | {
    op: "resource";
    index: number;
    rep: WireCoreType;
    dtor: WireCoreDef | null;
    instance: number;
  };

/** @internal */
export type WireCoreDef =
  | { kind: "export"; instance: number; item: WireExportItem }
  | { kind: "instance-flags"; instance: number }
  | { kind: "trampoline"; index: number }
  /**
   * `CoreDef::UnsafeIntrinsic` (plan v1 / contracts/plan-format.md v0.3).
   * `intrinsic` is wasmtime's stable symbol name
   * (`UnsafeIntrinsic::name()`), not an enum ordinal. The executor
   * materializes `context-{get,set}-i32-{0,1}` as host functions over the
   * current thread's context storage (definitions.py `canon_context_get` /
   * `canon_context_set`, lines 2348/2358) and fails at instantiate time on
   * every other symbol.
   */
  | { kind: "unsafe-intrinsic"; intrinsic: string }
  | { kind: "task-may-block" };

/** @internal */
export interface WireCoreExport {
  instance: number;
  item: WireExportItem;
}

/** @internal */
export interface WireExportItem {
  name: string;
  space: "func" | "table" | "memory" | "global" | "tag" | "unknown";
}

/**
 * Trampoline declarations, tag-for-tag with the wasmtime `Trampoline` enum.
 * Only the variants the executor implements are given precise field types;
 * the rest are matched by `kind` and rejected at instantiate time with
 * capability-aware errors (contracts/intrinsics.md §B).
 * @internal
 */
export type WireTrampoline =
  | {
    kind: "lower-import";
    index: number;
    lowered: number;
    options: number;
    type: number;
  }
  | { kind: "trap"; index: number }
  | { kind: "enter-sync-call"; index: number }
  | { kind: "exit-sync-call"; index: number }
  | {
    kind: "task-return";
    index: number;
    instance: number;
    /**
     * The **raw** wasmtime `TypeTupleIndex` of the task's declared results
     * (plan v3; in v2 this field held the interned `plan.types` index that
     * `resultType` now carries). It is the key FACT's `prepare-call` passes
     * as `task_return_type` at runtime, so it is what lets a FACT callee task
     * find its own declared result type.
     */
    results: number;
    /**
     * `results` interned into `plan.types` as a tuple type (the task-return
     * trampoline's raw `results` key + interned `resultType`;
     * contracts/plan-format.md schema). `null` is accepted on the
     * wire for a task with no declared result type; the current producer
     * never emits it (wasmtime's `TaskReturn.results` is not an `Option` —
     * a no-result task carries the empty tuple).
     */
    resultType: number | null;
    options: number;
  }
  | {
    kind: "resource-drop" | "resource-new" | "resource-rep";
    index: number;
    instance: number;
    resource: number;
  }
  | { kind: string; index: number; [field: string]: unknown };

/** @internal */
export interface WireCanonicalOptions {
  instance: number;
  stringEncoding: "utf8" | "utf16" | "latin1+utf16";
  memory: number | null;
  realloc: number | null;
  postReturn: number | null;
  callback: number | null;
  async: boolean;
  cancellable: boolean;
  coreType: { params: WireCoreType[]; results: WireCoreType[] };
}

/**
 * descriptor-ir.md ValType JSON (nested structurally).
 * @internal
 */
export type WireValType =
  | {
    kind:
      | "bool"
      | "s8"
      | "u8"
      | "s16"
      | "u16"
      | "s32"
      | "u32"
      | "s64"
      | "u64"
      | "f32"
      | "f64"
      | "char"
      | "string"
      | "error-context";
  }
  | { kind: "list"; element: WireValType; length?: number }
  | { kind: "record"; fields: { label: string; type: WireValType }[] }
  | { kind: "tuple"; elements: WireValType[] }
  | { kind: "variant"; cases: { label: string; type: WireValType | null }[] }
  | { kind: "enum"; labels: string[] }
  | { kind: "option"; type: WireValType }
  | { kind: "result"; ok: WireValType | null; err: WireValType | null }
  | { kind: "map"; key: WireValType; value: WireValType }
  | { kind: "flags"; labels: string[] }
  | { kind: "own"; resource: number }
  | { kind: "borrow"; resource: number }
  | { kind: "stream"; element: WireValType | null }
  | { kind: "future"; element: WireValType | null };

/** @internal */
export type WireTypeDecl =
  | {
    kind: "func";
    params: { label: string; type: WireValType }[];
    results: WireValType[];
    async: boolean;
  }
  | WireValType;

/** @internal */
export type WireResourceTable =
  | { kind: "concrete"; resource: number; instance: number }
  | { kind: "abstract"; id: number };

/** One stream or future table (plan v2). */
/**
 * One error-context table: the owning component instance, nothing else.
 * @internal
 */
export interface WireErrorContextTable {
  instance: number;
}

/** @internal */
export interface WireAsyncTable {
  element: WireValType | null;
  instance: number;
}

/**
 * One imported resource type: back-reference into `plan.imports`.
 * @internal
 */
export interface WireImportedResource {
  /** `RuntimeImportIndex` — index into `plan.imports`. */
  import: number;
}

/** @internal */
export interface WireImport {
  name: string;
  path: string[];
  kind: string;
  type?: number;
}

/** @internal */
export type WireExport =
  | {
    kind: "lifted-func";
    name: string;
    coreDef: WireCoreDef;
    options: number;
    type: number;
  }
  | { kind: "instance"; name: string; exports: WireExport[] }
  | { kind: "type"; name: string; type: WireTypeExport }
  /**
   * An exported embedded core module; `module` indexes the static module
   * space (`modules`); the `module` export kind (contracts/plan-format.md
   * schema notes).
   */
  | { kind: "module"; name: string; module: number };

/** @internal */
export type WireTypeExport =
  | { kind: "resource"; resource: number }
  | { kind: "value"; type: number };

/**
 * The shim's C-ABI envelope: plan + adapter artifacts in one JSON document
 * (crates/translator-shim/README.md documents the 1:1 mapping to the
 * contract's artifact set).
 * @internal
 */
export interface WireEnvelope {
  plan?: WirePlan;
  adapters?: { file: string; wasm: string }[];
  /** Failure message (v0.1 shape; unchanged meaning). */
  error?: string;
  /**
   * Structured verdict accompanying `error` (contracts v0.2 proposal). Absent
   * from v0.1 producers; consumers must tolerate that (treat as phase
   * `"internal"`, i.e. "not a statement about the component").
   */
  errorDetail?: WireErrorDetail;
}

/**
 * Structured translation failure.
 *
 * `phase` is the load-bearing field: only `"validation"` means *the component
 * is invalid/malformed* — the verdict the official suite's `assert_invalid` /
 * `assert_malformed` commands require. `"unsupported"` means the component is
 * valid but uses a shape this plan-format version cannot express, and
 * `"internal"` is a shim bug. Neither of the latter two may be scored as a
 * correct rejection.
 * @internal
 */
export interface WireErrorDetail {
  phase: "validation" | "unsupported" | "internal";
  message: string;
  /** Full error chain, diagnostics only. */
  detail?: string;
}
