// The host half of the hello-world example — the whole pipeline is one
// call: give `instantiate` the component bytes and the translator, get
// typed-shaped exports back.
//
// The translator comes from @polyengine/translator — on Deno it arrives via a
// native wasm-module import (permission-free); the only permission this
// script needs is reading the component it runs:
//
//   deno run --allow-read=build host.ts
//
// Inside this repository `@polyengine/runtime` and `@polyengine/translator`
// resolve through the Deno workspace; a published consumer uses the same
// specifiers via JSR/npm.

import { instantiate } from "@polyengine/runtime/embedder";
import { defaultTranslator } from "@polyengine/translator";

const translator = await defaultTranslator();
const componentBytes = await Deno.readFile(
  new URL("build/hello.component.wasm", import.meta.url),
);

const component = await instantiate({ componentBytes, translator }, {
  // ... imports would go here; this world has none. See ../kitchen-sink.
});

// Exports are uniformly Promise-shaped (a sync guest resolves immediately).
const greeting = await component.exports.greet("component model");
console.log(greeting);

if (greeting !== "Hello, component model!") {
  throw new Error(`unexpected greeting: ${greeting}`);
}
console.log("hello-world example: OK");
