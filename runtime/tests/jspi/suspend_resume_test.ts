// Claim (a) — docs/architecture.md §5: suspension through a pure-wasm stack works.
//
// promising(export) → wasm → Suspending(import returning a real Promise) →
// suspends → resolves → wasm resumes → export result delivered.
//
// Pinned against Deno 2.9.5 / V8 15.0.245.2-rusty. OBSERVED: matches spec —
// no surprises here; the interesting divergences are in frame_rule_test.ts
// and reentry_test.ts.

import { assertEquals } from "./asserts.ts";
import { instantiateActivation } from "./support.ts";

Deno.test("promising export suspends on a Suspending import and resumes with its resolved value", async () => {
  let resolveBlock: (v: number) => void;
  const blocked = new Promise<number>((r) => {
    resolveBlock = r;
  });

  const exp = await instantiateActivation({
    // activation.wat's `run` computes block(x) + 1.
    block: new WebAssembly.Suspending((x: number) =>
      blocked.then((v) => v + x)
    ),
  });

  const runPromising = WebAssembly.promising(exp.run);
  const resultPromise = runPromising(5);

  // Genuine suspension: the Promise is not settled yet (nothing has resolved
  // `blocked`). We can't directly assert "pending" without a race, but we
  // can assert resolution only happens after we resolve `blocked`, via
  // ordering against a microtask queued first.
  let orderMarker = "not-yet";
  resultPromise.then(() => {
    orderMarker = "resolved";
  });
  await Promise.resolve(); // flush one microtask turn
  assertEquals(orderMarker, "not-yet", "wasm should still be suspended");

  resolveBlock!(100);
  const result = await resultPromise;
  // block(5) = 100 + 5 = 105; run() returns block(x) + 1 = 106.
  assertEquals(result, 106);
});
