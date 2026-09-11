// Schema-round-trip validation: each emitted CaseResult/Envelope line must
// parse per the upstream normative shapes in
// polymorph-test/crates/component-test-results/src/lib.rs (the L4 schema
// authority): `Envelope` (component-test-results/target/suite/run),
// `CaseResult` (case/status/provenance/detail/duration-ms/diagnostics/
// diagnostics-complete) and the frozen status/provenance wire vocabulary
// (`wire_vocabulary_pinned` test in that file). This test hand-checks the
// same field set and vocabulary in TS (no shared crate to link against from
// here), citing the exact upstream fields each assertion matches.

import { assertEq } from "../../runtime/tests/support/asserts.ts";
import { runSuite } from "../src/mod.ts";
import { artifactsOf, haveFixture, TEST_SUITE_WASM } from "./support.ts";

const ready = await haveFixture(TEST_SUITE_WASM);

const STATUSES = new Set([
  "pass",
  "fail",
  "skipped",
  "not-reached",
  "not-applicable",
  "deselected",
]);

function checkProvenance(p: unknown): void {
  if (p === undefined) return; // not-applicable/deselected/not-reached carry none
  if (p === "returned" || p === "trap") return;
  if (
    p !== null && typeof p === "object" && "limit-exceeded" in (p as object)
  ) {
    assertEq(
      typeof (p as { "limit-exceeded": unknown })["limit-exceeded"],
      "string",
    );
    return;
  }
  throw new Error(`unrecognized provenance shape: ${JSON.stringify(p)}`);
}

Deno.test({
  name: "L4 schema: envelope + every case line round-trips the upstream shape",
  ignore: !ready,
  fn: async () => {
    const artifacts = await artifactsOf(TEST_SUITE_WASM);
    const lines: string[] = [];
    await runSuite(artifacts, {
      target: "wasmtime/polyengine",
      suiteName: "test-suite",
      caseTimeoutMs: 5000,
      emit: (l) => lines.push(l),
    });

    assertEq(lines.length >= 3, true);
    const envelope = JSON.parse(lines[0]);
    // Envelope: `component-test-results` (version tag, RESULTS_VERSION),
    // `target` (string), `suite.name` (string), `run.segment` (u32) — the
    // Rust `Envelope`/`SuiteInfo`/`RunInfo` structs' required fields.
    assertEq(envelope["component-test-results"], "0.1");
    assertEq(typeof envelope.target, "string");
    assertEq(typeof envelope.suite.name, "string");
    assertEq(typeof envelope.run.segment, "number");
    // `run.scheduling`: additive string vocabulary; "none" means "execute
    // everything" (RunInfo doc comment) — correct for a runner with no tag
    // scheduling.
    assertEq(envelope.run.scheduling, "none");

    const terminator = lines[lines.length - 1];
    assertEq(terminator, '{"segment-end":true}');

    for (const line of lines.slice(1, -1)) {
      const ev = JSON.parse(line);
      // CaseResult required/typed fields.
      assertEq(typeof ev.case, "string");
      assertEq(ev.case.length > 0, true);
      assertEq(STATUSES.has(ev.status), true, `status: ${ev.status}`);
      checkProvenance(ev.provenance);
      if (ev.detail !== undefined) assertEq(typeof ev.detail, "string");
      if (ev["duration-ms"] !== undefined) {
        assertEq(typeof ev["duration-ms"], "number");
      }
      if (ev.diagnostics !== undefined) {
        assertEq(Array.isArray(ev.diagnostics), true);
        for (const d of ev.diagnostics) assertEq(typeof d, "string");
      }
      // `diagnostics-complete` defaults true (Rust `#[serde(default =
      // "default_true")]`); this runner always emits it explicitly except on
      // the plain-pass path, which is fine — its ABSENCE also means true.
      if (ev["diagnostics-complete"] !== undefined) {
        assertEq(typeof ev["diagnostics-complete"], "boolean");
      }
      // Never a dual error channel: exactly one status, provenance present
      // iff the case executed.
      const executed = ev.status === "pass" || ev.status === "fail" ||
        ev.status === "skipped";
      assertEq(
        executed === (ev.provenance !== undefined),
        true,
        `executed/provenance mismatch: ${line}`,
      );
    }
  },
});
