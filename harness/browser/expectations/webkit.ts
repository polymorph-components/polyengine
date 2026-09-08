// WebKit lane expectation — a findings lane (best-effort, non-gating).
//
// ENGINE FINDINGS
// ---------------
// 1. The pinned Playwright WebKit build passes the in-page JSPI round-trip
//    probe without flags. This does not establish support in shipping Safari.
// 2. The pinned build rejects multi-memory modules at compile time. FACT
//    adapters can require multiple memories for cross-component copies and
//    transcoding. Subsequent commands cascade from failed instantiations.
//    The gap is tracked in https://github.com/polymorph-components/polyengine/issues/11;
//    newer WebKit builds have demonstrated multi-memory support. Re-measure
//    when advancing the pin and remove deltas that the stale-delta detector
//    identifies, rather than carrying the overlay forward unchanged.
// 3. Trap wording (JSC vs. V8) is normalized harness-side. JSC says
//    "Unreachable code should not be executed" for the core `unreachable`
//    trap where the suite expects the wasmtime/V8 wording
//    (docs/architecture.md §1); the runtime passes each engine's raw text
//    through unmodified (`mapCoreException`, runtime/src/exec/boundary.ts)
//    and the harness normalizes it (`TRAP_MESSAGE_EQUIVALENTS`,
//    harness/src/runner.ts).
//
// M3A-1 (platform async-context dependency) is closed. Cascades in this
// overlay are attributed to finding 2's multi-memory compile rejection.

import type { LaneExpectation } from "./types.ts";

export const webkit: LaneExpectation = {
  lane: "webkit",
  required: false,
  notes:
    "WebKit 26.5 (WPE headless). JSPI present and working unflagged. Every delta is rooted in finding 2: JSC has no multi-memory (58 direct + cascades). FINDING M3A-1 is fixed in the runtime and no longer appears here.",
  deltas: [
    {
      file: "async/big-interleaving-test.json",
      line: 823,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 825,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 828,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 837,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 842,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 845,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 857,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 864,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 874,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 885,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 897,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 907,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 912,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 915,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 935,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 947,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 965,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1025,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1059,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1105,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1133,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1161,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1207,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1257,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1289,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1345,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1393,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1406,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1408,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1415,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1418,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1428,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1437,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1439,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1446,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1449,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1458,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1470,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1482,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1492,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1505,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1521,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1534,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1545,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1556,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1569,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1585,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1593,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1595,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1601,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1604,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1615,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1634,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/big-interleaving-test.json",
      line: 1645,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 472,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 473,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 474,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 475,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 476,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 477,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 478,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 479,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 480,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 481,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 482,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 483,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 484,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 485,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 486,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 487,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 488,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 489,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 490,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 491,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 492,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 493,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 494,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 495,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 496,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 497,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 498,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 499,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 500,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 501,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 502,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 503,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 504,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 505,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 506,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 507,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 508,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 509,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 510,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 511,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 512,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 513,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 514,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 515,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 516,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 517,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 518,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/cross-abi-calls.json",
      line: 519,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/deadlock.json",
      line: 4,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/deadlock.json",
      line: 73,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/partial-stream-copies.json",
      line: 7,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/partial-stream-copies.json",
      line: 238,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "async/sync-streams.json",
      line: 7,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "async/sync-streams.json",
      line: 208,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 261,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "linking/unit.json",
      line: 295,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 296,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 297,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 298,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 299,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 300,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 301,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 302,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 308,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "linking/unit.json",
      line: 344,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 345,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 346,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 347,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 348,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 349,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 350,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 351,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 355,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "linking/unit.json",
      line: 374,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "linking/unit.json",
      line: 375,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "validation/instantiation.json",
      line: 342,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/alignment.json",
      line: 26,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/alignment.json",
      line: 27,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/alignment.json",
      line: 51,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/alignment.json",
      line: 52,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/alignment.json",
      line: 81,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/alignment.json",
      line: 82,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/alignment.json",
      line: 110,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/alignment.json",
      line: 111,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/alignment.json",
      line: 138,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/alignment.json",
      line: 139,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/alignment.json",
      line: 170,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/alignment.json",
      line: 171,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/alignment.json",
      line: 172,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/alignment.json",
      line: 173,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/alignment.json",
      line: 204,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/alignment.json",
      line: 205,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/alignment.json",
      line: 206,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/alignment.json",
      line: 207,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/concat.json",
      line: 463,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/concat.json",
      line: 723,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/concat.json",
      line: 729,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/concat.json",
      line: 732,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/concat.json",
      line: 741,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/concat.json",
      line: 748,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/concat.json",
      line: 755,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/concat.json",
      line: 762,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/concat.json",
      line: 770,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/concat.json",
      line: 788,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/realloc.json",
      line: 6,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/realloc.json",
      line: 40,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/realloc.json",
      line: 66,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/realloc.json",
      line: 67,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/realloc.json",
      line: 93,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/realloc.json",
      line: 94,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/transcode.json",
      line: 7,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/transcode.json",
      line: 113,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/transcode.json",
      line: 117,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/transcode.json",
      line: 201,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/transcode.json",
      line: 205,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/transcode.json",
      line: 319,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/transcode.json",
      line: 323,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/transcode.json",
      line: 432,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
    {
      file: "values/transcode.json",
      line: 437,
      kind: "expected-fail",
      reason:
        "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
    },
    {
      file: "values/transcode.json",
      line: 534,
      kind: "expected-fail",
      reason:
        "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
    },
  ],
  totals: {
    commands: 1416,
    executed: 1369,
    // 18 commands moved from xfail to passed when FINDING M3A-1 was fixed in
    // the runtime and its entries left this file.
    // +4 more (async/drop-cross-task-borrow:305,307, async/passing-resources
    // :175,176) when the #18 tls-smoke fixes pruned their shared xfail
    // entries — arithmetic update, NOT re-measured (webkit is not runnable
    // on this dev host); the post-merge webkit lane is the check.
    // +21 commands / +20 xfail / +1 pending-runtime from the upstream
    // during-sync-call-* tests (submodule bump to CM 4142913): all three
    // fail at TRANSLATION (wasmparser pin drift, engine-independent — see
    // harness/src/xfail.ts), so the shift is uniform across lanes —
    // arithmetic update, NOT re-measured; the post-merge webkit lane is
    // the check.
    // +3 passed / -3 xfail when #13 closed drop-stream:158 +
    // drop-cross-task-borrow:309 (trap-wording parity, engine-independent;
    // neither file has a webkit delta) and binary:1421 (plan v4 core-module
    // exports; translation + an empty-module compile, engine-independent) —
    // arithmetic update, NOT re-measured; the post-merge webkit lane is
    // the check.
    passed: 1083,
    failed: 0,
    xfail: 286,
    pendingRuntime: 42,
    pendingCapability: 0,
    unsupportedDirective: 5,
  },
};

export default webkit;
