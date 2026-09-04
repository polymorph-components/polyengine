// definitions.py `### Waitable State` (line 754) — the event protocol shared
// by subtasks and (later) stream/future ends.

import { assert_, trapIf } from "../cabi/trap.ts";
import { chooseCandidate } from "./scheduler.ts";
import type { BlockRequest, Cancelled } from "./scheduler.ts";
import type { Thread } from "./thread.ts";

/** definitions.py `EventCode` (line 756). */
export enum EventCode {
  NONE = 0,
  SUBTASK = 1,
  STREAM_READ = 2,
  STREAM_WRITE = 3,
  FUTURE_READ = 4,
  FUTURE_WRITE = 5,
  TASK_CANCELLED = 6,
}

/** definitions.py `EventTuple` = `(EventCode, int, int)`. */
export type EventTuple = [code: EventCode, p1: number, p2: number];

/**
 * definitions.py `class Waitable` (line 767).
 *
 * The pending event is a **thunk**, not a value: the reference computes the
 * payload at delivery time (`get_pending_event` calls it), which is what lets
 * a subtask report its *final* state even if it advanced between the event
 * being set and being read. Keeping the thunk is load-bearing — see
 * `Subtask.setPendingEvent`.
 */
export class Waitable {
  pendingEvent: (() => EventTuple) | null = null;
  wset: WaitableSet | null = null;
  hasSyncWaiter = false;

  setPendingEvent(pendingEvent: () => EventTuple): void {
    this.pendingEvent = pendingEvent;
  }

  hasPendingEvent(): boolean {
    return this.pendingEvent !== null;
  }

  inWaitableSet(): boolean {
    return this.wset !== null;
  }

  /**
   * definitions.py `Waitable.wait_for_pending_event` (line 786): a
   * *non-cancellable* block until this waitable has an event, used by the
   * synchronous `subtask.cancel` path.
   */
  *waitForPendingEvent(
    thread: Thread,
  ): Generator<BlockRequest, void, Cancelled> {
    assert_(
      !this.inWaitableSet() && !this.hasSyncWaiter,
      "waitForPendingEvent on a joined or already-awaited waitable",
    );
    this.hasSyncWaiter = true;
    yield* thread.waitUntil(() => this.hasPendingEvent(), false);
    this.hasSyncWaiter = false;
  }

  getPendingEvent(): EventTuple {
    const pendingEvent = this.pendingEvent;
    assert_(pendingEvent !== null, "getPendingEvent with no pending event");
    this.pendingEvent = null;
    return pendingEvent();
  }

  /** definitions.py `Waitable.join` (line 797). */
  join(wset: WaitableSet | null): void {
    assert_(!this.hasSyncWaiter, "join on a waitable with a sync waiter");
    if (this.wset) {
      const i = this.wset.elems.indexOf(this);
      assert_(i !== -1, "waitable not in its own waitable set");
      this.wset.elems.splice(i, 1);
    }
    this.wset = wset;
    if (wset) wset.elems.push(this);
  }

  /** definitions.py `Waitable.drop` (line 805). */
  drop(): void {
    assert_(!this.hasPendingEvent(), "dropping a waitable with a pending event");
    assert_(!this.hasSyncWaiter, "dropping a waitable with a sync waiter");
    this.join(null);
  }
}

const EV_TRACE = (() => {
  try {
    return Deno.env.get("CE_EVENT_TRACE") === "1";
  } catch {
    return false;
  }
})();

/** definitions.py `class WaitableSet` (line 810). */
export class WaitableSet {
  readonly elems: Waitable[] = [];
  numWaiting = 0;

  hasPendingEvent(): boolean {
    return this.elems.some((w) => w.hasPendingEvent());
  }

  /**
   * definitions.py `WaitableSet.get_pending_event` (line 821). The reference
   * shuffles `elems` before scanning; we scan in **join order** under the
   * default FIFO policy (`chooseCandidate` over the ready elements), which is
   * within the same allowed nondeterminism — see scheduler.ts's policy note.
   */
  getPendingEvent(): EventTuple {
    const ready = this.elems.filter((w) => w.hasPendingEvent());
    assert_(ready.length > 0, "getPendingEvent on a set with no pending event");
    const w = chooseCandidate(ready);
    assert_(w.wset === this, "waitable/waitable-set back-reference mismatch");
    const ev = w.getPendingEvent();
    if (EV_TRACE) {
      console.error(
        `[event] deliver code=${ev[0]} idx=${ev[1]} payload=${ev[2]} ` +
          `readyCount=${ready.length} setSize=${this.elems.length} ` +
          `chosenPos=${this.elems.indexOf(w)}`,
      );
    }
    return ev;
  }

  /** definitions.py `WaitableSet.wait_for_event_and` (line 829). */
  *waitForEventAnd(
    thread: Thread,
    readyFunc: () => boolean,
    cancellable: boolean,
  ): Generator<BlockRequest, EventTuple, Cancelled> {
    this.numWaiting += 1;
    try {
      const cancelled = yield* thread.waitUntil(
        () => readyFunc() && this.hasPendingEvent(),
        cancellable,
      );
      return cancelled
        ? [EventCode.TASK_CANCELLED, 0, 0]
        : this.getPendingEvent();
    } finally {
      this.numWaiting -= 1;
    }
  }

  /** definitions.py `WaitableSet.wait_for_event` (line 841). */
  *waitForEvent(
    thread: Thread,
    cancellable: boolean,
  ): Generator<BlockRequest, EventTuple, Cancelled> {
    return yield* this.waitForEventAnd(thread, () => true, cancellable);
  }

  /**
   * definitions.py `WaitableSet.poll` (line 844). Never blocks, so it is a
   * plain function rather than a generator.
   */
  // deno-lint-ignore no-explicit-any
  poll(task: any, cancellable: boolean): EventTuple {
    if (task.deliverPendingCancel(cancellable)) {
      return [EventCode.TASK_CANCELLED, 0, 0];
    }
    if (!this.hasPendingEvent()) return [EventCode.NONE, 0, 0];
    return this.getPendingEvent();
  }

  /** definitions.py `WaitableSet.drop` (line 852). */
  drop(): void {
    trapIf(this.elems.length > 0, "cannot drop waitable set with waitables");
    trapIf(this.numWaiting > 0, "cannot drop waitable set with waiters");
  }
}
