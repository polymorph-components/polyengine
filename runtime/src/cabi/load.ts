// Loading component values from linear memory (definitions.py `## Loading`).

import { assert_, NotImplemented, trapIf } from "./trap.ts";
import { bytesOf, loadIntS, loadIntU, loadPtr } from "./memory.ts";
import { decodeI32AsFloat, decodeI64AsFloat } from "./float.ts";
import { elemSizeFlags, layoutOf } from "./layout.ts";
import { convertI32ToChar, loadString } from "./strings.ts";
import { type LiftLowerContext, requireMemory } from "./context.ts";
import { tryLoadNumericList } from "./bulk_lists.ts";
import { liftBorrow, liftOwn } from "./handles.ts";
import {
  type CaseType,
  type ComponentValue,
  type FieldType,
  type ValType,
} from "./types.ts";
import {
  liftErrorContext,
  liftFuture,
  liftStream,
} from "./async_values.ts";

export const MAX_LIST_BYTE_LENGTH = (1 << 28) - 1;

export function load(
  cx: LiftLowerContext,
  ptr: number,
  t: ValType,
): ComponentValue {
  const mem = requireMemory(cx.opts);
  // One cached layout node per (type, pointer width) — issue #261; it carries
  // the despecialized type too, so this is the only map lookup on the path.
  const L = layoutOf(t, mem.ptrType());
  // Alignments are always powers of two, so `ptr % align === 0` decides
  // exactly what `ptr === alignTo(ptr, align)` did, without the float divide.
  assert_(ptr % L.align === 0, "load misaligned");
  assert_(ptr + L.size <= mem.length, "load OOB");
  const d = L.d;
  switch (d.kind) {
    case "bool":
      return convertIntToBool(loadIntU(mem, ptr, 1));
    case "u8":
      return loadIntU(mem, ptr, 1);
    case "u16":
      return loadIntU(mem, ptr, 2);
    case "u32":
      return loadIntU(mem, ptr, 4);
    case "u64":
      return loadIntU(mem, ptr, 8);
    case "s8":
      return loadIntS(mem, ptr, 1);
    case "s16":
      return loadIntS(mem, ptr, 2);
    case "s32":
      return loadIntS(mem, ptr, 4);
    case "s64":
      return loadIntS(mem, ptr, 8);
    case "f32":
      return decodeI32AsFloat(loadIntU(mem, ptr, 4));
    case "f64":
      return decodeI64AsFloat(loadIntU(mem, ptr, 8));
    case "char":
      return convertI32ToChar(loadIntU(mem, ptr, 4));
    case "string":
      return loadString(cx, ptr);
    case "error-context":
      return liftErrorContext(cx, loadIntU(cx.opts.memory!, ptr, 4)) as never;
    case "list":
      return loadList(cx, ptr, d.element, d.length ?? null);
    case "record":
      return loadRecord(cx, ptr, d.fields, L.fieldOffsets!);
    case "variant":
      // discSize is 0 only on the kinds that have no discriminant; inside
      // this arm `variantLayout` established it as 1|2|4.
      return loadVariant(
        cx,
        ptr,
        d.cases,
        L.discSize as 1 | 2 | 4,
        L.payloadOffset,
      );
    case "flags":
      return loadFlags(cx, ptr, d.labels);
    case "own":
      return liftOwn(cx, loadIntU(mem, ptr, 4), d);
    case "borrow":
      return liftBorrow(cx, loadIntU(mem, ptr, 4), d);
    case "stream":
      return liftStream(cx, loadIntU(cx.opts.memory!, ptr, 4), d) as never;
    case "future":
      return liftFuture(cx, loadIntU(cx.opts.memory!, ptr, 4), d) as never;
  }
}

export function convertIntToBool(i: number): boolean {
  assert_(i >= 0);
  return Boolean(i);
}

export function loadList(
  cx: LiftLowerContext,
  ptr: number,
  elemType: ValType,
  maybeLength: number | null,
): ComponentValue {
  if (maybeLength !== null) {
    return loadListFromValidRange(cx, ptr, maybeLength, elemType);
  }
  const mem = requireMemory(cx.opts);
  const begin = loadPtr(mem, ptr);
  const length = loadPtr(mem, ptr + mem.ptrSize());
  return loadListFromRange(cx, begin, length, elemType);
}

export function loadListFromRange(
  cx: LiftLowerContext,
  ptr: number | bigint,
  length: number | bigint,
  elemType: ValType,
): ComponentValue {
  const mem = requireMemory(cx.opts);
  const { size, align } = layoutOf(elemType, mem.ptrType());
  const byteLengthBig = BigInt(length) * BigInt(size);
  trapIf(byteLengthBig > BigInt(MAX_LIST_BYTE_LENGTH), "list too long");
  const ptrBig = BigInt(ptr);
  trapIf(ptrBig % BigInt(align) !== 0n, "misaligned list pointer");
  trapIf(ptrBig + byteLengthBig > BigInt(mem.length), "list out of bounds");
  return loadListFromValidRange(cx, Number(ptrBig), Number(length), elemType);
}

export function loadListFromValidRange(
  cx: LiftLowerContext,
  ptr: number,
  length: number,
  elemType: ValType,
): ComponentValue {
  const mem = requireMemory(cx.opts);
  const L = layoutOf(elemType, mem.ptrType());
  const kind = L.d.kind;
  // docs/architecture.md §7: list<u8> lifts to a Uint8Array copy.
  if (kind === "u8") {
    return bytesOf(mem, ptr, length).slice();
  }
  // Other flat element types lift bulk too (issue #67) — same host shapes
  // (number[]/bigint[]/boolean[]), same NaN canonicalization; falls through
  // to the per-element loop for compound types, char (per-element USV
  // validation is the point), and non-little-endian platforms.
  const bulk = tryLoadNumericList(mem, ptr, length, kind);
  if (bulk !== null) return bulk;
  const size = L.size;
  const a: ComponentValue[] = [];
  for (let i = 0; i < length; i++) {
    a.push(load(cx, ptr + i * size, elemType));
  }
  return a;
}

/**
 * `offsets[i]` is field i's byte offset from `ptr`, precomputed on the layout
 * node, so the loop is an indexed read rather than the per-field
 * `alignTo`/`alignment`/`elemSize` recomputation it used to be (issue #261).
 * Taking the offsets rather than the whole `Layout` keeps the function
 * self-consistent: its two arguments are the ones the result depends on, and
 * there is no unchecked "these came from the same type" invariant to violate.
 */
export function loadRecord(
  cx: LiftLowerContext,
  ptr: number,
  fields: FieldType[],
  offsets: readonly number[],
): ComponentValue {
  const record: { [label: string]: ComponentValue } = {};
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    record[field.label] = load(cx, ptr + offsets[i], field.type);
  }
  return record;
}

export function loadVariant(
  cx: LiftLowerContext,
  ptr: number,
  cases: CaseType[],
  discSize: 1 | 2 | 4,
  payloadOffset: number,
): ComponentValue {
  const mem = requireMemory(cx.opts);
  const caseIndex = loadIntU(mem, ptr, discSize);
  trapIf(caseIndex >= cases.length, "invalid variant discriminant");
  const c = cases[caseIndex];
  if (c.type === null) return { kind: c.label, value: null };
  return { kind: c.label, value: load(cx, ptr + payloadOffset, c.type) };
}

export function loadFlags(
  cx: LiftLowerContext,
  ptr: number,
  labels: string[],
): ComponentValue {
  const mem = requireMemory(cx.opts);
  const i = loadIntU(mem, ptr, elemSizeFlags(labels) as 1 | 2 | 4);
  return unpackFlagsFromInt(i, labels);
}

export function unpackFlagsFromInt(
  i: number,
  labels: string[],
): { [label: string]: ComponentValue } {
  const record: { [label: string]: ComponentValue } = {};
  let v = i >>> 0;
  for (const l of labels) {
    record[l] = Boolean(v & 1);
    v = v >>> 1;
  }
  return record;
}
