// Park-scoped state must be discharged on EVERY settle path (issue #106) —
// the cleanup-only-in-produce siblings enumerated by the #102 track.
//
// Authority: contracts/intrinsics.md §A's trap-unwind/lender-release
// obligation for the lender sites; `SuspensionPoint.onSettled`
// (jspi/bridge.ts, #102) is the mechanism. The settle-path enumeration these
// tests walk is the one pinned in resource_lender_park_settle_test.ts:
// produce-success / produce-throw / abandon (a cancelled resume of a
// non-cancellable park is not a settle, and never-settled dies with the
// store).
//
// Sites covered, matching the #106 numbering:
//   1. stream sync copy park        — `end.hasSyncWaiter` (SITE 4 lit)
//   2. waitable-set.wait park       — `wset.numWaiting`   (SITE 2 lit)
//   3. subtask.cancel sync park     — `st.hasSyncWaiter`  (SITE 5 lit)
//   4. sync host-import park        — the subtask's LENDERS; produce-throw is
//      exempt-by-poisoning (analysis at the site), abandon is not (#102 pins
//      an abandoned park as non-poisoning), so the hook discharges it.
//   5. (found during closure) the `needsJspi` bail in the same lowering runs
//      AFTER `onStart` lifted borrows — a capability signal is expressly
//      non-poisoning and must not strand lenders.

import { assertEq } from "./support/asserts.ts";
import {
  createSubtaskCancel,
  createWaitableSetDrop,
  createWaitableSetWait,
} from "../src/intrinsics/async_builtins.ts";
import {
  createStreamCancelRead,
  createStreamRead,
} from "../src/intrinsics/stream_builtins.ts";
import {
  createLoweredImport,
  newStats,
  type ResolvedOptions,
} from "../src/exec/boundary.ts";
import {
  ComponentInstanceState,
  NeedsJspi,
  popCurrentThread,
  pushCurrentThread,
  ReadableStreamEnd,
  SharedStreamImpl,
  Store,
  Subtask,
  Task,
  type TaskOptions,
  Thread,
  WaitableSet,
} from "../src/task/mod.ts";
import type { SuspensionPoint } from "../src/jspi/mod.ts";
import {
  canonResourceDrop,
  canonResourceNew,
  ResourceHandle,
  ResourceTypeInfo,
} from "../src/cabi/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

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

/** One instance, one live thread, and the point-finder the #102 tests use. */
function mkWorld() {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const task = new Task(ASYNC_FT, CALLBACK_OPTS, inst, () => [], () => {});
  task.state = "started";
  const thread = new Thread(task, (function* () {})());
  return {
    store,
    inst,
    task,
    thread,
    point(): SuspensionPoint<unknown> | undefined {
      return store.waiting.find(
        (w) => typeof (w as { resume?: unknown }).resume === "function" &&
          typeof (w as { abandon?: unknown }).abandon === "function",
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

const rejected = (p: Promise<unknown>) =>
  p.then(() => "resolved", (e) => `rejected: ${(e as Error).message}`);

// ---------------------------------------------------------------------------
// SITE 2: waitable-set.wait — `numWaiting`
// ---------------------------------------------------------------------------

function parkOnWait(cancellable: boolean) {
  const w = mkWorld();
  const wset = new WaitableSet();
  const seti = w.inst.handles.add(wset);
  const o = opts(w.inst, { cancellable });
  const ctx = { componentInstance: () => w.inst, options: () => o, resultTypes: () => [] };
  const wait = createWaitableSetWait({ options: 0 }, ctx, w.inst, "jspi");
  const parked = w.run(() => wait(seti, 0));
  assert(parked instanceof Promise, "the wait parked");
  assertEq(wset.numWaiting, 1);
  const point = w.point();
  assert(point !== undefined, "the suspension point is waiting");
  const drop = createWaitableSetDrop(w.inst);
  return { ...w, wset, seti, parked, point, drop };
}

Deno.test("#106 SITE 2: abandon discharges numWaiting; waitable-set.drop stays legal", async () => {
  const t = parkOnWait(false);
  const settled = rejected(t.parked as Promise<unknown>);
  t.point.abandon(new Error("store teardown"));
  assertEq(t.wset.numWaiting, 0);
  // The observable the counter exists for: drop no longer traps
  // "cannot drop waitable set with waiters" against a waiter that is gone.
  t.drop(t.seti);
  assertEq(await settled, "rejected: store teardown");
});

Deno.test("#106 SITE 2: cancelled resume decrements exactly once (produce runs, hook is sole owner)", async () => {
  const t = parkOnWait(true);
  // Deliver cancellation exactly as Task.requestCancellation does — the
  // produce(cancelled=true) leg (cancel_bracket_race_test.ts's machinery).
  t.task.requestCancellation(null);
  await (t.parked as Promise<unknown>);
  assertEq(t.wset.numWaiting, 0); // 0, not -1: the decrement is not doubled
  t.drop(t.seti);
});

Deno.test("#106 SITE 2: produce-throw still discharges numWaiting", async () => {
  const t = parkOnWait(false);
  const settled = rejected(t.parked as Promise<unknown>);
  // resume with no pending event: `produce` calls `getPendingEvent()` on an
  // empty set and throws — the produce-throw settle leg.
  t.point.resume(false);
  assertEq(t.wset.numWaiting, 0);
  t.drop(t.seti);
  assert((await settled).startsWith("rejected:"), "the park rejected");
});

// ---------------------------------------------------------------------------
// SITE 4 (lit): stream sync copy — `end.hasSyncWaiter`
// ---------------------------------------------------------------------------

Deno.test("#106 SITE 4: abandon clears hasSyncWaiter; cancel-copy and drop stay legal", async () => {
  const w = mkWorld();
  const shared = new SharedStreamImpl(null);
  const readEnd = new ReadableStreamEnd(shared);
  const ri = w.inst.handles.add(readEnd);
  const o = opts(w.inst);
  const ctx = {
    componentInstance: () => w.inst,
    options: () => o,
    streamElem: () => null,
    futureElem: () => null,
    resultTypes: () => [],
    suspensionMode: "jspi" as const,
  };
  const read = createStreamRead({ streamTable: 0, options: 0 }, ctx, w.inst);
  const parked = w.run(() => read(ri, 0, 4));
  assert(parked instanceof Promise, "the sync read parked (no counterpart)");
  assertEq(readEnd.hasSyncWaiter, true);
  const settled = rejected(parked as Promise<unknown>);
  const point = w.point();
  assert(point !== undefined, "the suspension point is waiting");

  point.abandon(new Error("store teardown"));

  assertEq(readEnd.hasSyncWaiter, false);
  // The observables the flag exists for: a concurrent cancel-copy trapped
  // "sync waiter" while set (cancelCopy), and Waitable.drop asserts
  // `!hasSyncWaiter`. Both must be legal again once no waiter exists.
  const cancel = createStreamCancelRead({ streamTable: 0, async: false }, ctx, w.inst);
  w.run(() => cancel(ri));
  assertEq(await settled, "rejected: store teardown");
});

// ---------------------------------------------------------------------------
// SITE 5 (lit): subtask.cancel sync park — `st.hasSyncWaiter`
// ---------------------------------------------------------------------------

Deno.test("#106 SITE 5: abandon clears the subtask's hasSyncWaiter", async () => {
  const w = mkWorld();
  const st = new Subtask();
  st.onCancel = () => {}; // accepts and ignores, like a host import
  const sti = w.inst.handles.add(st);
  const cancel = createSubtaskCancel({ async: false }, w.inst, "jspi");
  const parked = w.run(() => cancel(sti));
  assert(parked instanceof Promise, "sync subtask.cancel parked (unresolved callee)");
  assertEq(st.hasSyncWaiter, true);
  const settled = rejected(parked as Promise<unknown>);
  const point = w.point();
  assert(point !== undefined, "the suspension point is waiting");

  point.abandon(new Error("store teardown"));

  assertEq(st.hasSyncWaiter, false);
  assertEq(await settled, "rejected: store teardown");
});

// ---------------------------------------------------------------------------
// Sync host-import park — subtask lenders (+ the needsJspi bail, site 5 of
// the #106 closure)
// ---------------------------------------------------------------------------

function mkImportWorld(input: {
  hostFn: (...a: unknown[]) => unknown;
  mode: "plain" | "jspi";
  suspendable: boolean;
}) {
  const w = mkWorld();
  const rt = new ResourceTypeInfo(w.inst, () => {});
  const handleIndex = canonResourceNew(w.inst, rt, 77);
  const handle = w.inst.handles.get(handleIndex) as ResourceHandle;
  const ft: FuncType = {
    params: [{ kind: "borrow", rt }],
    results: [],
    async: false,
  };
  const call = createLoweredImport({
    name: "lend-to-host",
    ft,
    opts: opts(w.inst, {
      // Sync lower of (borrow) -> (): one flat i32 param, no results.
      coreType: { params: ["i32"], results: [] },
    }),
    hostFn: input.hostFn,
    stats: newStats(),
    mode: input.mode,
    suspendable: input.suspendable,
    deferCancel: false,
    abortable: false,
  }) as (...args: number[]) => unknown;
  return { ...w, rt, handle, handleIndex, call };
}

Deno.test("#106 host-import park: abandon releases the subtask's lenders (caller not poisoned)", async () => {
  const t = mkImportWorld({
    hostFn: () => new Promise(() => {}),
    mode: "jspi",
    suspendable: true,
  });
  const parked = t.run(() => t.call(t.handleIndex));
  assert(parked instanceof Promise, "the sync suspending import parked");
  assertEq(t.handle.numLends, 1); // lent for the duration of the call
  const settled = rejected(parked as Promise<unknown>);
  const point = t.point();
  assert(point !== undefined, "the suspension point is waiting");

  point.abandon(new Error("store teardown"));

  assertEq(t.handle.numLends, 0);
  // An abandoned park does NOT poison the caller (the
  // resource_lender_park_settle_test.ts pin), so the handle must remain
  // usable — this drop trapped "handle still lent out" before the hook.
  canonResourceDrop(t.inst, t.rt, t.handleIndex);
  assertEq(await settled, "rejected: store teardown");
});

Deno.test("#106 host-import park: success path releases exactly once (hook observes resolveDelivered)", async () => {
  let resolve!: (v: unknown) => void;
  const t = mkImportWorld({
    hostFn: () => new Promise((r) => (resolve = r)),
    mode: "jspi",
    suspendable: true,
  });
  const parked = t.run(() => t.call(t.handleIndex));
  assert(parked instanceof Promise, "the sync suspending import parked");
  assertEq(t.handle.numLends, 1);
  const point = t.point();
  assert(point !== undefined, "the suspension point is waiting");

  resolve(undefined);
  await Promise.resolve(); // the recorded-outcome microtask
  point.resume(false); // produce: onResolve + deliverResolve, then the hook
  await parked;

  // deliverResolve ran inside produce; the onSettled backstop saw
  // `resolveDelivered()` and stayed out of the way (a double release would
  // throw AssertionError inside the hook and be reported, and the count
  // would go negative — 0 pins both).
  assertEq(t.handle.numLends, 0);
  canonResourceDrop(t.inst, t.rt, t.handleIndex);
});

Deno.test("#106 host-import park: rejection (produce-throw) — poisoning trap, lenders unwound as belt-and-braces", async () => {
  let reject!: (e: unknown) => void;
  const t = mkImportWorld({
    hostFn: () => new Promise((_, r) => (reject = r)),
    mode: "jspi",
    suspendable: true,
  });
  const parked = t.run(() => t.call(t.handleIndex));
  assert(parked instanceof Promise, "the sync suspending import parked");
  const settled = rejected(parked as Promise<unknown>);
  const point = t.point();
  assert(point !== undefined, "the suspension point is waiting");

  reject(new Error("host bug"));
  await Promise.resolve();
  point.resume(false); // produce throws `done.error` — the trap path

  // This settle poisons the caller (the trap-unwind/lender-release obligation
  // owes no release here — the analysis lives at the site); the hook unwinds anyway as harmless
  // bookkeeping, which this pins so a future refactor keeps it deliberate.
  assertEq(t.handle.numLends, 0);
  assertEq(await settled, "rejected: host bug");
});

Deno.test("#106 needsJspi bail: a capability signal after onStart must not strand lenders", () => {
  // jspi mode but the import is NOT suspending()-marked: the lowering lifts
  // the borrow (numLends -> 1), then bails NeedsJspi before any park exists.
  const t = mkImportWorld({
    hostFn: () => new Promise(() => {}),
    mode: "jspi",
    suspendable: false,
  });
  let threw: unknown = null;
  try {
    t.run(() => t.call(t.handleIndex));
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof NeedsJspi, "the sync lower bailed NeedsJspi");
  // NeedsJspi is expressly non-poisoning (the trap-unwind/lender-release obligation): the caller keeps
  // running, so the lend must have been discharged...
  assertEq(t.handle.numLends, 0);
  // ...and the handle must remain fully usable.
  canonResourceDrop(t.inst, t.rt, t.handleIndex);
});
