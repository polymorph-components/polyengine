// ============================================================================
// Browser conformance lane driver (docs/milestones.md M3).
//
// Runs the FULL testgen conformance corpus (`harness/generated/**`) inside a
// real browser and compares the outcome against the Deno lane.
//
//   RUN INSTRUCTIONS
//   ----------------
//   One-time browser download (into ./.browser-cache, gitignored):
//
//     PLAYWRIGHT_BROWSERS_PATH=$PWD/.browser-cache \
//       deno run -A npm:playwright@1.62.1 install chromium
//     # …and `firefox` / `webkit` for the stretch lanes.
//
//   Then, from the repo root:
//
//     deno task -c harness/deno.json browser:chromium     # required lane
//     deno task -c harness/deno.json browser:firefox      # findings lane
//     deno task -c harness/deno.json browser:webkit       # findings lane
//
//   or directly:
//
//     deno run -A tools/browser/run-lane.ts chromium [--headed] [--keep-open]
//                                                    [--json <path>]
//                                                    [--realm page|worker|shared-worker]
//
//   `--realm` (issue #129) runs the whole corpus inside a dedicated or shared
//   worker instead of the window realm, judged against the same expectation:
//   a Window-only dependency creeping into the runtime fails the realm row
//   and names the realm.
//
//   Prerequisites (both are also checked at startup):
//     * `cd harness && deno task gen`        -> harness/generated/**
//     * `cd harness && deno task shim-check` -> the translator shim wasm
//
//   What it does: bundles `harness/browser/entry.ts` for the browser
//   (`tools/browser/bundle.ts`), starts a local static server
//   (`tools/browser/serve.ts`) that serves the bundle + corpus + shim with
//   correct MIME types, launches the browser headless, drives the in-page
//   runner, ingests per-file results as they stream back, then classifies
//   them with the SAME `harness/src/xfail.ts` the Deno lane uses plus the
//   lane's overlay (`harness/browser/expectations/<lane>.ts`), prints the
//   per-directory table, and exits non-zero when a required lane deviates.
//
//   Exit codes: 0 = lane matched its expectation; 1 = unexpected results in a
//   required lane; 2 = infrastructure failure (no browser, no corpus, page
//   crash).
//
//   LANE NOTES (measured 2026-08-09, linux-arm64, playwright 1.62.1)
//   ---------------------------------------------------------------
//   chromium  HeadlessChrome/151 — REQUIRED lane, ~23 s. JSPI on by default.
//   firefox   Firefox/153 — runs the full corpus in ~26 s. JSPI works behind
//             `javascript.options.wasm_js_promise_integration`, which this
//             driver sets via `firefoxUserPrefs` (launch.ts FIREFOX_PREFS).
//   webkit    WebKit 26.5 (WPE headless) — runs the full corpus in ~10 s.
//             JSPI works unflagged. On a host that is not Ubuntu 24.04 the
//             bundled build will not launch until its Ubuntu-24.04-ABI
//             libraries are supplied; the exact recipe (and why exporting
//             `LD_LIBRARY_PATH` around this driver does NOT work) is in
//             `harness/browser/expectations/webkit.ts`. Run that lane with
//             `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`.
//
//   Historical note: all three lanes originally carried FINDING M3A-1 (the
//   scheduler's ambient rode `node:async_hooks`, absent in every browser —
//   80 async/ commands). Fixed by explicit ambient threading in the
//   scheduler; chromium now runs at exact Deno parity (deltas: []) and the
//   stale-delta detector keeps it that way.
// ============================================================================

import { startServer } from "./serve.ts";
import { launch } from "./launch.ts";
import { bundle } from "./bundle.ts";
import { classify, diffTotals, totalsOf } from "./classify.ts";
import type { LaneExpectation } from "../../harness/browser/expectations/types.ts";
import chromium from "../../harness/browser/expectations/chromium.ts";
import firefox from "../../harness/browser/expectations/firefox.ts";
import webkit from "../../harness/browser/expectations/webkit.ts";
import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const EXPECTATIONS: Record<string, LaneExpectation> = {
  chromium,
  firefox,
  webkit,
};

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);

/**
 * JS realm the corpus runs in (issue #129). `page` is the historical
 * behavior; the worker realms run the SAME corpus through the SAME driver and
 * are judged against the SAME per-engine expectation — same engine + same
 * corpus means identical totals, so any delta at all is a realm leak.
 */
const REALMS = ["page", "worker", "shared-worker"] as const;
type Realm = typeof REALMS[number];

interface Args {
  lane: string;
  headed: boolean;
  keepOpen: boolean;
  jsonOut: string | null;
  realm: Realm;
}

function parseArgs(argv: string[]): Args {
  // `--realm <v>`'s value is not a flag, so exclude it from the lane guess.
  const realmIdx = argv.indexOf("--realm");
  const realmRaw = realmIdx >= 0 ? argv[realmIdx + 1] ?? "" : "page";
  const realmValIdx = realmIdx >= 0 ? realmIdx + 1 : -1;
  const lane =
    argv.filter((a, i) => !a.startsWith("-") && i !== realmValIdx)[0] ??
      "chromium";
  const jsonIdx = argv.indexOf("--json");
  if (!(REALMS as readonly string[]).includes(realmRaw)) {
    fail(`unknown realm '${realmRaw}' (${REALMS.join(" | ")})`);
  }
  return {
    lane,
    headed: argv.includes("--headed"),
    keepOpen: argv.includes("--keep-open"),
    jsonOut: jsonIdx >= 0 ? argv[jsonIdx + 1] ?? null : null,
    realm: realmRaw as Realm,
  };
}

type BrowserFile = {
  path: string;
  dir: string;
  source: string;
  // deno-lint-ignore no-explicit-any
  results: any[];
  ms: number;
};
// deno-lint-ignore no-explicit-any
type Header = any;

function fail(msg: string, code = 2): never {
  console.error(`\n[browser-lane] ${msg}`);
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

async function main() {
  const args = parseArgs(Deno.args);
  const exp = EXPECTATIONS[args.lane];
  if (!exp) fail(`unknown lane '${args.lane}' (chromium | firefox | webkit)`);

  await preflight();
  console.log(`[browser-lane] bundling…`);
  await bundle();
  // Only built for the realm rows, so the default `page` lane's work (and
  // output) is unchanged.
  if (args.realm !== "page") {
    await bundle(
      join("harness", "browser", "worker_entry.ts"),
      join("harness", "browser", "dist", "worker_entry.js"),
    );
  }

  const files: BrowserFile[] = [];
  let header: Header = null;
  const server = startServer((e) => {
    if (e.kind === "header") header = e.header;
    else if (e.kind === "file") files.push(e.file as BrowserFile);
  });
  console.log(`[browser-lane] serving ${server.origin}`);

  const wall0 = performance.now();
  const { browser } = await launch(args.lane, args.headed).catch((e) =>
    fail(e instanceof Error ? e.message : String(e))
  );
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m: { type(): string; text(): string }) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on(
    "pageerror",
    (e: Error) => consoleErrors.push(`pageerror: ${e.message}`),
  );
  page.on("crash", () => consoleErrors.push("PAGE CRASHED"));

  let runError: string | null = null;
  try {
    await page.goto(server.origin, { waitUntil: "load" });
    // No playwright default timeout: the full corpus can take minutes and a
    // silent 30s timeout would look like a corpus shrink.
    await page.evaluate(
      // deno-lint-ignore no-explicit-any
      (realm: string) => (globalThis as any).__ceRunAll(realm),
      args.realm,
      { timeout: 0 },
    );
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
  }
  const wallMs = Math.round(performance.now() - wall0);

  if (!args.keepOpen) await browser.close();
  await server.shutdown();

  // ---- report -------------------------------------------------------------
  // Realm annotation is emitted only for the realm rows, so `page` output
  // stays byte-identical to the pre-#129 lane.
  console.log(
    `\n=== lane: ${args.lane}${
      args.realm === "page" ? "" : ` (realm: ${args.realm})`
    } ===`,
  );
  if (args.realm !== "page") {
    console.log(
      `realm      : ${args.realm} (header says: ${header?.realm ?? "?"})`,
    );
  }
  console.log(
    `user agent : ${header?.userAgent ?? "(none — page never reported)"}`,
  );
  console.log(`JSPI       : ${JSON.stringify(header?.jspi ?? null)}`);
  console.log(`shim sha256: ${header?.shimBuildHash ?? "?"}`);
  console.log(`files ran  : ${files.length}/${header?.fileCount ?? "?"}`);
  console.log(`wall clock : ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`notes      : ${exp.notes}`);

  if (files.length === 0) {
    for (const c of consoleErrors.slice(0, 20)) {
      console.error(`  console: ${c}`);
    }
    fail(`no files ran${runError ? ` — ${runError}` : ""}`);
  }

  const { summary, unexpectedFailures, staleDeltas } = classify(files, exp);
  console.log(`\n${summary.format()}\n`);

  if (args.jsonOut) {
    await Deno.writeTextFile(
      args.jsonOut,
      JSON.stringify(
        { lane: args.lane, realm: args.realm, header, wallMs, files },
        null,
        2,
      ),
    );
    console.log(`[browser-lane] raw results -> ${args.jsonOut}`);
  }

  let bad = false;

  if (runError) {
    console.error(`\nRUN ERROR: ${runError}`);
    bad = true;
  }
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
    console.error(
      `\n${staleDeltas.length} STALE OVERLAY DELTA(S) (predicted, did not occur):`,
    );
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
  if (consoleErrors.length > 0) {
    console.log(`\n(${consoleErrors.length} console error(s); first few:)`);
    for (const c of consoleErrors.slice(0, 10)) console.log(`  ${c}`);
  }

  if (!bad) {
    console.log(
      `\n[browser-lane] ${args.lane}${
        args.realm === "page" ? "" : ` [realm: ${args.realm}]`
      }: OK (matches expectation)`,
    );
    Deno.exit(0);
  }
  console.error(
    `\n[browser-lane] ${args.lane}${
      args.realm === "page" ? "" : ` [realm: ${args.realm}]`
    }: ${
      exp.required
        ? "FAILED"
        : "deviations recorded (findings lane, not gating)"
    }`,
  );
  Deno.exit(exp.required ? 1 : 0);
}

if (import.meta.main) await main();
