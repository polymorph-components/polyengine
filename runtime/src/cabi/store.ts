// Storing component values into linear memory (definitions.py `## Storing`).

import { assert_, NotImplemented, trapIf } from "./trap.ts";
import { bytesOf, storeInt, storePtr } from "./memory.ts";
import { tryStoreNumericList } from "./bulk_lists.ts";
import { encodeFloatAsI32, encodeFloatAsI64 } from "./float.ts";
import { alignTo, elemSizeFlags, layoutOf } from "./layout.ts";
import {
  charToI32,
  REALLOC_I32_MAX,
  REALLOC_MISALIGNED,
  REALLOC_OOB,
  storeString,
} from "./strings.ts";
import { type LiftLowerContext, requireMemory } from "./context.ts";
import { lowerBorrow, lowerOwn } from "./handles.ts";
import {
  caseIndexOf,
  type CaseType,
  type ComponentValue,
  type FieldType,
  type ValType,
  type VariantValue,
} from "./types.ts";
import {
  lowerErrorContext,
  lowerFuture,
  lowerStream,
} from "./async_values.ts";

export function store(
  cx: LiftLowerContext,
  v: ComponentValue,
  t: ValType,
  ptr: number,
): void {
  const mem = requireMemory(cx.opts);
  // The load-side mirror: one cached layout node carrying the despecialized
  // type as well (issue #261), and `ptr % align === 0` in place of
  // `ptr === alignTo(ptr, align)` — identical for power-of-two alignments,
  // minus the float divide.
  const L = layoutOf(t, mem.ptrType());
  assert_(ptr % L.align === 0, "store misaligned");
  assert_(ptr + L.size <= mem.length, "store OOB");
  const d = L.d;
  switch (d.kind) {
    case "bool":
      storeInt(mem, Number(Boolean(v)), ptr, 1);
      return;
    case "u8":
      storeInt(mem, v as number, ptr, 1);
      return;
    case "u16":
      storeInt(mem, v as number, ptr, 2);
      return;
    case "u32":
      storeInt(mem, v as number, ptr, 4);
      return;
    case "u64":
      storeInt(mem, v as bigint, ptr, 8);
      return;
    case "s8":
      storeInt(mem, v as number, ptr, 1, true);
      return;
    case "s16":
      storeInt(mem, v as number, ptr, 2, true);
      return;
    case "s32":
      storeInt(mem, v as number, ptr, 4, true);
      return;
    case "s64":
      storeInt(mem, v as bigint, ptr, 8, true);
      return;
    case "f32":
      storeInt(mem, encodeFloatAsI32(v as number), ptr, 4);
      return;
    case "f64":
      storeInt(mem, encodeFloatAsI64(v as number), ptr, 8);
      return;
    case "char":
      storeInt(mem, charToI32(v as string), ptr, 4);
      return;
    case "string":
      storeString(cx, v as string, ptr);
      return;
    case "error-context":
      storeInt(mem, lowerErrorContext(cx, v as never), ptr, 4);
      return;
    case "list":
      storeList(
        cx,
        v as ArrayLike<ComponentValue>,
        ptr,
        d.element,
        d.length ?? null,
      );
      return;
    case "record":
      storeRecord(
        cx,
        v as Record<string, ComponentValue>,
        ptr,
        d.fields,
        L.fieldOffsets!,
      );
      return;
    case "variant":
      storeVariant(
        cx,
        v as VariantValue,
        ptr,
        d.cases,
        // 0 only on the kinds without a discriminant; see loadVariant's note.
        L.discSize as 1 | 2 | 4,
        L.payloadOffset,
      );
      return;
    case "flags":
      storeFlags(cx, v as Record<string, ComponentValue>, ptr, d.labels);
      return;
    case "own":
      storeInt(mem, lowerOwn(cx, v as number, d), ptr, 4);
      return;
    case "borrow":
      storeInt(mem, lowerBorrow(cx, v as number, d), ptr, 4);
      return;
    case "stream":
      storeInt(mem, lowerStream(cx, v as never, d), ptr, 4);
      return;
    case "future":
      storeInt(mem, lowerFuture(cx, v as never, d), ptr, 4);
      return;
  }
}

export function storeList(
  cx: LiftLowerContext,
  v: ArrayLike<ComponentValue>,
  ptr: number,
  elemType: ValType,
  maybeLength: number | null,
): void {
  if (maybeLength !== null) {
    assert_(maybeLength === v.length, "fixed-length list length mismatch");
    storeListIntoValidRange(cx, v, ptr, elemType);
    return;
  }
  const mem = requireMemory(cx.opts);
  const [begin, length] = storeListIntoRange(cx, v, elemType);
  storePtr(mem, begin, ptr);
  storePtr(mem, length, ptr + mem.ptrSize());
}

export function storeListIntoRange(
  cx: LiftLowerContext,
  v: ArrayLike<ComponentValue>,
  elemType: ValType,
): [number, number] {
  const mem = requireMemory(cx.opts);
  const { size, align } = layoutOf(elemType, mem.ptrType());
  const byteLength = v.length * size;
  assert_(byteLength <= REALLOC_I32_MAX);
  const ptr = cx.allocate(align, byteLength);
  trapIf(ptr !== alignTo(ptr, align), REALLOC_MISALIGNED);
  trapIf(ptr + byteLength > mem.length, REALLOC_OOB);
  storeListIntoValidRange(cx, v, ptr, elemType);
  return [ptr, v.length];
}

export function storeListIntoValidRange(
  cx: LiftLowerContext,
  v: ArrayLike<ComponentValue>,
  ptr: number,
  elemType: ValType,
): void {
  const mem = requireMemory(cx.opts);
  const L = layoutOf(elemType, mem.ptrType());
  const kind = L.d.kind;
  // docs/architecture.md §7: list<u8> is Uint8Array-shaped on the host, and
  // both directions are bulk copies — this is the store-side mirror of
  // load.ts `loadListFromValidRange`'s u8 fast path (issue #54: the
  // per-element interpreted store cost ~45 ns/byte, capping async imports
  // returning list<u8> at ~22 MB/s while the lift ran at memcpy speed).
  if (kind === "u8") {
    const dst = bytesOf(mem, ptr, v.length);
    if (v instanceof Uint8Array) {
      dst.set(v);
      return;
    }
    // Plain-array sources (raw-layer embedders) keep the exact per-element
    // semantics of `storeInt(…, 1)`: assert integer-ness, then mask mod 256
    // (a Uint8Array element write and DataView.setUint8 wrap identically).
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      assert_(typeof x === "number" && Number.isInteger(x), "int store");
      dst[i] = x as number;
    }
    return;
  }
  // Other flat element types store bulk too (issue #67), preserving the
  // per-element semantics exactly (same asserts, same wrap, canonical-NaN
  // floats); falls through for compound types, char, and non-little-endian
  // platforms.
  if (tryStoreNumericList(mem, v, ptr, kind)) return;
  const size = L.size;
  for (let i = 0; i < v.length; i++) {
    store(cx, v[i], elemType, ptr + i * size);
  }
}

/** The store-side mirror of `loadRecord`: indexed offset writes, no per-field
 * layout recomputation (issue #261). */
export function storeRecord(
  cx: LiftLowerContext,
  v: Record<string, ComponentValue>,
  ptr: number,
  fields: FieldType[],
  offsets: readonly number[],
): void {
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    store(cx, v[f.label], f.type, ptr + offsets[i]);
  }
}

/** definitions.py match_case, over the `{kind, value}` variant shape. */
export function matchCase(
  v: VariantValue,
  cases: CaseType[],
): [number, ComponentValue] {
  const label = v.kind;
  // `caseIndexOf` is the memoized form of the linear scan this used to run on
  // every variant stored (issue #261); it maps a duplicated label to -1, so
  // the "exactly one match" condition below is unchanged. A missing or
  // non-string `kind` cannot be a key of that Map either, so this one assert
  // covers a malformed value too.
  const i = caseIndexOf(cases).get(label);
  assert_(i !== undefined && i >= 0, `variant case '${label}' not found`);
  return [i as number, v.value];
}

export function storeVariant(
  cx: LiftLowerContext,
  v: VariantValue,
  ptr: number,
  cases: CaseType[],
  discSize: 1 | 2 | 4,
  payloadOffset: number,
): void {
  const mem = requireMemory(cx.opts);
  const [caseIndex, caseValue] = matchCase(v, cases);
  storeInt(mem, caseIndex, ptr, discSize);
  const c = cases[caseIndex];
  if (c.type !== null) {
    store(cx, caseValue, c.type, ptr + payloadOffset);
  }
}

export function storeFlags(
  cx: LiftLowerContext,
  v: Record<string, ComponentValue>,
  ptr: number,
  labels: string[],
): void {
  const mem = requireMemory(cx.opts);
  const i = packFlagsIntoInt(v, labels);
  storeInt(mem, i, ptr, elemSizeFlags(labels) as 1 | 2 | 4);
}

export function packFlagsIntoInt(
  v: Record<string, ComponentValue>,
  labels: string[],
): number {
  let i = 0;
  let shift = 0;
  for (const l of labels) {
    i = (i | ((v[l] ? 1 : 0) << shift)) >>> 0;
    shift += 1;
  }
  return i;
}
