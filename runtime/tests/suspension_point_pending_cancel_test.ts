// `SuspensionPoint`/`blockCurrentActivation` carried the pre-#302 shape of
// `Thread.waitUntil`: it parked on the raw `readyFunc`, returned the raw
// cancelled flag, and left `cancellable` set after resuming. The reference
// (definitions.py `Thread.wait_until` 361-373) parks on `ready_func() or
// (cancellable() and task.has_pending_cancel())` and re-runs
// `deliver_pending_cancel` AFTER the block; task/thread.ts:waitUntil ports
// that, and this pins the jspi block path to the same behavior.
//
// The producing shape: a cancel that arrives while a sibling activation of the
// instance holds `exclusiveThread` parks as `pending-cancel`
// (`Task.requestCancellation` excludes the implicit thread — and hence its
// suspension points — while the lock is held). When the slot frees, the
// reference wakes the parked block point and hands it Cancelled.TRUE.
//
// Issue #300 notes this is unreachable through real guests today: the only
// producer of a pending-cancel against a live cancellable wait is the
// exclusive-slot exclusion, which no real `SuspensionPoint` owner meets. So
// the point is driven directly, with fake threads and no wasm, in the style of
// wait_until_pending_cancel_test.ts.

import { assertEq } from "./support/asserts.ts";
import {
  type BlockRequest,
  type Cancelled,
  ComponentInstanceState,
  Store,
  Task,
  type TaskOptions,
  Thread,
} from "../src/task/mod.ts";
import { SuspensionPoint } from "../src/jspi/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

const ASYNC_FT: FuncType = { params: [], results: [], async: true };

/** Async-typed, callback ABI: `needsExclusive()` is true. */
const CALLBACK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
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

function mkTask(inst: ComponentInstanceState, opts: TaskOptions): Task {
  return new Task(ASYNC_FT, opts, inst, () => [], () => {});
}

/**
 * Drive the store to quiescence; bounded so a lost wakeup is not a hang.
 *
 * Settling a suspension point takes a `pendingResumptions` entry against the
 * resumed activation, and `tick` refuses to run while one is outstanding. In a
 * real jspi run the engine resumes the wasm activation, which closes its own
 * window by parking again or finishing; here nothing does, so the loop plays
 * that edge (`Store.releasePendingOf`, the settle-side half) itself.
 */
function runToQuiescence(store: Store, task: Task): void {
  for (let i = 0; i < 50; i++) {
    if (!store.tick()) break;
    store.releasePendingOf(task.implicitThread);
  }
}

/** Sibling B: takes the exclusive slot, parks non-cancellably until `gate`. */
function spawnSibling(
  inst: ComponentInstanceState,
  gate: { open: boolean },
): Thread {
  const b = mkTask(inst, CALLBACK_OPTS);
  const tb = spawn(b, function* (thread) {
    yield* b.enterImplicitThread(thread);
    b.start();
    yield* thread.waitUntil(() => gate.open, false);
    b.return_([]);
    b.exitImplicitThread(thread);
  });
  tb.resume();
  return tb;
}

/**
 * Task A blocking the jspi way: a cancellable `SuspensionPoint` sits in
 * `store.waiting` while the Thread that owns the activation parks
 * non-cancellably on the settle of that point (the `awaitValue` seam, modelled
 * here as a plain flag rather than a Promise).
 */
function spawnJspiBlocker(
  inst: ComponentInstanceState,
  readyFunc: (() => boolean) | null,
  observed: boolean[],
): Task {
  const a = mkTask(inst, CALLBACK_OPTS);
  const ta = spawn(a, function* (thread) {
    yield* a.enterImplicitThread(thread);
    a.start();
    inst.exclusiveThread = null; // released across the block, as the loop does
    const settled = { done: false };
    new SuspensionPoint<number>(
      inst.store,
      a,
      readyFunc,
      true, // cancellable block point
      (cancelled) => {
        observed.push(cancelled === true);
        settled.done = true;
        return 0;
      },
      thread,
    );
    yield* thread.waitUntil(() => settled.done, false);
    inst.exclusiveThread = thread; // retake, as the loop does
    if (observed[0]) a.cancel();
    else a.return_([]);
    a.exitImplicitThread(thread);
  });
  ta.resume();
  return a;
}

Deno.test("jspi block: a cancel pending behind a sibling's exclusive slot resumes the suspension point as cancelled", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const observed: boolean[] = [];

  // `readyFunc` mirrors the callback loop's "the lock is free" condition, so
  // the point IS woken pre-fix — what it was handed is the question.
  const a = spawnJspiBlocker(
    inst,
    () => inst.exclusiveThread === null,
    observed,
  );

  const gate = { open: false };
  const tb = spawnSibling(inst, gate);
  assertEq(inst.exclusiveThread === tb, true, "B holds the exclusive slot");

  a.requestCancellation(null);
  // Agreed by both: A is not cancellable while B holds the lock, and its
  // suspension point is a frame of A's implicit thread.
  assertEq(a.state, "pending-cancel");

  gate.open = true;
  runToQuiescence(store, a);

  // Reference: the post-block `deliver_pending_cancel` converts the
  // Cancelled.FALSE resumption into Cancelled.TRUE. Pre-fix: a spurious false.
  assertEq(observed, [true]);
  assertEq(a.state, "resolved");
});

Deno.test("jspi block: a suspension point whose readyFunc never holds is still woken by the pending cancel", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const observed: boolean[] = [];

  // Nothing this point waits for will ever happen (an empty waitable set):
  // only the reference's `cancellable() and has_pending_cancel()` disjunct
  // can make it ready.
  const a = spawnJspiBlocker(inst, () => false, observed);

  const gate = { open: false };
  spawnSibling(inst, gate);
  a.requestCancellation(null);
  assertEq(a.state, "pending-cancel");

  gate.open = true;
  runToQuiescence(store, a);

  // Pre-fix: never woken at all — `observed` stays empty and A never resolves.
  assertEq(observed, [true]);
  assertEq(a.state, "resolved");
});
