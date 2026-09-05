// Node.js pinned lane expectation — REQUIRED gate.
//
// PIN: node v26.7.0 (official nodejs.org dist tarball, sha256-verified
// against the release's SHASUMS256.txt — tools/shell/pins.json). Both linux
// arches are published, so unlike jsc-pinned this lane runs on both CI legs.
//
// TOTALS: seeded as EXACT Deno-lane parity from a local measurement
// (2026-08-11, linux-arm64 dev box, V8 14.6.202.34-node.28): 1254 passed /
// 0 failed / 95 xfail, zero node-specific deltas, full capability matrix
// true (JSPI round trip, multi-memory, wasm-GC, EH, memory64, tail-calls,
// relaxed-simd) — with NO runtime flags: wasm JSPI is on by default in
// node >= 26, exactly as docs/architecture.md §3's engine table recorded.
// Like jsc-pinned's seeding, determinism does the heavy lifting: pinned
// bytes + pinned corpus + pinned shim flags; confirm on the first CI run.
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
// WHAT THIS LANE ADDS over the Deno lane (same V8 family): the node
// EMBEDDING — ESM loading of the bundle, the node event loop under the
// scheduler, and node's pooled-Buffer I/O (tools/shell/host-node.mjs must
// copy out of the pool before bytes reach WebAssembly APIs; handing the
// pool-backed .buffer to wasm is a classic node-embedder defect this lane
// would catch). Raw-engine coverage was already carried by the shell and
// browser lanes; this pin is about the runtime consumers actually deploy.
//
// CM#705 pin advance to 2f13265 (polyengine#173): re-measured (this host is
// aarch64) — full Deno-lane parity holds exactly, zero deltas, zero stale
// xfails. Corpus grew 1416->1475 commands; see harness/src/xfail.ts and
// sm-pinned.ts's header for the new-class breakdown (engine-independent by
// construction).

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
    passed: 1281,
    failed: 0,
    xfail: 130,
    pendingRuntime: 95,
    pendingCapability: 0,
    unsupportedDirective: 5,
  },
};

export default nodePinned;
