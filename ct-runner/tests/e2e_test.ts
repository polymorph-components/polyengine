// Integration: the fixture suite end to end through `runSuite`, asserting
// the case-loop policy mirrored from js/viewer/harness.mjs `runCases`/
// `runSuiteJsonl`: fresh instance per case (default), diagnostics attached
// to the right case, `only` reports the unselected remainder as
// `deselected` rows (never omitted), and counts.

import { assertEq } from "../../runtime/tests/support/asserts.ts";
import { runSuite } from "../src/mod.ts";
import { artifactsOf, haveFixture, TEST_SUITE_WASM } from "./support.ts";

const ready = await haveFixture(TEST_SUITE_WASM);

Deno.test({
  name: "e2e: fixture suite -> runner -> full JSONL, all six cases",
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
    assertEq(lines.length, 1 + 6 + 1); // envelope + 6 cases + terminator

    const events = lines.slice(1, -1).map((l) => JSON.parse(l));
    assertEq(events.map((e) => e.case), [
      "suite/basic/pass",
      "suite/basic/fail",
      "suite/basic/skip",
      "suite/diag/chatty",
      "suite/diag/slow",
      "suite/nested/deep/leaf",
    ]);

    // Diagnostics attached to the RIGHT case (not leaked across cases: the
    // fresh-instance-per-case policy plus a fresh diagnostics sink per case
    // means suite/basic/pass carries none, suite/diag/chatty carries all
    // three of its own messages and nothing from suite/diag/slow).
    const byCase = Object.fromEntries(events.map((e) => [e.case, e]));
    assertEq(byCase["suite/basic/pass"].diagnostics, undefined);
    assertEq(byCase["suite/diag/chatty"].diagnostics, [
      "starting the chatty case",
      "midpoint observation: ok",
      "finishing up",
    ]);
    assertEq(byCase["suite/diag/slow"].diagnostics, ["sleeping briefly"]);

    // The failing/skipping cases carry their outcome payload as `detail`.
    assertEq(byCase["suite/basic/fail"].status, "fail");
    assertEq(byCase["suite/basic/fail"].detail, "expected 2 + 2 = 4, got 5");
    assertEq(byCase["suite/basic/skip"].status, "skipped");
    assertEq(
      byCase["suite/basic/skip"].detail,
      "declared hardware token unavailable at run time",
    );

    // Budget plumbing: every executed case carries a numeric duration-ms.
    for (const e of events) {
      assertEq(typeof e["duration-ms"], "number");
      assertEq(e["duration-ms"] >= 0, true);
    }
  },
});

Deno.test({
  name: "e2e: `only` reports the unselected remainder as `deselected` rows",
  ignore: !ready,
  fn: async () => {
    const artifacts = await artifactsOf(TEST_SUITE_WASM);
    const lines: string[] = [];
    const counts = await runSuite(artifacts, {
      target: "t",
      suiteName: "test-suite",
      only: "diag/",
      emit: (l) => lines.push(l),
    });
    const rows = lines.slice(1, -1).map((l) => JSON.parse(l));
    assertEq(rows.length, 6, "every census case still gets a row");
    assertEq(rows.map((r) => r.case), [
      "suite/basic/pass",
      "suite/basic/fail",
      "suite/basic/skip",
      "suite/diag/chatty",
      "suite/diag/slow",
      "suite/nested/deep/leaf",
    ]);
    // The two `diag/` cases execute normally; the rest are exactly the
    // `deselected` row shape (harness.mjs:197): case, status, detail — no
    // other fields.
    const byCase = Object.fromEntries(rows.map((r) => [r.case, r]));
    for (
      const name of [
        "suite/basic/pass",
        "suite/basic/fail",
        "suite/basic/skip",
        "suite/nested/deep/leaf",
      ]
    ) {
      assertEq(byCase[name], {
        case: name,
        status: "deselected",
        detail: "only diag/",
      });
    }
    assertEq(byCase["suite/diag/chatty"].status, "pass");
    assertEq(byCase["suite/diag/slow"].status, "pass");
    assertEq(counts, {
      passed: 2,
      failed: 0,
      skipped: 0,
      na: 0,
      deselected: 4,
      selected: 2,
      total: 6,
    });
  },
});

Deno.test({
  name: "e2e: `only` matching nothing is a run error (unsharded)",
  ignore: !ready,
  fn: async () => {
    const artifacts = await artifactsOf(TEST_SUITE_WASM);
    let threw = "";
    try {
      await runSuite(artifacts, {
        target: "t",
        suiteName: "test-suite",
        only: "no-such-case",
        emit: () => {},
      });
    } catch (e) {
      threw = String(e);
    }
    assertEq(threw.includes("matches no cases"), true);
  },
});

Deno.test({
  name: "e2e: freshCases=false still runs to completion (single shared instance)",
  ignore: !ready,
  fn: async () => {
    const artifacts = await artifactsOf(TEST_SUITE_WASM);
    const lines: string[] = [];
    const counts = await runSuite(artifacts, {
      target: "t",
      suiteName: "test-suite",
      freshCases: false,
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
  },
});
