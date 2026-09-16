// FINDING M3A-1 — the explicit activation ambient, pinned.
//
// The scheduler used to recover "which activation is running?" across the
// engine's JSPI continuations from an async-context store (`node:async_hooks`
// `AsyncLocalStorage`). No browser ships that facility, nor its `AsyncContext`
// successor, so docs/architecture.md §4.3 forbids it and the browser lanes lost 80 commands to
// it. The runtime now states the ambient explicitly at the two sites where
// wasm leaves our JS frames. These tests pin BOTH sites, because a regression
// at either is silent on Deno-only unit tests and only shows up as a wrong
// task attribution deep inside `async/`.
//
// Site 1 — THE MICROTASK HOP (jspi pin (j), `fastpath_hop_test.ts`). Every
// call through a `Suspending` import returns to wasm through a microtask, even
// when the import answered synchronously. The rest of the guest's frame
// therefore runs after our brackets have unwound. `suspendingImport`'s wrapper
// claims the caller's ambient for that window.
//
// Site 2 — A GENUINE SUSPENSION. `blockCurrentActivation` records the parking
// activation on the `SuspensionPoint`, and `SuspensionPoint.resume` claims it
// again when it settles, so the resumed guest's built-ins resolve to it.
//
// The corpus is the real arbiter (async/ goes from 80 failures to 0 in every
// browser), but these keep the mechanism honest at unit scale.

import { assertEquals } from "./asserts.ts";
import { instantiateActivation } from "./support.ts";
import { isSupported } from "../../src/jspi/mechanics.ts";
import {
  blockCurrentActivation,
  enterWasm,
  suspendingImport,
} from "../../src/jspi/mod.ts";
import {
  ambientResidue,
  type CurrentThreadLike,
  maybeCurrentThread,
  releaseActivationAmbient,
  Store,
  withActivation,
} from "../../src/task/mod.ts";

/** The structural minimum the ambient machinery needs of a "thread". */
function fakeThread(label: string): CurrentThreadLike & { label: string } {
  return { label, storage: [0, 0], task: null };
}

Deno.test({
  name:
    "M3A-1 site 1: a built-in reached AFTER a non-suspending Suspending hop " +
    "still resolves its own activation",
  ignore: !isSupported(),
  fn: async () => {
    const thread = fakeThread("A");
    const seen: unknown[] = [];
    const imp = suspendingImport(
      ((x: number) => {
        seen.push(maybeCurrentThread());
        return x + 1; // plain value — the fast path, which STILL hops
      }) as (...a: never[]) => unknown,
      "jspi",
    );
    const exports = await instantiateActivation({
      block: imp as WebAssembly.Suspending,
    });
    const run = enterWasm(
      exports.run_twice as (...a: never[]) => unknown,
      "jspi",
    ) as unknown as (x: number) => Promise<number>;

    // Exactly how exec/boundary.ts `awaitCore` enters wasm.
    await withActivation(thread, () => run(1));

    assertEquals(seen.length, 2);
    // The first call is inside our bracket — this always worked.
    assertEquals(seen[0], thread);
    // The second is after the engine's microtask hop, with every JS frame of
    // ours unwound. This is the one the async-context store used to answer and
    // the one that produced "exit-sync-call with an empty sync-call stack"
    // when nothing claimed it.
    assertEquals(seen[1], thread);

    // The claim is released in production when the activation parks
    // (`blockCurrentActivation`) or finishes (`Store.noteAwaiting`); neither
    // exists in this bare fixture, so release it by hand and confirm nothing
    // else leaked.
    releaseActivationAmbient(thread);
    assertEquals(ambientResidue().stack, 0);
    assertEquals(ambientResidue().claim, false);
  },
});

Deno.test({
  name:
    "M3A-1 site 2: a genuine suspension carries its owner, so the resumed " +
    "activation's built-ins resolve to it",
  ignore: !isSupported(),
  fn: async () => {
    const store = new Store();
    const thread = fakeThread("B");
    const seen: unknown[] = [];
    let first = true;
    const imp = suspendingImport(
      ((x: number) => {
        if (first) {
          first = false;
          // Park the activation the way every blocking built-in does. The
          // owner is captured from the ambient HERE, while our bracket is
          // still live — not derived later at resume time.
          return blockCurrentActivation<number>({
            store,
            task: { implicitThread: thread },
            readyFunc: () => true,
            produce: () => x + 1,
          });
        }
        // Reached only after the engine resumed the suspended activation.
        seen.push(maybeCurrentThread());
        return x + 1;
      }) as (...a: never[]) => unknown,
      "jspi",
    );
    const exports = await instantiateActivation({
      block: imp as WebAssembly.Suspending,
    });
    const run = enterWasm(
      exports.run_twice as (...a: never[]) => unknown,
      "jspi",
    ) as unknown as (x: number) => Promise<number>;

    const done = withActivation(thread, () => run(1));

    // One suspension point is parked, and it knows who owns it.
    assertEquals(store.waiting.length, 1);
    const point = store.waiting[0] as unknown as { owner: unknown };
    assertEquals(point.owner, thread);

    // Resume it exactly as `Store.tick` would.
    (store.waiting[0] as unknown as { resume(): void }).resume();
    await done;

    assertEquals(seen.length, 1);
    assertEquals(seen[0], thread);

    // In production the store's pending-resumption entry is retired by
    // `Store.consumePendingIfRunning` (the activation parks again) or by
    // `Store.noteAwaiting` (it finishes); this bare fixture has neither, so
    // wind both down by hand and confirm nothing else leaked — the ambient
    // globals AND this store's gate (the residue check lost its claim
    // component when the gate moved onto `Store`, #158).
    releaseActivationAmbient(thread);
    store.removePendingResumption(thread);
    assertEquals(ambientResidue().stack, 0);
    assertEquals(ambientResidue().claim, false);
    assertEquals(store.pendingResumptions.size, 0);
  },
});
