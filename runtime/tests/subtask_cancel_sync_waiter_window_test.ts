// #295: the async form of `subtask.cancel` must not hold `hasSyncWaiter`
// across the #92 determinacy park.
//
// definitions.py `canon_subtask_cancel` (:2453-2461) sets `has_sync_waiter`
// before `on_cancel()` and clears it BEFORE returning BLOCKED — the flag is
// held only across the synchronous claim window. Our jspi implementation adds
// a park (named divergence #92, docs/architecture.md §6) that waits for the
// callee to become determinate before answering; #92 licenses a *reordering*,
// not a new trap condition, so the async form clears the flag at park entry.
//
// Pinned here: with the callee hop-parked (a thread neither done nor in
// `store.waiting`, so `determinate()` is false), a sibling thread's
// `waitable.join` on the same subtask handle succeeds during the park.

import { assertEq } from "./support/asserts.ts";
import {
  BLOCKED,
  createSubtaskCancel,
  createWaitableJoin,
} from "../src/intrinsics/async_builtins.ts";
import {
  ComponentInstanceState,
  popCurrentThread,
  pushCurrentThread,
  Store,
  Subtask,
  Task,
  type TaskOptions,
  Thread,
  WaitableSet,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

const FT: FuncType = { params: [], results: [], async: true };
const OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

Deno.test(
  "#295: async subtask.cancel clears hasSyncWaiter when the #92 determinacy " +
    "park begins, so a sibling waitable.join on the same subtask succeeds",
  async () => {
    const store = new Store();
    const inst = new ComponentInstanceState(0, store);

    const subtask = new Subtask();
    subtask.onCancel = () => {}; // does not resolve: the park's shape.
    const subtaski = inst.handles.add(subtask);

    // A callee task whose only thread is hop-parked: not done, and not
    // registered in `store.waiting` — exactly the mid-hop state the #92 park
    // exists to wait out, so `determinate()` is false and the cancel parks.
    const calleeTask = new Task(FT, OPTS, inst, () => [], () => {});
    const calleeThread = new Thread(calleeTask, (function* () {})());
    calleeTask.threads.push(calleeThread);
    subtask.calleeTask = calleeTask;
    assertEq(calleeThread.done(), false);

    const callerTask = new Task(FT, OPTS, inst, () => [], () => {});
    const callerThread = new Thread(callerTask, (function* () {})());
    const asGuest = <T>(fn: () => T): T => {
      pushCurrentThread(callerThread);
      try {
        return fn();
      } finally {
        popCurrentThread(callerThread);
      }
    };

    const cancel = createSubtaskCancel({ async: true }, inst, "jspi");
    const pending = asGuest(() => cancel(subtaski)) as unknown as Promise<
      number
    >;
    // The park is entered synchronously, before the Promise is handed back.
    assertEq(subtask.hasSyncWaiter, false);

    // The reference has already returned BLOCKED with the flag clear by now,
    // so a sibling thread joining this subtask into a set must succeed.
    const wset = new WaitableSet();
    const seti = inst.handles.add(wset);
    const siblingTask = new Task(FT, OPTS, inst, () => [], () => {});
    const siblingThread = new Thread(siblingTask, (function* () {})());
    pushCurrentThread(siblingThread);
    try {
      createWaitableJoin(inst)(subtaski, seti);
    } finally {
      popCurrentThread(siblingThread);
    }
    assertEq(subtask.inWaitableSet(), true);

    // Unwind: make the callee determinate and let the park answer BLOCKED
    // (the subtask never resolved).
    // (the park captured the callee task object, so drop its threads rather
    // than clearing `subtask.calleeTask`).
    calleeTask.threads.length = 0;
    store.tick();
    assertEq(await pending, BLOCKED);
    assertEq(subtask.hasSyncWaiter, false);
  },
);
