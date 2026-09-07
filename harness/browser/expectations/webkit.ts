// WebKit lane expectation — a findings lane (best-effort, non-gating).
//
// RESULT (2026-08-09, playwright 1.62.1 webkit build 2336 =
// Safari/WebKit 26.5, linux-arm64 WPE headless): **the lane runs the full
// corpus.** All 59 files, 1395 commands, 10.3 s wall clock — the fastest of
// the three engines.
//
// GETTING IT TO LAUNCH (this host is Ubuntu questing/25.10; playwright's
// WebKit bundle is linked against the Ubuntu 24.04 ABI, so
// `playwright install-deps` cannot satisfy it — libicu74 in particular has no
// questing candidate). Recipe, all outside the repo except the browser cache:
// fetch the noble arm64 .debs for libicu74, libxml2, libavif16 (+ its codec
// deps libdav1d7 libgav1-1 librav1e0 libyuv0 libSvtAv1Enc1d1 libabsl…),
// libenchant-2-2, libevent-2.1-7t64, libflite1,
// libgstreamer-plugins-bad1.0-0, libharfbuzz-icu0, libhyphen0,
// libmanette-0.2-0, libwayland-server0, libevdev2; `dpkg-deb -x` them; copy
// the resulting `usr/lib/aarch64-linux-gnu/*.so*` into BOTH
// `.browser-cache/webkit-<build>/minibrowser-wpe/sys/lib/` and
// `…/minibrowser-gtk/sys/lib/`. Those directories are already on the
// bundle wrapper's `LD_LIBRARY_PATH`, which is the only reliable channel —
// exporting `LD_LIBRARY_PATH` around the driver does NOT reach the browser
// process. Then run with `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`.
//
// ENGINE FINDINGS
// ---------------
// 1. JSPI WORKS on JavaScriptCore, in a stock playwright WebKit build, with
//    no flag: `{suspending: true, promising: true, roundTrip: true}` from the
//    in-page end-to-end probe. docs/architecture.md §12 (Risks) records "Safari: JSPI in STP only"
//    and excludes stable Safari; on this build the API is present and a real
//    suspend/resume round trip completes. Worth re-checking against shipping
// Safari before the exclusion in docs/architecture.md §12 (Risks) is relaxed.
// 2. **JSC does not implement multi-memory in this pinned build** — 58
//    commands fail at `WebAssembly.Module` compile time with "there can at
//    most be one Memory section for now". This is the substantive WebKit
//    finding: the Component Model's canonical ABI routinely needs more than
//    one memory in a single core module (transcoding, cross-component
//    copies, realloc-into-another-instance), so a JSC lane is capped until
//    multi-memory ships there. It is an engine capability gap, not a host
//    defect: the same components run on V8 and SpiderMonkey. 111 further
//    commands are CASCADE entries from those failed instantiations ("no
//    current instance").
//    RESOLVED UPSTREAM (measured 2026-08-09, polyengine#11): webkit-2342
//    (playwright 1.63 alpha roll) ships multi-memory ENABLED BY DEFAULT —
//    the lane reaches 1248/0 against it and 173 of this file's 175 deltas
//    collapse, leaving only the two wording entries of finding 3. This
//    build's `JSC_useWasmMultiMemory` option is an inert stub (verified:
//    the env route works — `JSC_useWasm=0` kills wasm — but the flag
//    changes nothing). When the playwright pin reaches a webkit-2342+ roll,
//    collapse this overlay to EMPTY; the stale-delta detector
//    will insist. Details: https://github.com/polymorph-components/polyengine/issues/11
// 3. Trap wording (JSC vs. V8) is no longer a lane delta. JSC says
//    "Unreachable code should not be executed" for the core `unreachable`
//    trap where the suite expects the wasmtime/V8 wording
//    (docs/architecture.md §1); the runtime passes each engine's raw text
//    through unmodified (`mapCoreException`, runtime/src/exec/boundary.ts)
//    and the harness now normalizes it (`TRAP_MESSAGE_EQUIVALENTS`,
//    harness/src/runner.ts).
//
// FINDING M3A-1 IS CLOSED, and its 18 entries are gone from this file. The
// runtime no longer depends on a platform async-context facility (see
// `chromium.ts`), so nothing here is attributable to it any more. The
// cascades that used to hang off those entries re-attribute upward to
// finding 2: in this corpus every `async/` file that M3A-1 broke on JSC also
// contains a multi-memory core module, so the earliest failure in the file is
// the compile-time rejection and the rest of the file cascades from THAT.
// Read finding 2 before blaming anything here on the host.

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
