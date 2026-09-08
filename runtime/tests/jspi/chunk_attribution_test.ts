// Issue #24 pin — continuation-chunk attribution across interleaved
// resumptions.
//
// Two promising activations suspend on Suspending imports (wrapped by
// `suspendingImport`, i.e. the runtime's real claim/sentinel funnel); both
// underlying promises settle in the same microtask drain, so the engine
// interleaves their continuation chunks at an empty bracket stack. The pin:
// each chunk's ambient must name ITS OWN activation. Pre-fix, the second
// chunk inherited the first one's claim (the LIFO top), which is exactly how
// wit-bindgen's callback epilogue wrote one task's context-local state into
// another thread's slots on the polymorph-tls webcrypto-composed suite
// (async_support.rs:578 `assert!(!state.is_null())` -> unreachable).
//
// The fix is the attribution sentinel (jspi/bridge.ts): a microtask queued
// contiguously ahead of every engine continuation reaction, claiming the
// chunk's owner. This test observes the ambient exactly where the runtime
// does — `claimingFn`'s owner capture on the chunk's next import call.

import { assertEquals } from "./asserts.ts";
import { instantiateActivation } from "./support.ts";
import { suspendingImport } from "../../src/jspi/mod.ts";
import { maybeCurrentThread, withActivation } from "../../src/task/mod.ts";

Deno.test("issue #24: interleaved continuation chunks each read their own ambient", async () => {
  const ownerA = { name: "A", storage: [0, 0] };
  const ownerB = { name: "B", storage: [0, 0] };
  const seen: Array<[string, unknown]> = [];

  function mkBlock(
    label: string,
  ): { resolveFirst: () => void; block: unknown } {
    let calls = 0;
    let resolveFirst!: () => void;
    const gate = new Promise<number>((res) => {
      resolveFirst = () => res(100);
    });
    const block = suspendingImport((x: number) => {
      calls++;
      if (calls === 1) return gate; // first call: genuine suspension
      // Second call happens inside the RESUMED chunk: record who the
      // ambient says is running. This is claimingFn's own owner-capture
      // position, one frame in.
      seen.push([label, maybeCurrentThread()]);
      return x + 1;
    }, "jspi");
    return { resolveFirst, block };
  }

  const a = mkBlock("A");
  const b = mkBlock("B");
  const expA = await instantiateActivation({ block: a.block as never });
  const expB = await instantiateActivation({ block: b.block as never });

  // Enter each activation under its own bracket (the runtime's awaitCore
  // shape), so the FIRST import call captures the right owner.
  const pA = withActivation(
    ownerA,
    () => WebAssembly.promising(expA.run_twice)(1),
  );
  const pB = withActivation(
    ownerB,
    () => WebAssembly.promising(expB.run_twice)(1),
  );

  // Settle BOTH suspensions in one turn — the interleave under test.
  a.resolveFirst();
  b.resolveFirst();
  await Promise.all([pA, pB]);

  assertEquals(seen.length, 2);
  for (const [label, ambient] of seen) {
    assertEquals(
      ambient,
      label === "A" ? ownerA : ownerB,
      `chunk ${label} read the wrong ambient (issue #24 regression)`,
    );
  }
});
