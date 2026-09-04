// Flat lifting (definitions.py `## Flat Lifting`): core values -> component
// values.

import { assert_, NotImplemented, trapIf } from "./trap.ts";
import {
  canonicalizeNan32,
  canonicalizeNan64,
  decodeI32AsFloat,
  decodeI64AsFloat,
} from "./float.ts";
import { convertI32ToChar, loadStringFromRange } from "./strings.ts";
import {
  convertIntToBool,
  loadListFromRange,
  unpackFlagsFromInt,
} from "./load.ts";
import { type LiftLowerContext, requireMemory } from "./context.ts";
import { flattenVariant } from "./flatten.ts";
import { liftBorrow, liftOwn } from "./handles.ts";
import {
  type CaseType,
  type ComponentValue,
  type CoreType,
  type CoreValue,
  despecialize,
  type FieldType,
  type ValType,
} from "./types.ts";
import {
  liftErrorContext,
  liftFuture,
  liftStream,
} from "./async_values.ts";

/** Anything lift can pull core values from (CoreValueIter or the variant
 * coercion iterator). */
export interface ValueIter {
  next(t: CoreType): CoreValue;
}

export class CoreValueIter implements ValueIter {
  i = 0;

  constructor(public values: CoreValue[]) {}

  next(t: CoreType): CoreValue {
    const v = this.values[this.i];
    this.i += 1;
    switch (t) {
      case "i32":
        assert_(
          typeof v === "number" && Number.isInteger(v) && 0 <= v &&
            v < 2 ** 32,
          "expected canonical i32 lane value",
        );
        break;
      case "i64":
        assert_(
          typeof v === "bigint" && 0n <= v && v < 1n << 64n,
          "expected canonical i64 lane value",
        );
        break;
      case "f32":
      case "f64":
        assert_(typeof v === "number", "expected float lane value");
        break;
    }
    return v;
  }

  done(): boolean {
    return this.i === this.values.length;
  }
}

export function liftFlat(
  cx: LiftLowerContext,
  vi: ValueIter,
  t: ValType,
): ComponentValue {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
      return convertIntToBool(vi.next("i32") as number);
    case "u8":
      return liftFlatUnsigned32(vi, 8);
    case "u16":
      return liftFlatUnsigned32(vi, 16);
    case "u32":
      return liftFlatUnsigned32(vi, 32);
    case "u64":
      return liftFlatUnsigned64(vi);
    case "s8":
      return liftFlatSigned32(vi, 8);
    case "s16":
      return liftFlatSigned32(vi, 16);
    case "s32":
      return liftFlatSigned32(vi, 32);
    case "s64":
      return liftFlatSigned64(vi);
    case "f32":
      return canonicalizeNan32(vi.next("f32") as number);
    case "f64":
      return canonicalizeNan64(vi.next("f64") as number);
    case "char":
      return convertI32ToChar(vi.next("i32") as number);
    case "string":
      return liftFlatString(cx, vi);
    case "error-context":
      return liftErrorContext(cx, vi.next("i32") as number) as never;
    case "list":
      return liftFlatList(cx, vi, d.element, d.length ?? null);
    case "record":
      return liftFlatRecord(cx, vi, d.fields);
    case "variant":
      return liftFlatVariant(cx, vi, d.cases);
    case "flags":
      return liftFlatFlags(vi, d.labels);
    case "own":
      return liftOwn(cx, vi.next("i32") as number, d);
    case "borrow":
      return liftBorrow(cx, vi.next("i32") as number, d);
    case "stream":
      return liftStream(cx, vi.next("i32") as number, d) as never;
    case "future":
      return liftFuture(cx, vi.next("i32") as number, d) as never;
  }
}

// definitions.py lift_flat_unsigned/lift_flat_signed, split by core width
// because 32-bit lanes are numbers and 64-bit lanes are bigints.

export function liftFlatUnsigned32(vi: ValueIter, tWidth: number): number {
  const i = vi.next("i32") as number;
  assert_(0 <= i && i < 2 ** 32);
  return i % 2 ** tWidth;
}

export function liftFlatUnsigned64(vi: ValueIter): bigint {
  const i = vi.next("i64") as bigint;
  assert_(0n <= i && i < 1n << 64n);
  return i; // i % 2**64 == i
}

export function liftFlatSigned32(vi: ValueIter, tWidth: number): number {
  const i0 = vi.next("i32") as number;
  assert_(0 <= i0 && i0 < 2 ** 32);
  const i = i0 % 2 ** tWidth;
  if (i >= 2 ** (tWidth - 1)) {
    return i - 2 ** tWidth;
  }
  return i;
}

export function liftFlatSigned64(vi: ValueIter): bigint {
  const i = vi.next("i64") as bigint;
  assert_(0n <= i && i < 1n << 64n);
  if (i >= 1n << 63n) {
    return i - (1n << 64n);
  }
  return i;
}

export function liftFlatString(
  cx: LiftLowerContext,
  vi: ValueIter,
): ComponentValue {
  const ptrType = requireMemory(cx.opts).ptrType();
  const ptr = vi.next(ptrType);
  const packedLength = vi.next(ptrType);
  return loadStringFromRange(cx, ptr, packedLength);
}

export function liftFlatList(
  cx: LiftLowerContext,
  vi: ValueIter,
  elemType: ValType,
  maybeLength: number | null,
): ComponentValue {
  if (maybeLength !== null) {
    const a: ComponentValue[] = [];
    for (let i = 0; i < maybeLength; i++) {
      a.push(liftFlat(cx, vi, elemType));
    }
    // docs/architecture.md §7: list<u8> is a Uint8Array.
    if (despecialize(elemType).kind === "u8") {
      return Uint8Array.from(a as number[]);
    }
    return a;
  }
  const ptrType = requireMemory(cx.opts).ptrType();
  const ptr = vi.next(ptrType);
  const length = vi.next(ptrType);
  return loadListFromRange(cx, ptr, length, elemType);
}

export function liftFlatRecord(
  cx: LiftLowerContext,
  vi: ValueIter,
  fields: FieldType[],
): ComponentValue {
  const record: { [label: string]: ComponentValue } = {};
  for (const f of fields) {
    record[f.label] = liftFlat(cx, vi, f.type);
  }
  return record;
}

export function liftFlatVariant(
  cx: LiftLowerContext,
  vi: ValueIter,
  cases: CaseType[],
): ComponentValue {
  const flatTypes = flattenVariant(cases, cx.opts);
  assert_(flatTypes.shift() === "i32");
  const caseIndex = vi.next("i32") as number;
  trapIf(caseIndex >= cases.length, "invalid variant discriminant");
  const coerceIter: ValueIter = {
    next(want: CoreType): CoreValue {
      const have = flatTypes.shift()!;
      const x = vi.next(have);
      if (have === "i32" && want === "f32") {
        return decodeI32AsFloat(x as number);
      } else if (have === "i64" && want === "i32") {
        return wrapI64ToI32(x as bigint);
      } else if (have === "i64" && want === "f32") {
        return decodeI32AsFloat(wrapI64ToI32(x as bigint));
      } else if (have === "i64" && want === "f64") {
        return decodeI64AsFloat(x as bigint);
      } else {
        assert_(have === want, `lane mismatch ${have} -> ${want}`);
        return x;
      }
    },
  };
  const c = cases[caseIndex];
  let v: ComponentValue;
  if (c.type === null) {
    v = null;
  } else {
    v = liftFlat(cx, coerceIter, c.type);
  }
  for (const have of flatTypes) {
    vi.next(have);
  }
  return { kind: c.label, value: v };
}

export function wrapI64ToI32(i: bigint): number {
  assert_(0n <= i && i < 1n << 64n);
  return Number(i & 0xffffffffn);
}

export function liftFlatFlags(
  vi: ValueIter,
  labels: string[],
): ComponentValue {
  assert_(0 < labels.length && labels.length <= 32);
  const i = vi.next("i32") as number;
  return unpackFlagsFromInt(i, labels);
}
