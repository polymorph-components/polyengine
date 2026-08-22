// ============================================================================
// OPFS smoke driver: @polyengine/wasi/filesystem-web against the REAL Origin
// Private File System, in a real browser.
//
//   deno run -A tools/browser/opfs-smoke.ts chromium [--headed] [--keep-open]
//   deno run -A tools/browser/opfs-smoke.ts firefox
//   deno run -A tools/browser/opfs-smoke.ts chromium --realm worker
//   deno run -A tools/browser/opfs-smoke.ts chromium --realm shared-worker
//
// (Recipe: `just smoke-opfs <lane>`; both lanes ride `just browsers` and
// the post-merge browser CI job.)
//
// What it does: bundles `harness/browser/opfs_entry.ts` (and, always, the
// `opfs_worker_entry.ts` dual-mode worker module — issue #129 realm
// neutrality; the extra bundle is cheap and keeps the driver's bundling step
// single-shaped regardless of `--realm`), starts the lane's static server
// (which also serves /opfs.html and the wasip2 fixture corpus under
// /fixtures/), launches the browser (shared launcher — Firefox gets the
// JSPI pref), calls the in-page `__opfsSmoke(realm)`, and asserts every
// check passed. Two halves (see opfs_entry.ts): the direct descriptor
// battery (no wasm) and the composed fs-probe guest (std::fs through
// wasi-libc, parking through the A14 marks — JSPI required, so this is
// also the browser exercise of the suspending kernel over real async
// storage). `--realm page` (default) runs both halves on the page; `--realm
// worker` / `--realm shared-worker` run the SAME battery inside a spawned
// dedicated/shared worker (opfs_worker_entry.ts) — the OPFS × JSPI-parking
// × worker-realm intersection issue #129 exists to pin.
//
// Prerequisites: `just shim` (the translator shim wasm) and
// `just fixtures` (examples/guests/build/fs-probe.component.wasm) — both
// also checked at startup.
//
// Exit codes: 0 = every check passed; 1 = a check failed; 2 =
// infrastructure failure (no browser, missing fixture, page crash).
// ============================================================================

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";
import { bundle } from "./bundle.ts";
import { launch } from "./launch.ts";
import { startServer } from "./serve.ts";
import type { OpfsSmokeReport } from "../../harness/browser/opfs_entry.ts";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);

const SMOKE_TIMEOUT_MS = 120_000;

function fail(msg: string, code = 2): never {
  console.error(`\n[opfs-smoke] ${msg}`);
  Deno.exit(code);
}

async function preflight(): Promise<void> {
  for (
    const [rel, hint] of [
      ["target/wasm32-unknown-unknown/release/translator_shim.wasm", "just shim"],
      ["examples/guests/build/fs-probe.component.wasm", "just fixtures"],
    ] as const
  ) {
    try {
      await Deno.stat(join(repoRoot, rel));
    } catch {
      fail(`missing ${rel} — run \`${hint}\` first`);
    }
  }
}

async function main(): Promise<void> {
  const realmIdx = Deno.args.indexOf("--realm");
  const realm = (realmIdx >= 0 ? Deno.args[realmIdx + 1] : "page") as
    "page" | "worker" | "shared-worker";
  if (!["page", "worker", "shared-worker"].includes(realm)) {
    fail(`unknown --realm '${realm}' (page | worker | shared-worker)`);
  }
  // `--realm <v>`'s value is not a flag, so exclude it from the lane guess
  // (mirrors run-lane.ts's parseArgs — the sibling track hit the same
  // `--realm worker chromium` misparse).
  const realmValIdx = realmIdx >= 0 ? realmIdx + 1 : -1;
  const lane =
    Deno.args.filter((a, i) => !a.startsWith("-") && i !== realmValIdx)[0] ??
      "chromium";
  const headed = Deno.args.includes("--headed");
  const keepOpen = Deno.args.includes("--keep-open");

  await preflight();
  console.log(`[opfs-smoke] bundling opfs_entry…`);
  await bundle(
    join("harness", "browser", "opfs_entry.ts"),
    join("harness", "browser", "dist", "opfs_entry.js"),
  );
  // Always bundle the worker module too: cheap, and keeps the driver's
  // bundling step single-shaped regardless of --realm.
  console.log(`[opfs-smoke] bundling opfs_worker_entry…`);
  await bundle(
    join("harness", "browser", "opfs_worker_entry.ts"),
    join("harness", "browser", "dist", "opfs_worker_entry.js"),
  );

  const server = startServer(() => {/* the smoke posts nothing */});
  const { browser } = await launch(lane, headed).catch((e) =>
    fail(e instanceof Error ? e.message : String(e))
  );
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e: Error) => console.error(`[page error] ${e.message}`));
    await page.goto(`${server.origin}/opfs.html`, { waitUntil: "load" });
    await page.waitForFunction("globalThis.__opfsReady === true", null, {
      timeout: 30_000,
    });

    const report = await page.evaluate(
      // In-page: serialize bigints defensively (none cross today).
      `globalThis.__opfsSmoke(${JSON.stringify(realm)}).then((r) => JSON.parse(JSON.stringify(r)))`,
      { timeout: SMOKE_TIMEOUT_MS },
    ) as OpfsSmokeReport;

    console.log(`\n[opfs-smoke] ${lane} realm=${report.realm}: ${report.userAgent}`);
    console.log(`[opfs-smoke] rename path: ${report.renamePath}`);
    let failed = 0;
    for (
      const [half, checks] of [
        ["direct", report.direct],
        ["composed", report.composed],
      ] as const
    ) {
      for (const check of checks) {
        console.log(`  ${check.ok ? "ok  " : "FAIL"} [${half}] [realm=${report.realm}] ${check.name}`);
        if (!check.ok) {
          failed++;
          console.log(`       ${check.detail ?? "(no detail)"}`);
        }
      }
    }
    if (report.direct.length === 0) fail("the direct battery reported nothing", 1);
    if (report.composed.length === 0) fail("the composed battery reported nothing", 1);
    if (keepOpen) {
      console.log("[opfs-smoke] --keep-open: waiting (ctrl-c to exit)…");
      await new Promise(() => {});
    }
    if (failed > 0) fail(`${failed} check(s) failed on ${lane} realm=${report.realm}`, 1);
    console.log(`[opfs-smoke] ${lane} realm=${report.realm}: all checks passed`);
  } finally {
    await browser.close();
    await server.shutdown();
  }
}

if (import.meta.main) {
  await main();
}
