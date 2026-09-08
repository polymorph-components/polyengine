// TypedArray-backed list copies for flat element types.
//
// Integers assert the same host type/shape preconditions as storeInt, but wrap
// out-of-range values modulo the element width rather than asserting range.
// This is a scalar/bulk host-precondition difference, not exact equivalence
// for arbitrary raw inputs (contracts/descriptor-ir.md; bulk_list_test.ts).
// Floats canonicalize NaNs in both directions and use the same narrowing as
// DataView stores. Bool stores use truthiness; loads accept any nonzero byte.
//
// u8 is NOT here: it has its own, shape-changing fast path (`list<u8>` is
// `Uint8Array` on the host — load.ts/store.ts). char is NOT here: its lift
// validates USVs per element (`convertI32ToChar` traps), which is the cost.
//
// Wasm memory is little-endian; JS TypedArrays use platform endianness.
// On a big-endian platform numeric views decline and callers use DataView.
//
// Alignment: the canonical ABI guarantees list pointers are element-aligned,
// but a MemInst subarray's backing byteOffset may be misaligned. Those views
// decline too. The bool byte path needs neither endianness nor alignment.

import { assert_ } from "./trap.ts";
import { bytesOf, type MemInst } from "./memory.ts";
import type { ComponentValue } from "./types.ts";
import { CANONICAL_FLOAT32_NAN, CANONICAL_FLOAT64_NAN } from "./float.ts";

export const PLATFORM_LITTLE_ENDIAN: boolean =
  new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;

type IntArrayCtor =
  | Int8ArrayConstructor
  | Uint16ArrayConstructor
  | Int16ArrayConstructor
  | Uint32ArrayConstructor
  | Int32ArrayConstructor;

const INT_CTORS: Record<string, IntArrayCtor> = {
  s8: Int8Array,
  u16: Uint16Array,
  s16: Int16Array,
  u32: Uint32Array,
  s32: Int32Array,
};

const BIG_CTORS: Record<
  string,
  BigUint64ArrayConstructor | BigInt64ArrayConstructor
> = {
  u64: BigUint64Array,
  s64: BigInt64Array,
};

const FLOAT_CTORS: Record<
  string,
  Float32ArrayConstructor | Float64ArrayConstructor
> = {
  f32: Float32Array,
  f64: Float64Array,
};

function viewOf<
  C extends {
    new (b: ArrayBufferLike, o: number, n: number): InstanceType<C>;
    readonly BYTES_PER_ELEMENT: number;
  },
>(ctor: C, mem: MemInst, ptr: number, length: number): InstanceType<C> | null {
  if (!PLATFORM_LITTLE_ENDIAN) return null;
  const byteOffset = mem.bytes.byteOffset + ptr;
  if (byteOffset % ctor.BYTES_PER_ELEMENT !== 0) return null;
  return new ctor(mem.bytes.buffer, byteOffset, length);
}

/**
 * Bulk lift of `length` elements of `kind` at `ptr`. Returns `null` when the
 * kind is not handled here (caller falls back to the per-element loop) —
 * never for a handled kind on a little-endian platform with an aligned view.
 * The caller has already trap-checked alignment and bounds.
 */
export function tryLoadNumericList(
  mem: MemInst,
  ptr: number,
  length: number,
  kind: string,
): ComponentValue[] | null {
  if (kind === "bool") {
    const out = new Array<ComponentValue>(length);
    const bytes = bytesOf(mem, ptr, length); // range assert: defense-in-depth
    for (let i = 0; i < length; i++) out[i] = bytes[i] !== 0;
    return out;
  }
  const intCtor = INT_CTORS[kind];
  if (intCtor !== undefined) {
    const view = viewOf(intCtor, mem, ptr, length);
    if (view === null) return null;
    const out = new Array<ComponentValue>(length);
    for (let i = 0; i < length; i++) out[i] = view[i];
    return out;
  }
  const bigCtor = BIG_CTORS[kind];
  if (bigCtor !== undefined) {
    const view = viewOf(bigCtor, mem, ptr, length);
    if (view === null) return null;
    const out = new Array<ComponentValue>(length);
    for (let i = 0; i < length; i++) out[i] = view[i];
    return out;
  }
  const floatCtor = FLOAT_CTORS[kind];
  if (floatCtor !== undefined) {
    const view = viewOf(floatCtor, mem, ptr, length);
    if (view === null) return null;
    const out = new Array<ComponentValue>(length);
    for (let i = 0; i < length; i++) {
      const v = view[i];
      // decodeI32AsFloat/decodeI64AsFloat: every NaN lifts as the canonical
      // one (the JS NaN literal IS the canonical f64 NaN, and the canonical
      // f32 NaN widens to it exactly).
      out[i] = v === v ? v : NaN;
    }
    return out;
  }
  return null;
}

/**
 * Bulk store of `v` as elements of `kind` at `ptr`. Returns false when not
 * handled (caller falls back). The caller has already trap-checked alignment
 * and bounds.
 */
export function tryStoreNumericList(
  mem: MemInst,
  v: ArrayLike<ComponentValue>,
  ptr: number,
  kind: string,
): boolean {
  const n = v.length;
  if (kind === "bool") {
    const bytes = bytesOf(mem, ptr, n); // range assert: defense-in-depth
    for (let i = 0; i < n; i++) bytes[i] = v[i] ? 1 : 0;
    return true;
  }
  const intCtor = INT_CTORS[kind];
  if (intCtor !== undefined) {
    const view = viewOf(intCtor, mem, ptr, n);
    if (view === null) return false;
    for (let i = 0; i < n; i++) {
      const x = v[i];
      assert_(typeof x === "number" && Number.isInteger(x), "int store");
      view[i] = x as number; // wraps exactly like the DataView setter
    }
    return true;
  }
  const bigCtor = BIG_CTORS[kind];
  if (bigCtor !== undefined) {
    const view = viewOf(bigCtor, mem, ptr, n);
    if (view === null) return false;
    for (let i = 0; i < n; i++) {
      const x = v[i];
      assert_(typeof x === "bigint", "64-bit store requires bigint");
      view[i] = x as bigint; // wraps mod 2^64 like setBigUint64/setBigInt64
    }
    return true;
  }
  const floatCtor = FLOAT_CTORS[kind];
  if (floatCtor !== undefined) {
    const view = viewOf(floatCtor, mem, ptr, n);
    if (view === null) return false;
    const size = floatCtor.BYTES_PER_ELEMENT;
    for (let i = 0; i < n; i++) {
      const x = v[i];
      if (typeof x === "number" && Number.isNaN(x)) {
        // encodeFloatAsI32/encodeFloatAsI64: a number NaN stores the
        // canonical bit pattern, never the engine's.
        if (size === 4) {
          mem.view.setUint32(ptr + i * 4, CANONICAL_FLOAT32_NAN, true);
        } else {
          mem.view.setBigUint64(ptr + i * 8, CANONICAL_FLOAT64_NAN, true);
        }
      } else {
        // Same ToNumber coercion + IEEE narrowing as DataView.setFloat*.
        view[i] = x as number;
      }
    }
    return true;
  }
  return false;
}
