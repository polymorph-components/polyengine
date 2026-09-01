// definitions.py `### Subtask State` (line 858): one in-progress call from
// this component to an import.

import { assert_, trapIf } from "../cabi/trap.ts";
import type { ResourceHandle } from "../cabi/handles.ts";
import type { CoreValue } from "../cabi/types.ts";
import { EventCode, Waitable } from "./waitable.ts";

/** definitions.py `Subtask.State` (line 859). */
export enum SubtaskState {
  STARTING = 0,
  STARTED = 1,
  RETURNED = 2,
  CANCELLED_BEFORE_STARTED = 3,
  CANCELLED_BEFORE_RETURNED = 4,
}

/**
 * Anything that can be lent to a callee. `ResourceHandle` is the only
 * implementor today; typed structurally so cabi's borrow-scope interfaces
 * keep working unchanged.
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
   * The callee TASK behind this subtask, when there is one (FACT
   * cross-component calls; host-import subtasks have none). `subtask.cancel`
   * needs it under jspi: a cancellation delivered to a suspended activation
   * resumes it on a MICROTASK (the engine's, not ours), so the async form
   * must wait until the callee's state is determinate before choosing
   * between BLOCKED and the resolved state — the same determinacy question
   * `async-start-call` answers, and it needs the same object to ask it of.
   */
  // deno-lint-ignore no-explicit-any
  calleeTask: any = null;

  /**
   * Handles lent to the callee for the duration of the call. `null` once
   * `deliverResolve` has run — the reference uses exactly this
   * `lenders is None` sentinel to mean "resolve delivered" (line 908), so the
   * nullability is semantic, not an optimization.
   */
  lenders: Lendable[] | null = [];

  /** definitions.py `Subtask.resolved` (line 880). */
  resolved(): boolean {
    switch (this.state) {
      case SubtaskState.STARTING:
      case SubtaskState.STARTED:
        return false;
      default:
        return true;
    }
  }

  /** definitions.py `Subtask.add_lender` (line 890). */
  addLender(h: Lendable): void {
    assert_(
      !this.resolveDelivered() && !this.resolved(),
      "addLender on a resolved subtask",
    );
    h.numLends += 1;
    this.lenders!.push(h);
  }

  /** definitions.py `Subtask.resolve` (line 895). */
  resolve(state: SubtaskState, flatResults: CoreValue[]): void {
    assert_(
      state === SubtaskState.RETURNED || flatResults.length === 0,
      "non-RETURNED subtask resolution carries results",
    );
    assert_(!this.resolved(), "resolve on an already-resolved subtask");
    this.state = state;
    this.flatResults = flatResults;
  }

  /** definitions.py `Subtask.deliver_resolve` (line 902). */
  deliverResolve(): void {
    assert_(
      !this.resolveDelivered() && this.resolved(),
      "deliverResolve on an unresolved or already-delivered subtask",
    );
    for (const h of this.lenders!) h.numLends -= 1;
    this.lenders = null;
  }

  /** definitions.py `Subtask.resolve_delivered` (line 908). */
  resolveDelivered(): boolean {
    assert_(
      this.lenders !== null || this.resolved(),
      "lenders released on an unresolved subtask",
    );
    return this.lenders === null;
  }

  /**
   * Release a never-delivered subtask's lenders after its call broke off a
   * non-poisoning exit — trap-rethrow past the CALLEE, capability bail, or
   * an abandoned park (contracts/intrinsics.md §A's trap-unwind/lender-release
   * obligation; the park legs are #102/#106).
   *
   * The reference has no analogue because it never resumes after a trap:
   * the store dies with the lent handles inside it. The resolution state
   * mirrors `canon_lower`'s `on_resolve(None)` branch (definitions.py
   * line 2267): CANCELLED_BEFORE_STARTED if the callee never started,
   * CANCELLED_BEFORE_RETURNED otherwise.
   *
   * Idempotent, and a no-op when the resolution was already delivered — a
   * settled hook can call it unconditionally without disturbing the success
   * path's own `deliverResolve`.
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

  /** definitions.py `Subtask.drop` (line 912). */
  override drop(): void {
    trapIf(
      !this.resolveDelivered(),
      "cannot drop a subtask which has not yet resolved",
    );
    super.drop();
  }

  /**
   * definitions.py `canon_lower`'s `on_progress`/`subtask_event` closure
   * (lines 2297-2298). The event payload is computed **at delivery time** and
   * delivering it is what runs `deliver_resolve` — so the lent handles are
   * released exactly when the guest observes the resolution, not when it
   * happens.
   *
   * The `!this.resolveDelivered()` guard has no reference analogue: it exists
   * so this can coexist with `unwindLenders()` (which may itself have already
   * delivered the resolve on an abandoned path). The reference's
   * `subtask_event` calls `deliver_resolve()` unconditionally and would
   * assert on a double delivery.
   */
  setSubtaskPendingEvent(subtaski: number): void {
    this.setPendingEvent(() => {
      if (this.resolved() && !this.resolveDelivered()) this.deliverResolve();
      return [EventCode.SUBTASK, subtaski, this.state];
    });
  }
}

/**
 * Pack a `canon_lower` async return value: `state | (subtaski << 4)`
 * (definitions.py line 2306, with the accompanying asserts on the ranges).
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
