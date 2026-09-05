// Golden-file test: emitted JSONL for the `test-suite` fixture, modulo
// nondeterministic fields. Mirrors how polymorph-test's own golden samples
// (expected/verify-pipeline-fixture.jsonl) handle timing: that repo has no
// duration-ms in its samples at all (harness.mjs's plain `envelope()` never
// emits timing), and normalizes `artifact-sha256` to the literal placeholder
// `<sha256>` — same normalization applied here, plus `duration-ms` stripped
// (this runner does emit it; upstream's schema marks it optional/nullable,
// component-test-results/src/lib.rs `CaseResult.duration_ms`).

import { assertEq } from "../../runtime/tests/support/asserts.ts";
import { runSuite } from "../src/mod.ts";
import { artifactsOf, haveFixture, TEST_SUITE_WASM } from "./support.ts";

const ready = await haveFixture(TEST_SUITE_WASM);

/** Strip nondeterministic fields for a byte-stable comparison. */
// deno-lint-ignore no-explicit-any
function normalize(line: string): string {
  const v = JSON.parse(line);
  if (v.suite?.["artifact-sha256"]) v.suite["artifact-sha256"] = "<sha256>";
  if (typeof v["duration-ms"] === "number") delete v["duration-ms"];
  return JSON.stringify(v);
}

Deno.test({
  name: "golden: test-suite fixture emits the expected JSONL shape",
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

    const got = lines.map(normalize).join("\n") + "\n";
    const want = await Deno.readTextFile(
      new URL("./expected/test-suite.jsonl", import.meta.url),
    );
    assertEq(got, want, `${got}\n---\n${want}`);
  },
});
