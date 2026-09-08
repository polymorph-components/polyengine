// The list<u8> bulk store fast path (issue #54): `storeListIntoValidRange`
// copies u8 payloads with `Uint8Array.set` instead of one interpreted
// `store()` per element — the store-side mirror of `loadListFromValidRange`'s
// u8 fast path (docs/architecture.md §7). These tests pin the equivalence:
// same bytes, same validation asserts, same masking as `storeInt(…, 1)`.

import {
  type ComponentValue,
  load,
  MemInst,
  store,
  type ValType,
} from "../src/cabi/mod.ts";
import { mkCx } from "./support/driver.ts";
import { Heap } from "./support/heap.ts";
import { assertEq } from "./support/asserts.ts";

const u8: ValType = { kind: "u8" };
const listU8: ValType = { kind: "list", element: u8 };
const listU32: ValType = { kind: "list", element: { kind: "u32" } };

function cxWithHeap(size: number) {
  const heap = new Heap(size);
  return {
    heap,
    cx: mkCx(new MemInst(heap.memory, "i32"), "utf8", heap.realloc),
  };
}

/** Store a list value at a fresh spot, return [begin, length] read back. */
function storeAndReadBack(
  v: ComponentValue,
  t: ValType,
  size = 4096,
): { bytes: Uint8Array; lifted: ComponentValue } {
  const { heap, cx } = cxWithHeap(size);
  // The (ptr, len) pair itself lives at 8; keep the bump allocator clear of it.
  heap.lastAlloc = 16;
  store(cx, v, t, 8);
  const begin = heap.memory[8] | (heap.memory[9] << 8) |
    (heap.memory[10] << 16) | (heap.memory[11] << 24);
  const length = heap.memory[12] | (heap.memory[13] << 8) |
    (heap.memory[14] << 16) | (heap.memory[15] << 24);
  return {
    bytes: heap.memory.slice(begin, begin + length),
    lifted: load(cx, 8, t),
  };
}

Deno.test("list<u8> store: Uint8Array source round-trips bulk", () => {
  const src = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);
  const { bytes, lifted } = storeAndReadBack(src, listU8);
  assertEq([...bytes], [...src], "stored bytes");
  assertEq(lifted instanceof Uint8Array, true, "lifts back as Uint8Array");
  assertEq([...(lifted as Uint8Array)], [...src], "round-trip");
});

Deno.test("list<u8> store: plain number[] source stores identically", () => {
  const src = [0, 1, 127, 128, 255];
  const { bytes } = storeAndReadBack(src, listU8);
  assertEq([...bytes], src, "stored bytes");
});

Deno.test("list<u8> store: empty sources", () => {
  assertEq([...storeAndReadBack(new Uint8Array(0), listU8).bytes], []);
  assertEq([...storeAndReadBack([], listU8).bytes], []);
});

Deno.test("list<u8> store: out-of-range integers mask mod 256 (storeInt parity)", () => {
  // Pins the pre-fast-path behavior: storeInt() -> DataView.setUint8 wraps;
  // the bulk path must not become stricter or looser. NOTE this masking is a
  // pre-existing repo deviation from definitions.py `store_int`, whose
  // int.to_bytes RAISES on out-of-range — pinned here as parity with our own
  // storeInt, not with the reference (docs/architecture.md §1 policy: the
  // deviation belongs to memory.ts, this path merely must not diverge from
  // it).
  const { bytes } = storeAndReadBack([256, 300, -1], listU8);
  assertEq([...bytes], [0, 44, 255], "mod-256 masking");
});

Deno.test("list<u8> store: non-integer elements keep the `int store` assert", () => {
  for (const bad of [[1.5], [NaN], ["7" as unknown as number], [null]]) {
    let err: unknown;
    try {
      storeAndReadBack(bad as ComponentValue, listU8);
    } catch (e) {
      err = e;
    }
    assertEq(
      String(err).includes("int store"),
      true,
      `expected the storeInt assert for ${Deno.inspect(bad)}, got: ${err}`,
    );
  }
});

Deno.test("list<u8> store: fixed-length lists take the same fast path", () => {
  const t: ValType = { kind: "list", element: u8, length: 4 };
  const { heap, cx } = cxWithHeap(64);
  store(cx, Uint8Array.from([9, 8, 7, 6]), t, 8);
  assertEq([...heap.memory.subarray(8, 12)], [9, 8, 7, 6]);
  assertEq([...(load(cx, 8, t) as Uint8Array)], [9, 8, 7, 6]);
});

Deno.test("list<u32> store: unaffected by the u8 fast path", () => {
  const src = [1, 0x11223344, 0xffffffff];
  const { lifted } = storeAndReadBack(src, listU32);
  assertEq(lifted, src, "u32 round-trip");
});
