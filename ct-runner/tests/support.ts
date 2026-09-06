// Shared fixture plumbing for ct-runner's tests: translate the guest fixture
// with the shim, same pattern as runtime/tests/embedder/support.ts.

import { Translator } from "../../runtime/src/shim/mod.ts";
import type { ComponentArtifacts } from "../../runtime/src/embedder/mod.ts";
import type { RunCounts } from "../src/mod.ts";

const root = new URL("../../", import.meta.url);

export async function readArtifact(rel: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    return null;
  }
}

const shimWasm = await readArtifact(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
);
const translator = shimWasm === null ? null : await Translator.create(shimWasm);

export async function haveFixture(rel: string): Promise<boolean> {
  return translator !== null && (await readArtifact(rel)) !== null;
}

export async function artifactsOf(rel: string): Promise<ComponentArtifacts> {
  const componentBytes = (await readArtifact(rel))!;
  return artifactsOfBytes(componentBytes);
}

/** Translate caller-supplied component bytes (e.g. a fixture with a
 * synthesized `component-test:tags@0.1` section appended). */
export function artifactsOfBytes(
  componentBytes: Uint8Array,
): ComponentArtifacts {
  const { plan, adapters } = translator!.translate(componentBytes);
  return { plan, componentBytes, adapters };
}

export const TEST_SUITE_WASM = "examples/guests/build/test-suite.component.wasm";

/** `runSuite`'s tally for an unfiltered, untagged run of TEST_SUITE_WASM
 * (4 pass, 1 fail, 1 skip; nothing gated or deselected). Tests whose
 * subject is not the counts assert this whole; tests ABOUT `only`/tags
 * spell out their own. */
export const FULL_RUN_COUNTS: RunCounts = {
  passed: 4, failed: 1, skipped: 1, na: 0, deselected: 0, selected: 6, total: 6,
};
