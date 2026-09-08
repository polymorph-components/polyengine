// JSC trunk lane expectation — a findings lane (best-effort, non-gating;
// issue #22). Expect the Deno baseline with no per-command deltas;
// `.github/workflows/canary.yml` measures trunk on x86_64.
//
// Trunk moves: a future drift in totals/capabilities is a FINDING to
// triage (engine change vs harness assumption), not a failure — the driver
// exits 0 either way and reports the diff.
//
// EXECUTION MODEL (see tools/shell/fetch.ts): keep the bundle intact and use its
// compiled wrapper (`<bundle>/jsc`), because `bin/jsc` carries a RELATIVE
// PT_INTERP resolved from the bundle root; and the zip's lib/*.so.N names
// are symlink entries that must be materialized as real symlinks.
//
// MACHINERY VALIDATION on non-x86_64 hosts (not a parity target): the
// driver, entry, bundler, and protocol can be exercised against a STABLE
// jsc 2.52 (GTK, extracted from the Debian/Ubuntu `libjavascriptcoregtk-bin`
// .deb — recipe in `tools/shell/run-lane.ts`'s header) via:
//
//   deno run -A tools/shell/run-lane.ts jsc-pinned \
//     --shell-bin /path/to/jsc --lib-path /path/to/libdir
//
// Expected on that stable build: capability matrix shows jspi=false,
// multiMemory=false (both land only in trunk) and a large deviation report
// (JSPI-needing commands fail outright rather than classifying pending).
// That is a stable-build artifact, not a jsc-trunk finding.
//
// SHELL-SURFACE FACTS specific to jsc (see `tools/shell/entry.ts`,
// `tools/shell/polyfill.ts` for where these matter):
//   - `readFile(path, "binary")` (top-level global, not namespaced) for
//     binary reads.
//   - `-m <path>` (module mode) with positional args AFTER the module path
//     working reliably as `arguments` in the shell global — unlike
//     SpiderMonkey's `--module=`, this shell tolerated
//     `jsc -m file.mjs -- foo bar` cleanly, but the driver still passes no
//     positional args (parity with the SpiderMonkey invocation; the entry
//     needs none either way).
//   - `JSC_*` env vars for feature flags — an unknown one makes jsc exit
//     with an error, so nothing speculative is ever passed; this driver
//     passes none.
//   - unreachable trap wording: `"Unreachable code should not be executed"`
//     — already a `TRAP_MESSAGE_EQUIVALENTS` row in `harness/src/runner.ts`,
//     no matcher work needed here.

import type { ShellLaneExpectation } from "./types.ts";

export const jscTrunk: ShellLaneExpectation = {
  lane: "jsc-trunk",
  required: false,
  notes:
    "JSC trunk (jsc-built-products, x86_64 CI only). Exact Deno-lane parity " +
    "since rev 318852@main: zero deltas, all capabilities true (JSPI round " +
    "trip, multi-memory, wasm-GC, EH, memory64, tail-calls, relaxed-simd). " +
    "Trunk drift is a finding to triage, never a gate.",
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

export default jscTrunk;
