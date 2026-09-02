// #92 (test half): a seeded-shuffle regression pinning the "cancel-delivery
// timing" window named in issue #92.
//
// The window: under jspi, `Task.requestCancellation`'s
// `SuspensionPoint.resume()` only *settles* the suspended activation's
// Promise; the resumed wasm frame's own continuation (its remaining
// built-ins, `exit-sync-call`, etc.) runs on a LATER microtask. A concurrent
// host EXPORT call can enter the same instance in between.
//
// There is no host-entry bracket and no reentrance gate, in the reference or
// here (CM#705), so the concurrent entry is ADMITTED by design rather than by
// an accident of bracket timing. The behavioral pin: driving a
// second export call through that window does not double-resume anything or
// leave inconsistent final state. It is included in `just sched-seeds` so any
// future schedule-order dependence here is caught.

import { assertEq } from "./support/asserts.ts";
import { createWaitableSetWait } from "../src/intrinsics/async_builtins.ts";
import { createLiftedFunction, newStats, type ResolvedOptions } from "../src/exec/boundary.ts";
import { entryRefusal } from "../src/task/scheduler.ts";
import {
  ComponentInstanceState,
  popCurrentThread,
  pushCurrentThread,
  Store,
  Task,
  type TaskOptions,
  Thread,
  WaitableSet,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

const ASYNC_FT: FuncType = { params: [], results: [], async: true };
const CALLBACK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

Deno.test(
  "#92: a concurrent export call entering between a cancellation delivery " +
    "and the resumed jspi activation's continuation is admitted, with no " +
    "double-resume and consistent final state",
  async () => {
    const store = new Store();
    const inst = new ComponentInstanceState(0, store);
    const wset = new WaitableSet();
    const seti = inst.handles.add(wset);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = {
      addrType: "i32" as const,
      get bytes() {
        return new Uint8Array(memory.buffer);
      },
      get view() {
        return new DataView(memory.buffer);
      },
      get length() {
        return memory.buffer.byteLength;
      },
      ptrType: () => "i32" as const,
      ptrSize: () => 4 as const,
    };
    const opts: ResolvedOptions = {
      stringEncoding: "utf8",
      // deno-lint-ignore no-explicit-any
      memory: view as any,
      realloc: null,
      postReturn: null,
      callback: null,
      async: true,
      cancellable: true, // the caller's `cancellable` canonical option.
      coreType: { params: ["i32", "i32"], results: ["i32"] },
      instance: inst,
    };
    const ctx = {
      componentInstance: () => inst,
      options: () => opts,
      resultTypes: () => [],
    };
    const task = new Task(ASYNC_FT, CALLBACK_OPTS, inst, () => [], () => {});
    task.state = "started";
    const thread = new Thread(task, (function* () {})());

    // Park task A at a cancellable `waitable-set.wait` (jspi mode) — no
    // event pending, so this is SITE 2's genuine suspension.
    const wait = createWaitableSetWait({ options: 0 }, ctx, inst, "jspi");
    pushCurrentThread(thread);
    let parked: unknown;
    try {
      parked = wait(seti, 0);
    } finally {
      popCurrentThread(thread);
    }
    assertEq(typeof parked, "object"); // a Promise, per blockCurrentActivation.
    assertEq(store.waiting.length, 1);

    // Sanity: nothing refuses entry while the activation is parked.
    assertEq(entryRefusal(inst, null, "base"), null);

    // Deliver the cancellation exactly as `Task.requestCancellation` does:
    // it finds the parked SuspensionPoint as a candidate (registered with
    // `task === task` and `cancellable === true`) and resumes it.
    task.requestCancellation(null);

    // THE WINDOW: the resumed activation's own continuation (the `.then()`
    // the engine attached to the settled Promise) has not run yet, and the
    // instance admits entry. This is exactly the gap #92 names.
    assertEq(entryRefusal(inst, null, "base"), null);
    assertEq(task.state, "cancel-delivered");

    // Drive a concurrent EXPORT call into the SAME instance through the real
    // host-entry path (`createLiftedFunction`), which refuses only a
    // poisoned instance (CM#705). If this traps or corrupts state, the
    // divergence is no longer merely theoretical.
    const syncFt: FuncType = { params: [], results: [], async: false };
    const exportOpts: ResolvedOptions = {
      stringEncoding: "utf8",
      memory: null,
      realloc: null,
      postReturn: null,
      callback: null,
      async: false,
      cancellable: false,
      coreType: { params: [], results: [] },
      instance: inst,
    };
    const lifted = createLiftedFunction({
      name: "concurrent-export",
      ft: syncFt,
      opts: exportOpts,
      core: () => undefined,
      stats: newStats(),
    });
    let raised: unknown;
    try {
      lifted();
    } catch (e) {
      raised = e;
    }
    // The concurrent entry is admitted — now by the merged reference's own
    // rule, not merely as an observed quirk.
    assertEq(raised, undefined);

    // Let the cancelled activation's own continuation actually run (the
    // microtask the engine scheduled when `resume()` settled its Promise),
    // and confirm no double-resume assertion fired and the final state is
    // consistent: the SuspensionPoint is done, the WaitableSet was never
    // touched by the concurrent export (it did not join or wait), and no
    // exception escaped this far.
    let sawRejection: unknown;
    await (parked as Promise<unknown>).catch((e) => {
      sawRejection = e;
    });
    // A cancelled `waitable-set.wait` resolves with TASK_CANCELLED — not a
    // rejection — so nothing should have been caught here.
    assertEq(sawRejection, undefined);
    assertEq(store.waiting.length, 0);
  },
);
