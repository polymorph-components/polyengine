// BONUS (stretch, not gating): the `resources` fixture through the same
// path — own/borrow handles at the host boundary (as raw reps, the cabi v1
// layer's representation), guest-side resource.new/rep/drop trampolines,
// and observable destructor runs via live-counters.

import { assertEq } from "../support/asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";

const root = new URL("../../../", import.meta.url);

async function readArtifact(rel: string, hint: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    throw new Error(`missing build artifact ${rel} — run: ${hint}`);
  }
}

const shimWasm = await readArtifact(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  "cargo build -p translator-shim --release --target wasm32-unknown-unknown",
);
const resourcesWasm = await readArtifact(
  "examples/guests/build/resources.component.wasm",
  "./examples/build.sh",
);

Deno.test("resources: instantiate + counter lifecycle + dtor observation", async () => {
  const translator = await Translator.create(shimWasm);
  const { plan, adapters } = translator.translate(resourcesWasm);
  const component = await instantiateComponent({
    plan,
    componentBytes: resourcesWasm,
    adapters,
  });

  const counters = component.exports["polyengine:resources/counters"] as
    Record<string, (...args: unknown[]) => unknown>;
  assertEq(typeof counters, "object");
  const names = Object.keys(counters).sort();
  assertEq(names.includes("make-counter"), true, `exports: ${names}`);

  const live = () => counters["live-counters"]() as number;
  assertEq(live(), 0);

  // make-counter returns an own handle (host-layer value: the rep).
  const a = counters["make-counter"](5n);
  const b = counters["make-counter"](10n);
  assertEq(live(), 2);

  // Borrows: must not invalidate the caller's handles.
  assertEq(counters["sum-both"](a, b), 15n);
  assertEq(counters["bump"](a, 2n), 7n);
  assertEq(live(), 2);

  // consume takes ownership; the dtor runs inside the call.
  assertEq(counters["consume"](a), 7n);
  assertEq(live(), 1);
  assertEq(counters["consume"](b), 10n);
  assertEq(live(), 0);
});
