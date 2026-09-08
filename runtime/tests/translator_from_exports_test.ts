// Translator.fromExports — the ESM wasm-module import path (issue #16
// delivery design note): Deno's native wasm imports hand back an
// instantiated namespace; `fromExports` wraps it with no compile and no
// copy. Pinned here: the wrapped namespace translates identically to a
// bytes-constructed Translator (envelope equality), the missing-export
// refusal, and the buildHash contract (null unless supplied).

import { assertEq } from "./support/asserts.ts";
import { Translator } from "../src/shim/mod.ts";

const shimUrl = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
  import.meta.url,
);
const trivialUrl = new URL(
  "../../crates/translator-shim/testdata/trivial.wasm",
  import.meta.url,
);

async function maybeRead(url: URL): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(url);
  } catch {
    return null;
  }
}

const shimBytes = await maybeRead(shimUrl);
const trivial = await maybeRead(trivialUrl);
const ready = shimBytes !== null && trivial !== null;

Deno.test({
  name:
    "fromExports: a native wasm-module import translates identically to create(bytes)",
  ignore: !ready,
  fn: async () => {
    // Deno's ESM wasm integration: dynamic import instantiates the
    // zero-import shim and returns its exports as the module namespace.
    const ns = await import(shimUrl.href);
    const viaImport = Translator.fromExports(ns);
    const viaBytes = await Translator.create(shimBytes!);
    // Envelope equality is the strongest cheap equivalence: same plan JSON,
    // same adapters, byte for byte.
    assertEq(
      viaImport.translateRaw(trivial!),
      viaBytes.translateRaw(trivial!),
      "envelopes must match",
    );
  },
});

Deno.test({
  name: "fromExports: repeated translations on the shared instance stay stable",
  ignore: !ready,
  fn: async () => {
    const ns = await import(shimUrl.href);
    const t = Translator.fromExports(ns);
    const first = t.translateRaw(trivial!);
    for (let i = 0; i < 3; i++) {
      assertEq(t.translateRaw(trivial!), first, `translation ${i} drifted`);
    }
  },
});

Deno.test("fromExports: a namespace missing shim exports is refused by name", () => {
  let raised: unknown;
  try {
    Translator.fromExports({ memory: new WebAssembly.Memory({ initial: 1 }) });
  } catch (e) {
    raised = e;
  }
  assertEq(
    String(raised).includes("ts_alloc"),
    true,
    `should name the missing export, got: ${raised}`,
  );
});

Deno.test({
  name: "fromExports: buildHash is null unless supplied",
  ignore: !ready,
  fn: async () => {
    const ns = await import(shimUrl.href);
    assertEq(Translator.fromExports(ns).buildHash, null, "default null");
    assertEq(
      Translator.fromExports(ns, { buildHash: "abc123" }).buildHash,
      "abc123",
      "supplied hash carried",
    );
  },
});
