// definitions.py `Subtask`: one in-progress call to an import.

import { assert_, trapIf } from "../cabi/trap.ts";
import type { ResourceHandle } from "../cabi/handles.ts";
import type { CoreValue } from "../cabi/types.ts";
import { EventCode, Waitable } from "./waitable.ts";

/** definitions.py `Subtask.State`. */
export enum SubtaskState {
  STARTING = 0,
  STARTED = 1,
  RETURNED = 2,
  CANCELLED_BEFORE_STARTED = 3,
  CANCELLED_BEFORE_RETURNED = 4,
}

/**
 * Structural lender interface shared with cabi's borrow scopes.
 */
export interface Lendable {
  numLends: number;
}

/** Cancellation callback handed back by a lifted callee (`OnCancel`). */
// deno-lint-ignore no-explicit-any
export type OnCancel = (caller: any) => void;

export class Subtask extends Waitable {
  state: SubtaskState = SubtaskState.STARTING;
  onCancel: OnCancel | null = null;
  cancellationRequested = false;
  flatResults: CoreValue[] = [];

  /**
   * FACT callee task; host imports have none. Async subtask.cancel uses it
   * to wait for a JSPI-delivered cancellation to reach a determinate state
   * before choosing BLOCKED versus a resolved status.
   */
  // deno-lint-ignore no-explicit-any
  calleeTask: any = null;

  /**
   * Lenders remain live until resolution is delivered, not merely recorded.
   * Null is `Subtask.resolve_delivered`'s sentinel.
   */
  lenders: Lendable[] | null = [];

  /** definitions.py `Subtask.resolved`. */
  resolved(): boolean {
    switch (this.state) {
      case SubtaskState.STARTING:
      case SubtaskState.STARTED:
        return false;
      default:
        return true;
    }
  }

  /** definitions.py `Subtask.add_lender`. */
  addLender(h: Lendable): void {
    assert_(
      !this.resolveDelivered() && !this.resolved(),
      "addLender on a resolved subtask",
    );
    h.numLends += 1;
    this.lenders!.push(h);
  }

  /** definitions.py `Subtask.resolve`. */
  resolve(state: SubtaskState, flatResults: CoreValue[]): void {
    assert_(
      state === SubtaskState.RETURNED || flatResults.length === 0,
      "non-RETURNED subtask resolution carries results",
    );
    assert_(!this.resolved(), "resolve on an already-resolved subtask");
    this.state = state;
    this.flatResults = flatResults;
  }

  /** definitions.py `Subtask.deliver_resolve`. */
  deliverResolve(): void {
    assert_(
      !this.resolveDelivered() && this.resolved(),
      "deliverResolve on an unresolved or already-delivered subtask",
    );
    for (const h of this.lenders!) h.numLends -= 1;
    this.lenders = null;
  }

  /** definitions.py `Subtask.resolve_delivered`. */
  resolveDelivered(): boolean {
    assert_(
      this.lenders !== null || this.resolved(),
      "lenders released on an unresolved subtask",
    );
    return this.lenders === null;
  }

  /**
   * Idempotent lender cleanup for abandoned calls and non-poisoning unwind
   * (contracts/intrinsics.md's trap-unwind/lender-release obligation).
   * Unresolved calls take `canon_lower`'s cancellation state according to
   * whether they started. Already-delivered resolutions are unchanged.
   */
  unwindLenders(): void {
    if (!this.resolved()) {
      this.resolve(
        this.state === SubtaskState.STARTING
          ? SubtaskState.CANCELLED_BEFORE_STARTED
          : SubtaskState.CANCELLED_BEFORE_RETURNED,
        [],
      );
    }
    if (!this.resolveDelivered()) this.deliverResolve();
  }

  /** definitions.py `Subtask.drop`. */
  override drop(): void {
    trapIf(
      !this.resolveDelivered(),
      "cannot drop a subtask which has not yet resolved",
    );
    super.drop();
  }

  /**
   * `canon_lower`'s event thunk reads status at delivery and releases lenders
   * when the guest observes resolution. The delivered guard also tolerates
   * an earlier unwindLenders cleanup on an abandoned path.
   */
  setSubtaskPendingEvent(subtaski: number): void {
    this.setPendingEvent(() => {
      if (this.resolved() && !this.resolveDelivered()) this.deliverResolve();
      return [EventCode.SUBTASK, subtaski, this.state];
    });
  }
}

/**
 * Pack a `canon_lower` async result: low four bits hold state, upper 28 the
 * nonzero subtask handle index.
 */
export function packSubtaskResult(
  state: SubtaskState,
  subtaski: number,
): number {
  assert_(
    subtaski > 0 && subtaski <= 2 ** 28 - 1,
    "subtask index out of packing range",
  );
  assert_(state >= 0 && state < 2 ** 4, "subtask state out of packing range");
  return (state | (subtaski << 4)) >>> 0;
}

/** Inverse of {@link packSubtaskResult}; used by tests mirroring the reference. */
export function unpackSubtaskResult(
  packed: number,
): [state: SubtaskState, subtaski: number] {
  return [(packed & 0xf) as SubtaskState, packed >>> 4];
}

/** Re-exported for callers that only import from this module. */
export type { ResourceHandle };
