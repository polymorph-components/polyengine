// The copy registry (contracts/embedder-api.md §"Module identity and
// @polyengine/protocol"; issue #83).
//
// The registry's job is diagnosis, never refusal. These tests use fake
// entries: the real registrant is runtime/src/embedder/mod.ts, and the
// end-to-end two-copies pin is tools/release-bundle/dual_copy_test.ts.

import { assert, assertEquals } from "./assert.ts";
import {
  copyCensus,
  PROTOCOL_GENERATION,
  registerRuntimeCopy,
  runtimeCopies,
} from "../src/mod.ts";
// RUNTIME_COPIES is @internal (not part of the public surface); this test
// reaches into the package's own module for the global-slot key.
import { RUNTIME_COPIES } from "../src/brands.ts";

function reset(): void {
  // deno-lint-ignore no-explicit-any
  delete (globalThis as any)[RUNTIME_COPIES];
}

Deno.test("registration is visible through the global slot", () => {
  reset();
  assertEquals(runtimeCopies().length, 0);
  assertEquals(copyCensus(), "", "a healthy graph adds nothing to messages");

  registerRuntimeCopy({
    url: "file:///a/mod.ts",
    runtimeVersion: "0.1.0",
    protocolGeneration: PROTOCOL_GENERATION,
  });
  assertEquals(runtimeCopies().length, 1);
  assertEquals(copyCensus(), "", "one copy is not a census-worthy event");

  registerRuntimeCopy({
    url: "file:///b/mod.ts",
    runtimeVersion: "0.1.0",
    protocolGeneration: PROTOCOL_GENERATION,
  });
  assertEquals(runtimeCopies().map((c) => c.url), [
    "file:///a/mod.ts",
    "file:///b/mod.ts",
  ]);
  assertEquals(
    copyCensus(),
    "2 polyengine copies loaded: file:///a/mod.ts, file:///b/mod.ts",
  );
  reset();
});

Deno.test("registration is idempotent per URL", () => {
  reset();
  const e = {
    url: "file:///a/mod.ts",
    runtimeVersion: "0.1.0",
    protocolGeneration: 1,
  };
  registerRuntimeCopy(e);
  registerRuntimeCopy({ ...e });
  assertEquals(runtimeCopies().length, 1);
  assertEquals(copyCensus(), "");
  reset();
});

Deno.test("a foreign pre-seeded array is adopted, never replaced", () => {
  reset();
  // Exactly the production shape: another copy (older package, bundled copy)
  // created the array before this module was ever evaluated.
  const foreign = [{
    url: "file:///bundled.mjs",
    runtimeVersion: "0.0.9",
    protocolGeneration: 1,
  }];
  // deno-lint-ignore no-explicit-any
  (globalThis as any)[RUNTIME_COPIES] = foreign;

  registerRuntimeCopy({
    url: "file:///src/mod.ts",
    runtimeVersion: "0.1.0",
    protocolGeneration: PROTOCOL_GENERATION,
  });
  assertEquals(foreign.length, 2, "we appended to THEIR array");
  assertEquals(runtimeCopies().map((c) => c.url), [
    "file:///bundled.mjs",
    "file:///src/mod.ts",
  ]);
  assert(copyCensus().includes("file:///bundled.mjs"));
  assert(copyCensus().includes("file:///src/mod.ts"));
  reset();
});

Deno.test("entries are frozen and snapshots do not alias the slot", () => {
  reset();
  registerRuntimeCopy({
    url: "file:///a/mod.ts",
    runtimeVersion: "0.1.0",
    protocolGeneration: 1,
  });
  const snap = runtimeCopies();
  assert(Object.isFrozen(snap[0]));
  (snap as unknown as unknown[]).push({ url: "file:///forged.ts" });
  assertEquals(runtimeCopies().length, 1);
  reset();
});
