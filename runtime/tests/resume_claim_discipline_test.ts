// Resume-time claim/pending-resumption discipline (issue #158).
//
// `SuspensionPoint.#resumeInner` (jspi/bridge.ts) has two arms — `produce`
// returned a value, or `produce` threw a resume-time trap — and BOTH hand
// control back to a wasm activation, so both record a pending resumption on
// the store (`Store.addPendingResumption`). Both also call
// `Store.consumePendingIfRunning()` first: when the code delivering the resume
// is a RUNNING guest activation that itself has a pending entry (a
// `subtask.cancel` settling a parked callee from inside its own frame), that
// entry's window is closed. Mechanism A of #158 was the trap arm missing that
// call; back then the gate was a single global slot with a one-claimant
// assert, so the same delivery shape with a trapping `produce` tripped the
// assert — and the assert preempted `#fail(e)`, so the parked guest received
// an AssertionError instead of its trap. These tests pin the fixed symmetry.
//
// Mechanism B of #158 (a second engine-driven resumption in one turn, from an
// activation that is NOT the entry holder) is RESOLVED, 2026-08-22: the gate
// became the per-Store, multi-entry `Store.pendingResumptions` set and the
// one-claimant assert is gone with the slot (the invariant it protected —
// tier-3 ambient attribution unambiguity — no longer exists; see
// `resolveAmbient`). The mechanism-B test below therefore pins the SUCCESS of
// that shape, cross-store and same-store, where it used to pin the assert.
//
// Scaffolding follows park_state_settle_test.ts. NOTE: the AMBIENT state
// (activationClaims, threadStack) is still MODULE-GLOBAL, so every test cleans
// up in a `finally`; the pending-resumption sets live on the stores.

import {
  ComponentInstanceState,
  instancePoisonCause,
  isInstancePoisoned,
  popCurrentThread,
  pushCurrentThread,
  releaseActivationAmbient,
  Store,
  Task,
  type TaskOptions,
  Thread,
  WaitableSet,
  withActivation,
} from "../src/task/mod.ts";
import { createWaitableSetWait } from "../src/intrinsics/async_builtins.ts";
import {
  blockCurrentActivation,
  type SuspensionPoint,
} from "../src/jspi/mod.ts";
import { Trap } from "../src/cabi/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";
import type { ResolvedOptions } from "../src/exec/boundary.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const ASYNC_FT: FuncType = { params: [], results: [], async: true };
const CALLBACK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

function mkMemoryView() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  return {
    addrType: "i32" as const,
    get bytes() {
      return new Uint8Array(memory.buffer);
    },
    get view() {
      return new DataView(memory.buffer);
    },
    get length() {
      return memory.buffer.byteLength;
    },
    ptrType: () => "i32" as const,
    ptrSize: () => 4 as const,
  };
}

function opts(
  inst: ComponentInstanceState,
  over: Partial<ResolvedOptions> = {},
): ResolvedOptions {
  return {
    stringEncoding: "utf8",
    // deno-lint-ignore no-explicit-any
    memory: mkMemoryView() as any,
    realloc: null,
    postReturn: null,
    callback: null,
    async: false,
    cancellable: false,
    coreType: { params: ["i32", "i32"], results: ["i32"] },
    instance: inst,
    ...over,
  };
}

function mkWorld(over: { store?: Store } = {}) {
  const store = over.store ?? new Store();
  const inst = new ComponentInstanceState(0, store);
  const task = new Task(ASYNC_FT, CALLBACK_OPTS, inst, () => [], () => {});
  task.state = "started";
  const thread = new Thread(task, (function* () {})());
  // The engine-resume claim names `task.implicitThread` — set it, as a real
  // lifted call's `enterImplicitThread` would.
  task.implicitThread = thread;
  return {
    store,
    inst,
    task,
    thread,
    /** THIS world's suspension point. Filtered by task, because worlds may
     * share a `Store` (`mkWorld({ store })`) and therefore a waiting list. */
    point(): SuspensionPoint<unknown> | undefined {
      return store.waiting.find(
        (w) =>
          typeof (w as { resume?: unknown }).resume === "function" &&
          typeof (w as { abandon?: unknown }).abandon === "function" &&
          (w as { task?: unknown }).task === task,
      ) as SuspensionPoint<unknown> | undefined;
    },
    run<T>(fn: () => T): T {
      pushCurrentThread(thread);
      try {
        return fn();
      } finally {
        popCurrentThread(thread);
      }
    },
  };
}

/** Park `w`'s task on waitable-set.wait; resuming with no pending event makes
 * `produce` throw (the trap-at-resume-time arm), resuming cancelled succeeds. */
function parkOnWait(w: ReturnType<typeof mkWorld>, cancellable: boolean) {
  const wset = new WaitableSet();
  const seti = w.inst.handles.add(wset);
  const o = opts(w.inst, { cancellable });
  const ctx = {
    componentInstance: () => w.inst,
    options: () => o,
    resultTypes: () => [],
  };
  const wait = createWaitableSetWait({ options: 0 }, ctx, w.inst, "jspi");
  const parked = w.run(() => wait(seti, 0));
  assert(parked instanceof Promise, "the wait parked");
  const point = w.point();
  assert(point !== undefined, "the suspension point is waiting");
  return { wset, seti, parked: parked as Promise<unknown>, point: point! };
}

function cleanupAmbient(...worlds: ReturnType<typeof mkWorld>[]) {
  for (const w of worlds) {
    w.store.pendingResumptions.clear();
    releaseActivationAmbient(w.thread);
  }
}

/** Deno fails a file on unhandled rejections; the parked promises here are
 * rejected deliberately and inspected (or ignored) by the tests. */
type Outcome = { ok: true; v: unknown } | { ok: false; e: unknown };
function rejection(p: Promise<unknown>): Promise<Outcome> {
  return p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
}

Deno.test("resume success arm: delivery from the pending-entry holder consumes it", () => {
  // The delivering activation and its callee share a `Store` — necessarily so:
  // a `subtask.cancel` delivery is intra-store (instances of one linked graph
  // share a Store, and activations never cross stores). With the gate per
  // store (#158 mechanism B), "the caller's entry" and "the callee's entry"
  // are entries in that one store's set.
  const store = new Store();
  const caller = mkWorld({ store });
  const callee = mkWorld({ store });
  try {
    const parked = parkOnWait(callee, true);
    rejection(parked.parked); // handled: this park is abandoned by the test
    // The caller's activation was engine-resumed (entry pending) and its wasm
    // is now running under its wasm-entry bracket, where it synchronously
    // delivers a cancellation whose `produce` SUCCEEDS (TASK_CANCELLED).
    store.addPendingResumption(caller.thread);
    withActivation(caller.thread, () => parked.point.resume(true));
    assert(
      !store.pendingResumptions.has(caller.thread),
      "the caller's entry was consumed: its window closed when it ran",
    );
    assert(
      store.pendingResumptions.has(callee.thread),
      "the callee's resumption is now pending",
    );
  } finally {
    cleanupAmbient(caller, callee);
  }
});

Deno.test("resume trap arm: delivery from the pending-entry holder consumes it too (#158 mechanism A)", async () => {
  const store = new Store();
  const caller = mkWorld({ store });
  const callee = mkWorld({ store });
  try {
    const parked = parkOnWait(callee, false);
    const outcome = rejection(parked.parked);
    store.addPendingResumption(caller.thread);
    let threw: unknown = null;
    try {
      // Resume with no pending event: `produce` throws — the
      // trap-at-resume-time arm of `#resumeInner`. Before the #158 mechanism-A
      // fix this arm recorded the resumed ambient WITHOUT consuming the
      // caller's, so the (then single-slot) gate asserted and preempted
      // `#fail(e)`.
      withActivation(caller.thread, () => parked.point.resume(false));
    } catch (e) {
      threw = e;
    }
    assert(
      threw === null,
      `no assertion may escape resume(); got: ${String(threw)}`,
    );
    // `resume` never rethrows a `produce` error — it goes to `#fail`, i.e. the
    // parked import Promise rejects and the engine turns that into a trap.
    const r = await outcome;
    assert(r.ok === false, "the parked promise rejected");
    const msg = String(r.e);
    assert(
      !msg.includes("two activations claim the resumed ambient"),
      `the guest must receive its own trap, not the #158 assertion: ${msg}`,
    );
    assert(
      !store.pendingResumptions.has(caller.thread),
      "the caller's entry was consumed on the trap arm too",
    );
    assert(
      store.pendingResumptions.has(callee.thread),
      "the callee's unwind resumption is pending",
    );
  } finally {
    cleanupAmbient(caller, callee);
  }
});

Deno.test("resume from an EMPTY bracket self-consumes via the claims-top fallback", () => {
  // One store, two activations of it (the shape the fallback exists for).
  const store = new Store();
  const a = mkWorld({ store });
  const b = mkWorld({ store });
  try {
    const parkedA = parkOnWait(a, true);
    const parkedB = parkOnWait(b, true);
    rejection(parkedA.parked), rejection(parkedB.parked); // handled
    // First resumption: B's cancellation delivered from outside any activation
    // (a driver) — records B, both the activation-ambient claim and the
    // store's pending entry.
    parkedB.point.resume(true);
    assert(store.pendingResumptions.has(b.thread), "B's entry is pending");
    // Second resumption in the same turn, again from an empty bracket:
    // `activationOf()` is the entryStack top ?? the activation-claims top, and
    // after the first resume the claims top IS B — so
    // `consumePendingIfRunning` self-consumes B's entry and nothing asserts.
    // (Attribution for B's pending chunk is lost, but that is a different
    // hazard.)
    let threw: unknown = null;
    try {
      parkedA.point.resume(true);
    } catch (e) {
      threw = e;
    }
    assert(threw === null, `expected no assert, got: ${String(threw)}`);
    assert(
      !store.pendingResumptions.has(b.thread),
      "B's entry was self-consumed via the claims-top fallback",
    );
    assert(store.pendingResumptions.has(a.thread), "A's entry is pending");
  } finally {
    cleanupAmbient(a, b);
  }
});

Deno.test("resume from a DIFFERENT running activation while a resumption is pending — cross-store (#158 mechanism B)", () => {
  // FLIPPED 2026-08-22. This is issue #158's mechanism B. It used to assert:
  // the resumed-ambient gate was a single global slot, so a resumption
  // delivered by an activation that is NOT the entry holder could not be
  // reconciled by `consumeClaimIfRunning` and tripped the one-claimant assert.
  // The gate is now the per-Store, multi-entry `Store.pendingResumptions`;
  // both resumptions are legitimately pending and nothing asserts.
  const x = mkWorld(); // the activation actually running (a dispatched tail's
  // guest chunk, under its own wasm-entry bracket)
  const y = mkWorld(); // the settled-but-not-yet-run activation
  const z = mkWorld(); // the parked activation X delivers to
  try {
    const parkedZ = parkOnWait(z, true);
    rejection(parkedZ.parked); // handled
    // Y's suspension was settled (entry pending), Y's engine chunk has not run.
    y.store.addPendingResumption(y.thread);
    // X's guest chunk synchronously delivers a cancellation to Z — the SUCCESS
    // arm, whose `consumePendingIfRunning` compares activationOf() (= X)
    // against Z's store's set and correctly consumes nothing.
    let threw: unknown = null;
    try {
      withActivation(x.thread, () => parkedZ.point.resume(true));
    } catch (e) {
      threw = e;
    }
    assert(threw === null, `expected no throw, got: ${String(threw)}`);
    assert(y.store.pendingResumptions.has(y.thread), "Y's entry survives");
    assert(z.store.pendingResumptions.has(z.thread), "Z's entry was recorded");
    // Cross-store: neither store's gate is affected by the other's entry
    // (issue #210 — this is what de-serializes independent instantiations).
    assert(
      x.store.pendingResumptions.size === 0,
      "X's own store carries no entry",
    );
  } finally {
    cleanupAmbient(x, y, z);
  }
});

Deno.test("resume from a DIFFERENT running activation while a resumption is pending — same store (#158 mechanism B)", () => {
  // The same shape with all three activations in ONE store: the set holds both
  // pending entries, and the store's gate refuses to schedule while either
  // lives — two legitimately-pending resumptions, neither of which may be
  // dropped.
  const store = new Store();
  const x = mkWorld({ store });
  const y = mkWorld({ store });
  const z = mkWorld({ store });
  try {
    const parkedZ = parkOnWait(z, true);
    rejection(parkedZ.parked); // handled
    store.addPendingResumption(y.thread);
    let threw: unknown = null;
    try {
      withActivation(x.thread, () => parkedZ.point.resume(true));
    } catch (e) {
      threw = e;
    }
    assert(threw === null, `expected no throw, got: ${String(threw)}`);
    assert(
      store.pendingResumptions.has(y.thread) &&
        store.pendingResumptions.has(z.thread),
      "both resumptions are pending in the shared store",
    );
    assert(
      store.tick() === false,
      "the gate refuses to schedule while entries pend",
    );
  } finally {
    cleanupAmbient(x, y, z);
  }
});

Deno.test("guest-shaped: a trapping cancellation delivery while the canceller's claim is live (#158 mechanism A)", async () => {
  // The f7abf96 class ("request_cancellation: a trap during delivery poisons
  // the callee", task_test.ts) on the SuspensionPoint arm: the callee is
  // parked in a cancellable built-in whose `produce` traps when handed
  // `cancelled`, and the canceller delivers it while still holding its own
  // engine-resume claim.
  // Intra-store, as a real cancellation delivery is.
  const store = new Store();
  const callee = mkWorld({ store });
  const canceller = mkWorld({ store });
  try {
    const parked = callee.run(() =>
      blockCurrentActivation<number>({
        store: callee.store,
        task: callee.task,
        readyFunc: null,
        cancellable: true,
        produce: (cancelled) => {
          if (cancelled) throw new Trap("boom during cancel delivery");
          return 0;
        },
      })
    );
    const outcome = rejection(parked);
    const point = callee.point();
    assert(point !== undefined, "the suspension point is waiting");

    store.addPendingResumption(canceller.thread);
    let threw: unknown = null;
    try {
      withActivation(
        canceller.thread,
        () => callee.task.requestCancellation(null),
      );
    } catch (e) {
      threw = e;
    }
    assert(
      !String(threw).includes("two activations claim the resumed ambient"),
      `the #158 assertion must not preempt the trap: ${String(threw)}`,
    );
    assert(
      callee.task.state === "cancel-delivered",
      `parity: the state is set first, got ${callee.task.state}`,
    );
    // `SuspensionPoint.resume` never rethrows a `produce` error: the trap
    // reaches the guest as a rejection of the import's Promise (the engine
    // turns it back into a wasm trap), so `requestCancellation` sees no throw
    // on this arm and the instance-poisoning branch of its catch does not run.
    // See the report on #158: whether the SP arm should also poison is a
    // separate question from the mechanism-A claim asymmetry fixed here.
    const r = await outcome;
    assert(r.ok === false, "the parked promise rejected");
    assert(
      String(r.e).includes("boom during cancel delivery"),
      `the guest receives its own trap: ${String(r.e)}`,
    );
    assert(
      isInstancePoisoned(callee.inst) === false &&
        instancePoisonCause(callee.inst) === undefined,
      "pinning current behavior: the SP arm does not poison the callee",
    );
  } finally {
    cleanupAmbient(callee, canceller);
  }
});
