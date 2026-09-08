// Pinned and canary engine-shell lane driver.
//
// Deno-lane-shaped: spawns the shell as a child process (`tools/shell/dist/
// entry.js`, bundled by `tools/shell/bundle.ts`). The entry derives artifact
// paths from its bundle URL, not the shell's working directory. Parses the entry's
// `@polyengine:`-prefixed protocol lines from stdout and classifies with the
// SAME `harness/src/xfail.ts` + `Summary` + per-lane-overlay machinery the
// browser lanes use (`tools/browser/classify.ts` — shared, not forked).
//
//   RUN INSTRUCTIONS
//   ----------------
//   LANE IDS: sm-pinned, sm-nightly (SpiderMonkey); jsc-pinned, jsc-trunk
//   (JSC); node-pinned (Node.js), bun-pinned (Bun) — the runtime lanes run
//   the same bundle via the tools/shell/host-node.mjs preamble. Pinned
//   engine-shell lanes (sm-pinned, jsc-pinned) and node-pinned are REQUIRED
//   gates in ci.yml's `core` job; bun-pinned runs there too but is
//   findings-only until it has a track record (its expectation carries
//   `required: false` — the WebKit-lane precedent); nightly/trunk lanes
//   stay findings-only canaries in canary.yml.
//
//   One-time shell fetch (into ./.shell-cache, gitignored):
//
//     deno run -A tools/shell/fetch.ts sm-pinned
//     deno run -A tools/shell/fetch.ts sm-nightly
//     deno run -A tools/shell/fetch.ts jsc-pinned  # x86_64 CI only
//     deno run -A tools/shell/fetch.ts jsc-trunk   # x86_64 CI only
//     deno run -A tools/shell/fetch.ts node-pinned
//     deno run -A tools/shell/fetch.ts bun-pinned
//
//   Then:
//
//     deno run -A tools/shell/run-lane.ts sm-pinned [--json <path>]
//     deno run -A tools/shell/run-lane.ts jsc-pinned [--json <path>]
//     deno run -A tools/shell/run-lane.ts node-pinned [--json <path>]
//     deno run -A tools/shell/run-lane.ts bun-pinned [--json <path>]
//
//   Machinery validation against a LOCAL stable jsc (not jsc-pinned/-trunk;
//   see `harness/shell/expectations/jsc-trunk.ts`'s header for the recipe
//   that produces a local build from the distro's .deb):
//
//     deno run -A tools/shell/run-lane.ts jsc-pinned \
//       --shell-bin /path/to/jsc --lib-path /path/to/libdir
//
//   Prerequisites (checked at startup, same as the browser lane):
//     * `cd harness && deno task gen`        -> harness/generated/**
//     * `cd harness && deno task shim-check` -> the translator shim wasm
//
//   Exit codes — same `required`-gated policy as the browser driver
//   (`tools/browser/run-lane.ts`): 0 = ran to completion with no deviations,
//   OR ran with deviations on a `required: false` (findings/canary) lane;
//   1 = deviations on a `required: true` (pinned, per-push-gate) lane; 2 =
//   infrastructure failure ONLY (shell binary missing, zero files ran, the
//   shell crashed mid-corpus with no results at all), regardless of
//   `required`. sm-nightly/jsc-trunk are `required: false` (issue #22:
//   "findings lanes, never gating"); sm-pinned/jsc-pinned are
//   `required: true`.

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";
import { classify, diffTotals, totalsOf } from "../browser/classify.ts";
import type { ShellLaneExpectation } from "../../harness/shell/expectations/types.ts";
import smPinned from "../../harness/shell/expectations/sm-pinned.ts";
import smNightly from "../../harness/shell/expectations/sm-nightly.ts";
import jscPinned from "../../harness/shell/expectations/jsc-pinned.ts";
import jscTrunk from "../../harness/shell/expectations/jsc-trunk.ts";
import nodePinned from "../../harness/shell/expectations/node-pinned.ts";
import bunPinned from "../../harness/shell/expectations/bun-pinned.ts";
import { bundle } from "./bundle.ts";
import { defaultShellPaths } from "./fetch.ts";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);

const EXPECTATIONS: Record<string, ShellLaneExpectation> = {
  "sm-pinned": smPinned,
  "sm-nightly": smNightly,
  "jsc-pinned": jscPinned,
  "jsc-trunk": jscTrunk,
  "node-pinned": nodePinned,
  "bun-pinned": bunPinned,
};

interface Args {
  lane: string;
  shellBin: string | null;
  libPath: string | null;
  jsonOut: string | null;
}

function parseArgs(argv: string[]): Args {
  const lane = argv.find((a) => !a.startsWith("-")) ?? "sm-pinned";
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  return {
    lane,
    shellBin: get("--shell-bin"),
    libPath: get("--lib-path"),
    jsonOut: get("--json"),
  };
}

function fail(msg: string, code = 2): never {
  console.error(`\n[shell-lane] ${msg}`);
  Deno.exit(code);
}

async function preflight(): Promise<void> {
  const manifest = join(repoRoot, "harness", "generated", "manifest.json");
  try {
    await Deno.stat(manifest);
  } catch {
    fail(`missing ${manifest} — run \`cd harness && deno task gen\` first`);
  }
  const shim = join(
    repoRoot,
    "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  );
  try {
    await Deno.stat(shim);
  } catch {
    fail(`missing ${shim} — run \`cd harness && deno task shim-check\` first`);
  }
}

type ShellFile = {
  path: string;
  dir: string;
  source: string;
  // deno-lint-ignore no-explicit-any
  results: any[];
  ms: number;
};
// deno-lint-ignore no-explicit-any
type Header = any;

/**
 * Runs the bundled entry under the shell binary. SpiderMonkey needs
 * `--module=<path>` (verified: bare positional args after `--module=<path>`
 * are consumed as additional scripts to run, NOT bound as `scriptArgs` — so
 * this driver passes no positional args at all and the entry derives the
 * repo root from `import.meta.url`); JSC accepts `-m <path>` (verified:
 * works even with a non-`.mjs` extension). Neither shell needs
 * `scriptArgs`/`arguments` here — see entry.ts's header.
 *
 * node/bun run `tools/shell/host-node.mjs` instead — an unbundled preamble
 * that installs the entry's host capabilities (binary reads, `print`) and
 * imports `dist/entry.mjs` (bundle.ts's byte-identical ESM-suffixed copy).
 * The Bun lane sets `BUN_JSC_useWasmMultiMemory=1` for multi-memory adapters.
 * BUN_JSC_* options are unstable; re-verify the option when updating the pin.
 *
 * The CWD is set to the repo root but the entry does NOT rely on it: JSC
 * trunk bundles run through their shipped wrapper, which chdir()s into the
 * bundle directory before exec'ing `bin/jsc` (whose PT_INTERP is the
 * *relative* path `lib/ld-linux-x86-64.so.2`) — see fetchJsc in fetch.ts.
 * The wrapper absolutizes relative argv paths against our CWD first, so the
 * bundle path argument works either way.
 */
async function runShell(
  lane: string,
  shellBin: string,
  libPath: string | null,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const bundlePath = join(repoRoot, "tools", "shell", "dist", "entry.js");
  const hostPath = join(repoRoot, "tools", "shell", "host-node.mjs");
  const args = lane.startsWith("sm-")
    ? [`--module=${bundlePath}`]
    : lane.startsWith("jsc-")
    ? ["-m", bundlePath]
    : [hostPath]; // node-pinned / bun-pinned
  const env: Record<string, string> = {};
  if (libPath) env.LD_LIBRARY_PATH = libPath;
  if (lane === "bun-pinned") env.BUN_JSC_useWasmMultiMemory = "1";
  const cmd = new Deno.Command(shellBin, {
    args,
    cwd: repoRoot,
    env,
    stdout: "piped",
    stderr: "piped",
  });
  let out;
  try {
    out = await cmd.output();
  } catch (e) {
    // Exit-2 policy: a shell that cannot even be spawned is an
    // infrastructure failure, not a lane finding.
    fail(
      `could not spawn ${shellBin}: ${
        e instanceof Error ? e.message : String(e)
      }\n  fetch it first: deno run -A tools/shell/fetch.ts ${lane}`,
    );
  }
  const { code, stdout, stderr } = out;
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

const SENTINEL = "@polyengine:";

function parseProtocol(stdout: string): { header: Header; files: ShellFile[] } {
  let header: Header = null;
  const files: ShellFile[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(SENTINEL)) continue; // shells print their own diagnostics too
    // deno-lint-ignore no-explicit-any
    let obj: any;
    try {
      obj = JSON.parse(line.slice(SENTINEL.length));
    } catch {
      continue; // a truncated/interleaved line; not this driver's problem to fix
    }
    // entry.ts's `emit(kind, payload)` merges `{kind, ...payload}` onto one
    // line — the header event's fields (engine/capabilities/etc) are
    // therefore top-level on the event object itself, not nested under a
    // `header` key (only the `file` event nests its payload, under `file`).
    if (obj.kind === "header") header = obj;
    else if (obj.kind === "file" && obj.file) files.push(obj.file);
  }
  return { header, files };
}

async function main() {
  const args = parseArgs(Deno.args);
  const exp = EXPECTATIONS[args.lane];
  if (!exp) {
    fail(
      `unknown lane '${args.lane}' (sm-pinned | sm-nightly | jsc-pinned | ` +
        `jsc-trunk | node-pinned | bun-pinned)`,
    );
  }

  await preflight();

  const defaults = defaultShellPaths(args.lane);
  const shellBin = args.shellBin ?? defaults.bin;
  const libPath = args.libPath ?? defaults.libPath;
  try {
    await Deno.stat(shellBin);
  } catch {
    fail(
      `shell binary not found: ${shellBin}\n` +
        `  fetch it with: deno run -A tools/shell/fetch.ts ${args.lane}\n` +
        `  or pass --shell-bin <path> --lib-path <dir> for a local build`,
    );
  }

  console.log(`[shell-lane] bundling…`);
  await bundle();

  console.log(`[shell-lane] running ${shellBin} …`);
  const wall0 = performance.now();
  const { code, stdout, stderr } = await runShell(args.lane, shellBin, libPath);
  const wallMs = Math.round(performance.now() - wall0);

  const { header, files } = parseProtocol(stdout);

  console.log(`\n=== lane: ${args.lane} ===`);
  console.log(`engine     : ${header?.engine ?? "(none — no header line)"}`);
  console.log(`version    : ${header?.engineVersion ?? "?"}`);
  console.log(`capabilities: ${JSON.stringify(header?.capabilities ?? null)}`);
  console.log(`shim sha256: ${header?.shimBuildHash ?? "?"}`);
  console.log(`files ran  : ${files.length}/${header?.fileCount ?? "?"}`);
  console.log(`wall clock : ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`shell exit : ${code}`);
  console.log(`notes      : ${exp.notes}`);

  if (files.length === 0) {
    console.error(`\nshell stderr (first 4000 chars):\n${stderr.slice(0, 4000)}`);
    console.error(`\nshell stdout (first 2000 chars):\n${stdout.slice(0, 2000)}`);
    fail(`no files ran (shell exit ${code})`);
  }

  const { summary, unexpectedFailures, staleDeltas } = classify(files, exp);
  console.log(`\n${summary.format()}\n`);

  if (args.jsonOut) {
    await Deno.writeTextFile(
      args.jsonOut,
      JSON.stringify({ lane: args.lane, header, wallMs, files }, null, 2),
    );
    console.log(`[shell-lane] raw results -> ${args.jsonOut}`);
  }

  let bad = false;

  if (header && files.length !== header.fileCount) {
    console.error(
      `\nCORPUS SHRANK: ${files.length} of ${header.fileCount} files reported`,
    );
    bad = true;
  }
  if (unexpectedFailures.length > 0) {
    console.error(`\n${unexpectedFailures.length} UNEXPECTED FAILURE(S):`);
    for (const u of unexpectedFailures.slice(0, 60)) {
      console.error(
        `  ${u.file}:${u.line} ${u.type}: ${u.detail.slice(0, 300)}`,
      );
    }
    if (unexpectedFailures.length > 60) {
      console.error(`  … and ${unexpectedFailures.length - 60} more`);
    }
    bad = true;
  }
  if (summary.staleXfails.length > 0) {
    console.error(
      `\n${summary.staleXfails.length} STALE XFAIL(S) on this lane ` +
        `(marked xfail on Deno but PASSING here — an engine delta worth an ` +
        `\`expected-pass\` overlay entry, not an xfail.ts edit):`,
    );
    for (const s of summary.staleXfails.slice(0, 40)) {
      console.error(`  ${s.file}:${s.line}`);
    }
    bad = true;
  }
  if (staleDeltas.length > 0) {
    console.error(`\n${staleDeltas.length} STALE OVERLAY DELTA(S) (predicted, did not occur):`);
    for (const d of staleDeltas) {
      console.error(`  ${d.file}:${d.line} [${d.kind}] ${d.reason}`);
    }
    bad = true;
  }
  if (exp.totals) {
    const diff = diffTotals(totalsOf(summary), exp.totals);
    if (diff.length > 0) {
      console.error(`\nTOTALS DIFFER FROM EXPECTATION:`);
      for (const d of diff) console.error(d);
      bad = true;
    }
  }

  if (!bad) {
    console.log(`\n[shell-lane] ${args.lane}: OK (matches expectation)`);
    Deno.exit(0);
  }
  console.error(
    `\n[shell-lane] ${args.lane}: ${
      exp.required ? "FAILED" : "deviations recorded (findings lane, not gating)"
    }`,
  );
  // Required lanes (sm-pinned, jsc-pinned) gate the per-push core job — a
  // deviation exits 1, mirroring tools/browser/run-lane.ts's
  // `exp.required ? 1 : 0` tail. Non-required canary lanes (sm-nightly,
  // jsc-trunk) stay findings-only: exit 0 regardless of deviations; only
  // infrastructure failure (caught above via `fail(...)`, exit 2) gates them.
  Deno.exit(exp.required ? 1 : 0);
}

if (import.meta.main) await main();
