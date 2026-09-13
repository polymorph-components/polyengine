// definitions.py `Thread`, implemented over JS generators.
//
// Mapping to the reference, state for state:
//
//   reference                    here
//   ------------------------------------------------------------------
//   cont is None (running)       #state === "running"
//   cont set, ready_func None    #state === "suspended"
//   cont set, ready_func set     #state === "waiting"  (in store.waiting)
//   thread.storage[2]            storage: [0, 0]   (context.{get,set})
//   thread.index                 index (inst.threads table slot)
//
// Shared-everything thread switching is not implemented (#12); resume drives
// one generator, while JSPI suspension is represented by the bridge.

import { assert_ } from "../cabi/trap.ts";
import {
  type BlockRequest,
  type Cancelled,
  CANCELLED_FALSE,
  CANCELLED_TRUE,
  isInstancePoisoned,
  NeedsJspi,
  notifyInstancePoisoned,
  PendingCapability,
  popCurrentThread,
  pushCurrentThread,
  type SchedulableThread,
  type Store,
  type ThreadBody,
} from "./scheduler.ts";

type ThreadState = "running" | "suspended" | "waiting" | "done";

export class Thread implements SchedulableThread {
  /**
   * Per-thread slots for `canon_context_get` / `canon_context_set`, not
   * task-shared state. Number storage is for the supported i32 context;
   * full-width i64 context would need a different representation.
   */
  readonly storage: number[] = [0, 0];

  /**
   * FACT brackets belong to the activation that emitted enter-sync-call and
   * exit-sync-call. A task can own several threads, so this is not task-shared.
   */
  // deno-lint-ignore no-explicit-any
  readonly syncCallStack: any[] = [];

  /** Slot in `inst.threads`, assigned by `Task.registerThread`. */
  index: number | null = null;

  /**
   * Cancellability of the current park, cleared on resume. Callback lock
   * availability is checked separately by `Task.implicitThreadCancellable`.
   */
  cancellable = false;

  #state: ThreadState = "suspended";
  #body: ThreadBody;
  #readyFunc: (() => boolean) | null = null;
  #store: Store;

  // deno-lint-ignore no-explicit-any
  constructor(public task: any, body: ThreadBody) {
    this.#body = body;
    this.#store = task.inst.store;
  }

  running(): boolean {
    return this.#state === "running";
  }

  suspended(): boolean {
    return this.#state === "suspended";
  }

  waiting(): boolean {
    return this.#state === "waiting";
  }

  done(): boolean {
    return this.#state === "done";
  }

  /** definitions.py `Thread.ready`. */
  ready(): boolean {
    return this.waiting() && this.#readyFunc !== null && this.#readyFunc();
  }

  /** definitions.py `Thread.start_waiting_internal`. */
  #startWaiting(readyFunc: () => boolean): void {
    assert_(!this.waiting() && this.#readyFunc === null);
    this.#readyFunc = readyFunc;
    this.#state = "waiting";
    this.#store.startWaiting(this);
  }

  /** definitions.py `Thread.stop_waiting_internal`. */
  #stopWaiting(cancelled: Cancelled): void {
    assert_(this.waiting() && this.#readyFunc !== null);
    assert_(
      cancelled || this.ready(),
      "stopWaiting on a thread that is neither ready nor cancelled",
    );
    this.#readyFunc = null;
    this.#state = "suspended";
    this.#store.stopWaiting(this);
  }

  /** definitions.py `Thread.resume_later`. */
  resumeLater(): void {
    assert_(this.suspended(), "resume_later on a non-suspended thread");
    this.#startWaiting(() => true);
  }

  /** Pending `awaitValue` promise, if this thread is parked on one. */
  awaiting: Promise<unknown> | null = null;

  /** Resume a promise-parked thread with the settled result. */
  resumeWith(value: unknown, failure?: { error: unknown }): void {
    assert_(
      this.awaiting !== null,
      "resumeWith on a thread that is not awaiting",
    );
    this.awaiting = null;
    this.#store.awaiting.delete(this);
    this.#state = "suspended";
    // Remove awaiting membership before running code that can re-park, so
    // overlapping drivers cannot consume this settlement twice.
    const inst = this.task.inst;
    // Retire late tails of poisoned instances without executing their bodies.
    if (isInstancePoisoned(inst)) return;
    try {
      this.#resumeInternal(value, failure);
    } catch (e) {
      if (!(e instanceof NeedsJspi) && !(e instanceof PendingCapability)) {
        // Rejected JSPI activations poison just like synchronous failures.
        notifyInstancePoisoned(
          inst as unknown as { handles: Iterable<unknown> },
          e,
        );
      }
      throw e;
    }
  }

  /** `Thread.resume`: run until the next block or completion. */
  resume(cancelled: Cancelled = CANCELLED_FALSE): void {
    assert_(
      !this.running() && !this.done(),
      "resume() on a running or finished thread",
    );
    assert_(
      this.cancellable || !cancelled,
      "cancelled resume of a non-cancellable block point",
    );
    if (this.waiting()) this.#stopWaiting(cancelled);
    this.#resumeInternal(cancelled);
  }

  /** Retire a cancellable wait without delivering task cancellation. */
  abandonWaiting(): void {
    assert_(
      this.waiting() && this.cancellable,
      "abandon of non-cancellable wait",
    );
    this.#stopWaiting(CANCELLED_TRUE);
    this.#body.return?.();
    this.#state = "done";
    this.cancellable = false;
  }

  #resumeInternal(sendValue: unknown, failure?: { error: unknown }): void {
    this.#state = "running";
    this.cancellable = false;
    pushCurrentThread(this);
    let step: IteratorResult<BlockRequest, void>;
    try {
      step = failure === undefined
        ? this.#body.next(sendValue)
        // Throw the rejection *into* the body so a post-resume trap unwinds
        // through the same `finally`s a synchronous one would (jspi pin (e)).
        : this.#body.throw(failure.error);
    } catch (e) {
      // The body threw (a trap, or one of our capability errors). The thread
      // is finished either way; the exception propagates to whoever was
      // driving the scheduler.
      this.#state = "done";
      throw e;
    } finally {
      popCurrentThread(this);
    }
    if (step.done) {
      this.#state = "done";
      return;
    }
    const req = step.value;
    this.cancellable = req.cancellable;
    if (req.awaitValue !== undefined) {
      // Promise parks are driver-owned, with eager settlement tracking to
      // order their bookkeeping before later scheduler ticks.
      this.#state = "suspended";
      this.awaiting = req.awaitValue;
      this.#store.noteAwaiting(this, req.awaitValue);
      return;
    }
    if (req.readyFunc === null) {
      // `suspend`: resumable only by an explicit `resume`/`resumeLater`.
      this.#state = "suspended";
    } else {
      this.#state = "suspended";
      this.#startWaiting(req.readyFunc);
    }
  }

  /**
   * Generator form of `Thread.wait_until`; call with `yield*`. Uses the
   * reference's deterministic-profile blocking path even if already ready.
   */
  *waitUntil(
    readyFunc: () => boolean,
    cancellable = false,
  ): Generator<BlockRequest, Cancelled, Cancelled> {
    assert_(this.running(), "waitUntil on a non-running thread");
    if (this.task.deliverPendingCancel(cancellable)) return CANCELLED_TRUE;
    // Pending cancellation is itself a wakeup, but the implicit callback
    // thread cannot receive it while another thread holds exclusivity.
    const readyOrCancelled = () =>
      readyFunc() ||
      (cancellable && this.task.hasPendingCancel() &&
        (this !== this.task.implicitThread ||
          this.task.implicitThreadCancellable()));
    const cancelled = yield { readyFunc: readyOrCancelled, cancellable };
    // As in Thread.wait_until, pending cancellation wins over a ready event
    // after the block as well as before it.
    if (this.task.deliverPendingCancel(cancellable)) return CANCELLED_TRUE;
    return cancelled;
  }

  /** definitions.py `Thread.suspend`. */
  *suspend(
    cancellable: boolean,
  ): Generator<BlockRequest, Cancelled, Cancelled> {
    assert_(this.running(), "suspend on a non-running thread");
    if (this.task.deliverPendingCancel(cancellable)) return CANCELLED_TRUE;
    const cancelled = yield { readyFunc: null, cancellable };
    return cancelled;
  }

  /** definitions.py `Thread.yield_`: wait with an always-ready predicate. */
  *yield_(cancellable: boolean): Generator<BlockRequest, Cancelled, Cancelled> {
    return yield* this.waitUntil(() => true, cancellable);
  }
}
