// Integration gate: the REAL `wasi:filesystem@0.2` surface end to end —
// the fs-probe fixture (examples/guests/fs-probe, wasm32-wasip2: std::fs
// through wasi-libc + the preview1 adapter) instantiated behind the
// runtime, with the node backend serving a real tempdir. The composed
// path a ported CLI program actually takes:
//
//   std::fs -> wasi-libc -> preview1 adapter -> filesystem@0.2.6
//   descriptor methods + via-stream reads/writes (io@0.2 blocking ops)
//   -> plan dispatch -> conventions adapter -> node:fs (sync)
//
// This is also the CALLBACK-MODE pin for the node backend: instantiation
// forces `jspi: false`, so any accidental promise out of a 0.2 method
// would fail loudly instead of quietly selecting jspi.
//
// Skip-if-absent on the shim + fixture corpus, like the other gates.

import { assertEq, assertTrue } from "./asserts.ts";
import { Translator } from "@polyengine/runtime/shim";
import { instantiate } from "@polyengine/runtime/embedder";
import { wasi } from "../src/mod.ts";
import { filesystemNode } from "../src/filesystem_node.ts";

const FIXTURE = new URL(
  "../../examples/guests/build/fs-probe.component.wasm",
  import.meta.url,
);
const SHIM_WASM = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
  import.meta.url,
);

async function readIfPresent(path: URL): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

const componentBytes = await readIfPresent(FIXTURE);
const shimWasm = await readIfPresent(SHIM_WASM);
const ready = componentBytes !== null && shimWasm !== null;

Deno.test({
  name: "integration: std::fs battery over the node backend (callback mode)",
  ignore: !ready,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "polyengine-fs-probe-" });
    try {
      const translator = await Translator.create(shimWasm!);
      const { plan, adapters } = translator.translate(componentBytes!);
      const c = await instantiate(
        { plan, componentBytes: componentBytes!, adapters },
        {
          // The batteries carry the empty-preopens stub on the same track
          // keys; the node backend spread AFTER wins the track (mod.ts
          // composition form 3).
          ...wasi(),
          ...filesystemNode({ preopens: { "/": dir }, writable: true }).imports,
        },
        { jspi: false }, // the sync backend must never park
      );
      const summary = await c.exports.run() as string;
      assertEq(summary, "fs probe ok");
      // The guest cleaned up after itself: the tempdir is empty again.
      const leftovers = [];
      for await (const e of Deno.readDir(dir)) leftovers.push(e.name);
      assertEq(leftovers.length, 0, "guest cleanup reached the real tree");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "integration: a guest error path — err payloads survive the adapter round-trip",
  ignore: !ready,
  async fn() {
    // No preopen named "/": wasi-libc can't resolve "/work", and the
    // guest's own error formatting must come back as OUR result err.
    const translator = await Translator.create(shimWasm!);
    const { plan, adapters } = translator.translate(componentBytes!);
    const c = await instantiate(
      { plan, componentBytes: componentBytes!, adapters },
      { ...wasi() },
      { jspi: false },
    );
    let threw: unknown;
    try {
      await c.exports.run();
    } catch (e) {
      threw = e;
    }
    assertTrue(threw !== undefined, "the guest reported a failure");
    assertTrue(
      String((threw as { payload?: unknown })?.payload ?? threw).includes(
        "create_dir",
      ),
      `the first failing step is named, got: ${
        (threw as { payload?: unknown })?.payload
      }`,
    );
  },
});
