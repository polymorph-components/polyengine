// Bulk list copies for flat element types (issue #67; cabi/bulk_lists.ts).
// These tests pin EQUIVALENCE with the per-element interpreted path: same
// host shapes, same wrap-on-overflow, same assert texts, and the
// deterministic profile's canonical-NaN handling in both directions
// (float.ts; run against absolute expected byte patterns, not against the
// old code path).

import {
  type ComponentValue,
  load,
  MemInst,
  PLATFORM_LITTLE_ENDIAN,
  store,
  tryLoadNumericList,
  tryStoreNumericList,
  type ValType,
} from "../src/cabi/mod.ts";
import { mkCx } from "./support/driver.ts";
import { Heap } from "./support/heap.ts";
import { assertEq } from "./support/asserts.ts";

function listOf(kind: string): ValType {
  return { kind: "list", element: { kind } as ValType } as ValType;
}

function cxWithHeap(size: number) {
  const heap = new Heap(size);
  return {
    heap,
    cx: mkCx(new MemInst(heap.memory, "i32"), "utf8", heap.realloc),
  };
}

/** Store a list at 8 (heap pre-bumped clear of it), read back bytes+value. */
function storeAndReadBack(
  v: ComponentValue,
  t: ValType,
  size = 4096,
): { bytes: Uint8Array; lifted: ComponentValue } {
  const { heap, cx } = cxWithHeap(size);
  heap.lastAlloc = 16;
  store(cx, v, t, 8);
  const begin = heap.memory[8] | (heap.memory[9] << 8) |
    (heap.memory[10] << 16) | (heap.memory[11] << 24);
  const length = heap.memory[12] | (heap.memory[13] << 8) |
    (heap.memory[14] << 16) | (heap.memory[15] << 24);
  const elemBytes = { // by kind, for slicing the payload
    bool: 1,
    s8: 1,
    u16: 2,
    s16: 2,
    u32: 4,
    s32: 4,
    f32: 4,
    u64: 8,
    s64: 8,
    f64: 8,
  }[(t as { element: { kind: string } }).element.kind]!;
  return {
    bytes: heap.memory.slice(begin, begin + length * elemBytes),
    lifted: load(cx, 8, t),
  };
}

Deno.test("bulk lists: integer kinds round-trip and wrap like the DataView setters", () => {
  const cases: [string, ComponentValue[], ComponentValue[]][] = [
    // [kind, stored, expected lift]
    ["u16", [0, 1, 0xffff, 0x1_0005], [0, 1, 0xffff, 5]],
    ["s16", [-1, -32768, 32767, 0x1_0005], [-1, -32768, 32767, 5]],
    ["u32", [0, 0xffffffff, 1], [0, 0xffffffff, 1]],
    ["s32", [-1, -2147483648, 2147483647], [-1, -2147483648, 2147483647]],
    ["s8", [-1, -128, 127, 200], [-1, -128, 127, -56]],
  ];
  for (const [kind, stored, expected] of cases) {
    const { lifted } = storeAndReadBack(stored, listOf(kind));
    assertEq(lifted, expected, `${kind} round-trip+wrap`);
  }
});

Deno.test("bulk lists: 64-bit kinds are bigint-shaped and wrap mod 2^64", () => {
  const u = storeAndReadBack(
    [0n, 0xffffffffffffffffn, 1n, (1n << 64n) + 7n],
    listOf("u64"),
  );
  assertEq(u.lifted, [0n, 0xffffffffffffffffn, 1n, 7n], "u64");
  const s = storeAndReadBack(
    [-1n, -(1n << 63n), (1n << 63n) - 1n],
    listOf("s64"),
  );
  assertEq(s.lifted, [-1n, -(1n << 63n), (1n << 63n) - 1n], "s64");
});

Deno.test("bulk lists: bool normalizes by truthiness, lifts nonzero as true", () => {
  // store(): `Number(Boolean(v))` accepted ANY value — pin that.
  const { bytes, lifted } = storeAndReadBack(
    [
      true,
      false,
      2 as unknown as ComponentValue,
      "" as unknown as ComponentValue,
    ],
    listOf("bool"),
  );
  assertEq([...bytes], [1, 0, 1, 0], "stored bytes normalized");
  assertEq(lifted, [true, false, true, false]);
  // A raw nonzero byte in memory lifts true (convertIntToBool semantics).
  const { heap, cx } = cxWithHeap(64);
  heap.memory[8] = 2;
  heap.memory[9] = 0;
  const t: ValType = {
    kind: "list",
    element: { kind: "bool" },
    length: 2,
  } as ValType;
  assertEq(load(cx, 8, t), [true, false], "byte 2 lifts as true");
});

Deno.test("bulk lists: floats round-trip, f32 narrows like setFloat32", () => {
  const f64 = storeAndReadBack([0.5, -0, 1e308, 5e-324], listOf("f64"));
  assertEq(f64.lifted, [0.5, -0, 1e308, 5e-324], "f64 exact");
  const f32 = storeAndReadBack(
    [0.5, 1.1, -3.4028234663852886e38],
    listOf("f32"),
  );
  assertEq(
    f32.lifted,
    [0.5, Math.fround(1.1), -3.4028234663852886e38],
    "f32 IEEE narrowing",
  );
});

Deno.test("bulk lists: NaN stores canonical bit patterns (deterministic profile)", () => {
  const f32 = storeAndReadBack([NaN, 1], listOf("f32"));
  assertEq(
    [...f32.bytes.subarray(0, 4)],
    [0x00, 0x00, 0xc0, 0x7f],
    "canonical f32 NaN bits",
  );
  const f64 = storeAndReadBack([NaN], listOf("f64"));
  assertEq(
    [...f64.bytes],
    [0, 0, 0, 0, 0, 0, 0xf8, 0x7f],
    "canonical f64 NaN bits",
  );
});

Deno.test("bulk lists: payload NaNs in memory lift as canonical NaN and re-store canonical", () => {
  // Craft a non-canonical (payload) NaN in memory, lift, and re-store: the
  // deterministic profile forces the canonical pattern both ways.
  const { heap, cx } = cxWithHeap(64);
  const view = new DataView(heap.memory.buffer);
  view.setUint32(8, 0x7fc00001, true); // payload f32 NaN
  const t: ValType = {
    kind: "list",
    element: { kind: "f32" },
    length: 1,
  } as ValType;
  const lifted = load(cx, 8, t) as number[];
  assertEq(Number.isNaN(lifted[0]), true, "lifts as NaN");
  store(cx, lifted, t, 12);
  assertEq(
    [...heap.memory.subarray(12, 16)],
    [0x00, 0x00, 0xc0, 0x7f],
    "re-stored canonical",
  );
  // f64 twin (decodeI64AsFloat parity): a signaling-shaped payload NaN.
  view.setBigUint64(16, 0x7ff0000000000001n, true);
  const t64: ValType = {
    kind: "list",
    element: { kind: "f64" },
    length: 1,
  } as ValType;
  const lifted64 = load(cx, 16, t64) as number[];
  assertEq(Number.isNaN(lifted64[0]), true, "f64 payload NaN lifts as NaN");
  store(cx, lifted64, t64, 24);
  assertEq(
    [...heap.memory.subarray(24, 32)],
    [0, 0, 0, 0, 0, 0, 0xf8, 0x7f],
    "f64 re-stored canonical",
  );
});

Deno.test("bulk lists: the fast path actually fires on this platform", () => {
  // All equivalence tests above pass identically under full fallback; this
  // smoke catches an accidental always-decline regression (review advisory).
  if (!PLATFORM_LITTLE_ENDIAN) return; // BE platforms legitimately decline
  const { heap, cx } = cxWithHeap(64);
  void cx;
  const mem = new MemInst(heap.memory, "i32");
  assertEq(
    tryLoadNumericList(mem, 0, 4, "u32") !== null,
    true,
    "u32 bulk lift engaged",
  );
  assertEq(
    tryStoreNumericList(mem, [1, 2], 0, "u16"),
    true,
    "u16 bulk store engaged",
  );
});

Deno.test("bulk lists: validation asserts match the per-element path", () => {
  for (
    const [kind, bad, msg] of [
      ["u32", [1.5], "int store"],
      ["u32", [Infinity], "int store"],
      ["u32", [NaN], "int store"],
      ["u32", [1n], "int store"],
      ["s16", ["7"], "int store"],
      ["u64", [1], "64-bit store requires bigint"],
      ["s64", [1.5], "64-bit store requires bigint"],
    ] as [string, unknown[], string][]
  ) {
    let err: unknown;
    try {
      storeAndReadBack(bad as ComponentValue[], listOf(kind));
    } catch (e) {
      err = e;
    }
    assertEq(
      String(err).includes(msg),
      true,
      `${kind} ${Deno.inspect(bad)}: expected '${msg}', got: ${err}`,
    );
  }
});

Deno.test("bulk lists: empty and fixed-length lists", () => {
  assertEq(storeAndReadBack([], listOf("u32")).lifted, []);
  const { heap, cx } = cxWithHeap(64);
  const t: ValType = {
    kind: "list",
    element: { kind: "u32" },
    length: 3,
  } as ValType;
  store(cx, [7, 8, 9], t, 8);
  assertEq(load(cx, 8, t), [7, 8, 9], "fixed-length round-trip");
  assertEq(heap.memory[8], 7, "payload in place (no indirection)");
});

Deno.test("bulk lists: misaligned view falls back to the per-element path, same results", () => {
  // A MemInst over a subarray with odd byteOffset makes the typed-array view
  // construction decline (byteOffset+ptr not element-aligned) while the CABI
  // alignment of ptr itself is satisfied — the fallback must produce
  // identical results.
  const backing = new Uint8Array(128);
  const mem = new MemInst(backing.subarray(2), "i32");
  const heapless = mkCx(mem, "utf8", null);
  const t: ValType = {
    kind: "list",
    element: { kind: "u32" },
    length: 2,
  } as ValType;
  store(heapless, [0x11223344, 0xffffffff], t, 4);
  assertEq(load(heapless, 4, t), [0x11223344, 0xffffffff], "fallback parity");
});
