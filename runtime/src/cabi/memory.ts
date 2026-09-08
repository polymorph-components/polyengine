// Linear-memory access (definitions.py `MemInst`, `load_int`, `store_int`,
// `ptr_size`).
//
// A `MemInst` wraps a byte buffer with an address type (wasm32/wasm64). All
// multi-byte accesses are little-endian via DataView. Following docs/architecture.md §7,
// integer lanes/values of width <= 32 are JS numbers and 64-bit values are
// BigInt.
//
// Addresses and sizes are JS numbers throughout: real guest memories are far
// below Number.MAX_SAFE_INTEGER. Values arriving from i64 lanes (memory64)
// are bounds-checked as BigInt before conversion — see `asIndex`.

import { assert_, trapIf } from "./trap.ts";
import type { PtrType } from "./types.ts";

export function ptrSize(ptrType: PtrType): 4 | 8 {
  return ptrType === "i32" ? 4 : 8;
}

/**
 * `MemInst` caches its `Uint8Array`/`DataView` at construction time and never
 * re-derives them. That is only sound for a memory that cannot grow within
 * this instance's lifetime: `memory.grow` (guest-triggered or host-triggered)
 * detaches the backing `ArrayBuffer`, and a cached view over a detached
 * buffer reads/writes garbage rather than trapping.
 *
 * Production call/lift/lower paths do NOT construct `MemInst` directly against
 * a live, growable `WebAssembly.Memory` for this reason: the executor
 * re-derives a fresh view per access via `LiveMemory`
 * (`exec/boundary.ts:97-160`), which is grow-safe. `MemInst` is for contexts
 * where the buffer is known fixed for the duration (tests, or a snapshot
 * already taken).
 */
export class MemInst {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly addrType: PtrType;

  constructor(bytes: Uint8Array, addrType: PtrType) {
    this.bytes = bytes;
    this.view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    this.addrType = addrType;
  }

  get length(): number {
    return this.bytes.length;
  }

  ptrType(): PtrType {
    return this.addrType;
  }

  ptrSize(): 4 | 8 {
    return ptrSize(this.addrType);
  }
}

/**
 * Convert a (possibly BigInt) address/length to a JS number index, after the
 * caller has already trapped on any out-of-bounds condition using exact
 * (BigInt) arithmetic. Asserts rather than traps: by this point the value is
 * known small.
 */
export function asIndex(v: number | bigint): number {
  if (typeof v === "bigint") {
    assert_(v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER), "index overflow");
    return Number(v);
  }
  assert_(Number.isSafeInteger(v) && v >= 0, "index not a safe integer");
  return v;
}

// definitions.py load_int(cx, ptr, nbytes, signed): widths 1/2/4 -> number,
// width 8 -> bigint (docs/architecture.md §7 number/BigInt split).

export function loadIntU(mem: MemInst, ptr: number, nbytes: 1 | 2 | 4): number;
export function loadIntU(mem: MemInst, ptr: number, nbytes: 8): bigint;
export function loadIntU(
  mem: MemInst,
  ptr: number,
  nbytes: 1 | 2 | 4 | 8,
): number | bigint {
  assert_(ptr + nbytes <= mem.length, "load out of bounds");
  switch (nbytes) {
    case 1:
      return mem.view.getUint8(ptr);
    case 2:
      return mem.view.getUint16(ptr, true);
    case 4:
      return mem.view.getUint32(ptr, true);
    case 8:
      return mem.view.getBigUint64(ptr, true);
  }
}

export function loadIntS(mem: MemInst, ptr: number, nbytes: 1 | 2 | 4): number;
export function loadIntS(mem: MemInst, ptr: number, nbytes: 8): bigint;
export function loadIntS(
  mem: MemInst,
  ptr: number,
  nbytes: 1 | 2 | 4 | 8,
): number | bigint {
  assert_(ptr + nbytes <= mem.length, "load out of bounds");
  switch (nbytes) {
    case 1:
      return mem.view.getInt8(ptr);
    case 2:
      return mem.view.getInt16(ptr, true);
    case 4:
      return mem.view.getInt32(ptr, true);
    case 8:
      return mem.view.getBigInt64(ptr, true);
  }
}

/** Load a pointer-sized unsigned integer (returns bigint for i64 memories). */
export function loadPtr(mem: MemInst, ptr: number): number | bigint {
  return mem.ptrSize() === 4 ? loadIntU(mem, ptr, 4) : loadIntU(mem, ptr, 8);
}

// definitions.py store_int(cx, v, ptr, nbytes, signed): `int.to_bytes` raises
// `OverflowError` when `v` does not fit in `nbytes` (signed/unsigned per the
// flag) — a host-precondition violation, not a guest-visible trap (the value
// never came from validated guest bytes; it is a JS number/bigint an
// embedder handed the lowering path). Ported as `assert_`/`AssertionError`
// (see cabi/trap.ts's Trap-vs-AssertionError taxonomy), not `Trap`.
// definitions.py:1568-1569 (`store_int`).
//
// This scalar path is where the check lives; the bulk (TypedArray) path in
// bulk_lists.ts intentionally wraps instead — see that file's header for why.

function bigintFitsIn64(v: bigint, signed: boolean): boolean {
  return signed ? v >= -(2n ** 63n) && v < 2n ** 63n : v >= 0n && v < 2n ** 64n;
}

function numberFitsInWidth(
  v: number,
  nbytes: 1 | 2 | 4,
  signed: boolean,
): boolean {
  const bits = nbytes * 8;
  if (signed) {
    const min = -(2 ** (bits - 1));
    const max = 2 ** (bits - 1) - 1;
    return v >= min && v <= max;
  }
  return v >= 0 && v <= 2 ** bits - 1;
}

export function storeInt(
  mem: MemInst,
  v: number | bigint,
  ptr: number,
  nbytes: 1 | 2 | 4 | 8,
  signed = false,
): void {
  assert_(ptr + nbytes <= mem.length, "store out of bounds");
  if (nbytes === 8) {
    assert_(typeof v === "bigint", "64-bit store requires bigint");
    assert_(bigintFitsIn64(v, signed), "int store: value out of range");
    if (signed) mem.view.setBigInt64(ptr, v, true);
    else mem.view.setBigUint64(ptr, v, true);
    return;
  }
  assert_(typeof v === "number" && Number.isInteger(v), "int store");
  assert_(
    numberFitsInWidth(v, nbytes, signed),
    "int store: value out of range",
  );
  switch (nbytes) {
    case 1:
      if (signed) mem.view.setInt8(ptr, v);
      else mem.view.setUint8(ptr, v);
      break;
    case 2:
      if (signed) mem.view.setInt16(ptr, v, true);
      else mem.view.setUint16(ptr, v, true);
      break;
    case 4:
      if (signed) mem.view.setInt32(ptr, v, true);
      else mem.view.setUint32(ptr, v, true);
      break;
  }
}

/** Store a pointer-sized unsigned integer, taking a JS number. */
export function storePtr(mem: MemInst, v: number, ptr: number): void {
  if (mem.ptrSize() === 4) storeInt(mem, v, ptr, 4);
  else storeInt(mem, BigInt(v), ptr, 8);
}

/** Bounds-checked byte-range read (callers trap on OOB before calling). */
export function bytesOf(mem: MemInst, ptr: number, len: number): Uint8Array {
  assert_(ptr >= 0 && len >= 0 && ptr + len <= mem.length, "range OOB");
  return mem.bytes.subarray(ptr, ptr + len);
}

/** Copy bytes into memory; used by string/list stores after trap checks. */
export function writeBytes(mem: MemInst, ptr: number, src: Uint8Array): void {
  assert_(ptr >= 0 && ptr + src.length <= mem.length, "write OOB");
  mem.bytes.set(src, ptr);
}

/**
 * Exact bounds check usable with i64-lane values: traps when
 * `ptr + byteLength > len(memory)`, computed without precision loss.
 *
 * `what` selects the trap wording only. Callers that are checking a pointer
 * *returned by realloc* pass wasmtime's phrasing for that case
 * ("realloc return: beyond end of memory",
 * `wasmtime/src/runtime/component/func/options.rs:185`) and the string-lift
 * path passes its own ("string pointer/length out of bounds of memory",
 * `.../func/typed.rs:1528`), because the official suite matches those texts.
 * The default is unchanged.
 */
export function trapIfRangeExceedsMemory(
  mem: MemInst,
  ptr: number | bigint,
  byteLength: number | bigint,
  what: string = "out of bounds of linear memory",
): void {
  trapIf(BigInt(ptr) + BigInt(byteLength) > BigInt(mem.length), what);
}
