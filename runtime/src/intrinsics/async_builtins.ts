// The 0.3 async canonical built-ins, as host trampolines
// (contracts/intrinsics.md §B): task.{return,cancel},
// backpressure.{set,inc,dec}, waitable-set.{new,wait,poll,drop},
// waitable.join, subtask.{drop,cancel} and thread.yield.
//
// Every one is a direct port of the correspondingly named `canon_*` function
// in definitions.py (cited per function), with one systematic substitution.
//
// ## `current_instance()` vs the trampoline's declared instance
//
// definitions.py reads `current_instance()` (line 312), defined as
// `current_task().inst` — it can, because in the reference a canonical
// built-in is only ever reached from inside a task. That is not true of a
// real component: wasmtime lets a core module's **start function** call
// instance-scoped built-ins (`waitable-set.new`, `backpressure.inc`, ...)
// during instantiation, before any task exists. The official suite exercises
// exactly this (e.g. `test/async/dont-block-start.wast`).
//
// wasmtime resolves it by naming the owning component instance *statically*
// in every trampoline declaration (`Trampoline::WaitableSetNew { instance }`
// and friends — the `instance` field the plan carries). So the built-ins
// below take their instance from the declaration, which is well-defined at
// instantiation time and identical to `current_instance()` whenever a task is
// running. Built-ins that genuinely need the *task* or *thread*
// (`task.return`, `task.cancel`, `subtask.cancel`, `thread.yield`) still read
// the current-thread stack: they are meaningless outside a task, and the
// reference's `trap_if`s are what report that.
//
// ## Blocking built-ins in a stackless world
//
// `waitable-set.wait`, `thread.yield` and the synchronous `subtask.cancel`
// all *block the calling wasm frame* in the reference. A callback-ABI guest
// is stackless: there is no suspendable wasm stack to park, so blocking here
// genuinely requires JSPI (docs/architecture.md §6, JSPI role 2) and these built-ins say
// so at the precise point, loudly, instead of faking a wait.
//
// They are not, however, unconditionally unavailable. Where the reference can
// complete *without* suspending — `waitable-set.wait` on a set that already
// has a pending event, `waitable-set.poll` always, `subtask.cancel` on a
// subtask that resolved eagerly — this module returns the answer directly.
// That is not a shortcut: definitions.py's `Thread.wait_until` (line 396) may
// legitimately return without blocking when `ready_func()` already holds, so
// taking that branch is a conforming schedule.

import { blockCurrentActivation } from "../jspi/mod.ts";
import type { SuspensionMode } from "../jspi/mod.ts";
import type { Cancelled } from "../task/mod.ts";
import { assert_, trap, trapIf } from "../cabi/trap.ts";
import {
  CoreValueIter,
  LiftLowerContext,
  liftFlatValues,
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
  SubtaskState,
  type Task,
  Thread,
  Waitable,
  WaitableSet,
} from "../task/mod.ts";
import type { ComponentInstanceState } from "../task/mod.ts";
import type { CoreFn, ResolvedOptions } from "../exec/boundary.ts";
import { cabiOptions, normalizeCoreValues } from "../exec/boundary.ts";
import { traceCopy } from "./stream_builtins.ts";

/** Services these built-ins need from the executor. */
export interface AsyncTrampolineContext {
  componentInstance(index: number): ComponentInstanceState;
  /** Resolved canonical options by `canonicalOptions` index. */
  options(index: number): ResolvedOptions;
  /** The element types of an interned results *tuple* (`task-return`). */
  resultTypes(index: number): ValType[];
}

/**
 * `BLOCKED` sentinel of `canon_subtask_cancel` (definitions.py line 2467).
 */
export const BLOCKED = 0xffff_ffff;

// ---------------------------------------------------------------------------
// task.return / task.cancel
// ---------------------------------------------------------------------------

/** definitions.py `canon_task_return` (line 2384). */
export function createTaskReturn(
  decl: { results: number; resultType: number | null; options: number },
  ctx: AsyncTrampolineContext,
): CoreFn {
  const opts = ctx.options(decl.options);
  // plan v3: `resultType` is the interned `plan.types` entry; `results` is the
  // raw wasmtime `TypeTupleIndex` (the FACT `task_return_type` key, consumed
  // by the loader's dictionary). `null` is wire-legal for a task with no
  // declared result type; today's producer always emits the empty tuple
  // instead, so this degenerates to `[]` either way.
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
    // `trap_if(result_type != task.ft.result)` (definitions.py:2388): the
    // trampoline's interned result tuple must be the lifted function's result
    // type. Compared structurally — the plan's type table interns by
    // structure, so identity comparison would reject valid components.
    //
    // Plan v3 enables this for FACT cross-component tasks too: the callee
    // task's declared result type is now resolvable from the raw
    // `TypeTupleIndex` `prepare-call` carried (the task-return trampoline's
    // raw `results` key + interned `resultType`, contracts/plan-format.md
    // schema; wired in fact_calls.ts). It remains skipped for the one
    // case v3 does not answer — a callee the plan maps no `task.return`
    // tuple for, where `ft.results` is a placeholder rather than a
    // declaration (`factResultTypesKnown === false`); comparing against a
    // placeholder would be a false rejection, not a check.
    trapIf(
      (!task.factPassthrough || task.factResultTypesKnown) &&
        !valTypesEqual(resultTypes, task.ft.results),
      "task.return with a result type that is not the task's result type",
    );
    // `trap_if(not LiftOptions.equal(opts, task.opts))` (definitions.py:2389).
    // The MEMORY half stays skipped for FACT tasks, and plan v3 does NOT
    // change that: the relaxation was never about the type mapping. The
    // task's memory is reconstructed from `prepare-call`'s `memory` field,
    // which is the *adapter's* view of the lift options
    // (`adapter.lift.options...memory`) and is `None` for callees whose own
    // `task.return` options do name a memory — the 17-param async-lifted
    // callees of `test/async/cross-abi-calls.wast` are exactly that shape.
    // The information simply is not in the plan, at v3 as at v2; restoring
    // the check needs `prepare-call`'s indices related to the callee's
    // canonical options, which remains open contract friction.
    //
    // definitions.py `LiftOptions.equal` (line 643) compares string encoding
    // *and* memory identity. Both halves are checked for a host-boundary task.
    //
    // For a FACT task the memory half is skipped, and the reason is specific
    // rather than "we can't be bothered": the task's memory is reconstructed
    // from `prepare-call`'s `memory` field, which carries the *adapter's* view
    // of the lift options (`adapter.lift.options...memory`) and is `None`
    // for callees whose own `task.return` options do name a memory —
    // `test/async/cross-abi-calls.wast`'s 17-param async-lifted callees are
    // exactly that shape. wasmtime tolerates the mismatch because its check is
    // *one-sided*: `concurrent.rs:3344-3358` treats "the `task.return` site
    // specifies no memory" as valid and only compares when it does, against a
    // lift memory it holds first-hand. We hold ours second-hand, so applying
    // either form of the memory comparison produces a false rejection.
    //
    // The string-encoding half IS checked on both paths: `prepare-call` passes
    // the encoding directly, so that reconstruction is exact.
    trapIf(
      !liftOptionsEqual(
        { stringEncoding: opts.stringEncoding, memory: opts.memory },
        task.factPassthrough
          ? { stringEncoding: task.opts.stringEncoding, memory: opts.memory }
          : task.opts,
      ),
      "task.return with canonical options differing from the task's",
    );
    // Type-aware per-lane normalization: `normalizeFlat`'s blanket `>>> 0`
    // silently truncated float lanes (a `task.return` of f64 -1.1 arrived at
    // `[async-return]` as 4294967295). `normalizeCoreValues` consults the
    // declared lane types, so only i32 lanes are coerced.
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

/** definitions.py `canon_task_cancel` (line 2397). */
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

// `canon_backpressure_set` is not ported: wasmtime 47 emits no
// `BackpressureSet` trampoline (`component/info.rs` has only
// `BackpressureInc`/`BackpressureDec`), and the reference's own copy was
// unreachable dead code until upstream removed it (CM PR #690; see
// upstream-component-model-repo-findings.md CM-2, RESOLVED). The counter
// below is the live interface.

/** definitions.py `canon_backpressure_inc` (line 2368). */
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

/** definitions.py `canon_backpressure_dec` (line 2375). */
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

/** definitions.py `canon_waitable_set_new` (line 2406). */
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
 * definitions.py `canon_waitable_set_wait` (line 2414).
 *
 * The reference blocks the calling thread until the set has an event. From a
 * stackless (callback-ABI) guest there is no wasm stack to suspend, so this
 * only succeeds when an event is *already* pending — which is the reference's
 * own non-blocking branch of `Thread.wait_until`. Otherwise: `needsJspi`.
 *
 * A guest using the callback ABI is expected to return the `WAIT` callback
 * code rather than call this built-in; hitting the JSPI path here means the
 * component uses the stackful async ABI.
 */
export function createWaitableSetWait(
  decl: { options: number },
  ctx: AsyncTrampolineContext,
  inst: ComponentInstanceState,
  mode: SuspensionMode = "plain",
): CoreFn {
  const opts = ctx.options(decl.options);
  // `cancellable` is a *canonical option*, not a trampoline field: wasmtime's
  // `Trampoline::WaitableSetWait` carries only `{instance, options}`
  // (wasmtime-environ 47.0.3 `component/info.rs:815`), while
  // `CanonicalOptions.cancellable` (info.rs:540) is what the guest declared.
  // It reaches definitions.py as `canon_waitable_set_wait`'s first parameter
  // (line 2414).
  const cancellable = opts.cancellable;
  return (si?: number, ptr?: number) => {
    trapIf(!inst.mayLeave, "waitable-set.wait: cannot leave component instance");
    const wset = requireWaitableSet(inst, si ?? 0, "waitable-set.wait");
    const task = currentTask() as Task;
    let event: EventTuple;
    if (task.deliverPendingCancel(cancellable)) {
      event = [EventCode.TASK_CANCELLED, 0, 0];
    } else if (wset.hasPendingEvent()) {
      // Non-blocking branch: definitions.py `Thread.wait_until` may return
      // immediately when the condition already holds.
      //
      // This deliberately skips `wait_for_event_and`, and with it the
      // `num_waiting += 1 / -= 1` bracket around the block
      // (`WaitableSet.wait_for_event_and`, line 829). That is unobservable:
      // `num_waiting` is read only by `WaitableSet.drop`
      // (`trap_if(self.num_waiting > 0)`, line 852), and since we never yield
      // between the increment and the decrement here, no other code could run
      // to observe a non-zero value. Incrementing and immediately decrementing
      // would be pure ceremony.
      traceCopy(`waitable-set.wait si=${si} FAST (pending event)`);
      event = wset.getPendingEvent();
    } else if (mode === "jspi") {
      traceCopy(`waitable-set.wait si=${si} BLOCKS`);
      // SITE 2 (lit). definitions.py `WaitableSet.wait_for_event_and`
      // (line 829): block until the set has an event, then take it.
      //
      // The `num_waiting` bracket is real now. Skipping it was justified only
      // while this path could not actually yield; a genuine block CAN be
      // observed, because `WaitableSet.drop` traps on `num_waiting > 0`
      // (line 852). Incremented before blocking and decremented in
      // `onSettled`, which runs exactly once on EVERY terminal transition —
      // normal resume, cancelled resume, produce-throw, and `abandon`
      // (#106: decrementing in `produce` missed the abandon leg, leaving
      // `numWaiting` elevated forever and a later `waitable-set.drop`
      // trapping spuriously). The decrement is not idempotent, so it lives
      // ONLY here, not in `produce` as well; nothing can observe the still-
      // elevated count between `produce` and the hook — both run
      // synchronously inside the settle, before any other code.
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
          return unpackEvent(opts, inst, ptr ?? 0, ev);
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
    return unpackEvent(opts, inst, ptr ?? 0, event);
  };
}

/** definitions.py `canon_waitable_set_poll` (line 2431). */
export function createWaitableSetPoll(
  decl: { options: number },
  ctx: AsyncTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const opts = ctx.options(decl.options);
  /** See `createWaitableSetWait`: `cancellable` is an option, not a decl field. */
  const cancellable = opts.cancellable;
  return (si?: number, ptr?: number) => {
    trapIf(!inst.mayLeave, "waitable-set.poll: cannot leave component instance");
    const wset = requireWaitableSet(inst, si ?? 0, "waitable-set.poll");
    const event = wset.poll(currentTask(), cancellable);
    return unpackEvent(opts, inst, ptr ?? 0, event);
  };
}

/** definitions.py `canon_waitable_set_drop` (line 2441). */
export function createWaitableSetDrop(inst: ComponentInstanceState): CoreFn {
  return (i?: number) => {
    trapIf(!inst.mayLeave, "waitable-set.drop: cannot leave component instance");
    const wset = inst.handles.remove(i ?? 0);
    trapIf(
      !(wset instanceof WaitableSet),
      "waitable-set.drop: handle is not a waitable set",
    );
    (wset as WaitableSet).drop();
  };
}

/** definitions.py `canon_waitable_join` (line 2451). */
export function createWaitableJoin(inst: ComponentInstanceState): CoreFn {
  return (wi?: number, si?: number) => {
    trapIf(!inst.mayLeave, "waitable.join: cannot leave component instance");
    const w = inst.handles.get(wi ?? 0);
    trapIf(!(w instanceof Waitable), "waitable.join: handle is not a waitable");
    trapIf(
      (w as Waitable).hasSyncWaiter,
      // Wording per the suite's assertions
      // (test/async/trap-if-sync-and-waitable-set.wast:301-307,
      // test/async/reentrance.wast:837): a waitable claimed synchronously and
      // a waitable in a set are the two halves of one rule, spelled the same.
      "waitable cannot be used synchronously while added to a waitable set " +
        "(waitable.join)",
    );
    if ((si ?? 0) === 0) {
      (w as Waitable).join(null);
      return;
    }
    const wset = requireWaitableSet(inst, si!, "waitable.join");
    (w as Waitable).join(wset);
  };
}

// ---------------------------------------------------------------------------
// subtasks
// ---------------------------------------------------------------------------

/** definitions.py `canon_subtask_drop` (line 2494). */
export function createSubtaskDrop(inst: ComponentInstanceState): CoreFn {
  return (i?: number) => {
    trapIf(!inst.mayLeave, "subtask.drop: cannot leave component instance");
    const s = inst.handles.remove(i ?? 0);
    trapIf(!(s instanceof Subtask), "subtask.drop: handle is not a subtask");
    (s as Subtask).drop();
  };
}

/**
 * definitions.py `canon_subtask_cancel` (line 2469).
 *
 * The synchronous form blocks (`subtask.wait_for_pending_event()`) when the
 * callee does not resolve promptly; from a stackless guest that is JSPI
 * territory. The async form returns `BLOCKED` instead of blocking, and is
 * fully supported.
 */
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

export function createSubtaskCancel(
  decl: { async?: boolean },
  inst: ComponentInstanceState,
  mode: SuspensionMode = "plain",
): CoreFn {
  const async_ = decl.async === true;
  return (i?: number) => {
    // The handle table is the **declared** instance's, not
    // `current_thread().task.inst`. definitions.py `canon_subtask_cancel`
    // (line 2469) uses the latter because the reference has no fused
    // adapters, so the running task and the subtask's owner always coincide.
    // With FACT they do not: `async-start-call` adds the subtask to
    // `prepare-call`'s `caller_instance`, which for a nested component is a
    // *different* instance from the one whose task is running — observed as
    // caller=2 vs task.inst=3 in `big-interleaving-test.wast:1584`, where the
    // lookup then failed with "table index out of range". wasmtime names the
    // owner on the trampoline for exactly this reason
    // (`Trampoline::SubtaskCancel { instance, .. }`), which is the same
    // correction already applied to every other instance-scoped built-in —
    // see this module's header.
    trapIf(!inst.mayLeave, "subtask.cancel: cannot leave component instance");
    const subtask = inst.handles.get(i ?? 0);
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
    // is not the claimer's to take. Corroborated by
    // test/async/trap-if-sync-and-waitable-set.wast:325-327, which asserts the
    // trap for `subtask-cancel-sync-when-in-set` AND
    // `subtask-cancel-async-when-in-set`, with the wording used here.
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
      // (`trap_if(w.has_sync_waiter)`) — test/async/reentrance.wast:837.
      // `parked` hands the clear over to the park's `produce`/`onSettled`
      // (#106: `abandon` never runs `produce`, so the flag needs the
      // `onSettled` backstop or it stays set forever and a later
      // `waitable.join` traps spuriously).
      st.hasSyncWaiter = true;
      let parked = false;
      try {
        st.onCancel!(inst);

        // Is the callee's state safe to READ yet? Under jspi it may not be.
        // `request_cancellation` delivers TASK_CANCELLED by settling the
        // callee's suspension, and the engine runs the resumed activation on
        // a LATER microtask (pin (j)); the reference has no such hop —
        // `Task.request_cancellation` -> `Thread.resume` runs the resumed
        // thread to its next block point or exit synchronously, so when
        // `on_cancel()` returns the callee is never mid-hop.
        //
        // DETERMINATE = every callee thread finished, or the callee is parked
        // on a scheduler condition — exactly `async-start-call`'s rule
        // (fact_calls.ts). Deliberately NOT "or `st.resolved()`":
        // resolved-but-mid-hop is precisely the stale state this park exists
        // to avoid. A callee whose callback already ran `task.cancel` and
        // returned EXIT is resolved while its `Thread` is still parked on
        // `awaitValue` holding `inst.exclusiveThread`; answering from here
        // then makes the NEXT `subtask.cancel` see the instance excluded and
        // report BLOCKED, and the guest's `subtask.drop` traps "not yet
        // resolved" (test/async/reentrance.wast:517).
        //
        // A callee with a pending (undeliverable) cancel sits parked
        // non-cancellably, which is determinate, so the genuine BLOCKED
        // answer is still immediate. Host-import subtasks carry no callee
        // task and cannot be mid-hop: the default onCancel resolves them
        // before this point, and a `deferCancel` import's no-op onCancel
        // leaves them simply unresolved — either way the answer is immediate.
        //
        // NAMED DIVERGENCE (docs/architecture.md §6, #92): this park makes
        // the async built-in non-atomic — other ready threads may run while
        // it waits, a reordering within the reference's Store.tick freedom
        // taken one built-in early.
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
        // state through the same tail as the non-blocking path — SITE 5
        // (lit), mirroring SITE 4 (stream_builtins.ts) and
        // `Waitable.waitForPendingEvent`. The ASYNC form answers BLOCKED as
        // soon as the callee is determinate and still unresolved.
        const ready = (): boolean =>
          determinate() && (async_ || st.hasPendingEvent());

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
 * definitions.py `canon_thread_yield` (line 2728).
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
      // SITE 3 (lit). definitions.py `Thread.yield_` is
      // `wait_until(lambda: True, cancellable)`: immediately ready, but it
      // goes through the scheduler, so other threads get a turn first. A
      // suspension point with an always-true `readyFunc` is exactly that --
      // `Store.tick` will resume it, after whatever else is already ready.
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
 * The two event payload words. Hoisted out of `unpackEvent` because
 * cabi/layout.ts and cabi/types.ts memoize on `ValType` identity (issue
 * #261): a fresh literal per call is a guaranteed cache miss plus a
 * `WeakMap.set` on immediate garbage, twice per event delivered.
 */
const EVENT_PAYLOAD_TYPE: ValType = Object.freeze({ kind: "u32" });

/**
 * definitions.py `unpack_event` (line 2422): store the two payload words at
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

// Structural `ValType` equality (the circular-structure bugfix) moved to cabi/types.ts
// (`valTypesEqual`) when the #18 tls smoke found its stream-element sibling;
// the contract note lives there now.

/** Unused-import guard: `trap` is re-exported for symmetry with cabi. */
void trap;
