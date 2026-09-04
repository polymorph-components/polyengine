// Flat lowering (definitions.py `## Flat Lowering`): component values ->
// core values.

import { assert_, NotImplemented } from "./trap.ts";
import {
  encodeFloatAsI32,
  encodeFloatAsI64,
  maybeScrambleNan32,
  maybeScrambleNan64,
} from "./float.ts";
import { charToI32, storeStringIntoRange } from "./strings.ts";
import { matchCase, packFlagsIntoInt, storeListIntoRange } from "./store.ts";
import { type LiftLowerContext, requireMemory } from "./context.ts";
import { flattenType, flattenVariant } from "./flatten.ts";
import { lowerBorrow, lowerOwn } from "./handles.ts";
import {
  type CaseType,
  type ComponentValue,
  type CoreValue,
  despecialize,
  type FieldType,
  type ValType,
  type VariantValue,
} from "./types.ts";
import {
  lowerErrorContext,
  lowerFuture,
  lowerStream,
} from "./async_values.ts";

export function lowerFlat(
  cx: LiftLowerContext,
  v: ComponentValue,
  t: ValType,
): CoreValue[] {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
      return [Number(v)];
    case "u8":
    case "u16":
    case "u32":
      return [v as number];
    case "u64":
      return [v as bigint];
    case "s8":
    case "s16":
    case "s32":
      return lowerFlatSigned32(v as number);
    case "s64":
      return lowerFlatSigned64(v as bigint);
    case "f32":
      return [maybeScrambleNan32(v as number)];
    case "f64":
      return [maybeScrambleNan64(v as number)];
    case "char":
      return [charToI32(v as string)];
    case "string":
      return lowerFlatString(cx, v as string);
    case "error-context":
      return [lowerErrorContext(cx, v as never)];
    case "list":
      return lowerFlatList(
        cx,
        v as ArrayLike<ComponentValue>,
        d.element,
        d.length ?? null,
      );
    case "record":
      return lowerFlatRecord(cx, v as Record<string, ComponentValue>, d.fields);
    case "variant":
      return lowerFlatVariant(cx, v as VariantValue, d.cases);
    case "flags":
      return lowerFlatFlags(v as Record<string, ComponentValue>, d.labels);
    case "own":
      return [lowerOwn(cx, v as number, d)];
    case "borrow":
      return [lowerBorrow(cx, v as number, d)];
    case "stream":
      return [lowerStream(cx, v as never, d)];
    case "future":
      return [lowerFuture(cx, v as never, d)];
  }
}

// definitions.py lower_flat_signed, split by core width (number vs bigint).

export function lowerFlatSigned32(i: number): CoreValue[] {
  if (i < 0) {
    return [i + 2 ** 32];
  }
  return [i];
}

export function lowerFlatSigned64(i: bigint): CoreValue[] {
  if (i < 0n) {
    return [i + (1n << 64n)];
  }
  return [i];
}

export function lowerFlatString(
  cx: LiftLowerContext,
  v: string,
): CoreValue[] {
  const [ptr, packedLength] = storeStringIntoRange(cx, v);
  if (requireMemory(cx.opts).ptrType() === "i32") {
    return [ptr, Number(packedLength)];
  }
  return [BigInt(ptr), packedLength];
}

export function lowerFlatList(
  cx: LiftLowerContext,
  v: ArrayLike<ComponentValue>,
  elemType: ValType,
  maybeLength: number | null,
): CoreValue[] {
  if (maybeLength !== null) {
    assert_(maybeLength === v.length, "fixed-length list length mismatch");
    const flat: CoreValue[] = [];
    for (let i = 0; i < v.length; i++) {
      flat.push(...lowerFlat(cx, v[i], elemType));
    }
    return flat;
  }
  const [ptr, length] = storeListIntoRange(cx, v, elemType);
  if (requireMemory(cx.opts).ptrType() === "i32") {
    return [ptr, length];
  }
  return [BigInt(ptr), BigInt(length)];
}

export function lowerFlatRecord(
  cx: LiftLowerContext,
  v: Record<string, ComponentValue>,
  fields: FieldType[],
): CoreValue[] {
  const flat: CoreValue[] = [];
  for (const f of fields) {
    flat.push(...lowerFlat(cx, v[f.label], f.type));
  }
  return flat;
}

export function lowerFlatVariant(
  cx: LiftLowerContext,
  v: VariantValue,
  cases: CaseType[],
): CoreValue[] {
  const [caseIndex, caseValue] = matchCase(v, cases);
  const flatTypes = flattenVariant(cases, cx.opts);
  assert_(flatTypes.shift() === "i32");
  const c = cases[caseIndex];
  let payload: CoreValue[];
  if (c.type === null) {
    payload = [];
  } else {
    payload = lowerFlat(cx, caseValue, c.type);
    const haveTypes = flattenType(c.type, cx.opts);
    for (let i = 0; i < payload.length; i++) {
      const fv = payload[i];
      const have = haveTypes[i];
      const want = flatTypes.shift()!;
      if (have === "f32" && want === "i32") {
        payload[i] = encodeFloatAsI32(fv as number);
      } else if (have === "i32" && want === "i64") {
        payload[i] = BigInt(fv as number);
      } else if (have === "f32" && want === "i64") {
        payload[i] = BigInt(encodeFloatAsI32(fv as number));
      } else if (have === "f64" && want === "i64") {
        payload[i] = encodeFloatAsI64(fv as number);
      } else {
        assert_(have === want, `lane mismatch ${have} -> ${want}`);
      }
    }
  }
  // Pad the remaining lanes of wider cases with zeros of the lane type.
  for (const want of flatTypes) {
    payload.push(want === "i64" ? 0n : 0);
  }
  return [caseIndex, ...payload];
}

export function lowerFlatFlags(
  v: Record<string, ComponentValue>,
  labels: string[],
): CoreValue[] {
  assert_(0 < labels.length && labels.length <= 32);
  return [packFlagsIntoInt(v, labels)];
}
