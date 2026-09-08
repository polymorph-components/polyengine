// SpiderMonkey pinned lane: required gate (issue #22). The release jsshell
// in tools/shell/pins.json is hash-verified on both supported Linux arches.
//
// This shell enables JSPI by default, unlike the Firefox browser pin, whose
// lane sets `javascript.options.wasm_js_promise_integration` explicitly.
// Neither lane establishes JSPI availability in the default browser config.
// Expect the Deno baseline with no per-command deltas. Re-measure and triage
// changed totals before accepting a new engine pin; shared failure classes
// are recorded in harness/src/xfail.ts.

import type { ShellLaneExpectation } from "./types.ts";

export const smPinned: ShellLaneExpectation = {
  lane: "sm-pinned",
  required: true,
  notes:
    "SpiderMonkey pinned (Firefox release 153.0 jsshell, sha256-verified, " +
    "both arches). Full Deno parity: zero deltas, all compile-probes true " +
    "(multi-memory/wasm-GC/EH/memory64/tail-calls/relaxed-simd), JSPI " +
    "enabled by default in this shell build (unlike the Firefox 153 " +
    "browser, which prefs it — see header). Required gate — promoted from " +
    "the sm-nightly canary.",
  deltas: [],
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

export default smPinned;
