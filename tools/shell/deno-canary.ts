// Deno canary probe for newer V8 behavior. Reuses the cached build, or fetches
// the latest canary when uncached; reports Deno/V8 identity, capabilities and
// conformance results against the pinned lane's expected totals.
//
// Usage: deno run -A tools/shell/deno-canary.ts [--json <path>]
//
// Findings-lane exit policy (same as `tools/shell/run-lane.ts`): 0 = ran to
// completion, deviations (if any) recorded; 2 = infrastructure failure only
// (canary channel unreachable, conformance run produced zero results).

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);
const cacheDir = join(repoRoot, ".shell-cache", "deno-canary");

function fail(msg: string, code = 2): never {
  console.error(`\n[deno-canary] ${msg}`);
  Deno.exit(code);
}

function targetTriple(): string {
  // dl.deno.land canary builds cover both aarch64 and x86_64 linux-gnu
  // (issue #22: "aarch64 included" is exactly why this substitutes for d8,
  // which chromium-v8's prebuilt bucket does not cover on linux-arm64).
  return Deno.build.arch === "aarch64"
    ? "aarch64-unknown-linux-gnu"
    : "x86_64-unknown-linux-gnu";
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await Deno.mkdir(destDir, { recursive: true });
  const cmd = new Deno.Command("python3", {
    args: [
      "-c",
      "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
      zipPath,
      destDir,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`python3 zipfile extraction failed (${zipPath})`);
}

async function fetchCanary(): Promise<{ bin: string; commit: string }> {
  const bin = join(cacheDir, "deno");
  let commit: string;
  try {
    commit = (await Deno.readTextFile(join(cacheDir, "COMMIT"))).trim();
    await Deno.stat(bin);
    console.log(`[deno-canary] already cached: ${bin} (commit ${commit})`);
    return { bin, commit };
  } catch {
    // not cached — fetch below
  }

  let latestRes: Response;
  try {
    latestRes = await fetch("https://dl.deno.land/canary-latest.txt");
  } catch (e) {
    fail(`could not reach dl.deno.land: ${e instanceof Error ? e.message : e}`);
  }
  if (!latestRes.ok) {
    fail(`canary-latest.txt: ${latestRes.status} ${latestRes.statusText}`);
  }
  commit = (await latestRes.text()).trim();
  const triple = targetTriple();
  const url = `https://dl.deno.land/canary/${commit}/deno-${triple}.zip`;
  console.log(`[deno-canary] fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) fail(`fetch ${url}: ${res.status} ${res.statusText}`);
  const zipPath = join(cacheDir, "deno.zip");
  await Deno.mkdir(cacheDir, { recursive: true });
  await Deno.writeFile(zipPath, new Uint8Array(await res.arrayBuffer()));
  await extractZip(zipPath, cacheDir);
  await Deno.remove(zipPath);
  await Deno.chmod(bin, 0o755);
  await Deno.writeTextFile(join(cacheDir, "COMMIT"), commit);
  console.log(`[deno-canary] ready: ${bin} (commit ${commit})`);
  return { bin, commit };
}

async function runCanary(
  bin: string,
  args: string[],
  cwd = repoRoot,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(bin, {
    args,
    cwd,
    // Keep ambient browser/tool settings out of the canary run.
    clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "" },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function main() {
  const jsonIdx = Deno.args.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? Deno.args[jsonIdx + 1] ?? null : null;

  const { bin, commit } = await fetchCanary();

  const versionRes = await runCanary(bin, ["--version"]);
  if (versionRes.code !== 0) {
    fail(`canary deno --version failed: ${versionRes.stderr}`);
  }
  console.log(`\n=== deno-canary (commit ${commit}) ===`);
  console.log(versionRes.stdout.trim());

  const pinnedVersionRes = await runCanary(Deno.execPath(), ["--version"]);
  console.log(`\npinned deno (this repo's lane):`);
  console.log(pinnedVersionRes.stdout.trim());

  // Capability preamble: a plain `deno run` of the shared JSPI/multi-memory/
  // etc probes, reusing the exact probe modules the shell lanes compile-
  // validate (`tools/shell/probes/*.wasm`) so a V8 feature flip shows up
  // identically across the Deno-canary and shell-canary reports.
  const probeScript = join(cacheDir, "probe.mjs");
  await Deno.mkdir(cacheDir, { recursive: true });
  const probesDir = join(repoRoot, "tools", "shell", "probes").replaceAll("\\", "\\\\");
  await Deno.writeTextFile(
    probeScript,
    `
const probesDir = ${JSON.stringify(probesDir)};
const probes = ["multi-memory","wasm-gc","exception-handling","memory64","tail-calls","relaxed-simd"];
const caps = {};
for (const name of probes) {
  const bytes = await Deno.readFile(probesDir + "/" + name + ".wasm");
  try { caps[name] = WebAssembly.validate(bytes); } catch (e) { caps[name] = "threw: " + e.message; }
}
const W = WebAssembly;
const jspi = { suspending: typeof W.Suspending === "function", promising: typeof W.promising === "function" };
console.log("@polyengine-caps:" + JSON.stringify({ jspi, ...caps }));
`,
  );
  const probeRes = await runCanary(bin, ["run", "-A", probeScript]);
  const capLine = probeRes.stdout.split("\n").find((l) => l.startsWith("@polyengine-caps:"));
  console.log(`\ncapability matrix (canary):`);
  console.log(capLine ? capLine.slice("@polyengine-caps:".length) : `(none — ${probeRes.stderr.slice(0, 500)})`);

  // Full conformance run under the canary binary. `deno task conformance`
  // from harness/, but invoked as `<canary> task conformance` so every
  // subprocess it spawns (deno test, etc.) inherits the canary too.
  console.log(`\n[deno-canary] running full conformance suite under canary…`);
  const confRes = await runCanary(bin, ["task", "conformance"], join(repoRoot, "harness"));
  console.log(confRes.stdout);
  if (confRes.stderr.trim()) console.error(confRes.stderr);

  if (jsonOut) {
    await Deno.writeTextFile(
      jsonOut,
      JSON.stringify(
        {
          commit,
          canaryVersion: versionRes.stdout.trim(),
          pinnedVersion: pinnedVersionRes.stdout.trim(),
          capabilities: capLine ? JSON.parse(capLine.slice("@polyengine-caps:".length)) : null,
          conformanceExitCode: confRes.code,
        },
        null,
        2,
      ),
    );
    console.log(`[deno-canary] raw results -> ${jsonOut}`);
  }

  // Findings lane: a conformance-table delta or non-zero `deno task
  // conformance` exit is a recorded finding, not an infrastructure failure
  // (the run itself completing is the bar for exit 0) — see this file's
  // header for the exact policy split with `run-lane.ts`.
  if (confRes.code !== 0 && !confRes.stdout.includes("TOTAL")) {
    fail(
      `conformance suite produced no results under the canary binary ` +
        `(exit ${confRes.code})`,
    );
  }
  console.log(
    `\n[deno-canary] done (conformance exit ${confRes.code}; findings lane, not gating)`,
  );
  Deno.exit(0);
}

if (import.meta.main) await main();
