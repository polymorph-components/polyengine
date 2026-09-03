// The per-type layout cache (issue #261; cabi/layout.ts `layoutOf`). These
// pin the three ways an identity-keyed cache goes wrong — keying too coarsely,
// handing out a mutable shared node, and caching a failure as a success — plus
// agreement between the cached node and the uncached definitions.py kernels
// that produce it.

import {
  alignment,
  alignmentRecord,
  alignmentVariant,
  alignTo,
  type CaseType,
  despecialize,
  elemSize,
  elemSizeRecord,
  elemSizeVariant,
  type FieldType,
  layoutOf,
  maxCaseAlignment,
  type PtrType,
  type ValType,
} from "../src/cabi/mod.ts";
import { assertEq } from "./support/asserts.ts";

const PTR_TYPES: PtrType[] = ["i32", "i64"];

function caught(fn: () => unknown, msg: string): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error(`${msg}: expected a throw, got none`);
}

function assertThrowsWith(fn: () => unknown, needle: string, msg: string) {
  const e = caught(fn, msg);
  const text = String((e as Error).message ?? e);
  if (!text.includes(needle)) {
    throw new Error(`${msg}: expected /${needle}/, got ${text}`);
  }
}

/**
 * Frozen-ness is asserted by error TYPE, not message: the strict-mode
 * assignment TypeError is worded differently by every engine, and this
 * runtime ships to browsers.
 */
function assertFrozenThrows(fn: () => unknown, msg: string) {
  const e = caught(fn, msg);
  assertEq(e instanceof TypeError, true, `${msg}: expected a TypeError`);
}

// 1. Layout is a function of BOTH the type and the pointer width. A single
//    WeakMap keyed on the type alone passes every other test in this file and
//    hands i32 layouts to a memory64 instance.
Deno.test("layoutOf keys on pointer width as well as type", () => {
  // Both fields are pointer-width-dependent: string is 2 pointers, a
  // variable-length list is a (ptr, len) pair.
  const t: ValType = {
    kind: "record",
    fields: [
      { label: "s", type: { kind: "string" } },
      { label: "l", type: { kind: "list", element: { kind: "u8" } } },
    ],
  };

  const a = layoutOf(t, "i32");
  const b = layoutOf(t, "i64");

  assertEq(a.align, 4, "i32 record alignment");
  assertEq(a.size, 16, "i32 record size");
  assertEq([...a.fieldOffsets!], [0, 8], "i32 field offsets");
  assertEq(b.align, 8, "i64 record alignment");
  assertEq(b.size, 32, "i64 record size");
  assertEq([...b.fieldOffsets!], [0, 16], "i64 field offsets");

  // Repeat calls hit the cache: the identical object, per pointer width.
  assertEq(layoutOf(t, "i32") === a, true, "i32 node is cached");
  assertEq(layoutOf(t, "i64") === b, true, "i64 node is cached");
  assertEq(a === b, false, "the two widths are distinct nodes");
});

// 2. The shared nodes are frozen, so a future caller cannot mutate one and
//    corrupt every other holder. Strict mode makes the mutation throw.
Deno.test("despecialized types and layout nodes are frozen", () => {
  const opt: ValType = { kind: "option", type: { kind: "u16" } };

  const d = despecialize(opt);
  assertEq(despecialize(opt) === d, true, "despecialize is memoized");
  assertEq(Object.isFrozen(d), true, "despecialized node frozen");
  assertFrozenThrows(
    () => ((d as { kind: string }).kind = "record"),
    "mutating a despecialized node",
  );
  const cases = (d as unknown as { cases: CaseType[] }).cases;
  assertEq(Object.isFrozen(cases), true, "despecialized cases array frozen");

  const L = layoutOf(opt, "i32");
  assertEq(Object.isFrozen(L), true, "layout node frozen");
  assertFrozenThrows(
    () => ((L as { size: number }).size = 99),
    "mutating a layout node",
  );
});

// 3. A throwing computation must leave nothing behind: the second call must
//    fail exactly like the first, not return a half-built node.
Deno.test("a failing layout is not cached as a success", () => {
  const empty: ValType = { kind: "record", fields: [] };
  for (const attempt of ["first", "second"]) {
    assertThrowsWith(
      () => layoutOf(empty, "i32"),
      "empty record",
      `${attempt} call on an empty record`,
    );
  }
});

// 4a. Non-compound layouts against LITERAL expected numbers. The spec table
//     (definitions.py `## Alignment` / `## Element Size`) is the oracle;
//     comparing against `alignment()`/`elemSize()` would assert nothing,
//     since those now just read the node back.
Deno.test("layoutOf: non-compound sizes match the spec table", () => {
  const labels = (n: number) =>
    Array.from({ length: n }, (_, i) => `flag${i}`);

  // [type, i32 align, i32 size, i64 align, i64 size]
  const table: [ValType, number, number, number, number][] = [
    [{ kind: "bool" }, 1, 1, 1, 1],
    [{ kind: "u8" }, 1, 1, 1, 1],
    [{ kind: "s8" }, 1, 1, 1, 1],
    [{ kind: "u16" }, 2, 2, 2, 2],
    [{ kind: "s16" }, 2, 2, 2, 2],
    [{ kind: "u32" }, 4, 4, 4, 4],
    [{ kind: "f32" }, 4, 4, 4, 4],
    [{ kind: "char" }, 4, 4, 4, 4],
    [{ kind: "u64" }, 8, 8, 8, 8],
    [{ kind: "f64" }, 8, 8, 8, 8],
    // A string is (ptr, len); a variable-length list likewise.
    [{ kind: "string" }, 4, 8, 8, 16],
    [{ kind: "list", element: { kind: "u32" } }, 4, 8, 8, 16],
    // A fixed-length list takes its element's alignment, n * elem size.
    [{ kind: "list", element: { kind: "u16" }, length: 3 }, 2, 6, 2, 6],
    [{ kind: "error-context" }, 4, 4, 4, 4],
    // flags at the 8/16/32 label boundaries.
    [{ kind: "flags", labels: labels(1) }, 1, 1, 1, 1],
    [{ kind: "flags", labels: labels(8) }, 1, 1, 1, 1],
    [{ kind: "flags", labels: labels(9) }, 2, 2, 2, 2],
    [{ kind: "flags", labels: labels(16) }, 2, 2, 2, 2],
    [{ kind: "flags", labels: labels(17) }, 4, 4, 4, 4],
    [{ kind: "flags", labels: labels(32) }, 4, 4, 4, 4],
  ];

  for (const [t, a32, s32, a64, s64] of table) {
    const where = `${t.kind}${
      "labels" in t ? `/${(t as { labels: string[] }).labels.length}` : ""
    }`;
    const i32 = layoutOf(t, "i32");
    const i64 = layoutOf(t, "i64");
    assertEq(i32.align, a32, `${where} i32 align`);
    assertEq(i32.size, s32, `${where} i32 size`);
    assertEq(i64.align, a64, `${where} i64 align`);
    assertEq(i64.size, s64, `${where} i64 size`);
    // None of these carry record/variant layout data.
    assertEq(i32.fieldOffsets, null, `${where} fieldOffsets`);
    assertEq(i32.discSize, 0, `${where} discSize`);
    assertEq(i32.payloadOffset, 0, `${where} payloadOffset`);
  }
});

// 4b. Compound layouts: size and alignment against the uncached spec kernels,
//     and the RETAINED offsets against an independent recomputation from
//     alignTo/alignment/elemSize — the check that the hoisted offsets are the
//     same arithmetic the spec walks per field.
Deno.test("layoutOf: compound offsets match an independent recomputation", () => {
  const u8: ValType = { kind: "u8" };
  const u32: ValType = { kind: "u32" };
  const u64: ValType = { kind: "u64" };
  const f64: ValType = { kind: "f64" };
  const str: ValType = { kind: "string" };

  const inner: ValType = {
    kind: "record",
    fields: [{ label: "a", type: u8 }, { label: "b", type: u64 }],
  };

  const types: ValType[] = [
    inner,
    {
      kind: "record",
      fields: [
        { label: "x", type: u8 },
        { label: "y", type: str },
        { label: "z", type: inner },
      ],
    },
    // Mixed-alignment payloads: a 1-byte discriminant and an 8-byte widest
    // payload, so the padding shows up in the payload offset.
    {
      kind: "variant",
      cases: [
        { label: "none", type: null },
        { label: "small", type: u8 },
        { label: "wide", type: f64 },
        { label: "str", type: str },
      ],
    },
    { kind: "option", type: u32 },
    { kind: "result", ok: u64, error: str },
    { kind: "result", ok: null, error: null },
    { kind: "tuple", elements: [u8, u32, str] },
    { kind: "enum", labels: ["a", "b", "c"] },
  ];

  for (const t of types) {
    for (const pt of PTR_TYPES) {
      const L = layoutOf(t, pt);
      const d = despecialize(t);
      const where = `${t.kind}/${pt}`;

      if (d.kind === "record") {
        assertEq(L.align, alignmentRecord(d.fields, pt), `align ${where}`);
        assertEq(L.size, elemSizeRecord(d.fields, pt), `size ${where}`);
        const want: number[] = [];
        let p = 0;
        for (const f of d.fields as FieldType[]) {
          p = alignTo(p, alignment(f.type, pt));
          want.push(p);
          p += elemSize(f.type, pt);
        }
        assertEq([...L.fieldOffsets!], want, `offsets ${where}`);
        assertEq(L.discSize, 0, `discSize on a record ${where}`);
        assertEq(L.payloadOffset, 0, `payloadOffset on a record ${where}`);
      } else if (d.kind === "variant") {
        assertEq(L.align, alignmentVariant(d.cases, pt), `align ${where}`);
        assertEq(L.size, elemSizeVariant(d.cases, pt), `size ${where}`);
        assertEq(
          L.payloadOffset,
          alignTo(L.discSize, maxCaseAlignment(d.cases, pt)),
          `payloadOffset ${where}`,
        );
        assertEq(L.fieldOffsets, null, `fieldOffsets on a variant ${where}`);
      } else {
        throw new Error(`${where}: expected a compound despecialization`);
      }
    }
  }
});

// Spot-check the two compound shapes against hand-computed bytes, so the
// kernels above are not the only oracle for the compound path either.
Deno.test("layoutOf: compound layouts against hand-computed bytes", () => {
  // record { a: u8, b: u64 } -> a at 0, one byte then 7 padding, b at 8.
  const rec: ValType = {
    kind: "record",
    fields: [
      { label: "a", type: { kind: "u8" } },
      { label: "b", type: { kind: "u64" } },
    ],
  };
  const r = layoutOf(rec, "i32");
  assertEq(r.align, 8, "record align");
  assertEq(r.size, 16, "record size");
  assertEq([...r.fieldOffsets!], [0, 8], "record offsets");

  // variant with 3 cases (1-byte discriminant) and an f64 payload: the
  // payload aligns to 8, total 16.
  const v: ValType = {
    kind: "variant",
    cases: [
      { label: "n", type: null },
      { label: "b", type: { kind: "u8" } },
      { label: "w", type: { kind: "f64" } },
    ],
  };
  const vl = layoutOf(v, "i32");
  assertEq(vl.discSize, 1, "variant discriminant width");
  assertEq(vl.payloadOffset, 8, "variant payload offset");
  assertEq(vl.align, 8, "variant align");
  assertEq(vl.size, 16, "variant size");

  // option<u32>: 2 cases -> 1-byte discriminant, payload aligns to 4.
  const o = layoutOf({ kind: "option", type: { kind: "u32" } }, "i32");
  assertEq(o.discSize, 1, "option discriminant width");
  assertEq(o.payloadOffset, 4, "option payload offset");
  assertEq(o.size, 8, "option size");
});
