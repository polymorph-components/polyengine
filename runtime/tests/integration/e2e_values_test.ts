// STRETCH (not gating): the `values` fixture's 17 echo exports through
// the same shim -> plan -> executor path as hello. Exercises the descriptor
// IR + cabi interpreter across every WIT type shape in the fixture corpus.
//
// Host value shapes are the cabi v1 interpreter's (definitions.py's semantics,
// our representation:
// `{kind, value}` variant/option/result objects, despecialized tuple records,
// label->bool flags) — NOT the ergonomic mapping table of descriptor-ir.md
// §"Host value mapping", which the interpreter does not implement yet.

import { assertEq } from "../support/asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";
import type { ComponentValue } from "../../src/cabi/mod.ts";

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
const valuesWasm = await readArtifact(
  "examples/guests/build/values.component.wasm",
  "./examples/build.sh",
);

const translator = await Translator.create(shimWasm);
const { plan, adapters } = translator.translate(valuesWasm);
const component = await instantiateComponent({
  plan,
  componentBytes: valuesWasm,
  adapters,
});

type EchoFn = (v: ComponentValue) => ComponentValue;
const echo = (name: string): EchoFn => {
  const fn = component.exports[name] as EchoFn | undefined;
  if (typeof fn !== "function") {
    throw new Error(`export ${name} missing; have: ${
      Object.keys(component.exports).join(", ")
    }`);
  }
  return fn;
};

function roundtrips(name: string, values: ComponentValue[]) {
  Deno.test(`values: ${name} roundtrips`, () => {
    const fn = echo(name);
    for (const v of values) {
      assertEq(fn(v), v, `${name}(${JSON.stringify(v, jsonBigint)})`);
    }
  });
}

// deno-lint-ignore no-explicit-any
function jsonBigint(_k: string, v: any) {
  return typeof v === "bigint" ? `${v}n` : v;
}

roundtrips("echo-bool", [true, false]);
roundtrips("echo-u64", [0n, 1n, 18446744073709551615n]);
roundtrips("echo-s64", [0n, -1n, -9223372036854775808n, 9223372036854775807n]);
roundtrips("echo-f32", [0, 1.5, -3.25, NaN]);
roundtrips("echo-f64", [0, Math.PI, -1e308, NaN]);
roundtrips("echo-char", ["a", "é", "🎉"]);
roundtrips("echo-string", ["", "hello", "héllo wörld 🌍", "\u0000embedded"]);
roundtrips("echo-record", [
  { a: 0, b: "", c: 0, d: false },
  { a: 4294967295, b: "record string", c: -2.5, d: true },
]);
roundtrips("echo-variant", [
  { kind: "point", value: null },
  { kind: "circle", value: 2.5 },
  { kind: "label", value: "hi" },
  { kind: "rect", value: { w: 3, h: 4 } },
]);
roundtrips("echo-enum", [
  { kind: "red", value: null },
  { kind: "green", value: null },
  { kind: "blue", value: null },
]);
roundtrips("echo-flags", [
  { read: true, write: false, exec: true, admin: false },
  { read: false, write: false, exec: false, admin: false },
  { read: true, write: true, exec: true, admin: true },
]);
roundtrips("echo-option", [
  { kind: "none", value: null },
  { kind: "some", value: "present" },
]);
roundtrips("echo-option-nested", [
  { kind: "none", value: null },
  { kind: "some", value: { kind: "none", value: null } },
  { kind: "some", value: { kind: "some", value: 7 } },
]);
roundtrips("echo-result", [
  { kind: "ok", value: 42 },
  { kind: "error", value: "went wrong" },
]);
roundtrips("echo-list-u8", [
  new Uint8Array(0),
  new Uint8Array([0, 1, 2, 254, 255]),
  new Uint8Array(4096).fill(0xab),
]);
roundtrips("echo-list-string", [
  [],
  ["one"],
  ["", "two", "threê", "🌍"],
]);
roundtrips("echo-tuple", [
  { "0": 0, "1": "", "2": 0 },
  { "0": 9, "1": "nine", "2": 9.25 },
]);

Deno.test("values: every call went through the task model", () => {
  // One task per lifted call, all resolved, none leaked.
  assertEq(component.stats.liftedCalls, component.stats.tasksResolved);
  assertEq(component.stats.liftedCalls > 0, true);
  const inst = component.componentInstances[0];
  // `inst.threads` is the reference's `Table[Thread]` (definitions.py
  // `ComponentInstance.threads`), so "no threads left" is an empty iteration.
  assertEq([...inst.threads].length, 0);
});
