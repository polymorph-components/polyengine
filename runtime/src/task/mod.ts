// Component-instance and task state, following definitions.py `ComponentInstance`
// and `Task`. Scheduler policy and JSPI ordering live in ./scheduler.ts.

import { Table } from "../cabi/handles.ts";
import { COMPONENT_INSTANCE } from "../cabi/context.ts";
import type { ComponentInstanceLike } from "../cabi/context.ts";
import type { ComponentValue, FuncType } from "../cabi/types.ts";
import { assert_, trapIf } from "../cabi/trap.ts";
import {
  type Cancelled,
  CANCELLED_TRUE,
  chooseCandidate,
  dbgId,
  isInstancePoisoned,
  NeedsJspi,
  notifyInstancePoisoned,
  PendingCapability,
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
  ): Generator<import("./scheduler.ts").BlockRequest, boolean, Cancelled> {
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
        let cancelled: Cancelled;
        try {
          cancelled = yield* thread.waitUntil(() => !hasBackpressure(), true);
        } finally {
          this.inst.numWaitingToEnter -= 1;
        }
        if (cancelled) {
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

  /**
   * definitions.py `Task.request_cancellation`. Delivered to a
   * cancellable thread if one exists; otherwise recorded as pending, to be
   * picked up at the next cancellable block point (`deliverPendingCancel`).
   *
   * `caller` is retained for the call-site shape (fact_calls.ts's
   * `subtask.onCancel`) and for diagnostics; no condition here consults it
   * (live-instance reentry is allowed).
   */
  requestCancellation(caller: ComponentInstanceState | null): void {
    void caller;
    if (this.state === "initial") {
      this.state = "cancel-delivered";
      this.implicitThread!.resume(CANCELLED_TRUE);
      return;
    }
    assert_(
      this.state === "started",
      `request_cancellation in state ${this.state}`,
    );
    // Include JSPI SuspensionPoints: their owning generator waits on a
    // non-cancellable awaitValue, while the actual cancellable park is in
    // store.waiting. Resume delivers the flag to that point's produce callback.
    type Cancellable = {
      cancellable: boolean;
      resume(cancelled?: boolean): void;
    };
    let candidates: Cancellable[] = this.threads.filter((t) => t.cancellable);
    const excludeImplicit = !this.implicitThreadCancellable();
    if (excludeImplicit) {
      candidates = candidates.filter((t) => t !== this.implicitThread);
    }
    // The implicit thread's SuspensionPoints obey the same exclusivity test.
    if (!excludeImplicit) {
      const store = this.inst.store as unknown as {
        waiting: ({ task?: unknown } & Cancellable)[];
      };
      for (const w of store.waiting) {
        if (
          w.task === this && w.cancellable === true &&
          !candidates.includes(w)
        ) {
          candidates.push(w);
        }
      }
    }
    // Poisoned instances cannot run a cancellation recipient.
    if (candidates.length > 0 && !isInstancePoisoned(this.inst)) {
      this.state = "cancel-delivered";
      try {
        chooseCandidate(candidates).resume(CANCELLED_TRUE);
      } catch (e) {
        // Escaping delivery failures poison the recipient, except capability signals.
        if (!(e instanceof NeedsJspi) && !(e instanceof PendingCapability)) {
          notifyInstancePoisoned(
            this.inst as unknown as { handles: Iterable<unknown> },
            e,
          );
        }
        throw e;
      }
    } else {
      this.state = "pending-cancel";
    }
  }

  /**
   * Live exclusivity conjunct for cancellability. `canon_lift`'s callback
   * waits use lock_available; static park flags alone cannot represent a
   * sibling taking the slot. Both delivery selection and pending-cancel
   * readiness consult this predicate.
   */
  implicitThreadCancellable(): boolean {
    return !(this.ft.async === true && this.needsExclusive() &&
      this.inst.exclusiveThread !== null &&
      this.inst.exclusiveThread !== this.implicitThread);
  }

  /** definitions.py `Task.has_pending_cancel`. */
  hasPendingCancel(): boolean {
    return this.state === "pending-cancel";
  }

  /** definitions.py `Task.deliver_pending_cancel`. */
  deliverPendingCancel(cancellable: boolean): boolean {
    if (cancellable && this.hasPendingCancel()) {
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

/** Convenience re-exports so `../task/mod.ts` remains the single entry point. */
export { Store, Subtask, Thread, Waitable, WaitableSet };
