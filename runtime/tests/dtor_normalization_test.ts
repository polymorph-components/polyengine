// #160 — a host-initiated resource destructor is an ordinary lifted call.
//
// Authority: definitions.py `canon_resource_drop` (line 2319) builds the dtor
// into a function instance and calls it through `Store.lift` with
// `CanonicalOptions(async_ = False)` / `FuncType([U32Type()], [], async_ =
// False)`. Before #160 the host-initiated path called `rt.dtor` bare while
// HOLDING a host-entry bracket across the returned promise, which produced two
// observable defects pinned below:
//
//   1. the dtor's own suspension points were unresumable — `Store.tick`'s
//      enterability filter (#155) skips a thread whose instance is not
//      host-enterable, and the held bracket made the impl exactly that, so
//      the completion promise (parked in `pendingHostCalls`, i.e. advertised
//      as *external* work) never settled and every driver waited forever;
//   2. the held bracket also locked the per-instantiation root for
//      the whole activation, so a SIBLING instance of the same component
//      looked non-enterable from the host — the macro-scale window of the
//      #156 class.
//
// Both are structural consequences of the missing Task/Thread, and both are
// gone now that the dtor runs through `createLiftedFunction`. CM#705
// (polyengine#173) has since removed the gate itself, so neither shape is
// even expressible any more; the pins below are restated in terms of what is
// still observable — the dtor's own task, scheduler resumability, and the
// fact that a dtor may re-enter a LIVE instance at all.

import { ResourceTypeInfo } from "../src/cabi/mod.ts";
import {
  ComponentInstanceState,
  Store,
  storeQuiescent,
} from "../src/task/mod.ts";
import { currentTask, entryRefusal } from "../src/task/scheduler.ts";
import { blockCurrentActivation } from "../src/jspi/mod.ts";
import { driveStoreAsync, hostDtorCall } from "../src/exec/boundary.ts";
import { assertEq } from "./support/asserts.ts";

Deno.test("#160: a dtor parked on a scheduler-resumable suspension point completes", async () => {
  const store = new Store();
  const impl = new ComponentInstanceState(1, store);
  let flag = false;
  let finished = false;

  const rt = new ResourceTypeInfo(
    impl,
    ((rep: number) => {
      // `currentTask()` resolves to the DTOR'S OWN task — that is the fix:
      // under the old bare call the activation had no task at all, so a
      // built-in reached here signalled `PendingCapability` (or, worse,
      // attributed itself to whatever foreign task happened to be ambient —
      // the #24 class).
      const task = currentTask();
      assertEq(task !== null, true);
      return blockCurrentActivation({
        store,
        task,
        readyFunc: () => flag,
        cancellable: false,
        produce: () => {
          finished = true;
          assertEq(rep, 77);
          return undefined;
        },
      });
    }) as unknown as (rep: number) => void,
  );

  hostDtorCall(rt, 77);

  // The park happened, and `tick` can resume the point below. Pre-#160 the
  // held bracket made the impl non-enterable and the store wedged forever;
  // post-#705 nothing can make it non-enterable except poisoning.
  assertEq(finished, false);
  assertEq(entryRefusal(impl, null, "base"), null);
  assertEq(store.waiting.length >= 1, true);
  // NOT advertised as external work: the settlement needs this scheduler.
  assertEq(store.pendingHostCalls.size, 0);

  flag = true;
  await driveStoreAsync(store, () => storeQuiescent(store), "#160 dtor drain");

  assertEq(finished, true);
  assertEq(store.waiting.length, 0);
  assertEq(storeQuiescent(store), true);
  assertEq(entryRefusal(impl, null, "base"), null);
  assertEq(store.hostFailure, undefined);
});

Deno.test("#160/#173: a dtor may run while its own instance is LIVE", async () => {
  // REPLACES the "#160/#156: a sibling instance stays enterable" pin, which
  // is trivial now (nothing can be non-enterable). The stronger merged
  // property: `canon_resource_drop` lifts the dtor with no gate at all
  // (definitions.py @ 2f13265), so a dtor whose implementing instance is in
  // the middle of a host-initiated activation is valid and both complete.
  const store = new Store();
  const impl = new ComponentInstanceState(1, store);

  // A first dtor activation of `impl`, parked mid-flight.
  let resolveFirst: () => void = () => {};
  const slow = new ResourceTypeInfo(
    impl,
    (() => new Promise<void>((r) => (resolveFirst = r))) as unknown as (
      rep: number,
    ) => void,
  );
  hostDtorCall(slow, 5);

  // A SECOND, synchronous dtor of the same instance, entered while the first
  // is still in flight. Pre-#705 this was refused ("cannot enter component
  // instance"); now it simply runs.
  let ranNested = 0;
  const quick = new ResourceTypeInfo(impl, (() => {
    ranNested += 1;
  }) as unknown as (rep: number) => void);
  hostDtorCall(quick, 6);
  assertEq(ranNested, 1, "the nested dtor ran; nothing was refused");

  resolveFirst();
  await driveStoreAsync(store, () => storeQuiescent(store), "dtor drain");
  assertEq(entryRefusal(impl, null, "base"), null);
  assertEq(store.hostFailure, undefined);
});
