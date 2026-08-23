// Unit tests for harness/src/value-mapping.ts's arity-collapse and
// empty-expected comparison paths. Regression coverage for issue #188:
// `assert_return` with zero expected results never checked the actual
// value returned by the export (two stacked discard sites).

import { collapseResultsByArity, compareValues } from "../src/value-mapping.ts";

function assertEq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual, (_k, v) => typeof v === "bigint" ? `${v}n` : v);
  const e = JSON.stringify(expected, (_k, v) => typeof v === "bigint" ? `${v}n` : v);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

function assertThrows(fn: () => void, msgContains: string, what: string) {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes(msgContains)) {
      throw new Error(
        `${what}: expected error containing "${msgContains}", got "${msg}"`,
      );
    }
    return;
  }
  throw new Error(`${what}: expected throw, but function returned normally`);
}

// --- compareValues: empty-expected must not vacuously pass ---

Deno.test("compareValues([], undefined) passes", () => {
  assertEq(compareValues([], undefined), undefined, "match");
});

Deno.test("compareValues([], 5) is a mismatch", () => {
  const m = compareValues([], 5);
  if (m === undefined) throw new Error("expected mismatch, got pass");
});

Deno.test("compareValues([], 0n) is a mismatch and does not throw", () => {
  // bigint must not blow up describeValue's JSON.stringify use.
  const m = compareValues([], 0n);
  if (m === undefined) throw new Error("expected mismatch, got pass");
});

// --- collapseResultsByArity ---

Deno.test("arity 0 + undefined -> []", () => {
  assertEq(collapseResultsByArity(undefined, 0, "f"), [], "arity0-ok");
});

Deno.test("arity 0 + spurious value throws naming the field", () => {
  assertThrows(() => collapseResultsByArity(42, 0, "f"), "'f'", "arity0-bad");
});

Deno.test("arity 0 + spurious bigint throws (bigint-safe message)", () => {
  assertThrows(() => collapseResultsByArity(7n, 0, "f"), "'f'", "arity0-bigint");
});

Deno.test("arity 1 + bare value -> [v]", () => {
  assertEq(collapseResultsByArity(42, 1, "f"), [42], "arity1-ok");
});

Deno.test("arity 1 + array value -> [arr] (deliberate deviation from issue text)", () => {
  // A single list<T>/tuple result IS a JS array; must NOT throw.
  const arr = [1, 2, 3];
  assertEq(collapseResultsByArity(arr, 1, "f"), [arr], "arity1-array");
});

Deno.test("arity 1 + undefined throws", () => {
  assertThrows(() => collapseResultsByArity(undefined, 1, "f"), "'f'", "arity1-undef");
});

Deno.test("arity 2 + matching-length array returned as-is", () => {
  const arr = [1, 2];
  assertEq(collapseResultsByArity(arr, 2, "f"), arr, "arity2-ok");
});

Deno.test("arity 2 + wrong-length array throws", () => {
  assertThrows(() => collapseResultsByArity([1], 2, "f"), "'f'", "arity2-wronglen");
});

Deno.test("arity 2 + non-array throws", () => {
  assertThrows(() => collapseResultsByArity(42, 2, "f"), "'f'", "arity2-nonarray");
});

Deno.test("undefined declared arity + undefined -> [] (fallback)", () => {
  assertEq(collapseResultsByArity(undefined, undefined, "f"), [], "fallback-undef");
});

Deno.test("undefined declared arity + value -> [value] (fallback)", () => {
  assertEq(collapseResultsByArity(42, undefined, "f"), [42], "fallback-val");
});
