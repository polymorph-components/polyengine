// Bulk (TypedArray-backed) list copies for flat element types (issue #67).
//
// The per-element interpreted `load()`/`store()` costs ~13-45 ns/element
// (despecialize + asserts + DataView per element); these helpers replace the
// loop body with one typed-array view per list and a tight per-element pass
// that preserves the interpreted path's EXACT observable semantics:
//
//   * integers: the same `assert_` type-shape texts as `storeInt` (`"int
//     store"`, `"64-bit store requires bigint"`) but, unlike the scalar path
//     in memory.ts (`storeInt`'s range `assert_`s, issue #96), NOT the same
//     range check: this bulk path wraps out-of-range values instead of
//     raising the host-precondition error (`OverflowError` per
//     definitions.py:1568-1569 `int.to_bytes`) that `storeInt` raises. That
//     is a deliberate scalar/bulk posture split, not an oversight:
//       - the whole point of this file (see the perf numbers above) is an
//         allocation-free, branch-minimal per-element loop; an added range
//         check is itself a per-element cost, defeating the purpose;
//       - values reaching this path from a descriptor-driven lower already
//         went through the descriptor layer's own type conversions for the
//         cases that matter in practice (see contracts/descriptor-ir.md);
//         the wrap here is a defense-in-depth gap only for a raw/buggy
//         embedder value, which the scalar path (used for non-bulk-eligible
//         kinds, and reachable directly from embedder code) still catches.
//     A TypedArray element write coerces exactly like the matching DataView
//     setter (wraps mod 2^width), so this is pinned as intentional behavior
//     (see bulk_list_test.ts), not merely undocumented;
//   * floats: the deterministic profile's NaN canonicalization on BOTH
//     directions (float.ts `decodeI32AsFloat` / `encodeFloatAsI32`): every
//     lifted NaN becomes the JS canonical NaN, every stored `number` NaN
//     writes the canonical bit pattern. Non-NaN values round-trip bit-exactly
//     (Float32Array narrowing is the same IEEE round-to-nearest-even as
//     `DataView.setFloat32`);
//   * bool: store normalizes any value by truthiness to 0/1 (`store()`'s
//     `Number(Boolean(v))`), lift maps any nonzero byte to `true`
//     (`convertIntToBool` semantics — it never traps for unsigned bytes).
//
// u8 is NOT here: it has its own, shape-changing fast path (`list<u8>` is
// `Uint8Array` on the host — load.ts/store.ts). char is NOT here: its lift
// validates USVs per element (`convertI32ToChar` traps), which is the cost.
//
// NAMED ASSUMPTION (issue #67): wasm linear memory is little-endian by spec;
// JS TypedArrays follow the PLATFORM's endianness. Every engine polyengine
// targets runs little-endian, but rather than bake that in silently, the
// check below gates the fast paths — on a big-endian platform they decline
// and the callers keep the (endianness-correct) DataView per-element loops.
//
// Alignment: the canonical ABI guarantees list pointers are element-aligned,
// and real guest memories sit at byteOffset 0, so the view construction
// below virtually never declines; a misaligned combination (possible for a
// test MemInst wrapping a subarray) falls back the same way.

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
  C extends { new (b: ArrayBufferLike, o: number, n: number): InstanceType<C>; readonly BYTES_PER_ELEMENT: number },
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
    // Manual preallocated loop: measurably faster than Array.from(view).
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
