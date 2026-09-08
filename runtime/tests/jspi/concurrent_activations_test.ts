// Claim (f) — docs/architecture.md §6: two concurrent suspended activations of the same
// instance/memory. Legal at engine level? (Already exercised incidentally in
// reentry_test.ts's second case; this file pins it as its own named claim,
// and additionally checks that both activations observe/produce correct
// independent results — i.e. no cross-talk between the two suspended stacks
// sharing the one instance.)

import { assertEquals } from "./asserts.ts";
import { instantiateActivation } from "./support.ts";

Deno.test("two concurrent suspended activations of the same instance are legal and independent", async () => {
  const pending: Array<{ x: number; resolve: (v: number) => void }> = [];
  const exp = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) =>
      new Promise<number>((resolve) => {
        pending.push({ x, resolve });
      })
    ),
  });

  const runPromising = WebAssembly.promising(exp.run);

  // Fire three concurrent suspended activations of the SAME instance.
  const p1 = runPromising(1);
  const p2 = runPromising(2);
  const p3 = runPromising(3);

  assertEquals(
    pending.length,
    3,
    "OBSERVED: engine permits N concurrent suspensions on one instance",
  );

  // Resolve out of order to rule out any hidden FIFO/queueing assumption.
  const byX = new Map(pending.map((p) => [p.x, p]));
  byX.get(2)!.resolve(200);
  byX.get(1)!.resolve(100);
  byX.get(3)!.resolve(300);

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  // run(x) = block(x) + 1, block(x) resolves to the value we passed in.
  assertEquals(r1, 101);
  assertEquals(r2, 201);
  assertEquals(r3, 301);
});
