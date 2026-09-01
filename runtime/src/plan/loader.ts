// Plan loader: formatVersion validation, structural checks, and conversion
// of the wire descriptor IR (contracts/descriptor-ir.md JSON) into the cabi
// in-memory type model (runtime/src/cabi/types.ts, the normative model).
//
// Wire -> in-memory deltas handled here:
//   - `result.err` (wire, per descriptor-ir.md) -> `result.error` (types.ts)
//   - func params `{label, type}[]` (wire) -> unlabeled `ValType[]`
//     (types.ts drops ABI-irrelevant names; labels are preserved separately
//     for bindgen/digest use)
//   - own/borrow `resource: <table index>` (wire) -> `ResourceTypeInfo`
//     identity tokens created per resource table at load time

import {
  type FuncType,
  ResourceTypeInfo,
  type ValType,
} from "../cabi/types.ts";
import type {
  WireEnvelope,
  WireErrorDetail,
  WirePlan,
  WireTrampoline,
  WireTypeDecl,
  WireValType,
} from "./format.ts";

/**
 * Fault in the plan document itself (version/shape/reference errors).
 * @internal
 */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/**
 * A structured translation verdict from the shim (envelope `errorDetail`).
 *
 * Distinguished from `PlanError` on purpose: a `TranslateError` with
 * `phase === "validation"` is *the translator's judgment about the input
 * component* and is the only failure that satisfies `assert_invalid` /
 * `assert_malformed`. `PlanError` and the other phases are failures of our
 * own pipeline and must never be scored as conformance passes.
 * @internal
 */
export class TranslateError extends Error {
  readonly phase: WireErrorDetail["phase"];
  readonly detail: string;

  constructor(d: WireErrorDetail) {
    super(`translator error [${d.phase}]: ${d.message}`);
    this.name = "TranslateError";
    this.phase = d.phase;
    this.detail = d.detail ?? d.message;
  }

  /** True iff the shim judged the *input component* invalid or malformed. */
  get isValidationVerdict(): boolean {
    return this.phase === "validation";
  }
}

/**
 * The single formatVersion this executor understands.
 *
 * v4 (2026-08-17, polyengine#13): `exports[]` gained the `"module"` kind — a
 * component exporting one of its own embedded core modules, surfaced as the
 * already-compiled `WebAssembly.Module`.
 * v3 (2026-08-10, polyengine#89): `errorContextTables` — the index space the
 * `error-context-transfer` trampoline actually uses (it was resolved through
 * the *resource*-table mapping before, a different space) — and
 * `task-return`'s `resultType` / raw `results` split, which lets a FACT
 * callee task carry its declared result type.
 * v2: `streamTables` / `futureTables` — the element types the
 * stream and future built-ins need to size their copy buffers.
 * v1 (contracts/plan-format.md v0.3): `CoreDef` gained `"unsafe-intrinsic"`.
 * The change is purely additive, but the contract's compat rule is a strict
 * equality check ("Validate `formatVersion` and fail fast on mismatch",
 * producer and consumer bumped in the same commit), so v0 plans are refused
 * rather than best-effort accepted — a stale cached artifact must be a loud
 * failure, not a subtly different execution.
 * @internal
 */
export const SUPPORTED_FORMAT_VERSION = 4;

/**
 * A types-table entry after conversion.
 * @internal
 */
export type LoadedType =
  | { kind: "func"; funcType: FuncType; paramNames: string[] }
  | { kind: "value"; type: ValType };

/** @internal */
export interface LoadedPlan {
  wire: WirePlan;
  /** Converted types table, index-aligned with `wire.types`. */
  types: LoadedType[];
  /**
   * Identity tokens for resource tables, index-aligned with
   * `wire.resourceTables`. The executor fills `impl`/`dtor` while running
   * `resource` initializers.
   */
  resourceTokens: ResourceTypeInfo[];
  /**
   * Number of imported resource types. `ResourceIndex =
   * numImportedResources + DefinedResourceIndex`
   * (the `importedResources` field; contracts/plan-format.md schema).
   */
  numImportedResources: number;
  /** Element type per stream table (plan v2); `null` = zero-width payload. */
  streamElems: (ValType | null)[];
  /** Element type per future table (plan v2). */
  futureElems: (ValType | null)[];
  /** Owning component instance per stream/future table (plan v2). */
  streamTableInstances: number[];
  futureTableInstances: number[];
  /**
   * Owning component instance per error-context table (plan v3), index space
   * == `TypeComponentLocalErrorContextTableIndex`.
   */
  errorContextTableInstances: number[];
  /**
   * Raw wasmtime `TypeTupleIndex` -> `plan.types` index, collected from the
   * `task-return` trampolines (plan v3). The key is what FACT's
   * `prepare-call` passes as `task_return_type` at runtime; the value is the
   * interned tuple type. A callee with no `task.return` trampoline of its own
   * (a sync-lifted callee) contributes no entry, and the lookup then reports
   * "unknown" rather than guessing.
   */
  resultTupleTypes: Map<number, number>;
}

/**
 * Validate a plan document and convert its type tables. Fails fast on
 * formatVersion mismatch per contracts/plan-format.md "Executor obligations".
 * @internal
 */
export function loadPlan(wire: WirePlan): LoadedPlan {
  if (wire.formatVersion !== SUPPORTED_FORMAT_VERSION) {
    throw new PlanError(
      `unsupported plan formatVersion ${wire.formatVersion} ` +
        `(this runtime implements v${SUPPORTED_FORMAT_VERSION})`,
    );
  }
  for (
    const required of [
      "modules",
      "initializers",
      "trampolines",
      "canonicalOptions",
      "types",
      "resourceTables",
      // ISSUE #94(2): the shim (crates/translator-shim/src/plan.rs) has no
      // `skip_serializing_if` on `stream_tables`/`future_tables` — a real
      // emitted v2 plan always serializes these as arrays (`[]` when empty,
      // never absent). Requiring presence here keeps the loader consistent
      // with what the producer actually emits, rather than silently
      // tolerating an absent field via `?? []` (which would also mask a
      // genuinely malformed/truncated envelope).
      "streamTables",
      "futureTables",
      // Same reasoning at v3 (the shim has no `skip_serializing_if` on
      // `error_context_tables` either): presence is what the producer
      // guarantees, so absence is a malformed envelope, not an empty table
      // space.
      "errorContextTables",
      "imports",
      "exports",
    ] as const
  ) {
    if (!Array.isArray(wire[required])) {
      throw new PlanError(`plan.${required} missing or not an array`);
    }
  }

  // ISSUE #94(3): deep-schema strictness. `initializers` / `trampolines` /
  // `canonicalOptions` / `CoreDef`s reach `runInitializers` unchecked today;
  // a malformed op object (e.g. `{"op":"instantiate-module"}` missing
  // `args`) dies as a raw `TypeError` deep in the executor rather than a
  // typed `PlanError` here at load time. Proportionate check: a
  // discriminated-union switch per op/trampoline kind verifying required
  // fields are present and primitively typed — not a full JSON-schema
  // engine.
  wire.initializers.forEach((init, i) =>
    validateInitializer(init, `initializers[${i}]`)
  );
  wire.trampolines.forEach((t, i) => validateTrampoline(t, `trampolines[${i}]`));
  wire.canonicalOptions.forEach((o, i) =>
    validateCanonicalOptions(o, `canonicalOptions[${i}]`)
  );
  // plan v3: `errorContextTables` entries are `{ instance }` and nothing
  // else; the executor routes real handle-table lookups through them, so a
  // malformed entry must fail here rather than as an undefined index later.
  wire.errorContextTables.forEach((t, i) => {
    const where = `errorContextTables[${i}]`;
    expect(isRecord(t), where, `must be an object, got ${describeValue(t)}`);
    expectNumber(t as unknown as Record<string, unknown>, "instance", where);
  });
  // ISSUE #187: `modules[]` / `exports[]` / `imports[]` get the same
  // deep-schema treatment as initializers/trampolines/canonicalOptions
  // (#94(3)) — a malformed entry must die here as a typed `PlanError`,
  // never as a raw TypeError in `Executor.buildExport` or (worse) as a
  // silent negative-offset slice of the wrong component bytes in
  // `compileModules` (executor.ts's only guard was an upper-bound check).
  wire.modules.forEach((m, i) => validateModule(m, `modules[${i}]`));
  wire.imports.forEach((imp, i) => validateImport(imp, `imports[${i}]`));
  wire.exports.forEach((exp, i) => validateExport(exp, `exports[${i}]`));

  const importedResources = wire.importedResources ?? [];
  for (const [i, ir] of importedResources.entries()) {
    if (
      typeof ir?.import !== "number" || ir.import < 0 ||
      ir.import >= wire.imports.length
    ) {
      throw new PlanError(
        `importedResources[${i}].import = ${ir?.import} is not a valid ` +
          `index into plan.imports (length ${wire.imports.length})`,
      );
    }
  }

  // Identity tokens: one per RESOURCE, aliased through every table that
  // names it — NOT one per table. plan-format.md "Type exports index into `resourceTables`": "one
  // resource type can be reachable through several distinct table indices …
  // Consumers keying per-resource state must key by `resourceTables[n]
  // .resource`, treating table indices as aliases." Minting per-table broke
  // exactly the way that warning predicts (found by the #18 polymorph-tls
  // smoke): in a wac-composed component the source and destination future
  // tables of a FACT transfer resolve `own<R>` through different table
  // indices, and `valTypeEqual`'s documented reference-identity comparison
  // (cabi/types.ts) saw two tokens for one resource — "future: destination
  // element mismatch" on every resource-bearing element type. wasmtime
  // interns identity at the `ResourceIndex` level and its transfer libcall
  // never re-compares element types at runtime (47.0.3
  // futures_and_streams.rs `guest_transfer`); unifying here restores parity
  // for every structural-equality site at once. Abstract tables keep
  // per-table tokens (no `resource` to key by; none in the current corpus).
  const tokenByResource = new Map<number, ResourceTypeInfo>();
  const resourceTokens = wire.resourceTables.map((table) => {
    if (table.kind !== "concrete") return new ResourceTypeInfo(null, null);
    let token = tokenByResource.get(table.resource);
    if (token === undefined) {
      token = new ResourceTypeInfo(null, null);
      tokenByResource.set(table.resource, token);
    }
    return token;
  });
  const types = wire.types.map((t, i) =>
    loadTypeDecl(t, resourceTokens, `types[${i}]`)
  );
  // plan v3: the `task-return` decls double as the `TypeTupleIndex` ->
  // `plan.types` dictionary (see `LoadedPlan.resultTupleTypes`). Two decls
  // naming the same raw tuple must agree — they are interned from one
  // wasmtime type, so disagreement means a hand-edited/corrupt plan.
  const resultTupleTypes = new Map<number, number>();
  for (const [i, t] of wire.trampolines.entries()) {
    if (t.kind !== "task-return") continue;
    const decl = t as Extract<WireTrampoline, { kind: "task-return" }>;
    if (decl.resultType === null) continue;
    if (decl.resultType < 0 || decl.resultType >= wire.types.length) {
      throw new PlanError(
        `trampolines[${i}].resultType = ${decl.resultType} is not a valid ` +
          `index into plan.types (length ${wire.types.length})`,
      );
    }
    const seen = resultTupleTypes.get(decl.results);
    if (seen !== undefined && seen !== decl.resultType) {
      throw new PlanError(
        `trampolines[${i}]: task-return tuple ${decl.results} maps to both ` +
          `type ${seen} and type ${decl.resultType}`,
      );
    }
    resultTupleTypes.set(decl.results, decl.resultType);
  }
  const elems = (ts: { element: WireValType | null }[] | undefined, what: string) =>
    (ts ?? []).map((t, i) =>
      t.element === null
        ? null
        : loadValType(t.element, resourceTokens, `${what}[${i}].element`)
    );
  return {
    wire,
    types,
    resourceTokens,
    numImportedResources: importedResources.length,
    streamElems: elems(wire.streamTables, "streamTables"),
    futureElems: elems(wire.futureTables, "futureTables"),
    streamTableInstances: wire.streamTables.map((t) => t.instance),
    futureTableInstances: wire.futureTables.map((t) => t.instance),
    errorContextTableInstances: wire.errorContextTables.map((t) => t.instance),
    resultTupleTypes,
  };
}

/**
 * Component-wide `ResourceIndex` for a `DefinedResourceIndex` (the `index`
 * field of a `resource` initializer). Mirrors wasmtime
 * `Component::resource_index` (wasmtime-environ 47.0.3
 * `component/info.rs:222`).
 * @internal
 */
export function resourceIndexOfDefined(
  plan: LoadedPlan,
  definedIndex: number,
): number {
  return plan.numImportedResources + definedIndex;
}

/**
 * Parse the shim's C-ABI JSON envelope into a validated wire plan + adapter
 * bytes. The plan is validated (formatVersion, type tables) but returned in
 * wire form: the executor re-runs `loadPlan` per instantiation so resource
 * identity tokens are fresh per component instance.
 * @internal
 */
export function loadEnvelope(json: string): {
  wire: WirePlan;
  adapters: Map<string, Uint8Array>;
} {
  let envelope: WireEnvelope;
  try {
    envelope = JSON.parse(json) as WireEnvelope;
  } catch (e) {
    throw new PlanError(`envelope is not valid JSON: ${e}`);
  }
  if (envelope.error !== undefined) {
    // v0.1 producers send only `error`; treat the missing structured verdict
    // as "internal" — an unknown phase must never be read as a validation
    // verdict (see TranslateError).
    throw new TranslateError(
      envelope.errorDetail ??
        { phase: "internal", message: envelope.error },
    );
  }
  if (!envelope.plan) throw new PlanError("envelope missing `plan`");
  loadPlan(envelope.plan); // validate early; discard (see docstring)
  const adapters = new Map<string, Uint8Array>();
  for (const a of envelope.adapters ?? []) {
    adapters.set(a.file, base64Decode(a.wasm));
  }
  return { wire: envelope.plan, adapters };
}

function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- ISSUE #94(3): deep-schema validation --------------------------------
//
// Proportionate shape-checking for the wire-format ops the executor runs
// strictly: required-field presence + primitive-type checks per
// discriminated-union arm, mirroring `format.ts`'s tagged unions. Not a
// full JSON-schema validator (no cross-field or index-bounds checks beyond
// what's already done for type/resource tables above) — just enough that
// a malformed op surfaces as a typed `PlanError` here instead of a raw
// `TypeError` mid-execution in the executor.

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function expect(
  cond: boolean,
  where: string,
  what: string,
): asserts cond {
  if (!cond) throw new PlanError(`${where}: ${what}`);
}

function expectNumber(o: Record<string, unknown>, field: string, where: string) {
  expect(
    typeof o[field] === "number",
    where,
    `.${field} must be a number, got ${describeValue(o[field])}`,
  );
}

function expectNumberOrNull(
  o: Record<string, unknown>,
  field: string,
  where: string,
) {
  expect(
    o[field] === null || typeof o[field] === "number",
    where,
    `.${field} must be a number or null, got ${describeValue(o[field])}`,
  );
}

function expectString(o: Record<string, unknown>, field: string, where: string) {
  expect(
    typeof o[field] === "string",
    where,
    `.${field} must be a string, got ${describeValue(o[field])}`,
  );
}

// ISSUE #187: `offset`/`len` reach `Uint8Array.slice` unchecked today; a
// negative or non-integer value is not merely "wrong type" (expectNumber
// would pass NaN and negatives through) but silently slices the *wrong*
// component bytes (`slice(-100, -8)` reads from the tail). Reject anything
// that is not a non-negative safe integer.
function expectNonNegativeInt(
  o: Record<string, unknown>,
  field: string,
  where: string,
) {
  const v = o[field];
  expect(
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
    where,
    `.${field} must be a non-negative safe integer, got ${describeValue(v)}`,
  );
}

function expectBoolean(o: Record<string, unknown>, field: string, where: string) {
  expect(
    typeof o[field] === "boolean",
    where,
    `.${field} must be a boolean, got ${describeValue(o[field])}`,
  );
}

function expectArray(o: Record<string, unknown>, field: string, where: string) {
  expect(
    Array.isArray(o[field]),
    where,
    `.${field} must be an array, got ${describeValue(o[field])}`,
  );
}

function describeValue(v: unknown): string {
  if (v === undefined) return "undefined (missing)";
  if (v === null) return "null";
  if (Array.isArray(v)) return `array (length ${v.length})`;
  if (typeof v === "object") return "object";
  return JSON.stringify(v);
}

const CORE_TYPE_LANES = new Set(["i32", "i64", "f32", "f64"]);

function validateCoreDef(def: unknown, where: string): void {
  expect(isRecord(def), where, `must be an object, got ${describeValue(def)}`);
  const d = def as Record<string, unknown>;
  expectString(d, "kind", where);
  switch (d.kind) {
    case "export":
      expectNumber(d, "instance", where);
      expect(isRecord(d.item), where, `.item must be an object`);
      validateExportItem(d.item, `${where}.item`);
      return;
    case "instance-flags":
      expectNumber(d, "instance", where);
      return;
    case "trampoline":
      expectNumber(d, "index", where);
      return;
    case "unsafe-intrinsic":
      expectString(d, "intrinsic", where);
      return;
    case "task-may-block":
      return;
    default:
      throw new PlanError(`${where}: unknown CoreDef kind ${describeValue(d.kind)}`);
  }
}

function validateExportItem(item: unknown, where: string): void {
  expect(isRecord(item), where, `must be an object`);
  const it = item as Record<string, unknown>;
  expectString(it, "name", where);
  expect(
    typeof it.space === "string" &&
      ["func", "table", "memory", "global", "tag", "unknown"].includes(
        it.space as string,
      ),
    where,
    `.space must be one of func/table/memory/global/tag/unknown, got ` +
      describeValue(it.space),
  );
}

function validateCoreExport(exp: unknown, where: string): void {
  expect(isRecord(exp), where, `must be an object`);
  const e = exp as Record<string, unknown>;
  expectNumber(e, "instance", where);
  expect(isRecord(e.item), where, `.item must be an object`);
  validateExportItem(e.item, `${where}.item`);
}

function validateInitializer(init: unknown, where: string): void {
  expect(isRecord(init), where, `must be an object, got ${describeValue(init)}`);
  const i = init as Record<string, unknown>;
  expectString(i, "op", where);
  switch (i.op) {
    case "instantiate-module":
      expectNumber(i, "module", where);
      expectNumberOrNull(i, "instance", where);
      expectArray(i, "args", where);
      (i.args as unknown[]).forEach((a, idx) =>
        validateCoreDef(a, `${where}.args[${idx}]`)
      );
      return;
    case "lower-import":
      expectNumber(i, "index", where);
      expectNumber(i, "import", where);
      return;
    case "extract-memory":
      expectNumber(i, "index", where);
      validateCoreExport(i.export, `${where}.export`);
      return;
    case "extract-realloc":
    case "extract-callback":
    case "extract-post-return":
      expectNumber(i, "index", where);
      validateCoreDef(i.def, `${where}.def`);
      return;
    case "extract-table":
      expectNumber(i, "index", where);
      validateCoreExport(i.export, `${where}.export`);
      return;
    case "resource":
      expectNumber(i, "index", where);
      expect(
        typeof i.rep === "string" && CORE_TYPE_LANES.has(i.rep as string),
        where,
        `.rep must be one of i32/i64/f32/f64, got ${describeValue(i.rep)}`,
      );
      expect(
        i.dtor === null || isRecord(i.dtor),
        where,
        `.dtor must be a CoreDef object or null`,
      );
      if (i.dtor !== null) validateCoreDef(i.dtor, `${where}.dtor`);
      expectNumber(i, "instance", where);
      return;
    default:
      throw new PlanError(`${where}: unknown initializer op ${describeValue(i.op)}`);
  }
}

// Trampoline kinds with precise wire shapes (format.ts's non-catch-all
// arms). Everything else falls to the `{ kind: string; index: number;
// [field: string]: unknown }` catch-all — milestone-aware unsupported
// kinds the executor rejects at instantiate time (contracts/intrinsics.md
// §B), so only `kind` (string) and `index` (number) are load-time
// invariants for those.
function validateTrampoline(t: unknown, where: string): void {
  expect(isRecord(t), where, `must be an object, got ${describeValue(t)}`);
  const tr = t as Record<string, unknown>;
  expectString(tr, "kind", where);
  expectNumber(tr, "index", where);
  switch (tr.kind) {
    case "lower-import":
      expectNumber(tr, "lowered", where);
      expectNumber(tr, "options", where);
      expectNumber(tr, "type", where);
      return;
    case "trap":
    case "enter-sync-call":
    case "exit-sync-call":
      return;
    case "task-return":
      expectNumber(tr, "instance", where);
      expectNumber(tr, "results", where);
      // plan v3: required, `number | null`.
      expectNumberOrNull(tr, "resultType", where);
      expectNumber(tr, "options", where);
      return;
    case "resource-drop":
    case "resource-new":
    case "resource-rep":
      expectNumber(tr, "instance", where);
      expectNumber(tr, "resource", where);
      return;
    default:
      // Catch-all: unknown/milestone-gated kind, only the common fields
      // above are required.
      return;
  }
}

function validateCanonicalOptions(o: unknown, where: string): void {
  expect(isRecord(o), where, `must be an object, got ${describeValue(o)}`);
  const co = o as Record<string, unknown>;
  expectNumber(co, "instance", where);
  expect(
    typeof co.stringEncoding === "string" &&
      ["utf8", "utf16", "latin1+utf16"].includes(co.stringEncoding as string),
    where,
    `.stringEncoding must be one of utf8/utf16/latin1+utf16, got ` +
      describeValue(co.stringEncoding),
  );
  expectNumberOrNull(co, "memory", where);
  expectNumberOrNull(co, "realloc", where);
  expectNumberOrNull(co, "postReturn", where);
  expectNumberOrNull(co, "callback", where);
  expectBoolean(co, "async", where);
  expectBoolean(co, "cancellable", where);
  expect(isRecord(co.coreType), where, `.coreType must be an object`);
  const ct = co.coreType as Record<string, unknown>;
  expectArray(ct, "params", `${where}.coreType`);
  expectArray(ct, "results", `${where}.coreType`);
  for (const [field, lanes] of [["params", ct.params], ["results", ct.results]] as const) {
    (lanes as unknown[]).forEach((lane, idx) => {
      expect(
        typeof lane === "string" && CORE_TYPE_LANES.has(lane),
        `${where}.coreType.${field}[${idx}]`,
        `must be one of i32/i64/f32/f64, got ${describeValue(lane)}`,
      );
    });
  }
}

// ISSUE #187: `modules[]` — mirrors format.ts's `WireModule` union exactly.
// `embedded`'s `offset`/`len` are the fields the negative-offset walk in
// the issue exploits (executor.ts's only guard was `end > length`, which a
// negative `offset` sails through); `adapter`'s `file`/`len`/`intrinsics`
// are what `compileModules`/intrinsic wiring dereference unchecked
// downstream.
function validateModule(m: unknown, where: string): void {
  expect(isRecord(m), where, `must be an object, got ${describeValue(m)}`);
  const mm = m as Record<string, unknown>;
  expectString(mm, "kind", where);
  switch (mm.kind) {
    case "embedded":
      expectNonNegativeInt(mm, "offset", where);
      expectNonNegativeInt(mm, "len", where);
      return;
    case "adapter":
      expectString(mm, "file", where);
      expectNonNegativeInt(mm, "len", where);
      expectArray(mm, "intrinsics", where);
      (mm.intrinsics as unknown[]).forEach((entry, i) =>
        validateIntrinsicEntry(entry, `${where}.intrinsics[${i}]`)
      );
      return;
    default:
      throw new PlanError(`${where}: unknown module kind ${describeValue(mm.kind)}`);
  }
}

function validateIntrinsicEntry(entry: unknown, where: string): void {
  expect(isRecord(entry), where, `must be an object, got ${describeValue(entry)}`);
  const e = entry as Record<string, unknown>;
  expectString(e, "module", where);
  expectString(e, "name", where);
  expectString(e, "category", where);
  expect(isRecord(e.def), where, `.def must be an object`);
  validateCoreDef(e.def, `${where}.def`);
}

// ISSUE #187: `imports[]` — mirrors format.ts's `WireImport`. `type` is
// optional on the wire (present only for imports that carry an interned
// type-table index), so it is checked only when present.
function validateImport(imp: unknown, where: string): void {
  expect(isRecord(imp), where, `must be an object, got ${describeValue(imp)}`);
  const i = imp as Record<string, unknown>;
  expectString(i, "name", where);
  expectArray(i, "path", where);
  (i.path as unknown[]).forEach((p, idx) => {
    expect(
      typeof p === "string",
      `${where}.path[${idx}]`,
      `must be a string, got ${describeValue(p)}`,
    );
  });
  expectString(i, "kind", where);
  if (i.type !== undefined) expectNumber(i, "type", where);
}

// ISSUE #187: `exports[]` — mirrors format.ts's `WireExport` union,
// recursing into `instance`'s nested `exports[]` (the "each kind's fields
// shape-checked … recursive for nested instance export lists" requirement).
function validateExport(exp: unknown, where: string): void {
  expect(isRecord(exp), where, `must be an object, got ${describeValue(exp)}`);
  const e = exp as Record<string, unknown>;
  expectString(e, "kind", where);
  switch (e.kind) {
    case "lifted-func":
      expectString(e, "name", where);
      expect(isRecord(e.coreDef), where, `.coreDef must be an object`);
      validateCoreDef(e.coreDef, `${where}.coreDef`);
      expectNumber(e, "options", where);
      expectNumber(e, "type", where);
      return;
    case "instance":
      expectString(e, "name", where);
      expectArray(e, "exports", where);
      (e.exports as unknown[]).forEach((nested, i) =>
        validateExport(nested, `${where}.exports[${i}]`)
      );
      return;
    case "type":
      expectString(e, "name", where);
      expect(isRecord(e.type), where, `.type must be an object`);
      validateTypeExport(e.type, `${where}.type`);
      return;
    case "module":
      // The `module` export kind (contracts/plan-format.md schema notes):
      // exported embedded core module.
      expectString(e, "name", where);
      expectNumber(e, "module", where);
      return;
    default:
      throw new PlanError(`${where}: unknown export kind ${describeValue(e.kind)}`);
  }
}

function validateTypeExport(t: unknown, where: string): void {
  expect(isRecord(t), where, `must be an object, got ${describeValue(t)}`);
  const tt = t as Record<string, unknown>;
  expectString(tt, "kind", where);
  switch (tt.kind) {
    case "resource":
      expectNumber(tt, "resource", where);
      return;
    case "value":
      expectNumber(tt, "type", where);
      return;
    default:
      throw new PlanError(`${where}: unknown type-export kind ${describeValue(tt.kind)}`);
  }
}

function loadTypeDecl(
  t: WireTypeDecl,
  resourceTokens: ResourceTypeInfo[],
  where: string,
): LoadedType {
  if (t.kind === "func") {
    const decl = t as Extract<WireTypeDecl, { kind: "func" }>;
    return {
      kind: "func",
      funcType: {
        params: decl.params.map((p) =>
          loadValType(p.type, resourceTokens, `${where}.params.${p.label}`)
        ),
        results: decl.results.map((r, i) =>
          loadValType(r, resourceTokens, `${where}.results[${i}]`)
        ),
        async: decl.async,
      },
      paramNames: decl.params.map((p) => p.label),
    };
  }
  return {
    kind: "value",
    type: loadValType(t as WireValType, resourceTokens, where),
  };
}

/** @internal */
export function loadValType(
  t: WireValType,
  resourceTokens: ResourceTypeInfo[],
  where: string,
): ValType {
  switch (t.kind) {
    case "bool":
    case "s8":
    case "u8":
    case "s16":
    case "u16":
    case "s32":
    case "u32":
    case "s64":
    case "u64":
    case "f32":
    case "f64":
    case "char":
    case "string":
    case "error-context":
      return { kind: t.kind };
    case "list":
      return {
        kind: "list",
        element: loadValType(t.element, resourceTokens, `${where}.element`),
        ...(t.length !== undefined ? { length: t.length } : {}),
      };
    case "record":
      return {
        kind: "record",
        fields: t.fields.map((f) => ({
          label: f.label,
          type: loadValType(f.type, resourceTokens, `${where}.${f.label}`),
        })),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: t.elements.map((e, i) =>
          loadValType(e, resourceTokens, `${where}[${i}]`)
        ),
      };
    case "variant":
      return {
        kind: "variant",
        cases: t.cases.map((c) => ({
          label: c.label,
          type: c.type === null
            ? null
            : loadValType(c.type, resourceTokens, `${where}.${c.label}`),
        })),
      };
    case "enum":
      return { kind: "enum", labels: [...t.labels] };
    case "option":
      return {
        kind: "option",
        type: loadValType(t.type, resourceTokens, `${where}.some`),
      };
    case "result":
      return {
        kind: "result",
        ok: t.ok === null
          ? null
          : loadValType(t.ok, resourceTokens, `${where}.ok`),
        // Wire name is `err` (descriptor-ir.md); in-memory name is `error`
        // (cabi/types.ts).
        error: t.err === null
          ? null
          : loadValType(t.err, resourceTokens, `${where}.err`),
      };
    case "map":
      return {
        kind: "map",
        key: loadValType(t.key, resourceTokens, `${where}.key`),
        value: loadValType(t.value, resourceTokens, `${where}.value`),
      };
    case "flags":
      return { kind: "flags", labels: [...t.labels] };
    case "own":
    case "borrow": {
      const rt = resourceTokens[t.resource];
      if (rt === undefined) {
        throw new PlanError(
          `${where}: ${t.kind} references resource table ${t.resource}, ` +
            `but the plan has ${resourceTokens.length} resource tables`,
        );
      }
      return { kind: t.kind, rt };
    }
    case "stream":
    case "future":
      return {
        kind: t.kind,
        element: t.element === null
          ? null
          : loadValType(t.element, resourceTokens, `${where}.element`),
      };
    default: {
      const exhaustive: never = t;
      throw new PlanError(
        `${where}: unknown ValType kind ${(exhaustive as WireValType).kind}`,
      );
    }
  }
}
