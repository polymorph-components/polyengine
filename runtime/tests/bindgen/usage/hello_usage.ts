// Hand-written usage sample exercising the generated `hello.ts` facade
// ("a hand-written usage sample per world must pass `deno
// check` against the generated types"). Type-check only — no runtime
// component here, just call-site type shape verification against the
// embedder conventions (contracts/embedder-api.md).

import type { WirePlan } from "../../../src/plan/mod.ts";
import { bind, instantiate, verify, WORLD_DIGEST } from "../generated/hello.ts";
import type { HelloExports } from "../generated/hello.ts";
import type { InstantiateSource } from "../../../src/embedder/mod.ts";
import type { EmbedderInstance } from "../../../src/embedder/mod.ts";
import type { Equal, Expect } from "./type_assert.ts";

// Exports are uniformly Promise-shaped (contracts/embedder-api.md
// §"Functions and async"), even though `greet` is a sync WIT func.
type _GreetIsPromiseShaped = Expect<
  Equal<HelloExports["greet"], (name: string) => Promise<string>>
>;

export async function useHello(instance: EmbedderInstance, plan: WirePlan) {
  const mismatch = await verify(plan);
  if (mismatch) {
    throw new Error(
      `hello world digest mismatch: expected ${mismatch.expected}, got ${mismatch.actual}`,
    );
  }
  const exports = bind(instance);
  const greeting: string = await exports.greet("component model");
  return { greeting, digest: WORLD_DIGEST };
}

// The verified default path (issue #184): the generated `instantiate`
// runs the world-digest handshake against WORLD_DIGEST before any guest
// code runs, throwing `WorldDigestMismatchError` on skew — the manual
// verify+bind pair above is the advanced/pre-verified route.
export async function useHelloVerified(source: InstantiateSource) {
  const { exports, handle } = await instantiate(source);
  const greeting: string = await exports.greet("component model");
  return { greeting, handle };
}
