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
// A generator owns each logical activation; JSPI SuspensionPoints represent
// parks inside its wasm entry and are linked through `explicitPark`.

import { assert_ } from "../cabi/trap.ts";
import {
  abortLogicalChildren,
  type BlockRequest,
  isInstancePoisoned,
  NeedsJspi,
  notifyInstancePoisoned,
  PendingCapability,
  popCurrentThread,
  pushCurrentThread,
  releaseActivationAmbient,
  type SchedulableThread,
  type Store,
  type ThreadBody,
} from "./scheduler.ts";

type ThreadState = "running" | "suspended" | "waiting" | "done";

/** The explicit-resume surface supplied by a JSPI SuspensionPoint. */
export interface ThreadPark extends SchedulableThread {
  readonly boundaryReturned?: boolean;
  explicitResumeLater(): void;
  explicitlySuspended(): boolean;
}

export class Thread implements SchedulableThread {
  /** Real synchronous logical caller, populated only by SynchronousActivation. */
  parent?: import("./scheduler.ts").CurrentThreadLike;
  /** Physical generator activation used for JSPI awaiting/resumption. */
  physicalOwner: Thread = this;
  /** Persistent logical descendants, including while their stack is unpublished. */
  readonly logicalDescendants: Set<Thread> = new Set<Thread>();
  /** Current wasm-level `thread.suspend*` park, if this activation has one. */
  activePark: ThreadPark | null = null;
  /** Present when this Thread is driven by an enclosing wasm sync call. */
  logicalActivation?: {
    active: boolean;
    finish(): void;
    abort(): void;
  };
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
  #stopWaiting(): void {
    assert_(this.waiting() && this.#readyFunc !== null);
    assert_(
      this.ready(),
      "stopWaiting on a thread that is not ready",
    );
    this.#readyFunc = null;
    this.#state = "suspended";
    this.#store.stopWaiting(this);
  }

  /** definitions.py `Thread.resume_later`. */
  resumeLater(): void {
    if (this.activePark !== null) {
      this.activePark.explicitResumeLater();
      return;
    }
    assert_(
      this.suspended() && this.awaiting === null,
      "resume_later on a non-suspended thread",
    );
    this.#startWaiting(() => true);
    this.#store.requestService();
  }

  /** Canonical suspended state accepted by `thread.*-then-resume`. */
  explicitlySuspended(): boolean {
    return this.activePark?.explicitlySuspended() ??
      (this.suspended() && this.awaiting === null);
  }

  /** Scheduler object whose readiness represents this logical thread. */
  schedulable(): SchedulableThread {
    return this.activePark ?? this;
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
  resume(): void {
    assert_(
      !this.running() && !this.done(),
      "resume() on a running or finished thread",
    );
    if (this.waiting()) this.#stopWaiting();
    this.#resumeInternal(undefined);
  }

  /** Wake an INITIAL task's admission wait after cancellation was recorded. */
  resumeStartupCancellation(): void {
    assert_(this.waiting(), "startup cancellation of a non-waiting thread");
    this.#readyFunc = null;
    this.#state = "suspended";
    this.#store.stopWaiting(this);
    this.#resumeInternal(undefined);
  }

  /** Retire a startup wait without delivering task cancellation. */
  abandonWaiting(): void {
    assert_(this.waiting(), "abandon of non-waiting thread");
    this.#readyFunc = null;
    this.#state = "suspended";
    this.#store.stopWaiting(this);
    this.#body.return?.();
    this.#state = "done";
  }

  #resumeInternal(sendValue: unknown, failure?: { error: unknown }): void {
    this.#state = "running";
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
      abortLogicalChildren(this);
      releaseActivationAmbient(this);
      this.#store.removePendingResumption(this);
      throw e;
    } finally {
      popCurrentThread(this);
    }
    if (step.done) {
      this.#state = "done";
      // CONTRACT: canonical resolution is captured at Task.return_, but the
      // host result becomes eligible only after this execution quantum has
      // returned (CanonicalABI.md:961-983). This also keeps sync post-return
      // inside the quantum that may still fail.
      this.task.controlReturned?.(this);
      return;
    }
    const req = step.value;
    if (req.awaitValue !== undefined) {
      // Promise parks are driver-owned, with eager settlement tracking to
      // order their bookkeeping before later scheduler ticks.
      this.#state = "suspended";
      this.awaiting = req.awaitValue;
      this.#store.noteAwaiting(this, req.awaitValue);
      // If the blocking import's boundary notification already ran, this is
      // now known to be a genuine park. Otherwise that notification will find
      // this awaiting owner. Plain-mode test doubles have no SuspensionPoint
      // and therefore remain an implementation hop.
      if (
        this.#store.waiting.some((w) =>
          (w as { owner?: unknown; boundaryReturned?: boolean }).owner ===
            this &&
          (w as { boundaryReturned?: boolean }).boundaryReturned === true
        )
      ) {
        this.task.controlReturned?.(this);
      }
      return;
    }
    if (req.readyFunc === null) {
      // `suspend`: resumable only by an explicit `resume`/`resumeLater`.
      this.#state = "suspended";
    } else {
      this.#state = "suspended";
      this.#startWaiting(req.readyFunc);
      if (this.ready()) this.#store.requestService();
    }
    this.task.controlReturned?.(this);
  }

  /**
   * Generator form of `Thread.wait_until`; call with `yield*`. Uses the
   * reference's deterministic-profile blocking path even if already ready.
   */
  *waitUntil(
    readyFunc: () => boolean,
  ): Generator<BlockRequest, void, unknown> {
    assert_(this.running(), "waitUntil on a non-running thread");
    yield { readyFunc };
  }

  /** definitions.py `Thread.suspend`. */
  *suspend(): Generator<BlockRequest, void, unknown> {
    assert_(this.running(), "suspend on a non-running thread");
    yield { readyFunc: null };
  }

  /** definitions.py `Thread.yield_`: wait with an always-ready predicate. */
  *yield_(): Generator<BlockRequest, void, unknown> {
    return yield* this.waitUntil(() => true);
  }
}
