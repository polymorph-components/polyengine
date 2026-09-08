// Host-side integer range asserts on the scalar store path (issue #96):
// definitions.py `store_int` -> `int.to_bytes(v, nbytes, 'little', signed=…)`
// raises `OverflowError` when `v` does not fit; `storeInt` (cabi/memory.ts)
// now raises the port's equivalent host-precondition error (`AssertionError`,
// NOT `Trap` — cabi/trap.ts's taxonomy: only `Trap` models a guest-visible
// canonical-ABI fault) instead of silently wrapping. This is the fix for a
// buggy embedder value (e.g. `{x: 300}` into `record{x: u8}`) corrupting data
// instead of failing loudly.
//
// The BULK path (bulk_lists.ts, `tryStoreNumericList`) intentionally keeps
// wrap-on-overflow for throughput (see that file's header) — pinned
// separately in bulk_list_test.ts and store_list_test.ts. This file only
// covers the scalar `storeInt` path.

import { AssertionError, MemInst, storeInt } from "../src/cabi/mod.ts";
import { assertEq } from "./support/asserts.ts";

function freshMem(size = 64): MemInst {
  return new MemInst(new Uint8Array(size), "i32");
}

function assertRangeError(fn: () => void, msg: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assertEq(
    err instanceof AssertionError,
    true,
    `${msg}: expected AssertionError, got ${err}`,
  );
  assertEq(
    String((err as Error)?.message ?? "").includes("out of range"),
    true,
    `${msg}: expected an "out of range" message, got: ${err}`,
  );
}

Deno.test("storeInt: in-range values are unchanged for every width", () => {
  const mem = freshMem();
  // [nbytes, signed, value, expected byte(s) readback via loadable width]
  storeInt(mem, 0, 0, 1, false);
  assertEq(mem.bytes[0], 0, "u8 min");
  storeInt(mem, 255, 0, 1, false);
  assertEq(mem.bytes[0], 255, "u8 max");
  storeInt(mem, -128, 0, 1, true);
  assertEq(mem.view.getInt8(0), -128, "s8 min");
  storeInt(mem, 127, 0, 1, true);
  assertEq(mem.view.getInt8(0), 127, "s8 max");

  storeInt(mem, 0, 8, 2, false);
  assertEq(mem.view.getUint16(8, true), 0, "u16 min");
  storeInt(mem, 0xffff, 8, 2, false);
  assertEq(mem.view.getUint16(8, true), 0xffff, "u16 max");
  storeInt(mem, -32768, 8, 2, true);
  assertEq(mem.view.getInt16(8, true), -32768, "s16 min");
  storeInt(mem, 32767, 8, 2, true);
  assertEq(mem.view.getInt16(8, true), 32767, "s16 max");

  storeInt(mem, 0, 16, 4, false);
  assertEq(mem.view.getUint32(16, true), 0, "u32 min");
  storeInt(mem, 0xffffffff, 16, 4, false);
  assertEq(mem.view.getUint32(16, true), 0xffffffff, "u32 max");
  storeInt(mem, -2147483648, 16, 4, true);
  assertEq(mem.view.getInt32(16, true), -2147483648, "s32 min");
  storeInt(mem, 2147483647, 16, 4, true);
  assertEq(mem.view.getInt32(16, true), 2147483647, "s32 max");

  storeInt(mem, 0n, 24, 8, false);
  assertEq(mem.view.getBigUint64(24, true), 0n, "u64 min");
  storeInt(mem, 0xffffffffffffffffn, 24, 8, false);
  assertEq(mem.view.getBigUint64(24, true), 0xffffffffffffffffn, "u64 max");
  storeInt(mem, -(1n << 63n), 24, 8, true);
  assertEq(mem.view.getBigInt64(24, true), -(1n << 63n), "s64 min");
  storeInt(mem, (1n << 63n) - 1n, 24, 8, true);
  assertEq(mem.view.getBigInt64(24, true), (1n << 63n) - 1n, "s64 max");
});

Deno.test("storeInt: out-of-range u8 raises the host-precondition error, not a silent wrap", () => {
  const mem = freshMem();
  assertRangeError(() => storeInt(mem, 300, 0, 1, false), "u8 over max");
  assertRangeError(() => storeInt(mem, -1, 0, 1, false), "u8 under min");
  assertEq(mem.bytes[0], 0, "memory untouched by a rejected store");
});

Deno.test("storeInt: out-of-range s16 raises the host-precondition error", () => {
  const mem = freshMem();
  assertRangeError(() => storeInt(mem, 32768, 0, 2, true), "s16 over max");
  assertRangeError(() => storeInt(mem, -32769, 0, 2, true), "s16 under min");
});

Deno.test("storeInt: out-of-range u32 raises the host-precondition error", () => {
  const mem = freshMem();
  assertRangeError(
    () => storeInt(mem, 0x1_0000_0000, 0, 4, false),
    "u32 over max",
  );
  assertRangeError(() => storeInt(mem, -1, 0, 4, false), "u32 under min");
});

Deno.test("storeInt: out-of-range s64 (bigint) raises the host-precondition error", () => {
  const mem = freshMem();
  assertRangeError(() => storeInt(mem, 1n << 63n, 0, 8, true), "s64 over max");
  assertRangeError(
    () => storeInt(mem, -(1n << 63n) - 1n, 0, 8, true),
    "s64 under min",
  );
});

Deno.test("storeInt: out-of-range u64 (bigint) raises the host-precondition error", () => {
  const mem = freshMem();
  assertRangeError(
    () => storeInt(mem, 1n << 64n, 0, 8, false),
    "u64 over max",
  );
  assertRangeError(() => storeInt(mem, -1n, 0, 8, false), "u64 under min");
});
