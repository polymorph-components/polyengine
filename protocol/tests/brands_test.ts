// Golden pin for the brand vocabulary (contracts/embedder-api.md §"Module
// identity and @polyengine/protocol", amendment A9; issue #83).
//
// Every key string is pinned LITERALLY here on purpose: the brands are
// process-global registry symbols shared with copies this repo never sees, so
// renaming a key — or bumping a generation suffix — is a breaking ecosystem
// event, not a refactor. It must fail a test, loudly, right here.

import { assertEquals } from "./assert.ts";
import * as brands from "../src/brands.ts";
import { PROTOCOL_GENERATION, ComponentException } from "../src/mod.ts";

const EXPECTED: Record<string, symbol> = {
  "polyengine.componentException/1": brands.COMPONENT_EXCEPTION,
  "polyengine.trap/1": brands.TRAP,
  "polyengine.dropped/1": brands.DROPPED,
  "polyengine.peerTrapped/1": brands.PEER_TRAPPED,
  "polyengine.invalidHandle/1": brands.INVALID_HANDLE,
  "polyengine.streamProducer/1": brands.STREAM_PRODUCER,
  "polyengine.suspending/1": brands.SUSPENDING,
  "polyengine.deferCancel/1": brands.DEFER_CANCEL,
  "polyengine.abortable/1": brands.ABORTABLE,
  "polyengine.stream/1": brands.STREAM,
  "polyengine.streamWriter/1": brands.STREAM_WRITER,
  "polyengine.future/1": brands.FUTURE,
  "polyengine.errorContext/1": brands.ERROR_CONTEXT,
  "polyengine.resourceState/1": brands.RESOURCE_STATE,
  "polyengine.pollable/1": brands.POLLABLE,
  "polyengine.wasiExit/1": brands.WASI_EXIT,
  "polyengine.runtimeCopies/1": brands.RUNTIME_COPIES,
};

// The realm-local pill (amendment A20) is a STRING key, not a registry
// symbol, so it sits outside the table above — but it is shared vocabulary
// across copies exactly as the brands are, and renaming it is the same
// breaking ecosystem event. Pinned literally for the same reason.
const EXPECTED_REALM_LOCAL = "polyengine.realmLocal/1";

Deno.test("A9: every brand key is exactly the contract's table entry", () => {
  for (const [key, sym] of Object.entries(EXPECTED)) {
    assertEquals(sym, Symbol.for(key), `brand key drift for ${key}`);
    assertEquals(Symbol.keyFor(sym), key, `${key} is not a registry symbol`);
  }
});

Deno.test("A9: the table is exhaustive — no unpinned exported brand", () => {
  const exported = (Object.values(brands) as unknown[])
    .filter((v): v is symbol => typeof v === "symbol")
    .map((s) => Symbol.keyFor(s) ?? "<not a registry symbol>")
    .sort();
  assertEquals(exported, Object.keys(EXPECTED).sort());
});

Deno.test("A20: the realm-local pill key is exactly the contract's spelling", () => {
  assertEquals(brands.REALM_LOCAL, EXPECTED_REALM_LOCAL);
  assertEquals(EXPECTED_REALM_LOCAL.endsWith(`/${PROTOCOL_GENERATION}`), true);
});

Deno.test("A9: the protocol generation matches the key suffix", () => {
  assertEquals(PROTOCOL_GENERATION, 1);
  for (const key of Object.keys(EXPECTED)) {
    assertEquals(key.endsWith(`/${PROTOCOL_GENERATION}`), true, key);
  }
});

Deno.test("A9: brands are non-enumerable and non-writable on prototypes", () => {
  const d = Object.getOwnPropertyDescriptor(
    ComponentException.prototype,
    brands.COMPONENT_EXCEPTION,
  );
  assertEquals(d?.value, true);
  assertEquals(d?.enumerable, false);
  assertEquals(d?.writable, false);
  // Not inherited by plain objects, and invisible to value walks.
  assertEquals(Object.keys(new ComponentException(1)).includes("payload"), true);
  assertEquals(
    Object.getOwnPropertySymbols(new ComponentException(1)).length,
    0,
    "the brand lives on the prototype, never on instances",
  );
});
