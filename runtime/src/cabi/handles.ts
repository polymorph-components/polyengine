// Handle tables and resource handles (definitions.py `### Table State`,
// `### Resource State`, `canon resource.{new,drop,rep}`, and the
// own/borrow lift/lower functions).
//
// The Table and ResourceHandle mechanics are pure and ported fully. What is
// simplified here (pending the task machinery):
//   - canon_resource_* take the instance explicitly instead of reading
//     current_instance() from the running thread;
//   - canon_resource_drop routes the dtor through `callDtorGated` below,
//     which reconstructs the reference's store.lift/store.lower bracket
//     (entry refusal + trap poisoning) around the destructor call (#85).
//     Host-initiated drops do NOT come here: they run the dtor through the
//     real lift harness (`hostDtorCall`, exec/boundary.ts) — see #160.

import { assert_, Trap, trap, trapIf } from "./trap.ts";
import {
  NeedsJspi,
  notifyInstancePoisoned,
  PendingCapability,
  entryRefusal,
} from "../task/scheduler.ts";
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
    trapIf(i >= this.array.length, "table index out of range");
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
  const h = requireInst(cx).handles.remove(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h as ResourceHandle;
  trapIf(rh.rt !== t.rt, "resource type mismatch");
  trapIf(rh.numLends !== 0, "handle still lent out");
  trapIf(!rh.own, "expected own handle");
  return rh.rep;
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
 * Is `x` a REAL component instance (`task/mod.ts` `ComponentInstanceState`),
 * as opposed to something that has no instance behind it at all?
 *
 * Two populations must answer false, and both are load-bearing for
 * `callDtorGated`: an imported/host-implemented resource, whose
 * `ResourceTypeInfo.impl` is `null` by construction (exec/executor.ts
 * `bindImportedResources`), and the bare `{handles, mayLeave}` doubles test
 * harnesses supply — neither has an instance to refuse entry into or to
 * poison. So this is deliberately NOT a structural match on
 * `ComponentInstanceLike`, which those doubles satisfy: it reads the
 * `COMPONENT_INSTANCE` brand, declared on `ComponentInstanceState` and
 * defined in ./context.ts so that cabi does not have to import task/.
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
 * Invoke a resource destructor, as definitions.py `canon_resource_drop`
 * (@ 2f13265) does — through `Store.lift`/`Store.lower`:
 *
 * ```python
 *   dtor = rt.dtor or (lambda rep: [])
 *   callee = inst.store.lift(dtor, ft, opts, rt.impl)
 *   caller = inst.store.lower(callee, ft, opts, inst)
 *   caller([h.rep])
 * ```
 *
 * That lift carries NO gate (CM#705): dropping a handle whose implementing
 * instance is mid-execution is VALID, including the dtor-less case.
 *
 * What this adds is polyengine's per-instance poisoning divergence, and it
 * applies to `rt.impl`, not to the dropping instance: a trap out of the dtor
 * buries the implementing instance (refusal names the original trap,
 * polyengine#145; its live stream/future ends are retired, #66). The
 * dropper is poisoned, if at all, by the same trap propagating at its own
 * level. `entryRefusal`'s `caller !== callee` guard keeps a component
 * dropping a handle to its OWN resource admissible even against a marked
 * instance.
 *
 * Capability signals (`NeedsJspi`, `PendingCapability`) are not traps — see
 * `isCapabilitySignal` in exec/boundary.ts — so they do not poison.
 *
 * SCOPE (#160): this is the **guest-initiated** path only. A guest-initiated
 * drop must complete synchronously (the reference lifts the dtor with
 * `async_ = False`), so a thenable here is a trap. The host-initiated path
 * goes through the full lift harness instead (`hostDtorCall` in
 * exec/boundary.ts), which is what definitions.py actually does.
 */
export function callDtorGated(
  rt: ResourceTypeInfo,
  rep: number,
  caller: unknown,
): void {
  const impl = isComponentInstance(rt.impl);
  // Always the raw synchronous dtor: `dtorHost` is the host path's lifted
  // entry, which is not callable from inside a guest activation.
  const dtorFn = rt.dtor;
  // No component instance behind the resource: an imported (host-implemented)
  // resource has `impl === null` by construction (executor.ts
  // `bindImportedResources`), so there is no instance to refuse entry into and
  // none to poison. Test doubles that supply a bare `{handles, mayLeave}`
  // instance land here too — see `isComponentInstance`.
  if (impl === null) {
    const r = dtorFn?.(rep) as unknown;
    trapIf(
      isThenable(r),
      "resource destructor did not complete synchronously",
    );
    return;
  }
  // The caller is only meaningful when it is a real component instance; a
  // host-initiated drop passes null, which is the reference's `caller = None`
  // (Store.invoke). It feeds `entryRefusal`'s `caller !== callee` guard below.
  const callerInst = isComponentInstance(caller) === null ? null : caller;

  // A poisoned target's refusal names the original trap (polyengine#145).
  // `callerInst` can legitimately BE `impl` here (a guest dropping its own
  // resource): `entryRefusal`'s self-call guard keeps that entry allowed
  // even against a marked instance.
  {
    const refusal = entryRefusal(
      impl,
      callerInst,
      "cannot enter component instance",
    );
    if (refusal !== null) trap(refusal);
  }

  const poison = (e: unknown): void => {
    // Capability signals are not traps: the operation they stand in for
    // completes normally in the reference, so the instance stays healthy.
    if (e instanceof NeedsJspi || e instanceof PendingCapability) return;
    // A real trap buries the implementing instance, and its live
    // stream/future ends are retired (#66) through the same seam
    // fact_calls.ts uses for its poisoning sites.
    notifyInstancePoisoned(impl, e);
  };

  let out: unknown;
  try {
    out = dtorFn?.(rep) as unknown;
  } catch (e) {
    poison(e);
    throw e;
  }
  if (isThenable(out)) {
    // A guest-initiated drop is lifted with `async_ = False`: the dtor must
    // resolve before `canon_resource_drop` returns. Reaching here means the
    // dtor's activation escaped, which is a trap that poisons the impl.
    const e = new Trap(
      "resource destructor did not complete synchronously",
    );
    poison(e);
    throw e;
  }
}

export function canonResourceDrop(
  inst: ComponentInstanceLike,
  rt: ResourceTypeInfo,
  i: number,
): void {
  trapIf(!inst.mayLeave, "may_leave violation");
  const h = inst.handles.remove(i);
  trapIf(!(h instanceof ResourceHandle), "not a resource handle");
  const rh = h as ResourceHandle;
  trapIf(rh.rt !== rt, "resource type mismatch");
  trapIf(rh.numLends !== 0, "handle still lent out");
  if (rh.own) {
    assert_(rh.borrowScope === null);
    // definitions.py line 2326-2333: the dtor runs through the store's
    // lift/lower bracket. SCOPE NOTE (#85): the call below is a JS frame
    // inside the drop trampoline, so a *guest*-initiated drop whose dtor
    // suspends traps under the JSPI frame rule. That is deterministic and
    // loud, and routing guest-initiated dtor calls through generated wasm is
    // explicitly out of scope for #85 (docs/architecture.md §5/§7 carry the
    // known-limitation note).
    callDtorGated(rt, rh.rep, inst);
  } else {
    assert_(rh.borrowScope !== null);
    rh.borrowScope!.numBorrows -= 1;
  }
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
