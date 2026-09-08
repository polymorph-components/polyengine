// Firefox lane expectation — a findings lane (best-effort, non-gating).
//
// The driver enables `javascript.options.wasm_js_promise_integration`;
// these expectations do not describe Firefox's default configuration.
// `probeJspi` in harness/browser/entry.ts checks a live suspend/resume trip.
// The baseline has no per-command deltas from Deno. Core-trap wording is
// normalized by `TRAP_MESSAGE_EQUIVALENTS` in harness/src/runner.ts, not by
// the runtime. The platform async-context failure class M3A-1 is closed.

import type { LaneExpectation } from "./types.ts";

export const firefox: LaneExpectation = {
  lane: "firefox",
  required: false,
  notes:
    "Firefox 153 + javascript.options.wasm_js_promise_integration. JSPI verified working end to end. " +
    "No deltas: corpus Deno-identical (trap wording now normalized harness-side).",
  deltas: [],
  // Findings lane: totals are recorded for drift detection but the driver
  // does not gate on them (`required: false`).
  totals: {
    commands: 1511,
    executed: 1411,
    passed: 1285,
    failed: 0,
    xfail: 126,
    pendingRuntime: 95,
    pendingCapability: 0,
    unsupportedDirective: 5,
  },
};

export default firefox;
