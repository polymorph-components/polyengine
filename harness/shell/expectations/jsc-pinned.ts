// JSC pinned lane: required gate (issue #22), x86_64 only. The verified
// bundle in tools/shell/pins.json is mirrored under the `shell-pins` release
// because the upstream download host retains only a rolling build window.
//
// Expect the Deno baseline with no per-command deltas. An aarch64 local run
// skips this lane; the x64 CI leg must verify changes to this baseline.
// Re-measure and triage changed totals before accepting a new engine pin.

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

export default jscPinned;
