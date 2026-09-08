// Node.js pinned lane expectation — REQUIRED gate.
//
// PIN: node v26.7.0 (official nodejs.org dist tarball, sha256-verified
// against the release's SHASUMS256.txt — tools/shell/pins.json). Both linux
// arches are published, so unlike jsc-pinned this lane runs on both CI legs.
//
// Expect the Deno baseline with no per-command deltas or runtime flags.
// JSPI is enabled by default in this pin.
//
// WHY 26.x AND NOT 24 LTS (measured, same box, same corpus): node 24.18's
// V8 13.6 gates JSPI behind `--experimental-wasm-jspi`, and even with the
// flag its older-vintage JSPI deviates on 2 commands
// (async/dont-block-start.json:3 and :24, assert_uninstantiable — the
// runtime classifies pending-capability "instantiation-time task context"
// instead of delivering the expected instantiation trap). Both pass on
// node 26 / V8 14.6. Recorded so nobody re-lanes the LTS expecting clean
// parity: a node-24 lane needs flag plumbing AND a 2-delta overlay.
//
// This lane also exercises Node's embedding: ESM loading, its event loop,
// and pooled-Buffer I/O. tools/shell/host-node.mjs must pass only the intended
// bytes to WebAssembly APIs, not a Buffer's entire backing pool.

import type { ShellLaneExpectation } from "./types.ts";

export const nodePinned: ShellLaneExpectation = {
  lane: "node-pinned",
  required: true,
  notes:
    "Node.js pinned (v26.7.0, nodejs.org tarball, sha256-verified, both " +
    "arches). Exact Deno-lane parity with no flags (JSPI default-on in " +
    ">= 26): zero deltas, all capabilities true. Required gate. Node 24 LTS " +
    "is deliberately not laned — flag-gated JSPI with 2 real deviations " +
    "(see this file's header).",
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

export default nodePinned;
