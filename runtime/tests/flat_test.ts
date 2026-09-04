// Ports of the flat lift/lower tables at the top of run_tests.py
// (records/tuples/fixed lists/flags/variants/options/results, the
// numeric/char/enum `test_pairs`, and the variant subtype-lower case), plus
// TS-added variant lane-coercion cases whose expectations were produced by
// running definitions.py directly (values recorded in comments).

import type { ValType } from "../src/cabi/mod.ts";
import { EXPECT_TRAP, mkTup, runTest, runTestPairs } from "./support/driver.ts";

const u8: ValType = { kind: "u8" };
const u16: ValType = { kind: "u16" };
const u32: ValType = { kind: "u32" };
const f32: ValType = { kind: "f32" };
const f64: ValType = { kind: "f64" };

Deno.test("records, tuples, fixed-length lists", () => {
  runTest(
    {
      kind: "record",
      fields: [
        { label: "x", type: u8 },
        { label: "y", type: u16 },
        { label: "z", type: u32 },
      ],
    },
    [1, 2, 3],
    { x: 1, y: 2, z: 3 },
  );
  runTest(
    { kind: "tuple", elements: [{ kind: "tuple", elements: [u8, u8] }, u8] },
    [1, 2, 3],
    { "0": { "0": 1, "1": 2 }, "1": 3 },
  );
  // list<u8> is a Uint8Array on the host side (docs/architecture.md §7).
  runTest(
    { kind: "list", element: u8, length: 3 },
    [1, 2, 3],
    Uint8Array.from([1, 2, 3]),
  );
  runTest(
    {
      kind: "list",
      element: { kind: "list", element: u8, length: 2 },
      length: 3,
    },
    [1, 2, 3, 4, 5, 6],
    [Uint8Array.from([1, 2]), Uint8Array.from([3, 4]), Uint8Array.from([5, 6])],
  );
});

Deno.test("flags", () => {
  const t: ValType = { kind: "flags", labels: ["a", "b"] };
  runTest(t, [0], { a: false, b: false });
  runTest(t, [2], { a: false, b: true });
  runTest(t, [3], { a: true, b: true });
  runTest(t, [4], { a: false, b: false });
  const labels32 = Array.from({ length: 32 }, (_, i) => String(i));
  const all32: Record<string, boolean> = {};
  for (const l of labels32) all32[l] = true;
  runTest({ kind: "flags", labels: labels32 }, [0xffffffff], all32);
});

Deno.test("variants, options, results", () => {
  const t: ValType = {
    kind: "variant",
    cases: [
      { label: "x", type: u8 },
      { label: "y", type: f32 },
      { label: "z", type: null },
    ],
  };
  runTest(t, [0, 42], { kind: "x", value: 42 });
  runTest(t, [0, 256], { kind: "x", value: 0 });
  runTest(t, [1, 0x4048f5c3], { kind: "y", value: 3.140000104904175 });
  runTest(t, [2, 0xffffffff], { kind: "z", value: null });

  const opt: ValType = { kind: "option", type: f32 };
  runTest(opt, [0, 3.14], { kind: "none", value: null });
  runTest(opt, [1, 3.14], { kind: "some", value: 3.14 });

  const res: ValType = { kind: "result", ok: u8, error: u32 };
  runTest(res, [0, 42], { kind: "ok", value: 42 });
  runTest(res, [1, 1000], { kind: "error", value: 1000 });
});

Deno.test("variant lowered to supertype", () => {
  const t: ValType = {
    kind: "variant",
    cases: [{ label: "w", type: u8 }, { label: "y", type: u8 }],
  };
  runTest(t, [0, 42], { kind: "w", value: 42 });
  runTest(t, [1, 42], { kind: "y", value: 42 });
  const t2: ValType = { kind: "variant", cases: [{ label: "w", type: u8 }] };
  runTest(
    t,
    [0, 42],
    { kind: "w", value: 42 },
    undefined,
    null,
    t2,
    { kind: "w", value: 42 },
  );
});

Deno.test("bool and integer lane wrapping (test_pairs)", () => {
  runTestPairs({ kind: "bool" }, [
    [0, false],
    [1, true],
    [2, true],
    [4294967295, true],
  ]);
  runTestPairs(u8, [
    [127, 127],
    [128, 128],
    [255, 255],
    [256, 0],
    [4294967295, 255],
    [4294967168, 128],
    [4294967167, 127],
  ]);
  runTestPairs({ kind: "s8" }, [
    [127, 127],
    [128, -128],
    [255, -1],
    [256, 0],
    [4294967295, -1],
    [4294967168, -128],
    [4294967167, 127],
  ]);
  runTestPairs(u16, [
    [32767, 32767],
    [32768, 32768],
    [65535, 65535],
    [65536, 0],
    [2 ** 32 - 1, 65535],
    [2 ** 32 - 32768, 32768],
    [2 ** 32 - 32769, 32767],
  ]);
  runTestPairs({ kind: "s16" }, [
    [32767, 32767],
    [32768, -32768],
    [65535, -1],
    [65536, 0],
    [2 ** 32 - 1, -1],
    [2 ** 32 - 32768, -32768],
    [2 ** 32 - 32769, 32767],
  ]);
  runTestPairs(u32, [
    [2 ** 31 - 1, 2 ** 31 - 1],
    [2 ** 31, 2 ** 31],
    [2 ** 32 - 1, 2 ** 32 - 1],
  ]);
  runTestPairs({ kind: "s32" }, [
    [2 ** 31 - 1, 2 ** 31 - 1],
    [2 ** 31, -(2 ** 31)],
    [2 ** 32 - 1, -1],
  ]);
});

Deno.test("u64/s64 <-> BigInt boundaries (test_pairs)", () => {
  runTestPairs({ kind: "u64" }, [
    [(1n << 63n) - 1n, (1n << 63n) - 1n],
    [1n << 63n, 1n << 63n],
    [(1n << 64n) - 1n, (1n << 64n) - 1n],
  ]);
  runTestPairs({ kind: "s64" }, [
    [(1n << 63n) - 1n, (1n << 63n) - 1n],
    [1n << 63n, -(1n << 63n)],
    [(1n << 64n) - 1n, -1n],
  ]);
});

Deno.test("floats (test_pairs)", () => {
  runTestPairs(f32, [[3.14, 3.14]]);
  runTestPairs(f64, [[3.14, 3.14]]);
});

Deno.test("char validation (test_pairs)", () => {
  runTestPairs({ kind: "char" }, [
    [0, "\x00"],
    [65, "A"],
    [0xd7ff, "\ud7ff"],
    [0xd800, EXPECT_TRAP],
    [0xdfff, EXPECT_TRAP],
    [0xe000, "\ue000"],
    [0x10ffff, "\u{10ffff}"],
    [0x110000, EXPECT_TRAP],
    [0xffffffff, EXPECT_TRAP],
  ]);
});

Deno.test("enum (test_pairs)", () => {
  runTestPairs({ kind: "enum", labels: ["a", "b"] }, [
    [0, { kind: "a", value: null }],
    [1, { kind: "b", value: null }],
    [2, EXPECT_TRAP],
  ]);
});

// TS-added: variant payload lane coercion (definitions.py CoerceValueIter /
// lower_flat_variant lane adjustment). Expected values verified against
// definitions.py (see comments; python3 session, DETERMINISTIC_PROFILE).

Deno.test("variant lane coercion i64<->f64/f32/i32", () => {
  // variant{a: u64, b: f64}: flat [i32, i64]
  const vU64F64: ValType = {
    kind: "variant",
    cases: [{ label: "a", type: { kind: "u64" } }, { label: "b", type: f64 }],
  };
  // python: lift [1, 0x3ff0000000000000] -> {'b': 1.0}
  runTest(vU64F64, [1, 0x3ff0000000000000n], { kind: "b", value: 1.0 });
  // python: lift [0, 5] -> {'a': 5}; lower -> [0, 5]
  runTest(vU64F64, [0, 5n], { kind: "a", value: 5n });

  // variant{a: u64, b: f32}: flat [i32, i64]
  const vU64F32: ValType = {
    kind: "variant",
    cases: [{ label: "a", type: { kind: "u64" } }, { label: "b", type: f32 }],
  };
  // python: lift [1, 0x40490fdb] -> {'b': 3.1415927410125732}
  runTest(vU64F32, [1, 0x40490fdbn], { kind: "b", value: 3.1415927410125732 });

  // variant{a: u32, b: f32}: flat [i32, i32] (join i32/f32 -> i32)
  const vU32F32: ValType = {
    kind: "variant",
    cases: [{ label: "a", type: u32 }, { label: "b", type: f32 }],
  };
  // python: lift [1, 0x40490fdb] -> {'b': 3.1415927410125732}
  runTest(vU32F32, [1, 0x40490fdb], { kind: "b", value: 3.1415927410125732 });

  // variant{a: f32, b: u64}: flat [i32, i64]; f32 read via wrap_i64_to_i32
  const vF32U64: ValType = {
    kind: "variant",
    cases: [{ label: "a", type: f32 }, { label: "b", type: { kind: "u64" } }],
  };
  // python: lift [0, 0x40490fdb] -> {'a': 3.1415927410125732}
  runTest(vF32U64, [0, 0x40490fdbn], { kind: "a", value: 3.1415927410125732 });
  // python: high bits ignored by wrap: [0, (7<<32)|0x40490fdb] -> same
  runTest(vF32U64, [0, (7n << 32n) | 0x40490fdbn], {
    kind: "a",
    value: 3.1415927410125732,
  });

  // variant{a: f64, b: u64}: flat [i32, i64]; f64 via i64 reinterpret
  const vF64U64: ValType = {
    kind: "variant",
    cases: [{ label: "a", type: f64 }, { label: "b", type: { kind: "u64" } }],
  };
  // python: lift [0, 0x3ff0000000000000] -> {'a': 1.0}; lower roundtrips
  runTest(vF64U64, [0, 0x3ff0000000000000n], { kind: "a", value: 1.0 });

  // variant{a: tuple<u64,u64>, b: u8}: flat [i32, i64, i64]; the u8 payload
  // widens to an i64 lane and the second lane pads with zero.
  // python: lower {'b': 9} -> [1, 9, 0]; lift [1, 9, 0] -> {'b': 9}
  // (definitions.py's dict spelling; ours is {kind: "b", value: 9})
  const vTupU8: ValType = {
    kind: "variant",
    cases: [
      {
        label: "a",
        type: { kind: "tuple", elements: [{ kind: "u64" }, { kind: "u64" }] },
      },
      { label: "b", type: u8 },
    ],
  };
  runTest(vTupU8, [1, 9n, 0n], { kind: "b", value: 9 });
  runTest(vTupU8, [0, 3n, 4n], { kind: "a", value: mkTup(3n, 4n) });
});
