// PROBE for issue #298: does `HostActivity.pump()`'s synchronous half run
// `Store.tick()` while a guest activation is live on the JS stack, and can
// that interleave with a concurrently parked `driveAsync`?
//
// The shape, store-level in the style of `host_pump_test.ts` /
// `parked_driver_host_call_test.ts` (no checked-in example guest has the
// participants):
//
//   * instance A's SYNC export is on the JS stack — modelled by
//     `pushCurrentThread(threadA)`, exactly what `createLiftedFunction`'s
//     plain-mode entry establishes around the core call;
//   * it calls a SYNC lowered host import (`createLoweredImport`, `async:
//     false`, `mode: "plain"`) whose `hostFn` calls `host.readable.read(1)`
//     on an exec-layer host stream end bound to the same store;
//   * a ready fake thread of instance B records, in its `resume()`, whether
//     A's activation is live (both A's own body flag and `currentThread()`).
//
// P-1 answers the reentrancy question; P-2 the two-loops question.

import { assertEq } from "./support/asserts.ts";
import {
  createLoweredImport,
  driveStoreAsync,
  hostStreamFor,
  newStats,
  registerHostCall,
  type ResolvedOptions,
  storeDriverDepth,
} from "../src/exec/mod.ts";
import {
  ComponentInstanceState,
  currentThread,
  popCurrentThread,
  pushCurrentThread,
  SharedStreamImpl,
  Store,
  Task,
  type TaskOptions,
  Thread,
} from "../src/task/mod.ts";
import type { ComponentValue, FuncType, ValType } from "../src/cabi/types.ts";

const U8: ValType = { kind: "u8" };

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** `func()` — sync-typed, no params, no results: no memory needed. */
const FT: FuncType = { params: [], results: [], async: false };

const TASK_OPTS: TaskOptions = {
  async_: false,
  callback: false,
  stringEncoding: "utf8",
  memory: null,
};

/** A host stream end wired to `store`, as `liftStream` would have wired it. */
function hostEndOn<T>(store: Store, element: ValType | null) {
  const shared = new SharedStreamImpl(element);
  (shared as unknown as { boundStore: unknown }).boundStore = store;
  return {
    shared,
    host: hostStreamFor<T>(shared as unknown as ComponentValue),
  };
}

/** Instance A: a real thread (so `currentThread()` is meaningful) plus the
 * sync lowered import whose `hostFn` the test supplies. */
function instanceA(store: Store, hostFn: () => void) {
  const inst = new ComponentInstanceState(0, store);
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    memory: null,
    realloc: null,
    postReturn: null,
    callback: null,
    async: false,
    cancellable: false,
    coreType: { params: [], results: [] },
    instance: inst,
  };
  const call = createLoweredImport({
    name: "host-import",
    ft: FT,
    opts,
    hostFn,
    stats: newStats(),
    mode: "plain",
    suspendable: false,
    deferCancel: false,
    abortable: false,
  }) as () => unknown;
  const task = new Task(FT, TASK_OPTS, inst, () => [], () => {});
  const thread = new Thread(task, (function* () {})());
  return { inst, thread, call };
}

/** `currentThread()` throws (PendingCapability) when no activation is live —
 * which is itself the answer this probe wants, so capture rather than throw. */
function ambientOrNull(): unknown {
  try {
    return currentThread();
  } catch {
    return null;
  }
}

/** Instance B's guest thread, ready from the start; `resume()` records the
 * ambient it was resumed under. */
class FakeThread {
  #ready = true;
  resumed = 0;
  /** Snapshot per resumption: was A's activation live on the stack? */
  readonly witness: {
    aBodyLive: boolean;
    ambient: unknown;
    driverDepth: number;
  }[] = [];
  readonly task = { inst: {} };
  constructor(
    private readonly probe: () => {
      aBodyLive: boolean;
      ambient: unknown;
      driverDepth: number;
    },
  ) {}
  ready(): boolean {
    return this.#ready;
  }
  waiting(): boolean {
    return !this.#ready;
  }
  wake(): void {
    this.#ready = true;
  }
  resume(): void {
    this.#ready = false;
    this.resumed++;
    this.witness.push(this.probe());
  }
}

// ---------------------------------------------------------------------------
// P-1: reentrance
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "P-1: the sync half of pump() ticks instance B while instance A's activation is live",
  fn: async () => {
    const store = new Store();
    const { shared, host } = hostEndOn<number>(store, U8);

    let aBodyLive = false;
    let ambientDuringResume: unknown = "unset";
    const b = new FakeThread(() => ({
      aBodyLive,
      ambient: ambientOrNull(),
      driverDepth: storeDriverDepth(store),
    }));
    store.startWaiting(b);

    let readPromise: Promise<number[]> | null = null;
    const a = instanceA(store, () => {
      // Inside the host import, inside A's live guest frame.
      readPromise = host.readable.read(1);
    });

    aBodyLive = true;
    pushCurrentThread(a.thread);
    try {
      a.call();
    } finally {
      popCurrentThread(a.thread);
      aBodyLive = false;
    }

    // THE OBSERVATION. If B was resumed at all, it happened synchronously
    // inside `a.call()` — nothing else ran.
    assert(
      b.resumed > 0,
      "NOT REACHABLE: the sync half of pump() did not tick B at all",
    );
    ambientDuringResume = b.witness[0].ambient;
    assert(
      b.witness[0].aBodyLive,
      "NOT REACHABLE: B was resumed outside A's activation",
    );
    assertEq(
      ambientDuringResume === a.thread,
      true,
      // `currentThread()` naming A's thread is the machine-checkable form of
      // "a guest activation is live on the JS stack".
    );
    assertEq(b.witness[0].driverDepth, 0);

    // Housekeeping: settle the read so no live pump is left behind.
    shared.drop();
    await readPromise;
    host.readable.drop();
    assertEq(store.hostFailure, undefined);
  },
});

// ---------------------------------------------------------------------------
// P-2: the two-loops question — a parked driveAsync plus the sync half
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "P-2: with a driveAsync parked on the same store, the sync half still ticks B",
  fn: async () => {
    const store = new Store();
    const { shared, host } = hostEndOn<number>(store, U8);

    let aBodyLive = false;
    const b = new FakeThread(() => ({
      aBodyLive,
      ambient: ambientOrNull(),
      driverDepth: storeDriverDepth(store),
    }));

    // The incumbent loop: a `driveAsync` parked on a never-settling host call.
    const stuck = new Promise<void>(() => {});
    registerHostCall(store, stuck);
    let finished = false;
    const driving = driveStoreAsync(store, () => finished, "test driver");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    assert(storeDriverDepth(store) > 0, "the driver should be live");

    // Only now make B ready, so the parked driver's snapshot predates it.
    store.startWaiting(b);

    let readPromise: Promise<number[]> | null = null;
    const a = instanceA(store, () => {
      readPromise = host.readable.read(1);
    });

    aBodyLive = true;
    pushCurrentThread(a.thread);
    try {
      a.call();
    } finally {
      popCurrentThread(a.thread);
      aBodyLive = false;
    }

    const syncResumes = b.resumed;
    const depthSeen = b.witness.map((w) => w.driverDepth);

    // Let the parked driver have its turns too, and see whether B is resumed
    // a SECOND time (the resume-once question) or the store is poisoned.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));

    finished = true;
    store.pendingHostCalls.delete(stuck);
    const wake: Promise<void> = Promise.resolve().then(() => {
      store.pendingHostCalls.delete(wake);
    });
    registerHostCall(store, wake);
    await driving;

    shared.drop();
    await readPromise;
    host.readable.drop();

    assert(
      syncResumes > 0,
      `NOT REACHABLE under a live driver: sync half did not tick B ` +
        `(driver depth seen: ${JSON.stringify(depthSeen)})`,
    );
    // Reported, not asserted-away: what the probe is here to measure.
    assertEq(depthSeen[0] > 0, true);
    assertEq(store.hostFailure, undefined);
    assertEq(b.resumed, syncResumes);
  },
});

// ---------------------------------------------------------------------------
// P-3: what limits the damage — `Store.tick`'s `pendingResumptions` gate
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "P-3: the sync half cannot steal a scheduling turn while a resumption is pending",
  fn: async () => {
    const store = new Store();
    const { shared, host } = hostEndOn<number>(store, U8);

    let aBodyLive = false;
    const b = new FakeThread(() => ({
      aBodyLive,
      ambient: ambientOrNull(),
      driverDepth: storeDriverDepth(store),
    }));
    store.startWaiting(b);

    // A driver (or any settle site) holds an entry for an activation whose
    // turn has not run yet — scheduler.ts `Store.tick` refuses to schedule
    // anything while one is outstanding (scheduler.ts:1164).
    const other = { marker: "settled-but-not-run" };
    store.addPendingResumption(other);

    let readPromise: Promise<number[]> | null = null;
    const a = instanceA(store, () => {
      readPromise = host.readable.read(1);
    });

    aBodyLive = true;
    pushCurrentThread(a.thread);
    try {
      a.call();
    } finally {
      popCurrentThread(a.thread);
      aBodyLive = false;
    }

    assertEq(b.resumed, 0);

    store.removePendingResumption(other);
    shared.drop();
    await readPromise;
    host.readable.drop();
    assertEq(store.hostFailure, undefined);
  },
});
