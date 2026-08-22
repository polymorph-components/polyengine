// Deno dedicated-worker realm row (issue #129: realm neutrality as a tested
// guarantee). This module runs the async/linking/resources conformance
// slice *inside* a `new Worker(..., { type: "module" })` realm, mirroring
// tests/conformance_test.ts (the main-thread lane) and
// harness/browser/entry.ts (the browser-worker lane it structurally
// resembles: this module IS the analogous "in-realm runner" for a Deno
// dedicated worker, posting structured per-file results back to the parent
// rather than driving Deno.test itself — Deno.test only exists on the main
// thread/realm\_worker_test.ts side).
//
// Message protocol (parent -> worker): a single "start" message carrying the
// slice's corpus-relative paths; this module resolves file/artifact URLs
// itself from `import.meta.url`, exactly like conformance_test.ts does with
// `../generated/` (this file lives in the same tests/ directory, so the
// relative path is identical).
//
// Message protocol (worker -> parent): `{kind:"file", ...}` streamed after
// each file (same shape as harness/browser's BrowserFileResult plus `dir`),
// then `{kind:"done"}`. An unexpected top-level throw posts
// `{kind:"fatal", detail}` instead of dying silently inside the worker
// (workers do not surface uncaught exceptions to a `postMessage` listener
// automatically the way a Promise rejection would to a caller).

import type { WastJson } from "../src/schema.ts";
import { RuntimeExecutor } from "../src/runtime-executor.ts";
import { runWastJson } from "../src/runner.ts";

/** Mirrors conformance_test.ts's / entry.ts's per-file stall guard. */
const STALL_TIMEOUT_MS = 30_000;

export interface WorkerCommandResult {
  line: number;
  type: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
  detail?: string;
}

export interface WorkerFileResult {
  path: string;
  dir: string;
  source: string;
  results: WorkerCommandResult[];
  ms: number;
}

export interface StartMessage {
  kind: "start";
  /** Corpus-relative paths (e.g. "async/foo.json") to run, in order. */
  files: string[];
}

type OutMessage =
  | { kind: "file"; result: WorkerFileResult }
  | { kind: "done" }
  | { kind: "fatal"; detail: string };

const generatedRoot = new URL("../generated/", import.meta.url);
const shimPath = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
  import.meta.url,
);

async function runSlice(files: string[]): Promise<void> {
  const shimWasm = await Deno.readFile(shimPath);
  // One executor for the worker's whole lifetime, reused (and reset()) per
  // file inside runWastJson — same lifetime discipline as
  // conformance_test.ts's module-level `executorFactory`.
  const executor = await RuntimeExecutor.create(shimWasm);

  for (const relPath of files) {
    const dir = relPath.split("/")[0];
    const t0 = performance.now();
    const doc: WastJson = JSON.parse(
      await Deno.readTextFile(new URL(relPath, generatedRoot)),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"stalled">((resolve) => {
      timer = setTimeout(() => resolve("stalled"), STALL_TIMEOUT_MS);
    });
    let raced: Awaited<ReturnType<typeof runWastJson>> | "stalled";
    try {
      raced = await Promise.race([
        runWastJson(
          doc,
          (filename) =>
            Deno.readFile(new URL(`${dir}/${filename}`, generatedRoot)),
          executor,
        ),
        timeout,
      ]);
    } catch (e) {
      // entry.ts pattern: a thrown runner must not shrink the corpus —
      // record every command of the file as failed instead of propagating.
      raced = {
        source: doc.source_filename,
        results: doc.commands.map((c) => ({
          line: c.line,
          type: c.type,
          status: "failed" as const,
          detail: `RUNNER THREW: ${
            e instanceof Error ? e.stack ?? e.message : String(e)
          }`,
        })),
      };
    }
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

    const fileResult: WorkerFileResult = {
      path: relPath,
      dir,
      source: result.source,
      results: result.results as WorkerCommandResult[],
      ms: Math.round(performance.now() - t0),
    };
    (self as unknown as { postMessage: (m: OutMessage) => void }).postMessage(
      { kind: "file", result: fileResult },
    );
  }

  (self as unknown as { postMessage: (m: OutMessage) => void }).postMessage({
    kind: "done",
  });
}

self.onmessage = (ev: MessageEvent<StartMessage>) => {
  const msg = ev.data;
  if (msg?.kind !== "start") return;
  runSlice(msg.files).catch((e) => {
    (self as unknown as { postMessage: (m: OutMessage) => void })
      .postMessage({
        kind: "fatal",
        detail: e instanceof Error ? e.stack ?? e.message : String(e),
      });
  });
};
