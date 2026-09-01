// Firefox lane expectation — a findings lane (best-effort, non-gating).
//
// RESULT (2026-08-09, Firefox/153.0 via playwright 1.62.1, linux-arm64,
// headless, launched with `javascript.options.wasm_js_promise_integration =
// true`): **the lane runs the full corpus, Deno-identical.** All 59 files,
// 1395 commands.
//
// ENGINE FINDINGS
// ---------------
// 1. JSPI WORKS on Firefox behind the pref, end to end. The in-page probe
//    (`harness/browser/entry.ts` `probeJspi`) builds a module with a
//    `Suspending` import, wraps the export with `WebAssembly.promising`, and
//    gets the suspended value back: `{suspending: true, promising: true,
//    roundTrip: true}`. docs/architecture.md §12 (Risks) lists "Firefox: flagged" as an accepted
//    risk that a pref flip resolves; the flip is sufficient — no
//    SpiderMonkey JSPI bug is visible from this corpus. Nothing in the
//    empirical pins (a)-(j) misfires here: with the runtime's ambient made
//    explicit (M3A-1, below), Firefox reproduces the Deno lane command for
//    command.
// 2. Trap wording (SpiderMonkey vs. V8) is no longer a lane delta. The
//    runtime passes each engine's raw core-trap text through unmodified
//    (`mapCoreException`, runtime/src/exec/boundary.ts); suite-wording
//    normalization (per docs/architecture.md §1, the suite's `assert_trap`
//    text is de facto wasmtime/V8 wording) now lives harness-side in
//    `TRAP_MESSAGE_EQUIVALENTS` (harness/src/runner.ts), which carries
//    SpiderMonkey's "unreachable executed" spelling alongside V8's and JSC's
//    for `async/builtin-trap-poisons-instance.wast:9`. The trap happens at
//    the right place and poisons the instance identically; only the message
//    text ever differed.
//
// FINDING M3A-1 IS CLOSED. This file used to carry 80 further entries,
// identical to Chromium's, for the runtime's `node:async_hooks` dependency.
// Track M3A-1 removed that dependency from `runtime/src` (see
// `harness/browser/expectations/chromium.ts` for the summary), so SpiderMonkey
// now reproduces the Deno lane exactly.
//
// CM#705 pin advance to 2f13265 (polyengine#173): re-measured (this host is
// aarch64) — full Deno-lane parity holds exactly, zero deltas, zero stale
// deltas. Corpus grew 1416->1475 commands; see harness/src/xfail.ts and
// harness/shell/expectations/sm-pinned.ts's header for the new-class
// breakdown (engine-independent by construction).

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

export default firefox;
