// Runs INSIDE the throwaway consumer project (see ../smoke.mjs), so every
// import below resolves through node_modules exactly as a consumer's would.

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";

const require = createRequire(import.meta.url);

// 1. One copy of each package -----------------------------------------------
//
// Resolved from two different dependents: if the graph ever carries a nested
// duplicate, these paths diverge. `require.resolve` is the honest probe —
// it reports the file Node would actually load.
for (const pkg of ["@polyengine/protocol", "@polyengine/runtime"]) {
  const direct = require.resolve(`${pkg}/package.json`);
  const viaRuntime = require.resolve(`${pkg}/package.json`, {
    paths: [require.resolve("@polyengine/wasi/package.json")],
  });
  assert.equal(
    direct,
    viaRuntime,
    `${pkg} resolves to two different copies:\n  ${direct}\n  ${viaRuntime}`,
  );
}
console.log("    one copy of protocol and runtime");

// 2. Brands cross package boundaries ----------------------------------------
const protocol = await import("@polyengine/protocol");
const embedder = await import("@polyengine/runtime/embedder");

assert.equal(
  protocol.COMPONENT_EXCEPTION,
  Symbol.for("polyengine.componentException/1"),
  "brand key is not the expected registry symbol",
);
assert.equal(protocol.PROTOCOL_GENERATION, 1, "unexpected brand generation");

const thrown = new embedder.ComponentException({ kind: "smoke" });
assert.ok(
  protocol.isComponentException(thrown),
  "a runtime-minted ComponentException is not recognized by the protocol package",
);
assert.ok(
  thrown[Symbol.for("polyengine.componentException/1")],
  "the brand symbol is not present on the instance",
);

// A hand-rolled brand — the zero-import host-module path — must be honored too.
const handRolled = Object.assign(new Error("hand-rolled"), {
  [Symbol.for("polyengine.componentException/1")]: true,
  payload: { kind: "smoke" },
});
assert.ok(
  protocol.isComponentException(handRolled),
  "a hand-rolled brand is not recognized",
);
console.log("    brands cross package boundaries");

// 3. The census sees exactly one runtime copy -------------------------------
const census = protocol.copyCensus();
assert.equal(
  census,
  "",
  `expected a single-copy graph, census reported: ${census}`,
);
console.log("    copy census clean");

// 4. Translate and run a real component -------------------------------------
const { defaultTranslator } = await import("@polyengine/translator");
const translator = await defaultTranslator();
const componentBytes = new Uint8Array(
  await readFile(new URL("./hello.component.wasm", import.meta.url)),
);
const component = await embedder.instantiate({ componentBytes, translator }, {});
const greeting = await component.exports.greet("npm");
assert.equal(greeting, "Hello, npm!", `unexpected greeting: ${greeting}`);
console.log(`    translated and ran a component: ${greeting}`);

// 5. The remaining packages load and expose their surface -------------------
const wasi = await import("@polyengine/wasi");
assert.equal(typeof wasi.wasi, "function", "@polyengine/wasi missing wasi()");
const imports = wasi.wasi();
assert.ok(
  Object.keys(imports).length > 0,
  "wasi() produced an empty import record",
);

const ctRunner = await import("@polyengine/ct-runner");
assert.equal(
  typeof ctRunner.runSuite,
  "function",
  "@polyengine/ct-runner missing runSuite()",
);

// Subpath exports resolve (a missing one is invisible until imported).
for (
  const subpath of [
    "@polyengine/runtime/shim",
    "@polyengine/runtime/plan",
    "@polyengine/runtime/cache",
    "@polyengine/wasi/clocks",
    "@polyengine/wasi/filesystem-node",
    "@polyengine/ct-runner/run",
  ]
) {
  const mod = await import(subpath);
  assert.ok(
    Object.keys(mod).length > 0,
    `${subpath} resolved but exported nothing`,
  );
}
console.log("    every declared subpath export resolves");

// The one Deno-only export must fail legibly rather than with a ReferenceError.
const { dirCache } = await import("@polyengine/runtime/cache");
assert.throws(
  () => dirCache("/tmp/whatever"),
  /not Deno/,
  "dirCache() should refuse legibly off Deno",
);
console.log("    dirCache() refuses legibly off Deno");
