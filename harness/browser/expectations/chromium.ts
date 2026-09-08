// Chromium is the required browser lane: expect the Deno totals and no
// per-command deltas. Keep this list empty; investigate divergence rather
// than masking it. In particular, check platform-only dependencies and
// unclaimed JSPI resumption context (the closed M3A-1 failure class).

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

export default chromium;
