// The 0.3 task model (docs/architecture.md §6): `ComponentInstance`, `Task`, and the
// re-export surface of the task core. Thread, Waitable/WaitableSet, Subtask
// and the scheduler live in sibling modules; see ./scheduler.ts for the
// scheduling-policy rationale and the generator-based thread model.
//
// Structural correspondence to definitions.py is the design constraint here:
// where this file diverges, the divergence is called out in a comment with
// the reference's line number. The two systematic divergences are
//
//   1. threads are generators, not OS threads (./scheduler.ts header), and
//   2. the shared-everything-threads built-ins (`thread.suspend-then-resume`
//      and friends, 🧵) are absent rather than approximated — https://github.com/polymorph-components/polyengine/issues/12
//      defers that feature with memory64.

import { Table } from "../cabi/handles.ts";
import { COMPONENT_INSTANCE } from "../cabi/context.ts";
import type { ComponentInstanceLike } from "../cabi/context.ts";
import type { ComponentValue, FuncType } from "../cabi/types.ts";
import { assert_, trapIf } from "../cabi/trap.ts";
import {
  type Cancelled,
  CANCELLED_TRUE,
  chooseCandidate,
  isInstancePoisoned,
  Store,
  dbgId,
  NeedsJspi,
  notifyInstancePoisoned,
  PendingCapability,
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
 * Per-component-instance runtime state (definitions.py `ComponentInstance`,
 * line 191).
 *
 * `mayLeave` is backed by a real `WebAssembly.Global(i32, mutable)` because
 * FACT adapters import that global (`flags` namespace) and read/write it as
 * the may_leave boolean (wasmtime 47 FACT treats the whole flags global as
 * may_leave; there is no bitmask). Initial value 1 (true).
 *
 * There is no `may_enter` counterpart and no instance tree: at the pinned
 * reference (definitions.py @ 2f13265, CM#705) there is no `may_enter`,
 * `parent`, `entering_set`, `enter_from` or `leave_to`, so nothing gates
 * entry into a live instance. What polyengine adds beyond the reference is
 * per-instance POISONING — a named divergence
 * living entirely in ./scheduler.ts (`isInstancePoisoned`, `entryRefusal`),
 * not in any state on this class.
 *
 * `COMPONENT_INSTANCE` brands this class as a real component instance for
 * the layers that only see the structural `ComponentInstanceLike`
 * (cabi/handles.ts `isComponentInstance`; cabi must not import task/).
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

/** definitions.py `Task.State` (line 445). */
export type TaskState =
  | "initial"
  | "started"
  | "pending-cancel"
  | "cancel-delivered"
  | "resolved";

export type OnStart = () => ComponentValue[];
export type OnResolve = (result: ComponentValue[] | null) => void;

/**
 * Canonical options as the task model needs to see them (definitions.py
 * `Task.opts`): only the two flags that change task *semantics*.
 */
export interface TaskOptions {
  async_: boolean;
  callback: boolean;
  /**
   * The two fields definitions.py's `LiftOptions.equal` (line 643) compares.
   * `canon_task_return` requires the options at the `task.return` site to
   * equal the ones the task was lifted with, so the task has to remember
   * them.
   */
  stringEncoding: string;
  memory: unknown | null;
}

/** definitions.py `LiftOptions.equal` (line 643): encoding + memory identity. */
export function liftOptionsEqual(
  a: { stringEncoding: string; memory: unknown | null },
  b: { stringEncoding: string; memory: unknown | null },
): boolean {
  return a.stringEncoding === b.stringEncoding && a.memory === b.memory;
}

/**
 * One export activation (definitions.py `class Task`, line 444). Also the
 * task-side borrow scope: `numBorrows` satisfies cabi's `TaskBorrowScope`.
 */
const ADMIT_TRACE = (() => {
  try {
    return Deno.env.get("CE_SP_TRACE") === "1";
  } catch {
    return false;
  }
})();

export class Task {
  state: TaskState = "initial";
  /** TaskBorrowScope (cabi/context.ts): live borrows lowered into this task. */
  numBorrows = 0;
  implicitThread: Thread | null = null;
  readonly threads: Thread[] = [];
  /**
   * True for a task created by a FACT cross-component call
   * (`prepare-call`, see intrinsics/fact_calls.ts).
   *
   * Such a task's `onStart` / `onResolve` carry **flat core values**, not
   * lifted component values: FACT fuses the caller-side lift and callee-side
   * lower into a pair of adapter functions (`[async-start]` / `[async-return]`)
   * that run *in wasm*, so the host only shuttles the core values between
   * them. definitions.py has no analogue because it has no fused adapters —
   * there, `canon_lift` lowers the params and `canon_lower`'s `on_resolve`
   * lifts the results, both in the host. The observable semantics are
   * identical; only which side of the boundary performs the copy differs.
   *
   * `canon_task_return` consults this to decide whether to lift its flat
   * arguments (host-boundary task) or pass them straight through (FACT task).
   */
  factPassthrough = false;
  /**
   * Plan v3: does `ft.results` hold this FACT task's *declared* result type?
   *
   * A FACT callee task's result type arrives as the raw wasmtime
   * `TypeTupleIndex` `prepare-call` passes as `task_return_type`; v3's
   * `task-return.results` / `resultType` pair is the dictionary for it
   * (the task-return trampoline's raw `results` key + interned `resultType`;
   * contracts/plan-format.md schema). It resolves for every callee
   * that has a `task.return` trampoline of its own — which is every callee
   * that can call `task.return` — but a callee with none (sync-lifted,
   * reached through an async-to-sync adapter) contributes no entry, and then
   * `ft.results` is the empty placeholder it was before v3. Only when this is
   * true may `canon_task_return` compare against it.
   */
  factResultTypesKnown = false;
  /**
   * In-flight FACT sync-call brackets for THIS task
   * (`enter-sync-call`/`exit-sync-call`).
   *
   * MOVED to `Thread` (see `Thread.syncCallStack`). Per-task was already an
   * improvement on per-executor, but it is still not the right unit: a task
   * can own several threads, so one activation's `exit-sync-call` could pop a
   * sibling activation's scope. Tracing big-interleaving showed exactly that
   * -- tasks whose `enter` count exceeded their `exit` count by one, and other
   * tasks taking an `exit` at depth 0, with the `ctx` fallback never firing.
   *
   * The bracket belongs to the ACTIVATION that opened it: FACT emits the
   * matching `enter-sync-call` and `exit-sync-call` from the same wasm
   * activation by construction, so riding the activation identity makes the
   * exit find the same stack the enter used no matter which task the scheduler
   * considers current in between (the 3i bracket-spans-suspension ruling).
   */

  constructor(
    public ft: FuncType,
    public opts: TaskOptions,
    public inst: ComponentInstanceState,
    public onStart: OnStart,
    public onResolve: OnResolve,
  ) {}

  /**
   * definitions.py `Task.needs_exclusive` (line 473): an async-typed task
   * needs the instance's exclusive thread unless it is a *stackful* async
   * lift. Sync-lowered (`not opts.async_`) and callback-ABI tasks both do.
   */
  needsExclusive(): boolean {
    assert_(this.ft.async === true, "needs_exclusive on a sync-typed task");
    return !this.opts.async_ || this.opts.callback;
  }

  /**
   * definitions.py `Task.enter_implicit_thread` (line 477) — the backpressure
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

  /** definitions.py `Task.register_thread` (line 497). */
  registerThread(thread: Thread): void {
    assert_(
      !this.threads.includes(thread) && thread.task === this,
      "register_thread of a foreign or duplicate thread",
    );
    this.threads.push(thread);
    assert_(thread.index === null, "register_thread of an indexed thread");
    thread.index = this.inst.threads.add(thread);
  }

  /** definitions.py `Task.exit_implicit_thread` (line 503). */
  exitImplicitThread(thread: Thread): void {
    assert_(thread === this.implicitThread, "exit of a non-implicit thread");
    this.unregisterThread(thread);
    if (this.ft.async === true && this.needsExclusive()) {
      // definitions.py lines 506-508, verbatim shape: assert-held, then
      // release. The former release-if-held tolerance existed only for the
      // removed release-at-BLOCK divergence (issue #43); under the hold rule
      // the implicit thread of a needs-exclusive task holds the slot from
      // `enter_implicit_thread` to here, without exception.
      assert_(
        this.inst.exclusiveThread === thread,
        "exit_implicit_thread without holding the exclusive thread",
      );
      this.inst.exclusiveThread = null;
    }
  }

  /** definitions.py `Task.unregister_thread` (line 510). */
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
   * definitions.py `Task.request_cancellation` (@ 2f13265). Delivered to a
   * cancellable thread if one exists; otherwise recorded as pending, to be
   * picked up at the next cancellable block point (`deliverPendingCancel`).
   *
   * `caller` is retained for the call-site shape (fact_calls.ts's
   * `subtask.onCancel`) and for diagnostics; no condition here consults it
   * (CM#705: entry into a live instance is ungated).
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
    // Candidates are CANCELLABLE BLOCK POINTS of this task. The reference
    // only ever finds them among `self.threads`, because its threads block
    // *in place* (`wait_until` marks the thread itself cancellable). Under
    // jspi the same block point is a `SuspensionPoint` parked in
    // `store.waiting` — the wasm frame is suspended mid-built-in and the
    // Thread that owns the activation sits non-cancellably on its
    // `awaitValue` — so a scan of `threads` alone finds nothing and a
    // cancellation the reference delivers synchronously was silently
    // deferred to `pending-cancel` (cancellable.wast:322, test 1: a
    // cancellable `waitable-set.wait` must observe TASK_CANCELLED).
    // A resumed SuspensionPoint hands `cancelled` to its `produce`, which
    // every cancellable built-in already translates (TASK_CANCELLED for
    // waits, 1 for thread.yield), so delivery works unchanged once the
    // point is simply *found*.
    type Cancellable = {
      cancellable: boolean;
      resume(cancelled?: boolean): void;
    };
    let candidates: Cancellable[] = this.threads.filter((t) => t.cancellable);
    const excludeImplicit = this.ft.async === true && this.needsExclusive() &&
      this.inst.exclusiveThread !== null &&
      this.inst.exclusiveThread !== this.implicitThread;
    if (excludeImplicit) {
      candidates = candidates.filter((t) => t !== this.implicitThread);
    }
    // Suspension points of this task's activation are frames OF the implicit
    // thread, so they obey the same exclusion (definitions.py line 526: with
    // another thread holding the exclusive slot, the implicit thread may not
    // run).
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
    // Merged reference (definitions.py @ 2f13265): `if candidates: deliver`,
    // full stop — no enterability condition, no bracket (CM#705).
    //
    // ONE divergence conjunct survives: a POISONED instance is a corpse whose
    // threads never resume, so the request parks as pending-cancel forever —
    // which is the honest state, since a corpse can never reach a cancellable
    // suspension to deliver at. The reference never faces this because a trap
    // there kills the whole store. The marker is the authoritative input.
    if (candidates.length > 0 && !isInstancePoisoned(this.inst)) {
      this.state = "cancel-delivered";
      try {
        chooseCandidate(candidates).resume(CANCELLED_TRUE);
      } catch (e) {
        // A trap escaping the delivery poisons the callee instance
        // (polyengine#164/#212) — polyengine's per-instance corpse divergence;
        // the reference wraps this `resume(Cancelled.TRUE)` in no handler at
        // all and simply ends the world.
        //
        // Capability signals are the exception, exactly as in `tick`: they
        // mark this RUNTIME incomplete, not the component faulted, and in the
        // reference the blocking operation they stand in for completes
        // normally.
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

  /** definitions.py `Task.deliver_pending_cancel` (line 536). */
  deliverPendingCancel(cancellable: boolean): boolean {
    if (cancellable && this.state === "pending-cancel") {
      this.state = "cancel-delivered";
      return true;
    }
    return false;
  }

  /** definitions.py `Task.start` (line 542). */
  start(): ComponentValue[] {
    assert_(this.state === "initial", "start on a started task");
    this.state = "started";
    return this.onStart();
  }

  /** definitions.py `Task.return_` (line 547). */
  return_(result: ComponentValue[]): void {
    trapIf(this.state === "resolved", "task.return on a resolved task");
    // Wording parity with wasmtime's exit-time check, pinned by
    // drop-cross-task-borrow.wast:309.
    trapIf(
      this.numBorrows > 0,
      "borrow handles still remain at the end of the call",
    );
    this.onResolve(result);
    this.state = "resolved";
  }

  /** definitions.py `Task.cancel` (line 554). */
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
