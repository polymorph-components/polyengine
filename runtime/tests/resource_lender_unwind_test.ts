// FACT start-call unwind: lender scopes must not leak on the non-success
// exits (issue #91).
//
// Authority: contracts/intrinsics.md v0.2 amendment 2 — on a trap escaping a
// FACT bracket the host unwinds sync-call scopes (releasing lenders) because
// this runtime deliberately supports post-trap re-entry on the caller side,
// where definitions.py kills the whole store instead. The lent handles belong
// to the CALLER, which neither a callee trap nor a capability bail poisons,
// so leaving `num_lends` elevated would make every later `lift_own` /
// `resource.drop` of those handles trap "handle still lent out"
// (definitions.py lines 1508 / 2325).

import {
  createAsyncStartCall,
  createPrepareCall,
  createSyncStartCall,
  type PreparedCall,
} from "../src/intrinsics/fact_calls.ts";
import type { FactStartScope } from "../src/intrinsics/mod.ts";
import { isInstancePoisoned } from "../src/task/scheduler.ts";
import { newStats } from "../src/exec/boundary.ts";
import { ComponentInstanceState, Store } from "../src/task/mod.ts";
import { NeedsJspi } from "../src/task/scheduler.ts";
import {
  canonResourceDrop,
  canonResourceNew,
  ResourceHandle,
  ResourceTypeInfo,
} from "../src/cabi/mod.ts";
import type { CoreValue, ValType } from "../src/cabi/types.ts";
import { assertEq } from "./support/asserts.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const PREPARE_ASYNC_NO_RESULT = 0xffff_ffff;

interface Harness {
  caller: ComponentInstanceState;
  callee: ComponentInstanceState;
  handle: ResourceHandle;
  rt: ResourceTypeInfo;
  handleIndex: number;
  /** Run one prepare + start-call; returns whatever escaped, or null. */
  run(kind: "sync" | "async", calleeBody: () => CoreValue): unknown;
}

function mkHarness(postReturn: (() => void) | null = null): Harness {
  const store = new Store();
  const caller = new ComponentInstanceState(0, store);
  const callee = new ComponentInstanceState(1, store);
  // The resource is implemented by the CALLER, so dropping it later is the
  // same-instance (ungated) path — this test is about `num_lends`, not #85.
  const rt = new ResourceTypeInfo(caller, () => {});
  const handleIndex = canonResourceNew(caller, rt, 77);
  const handle = caller.handles.get(handleIndex) as ResourceHandle;

  const factStartScopes: FactStartScope[] = [];
  const prepared: { current: PreparedCall | null } = { current: null };
  const ctx = {
    componentInstance: (i: number) => (i === 0 ? caller : callee),
    resultTypes: () => [] as ValType[],
    resultTypesForTuple: () => null,
    callback: (_i: number) => postReturn,
    memoryToken: () => null,
    stats: newStats(),
    prepared,
    factStartScopes,
    suspensionMode: "plain" as const,
  };

  return {
    caller,
    callee,
    handle,
    rt,
    handleIndex,
    run(kind, calleeBody) {
      // `[async-start]`: this is where a `transfer-borrow` intrinsic lends one
      // of the caller's handles to the call (intrinsics/mod.ts
      // `FactStartScope`), so the stub does exactly that.
      const start = () => {
        const scope = factStartScopes[factStartScopes.length - 1];
        assert(scope !== undefined, "a start scope is live");
        scope.lenders.addLender(handle);
        return undefined as unknown as CoreValue;
      };
      const return_ = () => undefined as unknown as CoreValue;

      // deno-lint-ignore no-explicit-any
      const prep = createPrepareCall({ memory: null }, ctx as any);
      const startCall = kind === "sync"
        // deno-lint-ignore no-explicit-any
        ? createSyncStartCall({ callback: null }, ctx as any)
        : createAsyncStartCall(
          { callback: null, postReturn: postReturn === null ? null : 0 },
          // deno-lint-ignore no-explicit-any
          ctx as any,
        );

      prep(
        start,
        return_,
        0, // caller_instance
        1, // callee_instance
        0,
        0,
        0,
        PREPARE_ASYNC_NO_RESULT,
      );
      try {
        if (kind === "sync") startCall(calleeBody, 0);
        else startCall(calleeBody, 0, 0, 0);
        return null;
      } catch (e) {
        return e;
      }
    },
  };
}

Deno.test("#91: sync-start-call releases the caller's lenders when the callee traps", () => {
  const h = mkHarness();
  const boom = new Error("callee trap");
  const escaped = h.run("sync", () => {
    throw boom;
  });
  assertEq(escaped === boom, true);
  // The callee is poisoned; the caller is not, and its handle is usable again.
  assertEq(isInstancePoisoned(h.callee), true);
  assertEq(h.handle.numLends, 0);
  canonResourceDrop(h.caller, h.rt, h.handleIndex); // no "still lent out" trap
});

Deno.test("#91: sync-start-call releases lenders on a capability bail", () => {
  const h = mkHarness();
  // `NeedsJspi` stands for a blocking operation this runtime cannot perform
  // yet (here: raised by the callee; the sibling site is the intrinsic's own
  // bail when an async-lifted callee has not resolved by the end of its first
  // activation, which needs a real parking callee to reach). It is expressly
  // a NON-poisoning capability signal, so the caller is guaranteed to keep
  // running and stranded lenders would be permanent — strictly worse than on
  // the trap path.
  const boom = new NeedsJspi("callee needs to block");
  const escaped = h.run("sync", () => {
    throw boom;
  });
  assert(escaped instanceof NeedsJspi, `expected NeedsJspi, got ${escaped}`);
  assertEq(isInstancePoisoned(h.callee), false); // not poisoned, as the class demands
  assertEq(h.handle.numLends, 0);
  canonResourceDrop(h.caller, h.rt, h.handleIndex);
});

Deno.test("#91: async-start-call releases the subtask's lenders when the callee traps", () => {
  const h = mkHarness();
  const boom = new Error("callee trap");
  const escaped = h.run("async", () => {
    throw boom;
  });
  assertEq(escaped === boom, true);
  assertEq(isInstancePoisoned(h.callee), true);
  // The subtask never reached `report()`, so nothing else would ever deliver
  // its resolution and release these.
  assertEq(h.handle.numLends, 0);
  canonResourceDrop(h.caller, h.rt, h.handleIndex);
});

Deno.test("#91: a trapping post-return leaves may_leave as the reference does", () => {
  // definitions.py `canon_lift`: `may_leave = False`, the post-return call,
  // `may_leave = True`. A trap in between skips the restore, and the instance
  // is poisoned, so its flags are left exactly as the trap left them.
  // Verified rather than "fixed": restoring `may_leave` here locally would
  // contradict the reference. The obligation this runtime adds — that no
  // *live* instance is stranded with `may_leave === false` — is discharged at
  // the host boundary by exec/boundary.ts `unwind`, which asserts the resting
  // state for every instance except the poisoned one.
  const boom = new Error("post-return trap");
  const h = mkHarness(() => {
    throw boom;
  });
  // flags = 0 selects the sync-ABI callee, whose lift runs the post-return.
  const escaped = h.run("async", () => undefined as unknown as CoreValue);
  assertEq(escaped === boom, true);
  assertEq(isInstancePoisoned(h.callee), true); // never enterable again
  assertEq(h.callee.mayLeave, false); // left as the trap left it
  // The caller — the instance that survives and may be re-entered — is sane.
  assertEq(isInstancePoisoned(h.caller), false);
  assertEq(h.caller.mayLeave, true);
  assertEq(h.handle.numLends, 0);
});
