// Resolution test: leaves at three 0.2.x versions all resolve against
// the one `@0.2` track provider — via the embedder's real `ImportResolver`,
// not string tricks (contracts/embedder-api.md §"Version canonicalization").

import { assertEq, assertTrue } from "./asserts.ts";
import { ImportResolver } from "@polyengine/runtime/embedder";
import { wasi } from "../src/mod.ts";

Deno.test("the one wasi() @0.2 provider serves 0.2.6 / 0.2.9 / 0.2.12", () => {
  const shims = wasi();
  const resolver = new ImportResolver(shims);
  for (const v of ["0.2.6", "0.2.9", "0.2.12"]) {
    const hit = resolver.resolve(`wasi:cli/environment@${v}`);
    assertTrue(hit !== undefined, `resolves at ${v}`);
    assertEq(hit!.key, "wasi:cli/environment@0.2");
    assertEq(hit!.value, shims["wasi:cli/environment@0.2"]);
  }
  // Same claim for a second interface family, to rule out a fluke of one key.
  for (const v of ["0.2.6", "0.2.9", "0.2.12"]) {
    const hit = resolver.resolve(`wasi:io/streams@${v}`);
    assertTrue(hit !== undefined, `io/streams resolves at ${v}`);
    assertEq(hit!.key, "wasi:io/streams@0.2");
  }
});

Deno.test("the one wasi() @0.3 clocks provider serves both diverging drafts", () => {
  const shims = wasi();
  const resolver = new ImportResolver(shims);
  const hit = resolver.resolve("wasi:clocks/monotonic-clock@0.3.0");
  assertTrue(hit !== undefined);
  assertEq(hit!.key, "wasi:clocks/monotonic-clock@0.3");
  const provider = hit!.value as Record<string, unknown>;
  assertTrue(typeof provider.waitFor === "function");
  assertTrue(typeof provider.now === "function");
  assertTrue(typeof provider.waitUntil === "function");
});

Deno.test("wasi(): captured is reachable and not confused for a WIT import key", () => {
  const shims = wasi();
  assertTrue(typeof shims.captured.stdoutText === "function");
  // Registering the fragment must not throw — "captured" has neither `:`
  // nor `/`, so `ImportResolver` never treats it as an unversioned
  // interface-id folding hazard (runtime/src/embedder/version.ts `#register`).
  new ImportResolver(shims);
});

// --- virtualization composition (mod.ts "COMPOSITION" form 3) ------------------

Deno.test("virtualization: a spread-replaced track key serves the stub; siblings stay real", () => {
  const fixed = Uint8Array.from([7, 7, 7, 7]);
  const composed = {
    ...wasi(),
    "wasi:random/random@0.2": {
      getRandomBytes: (_len: bigint): Uint8Array => fixed,
      getRandomU64: (): bigint => 7n,
    },
  };
  const resolver = new ImportResolver(composed);
  // The stubbed interface resolves to the stub — at any 0.2.x the guest asks.
  const stubbed = resolver.resolve("wasi:random/random@0.2.9");
  assertTrue(stubbed !== undefined);
  const provider = stubbed!.value as { getRandomBytes(len: bigint): Uint8Array };
  assertEq(provider.getRandomBytes(4n), fixed);
  // Sibling interfaces from the SAME fragment are untouched.
  const sibling = resolver.resolve("wasi:random/insecure-seed@0.2.9");
  assertTrue(sibling !== undefined);
  assertEq(sibling!.key, "wasi:random/insecure-seed@0.2");
});

Deno.test("virtualization: track + exact keys on one track are refused, loudly", () => {
  // The documented boundary: override by REPLACING the track key, never by
  // adding an exact-versioned sibling (ambiguous; refused at registration).
  const composed = {
    ...wasi(),
    "wasi:random/random@0.2.9": { getRandomBytes: (): Uint8Array => new Uint8Array(0) },
  };
  let threw: unknown;
  try {
    new ImportResolver(composed);
  } catch (e) {
    threw = e;
  }
  assertTrue(threw !== undefined, "registration refuses the ambiguity");
  assertTrue(
    String(threw).includes("wasi:random/random"),
    `the refusal names the colliding interface, got: ${threw}`,
  );
});
