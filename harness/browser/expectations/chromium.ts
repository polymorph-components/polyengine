// Chromium lane expectation — the REQUIRED lane (docs/milestones.md M3).
//
// Chromium and Deno share V8, so the browser lane SHOULD be the Deno lane.
// **It now is, exactly**: zero deltas, and the TOTAL row below is the Deno
// lane's TOTAL row verbatim.
//
// HISTORY — FINDING M3A-1, now closed. This file used to carry 80
// `expected-fail` entries across 25 `async/` files. Their single root cause
// was a platform leak, not engine variance: `runtime/src/task/scheduler.ts`
// imported `AsyncLocalStorage` from `node:async_hooks` (a Node/Deno builtin
// no browser ships, and whose `AsyncContext` successor no browser ships
// either) to carry the activation ambient across the engine's JSPI
// continuations. The browser bundle had to substitute a synchronous-extent
// stand-in, and 80 commands fell over.
//
// Track M3A-1 removed the dependency instead of tolerating it: the runtime
// now states that ambient explicitly at the sites it owns — see the
// "engine-driven resumptions" section of `runtime/src/task/scheduler.ts`, the
// `Suspending`-import wrapper in `runtime/src/jspi/bridge.ts`, and
// `SuspensionPoint.owner`. Nothing in `runtime/src` imports a platform
// async-context facility any more (docs/architecture.md §4.3), so the browser bundle
// substitutes nothing and the lane has nothing to excuse.
//
// KEEP THIS LIST EMPTY. It is the detector this lane exists for: any entry
// appearing here again means Chromium diverged from Deno, and the first
// question to ask is whether something re-introduced a Node-only dependency
// or a JSPI resumption path that nobody claims the ambient for.
//
// Measured 2026-08-09 on HeadlessChrome/151.0.7922.34 (playwright 1.62.1,
// linux-arm64). JSPI is present and functional (`WebAssembly.Suspending` /
// `promising` + a live suspend/resume round trip).
//
// CM#705 pin advance to 2f13265 (polyengine#173): re-measured (this host is
// aarch64) — full Deno-lane parity holds exactly, zero deltas, zero stale
// deltas. Corpus grew 1416->1475 commands; see harness/src/xfail.ts and
// harness/shell/expectations/sm-pinned.ts's header for the new-class
// breakdown (engine-independent by construction).

import type { LaneExpectation } from "./types.ts";

export const chromium: LaneExpectation = {
  lane: "chromium",
  required: true,
  notes:
    "Same V8 as Deno, and now the same results: FULL DENO PARITY, zero deltas. " +
    "FINDING M3A-1 (the node:async_hooks dependency) is fixed in the runtime, not shimmed. " +
    "Any delta at all is a gate failure.",
  deltas: [],
  // Identical to the Deno lane's TOTAL row.
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

export default chromium;
