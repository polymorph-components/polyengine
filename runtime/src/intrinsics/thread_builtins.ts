// Explicit Component Model thread built-ins. Semantics follow
// definitions.py `canon_thread_*` and CanonicalABI.md §§thread.index–
// thread.yield-then-promote.

import { assert_, trapIf } from "../cabi/trap.ts";
import type { CoreValue } from "../cabi/types.ts";
import { awaitCore, type CoreFn } from "../exec/boundary.ts";
import { blockCurrentActivation, type SuspensionMode } from "../jspi/mod.ts";
import {
  type Cancelled,
  currentThreadExactlyForInstance,
  needsJspi,
  Thread,
} from "../task/mod.ts";
import type { ComponentInstanceState } from "../task/mod.ts";

export interface ThreadTrampolineContext {
  componentInstance(index: number): ComponentInstanceState;
  runtimeTable(index: number): WebAssembly.Table;
  suspensionMode: SuspensionMode;
  enterThreadFunction(fn: CoreFn): CoreFn;
}

type ThreadDecl = { instance: number; cancellable?: boolean };

// Generated from the checked WAT below. `ref.test` checks a nominal final
// reference without executing the target. It covers the canonical final types
// emitted by the current translator, but not every structurally equivalent
// non-final/derived type allowed by the Component Model. The JS API has no
// signature/reflection operation with which to implement that general check;
// contracts/intrinsics.md §B records capability restriction #12.
//
// (module
//   (type $i32void (func (param i32)))
//   (type $i64void (func (param i64)))
//   (func (export "is-i32") (param funcref) (result i32)
//     local.get 0 ref.test (ref $i32void))
//   (func (export "is-i64") (param funcref) (result i32)
//     local.get 0 ref.test (ref $i64void)))
const THREAD_FUNC_VALIDATOR_BYTES = new Uint8Array([
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  14,
  3,
  96,
  1,
  127,
  0,
  96,
  1,
  126,
  0,
  96,
  1,
  112,
  1,
  127,
  3,
  3,
  2,
  2,
  2,
  7,
  19,
  2,
  6,
  105,
  115,
  45,
  105,
  51,
  50,
  0,
  0,
  6,
  105,
  115,
  45,
  105,
  54,
  52,
  0,
  1,
  10,
  17,
  2,
  7,
  0,
  32,
  0,
  251,
  20,
  0,
  11,
  7,
  0,
  32,
  0,
  251,
  20,
  1,
  11,
]);

type RefValidator = (fn: CoreFn | null) => number;
let validators: { i32: RefValidator; i64: RefValidator } | undefined;

function threadValidators(): { i32: RefValidator; i64: RefValidator } {
  if (validators !== undefined) return validators;
  const exports = new WebAssembly.Instance(
    new WebAssembly.Module(THREAD_FUNC_VALIDATOR_BYTES),
  ).exports;
  validators = {
    i32: exports["is-i32"] as RefValidator,
    i64: exports["is-i64"] as RefValidator,
  };
  return validators;
}

function declaredInst(
  decl: ThreadDecl,
  ctx: ThreadTrampolineContext,
): ComponentInstanceState {
  return ctx.componentInstance(decl.instance);
}

function requireMayLeave(inst: ComponentInstanceState, what: string): void {
  trapIf(!inst.mayLeave, `${what}: cannot leave component instance`);
}

function requireTarget(inst: ComponentInstanceState, index: number): Thread {
  const target = inst.threads.get(index >>> 0);
  trapIf(
    target === currentThreadExactlyForInstance<Thread>(inst),
    "cannot resume the current thread",
  );
  return target;
}

export function createThreadIndex(
  decl: ThreadDecl,
  ctx: ThreadTrampolineContext,
): CoreFn {
  const inst = declaredInst(decl, ctx);
  return () => {
    requireMayLeave(inst, "thread.index");
    const thread = currentThreadExactlyForInstance<Thread>(inst);
    assert_(thread.index !== null, "current thread is not registered");
    return thread.index;
  };
}

export function createThreadNewIndirect(
  decl: ThreadDecl & { startFuncTable: number },
  ctx: ThreadTrampolineContext,
): CoreFn {
  const inst = declaredInst(decl, ctx);
  const table = ctx.runtimeTable(decl.startFuncTable);
  return (rawIndex?: number, closure?: CoreValue) => {
    requireMayLeave(inst, "thread.new-indirect");
    const task = currentThreadExactlyForInstance<Thread>(inst).task;
    const index = (rawIndex ?? 0) >>> 0;
    let target: CoreFn | null;
    try {
      target = table.get(index) as CoreFn | null;
    } catch {
      trapIf(true, "thread.new-indirect table index out of range");
      return 0;
    }
    trapIf(target === null, "thread.new-indirect function is null");
    assert_(target !== null);

    // CONTRACT: the validated canonical trampoline signature determines the
    // declared start parameter: i32 arrives as number and i64 as bigint. The
    // nominal ref.test check is deliberately the documented supported subset,
    // not a claim of full structural CoreFuncType equality (contract §B/#12).
    trapIf(
      typeof closure !== "number" && typeof closure !== "bigint",
      "thread.new-indirect invalid closure type",
    );
    const expected = typeof closure === "bigint" ? "i64" : "i32";
    trapIf(
      threadValidators()[expected](target) === 0,
      "thread.new-indirect function type mismatch",
    );
    const entry = ctx.enterThreadFunction(target);
    const holder: { thread?: Thread } = {};
    const body = (function* () {
      const thread = holder.thread!;
      try {
        yield* awaitCore(entry, [closure!] as CoreValue[], thread);
      } catch (error) {
        task.abortThread(thread);
        throw error;
      }
      if (thread.index !== null) {
        task.unregisterThread(thread);
        // An explicit thread may be the activation which resolved the task;
        // public delivery becomes eligible when that activation returns.
        task.controlReturned(thread);
      }
    })();
    const thread = new Thread(task, body);
    holder.thread = thread;
    task.registerThread(thread);
    return thread.index!;
  };
}

export function createThreadResumeLater(
  decl: ThreadDecl,
  ctx: ThreadTrampolineContext,
): CoreFn {
  const inst = declaredInst(decl, ctx);
  return (index?: number) => {
    requireMayLeave(inst, "thread.resume-later");
    const target = requireTarget(inst, index ?? 0);
    trapIf(!target.explicitlySuspended(), "cannot resume thread");
    target.resumeLater();
  };
}

type ParkKind = "suspend" | "yield";
type TargetKind = "none" | "resume" | "promote";

function createThreadPark(
  decl: ThreadDecl,
  ctx: ThreadTrampolineContext,
  park: ParkKind,
  targetKind: TargetKind,
): CoreFn {
  const inst = declaredInst(decl, ctx);
  const cancellable = decl.cancellable === true;
  return (index?: number) => {
    requireMayLeave(inst, `thread.${park}`);
    const caller = currentThreadExactlyForInstance<Thread>(inst);

    let target: Thread | null = null;
    if (targetKind !== "none") {
      target = requireTarget(inst, index ?? 0);
      if (targetKind === "resume") {
        trapIf(!target.explicitlySuspended(), "cannot resume thread");
      }
    }
    // definitions.py validates target/self/state before cancellation delivery.
    if (caller.task.deliverPendingCancel(cancellable)) return 1;
    if (ctx.suspensionMode !== "jspi") {
      needsJspi(
        `thread.${park}${targetKind === "none" ? "" : `-then-${targetKind}`}`,
      );
    }

    const targetSchedulable = target?.schedulable() ?? null;
    const resumeTarget = targetKind === "resume" ||
      (targetKind === "promote" && targetSchedulable?.ready() === true);
    const callerPromise = blockCurrentActivation({
      store: inst.store,
      task: caller.task,
      readyFunc: park === "yield" ? () => true : null,
      cancellable,
      explicitSuspend: park === "suspend",
      produce: (cancelled: Cancelled) => cancelled ? 1 : 0,
    });
    if (resumeTarget) {
      // The caller's canonical state is now published. Transfer directly to
      // the named target before any ordinary scheduler choice.
      if (target!.explicitlySuspended()) target!.resumeLater();
      target!.schedulable().resume();
    }
    return callerPromise as unknown as number;
  };
}

export function createThreadSuspend(
  decl: ThreadDecl,
  ctx: ThreadTrampolineContext,
): CoreFn {
  return createThreadPark(decl, ctx, "suspend", "none");
}

export function createThreadSuspendThenResume(
  decl: ThreadDecl,
  ctx: ThreadTrampolineContext,
): CoreFn {
  return createThreadPark(decl, ctx, "suspend", "resume");
}

export function createThreadYieldThenResume(
  decl: ThreadDecl,
  ctx: ThreadTrampolineContext,
): CoreFn {
  return createThreadPark(decl, ctx, "yield", "resume");
}

export function createThreadSuspendThenPromote(
  decl: ThreadDecl,
  ctx: ThreadTrampolineContext,
): CoreFn {
  return createThreadPark(decl, ctx, "suspend", "promote");
}

export function createThreadYieldThenPromote(
  decl: ThreadDecl,
  ctx: ThreadTrampolineContext,
): CoreFn {
  return createThreadPark(decl, ctx, "yield", "promote");
}
