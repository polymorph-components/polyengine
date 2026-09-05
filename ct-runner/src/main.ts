#!/usr/bin/env -S deno run -A
// ct-runner CLI entry.
//
//   deno run -A ct-runner/src/main.ts <suite.wasm> --out results.jsonl \
//     [--translator <translator_shim.wasm>] [--imports <module.ts>] \
//     [--target NAME] [--suite-name NAME] \
//     [--only SUBSTRING] [--missing f1,f2,...] [--case-timeout-ms N] \
//     [--no-fresh-cases] [--jspi]
//
// `--imports <module.ts>` convention (contracts/embedder-api.md §"Module
// wiring and instantiation"): a TS module whose default export is either
// the imports record directly, or a factory (sync or async) producing one.
// Never test-context — the runner supplies that itself.
//
// `--translator` (or POLYENGINE_TRANSLATOR in the environment) names the
// translator-shim wasm explicitly — required when this CLI runs outside a
// polyengine checkout (e.g. imported by URL at a release tag, with the wasm
// taken from that release's `polyengine-translator-shim.wasm` asset; see
// docs/consumers.md and issue #16's interim release scheme). Inside a
// checkout it defaults to the local release build under `target/`.

import { Translator } from "../../runtime/src/shim/mod.ts";
import type { ComponentArtifacts } from "@polyengine/runtime/embedder";
import { MissingImportsError, runSuite } from "./mod.ts";

const REPO_ROOT = new URL("../../", import.meta.url);

function usageError(msg: string): never {
  console.error(`error: ${msg}`);
  console.error(
    "usage: deno run -A ct-runner/src/main.ts <suite.wasm> --out <results.jsonl> " +
      "[--translator <translator_shim.wasm>] [--imports <module.ts>] " +
      "[--target NAME] [--suite-name NAME] " +
      "[--only SUBSTRING] [--missing f1,f2,...] [--case-timeout-ms N] " +
      "[--no-fresh-cases] [--jspi]",
  );
  Deno.exit(2);
}

interface Cli {
  suitePath: string;
  out: string;
  translator?: string;
  importsModule?: string;
  target: string;
  suiteName?: string;
  only?: string;
  missing?: string[];
  caseTimeoutMs?: number;
  freshCases: boolean;
  jspi: boolean;
}

function parseArgs(argv: string[]): Cli {
  const positional: string[] = [];
  let out: string | undefined;
  let translator: string | undefined;
  let importsModule: string | undefined;
  let target = "polyengine/host";
  let suiteName: string | undefined;
  let only: string | undefined;
  let missing: string[] | undefined;
  let caseTimeoutMs: number | undefined;
  let freshCases = true;
  let jspi = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--out":
        out = argv[++i];
        break;
      case "--translator":
        translator = argv[++i];
        break;
      case "--imports":
        importsModule = argv[++i];
        break;
      case "--target":
        target = argv[++i];
        break;
      case "--suite-name":
        suiteName = argv[++i];
        break;
      case "--only":
        only = argv[++i];
        break;
      case "--missing":
        // Comma-separated missing-feature list (upstream ct-runner's
        // --missing f1,f2,...); tag gating per src/tags.ts.
        missing = argv[++i].split(",").filter((f) => f !== "");
        break;
      case "--case-timeout-ms":
        caseTimeoutMs = Number(argv[++i]);
        break;
      case "--no-fresh-cases":
        freshCases = false;
        break;
      case "--jspi":
        jspi = true;
        break;
      default:
        if (a.startsWith("--")) usageError(`unknown flag '${a}'`);
        positional.push(a);
    }
  }
  if (positional.length !== 1) usageError("expected exactly one <suite.wasm> argument");
  if (out === undefined) usageError("--out <results.jsonl> is required");
  return {
    suitePath: positional[0],
    out,
    translator,
    importsModule,
    target,
    suiteName,
    only,
    missing,
    caseTimeoutMs,
    freshCases,
    jspi,
  };
}

async function loadImportsModule(path: string): Promise<Record<string, unknown>> {
  const mod = await import(
    path.startsWith(".") || path.startsWith("/")
      ? new URL(path, `file://${Deno.cwd()}/`).href
      : path
  );
  const def = mod.default;
  if (typeof def === "function") {
    return (await def()) ?? {};
  }
  return (def ?? {}) as Record<string, unknown>;
}

/** Resolve the translator-shim wasm: explicit `--translator`, then
 * `POLYENGINE_TRANSLATOR`, then the checkout-local release build. The explicit
 * paths exist for consumers running this CLI outside a polyengine checkout
 * (URL-imported at a release tag): `import.meta.url` is then remote, so the
 * repo-relative default cannot work — they point at the release's
 * `polyengine-translator-shim.wasm` asset instead. */
async function loadTranslator(explicit?: string): Promise<Translator> {
  const fromEnv = Deno.env.get("POLYENGINE_TRANSLATOR");
  const path = explicit ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  if (path !== undefined) {
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(path);
    } catch (e) {
      console.error(
        `error: cannot read translator wasm at ${path}` +
          ` (${explicit !== undefined ? "--translator" : "POLYENGINE_TRANSLATOR"}): ${e}`,
      );
      Deno.exit(1);
    }
    return await Translator.create(bytes);
  }

  if (REPO_ROOT.protocol !== "file:") {
    console.error(
      "error: running outside a polyengine checkout — pass --translator " +
        "<translator_shim.wasm> (or set POLYENGINE_TRANSLATOR); the wasm ships as " +
        "a release asset (polyengine-translator-shim.wasm).",
    );
    Deno.exit(1);
  }
  const rel = "target/wasm32-unknown-unknown/release/translator_shim.wasm";
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(new URL(rel, REPO_ROOT));
  } catch {
    console.error(
      `error: missing ${rel} — run: cargo build -p translator-shim --release ` +
        `--target wasm32-unknown-unknown (or pass --translator)`,
    );
    Deno.exit(1);
  }
  return await Translator.create(bytes);
}

function suiteNameFrom(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.component\.wasm$|\.wasm$/, "");
}

async function main() {
  const cli = parseArgs(Deno.args);
  const componentBytes = await Deno.readFile(cli.suitePath);
  const translator = await loadTranslator(cli.translator);
  const { plan, adapters } = translator.translate(componentBytes);
  const artifacts: ComponentArtifacts = { plan, componentBytes, adapters };

  const imports = cli.importsModule
    ? await loadImportsModule(cli.importsModule)
    : {};

  const lines: string[] = [];
  try {
    const counts = await runSuite(artifacts, {
      imports,
      target: cli.target,
      suiteName: cli.suiteName ?? suiteNameFrom(cli.suitePath),
      only: cli.only,
      missing: cli.missing,
      caseTimeoutMs: cli.caseTimeoutMs,
      freshCases: cli.freshCases,
      jspi: cli.jspi,
      emit: (line) => lines.push(line),
      log: (msg) => console.error(msg),
    });
    await Deno.writeTextFile(cli.out, lines.join("\n") + "\n");
    console.error(
      `${counts.passed} passed | ${counts.failed} failed | ${counts.skipped} skipped | ` +
        `${counts.na} n/a | ${counts.deselected} deselected (${counts.total} total) -> ${cli.out}`,
    );
    if (counts.failed > 0) Deno.exit(1);
  } catch (e) {
    if (e instanceof MissingImportsError) {
      console.error(`error: ${e.message}`);
      for (const leaf of e.leaves) console.error(`  - ${leaf.interfaceId}`);
      Deno.exit(3);
    }
    throw e;
  }
}

if (import.meta.main) await main();
