// Host-activity arm liveness == host retention (issue #162, embedder-api
// §"Streams and futures").
//
// THE BUG THESE PIN
// =================
//
// A host import that receives a stream and hands the SAME stream straight
// back (`identity: async func(s: stream<u8>) -> stream<u8>`) used to leave
// the store permanently unable to trap a genuine deadlock:
//
//   1. lifting the guest's stream builds a wrapper (`hostStreamFor`) whose
//      `HostActivity` arms immediately off the recorded `boundStore`;
//   2. returning the same shared object lowers it back into the guest —
//      nothing on that path touched the arm;
//   3. `HostActivity.close()` fires only on DROPPED / end-of-pump and is
//      terminal, so the arm lived forever, and both of `driveAsync`'s
//      deadlock verdicts (which read raw `pendingHostCalls.size`, BY DESIGN)
//      were suppressed for the store's remaining lifetime.
//
// The fix makes arms truthful rather than touching the verdicts: the arm is
// live iff the host retains a way to act. These tests drive the CABI seam
// directly — `onLowered` / `onLifted`, exactly as `lowerStream`/`lowerFuture`
// (cabi/async_values.ts :177/:204) and `liftAsyncValue` (:126) fire them —
// over real `SharedStreamImpl`/`SharedFutureImpl` objects and the production
// `hostStreamFor`/`hostFutureFor` wrappers, so the `HostActivity` under test
// is the real one.
//
// Pre-fix observation for test 1: with the arm stranded, `driveStoreAsync`
// never reaches its deadlock trap (the `pendingHostCalls.size === 0`
// precondition of both verdicts is false forever) and the test times out.

import { assertEq } from "./support/asserts.ts";
import {
  driveStoreAsync,
  hostFuture,
  hostFutureFor,
  hostStream,
  hostStreamFor,
} from "../src/exec/mod.ts";
import {
  dropSharedForTeardown,
  hasRealHostCall,
  SharedFutureImpl,
  SharedStreamImpl,
  Store,
} from "../src/task/mod.ts";
import type { ComponentValue, ValType } from "../src/cabi/types.ts";

const U8: ValType = { kind: "u8" };

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function withTimeout<T>(p: Promise<T>, label: string, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, rj) => {
      timer = setTimeout(() => rj(new Error(`TIMEOUT ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

/** The CABI seam, as `lowerStream`/`lowerFuture` fire it. */
function fireLowered(shared: unknown, store: Store): void {
  (shared as { onLowered?: ((i: { store: unknown }) => void) | null })
    .onLowered?.({ store });
}

/** The CABI seam, as `liftAsyncValue` fires it. */
function fireLifted(shared: unknown, store: Store): void {
  (shared as { onLifted?: ((i: { store: unknown }) => void) | null })
    .onLifted?.({ store });
}

/** A shared object presented as though it had just been lifted out of a guest. */
function liftedStream(store: Store): SharedStreamImpl {
  const shared = new SharedStreamImpl(U8);
  (shared as unknown as { boundStore: unknown }).boundStore = store;
  return shared;
}

function liftedFuture(store: Store): SharedFutureImpl {
  const shared = new SharedFutureImpl(U8);
  (shared as unknown as { boundStore: unknown }).boundStore = store;
  return shared;
}

/**
 * A promise-parked activation that never settles — the `store.awaiting`
 * shape `driveAsync` races (copied from host_pump_test.ts's `mkParked`).
 */
function mkStuck(store: Store) {
  const t = {
    awaiting: new Promise<void>(() => {}) as Promise<unknown> | null,
    resumed: 0,
    resumeWith(_v: unknown, _f?: { error: unknown }) {
      this.resumed++;
      this.awaiting = null;
      store.awaiting.delete(this);
    },
  };
  store.noteAwaiting(t, t.awaiting!);
  return t;
}

/** Drive to the deadlock verdict; resolves with the trap message. */
async function expectDeadlock(store: Store, label: string): Promise<string> {
  try {
    await withTimeout(
      driveStoreAsync(store, () => false, "test"),
      label,
    );
  } catch (e) {
    return String((e as Error).message ?? e);
  }
  throw new Error(`${label}: driveStoreAsync resolved without a verdict`);
}

// ---------------------------------------------------------------------------
// 1. The identity round trip (stream)
// ---------------------------------------------------------------------------

Deno.test({
  name: "162/1: lowering a lifted stream back into a guest disarms the store",
  fn: async () => {
    const store = new Store();
    const shared = liftedStream(store);
    hostStreamFor<number>(shared as unknown as ComponentValue);

    assertEq(store.pendingHostCalls.size, 1);
    assert(
      !hasRealHostCall(store),
      "the arm is a retention claim, not outstanding host work",
    );

    // The identity return: the host's only end goes back to the guest.
    fireLowered(shared, store);
    assertEq(store.pendingHostCalls.size, 0);

    // A genuine deadlock is now reported as one.
    mkStuck(store);
    const msg = await expectDeadlock(store, "identity round trip");
    assert(
      /deadlock detected/.test(msg),
      `expected a deadlock verdict, got: ${msg}`,
    );
  },
});

// ---------------------------------------------------------------------------
// 2. Retention: a host-CREATED stream keeps its arm across lowers
// ---------------------------------------------------------------------------

Deno.test({
  name: "162/2: a host-created stream retains its writable end across lowers",
  fn: () => {
    const store = new Store();
    const h = hostStream<number>(U8);
    const shared = h.value;

    assertEq(store.pendingHostCalls.size, 0); // not bound until lowered
    fireLowered(shared, store);
    assertEq(store.pendingHostCalls.size, 1);
    // A second lower (the same wrapper handed to another instance) must not
    // duplicate the arm, and must not release it: the host still writes.
    fireLowered(shared, store);
    assertEq(store.pendingHostCalls.size, 1);

    h.writable.drop();
    assertEq(store.pendingHostCalls.size, 0);
  },
});

// ---------------------------------------------------------------------------
// 3. A re-lift restores the retention claim
// ---------------------------------------------------------------------------

Deno.test({
  name: "162/3: re-lifting a lowered-back stream re-arms; the cycle repeats",
  fn: () => {
    const store = new Store();
    const shared = liftedStream(store);
    const first = hostStreamFor<number>(shared as unknown as ComponentValue);
    assertEq(store.pendingHostCalls.size, 1);

    fireLowered(shared, store);
    assertEq(store.pendingHostCalls.size, 0);

    // The guest hands it back out again (stream/future round-trip: same cached wrapper).
    fireLifted(shared, store);
    assertEq(store.pendingHostCalls.size, 1);
    assert(
      hostStreamFor<number>(shared as unknown as ComponentValue) === first,
      "stream/future round-trip: a re-lift yields the wrapper the host already holds",
    );

    fireLowered(shared, store);
    assertEq(store.pendingHostCalls.size, 0);
    fireLifted(shared, store);
    assertEq(store.pendingHostCalls.size, 1);
  },
});

// ---------------------------------------------------------------------------
// 4. Futures mirror all of the above
// ---------------------------------------------------------------------------

Deno.test({
  name: "162/4a: the future identity round trip disarms, and a re-lift re-arms",
  fn: async () => {
    const store = new Store();
    const shared = liftedFuture(store);
    const first = hostFutureFor<number>(shared as unknown as ComponentValue);
    assertEq(store.pendingHostCalls.size, 1);
    assert(!hasRealHostCall(store), "the future arm is not outstanding work");

    fireLowered(shared, store);
    assertEq(store.pendingHostCalls.size, 0);

    fireLifted(shared, store);
    assertEq(store.pendingHostCalls.size, 1);
    assert(
      hostFutureFor<number>(shared as unknown as ComponentValue) === first,
      "stream/future round-trip: a re-lifted future yields the cached wrapper",
    );
    fireLowered(shared, store);
    assertEq(store.pendingHostCalls.size, 0);

    mkStuck(store);
    const msg = await expectDeadlock(store, "future identity round trip");
    assert(
      /deadlock detected/.test(msg),
      `expected a deadlock verdict, got: ${msg}`,
    );
  },
});

Deno.test({
  name: "162/4b: a host-created future retains its writable end across lowers",
  fn: () => {
    const store = new Store();
    const h = hostFuture<number>(U8);
    fireLowered(h.value, store);
    assertEq(store.pendingHostCalls.size, 1);
    fireLowered(h.value, store);
    assertEq(store.pendingHostCalls.size, 1);
    h.drop();
    assertEq(store.pendingHostCalls.size, 0);
  },
});

Deno.test({
  name: "162/4c: a guest-side future drop with nothing parked releases the arm",
  fn: () => {
    const store = new Store();
    const shared = liftedFuture(store);
    hostFutureFor<number>(shared as unknown as ComponentValue);
    assertEq(store.pendingHostCalls.size, 1);
    // No host operation is parked, so the settle(DROPPED) -> close() path
    // cannot run; the shared object's drop observers are what release it.
    shared.drop();
    assertEq(store.pendingHostCalls.size, 0);
  },
});

Deno.test({
  name: "162/4d: readResult() on an already-dropped future strands no arm",
  fn: async () => {
    const store = new Store();
    const shared = liftedFuture(store);
    const h = hostFutureFor<number>(shared as unknown as ComponentValue);
    assertEq(store.pendingHostCalls.size, 1);
    shared.drop();
    // The dropped fast path returns synchronously without touching the
    // activity; the drop observer already released the arm.
    const r = await withTimeout(h.readResult(), "dropped readResult");
    assertEq(r.value, undefined);
    assertEq(store.pendingHostCalls.size, 0);
  },
});

// ---------------------------------------------------------------------------
// 5. Teardown with nothing parked
// ---------------------------------------------------------------------------

Deno.test({
  name: "162/5: dropSharedForTeardown releases the arm with nothing parked",
  fn: () => {
    const store = new Store();

    const s = liftedStream(store);
    hostStreamFor<number>(s as unknown as ComponentValue);
    assertEq(store.pendingHostCalls.size, 1);
    dropSharedForTeardown(s);
    assertEq(store.pendingHostCalls.size, 0);

    const f = liftedFuture(store);
    hostFutureFor<number>(f as unknown as ComponentValue);
    assertEq(store.pendingHostCalls.size, 1);
    dropSharedForTeardown(f);
    assertEq(store.pendingHostCalls.size, 0);
  },
});

// ---------------------------------------------------------------------------
// 6. Guest-side stream drop with nothing parked
// ---------------------------------------------------------------------------

Deno.test({
  name: "162/6: a guest-side stream drop with nothing parked releases the arm",
  fn: () => {
    const store = new Store();
    const shared = liftedStream(store);
    hostStreamFor<number>(shared as unknown as ComponentValue);
    assertEq(store.pendingHostCalls.size, 1);
    shared.drop();
    assertEq(store.pendingHostCalls.size, 0);
  },
});
