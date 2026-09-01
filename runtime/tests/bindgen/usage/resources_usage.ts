// Hand-written usage sample for the generated `resources.ts` facade —
// pins the guest-implemented resource class shape (constructor, camelCase
// methods/statics, `[Symbol.dispose]`/`drop`), the interface-id-keyed
// exports record, and Promise-shaped resource methods/statics
// (contracts/embedder-api.md §"Resources" + "Functions and async").

import { bind } from "../generated/resources.ts";
import type { Counter, ResourcesExports } from "../generated/resources.ts";
import type { EmbedderInstance } from "../../../src/embedder/mod.ts";
import type { Equal, Expect } from "./type_assert.ts";

// Resource methods/statics are camelCase and Promise-shaped, same as plain
// exports (dispatch: "exports uniformly Promise-shaped applies to
// functions AND resource methods").
type _IncrementIsPromise = Expect<
  Equal<Counter["increment"], () => Promise<bigint>>
>;
type _GetIsPromise = Expect<Equal<Counter["get"], () => Promise<bigint>>>;
type _MergeIsStaticPromise = Expect<
  Equal<typeof Counter.merge, (a: Counter, b: Counter) => Promise<Counter>>
>;

// `using` works: [Symbol.dispose] present (TS 5.2+ explicit resource
// management, Deno 2.9's bundled TypeScript supports it).
type _HasSymbolDispose = Expect<
  Equal<ReturnType<Counter[typeof Symbol.dispose]>, void>
>;

// **Constructors are synchronous** (contracts/embedder-api.md
// §"Resources"): a JS class constructor cannot await, so `new Counter(...)`
// is typed as an ordinary synchronous constructor despite going through an
// async guest-export ABI call underneath — a runtime error (named) if the
// guest constructor fails to complete synchronously.
type _ConstructorIsSync = Expect<
  Equal<ConstructorParameters<typeof Counter>, [bigint]>
>;

export async function useResources(instance: EmbedderInstance) {
  const exports: ResourcesExports = bind(instance);
  const counters = exports["polyengine:resources/counters"];

  const c: Counter = new counters.Counter(0n);
  const bumped: bigint = await c.increment();
  const value: bigint = await c.get();

  const c2: Counter = await counters.makeCounter(10n);
  const merged: Counter = await counters.Counter.merge(c, c2);
  const summed: bigint = await counters.sumBoth(c, c2);
  const afterBump: bigint = await counters.bump(c, 5n);
  const consumed: bigint = await counters.consume(merged);
  const alive: number = await counters.liveCounters();

  // `using` disposes at scope exit — instance stays valid only while
  // retained (own/borrow invalidation is runtime-enforced, not type-level;
  // this just pins that the member exists with the right shape).
  using _c3 = await counters.makeCounter(1n);
  void _c3;

  return { bumped, value, summed, afterBump, consumed, alive };
}
