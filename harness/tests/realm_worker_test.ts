// Realm-neutrality row (issue #129): the runtime must instantiate and run
// identically in every JS realm kind. This file is the **Deno
// dedicated-worker** row — it spawns `harness/tests/realm_worker.ts` inside
// `new Worker(..., { type: "module" })` and runs a conformance slice there,
// so any later accidental main-thread/Window dependency (a global, a DOM
// API, an assumption about the realm the runtime boots in) fails loud at
// this gate instead of surfacing inside a consumer's worker topology months
// later. Browser worker rows (a Web Worker inside chromium/firefox) live in
// the browser lane (harness/browser/), not here — this row only proves
// Deno's own worker realm.
//
// Slice: manifest files under async/, linking/, resources/ — the axes issue
// #129 names (instantiation, linking, host streams, error paths). Derived
// from harness/generated/manifest.json at runtime; no hardcoded file list,
// so the slice tracks the corpus as testgen regenerates it.

import { isXfail } from "../src/xfail.ts";

const generatedRoot = new URL("../generated/", import.meta.url);

const SLICE_DIRS = new Set(["async", "linking", "resources"]);

interface WorkerCommandResult {
  line: number;
  type: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
  detail?: string;
}

interface WorkerFileResult {
  path: string;
  dir: string;
  source: string;
  results: WorkerCommandResult[];
  ms: number;
}

// Same try/catch discipline as conformance_test.ts: a missing --allow-env
// would otherwise throw NotCapable here.
const useCoreOnly = (() => {
  try {
    return Deno.env.get("CONFORMANCE_EXECUTOR") === "core-only";
  } catch {
    return false;
  }
})();

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

if (useCoreOnly) {
  // The stub executor proves nothing about realm neutrality (it never
  // touches the runtime under test) — self-ignore rather than pretend the
  // row ran.
  Deno.test({
    name: "conformance slice in a Deno worker (realm: dedicated worker)",
    ignore: true,
    fn: () => {},
  });
} else {
  const shimExists = await Deno.stat(shimPath).then(() => true, () => false);
  if (!shimExists) {
    Deno.test("translator shim build artifact is missing (deno-worker realm row)", () => {
      throw new Error(
        `missing ${shimPath} — run: cargo build -p translator-shim ` +
          `--target wasm32-unknown-unknown --release (or set ` +
          `CONFORMANCE_EXECUTOR=core-only for the pipeline-sanity stub)`,
      );
    });
  } else {
    let manifest: { files: string[] } | undefined;
    try {
      manifest = JSON.parse(
        await Deno.readTextFile(new URL("manifest.json", generatedRoot)),
      );
    } catch {
      Deno.test("harness/generated is missing (deno-worker realm row)", () => {
        throw new Error(
          "harness/generated/manifest.json not found - run `deno task gen` " +
            "(or `deno task conformance`) to convert the wast suite first",
        );
      });
    }

    if (manifest) {
      const allSlice = manifest.files.filter((f) =>
        SLICE_DIRS.has(f.split("/")[0])
      );

      Deno.test(
        "conformance slice in a Deno worker (realm: dedicated worker)",
        async () => {
          let slice = allSlice;
          if (seeded) {
            // Same rationale as conformance_test.ts's seeded self-skip: this
            // file's guest asserts a schedule-order-dependent invariant that
            // only holds under the reference's DETERMINISTIC_PROFILE
            // (definitions.py:1373); see src/xfail.ts
            // DETERMINISTIC_PROFILE_ONLY for the full story.
            const { DETERMINISTIC_PROFILE_ONLY } = await import(
              "../src/xfail.ts"
            );
            const dropped = slice.filter((f) =>
              DETERMINISTIC_PROFILE_ONLY.has(f)
            );
            if (dropped.length > 0) {
              console.warn(
                `SKIP (deno-worker realm row): ${
                  dropped.join(", ")
                } under POLYENGINE_SCHED_SEED — schedule-order-dependent ` +
                  "guest assumption, see src/xfail.ts DETERMINISTIC_PROFILE_ONLY.",
              );
            }
            slice = slice.filter((f) => !DETERMINISTIC_PROFILE_ONLY.has(f));
          }

          const worker = new Worker(
            new URL("./realm_worker.ts", import.meta.url).href,
            { type: "module" },
          );
          const fileResults: WorkerFileResult[] = [];
          const seenPaths = new Set<string>();
          try {
            const WATCHDOG_MS = 120_000;
            await new Promise<void>((resolve, reject) => {
              const watchdog = setTimeout(() => {
                reject(
                  new Error(
                    `[realm: deno-worker] watchdog: worker did not finish ` +
                      `within ${WATCHDOG_MS / 1000}s (received ${fileResults.length}` +
                      `/${slice.length} file results before hanging)`,
                  ),
                );
              }, WATCHDOG_MS);
              worker.onmessage = (
                ev: MessageEvent<
                  | { kind: "file"; result: WorkerFileResult }
                  | { kind: "done" }
                  | { kind: "fatal"; detail: string }
                >,
              ) => {
                const msg = ev.data;
                if (msg.kind === "file") {
                  fileResults.push(msg.result);
                  seenPaths.add(msg.result.path);
                } else if (msg.kind === "done") {
                  clearTimeout(watchdog);
                  resolve();
                } else if (msg.kind === "fatal") {
                  clearTimeout(watchdog);
                  reject(
                    new Error(`[realm: deno-worker] worker fatal: ${msg.detail}`),
                  );
                }
              };
              worker.onerror = (ev: ErrorEvent) => {
                clearTimeout(watchdog);
                reject(
                  new Error(
                    `[realm: deno-worker] worker error: ${ev.message}`,
                  ),
                );
              };
              worker.postMessage({ kind: "start", files: slice });
            });
          } finally {
            worker.terminate();
          }

          // Slice-completeness: every expected file reported exactly once.
          const missing = slice.filter((f) => !seenPaths.has(f));
          if (missing.length > 0) {
            throw new Error(
              `[realm: deno-worker] ${missing.length} slice file(s) never ` +
                `reported a result (corpus shrink):\n${
                  missing.map((f) => `  ${f}`).join("\n")
                }`,
            );
          }
          const dupes = fileResults.length - seenPaths.size;
          if (dupes > 0) {
            throw new Error(
              `[realm: deno-worker] ${dupes} slice file(s) reported more ` +
                `than once`,
            );
          }

          // Classification: unexpected failures (not covered by xfail).
          const failures: string[] = [];
          // Realm-delta detection: xfail entries that PASS in the worker.
          const realmDeltas: string[] = [];
          for (const fr of fileResults) {
            for (const r of fr.results) {
              const xfail = isXfail(fr.path, r.line);
              if (r.status === "failed" && !xfail) {
                failures.push(
                  `  ${fr.source}:${r.line} ${r.type}: ${r.detail}`,
                );
              }
              if (r.status === "passed" && xfail) {
                realmDeltas.push(`  ${fr.path}:${r.line} ${r.type}`);
              }
            }
          }

          if (failures.length > 0) {
            throw new Error(
              `[realm: deno-worker] ${failures.length} command(s) failed ` +
                `in the worker realm:\n${failures.join("\n")}`,
            );
          }
          if (realmDeltas.length > 0) {
            throw new Error(
              `[realm: deno-worker] ${realmDeltas.length} command(s) marked ` +
                "xfail PASSED inside the worker realm (a realm delta — " +
                "better behavior in a worker than main thread is still a " +
                "delta; these would also trip the main lane's stale-xfail " +
                "gate if the xfail were pruned globally, so a worker-only " +
                `pass means realm variance, not progress):\n${
                  realmDeltas.join("\n")
                }`,
            );
          }
        },
      );
    }
  }
}
