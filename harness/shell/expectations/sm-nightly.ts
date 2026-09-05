// SpiderMonkey nightly lane expectation — a findings lane (best-effort,
// non-gating; issue #22).
//
// RESULT (2026-08-09, SpiderMonkey nightly `js` shell, linux-aarch64,
// jsshell-linux-aarch64.zip fetched from
// archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central/): **the
// lane runs the full corpus, Deno-identical.** All 59 files, 1395 commands,
// zero deltas, zero stale xfails, zero unexpected failures.
//
// CAPABILITY MATRIX (this run): jspi = {suspending: true, promising: true,
// roundTrip: true}, multiMemory = true, wasmGc = true, exceptionHandling =
// true, memory64 = true, tailCalls = true, relaxedSimd = true. Every
// proposal this lane's compile-probes (`tools/shell/probes/*.wasm`) check is
// already implemented in this nightly build — consistent with SpiderMonkey
// nightly being the trailing-edge-but-still-ahead-of-stable-Firefox
// reference issue #22 was written to watch (JSPI unflagged here vs. Firefox
// 153's `javascript.options.wasm_js_promise_integration` pref — see
// `harness/browser/expectations/firefox.ts`).
//
// SHELL-SURFACE FINDINGS (feed the polyfill scope in `tools/shell/polyfill.ts`
// and the shell detection in `tools/shell/entry.ts`):
//   - `os.file.readFile(path, "binary")` for binary reads; both relative
//     (resolved against CWD) and absolute paths work.
//   - `TextEncoder`/`TextDecoder`, `crypto.subtle.digest`, and `atob`/`btoa`
//     are ALL absent — none of the four is a browser/Deno-only convenience;
//     each is polyfilled in `tools/shell/polyfill.ts` (see its header for
//     the runtime call sites that drove the scope of each).
//   - `--module=<path>` (with `=`; a bare `--module <path> <positional>`
//     misparses the first positional as a second script to run — see
//     `tools/shell/run-lane.ts`'s `runShell` comment) with no positional
//     args at all is the reliable invocation; the entry needs none because
//     every path it reads is a fixed repo-relative location and the driver
//     sets the shell's CWD to the repo root.
//   - `print()` is the stdout sink; unprefixed shell diagnostics (module
//     load warnings etc.) show up on stdout too, hence the `@polyengine:`
//     sentinel prefix in the protocol instead of assuming every line is
//     one of ours.
//   - Job-queue draining (`drainJobQueue()`) is present but not needed for
//     the corpus run itself: top-level `await` in module mode drives the
//     queue automatically (verified), same as Deno/browsers.
//
// Track this file the same way `harness/browser/expectations/firefox.ts`
// tracks Firefox: any future delta gets a named, dated entry here, never a
// blanket overlay.
//
// CM#705 pin advance to 2f13265 (polyengine#173): re-measured (this host is
// aarch64) — full Deno-lane parity holds exactly, zero deltas, zero stale
// xfails. Corpus grew 1416->1475 commands; see harness/src/xfail.ts and
// sm-pinned.ts's header for the new-class breakdown (engine-independent by
// construction).

import type { ShellLaneExpectation } from "./types.ts";

export const smNightly: ShellLaneExpectation = {
  lane: "sm-nightly",
  required: false,
  notes:
    "SpiderMonkey nightly (linux-aarch64 jsshell). Full Deno parity: " +
    "zero deltas, all compile-probes true (multi-memory/wasm-GC/EH/memory64/" +
    "tail-calls/relaxed-simd), JSPI round trip verified end to end.",
  deltas: [],
  totals: {
    commands: 1511,
    executed: 1411,
    passed: 1284,
    failed: 0,
    xfail: 127,
    pendingRuntime: 95,
    pendingCapability: 0,
    unsupportedDirective: 5,
  },
};

export default smNightly;
