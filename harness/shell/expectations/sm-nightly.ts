// SpiderMonkey nightly lane expectation — a findings lane (best-effort,
// non-gating; issue #22).
//
// Expect the Deno baseline with no per-command deltas. The shell's JSPI
// defaults do not establish availability in the shipping browser config;
// see harness/browser/expectations/firefox.ts.
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
    passed: 1285,
    failed: 0,
    xfail: 126,
    pendingRuntime: 95,
    pendingCapability: 0,
    unsupportedDirective: 5,
  },
};

export default smNightly;
