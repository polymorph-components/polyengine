// Resource destructor gating and host-side lend tracking (issues #85, #86).
//
// Authority: definitions.py `canon_resource_drop` (@ 2f13265) and the
// `Store.lift` it routes the dtor through — which post-CM#705 carries NO
// entry gate, so dtor reentrance into a live instance is valid — plus
// the lend bookkeeping of `Subtask.add_lender` / `deliver_resolve`
// (lines 890, 902) and the `num_lends` traps in `lift_own` /
// `canon_resource_drop` (lines 1508, 2325).

import {
  canonResourceDrop,
  canonResourceNew,
  ResourceTypeInfo,
} from "../src/cabi/mod.ts";
import { ComponentInstanceState, Store, storeQuiescent } from "../src/task/mod.ts";
import { driveStoreAsync, hostDtorCall } from "../src/exec/boundary.ts";
import {
  isInstancePoisoned,
  notifyInstancePoisoned,
  setOnInstancePoisoned,
} from "../src/task/scheduler.ts";
// Side-effecting import: registers `retireInstanceAsyncEnds` as the poisoning
// hook (#66). Without it the seam is null and the poison walk is a no-op.
import { retireInstanceAsyncEnds } from "../src/task/streams.ts";
import {
  GuestResource,
  lendWrapper,
  makeWrapper,
  simulateFinalizationForTest,
  takeRep,
  wrapperLends,
} from "../src/embedder/resources.ts";
import { assertEq, assertTrap } from "./support/asserts.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** Install a spy on the poisoning seam for one test, then restore the real one. */
function withPoisonSpy<T>(
  run: (seen: { inst: unknown; cause: unknown }[]) => T,
): T {
  const seen: { inst: unknown; cause: unknown }[] = [];
  setOnInstancePoisoned((inst, cause) => {
    seen.push({ inst, cause });
    retireInstanceAsyncEnds(inst, cause);
  });
  const restore = () => setOnInstancePoisoned(retireInstanceAsyncEnds);
  let out: T;
  try {
    out = run(seen);
  } catch (e) {
    restore();
    throw e;
  }
  // The seam must stay installed across an async body's microtasks.
  if (typeof (out as { then?: unknown })?.then === "function") {
    return (out as unknown as Promise<unknown>).then(
      (v) => {
        restore();
        return v;
      },
      (e) => {
        restore();
        throw e;
      },
    ) as unknown as T;
  }
  restore();
  return out;
}

function mkPair(): {
  store: Store;
  caller: ComponentInstanceState;
  impl: ComponentInstanceState;
} {
  const store = new Store();
  return {
    store,
    caller: new ComponentInstanceState(0, store),
    impl: new ComponentInstanceState(1, store),
  };
}

// ---------------------------------------------------------------------------
// #85 — dtor gating
// ---------------------------------------------------------------------------

Deno.test("#85/#173: dropping a cross-instance own while the impl is LIVE succeeds", () => {
  // INVERTED by polyengine#173 (CM#705): `canon_resource_drop` lifts the dtor
  // through a `Store.lift` that no longer gates, so a drop whose implementing
  // instance is mid-execution is valid and the dtor simply runs.
  const { caller, impl } = mkPair();
  let ran = 0;
  const rt = new ResourceTypeInfo(impl, () => {
    ran += 1;
  });
  const h = canonResourceNew(caller, rt, 42);

  void impl;
  canonResourceDrop(caller, rt, h);
  assertEq(ran, 1, "the dtor ran; nothing was refused");
});

Deno.test("#85/#173: a dtor-less drop into a live impl succeeds too", () => {
  const { caller, impl } = mkPair();
  const rt = new ResourceTypeInfo(impl, null);
  const h = canonResourceNew(caller, rt, 7);
  void impl;
  canonResourceDrop(caller, rt, h);
});

Deno.test("#85: a POISONED impl still refuses the drop", () => {
  // The surviving refusal: polyengine's per-instance corpse divergence.
  withPoisonSpy(() => {
    const { caller, impl } = mkPair();
    const rt = new ResourceTypeInfo(impl, () => {});
    const h = canonResourceNew(caller, rt, 43);
    notifyInstancePoisoned(impl, new Error("earlier boom"));
    assertTrap(
      () => canonResourceDrop(caller, rt, h),
      "cannot enter component instance",
    );
  });
});

Deno.test("#85: a same-instance drop is admissible even against its own marker", () => {
  // `entryRefusal`'s vacuous pass (`caller !== callee`): a guest dropping a
  // handle to its OWN resource is never refused by its own poison marker.
  withPoisonSpy(() => {
    const { caller } = mkPair();
    let ran = 0;
    const rt = new ResourceTypeInfo(caller, () => {
      ran += 1;
    });
    const h = canonResourceNew(caller, rt, 5);
    notifyInstancePoisoned(caller, new Error("earlier boom"));
    canonResourceDrop(caller, rt, h);
    assertEq(ran, 1);
  });
});

Deno.test("#85: a trapping dtor poisons the impl instance and retires its ends", () => {
  withPoisonSpy((seen) => {
    const { caller, impl } = mkPair();
    const boom = new Error("dtor trap");
    const rt = new ResourceTypeInfo(impl, () => {
      throw boom;
    });
    const h = canonResourceNew(caller, rt, 3);
    let caught: unknown;
    try {
      canonResourceDrop(caller, rt, h);
    } catch (e) {
      caught = e;
    }
    assertEq(caught === boom, true);
    // The impl is a corpse; the dropping instance is untouched.
    assertEq(isInstancePoisoned(impl), true);
    assertEq(isInstancePoisoned(caller), false);
    assertEq(seen.length, 1);
    assertEq(seen[0].inst === impl, true);
    assertEq(seen[0].cause === boom, true);
  });
});

Deno.test("#85: a guest-initiated dtor that does not finish synchronously traps", () => {
  withPoisonSpy((seen) => {
    const { caller, impl } = mkPair();
    const rt = new ResourceTypeInfo(
      impl,
      (() => Promise.resolve()) as unknown as (rep: number) => void,
    );
    const h = canonResourceNew(caller, rt, 9);
    assertTrap(
      () => canonResourceDrop(caller, rt, h),
      "did not complete synchronously",
    );
    assertEq(isInstancePoisoned(impl), true);
    assertEq(seen.length, 1);
  });
});

Deno.test("#160: a host-initiated async dtor is not external work", async () => {
  // REVISED from the #85 pin "holds the gate until it settles". That
  // behaviour was the bug: the held `enterFrom(null)` bracket made the impl
  // instance non-enterable for the whole activation, so `Store.tick`'s
  // enterability filter could never resume a suspension point belonging to
  // the dtor itself (#160). A host-initiated dtor is a full canonical lift
  // (definitions.py `canon_resource_drop`), and post-CM#705 (polyengine#173)
  // there is no gate left to hold at all. What still needs pinning: the
  // completion promise is NOT a `pendingHostCalls` entry (it is not external
  // work), and the store drains cleanly.
  const { store, impl } = mkPair();
  let resolveDtor: () => void = () => {};
  const rt = new ResourceTypeInfo(
    impl,
    (() => new Promise<void>((r) => (resolveDtor = r))) as unknown as (
      rep: number,
    ) => void,
  );
  hostDtorCall(rt, 11);
  assertEq(isInstancePoisoned(impl), false);
  assertEq(store.pendingHostCalls.size, 0);
  resolveDtor();
  await driveStoreAsync(store, () => storeQuiescent(store), "dtor drain");
  assertEq(isInstancePoisoned(impl), false);
  assertEq(store.pendingHostCalls.size, 0);
  assertEq(store.hostFailure, undefined);
});

Deno.test("#85/#160: a rejected host-initiated dtor poisons and lands on hostFailure", async () => {
  await withPoisonSpy(async (seen) => {
    const { store, impl } = mkPair();
    const boom = new Error("async dtor trap");
    const rt = new ResourceTypeInfo(
      impl,
      (() => Promise.reject(boom)) as unknown as (rep: number) => void,
    );
    // Substance unchanged by #160; only the timing (microtasks, not the
    // `pendingHostCalls` promise) and the surfaced error identity move: the
    // rejection now travels through `awaitCore`'s `mapCoreException`, which
    // passes a non-`WebAssembly.RuntimeError` through unchanged — so it is
    // still `boom` itself.
    hostDtorCall(rt, 12);
    await driveStoreAsync(store, () => storeQuiescent(store), "dtor drain")
      .catch(() => {});
    await Promise.resolve();
    assertEq(store.hostFailure === boom, true);
    assertEq(isInstancePoisoned(impl), true);
    assertEq(seen.length, 1);
    store.hostFailure = undefined;
  });
});

// ---------------------------------------------------------------------------
// #86 — host lend tracking
// ---------------------------------------------------------------------------

class Res extends GuestResource {}

function mkWrapper(rt: ResourceTypeInfo, rep = 100) {
  return makeWrapper(Res, rep, rt, true);
}

Deno.test("#86: drop() while lent is deferred until the last release", () => {
  const { impl } = mkPair();
  const dropped: number[] = [];
  const rt = new ResourceTypeInfo(impl, (rep) => {
    dropped.push(rep);
  });
  const w = mkWrapper(rt, 21);

  const release = lendWrapper(w); // host `own` lowered as `borrow<R>`
  assertEq(wrapperLends(w), 1);
  w.drop();
  assertEq(dropped, []); // NOT destroyed under a live guest borrow
  release();
  assertEq(dropped, [21]);
  assertEq(wrapperLends(w), 0);
  // Idempotent: a second release (and a second drop) change nothing.
  release();
  w.drop();
  assertEq(dropped, [21]);
});

Deno.test("#86: two overlapping lends both have to be released", () => {
  const { impl } = mkPair();
  const dropped: number[] = [];
  const rt = new ResourceTypeInfo(impl, (rep) => dropped.push(rep));
  const w = mkWrapper(rt, 22);
  const r1 = lendWrapper(w);
  const r2 = lendWrapper(w);
  assertEq(wrapperLends(w), 2);
  w.drop();
  r1();
  assertEq(dropped, []);
  r2();
  assertEq(dropped, [22]);
});

Deno.test("#86: the GC backstop under a live borrow defers instead of destroying", () => {
  const { impl } = mkPair();
  const dropped: number[] = [];
  const rt = new ResourceTypeInfo(impl, (rep) => dropped.push(rep));
  const w = mkWrapper(rt, 23);
  const release = lendWrapper(w);

  simulateFinalizationForTest(w); // the finalizer callback, verbatim
  assertEq(dropped, []); // the repro of #86: no use-after-free
  release();
  assertEq(dropped, [23]);
  // Not resurrected, not double-run.
  simulateFinalizationForTest(w);
  assertEq(dropped, [23]);
});

Deno.test("#86: the backstop is idempotent against an explicit drop", () => {
  const { impl } = mkPair();
  const dropped: number[] = [];
  const rt = new ResourceTypeInfo(impl, (rep) => dropped.push(rep));
  const w = mkWrapper(rt, 24);
  w.drop();
  simulateFinalizationForTest(w);
  assertEq(dropped, [24]);
});

Deno.test("#86: a trapping backstop dtor poisons the impl and records the failure", () => {
  withPoisonSpy((seen) => {
    const { store, impl } = mkPair();
    const boom = new Error("backstop dtor trap");
    const rt = new ResourceTypeInfo(impl, () => {
      throw boom;
    });
    const w = mkWrapper(rt, 25);
    // Never throws out of the finalizer callback...
    simulateFinalizationForTest(w);
    // ... but is no longer swallowed either (the former `catch {}`).
    assertEq(store.hostFailure === boom, true);
    assertEq(isInstancePoisoned(impl), true);
    assertEq(seen.length, 1);
    store.hostFailure = undefined;
  });
});

Deno.test("#86: transferring a lent handle as own<R> is refused (lift_own)", () => {
  const { impl } = mkPair();
  const rt = new ResourceTypeInfo(impl, () => {});
  const w = mkWrapper(rt, 26);
  const release = lendWrapper(w);
  let msg = "";
  try {
    takeRep(w, true, "own<r>");
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes("still lent out"), `expected a lend refusal, got ${msg}`);
  release();
  assertEq(takeRep(w, true, "own<r>"), 26);
});
