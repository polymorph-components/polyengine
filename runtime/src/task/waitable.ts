// definitions.py `Waitable` / `WaitableSet`: events shared by subtasks and
// stream/future ends.

import { assert_, trapIf } from "../cabi/trap.ts";
import { chooseCandidate } from "./scheduler.ts";
import type { BlockRequest, Cancelled } from "./scheduler.ts";
import type { Thread } from "./thread.ts";

/** definitions.py `EventCode`. */
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
 * `Waitable.get_pending_event` computes the payload at delivery time, so a
 * subtask reports its current state even if it advanced after notification.
 * See `Subtask.setSubtaskPendingEvent` for delivery-time lender release.
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
   * definitions.py `Waitable.wait_for_pending_event`: a
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

  /** definitions.py `Waitable.join`. */
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

  /** definitions.py `Waitable.drop`. */
  drop(): void {
    assert_(
      !this.hasPendingEvent(),
      "dropping a waitable with a pending event",
    );
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

/** definitions.py `WaitableSet`. */
export class WaitableSet {
  readonly elems: Waitable[] = [];
  numWaiting = 0;

  hasPendingEvent(): boolean {
    return this.elems.some((w) => w.hasPendingEvent());
  }

  /**
   * `WaitableSet.get_pending_event` permits choosing any pending member.
   * Default to join order; seeded scheduling chooses among ready members.
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

  /** definitions.py `WaitableSet.wait_for_event_and`. */
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

  /** definitions.py `WaitableSet.wait_for_event`. */
  *waitForEvent(
    thread: Thread,
    cancellable: boolean,
  ): Generator<BlockRequest, EventTuple, Cancelled> {
    return yield* this.waitForEventAnd(thread, () => true, cancellable);
  }

  /**
   * definitions.py `WaitableSet.poll`. Never blocks, so it is a
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

  /** definitions.py `WaitableSet.drop`. */
  drop(): void {
    trapIf(this.elems.length > 0, "cannot drop waitable set with waitables");
    trapIf(this.numWaiting > 0, "cannot drop waitable set with waiters");
  }
}
