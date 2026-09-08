// In-memory CABI descriptor model (contracts/descriptor-ir.md).
// The plan loader resolves wire indices into these types and resource identity
// tokens. The lift/lower interpreter follows definitions.py using the raw
// value shapes below; embedder facades translate to their own public shapes.

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
 * Minimal shape of a resource's implementing instance
 * (definitions.py `ResourceType.impl`); instance comparisons use identity.
 */
export interface InstanceLike {
  handles: unknown; // Table — typed loosely here to avoid a cycle; see handles.ts
  mayLeave: boolean;
}

/**
 * definitions.py `ResourceType`: identity + implementing instance + optional
 * destructor. Shared origin identity across component-local resource tables.
 *
 * `dtorHost` is the host-initiated drop entry, wired by exec/executor.ts or
 * lazily by `hostDtorCall` in exec/boundary.ts. It lifts the dtor with a fresh
 * Task/Thread and lets the scheduler finish an unfinished activation. Its
 * undefined-or-Promise return is not a guest-callable core ABI.
 *
 * Guest-initiated drops (`callDtorGated`) lift `dtor` through the same
 * machinery with a fresh synchronous task/thread, the guest caller identity,
 * and no host-wide drive. Any thenable there is a trap.
 */
export class ResourceTypeInfo {
  constructor(
    public impl: InstanceLike | null,
    public dtor: ((rep: number) => void) | null = null,
    public dtorHost: ((rep: number) => unknown) | null = null,
  ) {}
}

/** Component-local handle identity; distinct wire tables never share a wrapper. */
export class ResourceTableInfo {
  constructor(readonly resource: ResourceTypeInfo) {}
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
  rt: ResourceTableInfo;
}
export interface BorrowType {
  kind: "borrow";
  rt: ResourceTableInfo;
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
// Component-level values (raw JS representations, contracts/descriptor-ir.md)
// ---------------------------------------------------------------------------

/**
 * Opaque host token for the async value types.
 *
 * `stream`, `future` and `error-context` do not lift to plain data: the
 * reference's `lift_async_value` yields the
 * *shared* stream/future object itself, because its identity is the value —
 * two components holding ends of one stream must see each other's copies.
 * Concretely these are `SharedStreamImpl`, `SharedFutureImpl` and
 * `ErrorContext` instances (task/streams.ts); they are declared
 * opaquely here to keep `cabi/types.ts` free of a dependency on the task
 * layer. Host code should treat one as a token and pass it back unchanged.
 *
 * This all-optional interface documents intent but does not enforce identity.
 * `lowerStream`/`lowerFuture` in async_values.ts check concrete classes;
 * callers must not treat arbitrary objects as valid tokens.
 */
export interface AsyncValue {
  readonly __asyncValue?: never;
}

/**
 * The internal shape of the whole despecialized variant family — plain
 * `variant`, `enum`, `option`, `result` (error case spelled `"error"`).
 * `value` is always present, `null` for a payload-free case.
 *
 * **Not interchangeable with the host variant shape** despite the matching
 * property names: `contracts/embedder-api.md` §"Implementation strategy"
 * enumerates the three asymmetries (`result`, `enum`, `option`) plus the
 * payload-free spelling. Translate deliberately; never pass one through as
 * the other.
 *
 * Declared as a type alias, not an interface, deliberately: only an alias
 * gets TypeScript's implicit index signature, which is what keeps it
 * assignable to `ComponentValue`'s record arm.
 */
export type VariantValue = {
  kind: string;
  value: ComponentValue;
};

/**
 * Raw values produced by lifting and consumed by lowering, not facade values:
 * bool -> boolean; <=32-bit integers/floats -> number; 64-bit integers -> bigint;
 * char -> one-scalar string; string -> JS string without encoding provenance;
 * list<u8> -> copied Uint8Array; other lists -> arrays;
 * record/flags -> label-keyed object; tuple -> { "0": v0, "1": v1, ... };
 * variant/enum/option/result -> VariantValue (result error kind is "error");
 * own/borrow -> numeric resource rep; async types -> opaque shared tokens.
 * See contracts/embedder-api.md for the distinct facade representations.
 */
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

/**
 * Identity-keyed memo. Input types and all reachable type/field/case arrays
 * must remain immutable: mutating them would leave despecialization and byte
 * layouts inconsistent. `loadValType` builds plan nodes without later writes.
 * Nodes and arrays synthesized here are frozen; existing input nodes returned
 * by the default branch, and child types referenced by new nodes, are not.
 */
const despecializedCache = new WeakMap<ValType, DespecializedValType>();

export function despecialize(t: ValType): DespecializedValType {
  const hit = despecializedCache.get(t);
  if (hit !== undefined) return hit;
  const d = despecializeUncached(t);
  // Cached only after the computation returns: a throwing path must leave no
  // entry behind, or the failure would be reported exactly once.
  despecializedCache.set(t, d);
  return d;
}

/**
 * definitions.py `despecialize`, using the raw variant/record shapes above.
 * Only synthesized nodes are frozen; input nodes are returned unchanged.
 */
function despecializeUncached(t: ValType): DespecializedValType {
  switch (t.kind) {
    case "tuple":
      return Object.freeze({
        kind: "record" as const,
        fields: Object.freeze(
          t.elements.map((e, i) =>
            Object.freeze({ label: String(i), type: e })
          ),
        ) as FieldType[],
      });
    case "enum":
      return Object.freeze({
        kind: "variant" as const,
        cases: Object.freeze(
          t.labels.map((l) => Object.freeze({ label: l, type: null })),
        ) as CaseType[],
      });
    case "option":
      return Object.freeze({
        kind: "variant" as const,
        cases: Object.freeze([
          Object.freeze({ label: "none", type: null }),
          Object.freeze({ label: "some", type: t.type }),
        ]) as CaseType[],
      });
    case "result":
      return Object.freeze({
        kind: "variant" as const,
        cases: Object.freeze([
          Object.freeze({ label: "ok", type: t.ok }),
          Object.freeze({ label: "error", type: t.error }),
        ]) as CaseType[],
      });
    case "map":
      return Object.freeze({
        kind: "list" as const,
        element: despecialize({
          kind: "tuple",
          elements: [t.key, t.value],
        }),
      });
    default:
      return t;
  }
}

// ---------------------------------------------------------------------------
// Discriminants (definitions.py `discriminant_type`)
// ---------------------------------------------------------------------------

/**
 * definitions.py `discriminant_type`: byte width for a nonempty variant with
 * fewer than 2^32 cases. u8/u16/u32 have alignment equal to size, so this
 * also supplies discriminant alignment to the layout code.
 */
export function discriminantSize(caseCount: number): 1 | 2 | 4 {
  const n = caseCount;
  if (!(0 < n && n < 2 ** 32)) throw new Error("assertion failed: case count");
  if (n <= 256) return 1;
  if (n <= 65536) return 2;
  return 4;
}

/**
 * Frozen shared types let flattening reuse the identity-keyed type caches.
 */
const U8: PrimType = Object.freeze({ kind: "u8" });
const U16: PrimType = Object.freeze({ kind: "u16" });
const U32: PrimType = Object.freeze({ kind: "u32" });

/**
 * definitions.py `discriminant_type`. The table itself lives in
 * `discriminantSize`; this is only the width -> type mapping, so the bound
 * check and thresholds exist once. Flattening
 * (`flattenVariant`) and layout (`alignmentVariant`,
 * `elemSizeVariant`) therefore cannot drift apart on the discriminant width.
 */
export function discriminantType(cases: CaseType[]): PrimType {
  switch (discriminantSize(cases.length)) {
    case 1:
      return U8;
    case 2:
      return U16;
    case 4:
      return U32;
  }
}

/**
 * Label -> case index, keyed on immutable case-array identity. Duplicate
 * labels map to -1 so `matchCase` enforces exactly one match, not last-wins.
 */
const caseIndexCache = new WeakMap<CaseType[], ReadonlyMap<string, number>>();

export function caseIndexOf(cases: CaseType[]): ReadonlyMap<string, number> {
  const hit = caseIndexCache.get(cases);
  if (hit !== undefined) return hit;
  const m = new Map<string, number>();
  for (let i = 0; i < cases.length; i++) {
    const label = cases[i].label;
    m.set(label, m.has(label) ? -1 : i);
  }
  caseIndexCache.set(cases, m);
  return m;
}

// ---------------------------------------------------------------------------
// Type predicates (definitions.py `contains_borrow` etc.)
// ---------------------------------------------------------------------------

export function containsBorrow(t: ValType | null): boolean {
  return contains(t, (u) => u.kind === "borrow");
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
 * Structural equality with local resource-table identity by default. Shared
 * async payload compatibility explicitly selects underlying origin identity.
 * Do not serialize or recurse into ResourceTypeInfo: its instance
 * points back to live handle tables and can form cycles.
 */
export function valTypesEqual(a: ValType[], b: ValType[]): boolean {
  return a.length === b.length && a.every((t, i) => valTypeEqual(t, b[i]));
}

export function valTypeEqual(
  a: ValType | null,
  b: ValType | null,
  identity: "local" | "underlying" = "local",
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "list": {
      const bb = b as typeof a;
      return a.length === bb.length &&
        valTypeEqual(a.element, bb.element, identity);
    }
    case "record": {
      const bb = b as typeof a;
      return a.fields.length === bb.fields.length &&
        a.fields.every((f, i) =>
          f.label === bb.fields[i].label &&
          valTypeEqual(f.type, bb.fields[i].type, identity)
        );
    }
    case "tuple": {
      const bb = b as typeof a;
      return a.elements.length === bb.elements.length &&
        a.elements.every((e, i) => valTypeEqual(e, bb.elements[i], identity));
    }
    case "variant": {
      const bb = b as typeof a;
      return a.cases.length === bb.cases.length &&
        a.cases.every((c, i) => {
          const other = bb.cases[i];
          if (c.label !== other.label) return false;
          if (c.type === null || other.type === null) {
            return c.type === other.type;
          }
          return valTypeEqual(c.type, other.type, identity);
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
      return valTypeEqual(a.type, bb.type, identity);
    }
    case "result": {
      const bb = b as typeof a;
      if ((a.ok === null) !== (bb.ok === null)) return false;
      if ((a.error === null) !== (bb.error === null)) return false;
      return (a.ok === null || valTypeEqual(a.ok, bb.ok!, identity)) &&
        (a.error === null || valTypeEqual(a.error, bb.error!, identity));
    }
    case "map": {
      const bb = b as typeof a;
      return valTypeEqual(a.key, bb.key, identity) &&
        valTypeEqual(a.value, bb.value, identity);
    }
    case "own":
    case "borrow": {
      const bb = b as typeof a;
      return identity === "local"
        ? a.rt === bb.rt
        : a.rt.resource === bb.rt.resource;
    }
    case "stream":
    case "future": {
      const bb = b as typeof a;
      if ((a.element === null) !== (bb.element === null)) return false;
      return a.element === null ||
        valTypeEqual(a.element, bb.element!, identity);
    }
    case "error-context":
      return true;
    default:
      // Remaining kinds (primitives) carry no extra fields beyond `kind`.
      return true;
  }
}

/**
 * Diagnostic shape that elides resource identities and their instance cycles.
 * The remaining type structure must be acyclic, as in a loaded plan.
 */
export function fmtValType(t: ValType | null): string {
  if (t === null) return "_";
  switch (t.kind) {
    case "list":
      return t.length === undefined
        ? `list<${fmtValType(t.element)}>`
        : `list<${fmtValType(t.element)}, ${t.length}>`;
    case "record":
      return `record{${
        t.fields.map((f) => `${f.label}: ${fmtValType(f.type)}`).join(", ")
      }}`;
    case "tuple":
      return `tuple<${t.elements.map(fmtValType).join(", ")}>`;
    case "variant":
      return `variant{${
        t.cases.map((c) =>
          c.type === null ? c.label : `${c.label}(${fmtValType(c.type)})`
        )
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
