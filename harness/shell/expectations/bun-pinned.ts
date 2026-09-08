// Bun pinned lane expectation — findings-only (`required: false`) until it
// has a CI track record, the WebKit-lane precedent (issue #11: non-blocking
// until proven). Promote by flipping `required` after a few green weeks;
// deviations meanwhile print loudly but exit 0 (infrastructure failures
// still exit 2 and do gate).
//
// PIN: bun v1.3.14 (oven-sh/bun GitHub release zip, sha256-verified against
// the release's SHASUMS256.txt — tools/shell/pins.json). Both linux arches.
//
// Expect the Deno baseline with no per-command deltas under
// `BUN_JSC_useWasmMultiMemory=1`, which the driver sets (run-lane.ts):
//
//   * Stock bun 1.3.14 ships wasm multi-memory default-OFF and rejects
//     multi-memory modules with "there can at most be one Memory section for
//     now" — the CABI routinely needs >1 memory per core module, the same
//     gap that capped the pinned-WebKit browser lane (issue #11; JSC trunk
//     and the jsc-pinned shell have it default-on since rev 318852@main).
//     The implementation is vendored, just not enabled; the env flip is the
//     firefox-lane precedent (that driver sets its JSPI pref itself).
//   * JSPI, by contrast, is ON by default in stock bun (round trip
//     verified) — bun curates its own JSC option defaults, hence the
//     asymmetry with both Safari and the jsc shell.
//   * memory64 and relaxedSimd probe false; nothing in the current corpus
//     requires either (capability probes are informational). A future
//     corpus bump touching them will surface here as deviations to triage.
//
// THE FLAG IS AN UNSTABLE SURFACE: bun prints "options change between
// releases of Bun and WebKit without notice" for unknown/renamed BUN_JSC_*
// options (and silently ignores them otherwise). The pin freezes that risk.
// A RE-PIN MUST RE-VERIFY the option name and re-measure: a bun that
// renames or drops `useWasmMultiMemory` loses multi-memory support, which
// this expectation reports as a totals mismatch even in a findings lane.

import type { ShellLaneExpectation } from "./types.ts";

export const bunPinned: ShellLaneExpectation = {
  lane: "bun-pinned",
  required: false,
  notes:
    "Bun pinned (v1.3.14, GitHub release zip, sha256-verified, both arches; " +
    "vendored JSC). Exact Deno-lane parity under BUN_JSC_useWasmMultiMemory=1 " +
    "(driver-set; stock bun lacks multi-memory -> 174 failures). JSPI on by " +
    "default. Findings-only until a CI track record, then promote.",
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

export default bunPinned;
