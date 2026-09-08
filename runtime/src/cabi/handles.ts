// Handle tables and resource handles (definitions.py `### Table State`,
// `### Resource State`, `canon resource.{new,drop,rep}`, and the
// own/borrow lift/lower functions).
//
// canon_resource_* take the declared instance explicitly. Guest drops use
// `callDtorGated` and a fresh synchronous lift task/thread; host drops use
// `hostDtorCall` (exec/boundary.ts) with host completion policy.

import { assert_, trapIf } from "./trap.ts";
import { removeHandleWithUnwind } from "../task/scheduler.ts";
import { createDtorEntry } from "../exec/boundary.ts";
import type { ComponentInstanceState } from "../task/mod.ts";
import { COMPONENT_INSTANCE } from "./context.ts";
import type {
  ComponentInstanceLike,
  LiftLowerContext,
  SubtaskBorrowScope,
  TaskBorrowScope,
} from "./context.ts";
import type { BorrowType, OwnType, ResourceTypeInfo } from "./types.ts";

export class Table<T> {
  static readonly MAX_LENGTH = 2 ** 28 - 1;

  array: (T | null)[] = [null];
  free: number[] = [];

  get(i: number): T {
    // Indices are u32; a negative i is out of range, and JS `array[-1]` is
    // `undefined`, not the `null` sentinel.
    trapIf(i < 0 || i >= this.array.length, "table index out of range");
    trapIf(this.array[i] === null, "table entry empty");
    return this.array[i]!;
  }

  add(e: T): number {
    let i: number;
    if (this.free.length > 0) {
      i = this.free.pop()!;
      assert_(this.array[i] === null);
      this.array[i] = e;
    } else {
      i = this.array.length;
      trapIf(i > Table.MAX_LENGTH, "table full");
      this.array.push(e);
    }
    return i;
  }

  remove(i: number): T {
    const e = this.get(i);
    this.array[i] = null;
    this.free.push(i);
    return e;
  }

  *[Symbol.iterator](): Iterator<T> {
    for (const e of this.array) {
      if (e !== null) yield e;
    }
  }
}

export class ResourceHandle {
  numLends = 0;

  constructor(
    public rt: ResourceTypeInfo,
    public rep: number,
    public own: boolean,
    public borrowScope: TaskBorrowScope | null = null,
  ) {}
}

// ---------------------------------------------------------------------------
// own/borrow lift & lower (called from load/store/lift/lower dispatchers)
// ---------------------------------------------------------------------------

function requireInst(cx: LiftLowerContext): ComponentInstanceLike {
  assert_(cx.inst !== null, "context requires a component instance");
  return cx.inst;
}

export function liftOwn(
  cx: LiftLowerContext,
  i: number,
  t: OwnType,
): number {
  return removeHandleWithUnwind(requireInst(cx), i, (h) => {
    trapIf(!(h instanceof ResourceHandle), "not a resource handle");
    const rh = h as ResourceHandle;
    trapIf(rh.rt !== t.rt, "resource type mismatch");
    trapIf(rh.numLends !== 0, "handle still lent out");
    trapIf(!rh.own, "expected own handle");
    return rh.rep;
  });
}

export function liftBorrow(
  cx: LiftLowerContext,
  i: number,
  t: BorrowType,
): number {
  const scope = cx.borrowScope as SubtaskBorrowScope | null;
  assert_(
    scope !== null && typeof scope.addLender === "function",
    "lifting a borrow requires a subtask borrow scope",
  );
  const h = requireInst(cx).handles.get(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h as ResourceHandle;
  trapIf(rh.rt !== t.rt, "resource type mismatch");
  scope!.addLender(rh);
  return rh.rep;
}

export function lowerOwn(
  cx: LiftLowerContext,
  rep: number,
  t: OwnType,
): number {
  const h = new ResourceHandle(t.rt, rep, true);
  return requireInst(cx).handles.add(h);
}

export function lowerBorrow(
  cx: LiftLowerContext,
  rep: number,
  t: BorrowType,
): number {
  const scope = cx.borrowScope as TaskBorrowScope | null;
  assert_(
    scope !== null && typeof scope.numBorrows === "number",
    "lowering a borrow requires a task borrow scope",
  );
  if (cx.inst !== null && cx.inst === (t.rt.impl as unknown)) {
    return rep;
  }
  const h = new ResourceHandle(t.rt, rep, false, scope);
  scope!.numBorrows += 1;
  return requireInst(cx).handles.add(h);
}

// ---------------------------------------------------------------------------
// canon resource.new / resource.drop / resource.rep
// (instance passed explicitly; see module comment)
// ---------------------------------------------------------------------------

export function canonResourceNew(
  inst: ComponentInstanceLike,
  rt: ResourceTypeInfo,
  rep: number,
): number {
  trapIf(!inst.mayLeave, "may_leave violation");
  const h = new ResourceHandle(rt, rep, true);
  return inst.handles.add(h);
}

/**
 * The slice of a real component instance a dtor call needs: its handle table
 * (for the poisoning walk) plus the identity `entryRefusal` keys on.
 */
interface RealComponentInstance {
  handles: Iterable<unknown>;
}

/**
 * Only branded component instances have task state and poisoning semantics.
 * Host resource impl=null and structural test doubles must not enter that path.
 */
function isComponentInstance(x: unknown): RealComponentInstance | null {
  if (x === null || typeof x !== "object") return null;
  return (x as Record<symbol, unknown>)[COMPONENT_INSTANCE] === true
    ? (x as RealComponentInstance)
    : null;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === "object" && v !== null &&
    typeof (v as { then?: unknown }).then === "function";
}

/**
 * Guest-initiated destructor call. `canon_resource_drop` lifts the dtor with
 * a fresh synchronous task/thread, including a no-op dtor when absent.
 * Reentrance into a live implementing instance is valid.
 *
 * The lift harness applies runtime poisoning to `rt.impl` on a trap and
 * retires its stream/future ends; capability signals do not poison. The
 * dropper's trap propagation is handled separately. `entryRefusal` preserves
 * the same-instance exemption for self-drops.
 *
 * Guest entry uses the reference's synchronous drive, not host-wide async
 * completion; a returned thenable traps. Host drops use `hostDtorCall`.
 */
export function callDtorGated(
  rt: ResourceTypeInfo,
  rep: number,
  caller: unknown,
): void {
  const impl = isComponentInstance(rt.impl);
  const dtorFn = rt.dtor;
  // Host resources and structural test doubles have no task/poisoning state.
  if (impl === null) {
    const r = dtorFn?.(rep) as unknown;
    trapIf(
      isThenable(r),
      "resource destructor did not complete synchronously",
    );
    return;
  }
  // Preserve a real guest caller's identity for the self-drop exemption.
  const callerInst = isComponentInstance(caller) === null ? null : caller;

  createDtorEntry({
    dtor: dtorFn,
    instance: impl as ComponentInstanceState,
    guestCaller: callerInst as ComponentInstanceState | null,
  })(rep);
}

export function canonResourceDrop(
  inst: ComponentInstanceLike,
  rt: ResourceTypeInfo,
  i: number,
): void {
  trapIf(!inst.mayLeave, "may_leave violation");
  removeHandleWithUnwind(inst, i, (h) => {
    trapIf(!(h instanceof ResourceHandle), "not a resource handle");
    const rh = h as ResourceHandle;
    trapIf(rh.rt !== rt, "resource type mismatch");
    trapIf(rh.numLends !== 0, "handle still lent out");
    if (rh.own) {
      assert_(rh.borrowScope === null);
      // Enter a fresh synchronous dtor task, not the dropping task's ambient.
      callDtorGated(rt, rh.rep, inst);
    } else {
      assert_(rh.borrowScope !== null);
      rh.borrowScope!.numBorrows -= 1;
    }
  });
}

export function canonResourceRep(
  inst: ComponentInstanceLike,
  rt: ResourceTypeInfo,
  i: number,
): number {
  const h = inst.handles.get(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h as ResourceHandle;
  trapIf(rh.rt !== rt, "resource type mismatch");
  return rh.rep;
}
