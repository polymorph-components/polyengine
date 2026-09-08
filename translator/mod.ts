// @polyengine/translator: the packaged translator wasm and per-platform loader.
//
// Why a separate package: the translator is a versioned peer of the
// runtime (plan-format coupling), so it ships in the same release. Embedders
// that translate at build time need not include the translator asset in
// their production module graphs.
//
// The asset (`translator_shim.wasm`, sibling to this module) is copied
// from the cargo build by `just shim` and is gitignored — run `just shim`
// once in a fresh checkout.

import { Translator } from "@polyengine/runtime/shim";

let singleton: Promise<Translator> | undefined;

/**
 * The packaged translator, loaded lazily and cached for the realm.
 *
 * Platform paths, in order of preference:
 *
 *   * **Deno** — native wasm-module import: stable, permission-free, and
 *     delivery/caching ride the module cache. The shim imports nothing,
 *     so the ESM integration instantiates it trivially and
 *     `Translator.fromExports` wraps the namespace with no compile and no
 *     copy. (`buildHash` is unrecoverable from an instance, so the
 *     artifact cache keys without translator identity on this path —
 *     see Translator.buildHash.)
 *   * **Node** — `node:fs` read of the packaged asset (Node's wasm-module
 *     imports are still experimental; don't build on them).
 *   * **Browser / workers** — `fetch` of the packaged asset URL (bundlers
 *     understand the `new URL(…, import.meta.url)` pattern and carry the
 *     asset).
 *
 * Pass the result to `instantiate({ componentBytes, translator })`
 * (contracts/embedder-api.md §"Module wiring and instantiation"), or call
 * `.translate()` directly.
 */
export function defaultTranslator(): Promise<Translator> {
  return singleton ??= load();
}

async function load(): Promise<Translator> {
  const url = new URL("./translator_shim.wasm", import.meta.url);
  try {
    if (typeof Deno !== "undefined") {
      // String-literal dynamic import: statically analyzable, so the wasm
      // rides the module graph permission-free; still lazy, and non-Deno
      // platforms never evaluate it (see its header).
      //
      // Falls THROUGH rather than failing when the module is absent: the npm
      // distribution omits it (Node cannot parse a static wasm ES-module
      // import), and Deno reports `process.versions.node`, so a Deno consumer
      // of the npm package lands on the Node arm below and works.
      try {
        const { ns } = await import("./shim_asset_deno.ts");
        return Translator.fromExports(ns);
      } catch {
        // no packaged Deno asset module — try the platform-neutral arms
      }
    }
    const proc = (globalThis as { process?: { versions?: { node?: string } } })
      .process;
    if (proc?.versions?.node) {
      const { readFile } = await import("node:fs/promises");
      return await Translator.create(new Uint8Array(await readFile(url)));
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`fetching the translator asset failed: ${res.status}`);
    }
    return await Translator.create(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    // The overwhelmingly likely in-repo cause is the missing gitignored
    // asset; say so instead of leaking a bare module-resolution error.
    throw new Error(
      `@polyengine/translator: could not load ${url}: ${e}\n` +
        `(in a repo checkout, run \`just shim\` to build and place the asset)`,
      { cause: e },
    );
  }
}
