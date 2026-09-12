// The 0.3 async canonical built-ins, as host trampolines
// (contracts/intrinsics.md §B): task.{return,cancel},
// backpressure.{inc,dec}, waitable-set.{new,wait,poll,drop},
// waitable.join, subtask.{drop,cancel} and thread.yield.
//
// Semantics follow the corresponding `canon_*` functions in definitions.py,
// with JSPI timing differences documented at the waits below.
//
// Instance-scoped built-ins use the trampoline's declared instance. It is
// available during core start functions before a task exists, and identifies
// the right handle table even when a FACT adapter runs under another
// instance's task. Operations needing a task/thread still read the ambient.
//
// Blocking a wasm frame requires JSPI, including from callback-ABI code.
// Returning WAIT/YIELD callback codes is the stackless alternative. A built-in
// may complete immediately when its condition already holds, as permitted by
// `Thread.wait_until`; otherwise plain mode reports `NeedsJspi`.

import { blockCurrentActivation } from "../jspi/mod.ts";
import type { SuspensionMode } from "../jspi/mod.ts";
import type { Cancelled } from "../task/mod.ts";
import { assert_, trap, trapIf } from "../cabi/trap.ts";
import {
  CoreValueIter,
  liftFlatValues,
  LiftLowerContext,
  MAX_FLAT_PARAMS,
  store as storeValue,
} from "../cabi/mod.ts";
import type { CoreValue, ValType } from "../cabi/types.ts";
import { valTypesEqual } from "../cabi/types.ts";
import {
  currentTask,
  currentThread,
  EventCode,
  type EventTuple,
  liftOptionsEqual,
  needsJspi,
  Subtask,
  type Task,
  type Thread,
  Waitable,
  WaitableSet,
} from "../task/mod.ts";
import type { ComponentInstanceState } from "../task/mod.ts";
import type { CoreFn, ResolvedOptions } from "../exec/boundary.ts";
import { cabiOptions, normalizeCoreValues } from "../exec/boundary.ts";
import { traceCopy } from "./stream_builtins.ts";
import { removeHandleWithUnwind } from "../task/scheduler.ts";

/** Services these built-ins need from the executor. */
export interface AsyncTrampolineContext {
  componentInstance(index: number): ComponentInstanceState;
  /** Resolved canonical options by `canonicalOptions` index. */
  options(index: number): ResolvedOptions;
  /** The element types of an interned results *tuple* (`task-return`). */
  resultTypes(index: number): ValType[];
}

/**
 * `BLOCKED` sentinel of definitions.py `canon_subtask_cancel`.
 */
export const BLOCKED = 0xffff_ffff;

// ---------------------------------------------------------------------------
// task.return / task.cancel
// ---------------------------------------------------------------------------

/** definitions.py `canon_task_return`. */
export function createTaskReturn(
  decl: { results: number; resultType: number | null; options: number },
  ctx: AsyncTrampolineContext,
): CoreFn {
  const opts = ctx.options(decl.options);
  // `resultType` is the interned `plan.types` entry; `results` is the
  // raw wasmtime `TypeTupleIndex` (the FACT `task_return_type` key, consumed
  // by the loader's dictionary). `null` is wire-legal for a task with no
  // declared result type and means an empty results list here.
  const resultTypes = decl.resultType === null
    ? []
    : ctx.resultTypes(decl.resultType);
  return (...flatArgs: CoreValue[]) => {
    const task = currentTask() as Task;
    trapIf(
      !task.inst.mayLeave,
      "task.return: cannot leave component instance (may_leave violation)",
    );
    trapIf(!task.opts.async_, "task.return from a non-async task");
    // `canon_task_return`'s `trap_if(result_type != task.ft.result)`: the
    // trampoline's interned result tuple must be the lifted function's result
    // type. Compared structurally — the plan's type table interns by
    // structure, so identity comparison would reject valid components.
    //
    // FACT tasks with no mapping for their raw TypeTupleIndex carry placeholder
    // results, not a declaration; only those skip this comparison.
    trapIf(
      (!task.factPassthrough || task.factResultTypesKnown) &&
        !valTypesEqual(resultTypes, task.ft.results),
      "task.return with a result type that is not the task's result type",
    );
    // `LiftOptions.equal` compares string encoding and memory identity.
    // Both are checked for host-boundary tasks. FACT tasks skip memory
    // identity: prepare-call carries the adapter's memory, which can be null
    // even when the callee's task.return names one (cross-abi-calls.wast's
    // 17-param async lifts). Restoring this check needs a reliable mapping
    // to the callee's lift memory. Encoding is passed directly and checked.
    trapIf(
      !liftOptionsEqual(
        { stringEncoding: opts.stringEncoding, memory: opts.memory },
        task.factPassthrough
          ? { stringEncoding: task.opts.stringEncoding, memory: opts.memory }
          : task.opts,
      ),
      "task.return with canonical options differing from the task's",
    );
    // Normalize by declared lane type; integer coercion must not touch floats.
    const flat = normalizeCoreValues(
      flatArgs,
      opts.coreType.params,
      "task.return arguments",
    );
    if (task.factPassthrough) {
      // FACT cross-component call: the caller's `[async-return]` adapter
      // function does the lift-and-lower itself, in wasm, so the host hands it
      // the callee's flat results untouched. See `Task.factPassthrough`.
      task.return_(flat);
      return;
    }
    const cx = new LiftLowerContext(cabiOptions(opts), task.inst, task);
    const vi = new CoreValueIter(flat);
    const result = liftFlatValues(cx, MAX_FLAT_PARAMS, vi, task.ft.results);
    task.return_(result);
  };
}

/** definitions.py `canon_task_cancel`. */
export function createTaskCancel(): CoreFn {
  return () => {
    const task = currentTask() as Task;
    trapIf(
      !task.inst.mayLeave,
      "task.cancel: cannot leave component instance (may_leave violation)",
    );
    trapIf(!task.opts.async_, "task.cancel from a non-async task");
    task.cancel();
  };
}

// ---------------------------------------------------------------------------
// backpressure
// ---------------------------------------------------------------------------

/** definitions.py `canon_backpressure_inc`. */
export function createBackpressureInc(inst: ComponentInstanceState): CoreFn {
  return () => {
    assert_(
      inst.backpressure >= 0 && inst.backpressure < 2 ** 16,
      "backpressure counter out of range",
    );
    inst.backpressure += 1;
    trapIf(inst.backpressure === 2 ** 16, "backpressure counter overflow");
  };
}

/** definitions.py `canon_backpressure_dec`. */
export function createBackpressureDec(inst: ComponentInstanceState): CoreFn {
  return () => {
    assert_(
      inst.backpressure >= 0 && inst.backpressure < 2 ** 16,
      "backpressure counter out of range",
    );
    inst.backpressure -= 1;
    trapIf(inst.backpressure < 0, "backpressure counter underflow");
  };
}

// ---------------------------------------------------------------------------
// waitable sets
// ---------------------------------------------------------------------------

/** definitions.py `canon_waitable_set_new`. */
export function createWaitableSetNew(inst: ComponentInstanceState): CoreFn {
  return () => {
    trapIf(
      !inst.mayLeave,
      "waitable-set.new: cannot leave component instance",
    );
    return inst.handles.add(new WaitableSet());
  };
}

/**
 * definitions.py `canon_waitable_set_wait`. Returns a pending event directly,
 * or suspends the calling wasm frame using JSPI until an event or cancellable
 * task cancellation arrives. Plain mode cannot perform the blocking case.
 */
export function createWaitableSetWait(
  decl: { options: number },
  ctx: AsyncTrampolineContext,
  inst: ComponentInstanceState,
  mode: SuspensionMode = "plain",
): CoreFn {
  const opts = ctx.options(decl.options);
  // `cancellable` is a canonical option, not a trampoline field.
  const cancellable = opts.cancellable;
  return (si?: number, ptr?: number) => {
    // Guest-supplied index/pointer are u32; core wasm delivers i32 args
    // signed. Normalize at the entry boundary.
    si = (si ?? 0) >>> 0;
    ptr = (ptr ?? 0) >>> 0;
    trapIf(
      !inst.mayLeave,
      "waitable-set.wait: cannot leave component instance",
    );
    const wset = requireWaitableSet(inst, si, "waitable-set.wait");
    const task = currentTask() as Task;
    let event: EventTuple;
    if (task.deliverPendingCancel(cancellable)) {
      event = [EventCode.TASK_CANCELLED, 0, 0];
    } else if (wset.hasPendingEvent()) {
      // No waiter count is needed for immediate delivery: no other thread can
      // observe the reference's increment/decrement bracket without a yield.
      traceCopy(`waitable-set.wait si=${si} FAST (pending event)`);
      event = wset.getPendingEvent();
    } else if (mode === "jspi") {
      traceCopy(`waitable-set.wait si=${si} BLOCKS`);
      // `WaitableSet.drop` must see this blocked waiter. Decrement exactly
      // once in onSettled, including abandonment and produce-time traps.
      // produce and the hook run synchronously, so no thread observes a
      // completed wait with its count still elevated.
      wset.numWaiting += 1;
      return blockCurrentActivation({
        store: inst.store,
        task,
        readyFunc: () => wset.hasPendingEvent(),
        cancellable,
        produce: (cancelled: Cancelled) => {
          const ev: EventTuple = cancelled
            ? [EventCode.TASK_CANCELLED, 0, 0]
            : wset.getPendingEvent();
          return unpackEvent(opts, inst, ptr, ev);
        },
        onSettled: () => {
          wset.numWaiting -= 1;
        },
      }) as unknown as number;
    } else {
      needsJspi(
        "waitable-set.wait with no pending event (the calling wasm frame " +
          "must block; a callback-ABI guest should return the WAIT code " +
          "instead)",
      );
    }
    return unpackEvent(opts, inst, ptr, event);
  };
}

/** definitions.py `canon_waitable_set_poll`. */
export function createWaitableSetPoll(
  decl: { options: number },
  ctx: AsyncTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const opts = ctx.options(decl.options);
  /** See `createWaitableSetWait`: `cancellable` is an option, not a decl field. */
  const cancellable = opts.cancellable;
  return (si?: number, ptr?: number) => {
    si = (si ?? 0) >>> 0;
    ptr = (ptr ?? 0) >>> 0;
    trapIf(
      !inst.mayLeave,
      "waitable-set.poll: cannot leave component instance",
    );
    const wset = requireWaitableSet(inst, si, "waitable-set.poll");
    const event = wset.poll(currentTask(), cancellable);
    return unpackEvent(opts, inst, ptr, event);
  };
}

/** definitions.py `canon_waitable_set_drop`. */
export function createWaitableSetDrop(inst: ComponentInstanceState): CoreFn {
  return (i?: number) => {
    // Guest-supplied index is u32; core wasm delivers i32 args signed.
    i = (i ?? 0) >>> 0;
    trapIf(
      !inst.mayLeave,
      "waitable-set.drop: cannot leave component instance",
    );
    removeHandleWithUnwind(inst, i, (wset) => {
      trapIf(
        !(wset instanceof WaitableSet),
        "waitable-set.drop: handle is not a waitable set",
      );
      (wset as WaitableSet).drop();
    });
  };
}

/** definitions.py `canon_waitable_join`. */
export function createWaitableJoin(inst: ComponentInstanceState): CoreFn {
  return (wi?: number, si?: number) => {
    wi = (wi ?? 0) >>> 0;
    si = (si ?? 0) >>> 0;
    trapIf(!inst.mayLeave, "waitable.join: cannot leave component instance");
    const w = inst.handles.get(wi);
    trapIf(!(w instanceof Waitable), "waitable.join: handle is not a waitable");
    trapIf(
      (w as Waitable).hasSyncWaiter,
      // A synchronous claim and waitable-set membership are mutually exclusive.
      "waitable cannot be used synchronously while added to a waitable set " +
        "(waitable.join)",
    );
    if (si === 0) {
      (w as Waitable).join(null);
      return;
    }
    const wset = requireWaitableSet(inst, si, "waitable.join");
    (w as Waitable).join(wset);
  };
}

// ---------------------------------------------------------------------------
// subtasks
// ---------------------------------------------------------------------------

/** definitions.py `canon_subtask_drop`. */
export function createSubtaskDrop(inst: ComponentInstanceState): CoreFn {
  return (i?: number) => {
    i = (i ?? 0) >>> 0;
    trapIf(!inst.mayLeave, "subtask.drop: cannot leave component instance");
    removeHandleWithUnwind(inst, i, (s) => {
      trapIf(!(s instanceof Subtask), "subtask.drop: handle is not a subtask");
      (s as Subtask).drop();
    });
  };
}

/**
 * The tail shared by `subtask.cancel`'s blocking and non-blocking exits:
 * take the delivered SUBTASK event, check it is the one we expect, and report
 * the resolved state. Factored out so the blocking form can run it at RESUME
 * time inside `produce`.
 */
function finishSubtaskCancel(
  i: number | undefined,
  st: Subtask,
): () => number {
  return (): number => {
    const [code, index, payload] = st.getPendingEvent();
    assert_(
      code === EventCode.SUBTASK && index === (i ?? 0) && payload === st.state,
      "unexpected event delivered by subtask.cancel",
    );
    assert_(
      st.resolveDelivered(),
      "subtask.cancel did not deliver the resolution",
    );
    return st.state;
  };
}

/**
 * definitions.py `canon_subtask_cancel`: sync waits for resolution; async
 * reports BLOCKED if unresolved. JSPI also waits for callee determinacy,
 * making the async form non-atomic (docs/architecture.md §6, issue #92).
 */
export function createSubtaskCancel(
  decl: { async?: boolean },
  inst: ComponentInstanceState,
  mode: SuspensionMode = "plain",
): CoreFn {
  const async_ = decl.async === true;
  return (i?: number) => {
    i = (i ?? 0) >>> 0;
    // FACT adds the handle to prepare-call's caller instance, which need not
    // be the ambient task's instance. Use the declared table owner.
    trapIf(!inst.mayLeave, "subtask.cancel: cannot leave component instance");
    const subtask = inst.handles.get(i);
    trapIf(
      !(subtask instanceof Subtask),
      "subtask.cancel: handle is not a subtask",
    );
    const st = subtask as Subtask;
    const finish = finishSubtaskCancel(i, st);
    trapIf(
      st.resolveDelivered(),
      "subtask.cancel on a subtask whose resolution was already delivered",
    );
    trapIf(
      st.cancellationRequested,
      "subtask.cancel on a subtask that was already cancelled",
    );
    // definitions.py `canon_subtask_cancel`: `trap_if(subtask.in_waitable_set())`
    // is unconditional — BOTH forms trap, because either form may claim the
    // subtask synchronously (`has_sync_waiter`, below) and a subtask in a set
    // is not the claimer's to take.
    trapIf(
      st.inWaitableSet(),
      "waitable cannot be used synchronously while added to a waitable set " +
        "(subtask.cancel)",
    );
    if (st.resolved()) {
      assert_(
        st.hasPendingEvent(),
        "resolved subtask without a pending event at cancellation",
      );
    } else {
      st.cancellationRequested = true;
      assert_(
        st.onCancel !== null,
        "subtask.cancel on a subtask with no cancellation handler",
      );
      // definitions.py `canon_subtask_cancel` sets `has_sync_waiter` BEFORE
      // `on_cancel()` and clears it once the claim ends — for BOTH forms, and
      // whether or not the call goes on to block. The window matters because
      // `on_cancel()` can run the cancelled callee synchronously, and that
      // callee may reenter this instance: the reentrant frame must see the
      // subtask as claimed and trap in `canon_waitable_join`
      // (`trap_if(w.has_sync_waiter)`). The JSPI determinacy park is part of
      // the emulated `on_cancel` delivery, so BOTH forms keep the claim until
      // produce/onSettled. Releasing it at async park entry lets another
      // thread steal the terminal event before `finish` consumes it.
      // CONTRACT: CanonicalABI.md:4308-4313 requires the claim for the full
      // duration in which `on_cancel` can run arbitrary/reentrant code.
      st.hasSyncWaiter = true;
      let parked = false;
      try {
        st.onCancel!(inst);

        // Cancellation may resume the callee on a later JSPI microtask.
        // Wait until all its threads finish or it genuinely parks in the
        // scheduler. Unlike async-start-call, resolution alone is NOT enough:
        // a resolved-but-mid-hop callee may still hold exclusiveThread and
        // affect the next cancellation's answer. Host-import subtasks have
        // no callee task and are immediately determinate, even if unresolved.
        //
        // The async determinacy park is the named non-atomicity divergence
        // (#92): other ready threads may run before this built-in returns.
        const callee = st.calleeTask as
          | { threads: { done(): boolean }[] }
          | null;
        const store = inst.store as unknown as {
          waiting: { task?: unknown }[];
        };
        const determinate = (): boolean =>
          callee === null ||
          callee.threads.every((th) => th.done()) ||
          store.waiting.some((w) => w.task === st.calleeTask);
        // The SYNC form additionally blocks until the callee actually
        // resolves (definitions.py `canon_subtask_cancel`:
        // `thread.wait_until(subtask.resolved)`), then reports the resolved
        // state through the same tail as the non-blocking path. The ASYNC
        // form answers BLOCKED once determinate and still unresolved.
        const ready = (): boolean => determinate() && (async_ || st.resolved());

        if (mode !== "jspi") {
          if (st.resolved()) return finish();
          if (!async_) {
            needsJspi(
              "synchronous subtask.cancel whose callee did not resolve " +
                "immediately (the calling wasm frame must block)",
            );
          }
          return BLOCKED;
        }
        if (!ready()) {
          parked = true;
          return blockCurrentActivation({
            store: inst.store,
            task: currentTask(),
            readyFunc: ready,
            cancellable: false,
            produce: () => {
              st.hasSyncWaiter = false;
              return st.resolved() ? finish() : BLOCKED;
            },
            onSettled: () => {
              st.hasSyncWaiter = false;
            },
          }) as unknown as number;
        }
        return st.resolved() ? finish() : BLOCKED;
      } finally {
        if (!parked) st.hasSyncWaiter = false;
      }
    }
    return finish();
  };
}

// ---------------------------------------------------------------------------
// thread.yield
// ---------------------------------------------------------------------------

/**
 * definitions.py `canon_thread_yield`.
 *
 * Yielding blocks the calling wasm frame until the scheduler comes back to
 * it. A callback-ABI guest expresses the same intent by returning the `YIELD`
 * callback code, which this runtime implements fully (exec/boundary.ts); the
 * *built-in* form needs a suspendable stack.
 */
export function createThreadYield(
  decl: { cancellable?: boolean },
  mode: SuspensionMode = "plain",
): CoreFn {
  const cancellable = decl.cancellable === true;
  return () => {
    const thread = currentThread<Thread>();
    trapIf(
      !thread.task.inst.mayLeave,
      "thread.yield: cannot leave component instance",
    );
    // A pending cancellation is deliverable without suspending at all
    // (definitions.py `Thread.yield_` -> `wait_until` -> `deliver_pending_cancel`).
    if (thread.task.deliverPendingCancel(cancellable)) return 1;
    if (mode === "jspi") {
      // definitions.py `Thread.yield_` is
      // `wait_until(lambda: True, cancellable)`: immediately ready, but it
      // goes through the scheduler, so other threads get a turn first. A
      // suspension point with an always-true `readyFunc` is exactly that --
      // `Store.tick` selects it under the configured scheduling policy.
      return blockCurrentActivation({
        store: thread.task.inst.store,
        task: thread.task,
        readyFunc: () => true,
        cancellable,
        produce: (cancelled: Cancelled) => (cancelled ? 1 : 0),
      }) as unknown as number;
    }
    needsJspi(
      "thread.yield (the calling wasm frame must block; a callback-ABI " +
        "guest should return the YIELD code instead)",
    );
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function requireWaitableSet(
  inst: ComponentInstanceState,
  si: number,
  what: string,
): WaitableSet {
  const wset = inst.handles.get(si);
  trapIf(
    !(wset instanceof WaitableSet),
    `${what}: handle ${si} is not a waitable set`,
  );
  return wset as WaitableSet;
}

/**
 * Shared type for both payload words so event delivery reuses cached layouts.
 */
const EVENT_PAYLOAD_TYPE: ValType = Object.freeze({ kind: "u32" });

/**
 * definitions.py `unpack_event`: store the two payload words at
 * `ptr` and return the event code.
 */
function unpackEvent(
  opts: ResolvedOptions,
  inst: ComponentInstanceState,
  ptr: number,
  e: EventTuple,
): number {
  const [event, p1, p2] = e;
  const cx = new LiftLowerContext(cabiOptions(opts), inst, null);
  storeValue(cx, p1, EVENT_PAYLOAD_TYPE, ptr);
  storeValue(cx, p2, EVENT_PAYLOAD_TYPE, ptr + 4);
  return event;
}

/** Unused-import guard. */
void trap;
