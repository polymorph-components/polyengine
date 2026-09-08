// mapCoreException's layering rule (runtime/src/exec/boundary.ts): a real
// core-wasm trap surfaces as our `Trap` type carrying the engine's raw
// message, with the `guest trapped: ` provenance prefix intact — no
// translation to another host's wording (e.g. wasmtime's). Suite-wording
// normalization lives in the harness (`TRAP_MESSAGE_EQUIVALENTS`,
// harness/src/runner.ts), not here.

import { assertEq } from "./support/asserts.ts";
import { Trap } from "../src/cabi/mod.ts";
import { callCore } from "../src/exec/boundary.ts";

/** A real `WebAssembly.Module` whose sole export unconditionally traps. */
function unreachableCoreFn(): (...args: unknown[]) => unknown {
  const wat = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d, // \0asm
    0x01,
    0x00,
    0x00,
    0x00, // version 1
    // type section: () -> ()
    0x01,
    0x04,
    0x01,
    0x60,
    0x00,
    0x00,
    // function section: 1 function of type 0
    0x03,
    0x02,
    0x01,
    0x00,
    // export section: export "f" as function 0
    0x07,
    0x05,
    0x01,
    0x01,
    0x66,
    0x00,
    0x00,
    // code section: body = unreachable; end
    0x0a,
    0x05,
    0x01,
    0x03,
    0x00,
    0x00,
    0x0b,
  ]);
  const mod = new WebAssembly.Module(wat);
  const inst = new WebAssembly.Instance(mod, {});
  return inst.exports.f as (...args: unknown[]) => unknown;
}

Deno.test("callCore: a real core `unreachable` trap surfaces as a Trap with the raw engine message, provenance-prefixed", () => {
  const fn = unreachableCoreFn();
  let caught: unknown;
  try {
    callCore(fn as never, []);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Trap)) {
    throw new Error(`expected a Trap, got ${String(caught)}`);
  }
  // V8's own wording for this trap is exactly "unreachable" (see
  // harness/src/runner.ts TRAP_MESSAGE_EQUIVALENTS for the cross-engine
  // spellings); the runtime does not translate it to wasmtime's
  // "wasm trap: wasm `unreachable` instruction executed" — that
  // normalization is the harness's job now, not the runtime's.
  assertEq((caught as Trap).message, "guest trapped: unreachable");
});
