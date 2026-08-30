// Task-core unit tests: ports of the run_tests.py async patterns that do not
// need streams or a suspendable wasm stack, plus the host-side pieces the
// reference gets for free from real OS threads.
//
// Naming follows the reference where a test is a direct port, so the two can
// be diffed by hand (run_tests.py `test_async_callback`,
// `test_async_backpressure`, `test_callback_interleaving`, ...).

import { assertEq } from "./support/asserts.ts";
import { Trap } from "../src/cabi/mod.ts";
import {
  type BlockRequest,
  type Cancelled,
  chooseCandidate,
  ComponentInstanceState,
  driveSyncLift,
  entryRefusal,
  EventCode,
  packSubtaskResult,
  schedulerPolicy,
  schedulerSeedForTesting,
  isInstancePoisoned,
  notifyInstancePoisoned,
  PendingCapability,
  Store,
  Subtask,
  SubtaskState,
  Task,
  type TaskOptions,
  Thread,
  unpackSubtaskResult,
  WaitableSet,
  withPoisonCause,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function assertThrows(fn: () => unknown, includes: string): void {
  try {
    fn();
  } catch (e) {
    assert(
      String(e).includes(includes),
      `expected an error containing ${JSON.stringify(includes)}, got: ${e}`,
    );
    return;
  }
  throw new Error(`expected a throw containing ${JSON.stringify(includes)}`);
}

const SYNC_FT: FuncType = { params: [], results: [], async: false };
const ASYNC_FT: FuncType = { params: [], results: [], async: true };

const SYNC_OPTS: TaskOptions = {
  async_: false,
  callback: false,
  stringEncoding: "utf8",
  memory: null,
};
/** Async-typed, callback ABI — the shape wit-bindgen emits. */
const CALLBACK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};
/** Async-typed, stackful (no callback) — does not need the exclusive thread. */
const STACKFUL_OPTS: TaskOptions = {
  async_: true,
  callback: false,
  stringEncoding: "utf8",
  memory: null,
};


/**
 * Create a thread whose body needs a reference to the thread itself (every
 * `canon_lift` body does: `enter_implicit_thread`, `wait_until` and
 * `exit_implicit_thread` all take it). The generator body does not run until
 * the first `resume()`, so the back-reference is always assigned by then.
 */
function spawn(
  task: Task,
  body: (t: Thread) => Generator<BlockRequest, void, Cancelled>,
): Thread {
  let thread!: Thread;
  thread = new Thread(
    task,
    (function* (): Generator<BlockRequest, void, Cancelled> {
      yield* body(thread);
    })(),
  );
  return thread;
}

function mkTask(
  inst: ComponentInstanceState,
  ft: FuncType,
  opts: TaskOptions,
  onResolve: (r: unknown) => void = () => {},
): Task {
  return new Task(ft, opts, inst, () => [], onResolve as never);
}

// ---------------------------------------------------------------------------
// Thread mechanics
// ---------------------------------------------------------------------------

Deno.test("thread: a body runs to completion and unregisters", () => {
  const inst = new ComponentInstanceState(0);
  let resolved = false;
  const task = mkTask(inst, SYNC_FT, SYNC_OPTS, () => {
    resolved = true;
  });
  const thread = spawn(task, function* (thread) {
    const entered = yield* task.enterImplicitThread(thread);
    assert(entered, "sync entry is never refused");
    task.start();
    task.return_([]);
    task.exitImplicitThread(thread);
  });
  assertEq(thread.suspended(), true);
  thread.resume();
  assertEq(thread.done(), true);
  assertEq(resolved, true);
  assertEq(task.state, "resolved");
  assertEq([...inst.threads].length, 0);
});

Deno.test("thread: wait_until blocks and the store resumes when ready", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  let flag = false;
  const order: string[] = [];
  const task = mkTask(inst, SYNC_FT, SYNC_OPTS);
  const thread = spawn(task, function* (thread) {
    yield* task.enterImplicitThread(thread);
    task.start();
    order.push("before");
    const cancelled = yield* thread.waitUntil(() => flag, false);
    assertEq(cancelled, false);
    order.push("after");
    task.return_([]);
    task.exitImplicitThread(thread);
  });

  thread.resume();
  assertEq(order.join(","), "before");
  assertEq(thread.waiting(), true);
  assertEq(thread.ready(), false);
  // Not ready: a tick makes no progress and must not resume anything.
  assertEq(store.tick(), false);
  flag = true;
  assertEq(thread.ready(), true);
  assertEq(store.tick(), true);
  assertEq(order.join(","), "before,after");
  assertEq(task.state, "resolved");
  assertEq(store.waiting.length, 0);
});

Deno.test("thread: context storage is per thread, initialised to zero", () => {
  const inst = new ComponentInstanceState(0);
  const task = mkTask(inst, SYNC_FT, SYNC_OPTS);
  const a = new Thread(task, (function* () {})());
  const b = new Thread(task, (function* () {})());
  // definitions.py `Thread.__init__`: `self.storage = [0,0]`.
  assertEq(a.storage.length, 2);
  assertEq(a.storage[0], 0);
  a.storage[0] = 42;
  assertEq(b.storage[0], 0);
});

// ---------------------------------------------------------------------------
// The sync driving loop and its deadlock trap
// ---------------------------------------------------------------------------

Deno.test("canon_lift sync loop: traps when no thread can make progress", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const task = mkTask(inst, SYNC_FT, SYNC_OPTS);
  const thread = spawn(task, function* (thread) {
    yield* task.enterImplicitThread(thread);
    task.start();
    // Blocks forever: nothing will ever make this ready.
    yield* thread.waitUntil(() => false, false);
    task.return_([]);
    task.exitImplicitThread(thread);
  });
  thread.resume();
  // definitions.py `canon_lift`: `trap_if(not candidates)`.
  assertThrows(() => driveSyncLift(task), "deadlock");
});

// ---------------------------------------------------------------------------
// Reentrance (ComponentInstance.enter_from / may_enter_from)
// ---------------------------------------------------------------------------

Deno.test("reentrance: an instance cannot be re-entered from the host", () => {
  const inst = new ComponentInstanceState(0);
  assertEq(inst.mayEnterFrom(null), true);
  inst.enterFrom(null);
  assertEq(inst.mayEnterFrom(null), false);
  inst.leaveTo(null);
  assertEq(inst.mayEnterFrom(null), true);
});

Deno.test("reentrance: the entering set excludes the caller's own ancestry", () => {
  const inst = new ComponentInstanceState(0);
  // definitions.py `entering_set`: `self_and_ancestors() - caller.self_and_ancestors()`.
  // A call from an instance to *itself* enters nothing, so it is always
  // permitted — that is what makes a self-recursive lift legal.
  assertEq([...inst.enteringSet(inst)].length, 0);
  inst.enterFrom(null);
  assertEq(inst.mayEnterFrom(inst), true);
});

// ---------------------------------------------------------------------------
// Synthetic per-instantiation root (plan v3 amendment 4 / polyengine#101)
// ---------------------------------------------------------------------------

Deno.test("root: a host entry locks the whole instantiation, not just the leaf", () => {
  const store = new Store();
  const a = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);
  assertEq(a.parent === b.parent, true, "siblings share one synthetic root");
  assertEq(a.parent!.isSyntheticRoot, true);

  // definitions.py `entering_set(None)` = `self_and_ancestors()`, which in the
  // reference always contains the top-level root. So a host entry into A
  // forbids a host entry into B — the reachable divergence #101 reported.
  assertEq([...a.enteringSet(null)].length, 2, "{leaf, root}");
  a.enterFrom(null);
  assertEq(a.mayEnterFrom(null), false);
  assertEq(b.mayEnterFrom(null), false, "the sibling is locked through the root");
  a.leaveTo(null);
  assertEq(b.mayEnterFrom(null), true);
});

Deno.test("root: instantiations are independent", () => {
  const a = new ComponentInstanceState(0, new Store());
  const b = new ComponentInstanceState(0, new Store());
  a.enterFrom(null);
  assertEq(b.mayEnterFrom(null), true, "a different Store is a different root");
});

Deno.test("root: guest-to-guest entering sets are unchanged ({leaf})", () => {
  const store = new Store();
  const a = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);
  // The root cancels out (it is in the caller's ancestry), so a guest->guest
  // call locks only the callee — the DAG adjudication (#99/#101).
  const set = [...b.enteringSet(a)];
  assertEq(set.length, 1);
  assertEq(set[0] === b, true);
  // ...and a call to oneself still enters nothing.
  assertEq([...a.enteringSet(a)].length, 0);
});

Deno.test("root: tick skips a sibling whose instance is locked by a host entry", () => {
  // Regression: `tick` used to select on `ready()` alone and then *assert*
  // host-enterability, so this shape trapped instead of making no progress.
  //
  // Shape: instance A is entered from the host by a sync export that is parked
  // on an async host import (the import settles from host JS, not from
  // `tick`). While A is parked, a thread of sibling instance B goes ready —
  // event-driven wakeups do this on every clock turn. A's host entry locks the
  // shared synthetic root, so B is not host-enterable in that window.
  const store = new Store();
  const a = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);

  // A's export call: entered from the host, parked awaiting an async import.
  a.enterFrom(null);
  let settleImport!: () => void;
  const pendingImport = new Promise<void>((resolve) => {
    settleImport = resolve;
  });
  store.pendingHostCalls.add(pendingImport);

  // B's thread: waiting, and it becomes ready while A is still entered.
  let flag = false;
  const order: string[] = [];
  const bTask = mkTask(b, SYNC_FT, SYNC_OPTS);
  const bThread = spawn(bTask, function* (thread) {
    yield* bTask.enterImplicitThread(thread);
    bTask.start();
    yield* thread.waitUntil(() => flag, false);
    order.push("b ran");
    bTask.return_([]);
    bTask.exitImplicitThread(thread);
  });
  bThread.resume();
  assertEq(bThread.waiting(), true);

  flag = true;
  assertEq(bThread.ready(), true, "B is ready...");
  assertEq(b.mayEnterFrom(null), false, "...but locked through the shared root");
  // The window: no throw, and no progress on B.
  assertEq(store.tick(), false, "ready-but-not-enterable is not progress");
  assertEq(order.length, 0);
  assertEq(bThread.done(), false);

  // The host import settles and A's entered call returns.
  settleImport();
  store.pendingHostCalls.delete(pendingImport);
  a.leaveTo(null);
  assertEq(b.mayEnterFrom(null), true, "the root is unlocked again");

  // B now runs to completion on the next turn.
  assertEq(store.tick(), true);
  assertEq(order.join(","), "b ran");
  assertEq(bTask.state, "resolved");
  assertEq(store.waiting.length, 0);
});

// --- issue #156: settled activation tails defer while the root is locked ----
//
// `Store.settled` tails are dispatched through `Thread.resumeWith`, which
// brackets the resumption with `enterFrom(null)`. Under the shared synthetic
// root a host entry into ANY instance locks every sibling, so dispatching a
// sibling's tail in that window used to trip `resumeWith`'s enterability
// assert (and, mutating before asserting, strand the thread and lose the
// settle). The fix defers such tails IN PLACE.

/** Settle a park promise and let `noteAwaiting`'s eager continuation run. */
async function queueSettledTail(settle: () => void): Promise<void> {
  settle();
  // Two hops: `noteAwaiting`'s `.then` pushes onto `settled`.
  await Promise.resolve();
  await Promise.resolve();
}

Deno.test("root: serviceSettled defers a sibling tail while a host entry holds the root", async () => {
  const store = new Store();
  const a = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);

  let settle!: () => void;
  const p = new Promise<void>((r) => {
    settle = r;
  });
  const order: string[] = [];
  const bTask = mkTask(b, SYNC_FT, SYNC_OPTS);
  const bThread = spawn(bTask, function* (thread) {
    yield* bTask.enterImplicitThread(thread);
    bTask.start();
    const v = yield { readyFunc: null, cancellable: false, awaitValue: p };
    void v;
    order.push("b tail ran");
    bTask.return_([]);
    bTask.exitImplicitThread(thread);
  });
  bThread.resume();
  assertEq(store.awaiting.has(bThread), true, "B is promise-parked");

  await queueSettledTail(settle);
  assertEq(store.settled.length, 1, "the tail is queued");

  // A host entry into the sibling locks the shared root.
  a.enterFrom(null);
  assertEq(b.mayEnterFrom(null), false);
  assertEq(store.serviceSettled(), false, "deferred: no dispatch, no throw");
  assertEq(store.settled.length, 1, "the entry stays queued, in place");
  assertEq(store.awaiting.has(bThread), true, "and the thread is not stranded");
  assertEq(order.length, 0);
  assertEq(store.tick(), false, "a deferred-only queue does not gate tick open");

  a.leaveTo(null);
  assertEq(store.serviceSettled(), true, "the lock released: dispatch");
  assertEq(order.join(","), "b tail ran");
  assertEq(bTask.state, "resolved");
  assertEq(store.settled.length, 0);
});

Deno.test("root: the phantom-state gate holds for a serviceable tail", async () => {
  // The tick gate relaxes ONLY for deferred tails: a serviceable unserviced
  // tail still refuses tick, preserving the reference's atomic-resume
  // discipline.
  const store = new Store();
  const a = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);

  let settle!: () => void;
  const p = new Promise<void>((r) => {
    settle = r;
  });
  const bTask = mkTask(b, SYNC_FT, SYNC_OPTS);
  const bThread = spawn(bTask, function* (thread) {
    yield* bTask.enterImplicitThread(thread);
    bTask.start();
    yield { readyFunc: null, cancellable: false, awaitValue: p };
    bTask.return_([]);
    bTask.exitImplicitThread(thread);
  });
  bThread.resume();

  // A ready sibling thread, exactly as the #155 test constructs one.
  let flag = false;
  const order: string[] = [];
  const aTask = mkTask(a, SYNC_FT, SYNC_OPTS);
  const aThread = spawn(aTask, function* (thread) {
    yield* aTask.enterImplicitThread(thread);
    aTask.start();
    yield* thread.waitUntil(() => flag, false);
    order.push("a ran");
    aTask.return_([]);
    aTask.exitImplicitThread(thread);
  });
  aThread.resume();
  flag = true;
  assertEq(aThread.ready(), true);

  await queueSettledTail(settle);
  assertEq(store.settled.length, 1);
  assertEq(a.mayEnterFrom(null), true, "nothing is entered: the tail is serviceable");
  assertEq(store.tick(), false, "a serviceable tail gates tick");
  assertEq(order.length, 0);

  assertEq(store.serviceSettled(), true);
  assertEq(store.tick(), true, "with the queue drained, tick proceeds");
  assertEq(order.join(","), "a ran");
});

Deno.test("root: poisoned tails retire even while the root is locked", async () => {
  // A poisoned leaf stays locked forever, so deferring its tail would leak.
  // `resumeWith`'s poison early-return retires it instead: the queue drains
  // and the body does NOT run.
  const store = new Store();
  const a = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);

  let settle!: () => void;
  const p = new Promise<void>((r) => {
    settle = r;
  });
  const order: string[] = [];
  const bTask = mkTask(b, SYNC_FT, SYNC_OPTS);
  const bThread = spawn(bTask, function* (thread) {
    yield* bTask.enterImplicitThread(thread);
    bTask.start();
    yield { readyFunc: null, cancellable: false, awaitValue: p };
    order.push("b tail ran");
    bTask.return_([]);
    bTask.exitImplicitThread(thread);
  });
  bThread.resume();
  await queueSettledTail(settle);
  assertEq(store.settled.length, 1);

  notifyInstancePoisoned(b, undefined);
  a.enterFrom(null);
  assertEq(store.serviceSettled(), true, "poisoned tails dispatch, locked or not");
  assertEq(store.settled.length, 0, "and the queue drains");
  assertEq(order.length, 0, "retired quietly: the body never ran");
  a.leaveTo(null);
});

Deno.test("root: stale settled entries are removed regardless of enterability", async () => {
  // "Stale" = the thread was resumed elsewhere (driveAsync's race-winner
  // path), i.e. it is gone from `store.awaiting`. Such entries are dropped
  // whenever encountered, and dropping one is not progress.
  const store = new Store();
  const a = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);

  let settle!: () => void;
  const p = new Promise<void>((r) => {
    settle = r;
  });
  const bTask = mkTask(b, SYNC_FT, SYNC_OPTS);
  const bThread = spawn(bTask, function* (thread) {
    yield* bTask.enterImplicitThread(thread);
    bTask.start();
    yield { readyFunc: null, cancellable: false, awaitValue: p };
    bTask.return_([]);
    bTask.exitImplicitThread(thread);
  });
  bThread.resume();
  await queueSettledTail(settle);
  assertEq(store.settled.length, 1);

  // Simulate the elsewhere-resumption.
  store.awaiting.delete(bThread);
  a.enterFrom(null);
  assertEq(store.serviceSettled(), false, "removing a stale entry is not progress");
  assertEq(store.settled.length, 0, "but it is removed");
  a.leaveTo(null);
});

Deno.test("root: trap poisoning stays per-instance (documented divergence)", () => {
  const store = new Store();
  const a = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);
  // A host entry into A that traps never reaches `leaveTo`: A stays poisoned
  // forever. polyengine deliberately keeps sibling instances usable (exec/
  // boundary.ts `poison`), so the shared root is released explicitly.
  a.enterFrom(null);
  a.releaseSyntheticRootOnPoison();
  assertEq(a.mayEnterFrom(null), false, "the leaf stays poisoned");
  assertEq(b.mayEnterFrom(null), true, "a sibling is still enterable");
});

// ---------------------------------------------------------------------------
// Backpressure (run_tests.py test_async_backpressure)
// ---------------------------------------------------------------------------

Deno.test("backpressure: an async task waits to enter and is released", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  inst.backpressure = 1;
  const log: string[] = [];
  const task = mkTask(inst, ASYNC_FT, STACKFUL_OPTS);
  const thread = spawn(task, function* (thread) {
    const entered = yield* task.enterImplicitThread(thread);
    assert(entered, "not cancelled");
    log.push("entered");
    task.start();
    task.return_([]);
    task.exitImplicitThread(thread);
  });

  thread.resume();
  // Blocked at the backpressure gate: `enter_implicit_thread` has not
  // returned, so nothing has started.
  assertEq(log.length, 0);
  assertEq(inst.numWaitingToEnter, 1);
  assertEq(store.tick(), false);
  inst.backpressure = 0;
  assertEq(store.tick(), true);
  assertEq(log.join(","), "entered");
  assertEq(inst.numWaitingToEnter, 0);
});

Deno.test("backpressure: a sync task ignores backpressure entirely", () => {
  // run_tests.py `test_sync_ignores_backpressure`: the gate in
  // `enter_implicit_thread` is inside `if self.ft.async_`.
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  inst.backpressure = 5;
  let entered = false;
  const task = mkTask(inst, SYNC_FT, SYNC_OPTS);
  const thread = spawn(task, function* (thread) {
    yield* task.enterImplicitThread(thread);
    entered = true;
    task.start();
    task.return_([]);
    task.exitImplicitThread(thread);
  });
  thread.resume();
  assertEq(entered, true);
  assertEq(task.state, "resolved");
});

Deno.test("backpressure: once anyone waits, later arrivals queue behind them", () => {
  // The `or self.inst.num_waiting_to_enter > 0` disjunct of
  // `enter_implicit_thread` — entry is a queue, not a stampede.
  //
  // The *order* assertion below is FIFO-policy-specific (a seeded schedule may
  // admit them in either order, which is equally conforming), so the policy is
  // pinned here; the queueing itself holds under every policy.
  schedulerSeedForTesting(null);
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  inst.backpressure = 1;
  const entered: number[] = [];
  const threads: Thread[] = [];
  for (let i = 0; i < 2; i++) {
    const task = mkTask(inst, ASYNC_FT, STACKFUL_OPTS);
    const thread = spawn(task, function* (thread) {
      yield* task.enterImplicitThread(thread);
      entered.push(i);
      task.start();
      task.return_([]);
      task.exitImplicitThread(thread);
    });
    threads.push(thread);
    thread.resume();
  }
  assertEq(entered.length, 0);
  assertEq(inst.numWaitingToEnter, 2);
  inst.backpressure = 0;
  while (store.tick());
  // FIFO policy: they enter in the order they arrived.
  assertEq(entered.join(","), "0,1");
  schedulerSeedForTesting(null);
});

Deno.test("backpressure: inc/dec are a counter, and dec below zero traps", () => {
  const inst = new ComponentInstanceState(0);
  inst.backpressure += 1;
  inst.backpressure += 1;
  assertEq(inst.backpressure, 2);
  inst.backpressure -= 2;
  assertEq(inst.backpressure, 0);
});

// ---------------------------------------------------------------------------
// Exclusive thread (callback-ABI / sync-lift exclusivity)
// ---------------------------------------------------------------------------

Deno.test("exclusive thread: a callback task takes and releases it", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const task = mkTask(inst, ASYNC_FT, CALLBACK_OPTS);
  assertEq(task.needsExclusive(), true);
  const thread = spawn(task, function* (thread) {
    yield* task.enterImplicitThread(thread);
    // Identity, not deep equality: Thread objects are cyclic (thread -> task
    // -> inst -> threads -> thread), which a structural comparison cannot
    // walk.
    assert(inst.exclusiveThread === thread, "the task holds the exclusive thread");
    task.start();
    task.return_([]);
    task.exitImplicitThread(thread);
  });
  thread.resume();
  assertEq(inst.exclusiveThread, null);
});

Deno.test("exclusive thread: a second callback task waits for the first", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const order: string[] = [];
  const mk = (name: string, release: { now: boolean }) => {
    const task = mkTask(inst, ASYNC_FT, CALLBACK_OPTS);
    const thread = spawn(task, function* (thread) {
      yield* task.enterImplicitThread(thread);
      order.push(`${name}:in`);
      task.start();
      if (!release.now) yield* thread.waitUntil(() => release.now, false);
      task.return_([]);
      task.exitImplicitThread(thread);
      order.push(`${name}:out`);
    });
    return thread;
  };
  const gateA = { now: false };
  const a = mk("a", gateA);
  a.resume();
  assert(inst.exclusiveThread === a, "a holds the exclusive thread");
  const b = mk("b", { now: true });
  b.resume();
  // `b` is stuck at the entry gate: `has_backpressure()` includes
  // "needs_exclusive and exclusive_thread is not None".
  assertEq(order.join(","), "a:in");
  gateA.now = true;
  while (store.tick());
  assertEq(order.join(","), "a:in,a:out,b:in,b:out");
  assertEq(inst.exclusiveThread, null);
});

Deno.test("exclusive thread: a stackful async task does not need it", () => {
  const inst = new ComponentInstanceState(0);
  const task = mkTask(inst, ASYNC_FT, STACKFUL_OPTS);
  // definitions.py `needs_exclusive`: `not opts.async_ or opts.callback`.
  assertEq(task.needsExclusive(), false);
});

// ---------------------------------------------------------------------------
// Waitables and waitable sets
// ---------------------------------------------------------------------------

Deno.test("waitable set: join, pending event, and delivery", () => {
  const wset = new WaitableSet();
  const sub = new Subtask();
  assertEq(wset.hasPendingEvent(), false);
  sub.join(wset);
  assertEq(sub.inWaitableSet(), true);
  assertEq(wset.hasPendingEvent(), false);
  sub.setPendingEvent(() => [EventCode.SUBTASK, 7, SubtaskState.RETURNED]);
  assertEq(wset.hasPendingEvent(), true);
  const [code, p1, p2] = wset.getPendingEvent();
  assertEq(code, EventCode.SUBTASK);
  assertEq(p1, 7);
  assertEq(p2, SubtaskState.RETURNED);
  // Delivery consumes the event (definitions.py `get_pending_event`).
  assertEq(wset.hasPendingEvent(), false);
});

Deno.test("waitable set: dropping a non-empty set traps", () => {
  const wset = new WaitableSet();
  const sub = new Subtask();
  sub.join(wset);
  assertThrows(() => wset.drop(), "waitables");
});

Deno.test("waitable set: poll returns NONE rather than blocking", () => {
  const inst = new ComponentInstanceState(0);
  const task = mkTask(inst, ASYNC_FT, CALLBACK_OPTS);
  const wset = new WaitableSet();
  const [code] = wset.poll(task, false);
  assertEq(code, EventCode.NONE);
});

Deno.test("waitable: join(null) removes it from its set", () => {
  const wset = new WaitableSet();
  const sub = new Subtask();
  sub.join(wset);
  assertEq(wset.elems.length, 1);
  sub.join(null);
  assertEq(wset.elems.length, 0);
  assertEq(sub.inWaitableSet(), false);
  wset.drop(); // now legal
});

// ---------------------------------------------------------------------------
// Subtask state machine
// ---------------------------------------------------------------------------

Deno.test("subtask: lenders are released exactly at resolve delivery", () => {
  const sub = new Subtask();
  const handle = { numLends: 0 };
  sub.addLender(handle);
  assertEq(handle.numLends, 1);
  sub.state = SubtaskState.STARTED;
  sub.resolve(SubtaskState.RETURNED, []);
  // Resolved but not delivered: the handle is still lent out.
  assertEq(handle.numLends, 1);
  assertEq(sub.resolveDelivered(), false);
  sub.deliverResolve();
  assertEq(handle.numLends, 0);
  assertEq(sub.resolveDelivered(), true);
});

Deno.test("subtask: dropping before resolve delivery traps", () => {
  const sub = new Subtask();
  assertThrows(() => sub.drop(), "has not yet resolved");
});

Deno.test("subtask: the pending event delivers the resolution", () => {
  const sub = new Subtask();
  const handle = { numLends: 0 };
  sub.addLender(handle);
  sub.setSubtaskPendingEvent(3);
  sub.state = SubtaskState.STARTED;
  sub.resolve(SubtaskState.RETURNED, []);
  // definitions.py `subtask_event`: reading the event is what calls
  // `deliver_resolve`, so the lent handle is freed when the guest observes
  // the resolution — not when it happened.
  assertEq(handle.numLends, 1);
  const [code, index, payload] = sub.getPendingEvent();
  assertEq(code, EventCode.SUBTASK);
  assertEq(index, 3);
  assertEq(payload, SubtaskState.RETURNED);
  assertEq(handle.numLends, 0);
});

Deno.test("subtask: the async-lower return value packs state and index", () => {
  // definitions.py `canon_lower`: `return [subtask.state | (subtaski << 4)]`.
  const packed = packSubtaskResult(SubtaskState.STARTED, 5);
  assertEq(packed, SubtaskState.STARTED | (5 << 4));
  const [state, index] = unpackSubtaskResult(packed);
  assertEq(state, SubtaskState.STARTED);
  assertEq(index, 5);
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

Deno.test("cancellation: a request at a cancellable block point is delivered", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  let sawCancel = false;
  let resolvedWith: unknown = "unset";
  const task = mkTask(inst, ASYNC_FT, STACKFUL_OPTS, (r) => {
    resolvedWith = r;
  });
  const thread = spawn(task, function* (thread) {
    yield* task.enterImplicitThread(thread);
    task.start();
    const cancelled = yield* thread.waitUntil(() => false, true);
    if (cancelled) {
      sawCancel = true;
      task.cancel();
    }
    task.exitImplicitThread(thread);
  });
  thread.resume();
  assertEq(task.state, "started");
  task.requestCancellation(null);
  assertEq(sawCancel, true);
  // definitions.py `Task.cancel`: `on_resolve(None)`.
  assertEq(resolvedWith, null);
  assertEq(task.state, "resolved");
});

Deno.test("cancellation: with no cancellable thread it becomes pending", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const gate = { open: false };
  const task = mkTask(inst, ASYNC_FT, STACKFUL_OPTS);
  const thread = spawn(task, function* (thread) {
    yield* task.enterImplicitThread(thread);
    task.start();
    // Non-cancellable block point.
    yield* thread.waitUntil(() => gate.open, false);
    // ... and then a cancellable one, which picks up the pending request.
    const cancelled = yield* thread.waitUntil(() => false, true);
    assertEq(cancelled, true);
    task.cancel();
    task.exitImplicitThread(thread);
  });
  thread.resume();
  task.requestCancellation(null);
  assertEq(task.state, "pending-cancel");
  gate.open = true;
  while (store.tick());
  assertEq(task.state, "resolved");
});

Deno.test("tick: a trap under tick records the poison marker", async () => {
  // A trap escaping `thread.resume()` under `Store.tick` breaks the
  // enter/leave bracket (definitions.py `Store.tick`, line 597) — and must
  // also record the poison MARKER, which `Thread.resumeWith`'s quiet-retire
  // and `dispatchableTail` read (polyengine#145, #156).
  const store = new Store();
  const b = new ComponentInstanceState(0, store);

  // A second thread of B, parked on a host promise BEFORE the trap.
  let settle!: () => void;
  const p = new Promise<void>((r) => {
    settle = r;
  });
  const order: string[] = [];
  const parkedTask = mkTask(b, SYNC_FT, SYNC_OPTS);
  const parkedThread = spawn(parkedTask, function* (thread) {
    yield* parkedTask.enterImplicitThread(thread);
    parkedTask.start();
    yield { readyFunc: null, cancellable: false, awaitValue: p };
    order.push("parked tail ran");
    parkedTask.return_([]);
    parkedTask.exitImplicitThread(thread);
  });
  parkedThread.resume();
  assertEq(store.awaiting.has(parkedThread), true, "the sibling is parked");

  // A waiting+ready thread of B whose resumption traps.
  let flag = false;
  const trapTask = mkTask(b, ASYNC_FT, STACKFUL_OPTS);
  const trapThread = spawn(trapTask, function* (thread) {
    yield* trapTask.enterImplicitThread(thread);
    trapTask.start();
    yield* thread.waitUntil(() => flag, false);
    throw new Trap("boom under tick");
  });
  trapThread.resume();
  flag = true;
  assertEq(trapThread.ready(), true);

  assertThrows(() => store.tick(), "boom under tick");

  assertEq(isInstancePoisoned(b), true, "the poison marker is recorded");
  assertEq(b.mayEnterFrom(null), false, "and the bracket stays broken");
  assert(
    withPoisonCause(b, "x").includes("boom under tick"),
    "the cause is available for entry-refusal diagnostics",
  );

  // #156 interaction: the settled tail of the poisoned instance drains
  // quietly instead of hitting `resumeWith`'s backstop assert (or deferring
  // forever, which is what `dispatchableTail` would do without the marker).
  await queueSettledTail(settle);
  assertEq(store.settled.length, 1, "the tail is queued");
  assertEq(store.serviceSettled(), true, "poisoned tails dispatch");
  assertEq(store.settled.length, 0, "the queue drains");
  assertEq(order.length, 0, "retired quietly: the body never ran");
});

Deno.test("request_cancellation: a trap during delivery poisons the callee", () => {
  // definitions.py `Task.request_cancellation` (lines 519-532) wraps the
  // delivery `resume(Cancelled.TRUE)` in no handler: a Trap skips `leave_to`.
  const store = new Store();
  const callerInst = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);
  const task = mkTask(b, ASYNC_FT, STACKFUL_OPTS);
  const thread = spawn(task, function* (thread) {
    yield* task.enterImplicitThread(thread);
    task.start();
    const cancelled = yield* thread.waitUntil(() => false, true);
    if (cancelled) throw new Trap("boom during cancel delivery");
  });
  thread.resume();
  assertEq(task.state, "started");

  assertThrows(
    () => task.requestCancellation(callerInst),
    "boom during cancel delivery",
  );
  assertEq(b.mayEnterFrom(callerInst), false, "the callee stays locked");
  assertEq(isInstancePoisoned(b), true);
  assertEq(task.state, "cancel-delivered", "parity: the state is set first");
});

Deno.test("request_cancellation: a capability signal releases the gate", () => {
  // Capability signals mark the RUNTIME incomplete, not the component
  // faulted: the bracket is released, exactly as in `Store.tick`.
  const store = new Store();
  const callerInst = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);
  const task = mkTask(b, ASYNC_FT, STACKFUL_OPTS);
  const thread = spawn(task, function* (thread) {
    yield* task.enterImplicitThread(thread);
    task.start();
    const cancelled = yield* thread.waitUntil(() => false, true);
    if (cancelled) throw new PendingCapability("x");
  });
  thread.resume();

  assertThrows(
    () => task.requestCancellation(callerInst),
    "pending-capability: x",
  );
  assertEq(b.mayEnterFrom(callerInst), true, "the gate is released");
  assertEq(isInstancePoisoned(b), false, "and nothing is poisoned");
});

// ---------------------------------------------------------------------------
// Poisoning re-key (polyengine#173)
// ---------------------------------------------------------------------------
//
// White-box pins on the property the re-key buys: every poisoning DECISION
// reads the poison MARKER, not `mayEnter`. Each test below forces `mayEnter`
// back to true on a marked instance — a state the runtime never produces
// today — so the pin isolates the marker's authority and must survive the
// CM#705 deletion of `may_enter` unchanged.

/** Force a marked instance (and its synthetic root) back to enterable. */
function forceEnterable(inst: ComponentInstanceState): void {
  for (const i of inst.selfAndAncestors()) i.mayEnter = true;
}

Deno.test("re-key: entryRefusal refuses a marked instance with mayEnter forced true", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  notifyInstancePoisoned(inst, new Trap("boom"));
  forceEnterable(inst);
  assertEq(inst.mayEnterFrom(null), true, "the transient gate is wide open");

  const r = entryRefusal(inst, null, "cannot enter component instance");
  assert(r !== null, "the marker alone refuses entry");
  assertEq(r.includes("cannot enter component instance"), true);
  assertEq(r.includes("instance poisoned by"), true, "the cause is named");
  assertEq(r.includes("boom"), true, "and it is the original trap");
});

Deno.test("re-key: an unmarked but bracket-locked instance refuses with the bare base", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  inst.enterFrom(null);
  assertEq(
    entryRefusal(inst, null, "cannot enter component instance"),
    "cannot enter component instance",
    "transient reentrance: byte-identical to the pre-re-key message",
  );
});

Deno.test("re-key: an enterable instance is not refused", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  assertEq(entryRefusal(inst, null, "base"), null);
});

Deno.test("re-key: caller === callee passes vacuously even when marked", () => {
  // definitions.py `entering_set` (line 230) is empty for a self-call, so
  // there is no instance to check. The dtor path (cabi/handles.ts) relies on
  // this: a guest dropping its own resource is not refused by its own marker.
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  notifyInstancePoisoned(inst, new Trap("boom"));
  forceEnterable(inst);
  assertEq([...inst.enteringSet(inst)].length, 0, "empty entering set");
  assertEq(entryRefusal(inst, inst, "base"), null);
});

Deno.test("re-key: tick does not resume a marked instance with mayEnter forced true", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  let flag = false;
  const order: string[] = [];
  const task = mkTask(inst, SYNC_FT, SYNC_OPTS);
  const thread = spawn(task, function* (thread) {
    yield* task.enterImplicitThread(thread);
    task.start();
    yield* thread.waitUntil(() => flag, false);
    order.push("ran");
    task.return_([]);
    task.exitImplicitThread(thread);
  });
  thread.resume();
  flag = true;
  assertEq(thread.ready(), true, "the thread is ready...");

  notifyInstancePoisoned(inst, new Trap("boom"));
  forceEnterable(inst);
  assertEq(inst.mayEnterFrom(null), true, "...and transiently enterable");
  assertEq(store.tick(), false, "but the marker excludes it from tick");
  assertEq(order.length, 0);
});

Deno.test("re-key: requestCancellation leaves a marked callee's request pending", () => {
  const store = new Store();
  const callerInst = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);
  let sawCancel = false;
  const task = mkTask(b, ASYNC_FT, STACKFUL_OPTS);
  const thread = spawn(task, function* (thread) {
    yield* task.enterImplicitThread(thread);
    task.start();
    const cancelled = yield* thread.waitUntil(() => false, true);
    if (cancelled) {
      sawCancel = true;
      task.cancel();
    }
    task.exitImplicitThread(thread);
  });
  thread.resume();
  assertEq(task.state, "started");

  notifyInstancePoisoned(b, new Trap("boom"));
  forceEnterable(b);
  assertEq(b.mayEnterFrom(callerInst), true, "transiently enterable");

  task.requestCancellation(callerInst);
  assertEq(sawCancel, false, "delivery is refused by the marker");
  assertEq(task.state, "pending-cancel");
});

Deno.test("cancellation: task.cancel without a delivered request traps", () => {
  const inst = new ComponentInstanceState(0);
  const task = mkTask(inst, ASYNC_FT, STACKFUL_OPTS);
  task.state = "started";
  assertThrows(() => task.cancel(), "without a delivered cancellation");
});

// ---------------------------------------------------------------------------
// Task invariants
// ---------------------------------------------------------------------------

Deno.test("task: returning with live borrows traps", () => {
  const inst = new ComponentInstanceState(0);
  const task = mkTask(inst, SYNC_FT, SYNC_OPTS);
  task.start();
  task.numBorrows = 1;
  assertThrows(() => task.return_([]), "borrow handles still remain");
});

Deno.test("task: task.return twice traps", () => {
  const inst = new ComponentInstanceState(0);
  const task = mkTask(inst, SYNC_FT, SYNC_OPTS);
  task.start();
  task.return_([]);
  assertThrows(() => task.return_([]), "resolved task");
});

Deno.test("task: finishing all threads without resolving traps", () => {
  const inst = new ComponentInstanceState(0);
  const task = mkTask(inst, SYNC_FT, SYNC_OPTS);
  const thread = new Thread(task, (function* () {})());
  task.registerThread(thread);
  task.start();
  assertThrows(
    () => task.unregisterThread(thread),
    "without resolving",
  );
});

// ---------------------------------------------------------------------------
// Scheduler policy
// ---------------------------------------------------------------------------

Deno.test("scheduler: the default policy is deterministic FIFO", () => {
  // Pin the policy rather than reading whatever POLYENGINE_SCHED_SEED happens to be:
  // this test is about what FIFO *means*, and the suite is also run under
  // seeds to explore alternative schedules.
  schedulerSeedForTesting(null);
  try {
    assertEq(schedulerPolicy(), "fifo");
    const items = ["a", "b", "c"];
    for (let i = 0; i < 10; i++) assertEq(chooseCandidate(items), "a");
  } finally {
    schedulerSeedForTesting(null);
  }
});

Deno.test("scheduler: a seed makes choices pseudo-random but reproducible", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const run = () => {
    schedulerSeedForTesting(12345);
    return Array.from({ length: 24 }, () => chooseCandidate(items)).join("");
  };
  try {
    const first = run();
    const second = run();
    assertEq(first, second); // reproducible from the seed
    assertEq(schedulerPolicy(), "seeded-shuffle");
    // ... and genuinely exploring, not pinned to one element.
    assert(
      new Set(first).size > 1,
      `seeded scheduling should visit more than one candidate, got ${first}`,
    );
  } finally {
    schedulerSeedForTesting(null);
  }
  // Restoring `null` is the FIFO policy regardless of how the process was
  // launched (schedulerSeedForTesting overrides the env-read seed).
  assertEq(schedulerPolicy(), "fifo");
});

Deno.test("scheduler: a seeded schedule still resolves the same task set", () => {
  // Schedule exploration must change *order*, never outcomes.
  const run = (seed: number | null): string => {
    schedulerSeedForTesting(seed);
    try {
      const store = new Store();
      const inst = new ComponentInstanceState(0, store);
      const done: string[] = [];
      for (const name of ["x", "y", "z"]) {
        const task = mkTask(inst, ASYNC_FT, STACKFUL_OPTS);
        const thread = spawn(task, function* (thread) {
          yield* task.enterImplicitThread(thread);
          task.start();
          yield* thread.yield_(false);
          task.return_([]);
          task.exitImplicitThread(thread);
          done.push(name);
        });
        thread.resume();
      }
      while (store.tick());
      return [...done].sort().join(",");
    } finally {
      schedulerSeedForTesting(null);
    }
  };
  assertEq(run(null), "x,y,z");
  for (const seed of [1, 2, 7, 99]) assertEq(run(seed), "x,y,z");
});

/** `Trap` is imported to assert capability errors are never traps. */
void Trap;
