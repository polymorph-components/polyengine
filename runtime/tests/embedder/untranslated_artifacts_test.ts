// The untranslated artifacts shape (contracts/embedder-api.md
// §"Module wiring and instantiation"): `instantiate` accepts `{ componentBytes, translator }` and runs the
// translation internally — bytes in, instance out. Both translator
// spellings are pinned: raw shim wasm bytes (compiles per call) and a
// shared `Translator` instance (the multi-component pattern).

import { assertEq } from "../support/asserts.ts";
import { haveFixture, readArtifact, testdata } from "./support.ts";
import { instantiate } from "../../src/embedder/mod.ts";
import { Translator } from "../../src/shim/mod.ts";

const shimWasm = await readArtifact(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
);
const ready = shimWasm !== null && (await haveFixture(testdata("imports")));

const IMPORTS = {
  log: (_x: number) => {},
  "host:api/math": {
    add: (a: number, b: number) => a + b,
    greet: (who: string) => `hello ${who}`,
  },
};

Deno.test({
  name: "module wiring: instantiate({ componentBytes, translator: bytes }) translates internally",
  ignore: !ready,
  fn: async () => {
    const componentBytes = (await readArtifact(testdata("imports")))!;
    const c = await instantiate({ componentBytes, translator: shimWasm! }, IMPORTS);
    assertEq(await c.exports.run(2, 40), 42);
  },
});

Deno.test({
  name: "module wiring: a shared Translator instance serves several instantiations",
  ignore: !ready,
  fn: async () => {
    const translator = await Translator.create(shimWasm!);
    const componentBytes = (await readArtifact(testdata("imports")))!;
    const a = await instantiate({ componentBytes, translator }, IMPORTS);
    const b = await instantiate({ componentBytes, translator }, IMPORTS);
    assertEq(await a.exports.run(1, 2), 3);
    assertEq(await b.exports.run(3, 4), 7);
  },
});
