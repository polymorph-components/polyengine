// Callback cancellation is explicit in `canon_lift`, not a generic property of
// `Thread.waitUntil` (definitions.py:2073-2094). These generator-level models
// pin the callback loop's readiness and post-wait delivery ordering.
//
// The bodies below mirror exec/boundary.ts `runCallbackLoop`'s WAIT/YIELD arms
// (:2640-2700) — release the slot across the wait, retake it after — with fake
// threads, no wasm.

import { assertEq } from "./support/asserts.ts";
import {
  type BlockRequest,
  ComponentInstanceState,
  EventCode,
  type EventTuple,
  Store,
  Task,
  type TaskOptions,
  Thread,
  Waitable,
  WaitableSet,
} from "../src/task/mod.ts";
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
  body: (t: Thread) => Generator<BlockRequest, void, unknown>,
): Thread {
  // Forward reference: the generator body only runs once `thread` below
  // is assigned (spawn returns before the body executes).
  function* threadBody(): Generator<BlockRequest, void, unknown> {
    yield* body(thread);
  }
  const thread: Thread = new Thread(task, threadBody());
  return thread;
}

function mkTask(inst: ComponentInstanceState, opts: TaskOptions): Task {
  return new Task(ASYNC_FT, opts, inst, () => [], () => {});
}

/** Drive the store to quiescence; bounded so a lost wakeup is not a hang. */
function runToQuiescence(store: Store): void {
  for (let i = 0; i < 50 && store.tick(); i++);
}

/**
 * Sibling B of the same instance: takes the exclusive slot, then parks
 * NON-cancellably mid-activation (stands in for a jspi sync lower of an
 * unresolved `suspending()` import). Opening the gate lets it return and
 * release the slot.
 */
function spawnSibling(
  inst: ComponentInstanceState,
  gate: { open: boolean },
): Thread {
  const b = mkTask(inst, CALLBACK_OPTS);
  const tb = spawn(b, function* (thread) {
    yield* b.enterImplicitThread(thread);
    b.start();
    yield* thread.waitUntil(() => gate.open);
    b.return_([]);
    b.exitImplicitThread(thread);
  });
  tb.resume();
  return tb;
}

Deno.test("callback WAIT: cancel pending behind a sibling's exclusive slot is delivered when the slot frees", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const wset = new WaitableSet(); // empty: no event will ever arrive
  const events: EventTuple[] = [];

  const a = mkTask(inst, CALLBACK_OPTS);
  const ta = spawn(a, function* (thread) {
    yield* a.enterImplicitThread(thread); // takes inst.exclusiveThread
    a.start();
    inst.exclusiveThread = null; // runCallbackLoop: release across the wait
    yield* thread.waitUntil(() =>
      inst.exclusiveThread === null &&
      (a.hasPendingCancel() || wset.hasPendingEvent())
    );
    const ev = a.deliverPendingCancel()
      ? [EventCode.TASK_CANCELLED, 0, 0] as EventTuple
      : wset.getPendingEvent();
    events.push(ev);
    inst.exclusiveThread = thread; // retake, as the loop does
    if (ev[0] === EventCode.TASK_CANCELLED) a.cancel();
    else a.return_([]);
    a.exitImplicitThread(thread);
  });
  ta.resume();

  const gate = { open: false };
  const tb = spawnSibling(inst, gate);
  assertEq(inst.exclusiveThread === tb, true, "B holds the exclusive slot");

  a.requestCancellation(null);
  // The request remains pending while B holds the lock.
  assertEq(a.state, "pending-cancel");

  gate.open = true;
  runToQuiescence(store);
  assertEq(inst.exclusiveThread, null, "B released the slot");

  // Callback readiness includes pending cancellation explicitly.
  assertEq(events, [[EventCode.TASK_CANCELLED, 0, 0]]);
  assertEq(a.state, "resolved");
});

Deno.test("callback YIELD: a pending cancel released by the slot must resume as cancelled, not as NONE", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const observed: boolean[] = [];

  const a = mkTask(inst, CALLBACK_OPTS);
  const ta = spawn(a, function* (thread) {
    yield* a.enterImplicitThread(thread);
    a.start();
    inst.exclusiveThread = null;
    yield* thread.waitUntil(() =>
      inst.exclusiveThread === null && a.hasPendingCancel()
    );
    const cancelled = a.deliverPendingCancel();
    observed.push(cancelled);
    inst.exclusiveThread = thread;
    if (cancelled) a.cancel();
    else a.return_([]);
    a.exitImplicitThread(thread);
  });
  ta.resume();

  const gate = { open: false };
  spawnSibling(inst, gate);
  a.requestCancellation(null);
  assertEq(a.state, "pending-cancel");

  gate.open = true;
  runToQuiescence(store);

  // The callback loop performs delivery after the pure wait.
  assertEq(observed, [true]);
});

Deno.test("callback WAIT with an event pending: TASK_CANCELLED is delivered first and the event stays pending", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const wset = new WaitableSet();
  const events: EventTuple[] = [];

  const a = mkTask(inst, CALLBACK_OPTS);
  const ta = spawn(a, function* (thread) {
    yield* a.enterImplicitThread(thread);
    a.start();
    inst.exclusiveThread = null;
    yield* thread.waitUntil(() =>
      inst.exclusiveThread === null &&
      (a.hasPendingCancel() || wset.hasPendingEvent())
    );
    const ev = a.deliverPendingCancel()
      ? [EventCode.TASK_CANCELLED, 0, 0] as EventTuple
      : wset.getPendingEvent();
    events.push(ev);
    inst.exclusiveThread = thread;
    if (ev[0] === EventCode.TASK_CANCELLED) a.cancel();
    else a.return_([]);
    a.exitImplicitThread(thread);
  });
  ta.resume();

  const gate = { open: false };
  spawnSibling(inst, gate);
  a.requestCancellation(null);
  assertEq(a.state, "pending-cancel");

  // Arm the set: a waitable with a queued SUBTASK event, joined before the
  // slot frees, so both disjuncts of the reference's ready predicate hold.
  const w = new Waitable();
  w.join(wset);
  w.setPendingEvent(() => [EventCode.SUBTASK, 7, 0]);

  gate.open = true;
  runToQuiescence(store);

  // `deliver_pending_cancel` runs before `get_pending_event`, so the event is
  // retained.
  assertEq(events, [[EventCode.TASK_CANCELLED, 0, 0]]);
  assertEq(w.hasPendingEvent(), true, "the SUBTASK event is still pending");
});
