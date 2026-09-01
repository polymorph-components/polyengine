// FACT start-call JSPI park: lender scopes must not leak on the settle paths
// that never run `produce` (issue #102).
//
// Authority: contracts/intrinsics.md §A's trap-unwind/lender-release
// obligation — lender release on every non-poisoning exit. #91 covered the
// non-park exits of the start-call bodies (trap rethrow, capability bail,
// async-start resume-trap), see `resource_lender_unwind_test.ts`. One layer
// down, `createSyncStartCall`'s `blockCurrentActivation` park released its
// lenders only inside `produce()`, so a `SuspensionPoint` that settles
// WITHOUT producing — `abandon`, i.e. store teardown — left `numLends`
// elevated forever, and every later `lift_own` / `resource.drop` of those
// handles would trap "handle still lent out" (definitions.py 1508 / 2325).
//
// Settle-path enumeration for these parks (mirrored in the comment at the fix
// site, fact_calls.ts):
//
//   1. resume(false), produce returns          -> produce RUNS (success)
//   2. resume(false), produce throws           -> produce PARTIALLY runs
//   3. resume(true)                            -> unreachable: these parks are
//      `cancellable: false` and `SuspensionPoint.resume` asserts
//      `cancellable || !cancelled` (#93) BEFORE marking the point done
//   4. abandon(reason)                         -> produce NEVER runs  <-- #102
//   5. never settled (store dropped)           -> nothing runs at all; the
//      handles die with the store, as in the reference
//   6. trap-poisoning of the parked instance   -> surfaces as (2) or (4)
//
// The fix ties release to the point's terminal state via `onSettled`
// (jspi/bridge.ts), keeping the release inside `produce` as well so the
// SUCCESS-path ordering — release before the packed result is shaped — is
// unchanged.

import {
  createAsyncStartCall,
  createPrepareCall,
  createSyncStartCall,
  type PreparedCall,
} from "../src/intrinsics/fact_calls.ts";
import type { FactStartScope } from "../src/intrinsics/mod.ts";
import { newStats } from "../src/exec/boundary.ts";
import { ComponentInstanceState, Store, withActivation } from "../src/task/mod.ts";
import type { SuspensionPoint } from "../src/jspi/mod.ts";
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
const START_FLAG_ASYNC_CALLEE = 1;

interface Harness {
  store: Store;
  caller: ComponentInstanceState;
  callee: ComponentInstanceState;
  handle: ResourceHandle;
  rt: ResourceTypeInfo;
  handleIndex: number;
  /** Run one prepare + start-call in jspi mode; returns what it returned. */
  run(kind: "sync" | "async", calleeBody: () => CoreValue): unknown;
  /** The single parked suspension point, or `undefined`. */
  point(): SuspensionPoint<unknown> | undefined;
}

function mkHarness(): Harness {
  const store = new Store();
  const caller = new ComponentInstanceState(0, store);
  const callee = new ComponentInstanceState(1, store);
  const rt = new ResourceTypeInfo(caller, () => {});
  const handleIndex = canonResourceNew(caller, rt, 77);
  const handle = caller.handles.get(handleIndex) as ResourceHandle;

  const factStartScopes: FactStartScope[] = [];
  const prepared: { current: PreparedCall | null } = { current: null };
  const ctx = {
    componentInstance: (i: number) => (i === 0 ? caller : callee),
    resultTypes: () => [] as ValType[],
    resultTypesForTuple: () => null,
    callback: (_i: number) => null,
    memoryToken: () => null,
    stats: newStats(),
    prepared,
    factStartScopes,
    // The park under test only exists in jspi mode. Nothing here needs the
    // engine's JSPI: `calleeCanBlock` is absent, so no callee is
    // `promising`-wrapped, and `blockCurrentActivation` mints an ordinary
    // `SuspensionPoint` whose Promise we never hand to wasm.
    suspensionMode: "jspi" as const,
  };

  // `blockCurrentActivation` reads `currentTask()`, so the start-call must run
  // under an ambient activation, as it always does in a real guest frame (the
  // caller's). A minimal stand-in is enough: the point only reads
  // `task.implicitThread` and `task.inst`.
  const callerAmbient = { task: { inst: caller, implicitThread: null } };

  return {
    store,
    caller,
    callee,
    handle,
    rt,
    handleIndex,
    point() {
      return store.waiting.find(
        (w) => typeof (w as { resume?: unknown }).resume === "function" &&
          typeof (w as { abandon?: unknown }).abandon === "function",
      ) as SuspensionPoint<unknown> | undefined;
    },
    run(kind, calleeBody) {
      // `[async-start]` is where `transfer-borrow` lends one of the caller's
      // handles to the call (intrinsics/mod.ts `FactStartScope`).
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
        // deno-lint-ignore no-explicit-any
        : createAsyncStartCall({ callback: null, postReturn: null }, ctx as any);

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
      return withActivation(callerAmbient, () =>
        kind === "sync"
          ? startCall(calleeBody, 0)
          : startCall(calleeBody, 0, 0, START_FLAG_ASYNC_CALLEE));
    },
  };
}

/**
 * A callee whose core call never returns: it parks on a host promise, so the
 * callee's thread stays alive and unresolved and the CALLER reaches its park
 * (a callee that merely returned without resolving would trap "task finished
 * all threads without resolving" instead).
 */
const neverResolves = (() => new Promise(() => {})) as unknown as () => CoreValue;

Deno.test("#102: sync-start-call park releases lenders when abandoned (no produce)", async () => {
  const h = mkHarness();
  const parked = h.run("sync", neverResolves);
  assert(parked instanceof Promise, "the caller's activation parked");
  // Rejection is the point of `abandon`; consume it so the test does not fail
  // on an unhandled rejection.
  const settled = parked.then(
    () => "resolved",
    (e) => `rejected: ${(e as Error).message}`,
  );
  const point = h.point();
  assert(point !== undefined, "the suspension point is registered as waiting");
  assertEq(h.handle.numLends, 1); // lent for the duration of the park

  // Settle path 4: teardown abandons the park. `produce` never runs.
  point.abandon(new Error("store teardown"));

  assertEq(h.handle.numLends, 0);
  // The caller is NOT poisoned by an abandoned park, so the handle must stay
  // usable — this is the trap the lender-release obligation exists to prevent.
  canonResourceDrop(h.caller, h.rt, h.handleIndex);
  assertEq(await settled, "rejected: store teardown");
  assertEq(h.store.waiting.includes(point), false);
});

Deno.test("#102: sync-start-call park success path is unchanged (release before the result)", async () => {
  const h = mkHarness();
  let resolved = false;
  const parked = h.run("sync", neverResolves);
  assert(parked instanceof Promise, "the caller's activation parked");
  const point = h.point();
  assert(point !== undefined, "the suspension point is registered as waiting");
  assertEq(h.handle.numLends, 1);

  // Settle path 1. `produce` releases the lenders BEFORE shaping the results,
  // and this pins that ordering: at the instant the value exists, the release
  // has already happened. (`resume` settles synchronously; the value is
  // observed on the microtask turn after.)
  parked.then(() => {
    resolved = true;
    // Ordering pin: the released state is visible to whatever observes the
    // produced value.
    assertEq(h.handle.numLends, 0);
  });
  point.resume(false);
  assertEq(h.handle.numLends, 0); // released inside `produce`, not by a hook
  await parked;
  assertEq(resolved, true);
  canonResourceDrop(h.caller, h.rt, h.handleIndex);
});

Deno.test("#102: sync-start-call park releases lenders when produce throws", async () => {
  const h = mkHarness();
  const parked = h.run("sync", neverResolves);
  assert(parked instanceof Promise, "the caller's activation parked");
  const settled = parked.then(() => "resolved", (e) => `rejected: ${(e as Error).message}`);
  const point = h.point();
  assert(point !== undefined, "the suspension point is registered as waiting");

  // Settle path 2: a trap computed at resume time. Simulated by making the
  // produced value itself unobtainable — the shape a real produce-throw has
  // (jspi/bridge.ts `resume`'s catch: it reaches the guest as a rejection).
  // Deliberately throwing BEFORE the release the real `produce` performs: the
  // point of the fix is that release no longer depends on `produce` getting
  // that far.
  (point as unknown as { produce: () => unknown }).produce = () => {
    throw new Error("resume-time trap");
  };

  point.resume(false);
  assertEq(h.handle.numLends, 0);
  canonResourceDrop(h.caller, h.rt, h.handleIndex);
  assertEq(await settled, "rejected: resume-time trap");
});

Deno.test("#102: a cancelled resume cannot reach these non-cancellable parks", async () => {
  const h = mkHarness();
  const parked = h.run("sync", neverResolves);
  assert(parked instanceof Promise, "the caller's activation parked");
  const settled = parked.then(() => "resolved", (e) => `rejected: ${(e as Error).message}`);
  const point = h.point();
  assert(point !== undefined, "the suspension point is registered as waiting");

  // Settle path 3: rejected by `SuspensionPoint.resume`'s assert (#93), which
  // fires before the point is marked done — so this is not a settle path at
  // all, and there is no non-poisoning continuation to release into. Pinned
  // here so a future `cancellable: true` at this site has to revisit the
  // enumeration.
  let threw: unknown = null;
  try {
    point.resume(true);
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, "a cancelled resume of a non-cancellable point traps");
  assertEq(point.waiting(), true); // still parked: NOT a terminal transition

  // Teardown then still discharges the lenders.
  point.abandon(new Error("teardown after the illegal resume"));
  assertEq(h.handle.numLends, 0);
  assertEq(await settled, "rejected: teardown after the illegal resume");
});

Deno.test("#102: async-start-call determinacy park releases subtask lenders when abandoned", async () => {
  const h = mkHarness();
  // A callee whose core call parks on a host promise: the callee thread is
  // neither done nor scheduler-parked, so `determinate()` is false and the
  // CALLER parks on the determinacy wait (fact_calls.ts, issue #43).
  const parked = h.run("async", neverResolves);
  if (!(parked instanceof Promise)) {
    // The determinacy wait was satisfied eagerly; nothing to test here (the
    // eager path is `resource_lender_unwind_test.ts`'s territory).
    return;
  }
  const settled = parked.then(() => "resolved", (e) => `rejected: ${(e as Error).message}`);
  const point = h.point();
  assert(point !== undefined, "the caller parked on the determinacy wait");
  assertEq(h.handle.numLends, 1);

  point.abandon(new Error("store teardown"));

  // `report()` never ran, so the guest never got a subtask index and nothing
  // would ever deliver this subtask's resolution: the park's backstop unwinds
  // it, exactly as the trap path does (#91's `unwindSubtaskLenders`).
  assertEq(h.handle.numLends, 0);
  canonResourceDrop(h.caller, h.rt, h.handleIndex);
  assertEq(await settled, "rejected: store teardown");
});

Deno.test("#102: async-start-call determinacy park does NOT unwind a live subtask on success", async () => {
  const h = mkHarness();
  const parked = h.run("async", neverResolves);
  if (!(parked instanceof Promise)) return;
  const point = h.point();
  assert(point !== undefined, "the caller parked on the determinacy wait");

  // Settle path 1: `report()` completes and hands the guest a subtask index.
  // The subtask is LIVE — its lenders are released by its own
  // `deliverResolve` later (definitions.py `Subtask.deliver_resolve`, 904) —
  // so the backstop must stay out of the way. A blanket unwind here would
  // cancel a perfectly good call.
  point.resume(false);
  const packed = await parked;
  assertEq(typeof packed, "number");
  assertEq(h.handle.numLends, 1);
});
