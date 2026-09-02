// Canonical options and lift/lower context (definitions.py `## Canonical ABI
// Options`, `## Lifting and Lowering Context`).

import { assert_, trapIf } from "./trap.ts";
import type { MemInst } from "./memory.ts";
import type { StringEncoding } from "./types.ts";
import type { Table } from "./handles.ts";

/**
 * definitions.py realloc signature: (original_ptr, original_size, alignment,
 * new_size) -> ptr. Addresses as JS numbers (see memory.ts).
 */
export type ReallocFn = (
  originalPtr: number,
  originalSize: number,
  alignment: number,
  newSize: number,
) => number;

export interface LiftOptions {
  stringEncoding: StringEncoding;
  memory: MemInst | null;
}

export interface LiftLowerOptions extends LiftOptions {
  realloc: ReallocFn | null;
}

export interface CanonicalOptions extends LiftLowerOptions {
  postReturn: (() => void) | null;
  async_: boolean;
  callback: unknown | null;
}

export function mkCanonicalOptions(
  partial: Partial<CanonicalOptions> = {},
): CanonicalOptions {
  return {
    stringEncoding: partial.stringEncoding ?? "utf8",
    memory: partial.memory ?? null,
    realloc: partial.realloc ?? null,
    postReturn: partial.postReturn ?? null,
    async_: partial.async_ ?? false,
    callback: partial.callback ?? null,
  };
}

/** Memory accessor that traps-or-asserts like `cx.opts.memory` derefs. */
export function requireMemory(opts: LiftOptions): MemInst {
  assert_(opts.memory !== null, "canonical option `memory` required");
  return opts.memory;
}

/**
 * Minimal component-instance stand-in for the value interpreter: a handle
 * table plus the `may_leave` gate. The full ComponentInstance (backpressure,
 * threads, ...) belongs to the task machinery, which cabi must not import.
 */
export interface ComponentInstanceLike {
  handles: Table<unknown>;
  mayLeave: boolean;
}

/**
 * Brand marking a value as a REAL component instance (task/mod.ts
 * `ComponentInstanceState`), as opposed to the many structural
 * `ComponentInstanceLike` stand-ins — imported/host resources carry no
 * instance at all, and test harnesses supply bare `{handles, mayLeave}`
 * doubles. cabi must not depend on task/, so the symbol lives here and
 * `ComponentInstanceState` declares it; cabi/handles.ts `isComponentInstance`
 * is the only reader. `ComponentInstanceLike` stays deliberately structural:
 * the brand is NOT part of it.
 */
export const COMPONENT_INSTANCE: unique symbol = Symbol(
  "polyengine.ComponentInstance",
);

/**
 * Borrow scopes (definitions.py `LiftLowerContext.borrow_scope`):
 * - lifting a borrow requires the *subtask* side: `add_lender`.
 * - lowering a borrow requires the *task* side: `num_borrows`.
 * The real Task/Subtask classes are deferred; these are the minimal
 * interfaces the value code needs.
 */
export interface SubtaskBorrowScope {
  addLender(h: import("./handles.ts").ResourceHandle): void;
}

export interface TaskBorrowScope {
  numBorrows: number;
}

export class LiftLowerContext {
  constructor(
    public opts: LiftLowerOptions,
    public inst: ComponentInstanceLike | null = null,
    public borrowScope: SubtaskBorrowScope | TaskBorrowScope | null = null,
  ) {}

  /**
   * definitions.py `LiftLowerContext.reallocate`: the guest's realloc runs
   * with `may_leave` cleared, so a realloc that lowers an import traps
   * (`canon_lower`'s `trap_if(not ...may_leave)`, implemented here by
   * exec/boundary.ts `createLoweredImport`). That bracket is implemented
   * below, and it is the whole story: the pinned reference does not route
   * the call through `canon_lift` (CM#705). polyengine issue #147.
   */
  reallocate(
    old: number,
    oldByteLength: number,
    alignment: number,
    newByteLength: number,
  ): number {
    const realloc = this.opts.realloc;
    trapIf(realloc === null, "realloc required but not provided");
    // A null instance is the value-interpreter unit-test harness only
    // (tests/support/driver.ts `mkCx`); every real runtime path constructs
    // this context with an instance, so there is no flag to bracket.
    if (this.inst === null) {
      return realloc!(old, oldByteLength, alignment, newByteLength);
    }
    assert_(this.inst.mayLeave, "realloc with may_leave already false");
    this.inst.mayLeave = false;
    // NO try/finally, deliberately: same bare bracket as the post-return one
    // in intrinsics/fact_calls.ts (#91) and the reference's `assert`/restore
    // pair. A trapping realloc skips the restore exactly as the reference
    // does; the host-boundary unwind and instance poisoning handle the rest.
    const ptr = realloc!(old, oldByteLength, alignment, newByteLength);
    this.inst.mayLeave = true;
    return ptr;
  }

  allocate(alignment: number, byteLength: number): number {
    return this.reallocate(0, 0, alignment, byteLength);
  }
}
