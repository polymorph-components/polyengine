// Bidirectional value-shape adaptation (contracts/embedder-api.md
// §"Value mapping").
//
// FROM: the runtime's raw boundary, whose shapes are the definitions.py
//       interpreter's — single-key variants (`{ "circle": 1.5 }`), `{some}` /
//       `{none}`, tuple-as-record (`{ "0": …, "1": … }`), `{ok}` / `{error}`
//       (note: the internal despecialization labels result's err case
//       `"error"`, not `"err"` — cabi/types.ts `despecialize`), kebab-case
//       record keys, resource handles as bare reps.
// TO:   the conventions: `{ kind, value? }` for variants and nested results,
//       outermost-option-as-`undefined` with nested boxing, real tuples,
//       camelCase record fields, flags objects, enum strings verbatim,
//       `Uint8Array` for `list<u8>`, class instances for resources,
//       `Stream`/`Future`/`ErrorContext` handles.
//
// The adapter is driven entirely by the plan's `ValType`s — no generated code
// participates, which is what lets the same facade serve an untyped embedder
// and a bindgen-typed one (the design ruling: runtime-driven facade,
// compile-time-only bindgen).

import type {
  CaseType,
  ComponentValue,
  EnumType,
  FlagsType,
  RecordType,
  ValType,
} from "../cabi/types.ts";
import { despecialize } from "../cabi/types.ts";
import { ERROR_CONTEXT, hasBrand } from "@polyengine/protocol";
import { describeCrossCopy } from "./copy.ts";
import { ErrorContext as InternalErrorContext } from "../task/mod.ts";
import { camelCase } from "./casing.ts";
import { NameCollisionError } from "./errors.ts";
import {
  type ElemCodec,
  ErrorContext,
  Future,
  lowerFutureSource,
  lowerStreamSource,
  Stream,
} from "./streams.ts";

/**
 * The parts of adaptation that need instance state: resources (identity
 * mapping, ownership) and the borrow scope of the call in flight.
 * @internal — value-adapter wiring, supplied by the runtime's instance
 * state.
 */
export interface ValueBridge {
  /** A guest handed the host an `own<R>`; the host now owns it. */
  liftOwn(rep: number, t: ValType & { kind: "own" }): unknown;
  /** A guest handed the host a `borrow<R>`, valid only for this call. */
  liftBorrow(
    rep: number,
    t: ValType & { kind: "borrow" },
    scope: BorrowScope,
  ): unknown;
  /** The host is passing an `own<R>` (transfer). */
  lowerOwn(v: unknown, t: ValType & { kind: "own" }): number;
  /** The host is passing a `borrow<R>` (no transfer). */
  lowerBorrow(v: unknown, t: ValType & { kind: "borrow" }): number;
  /**
   * Destroy a LOWERED `own<R>` the guest will never receive (a resource
   * stream element the producer lowered but the reader never took).
   * Runs the resource's destructor — for a host-implemented R the
   * instance's `[Symbol.dispose]`, for a guest-implemented R the guest
   * dtor — exactly as if the guest had taken the handle and dropped it.
   */
  dropOwn(rep: number, t: ValType & { kind: "own" }): void;
}

/**
 * Wrappers materialized for `borrow<R>` arguments of one call. The contract:
 * "instance valid **only during the call** (retention throws)", so the scope
 * invalidates them when the call returns.
 *
 * @internal — the runtime materializes and invalidates these per call; a
 * host never constructs or names one.
 */
export class BorrowScope {
  readonly #invalidate: (() => void)[] = [];

  add(f: () => void): void {
    this.#invalidate.push(f);
  }

  end(): void {
    for (const f of this.#invalidate) f();
    this.#invalidate.length = 0;
  }
}

/** A no-op scope for positions where no borrow can appear. */
export const NO_BORROWS = new BorrowScope();

/**
 * Label sets already checked for camelCase collisions. `ValType` objects are
 * stable for the lifetime of a loaded plan, so this is a one-time cost per
 * record/flags type rather than a per-call one.
 */
const checkedLabels = new WeakSet<object>();

/**
 * Refuse two labels in one scope that camelCase to the same JS name.
 *
 * `read-only` and `readOnly` are distinct WIT labels but one JS property, so
 * one would silently shadow the other at the boundary — values corrupted with
 * no diagnostic anywhere. Contract principle 2: footguns are design defects.
 */
export function checkNoCollisions(
  key: object,
  labels: string[],
  what: string,
): void {
  if (checkedLabels.has(key)) return;
  const seen = new Map<string, string>();
  for (const l of labels) {
    const js = camelCase(l);
    const held = seen.get(js);
    if (held !== undefined) {
      throw new NameCollisionError(
        `${what}: the labels '${held}' and '${l}' both map to the JS name ` +
          `'${js}'. Rename one in the WIT; the conventions layer will not ` +
          `guess which one wins.`,
      );
    }
    seen.set(js, l);
  }
  checkedLabels.add(key);
}

// ---------------------------------------------------------------------------
// Per-type adapter tables
// ---------------------------------------------------------------------------
//
// Everything below is a pure function of the type, so paying for it per
// element is paying for it once per element too many (issue #261). Same
// argument as `checkedLabels` above: `ValType` objects are stable for the
// lifetime of a loaded plan, so a `WeakMap` keyed on the type's identity turns
// a per-call cost into a one-time cost per type, and the table dies with the
// plan. Both directions read the same tables.

interface RecordField {
  /** The WIT label — the key of the internal record object. */
  label: string;
  /** The camelCased JS name — the key of the host object. */
  js: string;
  type: ValType;
  isOption: boolean;
  /** The option's payload type when `isOption`, else null. */
  optionInner: ValType | null;
}

interface RecordTable {
  /** The labels in source order, for `checkNoCollisions`. */
  labels: string[];
  fields: RecordField[];
}

const recordTables = new WeakMap<RecordType, RecordTable>();

function recordTable(t: RecordType): RecordTable {
  const hit = recordTables.get(t);
  if (hit !== undefined) return hit;
  const table: RecordTable = {
    labels: t.fields.map((f) => f.label),
    fields: t.fields.map((f) => ({
      label: f.label,
      js: camelCase(f.label),
      type: f.type,
      isOption: f.type.kind === "option",
      optionInner: f.type.kind === "option" ? f.type.type : null,
    })),
  };
  recordTables.set(t, table);
  return table;
}

/**
 * Label -> case, memoized on the `cases` array. Replaces the linear
 * `t.cases.find(...)` both directions ran per element.
 *
 * **First wins on a duplicated label** — deliberately NOT `caseIndexOf` from
 * cabi/types.ts, which maps a duplicate to -1. The two sites replace scans
 * with different pre-existing behavior (`find` takes the first match; the cabi
 * scan asserted on exactly one), so each keeps its own; merging them would be
 * a behavior change, not a deduplication.
 */
const variantTables = new WeakMap<CaseType[], Map<string, CaseType>>();

function variantTable(cases: CaseType[]): Map<string, CaseType> {
  const hit = variantTables.get(cases);
  if (hit !== undefined) return hit;
  const m = new Map<string, CaseType>();
  for (const c of cases) if (!m.has(c.label)) m.set(c.label, c);
  variantTables.set(cases, m);
  return m;
}

/** The enum's labels as a set, replacing `t.labels.includes(v)`. */
const enumTables = new WeakMap<EnumType, Set<string>>();

function enumTable(t: EnumType): Set<string> {
  const hit = enumTables.get(t);
  if (hit !== undefined) return hit;
  const s = new Set(t.labels);
  enumTables.set(t, s);
  return s;
}

/** Flags labels paired with their JS names, in source order. */
const flagsTables = new WeakMap<FlagsType, { label: string; js: string }[]>();

function flagsTable(t: FlagsType): { label: string; js: string }[] {
  const hit = flagsTables.get(t);
  if (hit !== undefined) return hit;
  const table = t.labels.map((label) => ({ label, js: camelCase(label) }));
  flagsTables.set(t, table);
  return table;
}

/** @internal — value-adapter wiring. */
export interface AdapterOptions {
  bridge: ValueBridge;
  /** Names the site in error messages (`import 'wasi:x/y'.f`, param 2). */
  where: string;
}

// ---------------------------------------------------------------------------
// internal -> conventions
// ---------------------------------------------------------------------------

/**
 * Adapt one lifted value to its conventions shape.
 *
 * `inOption` implements the contract's option rule: the *outermost* option in
 * a chain maps to `T | undefined`; an option nested **directly inside another
 * option** boxes as `{ kind: "some", value } | { kind: "none" }`. Only option maps
 * to `undefined`, so this is the only ambiguity, and the flag is set only when
 * descending through an option's payload — every other constructor resets it.
 * @internal — value-adapter internals; the facade adapts values at the
 * boundary.
 */
export function toHost(
  v: ComponentValue,
  t: ValType,
  o: AdapterOptions,
  scope: BorrowScope = NO_BORROWS,
  inOption = false,
): unknown {
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
      return v;
    case "error-context":
      return new ErrorContext(v as unknown as InternalErrorContext);
    case "list": {
      const elem = despecialize(t.element);
      if (elem.kind === "u8") {
        // Already a Uint8Array from the raw boundary (docs/architecture.md §7); copy defensively
        // only if the interpreter handed back a plain array (fixed-length lists
        // take the Uint8Array path too, but be tolerant).
        return v instanceof Uint8Array ? v : Uint8Array.from(v as number[]);
      }
      return (v as ComponentValue[]).map((e) => toHost(e, t.element, o, scope));
    }
    case "record": {
      const table = recordTable(t);
      checkNoCollisions(t, table.labels, `${o.where}: record`);
      const src = v as Record<string, ComponentValue>;
      const out: Record<string, unknown> = {};
      for (const f of table.fields) {
        // "fields of option type are optional properties (`field?: T`)": a
        // `none` field is *absent*, not `undefined`-valued, so the object has
        // one canonical shape rather than two indistinguishable ones.
        if (f.isOption) {
          const inner = src[f.label] as Record<string, ComponentValue>;
          if ("none" in inner) continue;
          out[f.js] = toHost(
            inner["some"],
            f.optionInner!,
            o,
            scope,
            true,
          );
          continue;
        }
        out[f.js] = toHost(src[f.label], f.type, o, scope);
      }
      return out;
    }
    case "tuple": {
      const src = v as Record<string, ComponentValue>;
      return t.elements.map((et, i) => toHost(src[String(i)], et, o, scope));
    }
    case "variant": {
      const [label, payload] = single(v, o);
      const c = variantTable(t.cases).get(label);
      if (c === undefined) {
        throw new TypeError(`${o.where}: unknown variant case '${label}'`);
      }
      return c.type === null
        ? { kind: label }
        : { kind: label, value: toHost(payload, c.type, o, scope) };
    }
    case "enum": {
      // Enum values are data: kebab-case verbatim, never camelCased.
      const [label] = single(v, o);
      return label;
    }
    case "option": {
      const [label, payload] = single(v, o);
      if (inOption) {
        return label === "none"
          ? { kind: "none" }
          : { kind: "some", value: toHost(payload, t.type, o, scope, true) };
      }
      return label === "none"
        ? undefined
        : toHost(payload, t.type, o, scope, true);
    }
    case "result": {
      const [label, payload] = single(v, o);
      // Internal despecialization names the err case "error"; the contract's
      // kind is "err" (cabi/types.ts `despecialize`).
      const kind = label === "error" ? "err" : "ok";
      const ct = label === "error" ? t.error : t.ok;
      return ct === null ? { kind } : { kind, value: toHost(payload, ct, o, scope) };
    }
    case "flags": {
      checkNoCollisions(t, t.labels, `${o.where}: flags`);
      const src = v as Record<string, ComponentValue>;
      const out: Record<string, boolean> = {};
      for (const f of flagsTable(t)) out[f.js] = Boolean(src[f.label]);
      return out;
    }
    case "map": {
      // `map<K,V>` despecializes to `list<tuple<K,V>>`; keep that shape.
      return toHost(v, despecialize(t), o, scope);
    }
    case "own":
      return o.bridge.liftOwn(v as number, t);
    case "borrow":
      return o.bridge.liftBorrow(v as number, t, scope);
    case "stream":
      return Stream.fromLifted(v, elemCodec(t.element, o));
    case "future":
      return Future.fromLifted(v, elemCodec(t.element, o));
  }
}

function single(
  v: ComponentValue,
  o: AdapterOptions,
): [string, ComponentValue] {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError(
      `${o.where}: expected a single-key case object, got ${describe(v)}`,
    );
  }
  const keys = Object.keys(v as Record<string, ComponentValue>);
  if (keys.length !== 1) {
    throw new TypeError(
      `${o.where}: expected exactly one case key, got ${keys.length}`,
    );
  }
  return [keys[0], (v as Record<string, ComponentValue>)[keys[0]]];
}

// ---------------------------------------------------------------------------
// conventions -> internal
// ---------------------------------------------------------------------------

/**
 * @internal — value-adapter internals; the facade adapts values at the
 * boundary.
 */
export function fromHost(
  v: unknown,
  t: ValType,
  o: AdapterOptions,
  inOption = false,
): ComponentValue {
  switch (t.kind) {
    case "bool":
      return Boolean(v);
    case "u8":
      return int(v, t.kind, 0, 0xff, o);
    case "u16":
      return int(v, t.kind, 0, 0xffff, o);
    case "u32":
      return int(v, t.kind, 0, 0xffffffff, o);
    case "s8":
      return int(v, t.kind, -0x80, 0x7f, o);
    case "s16":
      return int(v, t.kind, -0x8000, 0x7fff, o);
    case "s32":
      return int(v, t.kind, -0x80000000, 0x7fffffff, o);
    case "u64":
      return big(v, t.kind, 0n, (1n << 64n) - 1n, o);
    case "s64":
      return big(v, t.kind, -(1n << 63n), (1n << 63n) - 1n, o);
    case "f32":
    case "f64":
      if (typeof v !== "number") {
        throw new TypeError(`${o.where}: ${t.kind} expects a number`);
      }
      return v;
    case "char": {
      if (typeof v !== "string" || [...v].length !== 1) {
        throw new TypeError(
          `${o.where}: char expects a single-code-point string`,
        );
      }
      // A lone surrogate has `[...v].length === 1` but is not a Unicode
      // scalar value, so `char` cannot hold it. Reject here, where the site is
      // known: the interpreter's own check reports only "not a valid char".
      const cp = v.codePointAt(0)!;
      if (cp >= 0xd800 && cp <= 0xdfff) {
        throw new TypeError(
          `${o.where}: char expects a Unicode scalar value, got the lone ` +
            `surrogate U+${cp.toString(16).toUpperCase()}`,
        );
      }
      return v;
    }
    case "string":
      if (typeof v !== "string") {
        throw new TypeError(`${o.where}: string expects a string`);
      }
      return v;
    case "error-context": {
      if (v instanceof ErrorContext) {
        return v.internal as unknown as ComponentValue;
      }
      if (v instanceof InternalErrorContext) return v as unknown as ComponentValue;
      // realm boundary (contracts/embedder-api.md §"Error-context is message-valued";
      // issue #131; definitions.py — an error-context's state is exactly
      // its debug message): a branded carrier of a string `message`, from
      // any copy (or hand-rolled), is accepted by minting a FRESH local
      // context — never "the same" one, since there is nothing to alias.
      if (
        hasBrand(v, ERROR_CONTEXT) &&
        typeof (v as { message?: unknown }).message === "string"
      ) {
        return new InternalErrorContext(
          (v as { message: string }).message,
        ) as unknown as ComponentValue;
      }
      // Branded but no string `message` (§"Module identity and @polyengine/protocol", superseded above only
      // for the message-valued case): a genuinely foreign stateful handle —
      // it lives in another copy's handle table, so it can never be lowered
      // here — but "recognized and named" beats the generic "expected an
      // ErrorContext" that sent issue #83 hunting in the wrong direction.
      if (hasBrand(v, ERROR_CONTEXT)) {
        throw new TypeError(
          `${o.where}: ${describeCrossCopy("this error-context")}`,
        );
      }
      throw new TypeError(`${o.where}: expected an ErrorContext`);
    }
    case "list": {
      const elem = despecialize(t.element);
      if (elem.kind === "u8") {
        if (v instanceof Uint8Array) return v;
        if (Array.isArray(v)) return Uint8Array.from(v as number[]);
        throw new TypeError(`${o.where}: list<u8> expects a Uint8Array`);
      }
      if (!Array.isArray(v)) {
        throw new TypeError(`${o.where}: list expects an array`);
      }
      return v.map((e) => fromHost(e, t.element, o));
    }
    case "record": {
      if (v === null || typeof v !== "object") {
        throw new TypeError(`${o.where}: record expects an object`);
      }
      const table = recordTable(t);
      checkNoCollisions(t, table.labels, `${o.where}: record`);
      const src = v as Record<string, unknown>;
      const out: Record<string, ComponentValue> = {};
      for (const f of table.fields) {
        const key = f.js;
        if (f.isOption) {
          // Absent and `undefined` both mean `none` — the two spellings of an
          // optional property.
          const inner = src[key];
          out[f.label] = inner === undefined
            ? { none: null }
            : { some: fromHost(inner, f.optionInner!, o, true) };
          continue;
        }
        if (!(key in src)) {
          throw new TypeError(`${o.where}: record field '${key}' is missing`);
        }
        out[f.label] = fromHost(src[key], f.type, o);
      }
      return out;
    }
    case "tuple": {
      if (!Array.isArray(v) || v.length !== t.elements.length) {
        throw new TypeError(
          `${o.where}: tuple expects an array of ${t.elements.length}`,
        );
      }
      const out: Record<string, ComponentValue> = {};
      t.elements.forEach((et, i) => {
        out[String(i)] = fromHost(v[i], et, o);
      });
      return out;
    }
    case "variant": {
      const { kind, value, has } = tagged(v, o);
      const c = variantTable(t.cases).get(kind);
      if (c === undefined) {
        throw new TypeError(`${o.where}: unknown variant case '${kind}'`);
      }
      if (c.type === null) return { [kind]: null };
      if (!has) {
        throw new TypeError(`${o.where}: variant case '${kind}' needs a 'value'`);
      }
      return { [kind]: fromHost(value, c.type, o) };
    }
    case "enum": {
      if (typeof v !== "string" || !enumTable(t).has(v)) {
        throw new TypeError(
          `${o.where}: enum expects one of ${t.labels.join(" | ")}, got ` +
            describe(v),
        );
      }
      return { [v]: null };
    }
    case "option": {
      if (inOption) {
        const { kind, value, has } = tagged(v, o);
        if (kind === "none") return { none: null };
        if (kind !== "some") {
          throw new TypeError(
            `${o.where}: a nested option must be { kind: "some" | "none" }`,
          );
        }
        return { some: has ? fromHost(value, t.type, o, true) : null };
      }
      return v === undefined
        ? { none: null }
        : { some: fromHost(v, t.type, o, true) };
    }
    case "result": {
      const { kind, value, has } = tagged(v, o);
      if (kind !== "ok" && kind !== "err") {
        throw new TypeError(
          `${o.where}: a result value must be { kind: "ok" | "err" }`,
        );
      }
      const label = kind === "err" ? "error" : "ok";
      const ct = kind === "err" ? t.error : t.ok;
      if (ct === null) return { [label]: null };
      // Symmetric with the variant path above: a case that carries a payload
      // must be given one. Silently lowering `null` would put a zero where the
      // guest expects data.
      if (!has) {
        throw new TypeError(
          `${o.where}: result case '${kind}' carries a payload and needs a 'value'`,
        );
      }
      return { [label]: fromHost(value, ct, o) };
    }
    case "flags": {
      if (v === null || typeof v !== "object") {
        throw new TypeError(`${o.where}: flags expects an object`);
      }
      checkNoCollisions(t, t.labels, `${o.where}: flags`);
      const src = v as Record<string, unknown>;
      const out: Record<string, ComponentValue> = {};
      // "lower: absent = false" — an omitted flag is not an error.
      for (const f of flagsTable(t)) out[f.label] = Boolean(src[f.js]);
      return out;
    }
    case "map":
      return fromHost(v, despecialize(t), o);
    case "own":
      return o.bridge.lowerOwn(v, t);
    case "borrow":
      return o.bridge.lowerBorrow(v, t);
    case "stream":
      // deno-lint-ignore no-explicit-any
      return lowerStreamSource(v as any, elemCodec(t.element, o));
    case "future":
      // deno-lint-ignore no-explicit-any
      return lowerFutureSource(v as any, elemCodec(t.element, o));
  }
}

function tagged(
  v: unknown,
  o: AdapterOptions,
): { kind: string; value: unknown; has: boolean } {
  if (v === null || typeof v !== "object" || !("kind" in v)) {
    throw new TypeError(
      `${o.where}: expected a { kind, value? } value, got ${describe(v)}`,
    );
  }
  const rec = v as { kind: unknown; value?: unknown };
  if (typeof rec.kind !== "string") {
    throw new TypeError(`${o.where}: 'kind' must be a string`);
  }
  return { kind: rec.kind, value: rec.value, has: "value" in rec };
}

function int(
  v: unknown,
  kind: string,
  lo: number,
  hi: number,
  o: AdapterOptions,
): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new TypeError(`${o.where}: ${kind} expects an integer number`);
  }
  if (v < lo || v > hi) {
    throw new TypeError(`${o.where}: ${kind} out of range: ${v}`);
  }
  // The raw boundary takes unsigned lane values for the signed types too?
  // No: cabi `lowerFlatSigned32` does the two's-complement fold, so the
  // interpreter wants the *signed* number here. Pass it through.
  return v;
}

function big(
  v: unknown,
  kind: string,
  lo: bigint,
  hi: bigint,
  o: AdapterOptions,
): bigint {
  if (typeof v !== "bigint") {
    throw new TypeError(`${o.where}: ${kind} expects a bigint`);
  }
  if (v < lo || v > hi) {
    throw new TypeError(`${o.where}: ${kind} out of range: ${v}`);
  }
  return v;
}

/** Per-element codec for a `stream<T>` / `future<T>`. */
function elemCodec(
  element: ValType | null,
  o: AdapterOptions,
): ElemCodec<unknown> {
  return {
    element,
    where: o.where,
    toHost: (v) => element === null ? undefined : toHost(v, element, o),
    fromHost: (v) => element === null ? null : fromHost(v, element, o),
    // resource stream: `own` elements a producer lowered but the reader never took
    // must be destroyed, not leaked — an un-taken element may hold a live
    // platform resource (the tcp `listen` shape: an accepted connection).
    // Top-level `own` is the supported element shape; nested owns inside
    // composite stream elements remain out of scope until a consumer
    // links one.
    release: element !== null && element.kind === "own"
      ? (v) => o.bridge.dropOwn(v as number, element)
      : undefined,
  };
}

export function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "object") return `a ${v.constructor?.name ?? "object"}`;
  return `a ${typeof v} (${String(v)})`;
}
