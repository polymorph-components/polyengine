// defaultTranslator: the packaged loader works (Deno path = native wasm
// import via Translator.fromExports), caches per realm, and translates
// identically to a bytes-built Translator.

import { defaultTranslator } from "../mod.ts";
import { Translator } from "@polyengine/runtime/shim";

function assertEq(got: unknown, want: unknown, what: string) {
  if (got !== want) throw new Error(`${what}: expected ${want}, got ${got}`);
}

async function maybeRead(url: URL): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(url);
  } catch {
    return null;
  }
}

const trivial = await maybeRead(
  new URL(
    "../../crates/translator-shim/testdata/trivial.wasm",
    import.meta.url,
  ),
);
const asset = await maybeRead(
  new URL("../translator_shim.wasm", import.meta.url),
);
const ready = trivial !== null && asset !== null;

Deno.test({
  name:
    "defaultTranslator: loads, translates, and matches a bytes-built Translator",
  ignore: !ready,
  fn: async () => {
    const t = await defaultTranslator();
    const reference = await Translator.create(asset!);
    assertEq(
      t.translateRaw(trivial!),
      reference.translateRaw(trivial!),
      "envelope equality",
    );
  },
});

Deno.test({
  name: "defaultTranslator: one instance per realm",
  ignore: !ready,
  fn: async () => {
    assertEq(
      await defaultTranslator() === await defaultTranslator(),
      true,
      "singleton identity",
    );
  },
});
