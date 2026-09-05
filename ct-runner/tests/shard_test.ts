// Shard option tests (issue #110): striping partition identity, suite-order
// restoration via emit's caseIndex, `shard` validation, and shard x `only`
// filter interaction. Uses the same test-suite fixture as golden_test.ts /
// e2e_test.ts (6 enumerated cases).

import { assertEq } from "../../runtime/tests/support/asserts.ts";
import { runSuite } from "../src/mod.ts";
import { artifactsOf, haveFixture, TEST_SUITE_WASM } from "./support.ts";

function assert(cond: boolean, msg = ""): void {
  if (!cond) throw new Error(msg || "assertion failed");
}

/** Strip `duration-ms` (nondeterministic wall-clock) for stable comparison,
 * same normalization golden_test.ts applies. */
// deno-lint-ignore no-explicit-any
function normalize(line: string): string {
  const v = JSON.parse(line);
  if (typeof v["duration-ms"] === "number") delete v["duration-ms"];
  return JSON.stringify(v);
}

const ready = await haveFixture(TEST_SUITE_WASM);

/** Case-result rows only (drop envelope + terminator), keyed by their
 * caseIndex as passed to `emit`. */
function collectCaseRows(
  artifacts: Awaited<ReturnType<typeof artifactsOf>>,
  shard?: { index: number; count: number },
) {
  const rows: { line: string; caseIndex?: number }[] = [];
  return runSuite(artifacts, {
    target: "wasmtime/polyengine",
    suiteName: "test-suite",
    shard,
    emit: (line, caseIndex) => rows.push({ line, caseIndex }),
  }).then((counts) => ({ rows, counts }));
}

Deno.test({
  name: "shard: partition identity — union of shards == unsharded, disjoint",
  ignore: !ready,
  fn: async () => {
    const artifacts = await artifactsOf(TEST_SUITE_WASM);

    const unsharded = await collectCaseRows(artifacts);
    const unshardedCaseLines = unsharded.rows.filter((r) =>
      r.caseIndex !== undefined
    );

    const count = 3;
    const shardedCaseLines: { line: string; caseIndex?: number }[] = [];
    const seenIndices = new Set<number>();
    for (let index = 0; index < count; index++) {
      const { rows } = await collectCaseRows(artifacts, { index, count });
      for (const r of rows) {
        if (r.caseIndex === undefined) continue; // envelope/terminator
        // Disjoint: no case index emitted by two different shards.
        assert(
          !seenIndices.has(r.caseIndex),
          `caseIndex ${r.caseIndex} emitted by more than one shard`,
        );
        seenIndices.add(r.caseIndex);
        // Stripe membership matches the documented i % count === index rule.
        assertEq(r.caseIndex % count, index);
        shardedCaseLines.push(r);
      }
    }

    // Union (restored to suite order) == the unsharded case lines.
    shardedCaseLines.sort((a, b) => a.caseIndex! - b.caseIndex!);
    assertEq(
      shardedCaseLines.map((r) => normalize(r.line)),
      unshardedCaseLines.map((r) => normalize(r.line)),
    );
  },
});

Deno.test({
  name: "shard: suite-order-index restoration merges two stripes back in order",
  ignore: !ready,
  fn: async () => {
    const artifacts = await artifactsOf(TEST_SUITE_WASM);
    const unsharded = await collectCaseRows(artifacts);
    const unshardedNames = unsharded.rows
      .filter((r) => r.caseIndex !== undefined)
      .map((r) => JSON.parse(r.line).case);

    const count = 2;
    const merged: { caseIndex: number; line: string }[] = [];
    for (let index = 0; index < count; index++) {
      const { rows } = await collectCaseRows(artifacts, { index, count });
      for (const r of rows) {
        if (r.caseIndex === undefined) continue;
        merged.push({ caseIndex: r.caseIndex, line: r.line });
      }
    }
    merged.sort((a, b) => a.caseIndex - b.caseIndex);
    const mergedNames = merged.map((r) => JSON.parse(r.line).case);
    assertEq(mergedNames, unshardedNames);
  },
});

Deno.test({
  name: "shard: validation rejects non-integer/out-of-range index or count",
  ignore: !ready,
  fn: async () => {
    const artifacts = await artifactsOf(TEST_SUITE_WASM);

    const cases: Array<{ index: number; count: number }> = [
      { index: 0, count: 0 },
      { index: 0, count: -1 },
      { index: 0, count: 1.5 },
      { index: -1, count: 2 },
      { index: 2, count: 2 },
      { index: 1.5, count: 2 },
    ];
    for (const shard of cases) {
      let threw = false;
      try {
        await runSuite(artifacts, {
          target: "wasmtime/polyengine",
          suiteName: "test-suite",
          shard,
          emit: () => {},
        });
      } catch (e) {
        threw = true;
        assert(
          e instanceof Error,
          `expected an Error for shard=${JSON.stringify(shard)}`,
        );
      }
      assert(threw, `expected shard=${JSON.stringify(shard)} to throw`);
    }
  },
});

Deno.test({
  name: "shard x filter: stripe membership decided before `only` filtering",
  ignore: !ready,
  fn: async () => {
    const artifacts = await artifactsOf(TEST_SUITE_WASM);

    // Unsharded, filtered: the full set of `only`-matching rows in suite
    // order — the identity this pins is that summing every shard's
    // `only`-filtered output (in suite order) reproduces this exactly.
    const unshardedFiltered = await runSuite(artifacts, {
      target: "wasmtime/polyengine",
      suiteName: "test-suite",
      only: "suite/",
      emit: () => {},
    }).then(async () => {
      const rows: { line: string; caseIndex?: number }[] = [];
      await runSuite(artifacts, {
        target: "wasmtime/polyengine",
        suiteName: "test-suite",
        only: "suite/",
        emit: (line, caseIndex) => rows.push({ line, caseIndex }),
      });
      return rows.filter((r) => r.caseIndex !== undefined);
    });

    const count = 2;
    const shardedFiltered: { caseIndex: number; line: string }[] = [];
    for (let index = 0; index < count; index++) {
      const rows: { line: string; caseIndex?: number }[] = [];
      await runSuite(artifacts, {
        target: "wasmtime/polyengine",
        suiteName: "test-suite",
        only: "suite/",
        shard: { index, count },
        emit: (line, caseIndex) => rows.push({ line, caseIndex }),
      });
      for (const r of rows) {
        if (r.caseIndex === undefined) continue;
        // Every emitted row still respects the stripe rule, even though
        // `only` also filtered some cases out of this run.
        assertEq(r.caseIndex % count, index);
        shardedFiltered.push({ caseIndex: r.caseIndex, line: r.line });
      }
    }
    shardedFiltered.sort((a, b) => a.caseIndex - b.caseIndex);
    assertEq(
      shardedFiltered.map((r) => normalize(r.line)),
      unshardedFiltered.map((r) => normalize(r.line)),
    );
  },
});

Deno.test({
  name: "shard: absent behaves byte-identically to today (no caseIndex needed)",
  ignore: !ready,
  fn: async () => {
    const artifacts = await artifactsOf(TEST_SUITE_WASM);
    const lines: string[] = [];
    const counts = await runSuite(artifacts, {
      target: "wasmtime/polyengine",
      suiteName: "test-suite",
      emit: (l) => lines.push(l),
    });
    assertEq(counts, {
      passed: 4,
      failed: 1,
      skipped: 1,
      na: 0,
      deselected: 0,
      selected: 6,
      total: 6,
    });
    assertEq(lines.length, 8); // envelope + 6 cases + terminator
  },
});
