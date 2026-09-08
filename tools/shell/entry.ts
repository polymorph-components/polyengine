// In-shell conformance runner (issue #22 — engine-shell canary lanes).
//
// Deno-lane-shaped, not browser-lane-shaped: this file is bundled
// (`tools/shell/bundle.ts`) and executed directly by a JS shell (SpiderMonkey
// `js` nightly or JSC `jsc` trunk) as a module — or by a JS *runtime* (node,
// bun) via the `tools/shell/host-node.mjs` preamble, which supplies the two
// host capabilities this entry needs (binary reads, `print`) without putting
// node: builtin imports into this browser-platform bundle. There is no HTTP
// server and no page: the corpus is read straight off disk — at absolute
// paths derived from `import.meta.url` (the repo root is three directories
// above the bundle), because the shell's CWD is not trustworthy: JSC trunk
// bundles chdir into their own directory (see `readBinary` below) — and
// results are streamed as `@polyengine:`-prefixed JSON lines on stdout via
// `print()`, which both target shells provide. `tools/shell/run-lane.ts`
// parses these lines and classifies with the exact same
// `harness/src/xfail.ts` + `Summary` + per-lane-overlay machinery the
// browser lanes use (`tools/browser/classify.ts`).
//
// IMPORTANT: the polyfill import below MUST be first. ES module evaluation
// runs side-effect imports in declaration order; `runtime-executor.ts` pulls
// in `runtime/src/cabi/strings.ts`, which constructs `TextEncoder`/
// `TextDecoder` instances at MODULE TOP LEVEL. If that import ran before the
// polyfill installed, the shell would throw `ReferenceError: TextEncoder is
// not defined` before a single corpus file ran.
import "./polyfill.ts";
import { sha256 } from "./polyfill.ts";

import type { WastJson } from "../../harness/src/schema.ts";
import { RuntimeExecutor } from "../../harness/src/runtime-executor.ts";
import { runWastJson } from "../../harness/src/runner.ts";

// ---------------------------------------------------------------------------
// Shell feature sniffing: binary-file-read adapter.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
const g = globalThis as any;

type EngineName = "spidermonkey" | "jsc" | "node" | "bun" | "unknown";

function detectEngine(): EngineName {
  // Bun also defines process.versions.node, so check Bun first. This entry runs
  // Node/Bun through host-node.mjs; Deno has a separate conformance runner.
  if (typeof g.process?.versions?.bun === "string") return "bun";
  if (typeof g.process?.versions?.node === "string") return "node";
  if (typeof g.os?.file?.readFile === "function") return "spidermonkey";
  if (typeof g.readFile === "function") return "jsc";
  return "unknown";
}

const engine = detectEngine();

// Both target shells provide a global `print()` for stdout; `deno check`
// does not know it (it is not a Deno global), so declare it here. On the
// node/bun lanes the host preamble (tools/shell/host-node.mjs) installs it
// before importing this bundle.
declare function print(s: string): void;

function readBinary(path: string): Uint8Array {
  const abs = path.startsWith("/") ? path : `${repoRoot}/${path}`;
  switch (engine) {
    case "spidermonkey":
      return g.os.file.readFile(abs, "binary");
    case "jsc":
      return g.readFile(abs, "binary");
    case "node":
    case "bun":
      // Installed by tools/shell/host-node.mjs (which keeps node: builtin
      // imports out of this browser-platform bundle). It copies out of
      // node's pooled Buffer so the returned bytes do not expose its whole slab.
      if (typeof g.__polyengineHostRead !== "function") {
        throw new Error(
          `readBinary: ${engine} detected but no __polyengineHostRead — run this ` +
            `bundle via tools/shell/host-node.mjs, not directly`,
        );
      }
      return g.__polyengineHostRead(abs);
    default:
      throw new Error(
        `readBinary: unrecognized shell (no os.file.readFile, no readFile)`,
      );
  }
}

/** Best-effort engine identity for the header. The jsshells expose a
 * `version()` global; node/bun carry theirs on `process.versions`. */
function engineVersionString(): string | null {
  if (engine === "node") {
    return `node ${g.process.version} (v8 ${g.process.versions.v8})`;
  }
  if (engine === "bun") {
    return `bun ${g.process.versions.bun} (webkit ${g.process.versions.webkit ?? "?"})`;
  }
  return typeof g.version === "function" ? g.version() : null;
}

// Repo root, derived from this bundle's own location rather than the CWD.
// The CWD is NOT reliable: JSC trunk bundles are executed through their
// shipped wrapper (see the README inside the bundle), which chdir()s into
// the bundle directory before exec'ing bin/jsc — its real binary carries a
// *relative* PT_INTERP (`lib/ld-linux-x86-64.so.2`) that only resolves from
// there. The bundle lives at <repo>/tools/shell/dist/entry.js, so the root
// is three directories up. `import.meta.url` shapes differ per shell
// (verified): SpiderMonkey yields a bare absolute path, JSC a file:// URL.
const repoRoot = (() => {
  let p = import.meta.url;
  if (p.startsWith("file://")) p = p.slice("file://".length);
  const parts = p.split("/");
  parts.splice(-4); // strip tools/shell/dist/entry.js
  return parts.join("/") || "/";
})();

function readText(path: string): string {
  const bytes = readBinary(path);
  return new TextDecoder().decode(bytes);
}

/** SpiderMonkey: `drainJobQueue()`. JSC: `drainMicrotasks()`. Both shells
 * also drive their job queue at `await`/`setTimeout` points automatically
 * (verified: top-level `await` works on both), so this is best-effort only,
 * used solely around the synchronous JSPI probe below. */
function drainJobs(): void {
  if (typeof g.drainJobQueue === "function") g.drainJobQueue();
  else if (typeof g.drainMicrotasks === "function") g.drainMicrotasks();
}

// ---------------------------------------------------------------------------
// Protocol: one line per event, `@polyengine:` sentinel prefix + JSON. Shells
// print warnings/diagnostics of their own to stdout; the driver ignores any
// line without the prefix.
// ---------------------------------------------------------------------------
const SENTINEL = "@polyengine:";

function emit(kind: string, payload: Record<string, unknown>): void {
  print(SENTINEL + JSON.stringify({ kind, ...payload }));
}

// ---------------------------------------------------------------------------
// Capability probes.
// ---------------------------------------------------------------------------

interface CapabilityMatrix {
  jspi: {
    suspending: boolean;
    promising: boolean;
    roundTrip: boolean | string;
  };
  multiMemory: boolean | string;
  wasmGc: boolean | string;
  exceptionHandling: boolean | string;
  memory64: boolean | string;
  tailCalls: boolean | string;
  relaxedSimd: boolean | string;
}

/** `WebAssembly.validate` a checked-in probe module; `true`/`false`/error text. */
function probeValidate(wasmRelPath: string): boolean | string {
  try {
    const bytes = readBinary(wasmRelPath);
    return WebAssembly.validate(bytes.buffer as ArrayBuffer);
  } catch (e) {
    return `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * End-to-end JSPI round trip, mirroring `harness/browser/entry.ts`'s
 * `probeJspi`: build `tools/shell/probes/jspi.wasm` (imports "" "f", exports
 * "g" calling it), wrap the import with `WebAssembly.Suspending`, wrap the
 * export with `WebAssembly.promising`, and await the real suspend/resume.
 */
async function probeJspi(): Promise<CapabilityMatrix["jspi"]> {
  const W = WebAssembly as unknown as {
    // deno-lint-ignore no-explicit-any
    Suspending?: any;
    // deno-lint-ignore no-explicit-any
    promising?: any;
  };
  const suspending = typeof W.Suspending === "function";
  const promising = typeof W.promising === "function";
  if (!suspending || !promising) {
    return { suspending, promising, roundTrip: false };
  }
  try {
    const bytes = readBinary("tools/shell/probes/jspi.wasm");
    const { instance } = await WebAssembly.instantiate(
      bytes.buffer as ArrayBuffer,
      {
        "": {
          f: new W.Suspending(() =>
            new Promise<number>((r) => setTimeout(() => r(42), 0))
          ),
        },
      },
    );
    const gFn = W.promising(
      (instance.exports as Record<string, unknown>).g,
    ) as () => Promise<number>;
    const v = await gFn();
    return { suspending, promising, roundTrip: v === 42 };
  } catch (e) {
    return {
      suspending,
      promising,
      roundTrip: `threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function probeCapabilities(): Promise<CapabilityMatrix> {
  const jspi = await probeJspi();
  drainJobs();
  return {
    jspi,
    multiMemory: probeValidate("tools/shell/probes/multi-memory.wasm"),
    wasmGc: probeValidate("tools/shell/probes/wasm-gc.wasm"),
    exceptionHandling: probeValidate("tools/shell/probes/exception-handling.wasm"),
    memory64: probeValidate("tools/shell/probes/memory64.wasm"),
    tailCalls: probeValidate("tools/shell/probes/tail-calls.wasm"),
    relaxedSimd: probeValidate("tools/shell/probes/relaxed-simd.wasm"),
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256(bytes)).map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Main run.
// ---------------------------------------------------------------------------

async function main() {
  const shimBytes = readBinary(
    "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  );
  const executor = await RuntimeExecutor.create(shimBytes);

  const manifest: { files: string[] } = JSON.parse(
    readText("harness/generated/manifest.json"),
  );

  const capabilities = await probeCapabilities();
  emit("header", {
    engine,
    // Best-effort engine identity string; run-lane.ts overrides/augments
    // this with fetched build metadata (nightly buildid / jsc revision) it
    // already knows from the fetch step.
    engineVersion: engineVersionString(),
    capabilities,
    shimBuildHash: sha256Hex(shimBytes),
    fileCount: manifest.files.length,
  });

  for (const relPath of manifest.files) {
    const dir = relPath.split("/")[0];
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    const doc: WastJson = JSON.parse(readText(`harness/generated/${relPath}`));

    let raced: Awaited<ReturnType<typeof runWastJson>>;
    try {
      raced = await runWastJson(
        doc,
        // deno-lint-ignore require-await
        async (filename) =>
          readBinary(
            `harness/generated/${dir}/${filename}`,
          ) as Uint8Array<ArrayBuffer>,
        executor,
      );
    } catch (e) {
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
    const t1 = typeof performance !== "undefined" ? performance.now() : 0;

    emit("file", {
      file: {
        path: relPath,
        dir,
        source: raced.source,
        results: raced.results,
        ms: Math.round(t1 - t0),
      },
    });
  }

  emit("done", {});
}

await main();
