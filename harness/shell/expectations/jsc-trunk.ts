// JSC trunk lane expectation — a findings lane (best-effort, non-gating;
// issue #22). Seeded from the first successful CI run (2026-08-09, GH
// Actions ubuntu-24.04 x64, bundle rev `318852@main` built 2026-08-08):
// **EXACT Deno-lane parity** — 1254 passed / 0 failed / 95 xfail (the Deno
// lane's own classes, identical classification), zero jsc-specific deltas,
// and the full capability matrix true: JSPI (round trip verified),
// multi-memory, wasm-GC, exception-handling, memory64, tail-calls,
// relaxed-simd. This corroborates the webkit-2342 browser measurement on
// issue #11 (multi-memory default-on in trunk) from an independent channel,
// and is now re-measured weekly by `.github/workflows/canary.yml`.
//
// Trunk moves: a future drift in totals/capabilities is a FINDING to
// triage (engine change vs harness assumption), not a failure — the driver
// exits 0 either way and reports the diff.
//
// EXECUTION MODEL (the two first-run artifacts, fixed in fetch.ts —
// details there): the bundle must stay intact and run via its shipped
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
//
// CM#705 pin advance to 2f13265 (polyengine#173): totals bumped to the
// engine-independent Deno-lane baseline (1475/1428/1263 passed/165 xfail/42
// pending-runtime/5 unsupported-directive — see harness/src/xfail.ts and
// sm-pinned.ts's header for the new-class breakdown) WITHOUT a local
// re-measurement: this lane is x86_64-only and self-skips on this
// aarch64 dev host. Every OTHER shell lane re-measured on aarch64 this
// round (sm-pinned, node-pinned, sm-nightly, bun-pinned) hit EXACT
// Deno-lane parity with zero per-row deltas, and this lane tracks
// jsc-pinned exactly (same rev, same hash) — so this bump is UNVERIFIED ON
// AARCH64, MEASURED-BY-CI: canary.yml's weekly x64 run is what actually
// re-confirms it (or reports trunk drift, per this file's own findings-only
// discipline).

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
    passed: 1281,
    failed: 0,
    xfail: 130,
    pendingRuntime: 95,
    pendingCapability: 0,
    unsupportedDirective: 5,
  },
};

export default jscTrunk;
