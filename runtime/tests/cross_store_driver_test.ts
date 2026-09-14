// Independent stores have independent event-driven coordinators (#210).

import { driveStoreAsync, requestStoreService } from "../src/exec/mod.ts";
import { Store } from "../src/task/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function fakeInst() {
  return {};
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

Deno.test("a pending resumption in one store does not stall another store (#210)", async () => {
  const storeA = new Store();
  const storeB = new Store();
  let settleAThread!: (v: unknown) => void;
  const aThreadP = new Promise((r) => (settleAThread = r));
  try {
    const thread = awaitingThread(storeA, aThreadP);
    storeA.addPendingResumption(thread);
    requestStoreService(storeA);

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

    // CONTROL: the real resumption claim still gates its own store.
    assert(storeA.hasPendingResumptions(), "A's entry is still pending");
    assert(storeA.tick() === false, "A's own gate still refuses to schedule");

    settleAThread(0);
    await Promise.resolve();
  } finally {
    settleAThread(0);
    storeA.pendingResumptions.clear();
    storeB.pendingResumptions.clear();
  }
});
