// #160 — a host-initiated resource destructor is an ordinary lifted call.
//
// Authority: definitions.py `canon_resource_drop` (line 2319) builds the dtor
// into a function instance and calls it through `Store.lift` with
// `CanonicalOptions(async_ = False)` / `FuncType([U32Type()], [], async_ =
// False)`. The host-initiated path runs the dtor through
// `createLiftedFunction`, so the activation has a real Task/Thread. The pins
// below cover what that buys: the dtor's own task, scheduler resumability of
// its suspension points, its completion NOT being advertised as external
// work, and the fact that a dtor may enter a LIVE instance at all.

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

  // The park happened, and `tick` can resume the point below: nothing can
  // make the impl non-enterable except poisoning (CM#705).
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
  // `canon_resource_drop` lifts the dtor with no gate at all
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
  // is still in flight: it simply runs (CM#705).
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
