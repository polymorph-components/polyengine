// Concurrent drivers on the SAME store (issue #239).
//
// The same-store half of #210. #210 made the driver's speculative resume
// entry per-store (`Store.pendingResumptions`), which stopped an unrelated
// store's driver from spinning on it — see `tests/cross_store_driver_test.ts`,
// whose header describes the entry as "held for the entire duration of a
// guest's wait on a slow host import". It left the same wedge intact for a
// SECOND driver on the store actually doing the waiting, which is the ordinary
// shape (two overlapping export calls; a detached guest task cancelling an
// in-flight import while the settlement pump holds the entry).
//
// Mechanism: `driveAsync` (exec/boundary.ts) takes the speculative entry and
// holds it across `Promise.race([chosenTag, ...others])`, where `others`
// includes `store.pendingHostCalls` — a window bounded only by when the HOST
// answers, i.e. possibly never. `Store.pendingResumptions` is a store-wide
// scheduling gate: `Store.tick()` returns false while it is non-empty
// (task/scheduler.ts), and every `driveAsync` yields at its top while
// `store.hasPendingResumptions()` holds, under a 10,000-hop bound that fires
//
//   assert_(claimHops < 10_000, "driveAsync: a resumed-activation claim was
//   never released (the activation neither parked, finished, nor trapped)")
//
// So the second driver died in ~311ms — an internal-bug detector firing on a
// perfectly ordinary suspended guest.
//
// The fix (boundary.ts, "Driver arrival: closing the overlap window"): the
// entry is taken only by the SOLE driver (`storeDriverDepth(store) === 1`),
// and `armDriverArrival(store)` rides the race so an incumbent wakes within a
// microtask when another driver arrives, drops the entry, and re-evaluates
// `done()`.
//
// These tests pin all three halves: the second driver returns promptly (1),
// the gate still gates when nobody else wants the store (2), and the entry is
// actually dropped while a second driver is live (3).
//
// Scaffolding style: cross_store_driver_test.ts / settlement_pump_test.ts
// (fake inst/threads, real Store, real driveStoreAsync).

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

/** Poll `cond` until true or the deadline passes; returns whether it held.
 * Macrotask hops, so the drivers under observation get to run. */
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 >= ms) return false;
    await new Promise((r) => setTimeout(r, 1));
  }
  return true;
}

// The regression. Driver A dwells on a slow host import; driver B arrives on
// the SAME store with nothing to do. Pre-fix B spun at the top of its own loop
// against A's speculative entry and died at the hop bound in ~311ms.
Deno.test("a second driver on the same store is not wedged by the incumbent's speculative entry (#239)", async () => {
  const store = new Store();
  let settleThread!: (v: unknown) => void;
  let settleHost!: (v: unknown) => void;
  const threadP = new Promise((r) => (settleThread = r));
  const hostP = new Promise((r) => (settleHost = r));
  let aDone = false;
  let aDriver: Promise<unknown> = Promise.resolve();
  try {
    // A guest suspended on a host import that never answers.
    awaitingThread(store, threadP);
    hostImport(store, hostP);
    aDriver = driveStoreAsync(store, () => aDone, "A: dweller").catch((e) => e);

    // Wait until A has reached its race holding the entry. A is the sole
    // driver here, so `sole` is true and the entry IS taken — the predicate is
    // as good a "A is parked in the race" signal as it is in the cross-store
    // test (and it is the exact state the bug needs).
    assert(
      await waitFor(() => store.hasPendingResumptions(), 2000),
      "A's driver never took its entry",
    );

    // Driver B: same store, immediately done. It must not consult A's entry.
    const tB = Date.now();
    let threw: unknown = null;
    try {
      await driveStoreAsync(store, () => true, "B: arriving");
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - tB;
    // Name the bug in the failure report: pre-fix this is the claimHops
    // AssertionError, not some generic rejection.
    assert(
      threw === null,
      `B's driver must not throw; got: ${String(threw)}` +
        (String(threw).includes("resumed-activation claim")
          ? " -- this is the #239 wedge: the incumbent's speculative " +
            "Store.pendingResumptions entry gated B's whole loop"
          : ""),
    );
    // Pre-fix: ~311ms (10,000 hops) ending in that assert. The bound is loose
    // on purpose — the property is "promptly, not gated on A's host" — and it
    // is the throw above that carries the regression; this only pins that B
    // cannot instead be made to dwell for the host's own duration.
    assert(elapsed < 2000, `B's driver returned in ${elapsed}ms, expected < 2s`);
  } finally {
    aDone = true;
    settleThread(0);
    settleHost(0);
    await aDriver;
    store.pendingResumptions.clear();
  }
});

// CONTROL, mirroring the tail of cross_store_driver_test.ts: the fix narrows
// WHO may hold the speculative entry, it does not delete it. With A the sole
// driver parked in its race, the gate is held and its own store refuses to
// schedule past it.
Deno.test("the speculative entry still gates when the incumbent is the sole driver (#239 control)", async () => {
  const store = new Store();
  let settleThread!: (v: unknown) => void;
  let settleHost!: (v: unknown) => void;
  const threadP = new Promise((r) => (settleThread = r));
  const hostP = new Promise((r) => (settleHost = r));
  let aDone = false;
  let aDriver: Promise<unknown> = Promise.resolve();
  try {
    awaitingThread(store, threadP);
    hostImport(store, hostP);
    aDriver = driveStoreAsync(store, () => aDone, "A: dweller").catch((e) => e);

    assert(
      await waitFor(() => store.hasPendingResumptions(), 2000),
      "A's driver never took its entry",
    );
    assert(store.hasPendingResumptions(), "A's entry is still pending");
    assert(store.tick() === false, "the gate still refuses to schedule");
  } finally {
    aDone = true;
    settleThread(0);
    settleHost(0);
    await aDriver;
    store.pendingResumptions.clear();
  }
});

// The mechanism of the fix, observed directly: while a second driver is live,
// nobody holds the store-wide gate. A wakes on `armDriverArrival`, drops the
// entry in the race's `finally`, and re-parks with `sole === false`.
//
// B is kept ALIVE across the observation (its `done` stays false until we have
// looked) deliberately: once B exits, A is sole again and legitimately retakes
// the entry, so a post-hoc read would be a race against A's next lap.
Deno.test("the speculative entry is dropped while a second driver is live on the store (#239)", async () => {
  const store = new Store();
  let settleThread!: (v: unknown) => void;
  let settleHost!: (v: unknown) => void;
  const threadP = new Promise((r) => (settleThread = r));
  const hostP = new Promise((r) => (settleHost = r));
  let aDone = false;
  let bDone = false;
  let aDriver: Promise<unknown> = Promise.resolve();
  let bDriver: Promise<unknown> = Promise.resolve();
  try {
    awaitingThread(store, threadP);
    hostImport(store, hostP);
    aDriver = driveStoreAsync(store, () => aDone, "A: dweller").catch((e) => e);

    assert(
      await waitFor(() => store.hasPendingResumptions(), 2000),
      "A's driver never took its entry",
    );

    bDriver = driveStoreAsync(store, () => bDone, "B: co-resident")
      .catch((e) => e);

    // A must stand out of its race and release the entry. Bounded wait, not a
    // bare read: the handoff is a few microtask hops, not synchronous.
    assert(
      await waitFor(() => !store.hasPendingResumptions(), 2000),
      "the incumbent never released the store-wide gate for the arriving " +
        "driver (#239: `armDriverArrival` did not reach A's race, or A " +
        "retook the entry while a second driver was live)",
    );
  } finally {
    aDone = true;
    bDone = true;
    settleThread(0);
    settleHost(0);
    await aDriver;
    await bDriver;
    store.pendingResumptions.clear();
  }
});

// The release path removes ONLY the driver's own entry (issue #158's lesson,
// re-asserted under #239's new wake path).
//
// `Store.pendingResumptions` is a SET, not the single global slot it started
// as, precisely so the race site can "name exactly what we added": the
// `finally` used to blanket-clear, so an entry minted DURING the await by a
// guest-synchronous delivery (`SuspensionPoint.resume`, jspi/bridge.ts) was
// clobbered early, re-opening the mis-attribution window that entry exists to
// close. #239 gave the driver a brand-new reason to run that `finally` — it
// now stands down mid-await whenever another driver arrives — so the
// identity-scoped removal is worth pinning on that path specifically. Nothing
// else in this file distinguishes the two: with one entry in play,
// `removePendingResumption(chosen)` and `pendingResumptions.clear()` are the
// same function.
//
// The foreign entry is a bare sentinel object rather than a second
// `awaitingThread`. `pendingResumptions` is `Set<unknown>` and the property
// under test is purely identity-scoped removal — the set's members are never
// dereferenced by the driver, only added/removed/counted — so a sentinel says
// exactly what is being tested and cannot accidentally participate in
// scheduling. A second parked thread would add awaiting-set membership the
// property does not involve.
//
// Teardown avoids the hop bound rather than catching it: while the foreign
// entry sits in the set the store-wide gate stays held, so BOTH drivers yield
// at their loop tops under the 10,000-hop `claimHops` assert (~311ms). The
// observation takes a few milliseconds, and teardown deletes the sentinel
// FIRST — restoring the state a real `SuspensionPoint.resume` would restore
// when its activation parks or finishes — so both drivers reach their `done()`
// and exit normally, with no AssertionError to swallow.
Deno.test("a driver releases only its own speculative entry, not the whole gate (#158 under #239's stand-down)", async () => {
  const store = new Store();
  let settleThread!: (v: unknown) => void;
  let settleHost!: (v: unknown) => void;
  const threadP = new Promise((r) => (settleThread = r));
  const hostP = new Promise((r) => (settleHost = r));
  const foreign = { what: "an entry minted by SuspensionPoint.resume" };
  let aDone = false;
  let bDone = false;
  let aDriver: Promise<unknown> = Promise.resolve();
  let bDriver: Promise<unknown> = Promise.resolve();
  try {
    const thread = awaitingThread(store, threadP);
    hostImport(store, hostP);
    aDriver = driveStoreAsync(store, () => aDone, "A: dweller").catch((e) => e);

    // A is sole, so the entry it takes in the race is `thread` itself.
    assert(
      await waitFor(() => store.pendingResumptions.has(thread), 2000),
      "A's driver never took its entry",
    );

    // The delivery-in-flight entry, minted while A is parked in the race.
    store.addPendingResumption(foreign);

    // B's arrival wakes A out of the race and runs its `finally`. B stays live
    // across the observation for the same reason as the previous test.
    bDriver = driveStoreAsync(store, () => bDone, "B: co-resident")
      .catch((e) => e);

    assert(
      await waitFor(() => !store.pendingResumptions.has(thread), 2000),
      "A never released its own entry on the stand-down path",
    );
    // THE PROPERTY: A named what it added. A blanket clear here would take the
    // in-flight delivery's entry with it — the #158 regression, invisible to
    // every other test in this file because they only ever have one entry.
    assert(
      store.pendingResumptions.has(foreign),
      "A's release path cleared an entry it did not add (#158: the " +
        "`finally` must remove only `chosen`, not clear the set — an entry " +
        "minted mid-await by a guest-synchronous delivery must survive)",
    );
  } finally {
    // Sentinel first: it is the only thing holding the gate now, and both
    // drivers are yielding against the hop bound until it goes.
    store.pendingResumptions.delete(foreign);
    aDone = true;
    bDone = true;
    settleThread(0);
    settleHost(0);
    await aDriver;
    await bDriver;
    store.pendingResumptions.clear();
  }
});
