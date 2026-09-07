// F1: `driveAsync`'s race-winner path resumes a thread directly but leaves the
// settlement's own `store.settled` entry behind.
//
// THE SHAPE (store-level; no checked-in example guest has the participants —
// a callback-ABI callee cancelled by its caller, whose `waitUntil` returns
// WITHOUT yielding on the pending cancel and re-parks inside the very
// `resumeWith` the winner path just called).
//
//   * `noteAwaiting` records the settlement EAGERLY: the parked promise's
//     first reaction pushes `{t, value}` onto `store.settled`;
//   * the winner path (exec/boundary.ts, the `winner.t.resumeWith(...)` site)
//     then resumes `t` directly and never splices that entry out;
//   * `serviceSettled` drops a leftover entry only when `!awaiting.has(t)`. A
//     SYNCHRONOUS re-park inside `resumeWith` puts `t` back in `awaiting`, so
//     the next iteration delivers the OLD value against the NEW promise.
//
// definitions.py `Thread.resume` is atomic: one settlement, one delivery. The
// assertion below is exactly that — the value arrives once.

import { assertEq } from "./support/asserts.ts";
import { driveStoreAsync, registerHostCall } from "../src/exec/mod.ts";
import { Store } from "../src/task/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/**
 * A promise-parked thread that re-parks synchronously inside `resumeWith` —
 * the `waitUntil`-with-a-pending-cancel shape (task/thread.ts:260 returns
 * without yielding, so the body runs straight on to a fresh `awaitValue`).
 *
 * Only the fields `Store.serviceSettled` / `noteAwaiting` / the driver's
 * winner path touch: `task.inst`, `awaiting`, `resumeWith`.
 */
class ReparkingThread {
  readonly task = { inst: { handles: [] as unknown[] } };
  awaiting: Promise<unknown> | null = null;
  readonly received: unknown[] = [];

  constructor(private readonly store: Store) {}

  resumeWith(value: unknown, failure?: { error: unknown }): void {
    this.received.push(failure === undefined ? value : failure);
    // What `Thread.resumeWith` does first, verbatim (task/thread.ts:141-142).
    this.awaiting = null;
    this.store.awaiting.delete(this);
    // ... and then the body runs, and blocks again on a NEW promise before
    // control ever returns to the driver.
    const next = new Promise<unknown>(() => {});
    this.awaiting = next;
    this.store.noteAwaiting(this, next);
  }
}

Deno.test({
  name:
    "F1: a settlement consumed by the race-winner path is not re-delivered to a synchronous re-park",
  fn: async () => {
    const store = new Store();
    const t = new ReparkingThread(store);

    // The park the driver will race.
    let settleA!: (v: unknown) => void;
    const p1 = new Promise<unknown>((r) => (settleA = r));
    t.awaiting = p1;
    store.noteAwaiting(t, p1);

    // A real, never-settling host call: it keeps `pendingHostCalls` non-empty
    // so the driver takes the P5 servicing race (the winner path) instead of
    // the deadlock probe.
    const stuck = new Promise<void>(() => {});
    registerHostCall(store, stuck);

    let finished = false;
    const driving = driveStoreAsync(store, () => finished, "F1 driver");

    // Let the driver reach the race.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    assertEq(t.received.length, 0);

    settleA("A");

    // Give the winner path and the next loop iteration (whose `serviceSettled`
    // is where the stale entry would be dispatched) room to run.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();

    assert(
      t.received.length > 0,
      "the settlement was never delivered at all (test setup, not the bug)",
    );
    assertEq(t.received, ["A"]);
    // The corollary: nothing of that settlement is left queued against the
    // NEW park.
    assertEq(store.settled.length, 0);

    // Teardown: let the driver exit and leave `pendingHostCalls` empty so the
    // settlement pump inherits nothing.
    finished = true;
    store.pendingHostCalls.delete(stuck);
    const wake: Promise<void> = Promise.resolve().then(() => {
      store.pendingHostCalls.delete(wake);
    });
    registerHostCall(store, wake);
    await driving;
    assertEq(store.pendingHostCalls.size, 0);
    assertEq(store.hostFailure, undefined);
  },
});
