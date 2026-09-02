// Concurrent drivers on independent stores (issues #210, #158 mechanism B).
//
// The driver's speculative resume entry (exec/boundary.ts, `Promise.race`
// over the parked threads) is held for the entire duration of a guest's wait
// on a slow host import — the completely ordinary suspended-guest shape.
// The gate is `Store.pendingResumptions`, PER STORE: activations never cross
// stores, so A's pending resumption is none of B's business. Were it shared,
// every `driveAsync` loop would yield at its top while ANY store held an
// entry, against a bounded hop counter:
//
//   assert_(claimHops < 10_000, "driveAsync: a resumed-activation claim was
//   never released ...")
//
// so an idle, completely unrelated store B's `driveStoreAsync` would die at
// 10,000 hops in ~311ms while store A merely dwelt on its import — an
// internal AssertionError naming neither component (issue #210).
//
// This test pins the requirement: B's driver must return promptly. The
// control below pins that the gate still gates — A's OWN driver refuses to
// tick past A's own pending entry.
//
// Scaffolding style: settlement_pump_test.ts (fake inst/threads, real Store,
// real driveStoreAsync).

import { driveStoreAsync } from "../src/exec/mod.ts";
import { Store } from "../src/task/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function fakeInst() {
  return {
  };
}

/** A thread parked on an awaitValue promise, as a promising-wrapped guest
 * activation suspended on a host import is. */
function awaitingThread(store: Store, p: Promise<unknown>) {
  const t = {
    awaiting: p as Promise<unknown> | null,
    task: { inst: fakeInst() },
    ready: () => false,
    waiting: () => false,
    resume: () => {},
    resumeWith(_v: unknown, _f?: { error: unknown }) {
      t.awaiting = null;
      store.awaiting.delete(t);
    },
  };
  store.noteAwaiting(t, p);
  return t;
}

function hostImport(store: Store, settle: Promise<unknown>): void {
  const p: Promise<void> = settle.then(() => {
    store.pendingHostCalls.delete(p);
  });
  store.pendingHostCalls.add(p);
}

Deno.test("a store dwelling on a slow import does not stall another store's driver (#210)", async () => {
  const storeA = new Store();
  const storeB = new Store();
  let settleAThread!: (v: unknown) => void;
  let settleAHost!: (v: unknown) => void;
  const aThreadP = new Promise((r) => (settleAThread = r));
  const aHostP = new Promise((r) => (settleAHost = r));
  let aDone = false;
  try {
    // Store A: guest suspended on a slow host import.
    awaitingThread(storeA, aThreadP);
    hostImport(storeA, aHostP);
    const aDriver = driveStoreAsync(storeA, () => aDone, "A: dweller")
      .catch((e) => e);

    // Wait until A's driver has taken its speculative entry (it needs a few
    // turns to reach the race).
    const t0 = Date.now();
    while (!storeA.hasPendingResumptions()) {
      assert(Date.now() - t0 < 2000, "A's driver never took its entry");
      await new Promise((r) => setTimeout(r, 1));
    }

    // Store B: a COMPLETELY IDLE unrelated store; its driver has nothing to do
    // (done() is immediately true). It must not consult A's gate at all.
    const tB = Date.now();
    let threw: unknown = null;
    try {
      await driveStoreAsync(storeB, () => true, "B: idle");
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - tB;
    assert(
      threw === null,
      `B's driver must not throw; got: ${String(threw)}`,
    );
    // Under the #210 bug this took ~311ms (10,000 hops) and ended in the
    // claimHops AssertionError. The bound is deliberately loose — the point is
    // "promptly, not gated on A" — while still being far under that.
    assert(
      elapsed < 2000,
      `B's driver returned in ${elapsed}ms, expected < 2s`,
    );

    // CONTROL: the gate still gates its OWN store. A's driver is still in its
    // race, holding A's entry, and A's own `tick` refuses.
    assert(storeA.hasPendingResumptions(), "A's entry is still pending");
    assert(storeA.tick() === false, "A's own gate still refuses to schedule");

    // Cleanup: let A's driver exit.
    aDone = true;
    settleAThread(0);
    settleAHost(0);
    await aDriver;
  } finally {
    settleAThread(0);
    settleAHost(0);
    storeA.pendingResumptions.clear();
    storeB.pendingResumptions.clear();
  }
});
