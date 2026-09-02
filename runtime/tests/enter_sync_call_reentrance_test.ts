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
import { ComponentInstanceState, Store } from "../src/task/mod.ts";
import { notifyInstancePoisoned } from "../src/task/scheduler.ts";

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
    trapState: { pending: undefined },
  } as unknown as TrampolineContext;
  const enter = createTrampoline({ kind: "enter-sync-call", index: 0 } as never, ctx);
  const exit = createTrampoline({ kind: "exit-sync-call", index: 0 } as never, ctx);
  const inst = (i: number) => (ctx as TrampolineContext).componentInstance(i);
  return { ctx, enter, exit, inst, syncCallStack };
}

/** `A` = instance 0, `C` = instance 1; sync (`async_ = 0`) throughout. */
const A = 0;
const C = 1;

Deno.test("enter-sync-call: an idle sibling callee is enterable", () => {
  const { enter, exit, syncCallStack } = fixture();
  enter(A, 0, C);
  assertEq(syncCallStack.length, 1, "bracket opened");
  exit();
  assertEq(syncCallStack.length, 0, "bracket closed");
});

Deno.test("enter-sync-call: a sibling cycle A -> C -> A no longer traps (CM#705)", () => {
  // Host entered A; A is mid-call into C; C calls back into A. That is
  // simply a valid call (CM#705).
  const { enter, exit, syncCallStack } = fixture();
  enter(A, 0, C);
  enter(C, 0, A);
  assertEq(syncCallStack.length, 2, "both brackets opened, nothing refused");
  exit();
  exit();
  assertEq(syncCallStack.length, 0);
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
  const { enter, inst } = fixture();
  notifyInstancePoisoned(inst(A), new Error("earlier boom"));
  enter(A, 0, A);
});

Deno.test("enter-sync-call: an acyclic sibling chain A -> B -> C never traps", () => {
  const { enter, exit, syncCallStack } = fixture();
  const B = 2;
  enter(A, 0, B);
  enter(B, 0, C);
  assertEq(syncCallStack.length, 2);
  exit();
  exit();
  assertEq(syncCallStack.length, 0);
});
