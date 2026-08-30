// Driver-level coverage for issue #156, INVERTED by polyengine#173 (CM#705).
//
// #156's shape: instance B's thread parked on an already-settled
// `awaitValue` (tail queued in `store.settled`) while sibling instance A held
// a host entry, which under the transient reentrance model's shared
// per-instantiation root made B non-enterable — so B's tail was DEFERRED IN
// PLACE and `driveAsync` had to park (not spin) until the lock released.
//
// Deferral can no longer occur: definitions.py @ 2f13265 has no
// `may_enter`/`enter_from`/`leave_to`, polyengine#173 deleted the model here
// too, and every non-stale tail dispatches on the spot. The pin below
// is the merged behavior — the tail dispatches immediately, with an unrelated
// outstanding host call in flight, and the driver still reaches quiescence
// (the outstanding call must not be mistaken for a reason to wedge).

import { assertEq } from "./support/asserts.ts";
import { driveStoreAsync } from "../src/exec/boundary.ts";
import {
  type BlockRequest,
  type Cancelled,
  ComponentInstanceState,
  Store,
  Task,
  type TaskOptions,
  Thread,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

const SYNC_FT: FuncType = { params: [], results: [], async: false };
const SYNC_OPTS: TaskOptions = {
  async_: false,
  callback: false,
  stringEncoding: "utf8",
  memory: null,
};

function spawn(
  task: Task,
  body: (t: Thread) => Generator<BlockRequest, void, Cancelled>,
): Thread {
  let thread!: Thread;
  thread = new Thread(
    task,
    (function* (): Generator<BlockRequest, void, Cancelled> {
      yield* body(thread);
    })(),
  );
  return thread;
}

Deno.test("driveAsync: a sibling's tail dispatches immediately (CM#705)", async () => {
  const store = new Store();
  const a = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);

  // B: parked on an awaitValue promise that settles immediately.
  const parkPromise = Promise.resolve(undefined);
  const order: string[] = [];
  const bTask = new Task(SYNC_FT, SYNC_OPTS, b, () => [], (() => {}) as never);
  const bThread = spawn(bTask, function* (thread) {
    yield* bTask.enterImplicitThread(thread);
    bTask.start();
    yield { readyFunc: null, cancellable: false, awaitValue: parkPromise };
    order.push("b tail ran");
    bTask.return_([]);
    bTask.exitImplicitThread(thread);
  });
  bThread.resume();
  // Let `noteAwaiting`'s eager continuation queue the tail.
  await Promise.resolve();
  await Promise.resolve();
  assertEq(store.settled.length, 1, "B's tail is queued");

  // A is mid-host-entry. Post-CM#705 that constrains nothing about B.
  void a;

  // An outstanding host call, registered exactly as `callDtorGated` did
  // (`.then` attached BEFORE insertion, so the driver's race sees an entry
  // that self-removes). Demonstrably a macrotask away: the driver must park,
  // not spin, while it is outstanding.
  let releaseHostCall!: () => void;
  const hostCall = new Promise<void>((r) => {
    releaseHostCall = r;
  });
  const gated = hostCall.then(() => {
    store.pendingHostCalls.delete(gated);
  });
  store.pendingHostCalls.add(gated);
  setTimeout(() => releaseHostCall(), 0);

  await driveStoreAsync(
    store,
    () => bTask.state === "resolved",
    "settled-deferral test",
  );

  assertEq(order.join(","), "b tail ran");
  assertEq(bTask.state, "resolved");
  assertEq(store.settled.length, 0);
  assertEq(store.awaiting.size, 0);
});
