// The generated typed `instantiate` wrapper's digest handshake (issue #184).
//
// contracts/embedder-api.md §"Module wiring and instantiation" +
// contracts/digest.md: bindings embed the expected world digest and the
// digest is recomputed from the loaded plan AT INSTANTIATE TIME, failing
// fast on mismatch (no structural diff). `crates/bindgen` emits that
// path as `instantiate` in every generated module (the checked-in
// snapshots under ./generated); this test drives it against real
// translated components.
//
// Requires build artifacts (both produced from source in this repo):
//   - target/wasm32-unknown-unknown/release/translator_shim.wasm
//       cargo build -p translator-shim --release --target wasm32-unknown-unknown
//   - examples/guests/build/{hello,values}.component.wasm
//       ./examples/build.sh

import { assertEq } from "../support/asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { WorldDigestMismatchError } from "../../src/digest/mod.ts";
import type { EmbedderInstance } from "../../src/embedder/mod.ts";
import * as hello from "./generated/hello.ts";
import * as values from "./generated/values.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

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
const helloWasm = await readArtifact(
  "examples/guests/build/hello.component.wasm",
  "./examples/build.sh",
);
const valuesWasm = await readArtifact(
  "examples/guests/build/values.component.wasm",
  "./examples/build.sh",
);

const translator = await Translator.create(shimWasm);

function artifacts(componentBytes: Uint8Array) {
  const { plan, adapters } = translator.translate(componentBytes);
  return { plan, componentBytes, adapters };
}

Deno.test("generated instantiate: matching component verifies and binds", async () => {
  const instance = await hello.instantiate(artifacts(helloWasm));

  // Typed exports work through the wrapper's return value...
  assertEq(await instance.exports.greet("component model"), "Hello, component model!");
  // ...and the embedder-conventions instance shape is preserved
  // (contracts/embedder-api.md: `{ exports, handle, imports }`).
  assert(instance.handle !== undefined, "wrapper must expose the runtime handle");
  assert(Array.isArray(instance.imports), "wrapper must expose the import leaves");
});

Deno.test("generated instantiate: also accepts an untranslated source", async () => {
  const instance = await hello.instantiate({
    componentBytes: helloWasm,
    translator,
  });
  assertEq(await instance.exports.greet("polyengine"), "Hello, polyengine!");
});

Deno.test("generated instantiate: skew fails fast before any guest code runs", async () => {
  // Bindings for world `hello`, plan for a DIFFERENT component (`values`):
  // exactly the stale-bindings scenario the handshake exists for.
  let caught: unknown;
  let returned: unknown = "<not assigned>";
  try {
    returned = await hello.instantiate(artifacts(valuesWasm));
  } catch (e) {
    caught = e;
  }

  assert(
    caught instanceof WorldDigestMismatchError,
    `expected WorldDigestMismatchError, got ${caught}`,
  );
  assertEq(caught.name, "WorldDigestMismatchError");
  assertEq(caught.world, "hello");
  assertEq(caught.expected, hello.WORLD_DIGEST);
  assert(caught.actual !== hello.WORLD_DIGEST, "actual digest must differ");
  assertEq(caught.mismatch.expected, hello.WORLD_DIGEST);
  // No instance escaped: nothing was instantiated, so no initializer and no
  // guest code ran (the throw happens before `instantiateEmbedder`).
  assertEq(returned, "<not assigned>");

  // Control: the right bindings for the same component do instantiate,
  // proving the failure above is the digest check and not a broken fixture.
  const ok = await values.instantiate(artifacts(valuesWasm));
  assert(ok.handle !== undefined, "values bindings must instantiate values");
});

Deno.test("generated bind(): unchecked cast, no verification", () => {
  // `bind` stays a pure cast (identity on `.exports`) — it must NOT verify,
  // even when handed an instance whose plan could never match this world.
  const exports = { greet: () => "not really" };
  const fake = { exports, handle: null, imports: [] } as unknown as EmbedderInstance;
  const bound = hello.bind(fake);
  assert(
    bound === (exports as unknown as hello.HelloExports),
    "bind must return the same `exports` object it was given",
  );
});
