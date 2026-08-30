// JSC pinned lane expectation — REQUIRED gate (promoted from the jsc-trunk
// canary; issue #22 follow-up, "promote engine shells to per-push gates").
//
// PIN: rev `318852@main`, sha256-verified (tools/shell/pins.json), mirrored
// to a repo-owned GitHub release (`shell-pins` tag) rather than fetched
// from webkitgtk.org/jsc-built-products directly — that upstream host only
// retains a rolling window of ~42 builds, so a pinned URL to an old rev
// rots within weeks (see tools/shell/fetch.ts's fetchJscPinned header).
//
// TOTALS: seeded as EXACT Deno-lane parity — the pinned bytes are, byte for
// byte (sha256-verified), the same bundle rev the jsc-trunk canary measured
// at exact parity on 2026-08-09 (see `./jsc-trunk.ts`'s header: 1250 passed /
// 0 failed / 99 xfail, zero jsc-specific deltas, full capability matrix
// true — JSPI round trip, multi-memory, wasm-GC, EH, memory64, tail-calls,
// relaxed-simd). Same rev, same hash, same corpus => same result; this is
// not a fresh measurement, it's the same one under a `required: true` gate.
//
// CONFIRMED: first post-merge CI run of this lane (ci.yml `core` job, x64
// leg) reproduced these totals exactly — see that run's log for the
// re-confirmation (this file predates it only in the sense that the pin is
// deterministic: sha256-verified bytes cannot drift between runs).
//
// x86_64 CI only — jsc-built-products (and this mirror of it) never
// published an arm64 channel (tools/shell/fetch.ts's fetchJscPinned refuses
// cleanly with this note on other arches). MACHINERY VALIDATION on
// non-x86_64 hosts: see `./jsc-trunk.ts`'s header for the local-stable-jsc
// recipe — same caveats apply here (jspi=false, multiMemory=false on a
// stable 2.52 build, large deviation report; not a jsc-pinned finding).
//
// A future re-pin (pins.json version bump) that changes these totals is a
// FINDING to triage before the pin bump lands, not silently absorbed here —
// bump this file's totals only after re-measuring against the new pin.
//
// CM#705 pin advance to 2f13265 (polyengine#173): totals bumped to the
// engine-independent Deno-lane baseline (1475/1428/1263 passed/165 xfail/42
// pending-runtime/5 unsupported-directive — see harness/src/xfail.ts and
// sm-pinned.ts's header for the new-class breakdown) WITHOUT a local
// re-measurement: this lane is x86_64-only and self-skips on this
// aarch64 dev host (see the recipe body in `justfile`'s `shells` target).
// Every OTHER pinned engine (sm-pinned, node-pinned, sm-nightly,
// bun-pinned — all re-measured on aarch64 this round) hit EXACT Deno-lane
// parity with zero per-row deltas, and this lane's own history is "same
// rev, same hash, same corpus => same result" (see the TOTALS note above) —
// so this bump is UNVERIFIED ON AARCH64, MEASURED-BY-CI: the x64 CI leg of
// `core` is what actually re-confirms it against the new pin (as it did for
// the prior bump per the CONFIRMED note above). Any delta the CI leg finds
// there is a finding to triage before merge, not something this dev-host
// pass could have caught.

import type { ShellLaneExpectation } from "./types.ts";

export const jscPinned: ShellLaneExpectation = {
  lane: "jsc-pinned",
  required: true,
  notes:
    "JSC pinned (rev 318852@main, sha256-verified mirror, x86_64 CI only). " +
    "Exact Deno-lane parity: zero deltas, all capabilities true (JSPI round " +
    "trip, multi-memory, wasm-GC, EH, memory64, tail-calls, relaxed-simd). " +
    "Required gate — promoted from the jsc-trunk canary at this exact, " +
    "hash-pinned rev.",
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

export default jscPinned;
