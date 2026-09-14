// Entry refusal on the sync fused-adapter bracket (issue #99).
//
// Nothing at the pinned reference gates this site: definitions.py @ 2f13265
// has no `may_enter`, `entering_set`, `enter_from`, `leave_to` or
// `ComponentInstance.parent`, and `Store.lift` runs `canon_lift`
// unconditionally (CM#705). A sibling cycle A -> C -> A through the
// trampoline therefore does NOT trap.
//
// wasmtime agreed all along: `enter_guest_sync_call`
// (47.0.3 `runtime/component/concurrent.rs:1723`) performs no reentrance
// check, and same-instance / ancestor pairs are trapped statically by FACT
// (`fact/trampoline.rs:120-127`), not here.
//
// What DOES still refuse at this site is polyengine's named divergence: a
// POISONED callee is a corpse, and the refusal names the original trap
// (polyengine#145). That is the surviving pin below.
//
// These tests drive the `enter-sync-call` trampoline directly, because the
// shapes involved are not constructible as components: mutual sibling
// imports are rejected by validation (instance imports form a DAG).

import { assertEq } from "./support/asserts.ts";
import {
  createTrampoline,
  type SyncCallScope,
  type TrampolineContext,
} from "../src/intrinsics/mod.ts";
import { newStats } from "../src/exec/boundary.ts";
import {
  ComponentInstanceState,
  Store,
  SynchronousActivation,
  Task,
  Thread,
} from "../src/task/mod.ts";
import {
  ambientResidue,
  currentTask,
  currentThread,
  maybeCurrentThread,
  notifyInstancePoisoned,
  withActivation,
} from "../src/task/scheduler.ts";
import {
  blockCurrentActivation,
  type SuspensionPoint,
} from "../src/jspi/bridge.ts";

function fixture() {
  const store = new Store();
  const insts = new Map<number, ComponentInstanceState>();
  const syncCallStack: SyncCallScope[] = [];
  const ctx = {
    componentInstance: (i: number) => {
      let s = insts.get(i);
      if (s === undefined) {
        s = new ComponentInstanceState(i, store);
        insts.set(i, s);
      }
      return s;
    },
    syncCallStack,
    factStartScopes: [],
    stats: newStats(),
  } as unknown as TrampolineContext;
  const enter = createTrampoline(
    { kind: "enter-sync-call", index: 0 } as never,
    ctx,
  );
  const exit = createTrampoline(
    { kind: "exit-sync-call", index: 0 } as never,
    ctx,
  );
  const inst = (i: number) => (ctx as TrampolineContext).componentInstance(i);
  return { ctx, enter, exit, inst, syncCallStack };
}

/** `A` = instance 0, `C` = instance 1; sync (`async_ = 0`) throughout. */
const A = 0;
const C = 1;

Deno.test("enter-sync-call: an idle sibling callee is enterable", () => {
  const { enter, exit, inst } = fixture();
  enter(A, 0, C);
  assertEq(currentTask().inst === inst(C), true, "callee task is current");
  assertEq(currentThread().storage, [0, 0], "callee slots start fresh");
  exit();
  assertEq(maybeCurrentThread(), undefined, "bracket closed");
});

Deno.test("enter-sync-call: a sibling cycle A -> C -> A no longer traps (CM#705)", () => {
  // Host entered A; A is mid-call into C; C calls back into A. That is
  // simply a valid call (CM#705).
  const { enter, exit, inst } = fixture();
  enter(A, 0, C);
  const c = currentThread();
  c.storage[0] = 41;
  enter(C, 0, A);
  assertEq(currentTask().inst === inst(A), true);
  assertEq(currentThread().storage, [0, 0]);
  exit();
  assertEq(currentThread() === c, true, "parent activation restored");
  assertEq(c.storage[0], 41);
  exit();
  assertEq(maybeCurrentThread(), undefined);
});

Deno.test("enter-sync-call: a POISONED callee is refused, naming the trap", () => {
  const { enter, inst } = fixture();
  notifyInstancePoisoned(inst(A), new Error("earlier boom"));
  let msg = "";
  try {
    enter(C, 0, A);
  } catch (e) {
    msg = String((e as Error).message ?? e);
  }
  assertEq(
    msg.includes("cannot enter component instance"),
    true,
    `expected the poisoned-corpse refusal, got: ${msg || "<no trap>"}`,
  );
  // polyengine#145 ask 1: the refusal names the original trap.
  assertEq(msg.includes("instance poisoned by"), true, msg);
  assertEq(msg.includes("earlier boom"), true, msg);
});

Deno.test("enter-sync-call: a poisoned instance calling ITSELF passes vacuously", () => {
  // `entryRefusal`'s `caller !== callee` guard passes a self-call
  // vacuously, even against a marked instance.
  const { enter, exit, inst } = fixture();
  notifyInstancePoisoned(inst(A), new Error("earlier boom"));
  enter(A, 0, A);
  exit();
});

Deno.test("enter-sync-call: an acyclic sibling chain A -> B -> C never traps", () => {
  const { enter, exit, inst } = fixture();
  const B = 2;
  enter(A, 0, B);
  enter(B, 0, C);
  assertEq(currentTask().inst === inst(C), true);
  exit();
  assertEq(currentTask().inst === inst(B), true);
  exit();
  assertEq(maybeCurrentThread(), undefined);
});

Deno.test("enter-sync-call: trap unwind retires nested task identity", () => {
  const { enter, inst } = fixture();
  const parent = { storage: [7, 8], task: { inst: inst(A) } };
  const boom = new Error("nested trap");
  let caught: unknown;
  try {
    withActivation(parent, () => {
      enter(A, 0, C);
      assertEq(currentTask().inst === inst(C), true);
      throw boom;
    });
  } catch (e) {
    caught = e;
  }
  assertEq(caught === boom, true);
  assertEq([...inst(C).threads].length, 0, "callee task retired on unwind");
  assertEq(maybeCurrentThread(), undefined, "ambient parent also unwound");
});

Deno.test("nested sync suspension keeps physical owner and logical task separate", async () => {
  const store = new Store();
  const outerInst = new ComponentInstanceState(0, store);
  const innerInst = new ComponentInstanceState(1, store);
  const outerTask = new Task(
    { params: [], results: [], async: true },
    { async_: true, callback: false, stringEncoding: "utf8", memory: null },
    outerInst,
    () => [],
    () => {},
  );
  let logical!: SynchronousActivation;
  const physical = new Thread(
    outerTask,
    (function* () {
      logical = new SynchronousActivation(innerInst, true, currentThread());
      const promise = blockCurrentActivation({
        store,
        task: logical.task,
        readyFunc: () => true,
        cancellable: false,
        produce: () => undefined,
      });
      yield { readyFunc: null, cancellable: false, awaitValue: promise };
      logical.finish();
    })(),
  );
  physical.resume();
  const point = store.waiting[0] as SuspensionPoint;
  assertEq(point.owner === physical, true, "scheduler owner is physical");
  assertEq(
    point.logicalOwner === logical.thread,
    true,
    "context owner is logical",
  );
  assertEq(point.task === logical.task, true, "built-in task remains logical");
  point.resume();
  await Promise.resolve();
  store.serviceSettled();
  assertEq([...innerInst.threads].length, 0);
  assertEq(physical.logicalDescendants.size, 0);
  assertEq(ambientResidue(), { stack: 0, claim: false });
});

Deno.test("nested sync post-hop trap retires persistent logical descendants", async () => {
  const store = new Store();
  const outerInst = new ComponentInstanceState(0, store);
  const innerInst = new ComponentInstanceState(1, store);
  const outerTask = new Task(
    { params: [], results: [], async: true },
    { async_: true, callback: false, stringEncoding: "utf8", memory: null },
    outerInst,
    () => [],
    () => {},
  );
  const boom = new Error("after-hop trap");
  const physical = new Thread(
    outerTask,
    (function* () {
      const logical = new SynchronousActivation(
        innerInst,
        true,
        currentThread(),
      );
      const promise = blockCurrentActivation({
        store,
        task: logical.task,
        readyFunc: () => true,
        cancellable: false,
        produce: () => undefined,
      });
      yield { readyFunc: null, cancellable: false, awaitValue: promise };
      throw boom;
    })(),
  );
  physical.resume();
  (store.waiting[0] as SuspensionPoint).resume();
  await Promise.resolve();
  let caught: unknown;
  try {
    store.serviceSettled();
  } catch (e) {
    caught = e;
  }
  assertEq(
    (caught as { cause?: unknown })?.cause === boom || caught === boom,
    true,
  );
  assertEq([...innerInst.threads].length, 0);
  assertEq(physical.logicalDescendants.size, 0);
  assertEq(store.pendingResumptions.size, 0);
  assertEq(ambientResidue(), { stack: 0, claim: false });
});
