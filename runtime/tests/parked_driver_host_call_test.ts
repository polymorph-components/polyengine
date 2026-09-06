// A host call registered while a driver is already parked still wakes the
// guest — the stale-snapshot half of the #239 class.
//
// THE SHAPE (store-level, in the style of host_pump_test.ts and for the same
// reason: no checked-in example guest has the participants)
// ===========================================================================
//
//   * a driver is live and parked on `Promise.race([...pendingHostCalls,
//     ...])` because one outstanding host call never settles (the end-to-end
//     original: a `readDirect` stream session keeping a `HostActivity` driver
//     alive while the guest holds a long-poll import open);
//   * a SECOND host call is then registered with no new driver entered — end
//     to end that is an export entered through the synchronous `drive` path,
//     which fires no driver arrival; here it is `registerHostCall` called
//     directly, which is exactly what that path reduces to;
//   * that call settles. Its continuation deletes itself from
//     `pendingHostCalls` and readies the guest thread — and readying is all
//     it does. Somebody has to tick the store.
//
// Pre-fix nobody did: the parked driver's snapshot predates the second call,
// and the settlement pump stands down because `storeDriverDepth > 0` (the
// parked driver counts). The guest sat until the next unrelated export call.
// Verified to fail on the pre-fix runtime: `resumed` stays 0 for the whole
// probe window.

import { assertEq } from "./support/asserts.ts";
import { driveStoreAsync, registerHostCall } from "../src/exec/mod.ts";
import { Store } from "../src/task/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** The stand-in guest thread of host_pump_test.ts, trimmed to what a
 * settlement-resumption needs: `Store.tick` resumes it whenever `ready()`. */
class FakeThread {
  #ready = false;
  resumed = 0;
  readonly task = { inst: {} };
  ready(): boolean {
    return this.#ready;
  }
  waiting(): boolean {
    return !this.#ready;
  }
  wake(): void {
    this.#ready = true;
  }
  resume(): void {
    this.#ready = false;
    this.resumed++;
  }
}

Deno.test({
  name:
    "a host call registered while a driver is parked wakes the guest (stale snapshot, #239 class)",
  fn: async () => {
    const store = new Store();
    const guest = new FakeThread();
    store.startWaiting(guest);

    // The never-settling call that keeps the incumbent driver parked, and
    // the driver itself: `done` never fires on its own, so it exits only via
    // the flag below (the test's stand-in for the stream session ending).
    const stuck = new Promise<void>(() => {});
    registerHostCall(store, stuck);
    let finished = false;
    const driving = driveStoreAsync(store, () => finished, "test driver");

    // Let it reach the park.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    assertEq(guest.resumed, 0);

    // The late registration, modelled exactly as the async-lower site does
    // it (exec/boundary.ts `createLoweredImport`): a promise whose
    // continuation deletes its own entry and readies the guest, registered
    // via `registerHostCall`. No driver is entered.
    let settle!: () => void;
    const raw = new Promise<void>((r) => (settle = r));
    const call: Promise<void> = raw.then(() => {
      store.pendingHostCalls.delete(call);
      guest.wake();
    });
    registerHostCall(store, call);

    settle();

    // A few microtask/timer turns is all a woken driver needs: it drops out
    // of the race, re-snapshots, and ticks the ready thread.
    for (let i = 0; i < 20 && guest.resumed === 0; i++) {
      await Promise.resolve();
    }
    for (let i = 0; i < 5 && guest.resumed === 0; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    assert(
      guest.resumed > 0,
      "the guest was never resumed: the parked driver's host-call snapshot " +
        "was stale and nothing else drove the store",
    );
    assertEq(store.hostFailure, undefined);

    // Release the driver so the test leaves no live loop behind — and leave
    // `pendingHostCalls` EMPTY on the way out, or the settlement pump inherits
    // an entry that can never settle again and spins.
    finished = true;
    store.pendingHostCalls.delete(stuck);
    const wake: Promise<void> = Promise.resolve().then(() => {
      store.pendingHostCalls.delete(wake);
    });
    registerHostCall(store, wake);
    await driving;
    assertEq(store.pendingHostCalls.size, 0);
  },
});
