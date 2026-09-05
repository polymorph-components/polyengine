// ISSUE #88: two core-wasm imports may legally share one `(module, field)`
// pair (core wasm permits it; wasmtime-environ 47.0.3 info.rs:438-445 gives
// one flat positional `CoreDef` per import *slot*, independent of naming).
// The JS `WebAssembly` API has no way to give two same-named import slots
// different values — building `importObject[module][field] = value` for
// each declared import in turn just makes the second write win. Before the
// #88 fix, a plan supplying two *different* `CoreDef`s for a duplicate name
// silently wired the wrong function into one of the slots; instantiation
// still succeeded because the JS API only checks total counts/types, not
// per-slot identity.
//
// Approach: a hand-built core module (byte-for-byte, following the pattern
// in boundary_trap_test.ts — this repo's test suite has no wat2wasm/
// component-shaping helper) with two `(env, g)` mutable-i32-global imports,
// driven through the full `instantiateComponent` entrypoint with a
// synthetic single-module plan. This exercises the real import-object
// builder in exec/executor.ts, not a re-implementation of it.

import { assertEq } from "./support/asserts.ts";
import { instantiateComponent } from "../src/exec/mod.ts";
import { PlanError, SUPPORTED_FORMAT_VERSION } from "../src/plan/mod.ts";
import type { WirePlan } from "../src/plan/format.ts";

/**
 * `(module (import "env" "g" (global (mut i32))) (import "env" "g" (global
 * (mut i32))))` — two imports sharing one `(module, field)` name, both
 * mutable i32 globals (so `ComponentInstanceState.flags`, a
 * `WebAssembly.Global({value:"i32",mutable:true})`, is a legal value for
 * either slot — see task/mod.ts).
 */
const DUP_IMPORT_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // \0asm, version 1
  // import section: 2 entries, each "env"."g" (mut i32 global)
  0x02, 0x13, 0x02,
  0x03, 0x65, 0x6e, 0x76, 0x01, 0x67, 0x03, 0x7f, 0x01,
  0x03, 0x65, 0x6e, 0x76, 0x01, 0x67, 0x03, 0x7f, 0x01,
]);

function planFor(args: WirePlan["initializers"][0] & { op: "instantiate-module" }): WirePlan {
  return {
    formatVersion: SUPPORTED_FORMAT_VERSION,
    producer: { shimVersion: "test", wasmtimeEnviron: "49.0.0-dev+4675ee1", features: [] },
    component: { sha256: "0".repeat(64), len: DUP_IMPORT_MODULE.length },
    modules: [{ kind: "embedded", offset: 0, len: DUP_IMPORT_MODULE.length }],
    initializers: [args],
    trampolines: [],
    canonicalOptions: [],
    types: [],
    resourceTables: [],
    streamTables: [],
    futureTables: [],
    errorContextTables: [],
    imports: [],
    exports: [],
    worldDigest: "sha256:0",
  };
}

Deno.test("executor: duplicate (module,field) core imports resolving to the SAME value instantiate fine", async () => {
  const plan = planFor({
    op: "instantiate-module",
    module: 0,
    instance: null,
    // Both slots reference `instance-flags` on the SAME component instance
    // (0): reference-identical values, which the JS API cannot distinguish
    // anyway — this must not throw.
    args: [
      { kind: "instance-flags", instance: 0 },
      { kind: "instance-flags", instance: 0 },
    ],
  });
  const component = await instantiateComponent({
    plan,
    componentBytes: DUP_IMPORT_MODULE,
    verifyHash: false,
  });
  assertEq(component.coreInstances.length, 1, "one core instance");
});

Deno.test("executor: duplicate (module,field) core imports resolving to DIFFERENT values is a typed PlanError naming module/field/indices", async () => {
  const plan = planFor({
    op: "instantiate-module",
    module: 0,
    instance: null,
    // Two DIFFERENT component instances -> two DIFFERENT `flags` Global
    // objects wired to the same "env"."g" import name: exactly the shape
    // #88 says must fail loudly rather than silently collapse to the last
    // write.
    args: [
      { kind: "instance-flags", instance: 0 },
      { kind: "instance-flags", instance: 1 },
    ],
  });
  let caught: unknown;
  try {
    await instantiateComponent({
      plan,
      componentBytes: DUP_IMPORT_MODULE,
      verifyHash: false,
    });
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof PlanError)) {
    throw new Error(`expected a PlanError, got ${caught}`);
  }
  const msg = String(caught);
  assertEq(msg.includes("env"), true, `message names the module: ${msg}`);
  assertEq(msg.includes("g"), true, `message names the field: ${msg}`);
  assertEq(msg.includes("0") && msg.includes("1"), true,
    `message names the conflicting arg indices: ${msg}`);
});
