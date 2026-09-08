// Claim (d) — docs/architecture.md §6: reentry while suspended.
//
// While instance A's export is suspended, call another export of the SAME
// instance. docs/architecture.md §6 says the engine permits this (the Component Model's
// reentrance rules are enforced by the host/scheduler, not the engine) —
// this test pins that the engine really does allow it, with no trap and no
// special interaction between the two activations (they operate on
// independent linear-memory state / locals; this fixture has none, but the
// absence of a trap and correct arithmetic on both sides is the pin).

import { assertEquals } from "./asserts.ts";
import { instantiateActivation } from "./support.ts";

Deno.test("reentry: calling another export of the same instance while one export is suspended is permitted by the engine", async () => {
  let resolveBlock: (v: number) => void;
  const blocked = new Promise<number>((r) => {
    resolveBlock = r;
  });

  const exp = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) =>
      blocked.then((v) => v + x)
    ),
  });

  const runPromising = WebAssembly.promising(exp.run);
  const suspendedCall = runPromising(5); // suspends immediately (blocked pending)

  // Reenter the SAME instance via a different export while `run` is
  // suspended. If the Component Model's reentrance gate were enforced by the
  // engine, this would trap; docs/architecture.md §6 says it is NOT — the CM-level check
  // is the scheduler's job (out of scope for this mechanics-only module).
  const otherResult = exp.other(1);
  assertEquals(
    otherResult,
    1001,
    "OBSERVED: reentry succeeds, no engine-level trap",
  );

  resolveBlock!(100);
  const result = await suspendedCall;
  // block(5) = 100 + 5 = 105; run() = block(x) + 1 = 106.
  assertEquals(result, 106);
});

Deno.test("reentry: can even call the SAME export again (a second independent activation) while the first is suspended", async () => {
  const resolvers: Array<(v: number) => void> = [];
  const exp = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) =>
      new Promise<number>((resolve) => {
        resolvers.push((v) => resolve(v + x));
      })
    ),
  });

  const runPromising = WebAssembly.promising(exp.run);
  const p1 = runPromising(1);
  const p2 = runPromising(2);
  assertEquals(resolvers.length, 2, "both calls suspended independently");

  resolvers[1](20); // resolve second first, to show independence of order
  resolvers[0](10);

  const [r1, r2] = await Promise.all([p1, p2]);
  // block(1) = 10 + 1 = 11; run(1) = 12.
  // block(2) = 20 + 2 = 22; run(2) = 23.
  assertEquals(r1, 12);
  assertEquals(r2, 23);
});
