// Canonical ABI — provisional component value-type model.
//
// This is the v1 sketch of the "CABI descriptor IR" of docs/architecture.md §8: the type
// information the host-boundary lift/lower interpreter walks. It mirrors the
// type classes of the executable spec
// (third_party/component-model/design/mvp/canonical-abi/definitions.py) as a
// TypeScript discriminated union, holding only what lift/lower needs.
//
// PROVISIONAL — expected to change when the translator shim (docs/architecture.md §4.2)
// defines the real plan format. Open questions, tracked in runtime/README.md:
//   - Serialized encoding (this in-memory shape vs the plan's wire format).
//   - Whether labels stay strings or become interned indices in the IR.
//   - Host-facing value representations for tuple/variant/option/result
//     (currently the despecialized definitions.py shapes; bindgen §9 will
//     want arrays / tagged unions / undefined-based options).
//   - Resource types: here an opaque token; the plan will carry resource-type
//     indices + dtor references instead.

/** Core wasm value types, as strings (mirrors definitions.py flat types). */
export type CoreType = "i32" | "i64" | "f32" | "f64";

/** Pointer type of a linear memory: wasm32 or wasm64. */
export type PtrType = "i32" | "i64";

/**
 * A flat core function signature (definitions.py `CoreFuncType`).
 * Equality is structural (see `coreFuncTypeEquals`).
 */
export interface CoreFuncType {
  params: CoreType[];
  results: CoreType[];
}

export function coreFuncTypeEquals(a: CoreFuncType, b: CoreFuncType): boolean {
  return a.params.length === b.params.length &&
    a.results.length === b.results.length &&
    a.params.every((p, i) => p === b.params[i]) &&
    a.results.every((r, i) => r === b.results[i]);
}

/** String encodings selectable by canonical options. */
export type StringEncoding = "utf8" | "utf16" | "latin1+utf16";

/**
 * Opaque token standing in for the implementing component instance of a
 * resource type (definitions.py `ResourceType.impl`). The value interpreter
 * only ever compares these by identity.
 */
export interface InstanceLike {
  handles: unknown; // Table — typed loosely here to avoid a cycle; see handles.ts
  mayLeave: boolean;
}

/**
 * definitions.py `ResourceType`: identity + implementing instance + optional
 * destructor. Compared by object identity everywhere.
 *
 * `dtorHost` is the **host-initiated**-drop entry (#85, reshaped by #160):
 * the dtor built as a fully LIFTED sync function — definitions.py
 * `canon_resource_drop` (line 2319) `inst.store.lift(dtor, ft, opts,
 * rt.impl)` — so the destructor's activation gets a real Task/Thread, the
 * reentrance bracket is released at its first park, and its suspension
 * points are resumable by the scheduler. It is wired by exec/executor.ts
 * (jspi-`promising` entry only when the dtor is suspension-capable, docs §7)
 * and called through `hostDtorCall` (exec/boundary.ts), which also fills it
 * in lazily for tokens built directly. It returns `undefined` or a Promise,
 * so it is NOT callable from inside a guest activation.
 *
 * Guest-initiated drops (`callDtorGated`) always use `dtor` directly: they
 * must complete synchronously (reference lifts the dtor with
 * `async_ = False`), and any thenable there is a trap.
 */
export class ResourceTypeInfo {
  constructor(
    public impl: InstanceLike | null,
    public dtor: ((rep: number) => void) | null = null,
    public dtorHost: ((rep: number) => unknown) | null = null,
  ) {}
}

// ---------------------------------------------------------------------------
// Value types (definitions.py ValType hierarchy)
// ---------------------------------------------------------------------------

export type PrimKind =
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
  | "string";

export interface PrimType {
  kind: PrimKind;
}
export interface ErrorContextType {
  kind: "error-context";
}
export interface ListType {
  kind: "list";
  element: ValType;
  /** Fixed-length list when present (list<t, n>). */
  length?: number;
}
export interface FieldType {
  label: string;
  type: ValType;
}
export interface RecordType {
  kind: "record";
  fields: FieldType[];
}
export interface TupleType {
  kind: "tuple";
  elements: ValType[];
}
export interface CaseType {
  label: string;
  type: ValType | null;
}
export interface VariantType {
  kind: "variant";
  cases: CaseType[];
}
export interface EnumType {
  kind: "enum";
  labels: string[];
}
export interface OptionType {
  kind: "option";
  type: ValType;
}
export interface ResultType {
  kind: "result";
  ok: ValType | null;
  error: ValType | null;
}
export interface MapType {
  kind: "map";
  key: ValType;
  value: ValType;
}
export interface FlagsType {
  kind: "flags";
  labels: string[];
}
export interface OwnType {
  kind: "own";
  rt: ResourceTypeInfo;
}
export interface BorrowType {
  kind: "borrow";
  rt: ResourceTypeInfo;
}
export interface StreamType {
  kind: "stream";
  element: ValType | null;
}
export interface FutureType {
  kind: "future";
  element: ValType | null;
}

export type ValType =
  | PrimType
  | ErrorContextType
  | ListType
  | RecordType
  | TupleType
  | VariantType
  | EnumType
  | OptionType
  | ResultType
  | MapType
  | FlagsType
  | OwnType
  | BorrowType
  | StreamType
  | FutureType;

/**
 * definitions.py `FuncType`, without parameter/result names (names do not
 * affect the ABI; bindings generation reads WIT instead — docs/architecture.md §9).
 * `results` holds zero or one type in current CM, but stays a list to mirror
 * the reference (`FuncType.result`).
 */
export interface FuncType {
  params: ValType[];
  results: ValType[];
  async?: boolean;
}

// ---------------------------------------------------------------------------
// Component-level values (host-side JS representations, docs/architecture.md §7)
// ---------------------------------------------------------------------------

/**
 * Host-side value representation produced by lifting / consumed by lowering:
 *   bool         -> boolean
 *   u8..u32, s8..s32, f32, f64 -> number
 *   u64, s64     -> bigint
 *   char         -> single-code-point string
 *   string       -> string (plain; see README on dropped encoding provenance)
 *   list<u8>     -> Uint8Array (copy; docs/architecture.md §7) — other lists -> Array
 *   record       -> { [fieldLabel]: value }
 *   tuple        -> despecialized record { "0": v0, "1": v1, ... }
 *   variant/enum/option/result -> single-key object { [caseLabel]: payload|null }
 *   flags        -> { [label]: boolean }
 *   own/borrow   -> number (the resource rep at this layer)
 * These mirror definitions.py's Python shapes; final host-facing bindings
 * representations are an open question (README).
 */
/**
 * Opaque host token for the async value types.
 *
 * `stream`, `future` and `error-context` do not lift to plain data: the
 * reference's `lift_async_value` (definitions.py line 1530) yields the
 * *shared* stream/future object itself, because its identity is the value —
 * two components holding ends of one stream must see each other's copies.
 * Concretely these are `SharedStreamImpl`, `SharedFutureImpl` and
 * `ErrorContext` instances (runtime/src/task/streams.ts); they are declared
 * opaquely here to keep `cabi/types.ts` free of a dependency on the task
 * layer. Host code should treat one as a token and pass it back unchanged.
 *
 * LIMITATION: this brand is *structural*, so an all-optional interface admits
 * any object — it documents intent, it does not enforce it. The enforcement is
 * at the lowering sites, which `assert_` on the concrete class before using a
 * value (`lowerStream`/`lowerFuture` in cabi/async_values.ts check
 * `instanceof SharedStreamImpl`/`SharedFutureImpl`). A nominal brand would
 * need a required property, which the real classes could not satisfy without
 * cabi importing the task layer — the cycle this declaration exists to avoid.
 */
export interface AsyncValue {
  readonly __asyncValue?: never;
}

export type ComponentValue =
  | AsyncValue
  | boolean
  | number
  | bigint
  | string
  | null
  | Uint8Array
  | ComponentValue[]
  | { [label: string]: ComponentValue };

/** Core (flat) values: numbers for i32/f32/f64 lanes, bigints for i64 lanes. */
export type CoreValue = number | bigint;

// ---------------------------------------------------------------------------
// Despecialization (definitions.py `despecialize`)
// ---------------------------------------------------------------------------

export type DespecializedValType = Exclude<
  ValType,
  TupleType | EnumType | OptionType | ResultType | MapType
>;

export function despecialize(t: ValType): DespecializedValType {
  switch (t.kind) {
    case "tuple":
      return {
        kind: "record",
        fields: t.elements.map((e, i) => ({ label: String(i), type: e })),
      };
    case "enum":
      return {
        kind: "variant",
        cases: t.labels.map((l) => ({ label: l, type: null })),
      };
    case "option":
      return {
        kind: "variant",
        cases: [{ label: "none", type: null }, { label: "some", type: t.type }],
      };
    case "result":
      return {
        kind: "variant",
        cases: [{ label: "ok", type: t.ok }, { label: "error", type: t.error }],
      };
    case "map":
      return {
        kind: "list",
        element: despecialize({
          kind: "tuple",
          elements: [t.key, t.value],
        }),
      };
    default:
      return t;
  }
}

// ---------------------------------------------------------------------------
// Discriminants (definitions.py `discriminant_type`)
// ---------------------------------------------------------------------------

export function discriminantType(cases: CaseType[]): PrimType {
  const n = cases.length;
  if (!(0 < n && n < 2 ** 32)) throw new Error("assertion failed: case count");
  // mirrors math.ceil(log2(n)/8): 0|1 -> u8, 2 -> u16, 3 -> u32
  if (n <= 256) return { kind: "u8" };
  if (n <= 65536) return { kind: "u16" };
  return { kind: "u32" };
}

// ---------------------------------------------------------------------------
// Type predicates (definitions.py `contains_borrow` etc.)
// ---------------------------------------------------------------------------

export function containsBorrow(t: ValType | null): boolean {
  return contains(t, (u) => u.kind === "borrow");
}

export function containsAsyncValue(t: ValType | null): boolean {
  return contains(t, (u) => u.kind === "stream" || u.kind === "future");
}

export function contains(
  t: ValType | null,
  p: (t: DespecializedValType) => boolean,
): boolean {
  if (t === null) return false;
  const d = despecialize(t);
  switch (d.kind) {
    case "list":
      return p(d) || contains(d.element, p);
    case "stream":
    case "future":
      return p(d) || contains(d.element, p);
    case "record":
      return p(d) || d.fields.some((f) => contains(f.type, p));
    case "variant":
      return p(d) || d.cases.some((c) => contains(c.type, p));
    default:
      return p(d);
  }
}

// ---------------------------------------------------------------------------
// Structural ValType equality and display
// ---------------------------------------------------------------------------

/**
 * Structural `ValType` equality.
 *
 * CONTRACT (bugfix, generalized during the #18 tls smoke): naive
 * `JSON.stringify(a) === JSON.stringify(b)` recurses into `own`/`borrow`'s
 * `ResourceTypeInfo` — a class whose `impl` field is documented "Compared by
 * object identity everywhere" (see `ResourceTypeInfo` above) and which cycles
 * back to the owning instance state (`impl.handles` holds live resource
 * tables that reference their types), so `JSON.stringify` throws
 * `TypeError: Converting circular structure to JSON` on ANY type containing
 * `own<R>`/`borrow<R>` at any depth. First hit by `task.return` result types
 * (polymorph-test's `list<own<test-case>>`), then by stream/future
 * element types (polymorph-tls streams carrying resource-bearing payloads).
 * Object-identity types (`ResourceTypeInfo`) are compared by reference, per
 * the documented invariant.
 */
export function valTypesEqual(a: ValType[], b: ValType[]): boolean {
  return a.length === b.length && a.every((t, i) => valTypeEqual(t, b[i]));
}

export function valTypeEqual(a: ValType, b: ValType): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "list": {
      const bb = b as typeof a;
      return a.length === bb.length && valTypeEqual(a.element, bb.element);
    }
    case "record": {
      const bb = b as typeof a;
      return a.fields.length === bb.fields.length &&
        a.fields.every((f, i) =>
          f.label === bb.fields[i].label && valTypeEqual(f.type, bb.fields[i].type)
        );
    }
    case "tuple": {
      const bb = b as typeof a;
      return a.elements.length === bb.elements.length &&
        a.elements.every((e, i) => valTypeEqual(e, bb.elements[i]));
    }
    case "variant": {
      const bb = b as typeof a;
      return a.cases.length === bb.cases.length &&
        a.cases.every((c, i) => {
          const other = bb.cases[i];
          if (c.label !== other.label) return false;
          if (c.type === null || other.type === null) return c.type === other.type;
          return valTypeEqual(c.type, other.type);
        });
    }
    case "enum":
    case "flags": {
      const bb = b as typeof a;
      return a.labels.length === bb.labels.length &&
        a.labels.every((l, i) => l === bb.labels[i]);
    }
    case "option": {
      const bb = b as typeof a;
      return valTypeEqual(a.type, bb.type);
    }
    case "result": {
      const bb = b as typeof a;
      if ((a.ok === null) !== (bb.ok === null)) return false;
      if ((a.error === null) !== (bb.error === null)) return false;
      return (a.ok === null || valTypeEqual(a.ok, bb.ok!)) &&
        (a.error === null || valTypeEqual(a.error, bb.error!));
    }
    case "map": {
      const bb = b as typeof a;
      return valTypeEqual(a.key, bb.key) && valTypeEqual(a.value, bb.value);
    }
    case "own":
    case "borrow": {
      const bb = b as typeof a;
      // Object-identity type (documented invariant): reference equality only.
      return a.rt === bb.rt;
    }
    case "stream":
    case "future": {
      const bb = b as typeof a;
      if ((a.element === null) !== (bb.element === null)) return false;
      return a.element === null || valTypeEqual(a.element, bb.element!);
    }
    case "error-context":
      return true;
    default:
      // Remaining kinds (primitives) carry no extra fields beyond `kind`.
      return true;
  }
}

/**
 * Cycle-safe display form for diagnostics. `JSON.stringify(t)` is UNSAFE on
 * any resource-bearing type (see `valTypeEqual`'s contract note); this prints
 * the structural shape and elides `ResourceTypeInfo` identities.
 */
export function fmtValType(t: ValType | null): string {
  if (t === null) return "_";
  switch (t.kind) {
    case "list":
      return t.length === undefined
        ? `list<${fmtValType(t.element)}>`
        : `list<${fmtValType(t.element)}, ${t.length}>`;
    case "record":
      return `record{${t.fields.map((f) => `${f.label}: ${fmtValType(f.type)}`).join(", ")}}`;
    case "tuple":
      return `tuple<${t.elements.map(fmtValType).join(", ")}>`;
    case "variant":
      return `variant{${
        t.cases.map((c) => c.type === null ? c.label : `${c.label}(${fmtValType(c.type)})`)
          .join(", ")
      }}`;
    case "enum":
      return `enum{${t.labels.join(", ")}}`;
    case "flags":
      return `flags{${t.labels.join(", ")}}`;
    case "option":
      return `option<${fmtValType(t.type)}>`;
    case "result":
      return `result<${fmtValType(t.ok)}, ${fmtValType(t.error)}>`;
    case "map":
      return `map<${fmtValType(t.key)}, ${fmtValType(t.value)}>`;
    case "own":
    case "borrow":
      return `${t.kind}<resource>`;
    case "stream":
    case "future":
      return `${t.kind}<${fmtValType(t.element)}>`;
    default:
      return t.kind;
  }
}
