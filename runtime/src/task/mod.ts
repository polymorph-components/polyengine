// Component-instance and task state, following definitions.py `ComponentInstance`
// and `Task`. Scheduler policy and JSPI ordering live in ./scheduler.ts.

import { Table } from "../cabi/handles.ts";
import { COMPONENT_INSTANCE } from "../cabi/context.ts";
import type { ComponentInstanceLike } from "../cabi/context.ts";
import type { ComponentValue, FuncType } from "../cabi/types.ts";
import { assert_, trapIf } from "../cabi/trap.ts";
import {
  claimActivationAmbient,
  type CurrentThreadLike,
  dbgId,
  isSynchronousAmbient,
  maybeCurrentThread,
  physicalOwnerOf,
  popLogicalActivation,
  pushLogicalActivation,
  Store,
} from "./scheduler.ts";
import { Thread } from "./thread.ts";
import { Waitable, WaitableSet } from "./waitable.ts";
import { Subtask } from "./subtask.ts";

export * from "./scheduler.ts";
export * from "./thread.ts";
export * from "./waitable.ts";
export * from "./subtask.ts";
export * from "./streams.ts";

/** Anything a component instance's handle table can hold. */
export type HandleTableEntry = unknown;

/**
 * Per-instance state. FACT shares mayLeave through a mutable i32 global
 * containing a boolean, not a bitmask. Task admission uses backpressure and
 * exclusiveThread, not a general reentry lock. Poison refusal lives separately
 * in scheduler.ts. COMPONENT_INSTANCE lets cabi identify real instances
 * without importing the task layer.
 */
export class ComponentInstanceState implements ComponentInstanceLike {
  readonly index: number;
  readonly flags: WebAssembly.Global;
  handles: Table<HandleTableEntry> = new Table();
  /** definitions.py `ComponentInstance.threads` — a Table, so `thread.index`. */
  readonly threads: Table<Thread> = new Table();
  /** cabi's real-instance discriminator; see the class doc. */
  readonly [COMPONENT_INSTANCE] = true;
  /** definitions.py `backpressure: int` — a *counter* (backpressure.{inc,dec}). */
  backpressure = 0;
  /** definitions.py `num_waiting_to_enter`. */
  numWaitingToEnter = 0;
  /** definitions.py `exclusive_thread`. */
  exclusiveThread: Thread | null = null;
  readonly store: Store;
  /** Host-visible calls not yet terminally published. */
  readonly activeCalls: Set<{ fail(cause: unknown): boolean }> = new Set();

  constructor(index: number, store?: Store) {
    this.index = index;
    this.store = store ?? new Store();
    this.flags = new WebAssembly.Global({ value: "i32", mutable: true }, 1);
  }

  get mayLeave(): boolean {
    return (this.flags.value as number) !== 0;
  }

  set mayLeave(v: boolean) {
    this.flags.value = v ? 1 : 0;
  }
}

/** definitions.py `Task.State`. */
export type TaskState =
  | "initial"
  | "started"
  | "pending-cancel"
  | "cancel-delivered"
  | "resolved";

export type OnStart = () => ComponentValue[];
export type OnResolve = (result: ComponentValue[] | null) => void;

/**
 * Task execution flags and the lift-option identity checked by task.return.
 */
export interface TaskOptions {
  async_: boolean;
  callback: boolean;
  /**
   * The two fields definitions.py's `LiftOptions.equal` compares.
   * `canon_task_return` requires the options at the `task.return` site to
   * equal the ones the task was lifted with, so the task has to remember
   * them.
   */
  stringEncoding: string;
  memory: unknown | null;
}

/** definitions.py `LiftOptions.equal`: encoding + memory identity. */
export function liftOptionsEqual(
  a: { stringEncoding: string; memory: unknown | null },
  b: { stringEncoding: string; memory: unknown | null },
): boolean {
  return a.stringEncoding === b.stringEncoding && a.memory === b.memory;
}

const ADMIT_TRACE = (() => {
  try {
    return Deno.env.get("CE_SP_TRACE") === "1";
  } catch {
    return false;
  }
})();

/** One call and its threads (`Task` in definitions.py), also a cabi borrow
 * scope. Resolution delivers the result; remaining threads may keep running. */
export class Task {
  state: TaskState = "initial";
  /** TaskBorrowScope (cabi/context.ts): live borrows lowered into this task. */
  numBorrows = 0;

  implicitThread: Thread | null = null;
  readonly threads: Thread[] = [];
  /**
   * FACT tasks shuttle flat core values through onStart/onResolve; wasm
   * adapters perform the conversions. canon_task_return passes those values
   * through rather than applying the host-boundary result lift.
   */
  factPassthrough = false;
  /**
   * Whether ft.results is the declared FACT result type rather than an
   * empty placeholder. prepare-call's raw tuple index resolves through the
   * plan's task-return results/resultType mapping. Callees without such a
   * trampoline may lack a mapping; only known types may be compared.
   */
  factResultTypesKnown = false;
  /**
   * Host-call lifecycle hooks. `onControlReturn` is deliberately separate
   * from `onResolve`: definitions.py delivers canonical resolution inside
   * `Task.return_`, while public delivery is eligible only when the activation
   * that performed it has returned or genuinely blocked (CanonicalABI.md
   * 961-983). FACT tasks leave these unset.
   */
  onControlReturn: ((thread: Thread) => void) | null = null;
  onFailure: ((cause: unknown) => boolean) | null = null;
  /** Root call that receives autonomous failures from this task. */
  failureOwner: Task = this;
  /** Route an autonomous scheduler failure to this task's owning call. */
  fail(cause: unknown): boolean {
    if (this.onFailure === null) return false;
    return this.onFailure(cause);
  }

  /** A generator activation finished or reached a real scheduler park. */
  controlReturned(thread: Thread): void {
    this.onControlReturn?.(thread);
  }

  attachCall(): void {
    this.inst.activeCalls.add(this);
  }

  detachCall(): void {
    this.inst.activeCalls.delete(this);
  }

  constructor(
    public ft: FuncType,
    public opts: TaskOptions,
    public inst: ComponentInstanceState,
    public onStart: OnStart,
    public onResolve: OnResolve,
  ) {}

  /**
   * definitions.py `Task.needs_exclusive`: an async-typed task
   * needs the instance's exclusive thread unless it is a *stackful* async
   * lift. Sync canonical lifts (`not opts.async_`) and callback-ABI tasks both do.
   */
  needsExclusive(): boolean {
    assert_(this.ft.async === true, "needs_exclusive on a sync-typed task");
    return !this.opts.async_ || this.opts.callback;
  }

  /**
   * definitions.py `Task.enter_implicit_thread` — the backpressure
   * and exclusivity gate, in full.
   *
   * Returns false when the task was cancelled while waiting to enter, in
   * which case the caller must return immediately (the task is already
   * resolved by `cancel()`).
   */
  *enterImplicitThread(
    thread: Thread,
  ): Generator<import("./scheduler.ts").BlockRequest, boolean, unknown> {
    assert_(this.state === "initial", "enter_implicit_thread after start");
    this.implicitThread = thread;
    if (this.ft.async === true) {
      const hasBackpressure = (): boolean =>
        this.inst.backpressure > 0 ||
        (this.needsExclusive() && this.inst.exclusiveThread !== null);
      // The `num_waiting_to_enter > 0` disjunct is what makes entry a queue
      // rather than a stampede: once anyone is waiting, later arrivals wait
      // too, even if backpressure has since cleared.
      if (hasBackpressure() || this.inst.numWaitingToEnter > 0) {
        this.inst.numWaitingToEnter += 1;
        try {
          yield* thread.waitUntil(() => !hasBackpressure());
        } finally {
          this.inst.numWaitingToEnter -= 1;
        }
        if (this.deliverPendingCancel()) {
          this.cancel();
          return false;
        }
      }
      if (this.needsExclusive()) {
        assert_(
          this.inst.exclusiveThread === null,
          "entering with the exclusive thread already taken",
        );
        this.inst.exclusiveThread = thread;
      }
    }
    if (ADMIT_TRACE) {
      console.error(`[admit] task=${dbgId(this)} thread=${dbgId(thread)}`);
    }
    this.registerThread(thread);
    return true;
  }

  /** definitions.py `Task.register_thread`. */
  registerThread(thread: Thread): void {
    assert_(
      !this.threads.includes(thread) && thread.task === this,
      "register_thread of a foreign or duplicate thread",
    );
    this.threads.push(thread);
    assert_(thread.index === null, "register_thread of an indexed thread");
    thread.index = this.inst.threads.add(thread);
  }

  /** definitions.py `Task.exit_implicit_thread`. */
  exitImplicitThread(thread: Thread): void {
    assert_(thread === this.implicitThread, "exit of a non-implicit thread");
    this.unregisterThread(thread);
    if (this.ft.async === true && this.needsExclusive()) {
      // Callback waits release and retake the slot between invocations;
      // the final invocation must still own it when exiting.
      assert_(
        this.inst.exclusiveThread === thread,
        "exit_implicit_thread without holding the exclusive thread",
      );
      this.inst.exclusiveThread = null;
      this.inst.store.requestService();
    }
  }

  /** definitions.py `Task.unregister_thread`. */
  unregisterThread(thread: Thread): void {
    const i = this.threads.indexOf(thread);
    assert_(i !== -1 && thread.task === this, "unregister of a foreign thread");
    this.threads.splice(i, 1);
    if (this.threads.length === 0) {
      trapIf(
        this.state !== "resolved",
        "task finished all threads without resolving",
      );
      assert_(this.numBorrows === 0, "task exited with live borrows");
    }
    assert_(thread.index !== null, "unregister of an unindexed thread");
    this.inst.threads.remove(thread.index);
    thread.index = null;
  }

  /** Exceptional explicit-thread exit. Remove scheduler/table membership
   * without applying unregisterThread's successful last-thread resolution
   * check; the original escaping trap remains authoritative. */
  abortThread(thread: Thread): void {
    const i = this.threads.indexOf(thread);
    if (i !== -1) this.threads.splice(i, 1);
    if (thread.index !== null) {
      this.inst.threads.remove(thread.index);
      thread.index = null;
    }
    if (thread.waiting()) this.inst.store.stopWaiting(thread);
  }

  /**
   * definitions.py `Task.request_cancellation`. Cancellation is recorded as
   * pending; startup admission and the callback loop consume it explicitly.
   *
   * `caller` is retained for the call-site shape (fact_calls.ts's
   * `subtask.onCancel`) and for diagnostics; no condition here consults it
   * (live-instance reentry is allowed).
   */
  requestCancellation(caller: ComponentInstanceState | null): void {
    void caller;
    if (this.state === "initial") {
      // definitions.py:462-470 records cancellation before resuming startup;
      // builtin/thread cancellability no longer participates in selection.
      this.state = "pending-cancel";
      this.implicitThread!.resumeStartupCancellation();
      return;
    }
    assert_(
      this.state === "started",
      `request_cancellation in state ${this.state}`,
    );
    this.state = "pending-cancel";
  }

  /** definitions.py `Task.has_pending_cancel`. */
  hasPendingCancel(): boolean {
    return this.state === "pending-cancel";
  }

  /** definitions.py `Task.deliver_pending_cancel`. */
  deliverPendingCancel(): boolean {
    if (this.hasPendingCancel()) {
      this.state = "cancel-delivered";
      return true;
    }
    return false;
  }

  /** definitions.py `Task.start`. */
  start(): ComponentValue[] {
    assert_(this.state === "initial", "start on a started task");
    this.state = "started";
    return this.onStart();
  }

  /** definitions.py `Task.return_`: deliver the result before setting state.
   * Resolution does not unregister threads or release callback exclusivity. */
  return_(result: ComponentValue[]): void {
    trapIf(this.state === "resolved", "task.return on a resolved task");
    trapIf(
      this.numBorrows > 0,
      "borrow handles still remain at the end of the call",
    );
    this.onResolve(result);
    this.state = "resolved";
  }

  /** definitions.py `Task.cancel`. */
  cancel(): void {
    trapIf(
      this.state !== "cancel-delivered",
      "task.cancel without a delivered cancellation request",
    );
    // Same definitions.py check as `return_` (num_borrows at exit); same
    // call-end wording.
    trapIf(
      this.numBorrows > 0,
      "borrow handles still remain at the end of the call",
    );
    this.onResolve(null);
    this.state = "resolved";
  }
}

/**
 * A synchronous nested canonical call. The reference always creates a fresh
 * Task and Thread for `canon_lift`, including realloc and sync-to-sync FACT
 * calls (definitions.py:2128-2194, 642-658). The native implementation may
 * defer allocation, but still saves/zeros/restores both context slots
 * (wasmtime component_sync_call.rs:40-43,98-123,183-203).
 *
 * This is an actual Task/Thread identity, not a slots-only shim, so task-scoped
 * builtins reached by the callee resolve against the callee. The body itself is
 * driven by the already-running wasm stack; no second generator is needed.
 */
export class SynchronousActivation {
  readonly task: Task;
  readonly thread: Thread;
  readonly logicalActivation: CurrentThreadLike["logicalActivation"];
  readonly parent: CurrentThreadLike | undefined;

  constructor(
    readonly inst: ComponentInstanceState,
    asyncTyped: boolean,
    parent: CurrentThreadLike | undefined,
  ) {
    this.parent = parent;
    this.task = new Task(
      { params: [], results: [], async: asyncTyped },
      {
        async_: false,
        callback: false,
        stringEncoding: "utf8",
        memory: null,
      },
      inst,
      () => [],
      () => {},
    );
    // A logical FACT callee has no host-visible completion channel of its own.
    // Preserve the root call identity captured at entry so a later genuine
    // park can distinguish an already-published result from a live sync call.
    // See definitions.py:2186-2194 for the synchronous callee drive.
    this.task.failureOwner = (parent?.task?.failureOwner ?? parent?.task ??
      this.task) as Task;
    this.thread = new Thread(this.task, (function* () {})());
    this.thread.parent = parent;
    const physical = this.parent === undefined
      ? this.thread
      : physicalOwnerOf(this.parent) as Thread;
    this.thread.physicalOwner = physical;
    if (physical !== this.thread) {
      if (physical.logicalDescendants === undefined) {
        (physical as CurrentThreadLike & {
          logicalDescendants: Set<CurrentThreadLike>;
        }).logicalDescendants = new Set();
      }
      physical.logicalDescendants.add(this.thread);
    }
    this.task.implicitThread = this.thread;
    if (asyncTyped) {
      // A sync-ABI implementation of an async-typed function needs the
      // instance's exclusive slot (definitions.py Task.needs_exclusive and
      // enter_implicit_thread, lines 447-469). enter-sync-call is already the
      // admitted synchronous path; an occupied slot would have blocked before
      // this adapter invocation.
      assert_(
        inst.exclusiveThread === null,
        "synchronous activation entered with exclusive thread occupied",
      );
      inst.exclusiveThread = this.thread;
    }
    this.task.registerThread(this.thread);
    this.task.start();
    this.logicalActivation = {
      active: true,
      finish: () => this.finish(),
      abort: () => this.abort(),
    };
    this.thread.logicalActivation = this.logicalActivation;
    pushLogicalActivation(this.thread);
  }

  finish(): void {
    if (!this.logicalActivation!.active) return;
    trapIf(
      this.task.numBorrows > 0,
      "borrow handles still remain at the end of the call",
    );
    // FACT exits this task before translating results into the caller and
    // temporarily restores the saved callee context for post-return
    // (wasmtime fact/trampoline.rs:853-904). This bookkeeping task intentionally
    // has an empty host-visible result tuple: core result locals remain in the
    // adapter. Resolve through the canonical state transition rather than
    // mutating state as an unregister workaround.
    this.task.return_([]);
    this.task.unregisterThread(this.thread);
    if (this.task.ft.async) {
      assert_(
        this.inst.exclusiveThread === this.thread,
        "synchronous activation lost exclusive thread",
      );
      this.inst.exclusiveThread = null;
      this.inst.store.requestService();
    }
    this.logicalActivation!.active = false;
    this.thread.physicalOwner.logicalDescendants.delete(this.thread);
    popLogicalActivation(this.thread);
    if (this.parent && !isSynchronousAmbient(this.parent)) {
      // The nested wasm continuation has returned through exit-sync-call. Its
      // caller's continuation is now the executing canonical activation.
      claimActivationAmbient(this.parent);
    }
  }

  abort(): void {
    if (!this.logicalActivation!.active) return;
    // Trap/capability unwind does not complete the task, but the synthetic
    // thread must leave the instance table and ambient chain.
    // FACT traps can skip exit-sync-call. Release all lenders owned by the
    // abandoned nested activation before removing its task identity.
    try {
      // Cleanup is best-effort here: abort always runs while preserving an
      // already escaping trap/capability signal. Attempt every lender scope.
      while (this.thread.syncCallStack.length > 0) {
        const scope = this.thread.syncCallStack.pop() as {
          releaseLenders(): void;
        };
        try {
          scope.releaseLenders();
        } catch {
          // The original activation failure remains authoritative.
        }
      }
    } finally {
      const i = this.task.threads.indexOf(this.thread);
      if (i !== -1) this.task.threads.splice(i, 1);
      if (this.thread.index !== null) {
        this.inst.threads.remove(this.thread.index);
        this.thread.index = null;
      }
      if (this.inst.exclusiveThread === this.thread) {
        this.inst.exclusiveThread = null;
        this.inst.store.requestService();
      }
      this.inst.store.removePendingResumption(this.thread);
      this.logicalActivation!.active = false;
      this.thread.physicalOwner.logicalDescendants.delete(this.thread);
    }
  }
}

/** Run a host-invoked synchronous canonical helper (notably realloc). */
export function withSynchronousActivation<T>(
  inst: ComponentInstanceState,
  fn: () => T,
): T {
  // This helper enters immediately, so sampling its caller here cannot cross
  // an asynchronous admission boundary.
  const activation = new SynchronousActivation(
    inst,
    false,
    maybeCurrentThread(),
  );
  try {
    const result = fn();
    activation.finish();
    return result;
  } catch (e) {
    activation.abort();
    popLogicalActivation(activation.thread);
    throw e;
  }
}

/** Convenience re-exports so `../task/mod.ts` remains the single entry point. */
export { Store, Subtask, Thread, Waitable, WaitableSet };
