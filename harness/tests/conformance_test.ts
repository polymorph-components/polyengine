// Conformance runner: executes every testgen-generated JSON command file
// under harness/generated/ and prints a per-directory summary.
//
// Run via `deno task conformance` (regenerates first) or `deno task test`.

import type { WastJson } from "../src/schema.ts";
import { CoreOnlyExecutor } from "../src/executor.ts";
import { RuntimeExecutor } from "../src/runtime-executor.ts";
import { runWastJson } from "../src/runner.ts";
import { Summary } from "../src/summary.ts";
import { DETERMINISTIC_PROFILE_ONLY, isXfail } from "../src/xfail.ts";

const generatedRoot = new URL("../generated/", import.meta.url);
const summary = new Summary();

// `CONFORMANCE_EXECUTOR=core-only` keeps the old JS-WebAssembly-API-only
// stub available for pipeline sanity (harness/README "Wire-up"); default is
// the real runtime, which needs the translator shim's wasm32 build.
const useCoreOnly = Deno.env.get("CONFORMANCE_EXECUTOR") === "core-only";

// Same try/catch discipline as runtime/tests/jspi/handshake_test.ts: a
// missing --allow-env would otherwise throw NotCapable here. The harness
// "test" task now grants --allow-env=CONFORMANCE_EXECUTOR,
// POLYENGINE_SCHED_SEED, so this should not throw in practice — but reading
// defensively means an unseeded run never depends on the permission being
// present.
const seeded = (() => {
  try {
    return (Deno.env.get("POLYENGINE_SCHED_SEED") ?? "") !== "";
  } catch {
    return false;
  }
})();

const shimPath = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
  import.meta.url,
);

async function makeExecutor(): Promise<CoreOnlyExecutor | RuntimeExecutor> {
  if (useCoreOnly) return new CoreOnlyExecutor();
  let shimWasm: Uint8Array;
  try {
    shimWasm = await Deno.readFile(shimPath);
  } catch {
    Deno.test("translator shim build artifact is missing", () => {
      throw new Error(
        `missing ${shimPath} — run: cargo build -p translator-shim ` +
          `--target wasm32-unknown-unknown --release (or set ` +
          `CONFORMANCE_EXECUTOR=core-only for the pipeline-sanity stub)`,
      );
    });
    return new CoreOnlyExecutor();
  }
  return await RuntimeExecutor.create(shimWasm);
}

const executorFactory = await makeExecutor();

let manifest: { files: string[] };
try {
  manifest = JSON.parse(
    await Deno.readTextFile(new URL("manifest.json", generatedRoot)),
  );
} catch {
  Deno.test("harness/generated is missing", () => {
    throw new Error(
      "harness/generated/manifest.json not found - run `deno task gen` " +
        "(or `deno task conformance`) to convert the wast suite first",
    );
  });
  manifest = { files: [] };
}

for (const relPath of manifest.files) {
  const dir = relPath.split("/")[0];
  // Schedule-profile-dependent files (src/xfail.ts DETERMINISTIC_PROFILE_ONLY):
  // under a seed, self-skip with `ignore: true` (so it shows in the tally as
  // ignored, mirroring handshake_test.ts's visibility) rather than letting
  // the guest's own profile-dependent assumption fail the run. Unseeded runs
  // are unaffected — the file still runs and must pass under FIFO.
  const skipForSeed = seeded && DETERMINISTIC_PROFILE_ONLY.has(relPath);
  if (skipForSeed) {
    console.warn(
      `SKIP: ${relPath} under POLYENGINE_SCHED_SEED — this file's guest ` +
        "asserts subtask return order that is only pinned under the " +
        "reference's DETERMINISTIC_PROFILE (definitions.py:1373); see " +
        "src/xfail.ts DETERMINISTIC_PROFILE_ONLY for the full story.",
    );
  }
  Deno.test({
    name: `conformance ${relPath}`,
    ignore: skipForSeed,
    fn: async () => {
      const doc: WastJson = JSON.parse(
        await Deno.readTextFile(new URL(relPath, generatedRoot)),
      );
      // A fresh executor instance per file for RuntimeExecutor too (component
      // definitions/instances must not leak across .wast files); reset() also
      // clears the CoreOnlyExecutor's transient state (currently none).
      //
      // Per-file timeout: a STALL (an await that never settles) would
      // otherwise die at Deno's pending-promise sanitizer AFTER abandoning
      // this continuation — summary.add would never run and the file would
      // silently vanish from the table, shrinking the corpus instead of
      // failing (observed: sync-barges-in under jspi detection). Racing a
      // timer makes stalls VISIBLE: every command is recorded as failed
      // "STALLED", the summary stays corpus-complete, and the test throws.
      const STALL_TIMEOUT_MS = 30_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => resolve("stalled"), STALL_TIMEOUT_MS);
      });
      const raced = await Promise.race([
        runWastJson(
          doc,
          (filename) =>
            Deno.readFile(new URL(`${dir}/${filename}`, generatedRoot)),
          executorFactory,
        ),
        timeout,
      ]);
      clearTimeout(timer);
      const result = raced === "stalled"
        ? {
          source: doc.source_filename,
          results: doc.commands.map((c) => ({
            line: c.line,
            type: c.type,
            status: "failed" as const,
            detail: `STALLED: file did not complete within ${
              STALL_TIMEOUT_MS / 1000
            }s (a stall is a worse defect than a failure)`,
          })),
        }
        : raced;
      summary.add(dir, result, (r) => isXfail(relPath, r.line));

      const failures = result.results.filter((r) =>
        r.status === "failed" && !isXfail(relPath, r.line)
      );
      if (failures.length > 0) {
        const lines = failures.map((f) =>
          `  ${doc.source_filename}:${f.line} ${f.type}: ${f.detail}`
        );
        throw new Error(
          `${failures.length} command(s) failed:\n${lines.join("\n")}`,
        );
      }
    },
  });
}

Deno.test("conformance summary", () => {
  console.log(`\n${summary.format()}\n`);
  const total = summary.total();
  if (total.commands === 0) {
    throw new Error("no commands ran - is harness/generated populated?");
  }
  // G7, now a REAL gate: xfail entries whose commands pass are stale and
  // must be pruned (a stale entry is a capability gained without noticing,
  // or a mask over a flake).
  if (summary.staleXfails.length > 0) {
    const lines = summary.staleXfails.map((s) => `  ${s.file}:${s.line}`);
    throw new Error(
      `${summary.staleXfails.length} stale xfail entr${
        summary.staleXfails.length === 1 ? "y" : "ies"
      } (marked xfail but PASSING - prune from xfail.ts):\n${lines.join("\n")}`,
    );
  }
});
