// SpiderMonkey pinned lane expectation — REQUIRED gate (promoted from the
// sm-nightly canary; issue #22 follow-up, "promote engine shells to
// per-push gates").
//
// PIN: Firefox release 153.0 jsshell (tools/shell/pins.json), matching the
// browser lane's Firefox version exactly — sha256-verified, both arches
// (archive.mozilla.org release archives are permanent, unlike
// jsc-built-products' rolling window, so no mirror is needed here — see
// tools/shell/fetch.ts's fetchSpiderMonkeyPinned header).
//
// SHELL vs BROWSER CONFIG (important distinction — read before trusting
// this file as a stand-in for "Firefox 153 ships JSPI"): this jsshell has
// JSPI ENABLED BY DEFAULT (verified empirically, see the RESULT below) —
// UNLIKE the Firefox 153 *browser*, which gates JSPI behind the
// `javascript.options.wasm_js_promise_integration` pref (the browser lane's
// driver sets that pref explicitly; see
// `harness/browser/expectations/firefox.ts`). The jsshell is a
// developer/testing build with different default flags than the shipping
// browser config — this lane measures the ENGINE's capability ceiling, not
// what ships to users. The browser lane (post-merge only as of this track)
// remains the check for the actual shipping-config surface.
//
// RESULT (2026-08-09, seed run — this host is aarch64; the release-153
// jsshell ships an aarch64 build, sha256-verified via pins.json):
// **the lane runs the full corpus, EXACT Deno-lane parity.** All 59 files,
// 1395 commands, 1349 executed, 1254 passed, 0 failed, 95 xfail, 41
// pending-runtime, 0 pending-capability, 5 unsupported-directive. Zero
// deltas, zero stale xfails, zero unexpected failures. Capability matrix:
// jspi = {suspending: true, promising: true, roundTrip: true}, multiMemory
// = true, wasmGc = true, exceptionHandling = true, memory64 = true,
// tailCalls = true, relaxedSimd = true — multi-memory shipped in Fx125, so
// full parity here was expected; it held exactly, no deltas to record.
//
// Any future re-pin (pins.json version bump) that changes these totals is a
// FINDING to triage before the pin bump lands, not silently absorbed here —
// bump this file's totals only after re-measuring against the new pin.
//
// CM#705 pin advance to 2f13265 (polyengine#173): re-measured (this host is
// aarch64) — full Deno-lane parity holds exactly, zero deltas, zero stale
// xfails. Corpus grew 1416->1475 commands (new reentrance.wast/
// during-sync-scheduling-candidates.wast/during-sync-call-exclusive-resume.
// wast files, new kebab.wast/max-value-size.wast assert_invalid rows, plus
// a few line-shifted-but-unchanged rows); the new xfail classes
// (fact-reentrance-47, cm705-sync-sched, cm707-cancel, name-rules-47,
// max-value-size-47, plus growth in the pre-existing wasmparser
// thread-built-in pin-drift class) are translate-time / our-own-runtime
// drift, engine-independent by construction — see harness/src/xfail.ts.

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
    commands: 1475,
    executed: 1428,
    passed: 1263,
    failed: 0,
    xfail: 165,
    pendingRuntime: 42,
    pendingCapability: 0,
    unsupportedDirective: 5,
  },
};

export default smPinned;
