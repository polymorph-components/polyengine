// The APPLICATION side of the conventions suite: translate a fixture and
// instantiate it. This is the only file here allowed to touch
// `@polyengine/runtime` — the harness plays the embedding application, whose
// job (instantiate, resolve artifacts, enumerate `requiredImports`) is exactly
// what `@polyengine/runtime/embedder`'s surface is for after §"The host-ABI surface and its version".
//
// The PROBE HOST MODULE (`probe.ts`) is the other side, and imports none of
// it. Keep the split: a runtime import leaking into probe.ts would void the
// property this suite exists to demonstrate.

import { Translator } from "@polyengine/runtime/shim";
import {
  type ComponentArtifacts,
  type EmbedderInstance,
  type EmbedderOptions,
  instantiate,
  requiredImports,
} from "@polyengine/runtime/embedder";

// Re-exported so this file stays the SINGLE place the suite touches the
// runtime: `rg 'from "@polyengine/runtime' runtime/tests/conventions/` must
// list harness.ts and nothing else.
export { requiredImports };

const root = new URL("../../../", import.meta.url);

async function read(rel: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    return null;
  }
}

const shimWasm = await read(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
);
const translator = shimWasm === null ? null : await Translator.create(shimWasm);

/** True when the shim and `rel` are both present; cases self-skip otherwise. */
export async function haveFixture(rel: string): Promise<boolean> {
  return translator !== null && (await read(rel)) !== null;
}

export async function artifactsOf(rel: string): Promise<ComponentArtifacts> {
  const componentBytes = (await read(rel))!;
  const { plan, adapters } = translator!.translate(componentBytes);
  return { plan, componentBytes, adapters };
}

export async function instantiateFixture(
  rel: string,
  imports: Record<string, unknown> = {},
  opts: EmbedderOptions = {},
): Promise<EmbedderInstance> {
  return await instantiate(await artifactsOf(rel), imports, opts);
}

/** A built guest component from `examples/guests`. */
export function guest(name: string): string {
  return `examples/guests/build/${name}.component.wasm`;
}

/** A hand-written `.wat` fixture from the translator-shim corpus. */
export function testdata(name: string): string {
  return `crates/translator-shim/testdata/${name}.wasm`;
}

/** A `.wat` fixture owned by THIS suite (committed alongside its `.wasm`). */
export function local(name: string): string {
  return `runtime/tests/conventions/${name}.wasm`;
}

/** JSPI is the engine floor for the `suspending()` row. */
export function jspiSupported(): boolean {
  return typeof (WebAssembly as { Suspending?: unknown }).Suspending ===
    "function";
}
