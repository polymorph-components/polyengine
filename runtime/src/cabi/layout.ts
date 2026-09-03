// Alignment and element size (definitions.py `## Alignment`, `## Element
// Size`): byte layout of component values in linear memory.

import { assert_ } from "./trap.ts";
import { ptrSize } from "./memory.ts";
import {
  type CaseType,
  despecialize,
  type DespecializedValType,
  discriminantSize,
  type FieldType,
  type PtrType,
  type ValType,
} from "./types.ts";

export function alignTo(ptr: number, alignment: number): number {
  return Math.ceil(ptr / alignment) * alignment;
}

/**
 * Everything the lift/lower paths need to know about one type's byte layout,
 * computed once and shared (issue #261).
 *
 * Deliberately ONE flat interface rather than a discriminated union of
 * per-kind layouts: every `Layout` then has the same hidden class, so the hot
 * property loads in `load`/`store` stay monomorphic. Fields that do not apply
 * to a kind carry null/0 — please do not "improve" this into a union.
 */
export interface Layout {
  /** The despecialized type (definitions.py `despecialize`). */
  readonly d: DespecializedValType;
  readonly align: number;
  readonly size: number;
  /** record: field i occupies `base + fieldOffsets[i]`; null otherwise. */
  readonly fieldOffsets: readonly number[] | null;
  /** variant: discriminant width, and the offset of the case payload; 0 otherwise. */
  readonly discSize: 0 | 1 | 2 | 4;
  readonly payloadOffset: number;
}

/**
 * Layout memo, keyed on type identity — see the despecialization memo in
 * types.ts for why identity is a sound key.
 *
 * One map PER POINTER WIDTH, because layout is a function of both: `string`,
 * variable-length `list` and the handle types all size off `ptrSize(ptrType)`.
 * A single map keyed on the type alone would return i32 layouts to a memory64
 * instance — silently, and with no corpus coverage to catch it, which is why
 * layout_cache_test.ts pins it explicitly.
 */
const layoutsI32 = new WeakMap<ValType, Layout>();
const layoutsI64 = new WeakMap<ValType, Layout>();

export function layoutOf(t: ValType, ptrType: PtrType): Layout {
  const cache = ptrType === "i32" ? layoutsI32 : layoutsI64;
  const hit = cache.get(t);
  if (hit !== undefined) return hit;
  const l = computeLayout(t, ptrType);
  // Cached only after the computation returns, so a type that trips
  // `elemSizeRecord`'s "empty record" assert keeps tripping it on every call
  // instead of leaving a half-built node behind.
  cache.set(t, l);
  return l;
}

/** Frozen for the same reason the despecialized nodes are: the node is now
 * shared by every caller, and the engine is a better guarantor of that than
 * an audit of today's call sites. */
function mkLayout(
  d: DespecializedValType,
  align: number,
  size: number,
  fieldOffsets: readonly number[] | null = null,
  discSize: 0 | 1 | 2 | 4 = 0,
  payloadOffset = 0,
): Layout {
  // The premise the whole cache rests on: every alignment is a power of two.
  // It is what lets `load`/`store` substitute `ptr % align === 0` for
  // `ptr === alignTo(ptr, align)`, and what lets the retained field/payload
  // offsets be base-relative (the aligned base factors out of `alignTo`).
  // True by induction over `computeLayout` — asserted here so it stays true,
  // once per type rather than per value.
  assert_(
    align > 0 && (align & (align - 1)) === 0,
    "layout alignment must be a power of two",
  );
  return Object.freeze({
    d,
    align,
    size,
    fieldOffsets: fieldOffsets === null ? null : Object.freeze(fieldOffsets),
    discSize,
    payloadOffset,
  });
}

/**
 * definitions.py `alignment` (line 1201) and `elem_size` (line 1259) fused:
 * the two functions switch over the same despecialized kinds, and every hot
 * caller wants both. The compound kinds delegate to the per-kind kernels
 * below, which stay the line-by-line spec mirror.
 */
function computeLayout(t: ValType, ptrType: PtrType): Layout {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
    case "s8":
    case "u8":
      return mkLayout(d, 1, 1);
    case "s16":
    case "u16":
      return mkLayout(d, 2, 2);
    case "s32":
    case "u32":
    case "f32":
    case "char":
      return mkLayout(d, 4, 4);
    case "s64":
    case "u64":
    case "f64":
      return mkLayout(d, 8, 8);
    case "string":
      return mkLayout(d, ptrSize(ptrType), 2 * ptrSize(ptrType));
    case "error-context":
      return mkLayout(d, 4, 4);
    case "list": {
      const len = d.length ?? null;
      return mkLayout(
        d,
        alignmentList(d.element, len, ptrType),
        elemSizeList(d.element, len, ptrType),
      );
    }
    case "record":
      return recordLayout(d, d.fields, ptrType);
    case "variant":
      return variantLayout(d, d.cases, ptrType);
    case "flags":
      return mkLayout(d, alignmentFlags(d.labels), elemSizeFlags(d.labels));
    // `own`/`borrow` are a constant 4 and their `ResourceTypeInfo` is NOT
    // walked: that graph cycles back to live instance state (see the
    // `valTypeEqual` contract note in types.ts).
    case "own":
    case "borrow":
    case "stream":
    case "future":
      return mkLayout(d, 4, 4);
  }
}

/**
 * The field offsets are exactly the intermediate `p` that
 * `elemSizeRecord` computes and discards — the same accumulation, retained
 * rather than re-derived, so the offsets cannot drift from the spec's own
 * arithmetic. Size and alignment still come from the kernels themselves,
 * which remain the single source of truth (and the "empty record" assert).
 *
 * They are BASE-RELATIVE, where the spec realigns a running absolute `p`.
 * The two agree because `load`/`store` have already asserted that the base is
 * aligned to this record's own alignment, which is the max over its fields',
 * and alignments are powers of two: `alignTo(base + p, a) == base +
 * alignTo(p, a)` whenever `a` divides `base`.
 */
function recordLayout(
  d: DespecializedValType,
  fields: FieldType[],
  ptrType: PtrType,
): Layout {
  const offsets: number[] = [];
  let p = 0;
  for (const f of fields) {
    p = alignTo(p, alignment(f.type, ptrType));
    offsets.push(p);
    p += elemSize(f.type, ptrType);
  }
  return mkLayout(
    d,
    alignmentRecord(fields, ptrType),
    elemSizeRecord(fields, ptrType),
    offsets,
  );
}

/**
 * `payloadOffset` is `elemSizeVariant`'s intermediate `s` after it has been
 * aligned up to `maxCaseAlignment` — the offset every case payload sits at.
 * Base-relative for the same reason as the record offsets above: the variant's
 * alignment is at least `maxCaseAlignment`, so the asserted-aligned base
 * factors out of the `alignTo`.
 */
function variantLayout(
  d: DespecializedValType,
  cases: CaseType[],
  ptrType: PtrType,
): Layout {
  const discSize = discriminantSize(cases.length);
  return mkLayout(
    d,
    alignmentVariant(cases, ptrType),
    elemSizeVariant(cases, ptrType),
    null,
    discSize,
    alignTo(discSize, maxCaseAlignment(cases, ptrType)),
  );
}

export function alignment(t: ValType, ptrType: PtrType): number {
  return layoutOf(t, ptrType).align;
}

export function alignmentList(
  elemType: ValType,
  maybeLength: number | null,
  ptrType: PtrType,
): number {
  if (maybeLength !== null) return alignment(elemType, ptrType);
  return ptrSize(ptrType);
}

export function alignmentRecord(fields: FieldType[], ptrType: PtrType): number {
  let a = 1;
  for (const f of fields) a = Math.max(a, alignment(f.type, ptrType));
  return a;
}

export function alignmentVariant(cases: CaseType[], ptrType: PtrType): number {
  // definitions.py takes `alignment(discriminant_type(cases))`; the
  // discriminant is always u8/u16/u32, whose alignment equals its size, so
  // `discriminantSize` is the same number without allocating the PrimType.
  return Math.max(
    discriminantSize(cases.length),
    maxCaseAlignment(cases, ptrType),
  );
}

export function maxCaseAlignment(cases: CaseType[], ptrType: PtrType): number {
  let a = 1;
  for (const c of cases) {
    if (c.type !== null) a = Math.max(a, alignment(c.type, ptrType));
  }
  return a;
}

export function alignmentFlags(labels: string[]): number {
  const n = labels.length;
  assert_(0 < n && n <= 32, "flags label count");
  if (n <= 8) return 1;
  if (n <= 16) return 2;
  return 4;
}

export function elemSize(t: ValType, ptrType: PtrType): number {
  return layoutOf(t, ptrType).size;
}

export function elemSizeList(
  elemType: ValType,
  maybeLength: number | null,
  ptrType: PtrType,
): number {
  if (maybeLength !== null) return maybeLength * elemSize(elemType, ptrType);
  return 2 * ptrSize(ptrType);
}

export function elemSizeRecord(fields: FieldType[], ptrType: PtrType): number {
  let s = 0;
  for (const f of fields) {
    s = alignTo(s, alignment(f.type, ptrType));
    s += elemSize(f.type, ptrType);
  }
  assert_(s > 0, "empty record");
  return alignTo(s, alignmentRecord(fields, ptrType));
}

export function elemSizeVariant(cases: CaseType[], ptrType: PtrType): number {
  // See `alignmentVariant`: size of u8/u16/u32 == `discriminantSize`.
  let s: number = discriminantSize(cases.length);
  s = alignTo(s, maxCaseAlignment(cases, ptrType));
  let cs = 0;
  for (const c of cases) {
    if (c.type !== null) cs = Math.max(cs, elemSize(c.type, ptrType));
  }
  s += cs;
  return alignTo(s, alignmentVariant(cases, ptrType));
}

export function elemSizeFlags(labels: string[]): number {
  const n = labels.length;
  assert_(0 < n && n <= 32, "flags label count");
  if (n <= 8) return 1;
  if (n <= 16) return 2;
  return 4;
}
