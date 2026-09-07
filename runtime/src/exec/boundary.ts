// Host-boundary wiring: lifted-export invocation (reference `canon_lift`,
// sync path) and lowered-import bodies (reference `canon_lower`, sync path),
// built on the cabi v1 interpreter (runtime/src/cabi/) driven by the plan's
// canonical options — docs/architecture.md §4.3 items 2 and 5, degenerate sync case.

import {
  type CanonicalOptions,
  coreFuncTypeEquals,
  CoreValueIter,
  type ComponentValue,
  type CoreFuncType,
  type CoreType,
  type CoreValue,
  type FuncType,
  flattenFunctype,
  liftFlatValues,
  LiftLowerContext,
  lowerFlatValues,
  MAX_FLAT_ASYNC_PARAMS,
  MAX_FLAT_PARAMS,
  MAX_FLAT_RESULTS,
  type MemInst,
  type PtrType,
  ResourceTypeInfo,
  trap,
  trapIf,
} from "../cabi/mod.ts";
import { AssertionError, assert_ } from "../cabi/trap.ts";
import {
  type BlockRequest,
  type Cancelled,
  ComponentInstanceState,
  driveSyncLift,
  EventCode,
  withActivation,
  addInstancePoisonedListener,
  hasRealHostCall,
  isInstancePoisoned,
  type EventTuple,
  NeedsJspi,
  needsJspi,
  packSubtaskResult,
  PendingCapability,
  notifyInstancePoisoned,
  realHostCalls,
  Store,
  storeQuiescent,
  Subtask,
  SyncEntryBusy,
  WaitableSet,
  SubtaskState,
  Task,
  type TaskOptions,
  Thread,
  entryRefusal,
} from "../task/mod.ts";
import { currentTask } from "../task/scheduler.ts";
import { PlanError } from "../plan/loader.ts";
import {
  blockCurrentActivation,
  enterWasm,
  type SuspensionMode,
} from "../jspi/mod.ts";

/**
 * Structural view of an intrinsics `SyncCallScope`: everything this module
 * needs in order to unwind a FACT sync-call bracket a trap escaped.
 */
export interface LenderScope {
  releaseLenders(): void;
}

/** A raw core function as exposed through the JS WebAssembly API. */
// deno-lint-ignore no-explicit-any
export type CoreFn = (...args: any[]) => unknown;

/** Counters exposed for tests/diagnostics on the component handle. */
export interface ExecutionStats {
  liftedCalls: number;
  tasksResolved: number;
  postReturnsRun: number;
  loweredCalls: number;
  enterSyncCalls: number;
  exitSyncCalls: number;
  /** Callback-export invocations of the async lift loop (`canon_lift`). */
  callbackInvocations: number;
}

export function newStats(): ExecutionStats {
  return {
    liftedCalls: 0,
    tasksResolved: 0,
    postReturnsRun: 0,
    loweredCalls: 0,
    enterSyncCalls: 0,
    exitSyncCalls: 0,
    callbackInvocations: 0,
  };
}

/**
 * A `MemInst`-shaped view over a `WebAssembly.Memory` that never goes stale:
 * `bytes`/`view` re-derive from `memory.buffer` whenever the buffer identity
 * changes (memory.grow detaches the previous ArrayBuffer — a cached
 * Uint8Array would silently drop writes). The provider indirection also
 * covers plan-order effects: canonical options can reference a memory whose
 * `extract-memory` initializer runs later; accesses before extraction fail
 * with a PlanError.
 *
 * Structurally compatible with cabi's `MemInst` (same public surface).
 */
export class LiveMemory {
  readonly addrType: PtrType = "i32"; // memory64 components: not yet implemented
  #provider: () => WebAssembly.Memory | undefined;
  #label: string;
  #buffer: ArrayBufferLike | null = null;
  #bytes: Uint8Array = new Uint8Array(0);
  #view: DataView = new DataView(new ArrayBuffer(0));

  constructor(provider: () => WebAssembly.Memory | undefined, label: string) {
    this.#provider = provider;
    this.#label = label;
  }

  #memory(): WebAssembly.Memory {
    const m = this.#provider();
    if (m === undefined) {
      throw new PlanError(
        `${this.#label} accessed before its extract-memory initializer ran`,
      );
    }
    return m;
  }

  #refresh(): void {
    const buffer = this.#memory().buffer;
    if (buffer !== this.#buffer) {
      this.#buffer = buffer;
      this.#bytes = new Uint8Array(buffer);
      this.#view = new DataView(buffer);
    }
  }

  get bytes(): Uint8Array {
    this.#refresh();
    return this.#bytes;
  }

  get view(): DataView {
    this.#refresh();
    return this.#view;
  }

  get length(): number {
    return this.#memory().buffer.byteLength;
  }

  ptrType(): PtrType {
    return this.addrType;
  }

  ptrSize(): 4 | 8 {
    return 4;
  }
}

// Compile-time proof that LiveMemory satisfies the MemInst surface.
const _memInstCheck: MemInst = new LiveMemory(() => undefined, "check");
void _memInstCheck;

/**
 * Canonical options resolved against executor state. `memory` is a
 * LiveMemory (or null); `realloc`/`postReturn`/`callback` resolve lazily so
 * options can be constructed before the corresponding extract initializers
 * run (wasmtime semantics: options hold indices, resolved at use).
 */
export interface ResolvedOptions {
  stringEncoding: "utf8" | "utf16" | "latin1+utf16";
  memory: LiveMemory | null;
  realloc: (() => CoreFn | undefined) | null;
  postReturn: (() => CoreFn | undefined) | null;
  callback: (() => CoreFn | undefined) | null;
  async: boolean;
  /**
   * `CanonicalOptions.cancellable` (wasmtime-environ 47.0.3
   * `component/info.rs:540`), i.e. whether a built-in reached through these
   * options is a *cancellable* block point.
   *
   * It lives in the options, not in the trampoline: `Trampoline::
   * WaitableSetWait`/`WaitableSetPoll` carry only `{instance, options}`
   * (info.rs:815-831). definitions.py takes it as the first parameter of
   * `canon_waitable_set_wait` / `canon_waitable_set_poll` (lines 2414/2431),
   * which is the same information arriving by a different route.
   *
   * (`thread.yield` and `subtask.cancel` are the exceptions: wasmtime puts
   * their `cancellable` / `async` flags on the *trampoline*, and those
   * built-ins read them from the decl.)
   */
  cancellable: boolean;
  coreType: CoreFuncType;
  instance: ComponentInstanceState;
}

function require<T>(
  resolver: (() => T | undefined) | null,
  what: string,
): T | null {
  if (resolver === null) return null;
  const v = resolver();
  if (v === undefined) {
    throw new PlanError(`${what} accessed before its extract initializer ran`);
  }
  return v;
}

/** cabi-facing options object (LiftLowerOptions + flatten inputs). */
export function cabiOptions(opts: ResolvedOptions): CanonicalOptions {
  return {
    stringEncoding: opts.stringEncoding,
    memory: opts.memory,
    realloc: opts.realloc === null ? null : (o, os, a, n) => {
      const realloc = require(opts.realloc, "realloc")!;
      const p = callCore(realloc, [o, os, a, n]);
      trapIf(p.length !== 1 || typeof p[0] !== "number", "realloc result");
      return (p[0] as number) >>> 0;
    },
    postReturn: null, // post-return handled by the task layer, not cabi
    async_: opts.async,
    // Truthiness only: `flattenFunctype` branches on whether a callback
    // exists (async lifts with a callback return a packed i32; stackful ones
    // return nothing). Passing the resolver rather than `null` is what makes
    // the callback-ABI core type come out right.
    callback: opts.callback === null ? null : opts.callback,
  };
}

/**
 * Call a core function, mapping core-wasm exceptions to canonical-ABI traps
 * (reference `call_and_trap_on_throw`). Component traps and internal errors
 * of ours propagate unchanged.
 */
/**
 * Layering rule: a core-wasm trap's message is engine-specific text (V8,
 * SpiderMonkey, JSC each word `unreachable` differently, for instance) and is
 * passed through here UNTOUCHED — it is diagnostics only, "engine-flavored"
 * and not normalized to any particular host's wording. The runtime never
 * emulates another host's (e.g. wasmtime's) message text.
 *
 * Suite-wording normalization (matching the official test suite's
 * `assert_trap` expectations, which are typically worded per wasmtime) lives
 * in the harness instead: see `TRAP_MESSAGE_EQUIVALENTS` in
 * harness/src/runner.ts, which maps engine-specific spellings to the
 * suite-expected forms at comparison time. (The FACT *adapter* traps take a
 * different route entirely — they arrive as numeric codes through the `trap`
 * trampoline and are runtime-authored text, see `FACT_TRAP_MESSAGES` in
 * intrinsics/mod.ts; that table is untouched by this layering rule.)
 */

export function callCore(fn: CoreFn, args: CoreValue[]): CoreValue[] {
  let raw: unknown;
  try {
    raw = fn(...args);
  } catch (e) {
    throw mapCoreException(e);
  }
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw as CoreValue[];
  return [raw as CoreValue];
}

/**
 * The `call_and_trap_on_throw` translation, factored so BOTH routes a core
 * trap can take reach it:
 *
 *   * a synchronous throw out of `fn(...args)` (`callCore` above — the plain
 *     path, and jspi pre-suspension);
 *   * a **rejection of a `promising` entry's Promise** (jspi pin (e): a trap
 *     after a resumption arrives as an ordinary rejection). That rejection
 *     carries the raw `WebAssembly.RuntimeError`, and before this helper was
 *     applied on the awaited path (`awaitCore` below), a post-suspension
 *     guest trap escaped to the embedder as `RuntimeError: unreachable`
 *     instead of the wasmtime-worded `Trap` — every deliberate guest trap
 *     under detection scored as a harness failure
 *     (big-interleaving-test.wast:836's assert_trap "unreachable").
 */
function mapCoreException(e: unknown): unknown {
  if (e instanceof WebAssembly.RuntimeError) {
    try {
      trap(`guest trapped: ${e.message}`);
    } catch (t) {
      return t;
    }
  }
  return e;
}

/**
 * Normalize raw JS-API core values to cabi's canonical lane representation:
 * i32 lanes as unsigned numbers (the JS API yields signed), i64 lanes as
 * unsigned bigints, floats as numbers.
 */
export function normalizeCoreValues(
  values: CoreValue[],
  lanes: CoreType[],
  what: string,
): CoreValue[] {
  if (values.length !== lanes.length) {
    throw new AssertionError(
      `${what}: expected ${lanes.length} core values, got ${values.length}`,
    );
  }
  return values.map((v, i) => {
    switch (lanes[i]) {
      case "i32":
        assert_(typeof v === "number", `${what}[${i}]: i32 lane`);
        return (v as number) >>> 0;
      case "i64":
        assert_(typeof v === "bigint", `${what}[${i}]: i64 lane`);
        return BigInt.asUintN(64, v as bigint);
      case "f32":
      case "f64":
        assert_(typeof v === "number", `${what}[${i}]: float lane`);
        return v;
    }
  });
}

/** Map a resolved result list to the host-facing return value by arity. */
function resultsToHost(results: ComponentValue[]): unknown {
  if (results.length === 0) return undefined;
  if (results.length === 1) return results[0];
  return results;
}

// ---------------------------------------------------------------------------
// Driving the scheduler from the host boundary
// ---------------------------------------------------------------------------
//
// run_tests.py's `lift_and_run` (line 55) is the reference embedding:
//
//   ```python
//   func_inst = inst.store.lift(callee, ft, opts, inst)
//   _ = inst.store.invoke(func_inst, on_start, on_resolve)
//   while inst.store.waiting:
//     inst.store.tick()
//   ```
//
// i.e. enter the component, then pump the store until nothing is waiting.
// `drive` below is that loop, with two additions the reference does not need:
//
//   1. **A deadlock verdict.** The reference's `while store.waiting` spins
//      forever if no waiting thread is ready, because its host functions run
//      on real OS threads and always eventually make progress. Ours cannot
//      spin: when no thread is ready and no host promise is outstanding, the
//      task can never resolve, which is the same condition `canon_lift`'s
//      sync loop traps on (`trap_if(not candidates)`), so we trap too.
//
//   2. **Host promises.** A host import implemented as an `async` JS function
//      resolves its subtask on a *microtask turn*, not on a thread. When the
//      only way forward is such a promise, `drive` returns a Promise and the
//      lifted export's return value becomes a Promise. This needs no JSPI:
//      the guest is stackless (callback ABI), so nothing is suspended mid-wasm
//      — the guest already returned WAIT and the host merely resumes it later.
//
// Consequence for callers: a lifted export returns `T` when the whole call
// completed synchronously, and `Promise<T>` when a host promise was involved.
// The conformance harness invokes exports synchronously
// (harness/src/runtime-executor.ts) and the official suite has no
// promise-returning host imports, so it only ever sees the synchronous shape.

/** True for thenables, which is what "is this host call asynchronous" means. */
function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}


// ---------------------------------------------------------------------------
// Handshake probe
// ---------------------------------------------------------------------------
//
// Env-gated tracing of the drive loops. This exists because site 1 is the
// first *lit* suspension site, so the `SuspensionPoint` <-> `Store.tick` <->
// `driveAsync` handshake had never executed before it; a pure-microtask stall
// there is invisible from the outside (no trap, no rejection -- just an await
// nothing settles). Off unless POLYENGINE_DRIVE_TRACE is set, and the getter is read
// once at module load so normal runs pay a boolean test.
const DRIVE_TRACE = (() => {
  try {
    return Deno.env.get("POLYENGINE_DRIVE_TRACE") === "1";
  } catch {
    return false;
  }
})();
let traceTurn = 0;

function describeWaiter(t: unknown): string {
  const w = t as {
    readyFunc?: unknown;
    ready?: () => boolean;
    waiting?: () => boolean;
    constructor?: { name?: string };
  };
  const kind = w?.constructor?.name ?? "?";
  let verdict = "?";
  try {
    verdict = w.ready?.() ? "READY" : (w.readyFunc === null ? "explicit" : "not-ready");
  } catch (e) {
    verdict = `threw:${e}`;
  }
  return `${kind}[${verdict}]`;
}

function traceDrive(loop: string, store: Store, done: () => boolean, branch: string): void {
  if (!DRIVE_TRACE) return;
  let doneVerdict = "?";
  try {
    doneVerdict = String(done());
  } catch (e) {
    doneVerdict = `threw:${e}`;
  }
  const waiters = store.waiting.map(describeWaiter).join(",");
  const awaiters = [...store.awaiting].map((t) => {
    const a = t as { constructor?: { name?: string }; task?: { label?: string } };
    return `${a?.constructor?.name ?? "?"}`;
  }).join(",");
  console.error(
    `[drive #${traceTurn++}] ${loop} branch=${branch} ` +
      `ready=${store.readyCandidates().length} ` +
      `waiting=${store.waiting.length}{${waiters}} ` +
      `awaiting=${store.awaiting.size} ` +
      `hostCalls=${store.pendingHostCalls.size} ` +
      `awaiters={${awaiters}} pending=${store.pendingResumptions.size} done=${doneVerdict}`,
  );
}

/**
 * What a driving loop does when it runs out of moves with `done()` still
 * false — the reference's empty-candidate-set state.
 *
 * `"trap"` is definitions.py `canon_lift`'s `trap_if(not candidates)` (line
 * 2189) and the default for every driver in this runtime: the sync-lift
 * paths, the destructor entry, and the pumps (which cannot reach the verdict
 * anyway — see `driveStoreAsync`).
 *
 * `"exit"` returns instead, leaving `done()` false for the caller to notice.
 * It exists for ONE caller: an **async-typed** lifted export (#292). The
 * reference's driving loop is guarded by `if not ft.async_`, so for such an
 * export `canon_lift` returns right after the first `thread.resume()` and the
 * driving — with it, the idle verdict — belongs to the embedder's
 * `Store.tick`, which never traps. wasmtime draws the same line:
 * `run_concurrent` is `poll_until(trap_on_idle=false)` (a `call_concurrent`
 * future simply stays pending on idle), and the trapping variant
 * `run_concurrent_trap_on_idle` is `pub(super)`, backing only the blocking
 * `[Typed]Func::call_async`. Polyengine's Promise-shaped export is
 * `call_concurrent` under an always-live `run_concurrent` (docs/architecture.md
 * §"Mapping the reference model"), hence "exit".
 */
type IdlePolicy = "trap" | "exit";

/**
 * Pump `store` until `done()` holds. Returns `undefined` if that was achieved
 * synchronously, or a Promise that settles when it has been.
 *
 * Under `idle: "exit"` it may also return with `done()` still false; see
 * `IdlePolicy`.
 */
function drive(
  store: Store,
  done: () => boolean,
  what: string,
  idle: IdlePolicy = "trap",
): void | Promise<void> {
  try {
    return driveLoop(store, done, what, idle);
  } catch (e) {
    // EXIT BY EXCEPTION IS STILL AN EXIT. A trap unwinds this call, but the
    // sibling work this loop already started — a registered host call, a
    // queued tail (which gates `Store.tick`) — does not unwind with it. The
    // `done()` path hands both to the settlement pump; so must this one.
    ensureSettlementPump(store);
    throw e;
  }
}

/** `drive`'s loop proper; see `drive` for the exception-exit hand-off. */
function driveLoop(
  store: Store,
  done: () => boolean,
  what: string,
  idle: IdlePolicy,
): void | Promise<void> {
  for (;;) {
    traceDrive("drive", store, done, "top");
    // The synchronous drain must not run while a thread is parked on a
    // Promise: `tick` cannot see those, so a thread that re-parks READY on
    // every resume (a callback-ABI guest spinning YIELD) would hold this
    // loop forever while the promise-parked thread that would stop the spin
    // never gets serviced (drop-subtask.wast:139 under detection: the
    // Looper spins YIELD until `return` runs, and `return`'s caller sat
    // parked on its activation promise). In jspi mode the lifted export
    // returns a Promise anyway, so handing off to `driveAsync` — whose
    // drain interleaves fairly — costs nothing; in plain mode `awaiting`
    // is always empty and this loop is bit-for-bit what it was.
    while (store.awaiting.size === 0 && store.tick()) {
      traceDrive("drive", store, done, "ticked");
      if (store.hostFailure !== undefined) throw takeHostFailure(store);
    }
    if (store.hostFailure !== undefined) throw takeHostFailure(store);
    if (done()) {
      traceDrive("drive", store, done, "EXIT-done");
      // Fully-synchronous completion: no `driveAsync` ran, so its exit hook
      // will not fire — arm the settlement pump here for any host calls the
      // guest registered fire-and-forget during this drive.
      ensureSettlementPump(store);
      return;
    }
    // A thread parked on a Promise (jspi) can only progress after a microtask
    // turn, exactly like an outstanding host call. So can an outstanding
    // pending resumption of THIS store: a suspension has been settled and its
    // activation has not run yet (see `Store.tick`).
    if (store.awaiting.size > 0 || store.hasPendingResumptions()) {
      traceDrive("drive", store, done, "->async(awaiting/pending)");
      return driveAsync(store, done, what, idle);
    }
    if (store.pendingHostCalls.size === 0) {
      // The idle verdict. Under "exit" (an async-typed lift, #292) this is
      // not a fault at all: the task simply has nothing to run right now and
      // the export's Promise stays pending until a later driver finishes it.
      if (idle === "exit") {
        traceDrive("drive", store, done, "EXIT-idle");
        // Same hand-off as the `done()` exit above: work this loop started
        // outlives it.
        ensureSettlementPump(store);
        return;
      }
      traceDrive("drive", store, done, "DEADLOCK-TRAP");
      trapIf(
        true,
        `wasm trap: deadlock detected: event loop cannot make further ` +
          `progress (${what}: no thread is ready and no host call is ` +
          `outstanding)`,
      );
    }
    traceDrive("drive", store, done, "->async(hostcalls)");
    return driveAsync(store, done, what, idle);
  }
}

/** A settled parked-thread promise, tagged with the thread that owns it. */
type AwaitWinner = {
  t: { awaiting: Promise<unknown> | null; resumeWith(v: unknown, f?: { error: unknown }): void };
  /**
   * The promise this tag was minted from — i.e. what `t.awaiting` held at
   * `tagAwait` time. Carried so a resumption site can check that the thread is
   * still parked on THAT promise and not on a later one (see the guard at the
   * race's resumption site).
   */
  p: Promise<unknown>;
  value: unknown;
  failure: { error: unknown } | undefined;
};

/**
 * Tagged promises, memoized by the *promise* (not the thread) so re-racing on
 * every turn does not attach a fresh continuation to the same promise, and so
 * a thread that parks again later can never pick up a stale tag.
 */
const taggedAwaits = new WeakMap<Promise<unknown>, Promise<AwaitWinner>>();

function tagAwait(t: AwaitWinner["t"]): Promise<AwaitWinner> {
  const p = t.awaiting!;
  let tag = taggedAwaits.get(p);
  if (tag === undefined) {
    tag = p.then(
      (value): AwaitWinner => ({ t, p, value, failure: undefined }),
      (e): AwaitWinner => ({ t, p, value: undefined, failure: { error: e } }),
    );
    taggedAwaits.set(p, tag);
  }
  return tag;
}

/**
 * THE asynchronous driving loop, exported for the one other driver in the
 * runtime: `HostActivity` in exec/host_streams.ts, which must pump the store
 * BETWEEN export calls (when no lifted call is in flight) with exactly these
 * semantics — service settled tails, tick to quiescence, then await the race
 * of every outstanding promise (parked activations AND `pendingHostCalls`),
 * repeat. Reimplementing it there diverged: that copy only drained
 * `store.awaiting` and never awaited `pendingHostCalls`, so a guest parked on
 * a Promise-returning host import was never resumed and the host's read of
 * the stream it was feeding hung (host-pump starvation of `pendingHostCalls`).
 *
 * Callers that must not hit the deadlock traps below (the host pump: an
 * embedder that never does its half is documented to hang, not trap) can
 * exclude them entirely — BOTH trap sites require
 * `store.pendingHostCalls.size === 0`, and both are reached only through the
 * synchronous fall-through from `done()`, so a `done` that returns true
 * whenever `pendingHostCalls` is empty provably never traps.
 */
export async function driveStoreAsync(
  store: Store,
  done: () => boolean,
  what: string,
): Promise<void> {
  return await driveAsync(store, done, what);
}

/**
 * How many `driveAsync` loops are live on a store.
 *
 * THE INVARIANT is not "only one loop may ever run" — concurrent export calls
 * have always produced concurrent loops, and the host-stream pump's stand-down
 * below is cooperative, so a *bounded overlap window* remains by construction
 * (an export call can start while the pump is parked mid-`await`; the pump
 * notices at its next `done()` evaluation, which the driver-arrival one-shot
 * below now makes prompt — before issue #239 it was "whenever the host happens
 * to answer", i.e. not bounded at all). The invariant is:
 *
 *   **no activation is resumed twice for one settlement, and no activation is
 *   resumed with a value from a settlement it has already consumed.**
 *
 * Overlap is benign for that invariant because of three mechanisms, in
 * decreasing order of how much weight they carry:
 *
 *   (a) LOAD-BEARING — `resumeWith` synchronously deletes the thread from
 *       `store.awaiting` (task/thread.ts `Thread.resumeWith`), and every
 *       resumption site here is guarded by an `store.awaiting.has(...)` test
 *       evaluated synchronously immediately before the call. The loser of a
 *       race therefore sees the deletion. The ordering that makes this
 *       airtight is microtask FIFO: both loops' race continuations were
 *       queued when the *tag* settled, which is strictly before the winner's
 *       `resumeWith` can run and therefore strictly before any re-park the
 *       resumed activation performs can queue a new settlement. So the loser
 *       observes "deleted", never a re-park that restored membership.
 *   (b) `tagAwait` memoizes per PROMISE (not per thread), so overlapping loops
 *       racing the same parked thread await the *same* tag object and see one
 *       settlement, not two independent ones. This is what makes (a)'s
 *       "queued at tag settlement" premise hold across loops.
 *   (c) The store's pending-resumption set (`Store.pendingResumptions`)
 *       serializes the resumption path WITHIN a store: every loop driving
 *       that store yields at its top while `store.hasPendingResumptions()`,
 *       so a settled activation runs before anything else is scheduled.
 *       (Until 2026-08-22 this was a module-global single slot with a
 *       one-claimant assert; per-store multi-entry replaced it — issues #158
 *       mechanism B and #210. Overlapping loops in the sense meant here are
 *       loops on the SAME store, which is exactly what (c) still covers;
 *       loops on different stores never shared a settlement to race for.)
 *
 * (a) is the guarantee; (b) and (c) are what make (a) apply across loops
 * rather than only within one. The one corner (a) does NOT cover — a thread
 * resumed by the *other* loop's `tick`, re-parked on a NEW promise, whose OLD
 * promise then settles late — is closed separately at the resumption site
 * below by comparing promise identity, not just membership.
 *
 * What overlap is NOT benign for is throughput and blame: two loops ticking
 * the same store interleave their `serviceSettled`/`tick` phases, and the
 * host-stream pump was observed to trip `Trap: table entry empty` out of
 * `runCallbackLoop` when it drove unconditionally alongside an export call's
 * loop. Export calls own their loops and cannot yield to anyone; the pumps
 * are *fallback* drivers — the host-activity pump for embedder operations
 * that land BETWEEN export calls, the settlement pump (below) for host-call
 * settlements that land between them — so they are the side that stands
 * down, using the two accessors below, narrowing the window to the
 * cooperative residue described above. When an export call's loop is live it
 * already races `pendingHostCalls` and `store.awaiting`, i.e. it pumps host
 * activity on the embedder's behalf.
 */
const driverDepth = new WeakMap<Store, number>();
const driverIdle = new WeakMap<Store, { p: Promise<void>; r: () => void }>();

export function storeDriverDepth(store: Store): number {
  return driverDepth.get(store) ?? 0;
}

/** Resolves once no `driveAsync` loop is live on `store`. */
export function whenStoreDriverIdle(store: Store): Promise<void> {
  if (storeDriverDepth(store) === 0) return Promise.resolve();
  let w = driverIdle.get(store);
  if (w === undefined) {
    let r!: () => void;
    const p = new Promise<void>((res) => (r = res));
    w = { p, r };
    driverIdle.set(store, w);
  }
  return w.p;
}

// ---------------------------------------------------------------------------
// Driver arrival: closing the overlap window (issue #239)
// ---------------------------------------------------------------------------
//
// The stand-down above ("the pumps are *fallback* drivers") is evaluated only
// at a driver's next `done()`, so the doc's "bounded overlap window" is really
// bounded by whatever the incumbent driver is parked on — and its longest park
// is `Promise.race([...parked tags, ...pendingHostCalls])`, i.e. HOST-CONTROLLED
// time. That is a stall in its own right, and it is fatal in combination with
// the SPECULATIVE resume entry the race holds: `Store.pendingResumptions` is a
// store-wide scheduling gate, so a second driver on the same store spins at
// `driveAsync`'s top and dies at the 10,000-hop internal-bug assert in ~311ms
// (issue #239 — the same-store half of the cross-store stall #210 fixed; see
// `tests/cross_store_driver_test.ts`, whose header describes this gate being
// "held for the entire duration of a guest's wait on a slow host import").
//
// So drivers announce themselves: every `driveAsync` that finds itself the
// second (or later) loop on a store fires this one-shot, which every driver
// races alongside its parked tags. The incumbent wakes within a microtask,
// drops the speculative entry on its way out of the race, and re-evaluates
// `done()` — which is exactly the stand-down the pumps were always supposed to
// perform, now prompt instead of "whenever the host happens to answer".
const driverArrivals = new WeakMap<Store, { p: Promise<null>; r: () => void }>();

/** A one-shot that resolves (to `null`, the race's "nothing settled" value)
 * when another driver starts on `store`. */
function armDriverArrival(store: Store): Promise<null> {
  let n = driverArrivals.get(store);
  if (n === undefined) {
    let r!: () => void;
    const p = new Promise<null>((res) => (r = () => res(null)));
    n = { p, r };
    driverArrivals.set(store, n);
  }
  return n.p;
}

function fireDriverArrival(store: Store): void {
  const n = driverArrivals.get(store);
  if (n === undefined) return;
  // Deleted before resolving so the next `armDriverArrival` mints a fresh,
  // unresolved one-shot: a driver that wakes on this and re-parks must not
  // pick the settled promise back up and spin.
  driverArrivals.delete(store);
  n.r();
}

// ---------------------------------------------------------------------------
// Host-call arrival: the other stale snapshot
// ---------------------------------------------------------------------------
//
// Every park that watches host calls does it by SNAPSHOT — `[...
// store.pendingHostCalls]` is spread once, when the racer parks. A parked
// driver therefore watches the calls that existed at park time and nothing
// else, and the calls a store owns are not a fixed set: guest execution
// registers new ones at the two `pendingHostCalls.add` sites below.
//
// The driver-arrival one-shot above does NOT cover this. It fires when a new
// *driver* starts (`driveAsync` at depth > 1), and the registration that
// opens the hole routinely happens under no new driver at all. Two paths run
// guest code without bumping the driver depth: an export entered through the
// synchronous `drive` path, and `HostActivity.pump()`'s synchronous drain
// (exec/host_streams.ts) while its async half is already parked in
// `driveAsync` — the stream-dom shape, a `readDirect` session live and every
// import awaited from an event handler. Either way the guest lowers a host
// import, the call is registered — and the incumbent parked driver, whose
// snapshot predates it, never hears about it. When that call settles, its
// continuation readies the guest thread and deletes itself from
// `pendingHostCalls`, but nobody drives: the settlement pump is standing down
// because `storeDriverDepth > 0` (the parked driver counts), and the parked
// driver is still waiting on promises that may never settle. The guest is
// resumed by the next unrelated export call. That is the same class as #239 —
// liveness held hostage by whatever an incumbent driver happens to be parked
// on — with the registration, not the arrival of a second loop, as the event
// that goes unheard.
//
// So registrations announce themselves too, on the same one-shot discipline:
// fired by `registerHostCall` below (THE path for both sites) and raced by
// every `driveAsync` park that spreads `pendingHostCalls`, alongside the
// snapshot. A racer wakes within a microtask, re-snapshots (which now includes
// the new call), and re-parks. The settlement pump does not need it: see the
// note at its race.
//
// Kept separate from driver arrival rather than folded into it because the
// two mean different things — "another loop is driving this store, stand
// down" versus "your snapshot is stale, re-take it" — and only the first is
// what `fireDriverArrival`'s callers and doc comment assert.
const hostCallArrivals = new WeakMap<Store, { p: Promise<null>; r: () => void }>();

/** A one-shot that resolves (to `null`, the race's "nothing settled" value)
 * when a new host call is registered on `store`. */
function armHostCallArrival(store: Store): Promise<null> {
  let n = hostCallArrivals.get(store);
  if (n === undefined) {
    let r!: () => void;
    const p = new Promise<null>((res) => (r = () => res(null)));
    n = { p, r };
    hostCallArrivals.set(store, n);
  }
  return n.p;
}

function fireHostCallArrival(store: Store): void {
  const n = hostCallArrivals.get(store);
  if (n === undefined) return;
  // Deleted before resolving, exactly as `fireDriverArrival`: a racer that
  // wakes on this and re-parks must mint a fresh, unresolved one-shot rather
  // than pick the settled promise back up and spin.
  hostCallArrivals.delete(store);
  n.r();
}

/**
 * Register an outstanding host call on `store` and announce it to every
 * parked racer. THE registration path for real host calls — the two lowering
 * sites below go through it, and so does the regression test that pins the
 * announcement (tests/parked_driver_host_call_test.ts), because a raw
 * `pendingHostCalls.add` is exactly the silent registration this closes.
 *
 * (`HostActivity`'s arm in exec/host_streams.ts is deliberately NOT a caller:
 * it re-arms on every embedder notification and means "the embedder may still
 * act", not "the host owes an event" — the same distinction `hasRealHostCall`
 * draws.)
 */
export function registerHostCall(store: Store, promise: Promise<unknown>): void {
  store.pendingHostCalls.add(promise);
  fireHostCallArrival(store);
}

// ---------------------------------------------------------------------------
// The settlement pump: liveness between export calls
// ---------------------------------------------------------------------------
//
// A host-import promise that settles while a driver is live is serviced by
// that driver (`driveAsync` races `store.pendingHostCalls`). One that settles
// while NO driver is live only mutates scheduler state — the registration
// site's continuation delivers results and readies threads, but nothing calls
// `serviceSettled`/`tick`, so the work sits queued until the next export call
// or host stream/future operation happens to drive the store. For a guest
// with genuinely background work — the canonical shape is a task parked WAIT
// on a waitable set whose pending host call is a clock (a componentize-go
// keep-alive ticker, a wasi:clocks `wait-for`) — that turned "the host will
// wake me" into "the embedder's next unrelated call will wake me": a liveness
// gap, not a policy (wasmtime's event loop delivers such wakeups whenever the
// embedder dwells in `run_concurrent`; on a JS host the event loop is always
// dwelling).
//
// The settlement pump closes the gap: whenever a driver exits leaving real
// host calls outstanding (`hasRealHostCall` — activity arms excluded, they
// mean "the embedder may still act", not "the host owes an event"), a
// detached keeper parks on `Promise.race` of those calls and, when one
// settles, drives the store to quiescence with the same loop and the same
// cooperative discipline as the host-activity pump above it in the driver
// hierarchy:
//
//   * it stands down whenever an export call's loop is live
//     (`storeDriverDepth` / `whenStoreDriverIdle`, plus the `> 1` clause in
//     its `done`, exactly as `HostActivity.#pumpAsync`);
//   * its `done` returns true whenever `pendingHostCalls` is empty, which is
//     the precondition of BOTH deadlock traps in `driveAsync` — the pump can
//     therefore never convert the documented embedder-never-acts hang into a
//     trap (see the `driveStoreAsync` note above);
//   * failures park on `store.hostFailure` for the next embedder call to
//     surface, the channel every between-calls driver already uses.
//
// Every real `pendingHostCalls` entry is born during guest execution, i.e.
// inside some driver, so arming at driver exit (`driveAsync`'s finally and
// `drive`'s synchronous completion) observes every registration. A
// HOST-initiated resource dtor (embedder `drop()` between calls) is no
// exception since #160: it is a lifted call like any other, so it brings its
// own driver, and any host call its activation makes is registered inside
// that driver.
//
// STALE SNAPSHOTS: the keeper races the real host calls it saw when it
// parked. A drive it performs can register NEW calls (the keep-alive ticker
// re-arming is the routine case), and `ensureSettlementPump` may be called
// while the keeper is already parked. Both are handled by a nudge promise
// raced alongside the snapshot: arming an already-live pump fires the nudge,
// the keeper wakes, re-snapshots, and re-parks.

const settlementPumps = new WeakSet<Store>();
const settlementNudges = new WeakMap<Store, { p: Promise<void>; r: () => void }>();

function armSettlementNudge(store: Store): Promise<void> {
  let n = settlementNudges.get(store);
  if (n === undefined) {
    let r!: () => void;
    const p = new Promise<void>((res) => (r = res));
    n = { p, r };
    settlementNudges.set(store, n);
  }
  return n.p;
}

function fireSettlementNudge(store: Store): void {
  const n = settlementNudges.get(store);
  if (n !== undefined) {
    settlementNudges.delete(store);
    n.r();
  }
}

/**
 * What an exiting driver must hand over: real host calls it was watching, a
 * queued activation tail (which gates `Store.tick` for every later driver),
 * or a hop-parked thread — the #280 rule ("a driver is not done while ANY
 * thread of ANY task is hop-parked") applied to the exits that cannot
 * evaluate their `done` predicate, i.e. the exception exits.
 */
function pumpWork(store: Store): boolean {
  return hasRealHostCall(store) || store.settled.length > 0 ||
    entryHopThreads(store).length > 0;
}

/**
 * Ensure a settlement pump is watching `store`'s real outstanding host calls.
 * Idempotent and cheap; called at every driver exit. Never throws.
 */
export function ensureSettlementPump(store: Store): void {
  if (settlementPumps.has(store)) {
    // Already parked (or driving): wake it so it re-snapshots the race —
    // this call may be reporting host calls registered after it parked.
    fireSettlementNudge(store);
    return;
  }
  if (store.hostFailure !== undefined) return;
  if (!pumpWork(store)) return;
  settlementPumps.add(store);
  void settlementPumpLoop(store);
}

async function settlementPumpLoop(store: Store): Promise<void> {
  let failed = false;
  try {
    for (;;) {
      // Stand down while any driver is live: it races `pendingHostCalls`
      // itself and services settlements on the guest's behalf.
      while (storeDriverDepth(store) > 0) {
        await whenStoreDriverIdle(store);
      }
      // A parked failure belongs to the next embedder call (the only place
      // it can surface); driving into it here would just consume and re-park
      // it in a loop.
      if (store.hostFailure !== undefined) return;
      const real = realHostCalls(store);
      // A queued tail is serviceable RIGHT NOW: drive without parking. A
      // hop-parked thread lands on the engine's own schedule, so its promise
      // is raced alongside the host calls — that is how an exception exit's
      // orphaned hop (F4/#280) gets an owner.
      const hops = store.settled.length > 0
        ? []
        : entryHopThreads(store).map((t) => t.awaiting).filter((
          p,
        ): p is Promise<unknown> => p !== null);
      if (store.settled.length === 0) {
        if (real.length === 0 && hops.length === 0) return;
        const nudge = armSettlementNudge(store);
        // The host-call arrival one-shot does NOT ride here, deliberately: a
        // registration this snapshot misses always reaches `ensureSettlementPump`
        // (which fires the nudge) — `driveAsync`'s finally, `drive`'s synchronous
        // completion, and `HostActivity.pump()`'s async half is itself a
        // `driveStoreAsync`. Any driver live meanwhile is what we stand down for.
        // Rejections are not this pump's to report: the registration site's
        // own continuation parks them on `store.hostFailure`.
        await Promise.race([
          ...real.map((p) => p.then(() => {}, () => {})),
          ...hops.map((p) => p.then(() => {}, () => {})),
          nudge,
        ]);
        if (storeDriverDepth(store) > 0) continue;
      }
      // Drive unconditionally after a wake: `storeQuiescent` cannot see a
      // READY waiting thread (the usual product of a settlement — the
      // continuation readied the guest and deleted its own host call), so
      // gating the drive on it skips exactly the work this pump exists to
      // do. `driveAsync` drains ready threads before consulting `done`, and
      // a vacuous round exits on its first `done` evaluation.
      await driveStoreAsync(
        store,
        // Quiescence, not completion — and the same three exit clauses as
        // the host-activity pump: nothing only an event-loop turn could
        // advance; `pendingHostCalls` empty (the deadlock traps'
        // precondition, so this pump provably never traps); another driver
        // appeared (ours is the 1).
        () =>
          store.pendingHostCalls.size === 0 ||
          storeQuiescent(store) ||
          storeDriverDepth(store) > 1,
        "settlement pump",
      );
    }
  } catch (e) {
    failed = true;
    store.hostFailure ??= e;
  } finally {
    settlementPumps.delete(store);
    // Close the exit race: an `ensureSettlementPump` that saw us live and
    // fired the nudge after our last snapshot check must not be lost.
    if (
      !failed && store.hostFailure === undefined &&
      storeDriverDepth(store) === 0 && pumpWork(store)
    ) {
      ensureSettlementPump(store);
    }
  }
}

async function driveAsync(
  store: Store,
  done: () => boolean,
  what: string,
  idle: IdlePolicy = "trap",
): Promise<void> {
  const depth = storeDriverDepth(store) + 1;
  driverDepth.set(store, depth);
  // An incumbent driver may be parked in the awaiting-race holding the
  // speculative resume entry — a store-wide gate this loop would otherwise
  // spin on until the 10,000-hop assert (issue #239). Announce ourselves so it
  // stands down within a microtask.
  if (depth > 1) fireDriverArrival(store);
  try {
  let claimHops = 0;
  for (;;) {
    traceDrive("driveAsync", store, done, "top");
    // FIRST: service every settled-but-unserviced activation tail, in settle
    // order (`Store.settled` — armed eagerly at park time). A settled
    // `awaitValue` is the rest of an activation that already finished its
    // wasm; the reference runs that bookkeeping atomically inside
    // `Thread.resume`, so nothing may be scheduled past it (`Store.tick`
    // refuses while the queue is non-empty). Servicing after ticking let a
    // freshly-resumed caller race into an entry gate while a finished
    // callee's body had yet to release the exclusive slot — cancellable.wast
    // then reported STARTING for an entry the reference admits.
    store.serviceSettled();
    if (store.hostFailure !== undefined) throw takeHostFailure(store);
    // A pending resumption of THIS store is an engine-driven resumption in
    // flight: its activation has not yet parked again or finished. It will
    // die on its own — parking consumes it (`blockCurrentActivation`),
    // finishing releases it (`Store.noteAwaiting`'s settle continuation) — so
    // yield microtasks until it does. The driver must NOT blanket-clear here:
    // an entry may have been taken by a guest built-in settling another
    // activation's suspension (`subtask.cancel` delivering a cancellation),
    // and clearing it before that activation runs re-opens the
    // mis-attribution window the entry exists to close.
    //
    // PER-STORE (issue #210): read only THIS store's entries. Activations
    // never cross stores, so another store's pending resumption is none of
    // this loop's business — and a gate shared across stores would spin an
    // idle store's driver here, to its death at the hop bound below in
    // ~311ms, merely because ANOTHER store's guest was dwelling on a slow
    // host import.
    if (store.hasPendingResumptions()) {
      traceDrive("driveAsync", store, done, "yield-pending");
      // Bounded: a pending entry that never dies is an internal bug (every
      // path out of a resumed activation releases it — park, finish, trap),
      // and a pure-microtask wait would otherwise starve the event loop and
      // every stall timer with it. Interleave macrotask hops so timers stay
      // alive, and fail loudly rather than spin forever. Scoped per store,
      // this is again the internal-bug detector it was meant to be.
      claimHops++;
      assert_(
        claimHops < 10_000,
        "driveAsync: a resumed-activation claim was never released " +
          "(the activation neither parked, finished, nor trapped)",
      );
      if (claimHops % 100 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      } else {
        await Promise.resolve();
      }
      continue;
    }
    claimHops = 0;
    while (store.tick()) {
      if (store.hostFailure !== undefined) throw takeHostFailure(store);
      // FAIRNESS between tick-able threads and promise-parked ones. A thread
      // that is READY again on every resume (the callback-ABI YIELD spin)
      // would otherwise monopolize this drain while a parked thread's
      // settled promise waits (the starvation that hung
      // drop-subtask.wast:139), and the engine's own continuations (jspi
      // pin (j)) only ever land on microtask turns. One hop per tick; bail
      // to the top the moment an activation tail lands.
      if (store.awaiting.size > 0) {
        await Promise.resolve();
        if (store.hasServiceableSettled()) break;
      }
    }
    if (store.hostFailure !== undefined) throw takeHostFailure(store);
    if (done()) {
      traceDrive("driveAsync", store, done, "EXIT-done");
      return;
    }
    // Only a SERVICEABLE tail is a reason to loop again: a queue holding
    // only tails DEFERRED on a non-enterable instance (issue #156) would
    // spin this loop hot — nothing in the cycle awaits.
    if (store.hasServiceableSettled() || store.hasPendingResumptions()) {
      continue;
    }
    // Service promise-parked threads (jspi).
    //
    // This must NOT block on one chosen thread's promise. A thread parked on a
    // promising-wrapped nested activation only settles once that activation's
    // own suspension points have been resumed -- and resuming those is
    // `Store.tick`'s job, i.e. *this loop's* job. Awaiting a single promise
    // therefore stops the scheduler while waiting for something that needs the
    // scheduler: a pure-microtask stall with no trap and no rejection.
    // Observed on `async/async-calls-sync.wast` the moment site 1 became the
    // first lit suspension site: turn N serviced a promise that
    // never settled while three other parked threads and three ready-able
    // suspension points went unexamined.
    //
    // So: race every outstanding promise (parked threads AND host calls) and
    // service whichever settles first, re-ticking each turn. The claim is
    // taken in the tagged continuation -- as close to settlement as we can get
    // -- so pin (i)'s window (engine-driven wasm resumption running built-ins
    // before our continuation) is still covered for the thread that actually
    // resumed, without falsely claiming the ambient for threads that did not.
    if (store.awaiting.size > 0) {
      // Is this actually progress, or a deadlock wearing its clothes?
      //
      // Everything in `store.awaiting` is an INTERNAL promise: a
      // promising-wrapped wasm activation. Such a promise settles either on
      // its own (the activation ran to completion -- which happens within one
      // macrotask turn, since the work is already done and only the microtask
      // hop remains) or because WE resume a suspension point it is waiting
      // behind. If no thread is ready, no host call is outstanding, and a full
      // macrotask turn passes with nothing settling, then nobody can move: the
      // awaited promises need us and we need them. That is the deadlock trap
      // (definitions.py `canon_lift`'s empty-candidate-set `trap_if`), and
      // without this check it presents as a silent stall instead -- which is
      // exactly what `tests/jspi/deadlock_test.ts` caught the moment site 2
      // was lit.
      if (store.pendingHostCalls.size === 0 && !store.hasPendingResumptions()) {
        traceDrive("driveAsync", store, done, "deadlock-probe");
        // Exclude threads whose settle is already QUEUED in `store.settled`
        // (issue #156): their promise has settled, so racing them wins
        // instantly off the memoized `tagAwait` tag, forever, in an unbounded
        // microtask chain — the tail is `serviceSettled`'s to run.
        const queued = new Set(store.settled.map((s) => s.t));
        const parked = ([...store.awaiting] as AwaitWinner["t"][]).filter(
          (t) => !queued.has(t),
        );
        const progressed = await Promise.race([
          ...parked.map((t) => tagAwait(t).then(() => true)),
          new Promise<boolean>((r) => setTimeout(() => r(false), 0)),
        ]);
        traceDrive(
          "driveAsync",
          store,
          done,
          `deadlock-probe:progressed=${progressed}`,
        );
        if (!progressed) {
          // The race covered a SNAPSHOT of the awaiting set. A thread that
          // parked during the macrotask turn (a promising callee's body
          // yielding its awaitValue mid-hop — jspi pin (j) makes this
          // routine) was not raced, and its promise may already be settled;
          // trapping now would declare a deadlock one iteration before the
          // loop would have serviced it. Membership change ⇒ re-probe.
          //
          // `fresh` gets the SAME queued-entry filter `parked` got (issue
          // #156), against a RECOMPUTED queued set — the settled queue can
          // change across the probe's await. Comparing a filtered snapshot
          // against an unfiltered one would read "changed" on every turn in
          // the all-deferred wedge state, so the verdict below could never
          // be reached and the wedge would present as a silent
          // macrotask-paced busy idle instead of a trap.
          const freshQueued = new Set(store.settled.map((s) => s.t));
          const fresh = ([...store.awaiting] as AwaitWinner["t"][]).filter(
            (t) => !freshQueued.has(t),
          );
          const changed = fresh.length !== parked.length ||
            fresh.some((t, i) => t !== parked[i]);
          if (changed) continue;
          // The probe's precondition can also expire WITHOUT the awaiting
          // set changing: the same activation resumes off an engine
          // continuation chunk during the probe's macrotask turn (jspi
          // pin (j) — a sync-completing Suspending import still defers its
          // continuation), runs, and re-parks through the suspending mark arm, which
          // registers a fresh `pendingHostCalls` entry. The activation
          // promise never settled and `awaiting` membership is unchanged,
          // but the park is externally wakeable now — the verdict's own
          // precondition (`pendingHostCalls.size === 0`) no longer holds.
          // Observed on wasi-shims' stream/future round-trip poll (sync fast path): probe sampled
          // hostCalls=0 between a settled park and the next one, then
          // trapped a live workload with hostCalls=1. Re-check ⇒ re-probe.
          // Likewise a SERVICEABLE settled entry (issue #156): dispatching
          // it is progress, so this is not a deadlock verdict — re-probe.
          // A deferred-only queue deliberately does NOT re-probe: nothing
          // can dispatch it while the lock is held, and if no host call is
          // outstanding nothing will ever release that lock, so it falls
          // THROUGH to the verdict below — the same loud-wedge treatment the
          // servicing race's own all-deferred fallthrough gets. Per the #156
          // analysis that state is unreachable (a lock spanning this loop's
          // await always has a `pendingHostCalls` entry, which fails this
          // probe's precondition); keeping it loud is what makes it an
          // internal-wedge detector rather than dead code.
          if (
            store.pendingHostCalls.size > 0 || store.hasPendingResumptions() ||
            store.hasServiceableSettled()
          ) {
            continue;
          }
          if (store.readyCandidates().length === 0) {
            if (idle === "exit") {
              traceDrive("driveAsync", store, done, "EXIT-idle");
              return;
            }
            trapIf(
              true,
              `wasm trap: deadlock detected: event loop cannot make ` +
                `further progress (${what}: every suspended activation is ` +
                `waiting on a suspension only this scheduler could resume, ` +
                `and none is ready)`,
            );
          }
          // No promise settled, but a thread became READY while we waited --
          // typically a suspension point whose `readyFunc` turned true because
          // another activation ran during the macrotask turn. The way forward
          // is `Store.tick`, not a promise: go back to the top and resume it.
          // Falling through to the servicing block instead would await
          // promises that nothing will settle while a runnable thread sits
          // there -- the `async/sync-barges-in.wast` stall exactly.
          continue;
        }
        // Progress IS possible: fall through to the normal servicing below,
        // which resumes the settled thread. Returning to the top instead would
        // spin -- the memoized tag is already settled, so the race would win
        // instantly, forever, without anyone being resumed.
      }
      // Re-check membership: the deadlock probe above AWAITS, and everything
      // below reads `[...store.awaiting][0]` as if the set were still
      // non-empty. A thread resumed during the probe (its settle continuation
      // runs `resumeWith`, which deletes it) can empty the set, and the
      // snapshot's `parked[0]` is then `undefined` — the exact check-then-act
      // shape that made the host pump's copy of this loop throw
      // `TypeError: ... (reading 'awaiting')` into `store.hostFailure`, where
      // it poisoned a later unrelated call via check-then-act on `store.hostFailure`. Nothing to
      // service ⇒ go back to the top and re-evaluate `done`.
      // Same re-check for the settled queue, and for the same reason: the
      // probe's macrotask turn can land a fresh, SERVICEABLE activation tail
      // (that is exactly what "progress IS possible" above usually means).
      // The queue owns those threads — the race below deliberately excludes
      // them (issue #156) — so the way forward is the top of the loop, where
      // `serviceSettled` dispatches them. Without this, filtering the
      // just-settled thread out of the race left the loop awaiting promises
      // that only its dispatch could settle (observed: tests/jspi/
      // handshake_test.ts stalled, then tripped the claim assert).
      if (store.awaiting.size === 0 || store.hasServiceableSettled()) continue;
      // Claim the ambient for ONE parked thread and await its promise -- as
      // before, so pin (i)'s window is covered exactly as it was -- but race
      // that promise against every other outstanding promise so this loop can
      // never be held hostage by it. The claimed thread's promise may only be
      // settleable by further scheduler progress (a promising-wrapped nested
      // activation whose own suspension points this loop must still resume);
      // blocking on it alone is the pure-microtask stall described above.
      // Same exclusion as the probe (issue #156): a thread whose tail is
      // already queued in `store.settled` must not be raced — its tag is
      // settled, so it re-wins instantly and livelocks the event loop,
      // starving the very host-call settle that would release the lock.
      const queued = new Set(store.settled.map((s) => s.t));
      const parked = ([...store.awaiting] as AwaitWinner["t"][]).filter(
        (t) => !queued.has(t),
      );
      if (parked.length === 0) {
        // UNREACHABLE BY CONSTRUCTION. `parked` is `store.awaiting` minus
        // the threads whose tails are already queued in `store.settled`, and
        // we only get here with `awaiting` non-empty and
        // `hasServiceableSettled()` false — which means the settled queue is
        // EMPTY, so nothing was excluded. Retained as a wedge detector, not
        // as expected behavior.
        if (store.pendingHostCalls.size > 0) {
          await Promise.race([
            ...store.pendingHostCalls,
            armDriverArrival(store),
            armHostCallArrival(store),
          ]).catch(() => {});
          continue;
        }
        // Per the issue #156 analysis this is unreachable (a spanning lock
        // always has a `pendingHostCalls` entry; a synchronous lock cannot
        // span this loop's await). An internal-wedge detector, not expected
        // behavior.
        traceDrive("driveAsync", store, done, "DEADLOCK-TRAP-deferred");
        trapIf(
          true,
          `wasm trap: deadlock detected: event loop cannot make further ` +
            `progress (${what}: every settled activation tail is deferred ` +
            `on a non-enterable instance and no host call is outstanding)`,
        );
      }
      const chosen = parked[0];
      const chosenTag = tagAwait(chosen);
      const others: Promise<AwaitWinner | null>[] = parked.slice(1).map(tagAwait);
      for (const h of store.pendingHostCalls) {
        others.push(h.then(() => null, () => null));
      }
      // A SPECULATIVE entry: the chosen thread is a promising-wrapped
      // activation, and the engine may run its wasm during this await (pin
      // (i)). It is dropped on the way out — if the activation is genuinely
      // mid-resumption its own exact entry (minted by
      // `SuspensionPoint.resume`) is what carries it, and dropping an entry
      // that names a thread already gone from the set is a no-op.
      //
      // ONLY ITS OWN ENTRY (issue #158): the `finally` must drop the entry
      // THIS loop added and nothing else. A guest-synchronous delivery during
      // the await takes a fresh entry of its own, and clearing that one here
      // would re-open early the very window it exists to close — which is why
      // the gate is a set of entries rather than a single slot.
      //
      // SOLE DRIVER ONLY, AND ONLY UNTIL ONE ARRIVES (issue #239). The entry
      // is a claim over a window this loop cannot bound: the race settles when
      // the HOST answers, which may be never. As a store-wide scheduling gate
      // (`Store.tick` refuses; every driver yields at its top) that is a wedge
      // the moment a second driver exists — it spins at the top of its own
      // loop and dies at the 10,000-hop assert in ~311ms, an internal-bug
      // detector firing on a perfectly ordinary suspended guest. Two concurrent
      // export calls with one slow suspending import were enough; the reported
      // shape was a detached guest task cancelling an in-flight import, which
      // parks mid-frame with no export call outstanding and leaves the
      // settlement pump holding this entry.
      //
      // What the entry protects — "the engine may run `chosen`'s wasm during
      // this await" — it protects by refusing OTHER `Store.tick` callers, and
      // this loop is not one of them while it awaits. The tick callers that
      // can reach a store mid-race are another `driveAsync` loop and
      // `HostActivity.pump`'s synchronous drain (exec/host_streams.ts) — the
      // latter is not gated by driver depth, so scoping the entry to "sole
      // driver" does hand it a window an unscoped entry would close at
      // depth >= 2.
      // What holds regardless is the invariant the `driverDepth` note names:
      // a genuine resumption is preceded by `SuspensionPoint.resume`'s OWN
      // entry (jspi/bridge.ts, minted before the settle), and every
      // resumption site here re-checks membership and promise identity
      // synchronously — mechanisms (a) and (b), which is where that note
      // already puts the weight.
      // ONLY IF WE ADDED IT (issue #158, same rule as the `finally` below):
      // `pendingResumptions` is a Set by identity, so a genuine entry for
      // `chosen` minted meanwhile — or already held — collapses with ours,
      // and removing "ours" would drop the genuine one.
      const sole = storeDriverDepth(store) === 1;
      const added = sole && !store.pendingResumptions.has(chosen);
      if (added) store.addPendingResumption(chosen);
      let winner: AwaitWinner | null;
      try {
        // `armDriverArrival` rides the race for every driver, not just the one
        // holding the entry: waking on a new arrival is also how a fallback
        // pump reaches its next `done()` — i.e. its stand-down — promptly.
        // `armHostCallArrival` rides for the sibling reason: the tags below
        // are a snapshot of what was parked when we entered the race, so a
        // host call registered after that under no new driver (a sync `drive`
        // export, `HostActivity.pump()`'s sync drain — neither fires a driver
        // arrival) can ready a thread with no racer watching for it. See the
        // host-call arrival note above.
        winner = await Promise.race([
          chosenTag,
          ...others,
          armDriverArrival(store),
          armHostCallArrival(store),
        ]);
      } finally {
        if (added) store.removePendingResumption(chosen);
      }
      // Resume whichever thread actually settled -- not necessarily the one we
      // claimed. Resuming only the claimed thread would spin: its promise may
      // never settle, the same thread would be chosen again next turn, and the
      // already-settled tags would win the race instantly forever (observed as
      // an OOM, not a hang). Our own entry is dropped above before any resumption,
      // exactly as on the original single-promise path, so this does not widen
      // the ambient window; it only ensures the loop always makes progress.
      // Membership is not enough: the corner it misses is a thread the OTHER
      // overlapping loop resumed via `tick`, which then re-parked on a NEW
      // promise, after which its OLD promise settles late — membership is
      // true again but the tag's value belongs to a settlement this thread
      // has already consumed. Compare promise identity too.
      // ONE SETTLEMENT, ONE DELIVERY (definitions.py `Thread.resume` is
      // atomic). `noteAwaiting` records settlements EAGERLY, so this
      // promise's `store.settled` entry is already queued; left there, a
      // body that re-parks SYNCHRONOUSLY inside `resumeWith` gets the OLD
      // value delivered against its NEW park by the next `serviceSettled`.
      if (
        winner !== null && store.awaiting.has(winner.t) &&
        winner.t.awaiting === winner.p
      ) {
        for (let i = store.settled.length - 1; i >= 0; i--) {
          if (store.settled[i].t === winner.t) store.settled.splice(i, 1);
        }
        winner.t.resumeWith(winner.value, winner.failure);
      }
      continue;
    }
    if (store.pendingHostCalls.size === 0) {
      if (idle === "exit") {
        traceDrive("driveAsync", store, done, "EXIT-idle");
        return;
      }
      traceDrive("driveAsync", store, done, "DEADLOCK-TRAP");
      trapIf(
        true,
        `wasm trap: deadlock detected: event loop cannot make further ` +
          `progress (${what}: no thread is ready and no host call is ` +
          `outstanding)`,
      );
    }
    traceDrive("driveAsync", store, done, "await-race");
    // Settlement order among several outstanding host calls is the host's,
    // not ours — this is genuine, unavoidable nondeterminism at the boundary
    // (the reference has the same freedom in `Store.tick`). Everything
    // *inside* the component stays deterministic per scheduler.ts.
    //
    // The driver-arrival one-shot rides here too. This is the routine park of
    // a quiet guest with a real host call outstanding — no speculative entry
    // is held, so there is no wedge to break, but a fallback pump parked here
    // would otherwise not reach its `done()` (i.e. its stand-down) until the
    // HOST answered, leaving two loops interleaving `serviceSettled`/`tick`
    // for that whole window. That interleaving is what the `driverDepth` note
    // above calls out as bad for throughput and blame.
    await Promise.race([
      ...store.pendingHostCalls,
      armDriverArrival(store),
      // ... and the host-call-arrival one-shot, because the spread above is a
      // SNAPSHOT: a host call registered while we are parked here under no
      // new driver (a sync `drive` export, `HostActivity.pump()`'s sync drain
      // — neither fires a driver arrival) would otherwise be watched by
      // nobody at all (the settlement pump stands down while we, the parked
      // driver, keep `storeDriverDepth` positive). See the host-call arrival
      // note above.
      armHostCallArrival(store),
    ]).catch(() => {});
  }
  } finally {
    const left = storeDriverDepth(store) - 1;
    driverDepth.set(store, left);
    if (left === 0) {
      const w = driverIdle.get(store);
      driverIdle.delete(store);
      w?.r();
      // The store just went driver-idle; if real host calls remain, hand
      // liveness to the settlement pump (which stands down again the moment
      // any driver starts).
      ensureSettlementPump(store);
    }
  }
}

function takeHostFailure(store: Store): unknown {
  const e = store.hostFailure;
  store.hostFailure = undefined;
  return e;
}

// ---------------------------------------------------------------------------
// canon lift
// ---------------------------------------------------------------------------

/**
 * Build the host-callable function for one lifted export (reference
 * `Store.lift` + `canon_lift`, definitions.py lines 578 and 2154).
 *
 * All three lift shapes go through one `Task` + implicit `Thread`:
 *
 *   * **sync** (`not ft.async`) — call, lift results, `task.return_`,
 *     post-return, then the sync driving loop until the task resolves;
 *   * **async + callback** (stackless) — the packed-code loop
 *     (EXIT / YIELD / WAIT), fully implemented here;
 *   * **async, no callback** (stackful) — the guest blocks mid-stack, which
 *     needs genuine wasm-frame suspension: `needsJspi`, at the precise point.
 */
/**
 * The plain-entered variant of a **sync-typed** lifted export in jspi mode,
 * attached to the promising-wrapped lifted function under this symbol
 * (contracts/embedder-api.md §"Functions and async", §"Functions and async").
 *
 * In jspi mode every promising-wrapped entry returns a Promise even when the
 * activation completes without suspending (jspi pin (e)). Some host contexts
 * cannot use a Promise no matter how promptly it resolves, so each sync-typed
 * export carries a second lifted function whose ENTRY is plain (unwrapped):
 * a guest activation that completes synchronously — the overwhelmingly common
 * case for sync-typed WIT — delivers its results synchronously through it.
 *
 * Two consumers, one mechanism:
 *
 *  * **resource constructors** — a WIT constructor is surfaced as a JS class
 *    constructor (§"Resources") and a JS constructor cannot await, so the
 *    embedder layer reads this symbol unconditionally for `[constructor]`
 *    exports;
 *  * **the embedder `sync()` adapter** — the explicit per-use
 *    synchronous view of any sync-typed export.
 *
 * The cost is confined to genuinely-suspending activations: a blocking
 * built-in reached through the plain entry signals `NeedsJspi` (a capability
 * error, instance left enterable), and a `Suspending`-wrapped host import
 * reached from the unwrapped frame fails as a trap. Both name the export
 * rather than silently deadlocking. A call made while the instance has
 * hop-parked activations refuses with `SyncEntryBusy` before entering
 * (`refuseOnEntryHops` below).
 */
export const SYNC_ENTRY: unique symbol = Symbol("polyengine.syncEntry");

// ---------------------------------------------------------------------------
// Pending async-typed lifts, and their poisoning (#292)
// ---------------------------------------------------------------------------
//
// An async-typed export whose driver exited idle (see `IdlePolicy`) leaves a
// host-visible Promise settled by nothing but the task itself finishing. If
// the task instead dies — a LATER driver runs it and traps — the instance is
// poisoned and that task's threads will never unregister, so the Promise
// would hang forever. That is precisely the failure #66 fixed for parked
// stream/future ends, and it gets the same treatment: a poisoning listener
// that rejects every pending lift of the instance with the poisoning cause.
//
// Registered on the extra-listener seam rather than `setOnInstancePoisoned`
// (which streams.ts owns) — see `addInstancePoisonedListener` for the
// evaluation-order reason both are seams.
const pendingLifts = new WeakMap<object, Set<(cause: unknown) => void>>();

function registerPendingLift(inst: object, reject: (c: unknown) => void): void {
  let s = pendingLifts.get(inst);
  if (s === undefined) pendingLifts.set(inst, (s = new Set()));
  s.add(reject);
}

function unregisterPendingLift(
  inst: object,
  reject: (c: unknown) => void,
): void {
  pendingLifts.get(inst)?.delete(reject);
}

addInstancePoisonedListener((inst, cause) => {
  const s = pendingLifts.get(inst as object);
  if (s === undefined || s.size === 0) return;
  // Drained before dispatch: a rejection handler running synchronously must
  // not see, or re-enter, this set.
  const waiters = [...s];
  s.clear();
  for (const r of waiters) r(cause);
});

export function createLiftedFunction(input: {
  name: string;
  ft: FuncType;
  opts: ResolvedOptions;
  core: CoreFn;
  stats: ExecutionStats;
  /**
   * Suspension discipline for this instantiation (jspi/bridge.ts). In `jspi`
   * mode the export's core function is `promising`-wrapped, so the whole
   * activation can suspend and the lifted function necessarily returns a
   * Promise.
   */
  suspensionMode?: SuspensionMode;
  /** Optional; see intrinsics `HostTrapState`. */
  trapState?: { pending: unknown };
  /**
   * Optional; the executor's sync-call scope stack (intrinsics
   * `SyncCallScope`). Structural, to keep this module free of an import
   * cycle with `../intrinsics/`.
   */
  syncCallStack?: LenderScope[];
  /**
   * Optional; every component instance of this component, for restoring
   * `may_leave` when a trap unwinds out of a FACT adapter.
   */
  allInstances?: () => Iterable<{ mayLeave: boolean }>;
  /**
   * Opt out of the reference's *synchronous* driving loop (`driveSyncLift`,
   * definitions.py `canon_lift` line 2213) for a sync-typed lift whose caller
   * does not need a synchronous answer — today only the host-initiated
   * resource destructor (#160; `createDtorEntry` below, `drop(): void` is
   * documented non-blocking).
   *
   * This is not a weakening of the deadlock trap: `drive` below enforces the
   * same "no ready thread, no pending host call, nothing awaiting" trap, just
   * asynchronously — which is exactly the substitution jspi mode already
   * makes unconditionally (see the comment at the `driveSyncLift` call).
   * It matters only when a *plain*-mode core returns a thenable, i.e. a
   * host-supplied JS destructor: the sync loop sees a thread parked on a
   * Promise, which it can never advance, and declares a bogus deadlock.
   */
  allowAsyncCompletion?: boolean;
  /**
   * Refuse — synchronously, before entering — a call made while the instance
   * has HOP-parked activations, instead of deferring it (§"Functions and async",
   * failure-ladder arm 2).
   *
   * Set for the `SYNC_ENTRY` variant, which is built with
   * `suspensionMode: "plain"` inside a *jspi-mode* instantiation: the
   * hop-quiescence gate below is keyed on this function's own mode and so is
   * dead for that variant, yet the hazard it exists to prevent is the
   * instance's, not the entry's — a hop-parked activation's pending lift
   * reads memory a fresh guest turn would mutate (see the gate's comment).
   * A synchronous caller cannot be deferred, so it refuses instead. The
   * refusal is pre-enter, hence non-poisoning: nothing was entered, so there
   * is nothing to poison — the same structural safety as `entryRefusal`.
   */
  refuseOnEntryHops?: boolean;
  /**
   * Make **async-typed** exports trap on idle instead of leaving their
   * Promise pending (#292). Default false; see `IdlePolicy`.
   *
   * `InstantiateInput.trapOnIdle`'s only consumer is the conformance harness,
   * whose `invoke` directive is a *blocking* call — the wast semantics
   * wasmtime serves with `run_concurrent_trap_on_idle` behind
   * `[Typed]Func::call_async`, not with `call_concurrent`. It is deliberately
   * absent from the embedder layer's options.
   */
  trapOnIdle?: boolean;
}): (...args: ComponentValue[]) => unknown {
  const {
    name,
    ft,
    opts,
    core,
    stats,
    trapState,
    syncCallStack,
    allInstances,
  } = input;
  const inst = opts.instance;
  const store = inst.store;
  const mode: SuspensionMode = input.suspensionMode ?? "plain";
  // Entry wrapping, half of jspi/bridge.ts's invariant: a lifted export's core
  // function is one of the three activations that can reach a blocking
  // built-in, so it is `promising`-wrapped exactly when the imports are
  // `Suspending`-wrapped.
  const enteredCore = enterWasm(core, mode);
  // See the comment at the `drive` call in `invokeNow` and `IdlePolicy`.
  const idlePolicy: IdlePolicy =
    ft.async === true && input.trapOnIdle !== true ? "exit" : "trap";
  const taskOpts: TaskOptions = {
    async_: opts.async,
    callback: opts.callback !== null,
    stringEncoding: opts.stringEncoding,
    memory: opts.memory,
  };

  // definitions.py `canon_lift` only ever sees consistent combinations; the
  // plan could in principle carry others, so reject at instantiate time.
  if (opts.callback !== null && !opts.async) {
    throw new PlanError(
      `export '${name}': canonical options carry a callback but are not ` +
        `async (callback is meaningless for a sync lift)`,
    );
  }

  // Instantiate-time consistency check (descriptor-ir.md "Flattening"):
  // flattening computed from the type must agree with the shim's coreType.
  const computed = flattenFunctype(cabiOptions(opts), ft, "lift");
  if (!coreFuncTypeEquals(computed, opts.coreType)) {
    throw new PlanError(
      `export '${name}': computed flat type ${JSON.stringify(computed)} ` +
        `!= plan coreType ${JSON.stringify(opts.coreType)}`,
    );
  }

  const invokeNow = (hostArgs: ComponentValue[]): unknown => {
    stats.liftedCalls++;
    // A trap remembered during an earlier call must never be attributed to
    // this one (see intrinsics `HostTrapState`).
    if (trapState !== undefined) trapState.pending = undefined;
    // Depth of the sync-call scope stack on entry; see the `finally` below.
    const syncCallDepth = syncCallStack?.length ?? 0;

    // Reference `Store.lift` (@ 2f13265) runs `canon_lift` with NO gate
    // (CM#705), so host entry into a live instance is valid. What this adds
    // is polyengine's per-instance
    // poisoning divergence — a poisoned instance is a corpse, and its refusal
    // names the original trap (polyengine#145 ask 1).
    {
      const refusal = entryRefusal(
        inst,
        null,
        `cannot enter component instance ${inst.index}`,
      );
      if (refusal !== null) trap(refusal);
    }
    let completed = false;

    let resolved: ComponentValue[] | null = null;
    let resolvedSeen = false;
    const task = new Task(
      ft,
      taskOpts,
      inst,
      () => hostArgs,
      (result) => {
        resolved = result;
        resolvedSeen = true;
        stats.tasksResolved++;
      },
    );

    const thread: Thread = new Thread(
      task,
      liftBody({
        name,
        ft,
        opts,
        core: enteredCore,
        stats,
        task,
        thread: () => thread,
        mode,
      }),
    );

    const finishHostEntry = (): unknown => {
      completed = true;
      trapIf(
        !resolvedSeen,
        `${name}: task finished without resolving (deadlock)`,
      );
      if (resolved === null) {
        // definitions.py `Task.cancel`: `on_resolve(None)`. A host-initiated
        // call has no way to express "cancelled" in its return value, and the
        // host never requests cancellation, so reaching this is a bug.
        throw new AssertionError(
          `${name}: task resolved as cancelled, but the host never ` +
            `requested cancellation`,
        );
      }
      return resultsToHost(resolved);
    };

    const unwind = (): void => {
      // Unwind any FACT sync-call brackets a trap escaped.
      //
      // A trap thrown inside an adapter skips that adapter's
      // `exit-sync-call`, so its `SyncCallScope` (and the `num_lends` it
      // holds on the caller's handles) would otherwise survive the call.
      // wasmtime does not need this: it poisons the whole store on trap
      // (`Store::call_hook`/panic-on-reuse semantics), so no later call can
      // observe the stale state. This runtime deliberately supports
      // post-trap re-entry — the `trapState.pending` reset above exists for
      // exactly that — so the state has to be unwound instead. Leaving it
      // would attach the next `transfer-borrow` to a dead scope and leave
      // lent handles permanently un-droppable ("while borrowed" forever).
      if (completed) return;
      // Per-ACTIVATION now (see `Thread.syncCallStack`): unwind the brackets
      // of every activation this task owns, which a trap inside a FACT adapter
      // skipped. A task can have several threads, so the loop is over threads.
      for (const t of task.threads as { syncCallStack: unknown[] }[]) {
        while (t.syncCallStack.length > 0) {
          (t.syncCallStack.pop() as LenderScope).releaseLenders();
        }
      }
      void syncCallStack;
      void syncCallDepth;
      // FACT clears the callee's / caller's `may_leave` flag around each
      // lift and lower (`fact/trampoline.rs`, `set_may_leave_false`) and
      // restores it afterwards. A trap in between skips the restore, so an
      // instance can be left permanently unable to leave — every later call
      // through an adapter then trips FACT's own `CannotLeaveComponent`
      // check. With the stack unwound to the host boundary no lift or lower
      // is in flight, so `may_leave` is true for every instance by
      // definition; assert that resting state rather than leaving the
      // component bricked.
      //
      // The ENTERED instance is excluded: it is poisoned by this trap (see
      // `poison` below) and must stay exactly as the trap left it. Restoring
      // its `may_leave` would be tidying the state of an instance that is no
      // longer allowed to run at all.
      for (const i of allInstances?.() ?? []) {
        if (i as unknown as ComponentInstanceState !== inst) {
          i.mayLeave = true;
        }
      }
    };

    /**
     * A trap escaped the task: mark the instance poisoned.
     *
     * polyengine's NAMED DIVERGENCE. definitions.py has no notion of a
     * post-trap instance at all — a Trap is the end of the world — and
     * wasmtime's answer is to poison the whole store. This runtime keeps the
     * component graph alive and buries only the instance that trapped: it is
     * not in a known state, so it may never be entered again, and the next
     * call reports `cannot enter component instance` with the recorded cause
     * appended (polyengine#145 ask 1).
     * `test/async/builtin-trap-poisons-instance.wast` asserts exactly this,
     * twice; the marker (`notifyInstancePoisoned`) is the whole mechanism.
     *
     * Only `inst` is affected; sibling instances stay usable.
     *
     * Poisoned instances can never rendezvous again, so their handle tables'
     * live stream/future ends are retired here (#66): parked host operations
     * settle (DROPPED) instead of hanging forever, and the recorded failure
     * lets the embedder layer reject them loudly.
     */
    const poison = (e: unknown): void => {
      // Through the seam (not retireInstanceAsyncEnds directly) so the
      // poison marker is recorded too — `Thread.resumeWith` retires this
      // instance's late settles against it instead of assert-cascading.
      notifyInstancePoisoned(
        inst as unknown as { handles: Iterable<unknown> },
        e,
      );
    };

    /**
     * Is `e` a *capability* signal rather than a genuine trap?
     *
     * `NeedsJspi` and `PendingCapability` mean "this runtime is incomplete",
     * not "the component faulted". Poisoning on them is wrong on the
     * reference's own terms: the operation they stand in for — a synchronous
     * stream copy, `waitable-set.wait`, a blocking cross-component call —
     * *blocks and then completes* in definitions.py. Every one of those
     * executions returns normally there, so the instance stays healthy.
     * Poisoning would attribute a permanent fault to a component
     * that, on a complete runtime, is perfectly healthy — and it cascades:
     * one unsupported operation made every later call on that instance report
     * `cannot enter component instance`, which is neither our real behaviour
     * nor the reference's.
     *
     * What unwinding must still do on this path, and what it must not:
     *
     *  - MUST unwind the FACT sync-call scopes and restore `may_leave`
     *    (`unwind`), for exactly the reasons it does after a trap: a bail-out
     *    mid-adapter skips `exit-sync-call` and the `may_leave` restore, and
     *    that state is shared with sibling instances.
     *  - MUST NOT try to "finish" the abandoned operation. A stream end left
     *    in `CopyState.COPYING` with its buffer parked in the shared object is
     *    the honest record of "this copy never happened"; the counterpart has
     *    not been notified and must not be, because on a complete runtime the
     *    copy would still be pending. Likewise a `prepare-call` slot consumed
     *    by a `*-start-call` that then bailed is already cleared by
     *    `takePrepared`, so nothing leaks there.
     *  - MUST NOT resolve or cancel the task: the host call fails, and the
     *    task simply never resolved.
     *
     * In other words the instance is left exactly as a *pending* operation
     * would leave it, which is the truthful state, and the only thing the
     * embedder loses is the result of this one call.
     */
    const isCapabilitySignal = (e: unknown): boolean =>
      e instanceof NeedsJspi || e instanceof PendingCapability;

    try {
      thread.resume();
      // definitions.py `canon_lift` (line 2213): the sync driving loop runs
      // *inside* the enter/leave bracket, over the callee instance's threads.
      //
      // It is skipped in jspi mode, and must be. That loop resumes *ready*
      // threads and traps when there are none — the reference's deadlock
      // trap. A thread parked on a Promise is neither ready nor waiting: only
      // a microtask turn can advance it, which a synchronous loop cannot give.
      // Running it anyway declared a bogus deadlock the moment a sync-lifted
      // export's activation suspended, which then trap-poisoned the instance
      // and abandoned the activation mid-bracket — the orphaned
      // `exit-sync-call` traced across phases 3h-3j.
      //
      // `drive` below is the correct driver in that mode: it knows about
      // `store.awaiting`, still enforces the deadlock trap (no ready thread,
      // no pending host call, nothing awaiting), and returns a Promise, which
      // a jspi-mode lifted export returns anyway.
      if (!ft.async && mode !== "jspi" && !input.allowAsyncCompletion) {
        driveSyncLift(task);
      }
    } catch (e) {
      unwind();
      if (!isCapabilitySignal(e)) poison(e);
      throw e;
    }

    /**
     * The task outlived its driver (#292): hand the host a Promise settled by
     * the task itself.
     *
     * Resolution rides `finishHostEntry` unchanged — it already holds
     * `completed`/`resultsToHost` — fired from `Task.onFinished`, i.e. the
     * moment this task's last thread unregisters. That point is safe for the
     * old `done` predicate's task-scoped clauses: `resolvedSeen` is
     * guaranteed (`unregisterThread`'s own `trapIf(state !== "resolved")`
     * fires first otherwise), and this task's threads are gone from
     * `store.awaiting`, so `midWasmCall()` is false by construction.
     * `hopParked()` is deliberately NOT re-tested: a hop is the obligation of
     * the driver that put it in flight (#280), never of a Promise waiting on
     * another task.
     *
     * Rejection has two sources: `finishHostEntry` itself throwing, and the
     * instance being poisoned by a later driver that ran this task into a
     * trap. Neither calls `unwind()`. A trap on the background path happens
     * under ANOTHER driver's `invokeNow`, whose own `catch` already unwinds
     * the FACT sync-call scopes and restores `may_leave` — running it twice
     * would restore sibling instances' `may_leave` from underneath a lift
     * that driver is still mid-flight in. This mirrors what already happens
     * to a post-`task.return` producer thread that traps later.
     */
    const backgroundCompletion = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        // Degenerate case: the task is already over (its threads unregistered
        // during the drive) and only a foreign hop kept `done` false. Nothing
        // will fire `onFinished`, so settle now.
        if (task.threads.length === 0) {
          try {
            resolve(finishHostEntry());
          } catch (e) {
            reject(e);
          }
          return;
        }
        const onPoison = (cause: unknown): void => {
          task.onFinished = null;
          reject(cause);
        };
        registerPendingLift(inst, onPoison);
        task.onFinished = () => {
          unregisterPendingLift(inst, onPoison);
          try {
            resolve(finishHostEntry());
          } catch (e) {
            reject(e);
          }
        };
      });

    let pending: void | Promise<void>;
    let driveDone: () => boolean = () => true;
    try {
      // Completion is "the task resolved AND its threads have drained", not
      // merely "resolved". `task.return` resolves the task, but the activation
      // is not finished until its implicit thread reaches
      // `exit_implicit_thread` — for a callback task that means running the
      // loop out to EXIT, which releases `inst.exclusiveThread`.
      //
      // In plain mode the two almost always coincide, because the generator
      // runs to completion inside one `resume()`. Under JSPI they do not: the
      // guest calls `task.return` while the activation is still suspended, so
      // the old predicate let the driver return early and the thread was
      // abandoned mid-loop — leaking the exclusive thread and its table slot.
      // The lifted call is over when the task has resolved AND this task's
      // activation is no longer mid-wasm-call. Those are two different events
      // and both matter:
      //
      //   * "task resolved" alone abandons a still-running activation. Under
      //     JSPI the guest calls `task.return` while suspended, so returning
      //     there left the callback loop parked forever — leaking the
      //     exclusive thread and its table slot.
      //   * "activation finished" alone deadlocks a *producer* guest, which
      //     legitimately keeps forwarding after `task.return`
      //     (wit-bindgen `wit_stream::new()` + a spawned loop).
      //
      // The distinguishing question is *what* the thread is parked on. An
      // `awaitValue` park means a wasm call is in flight and will settle on
      // its own, so we must keep draining. A park in `store.waiting` means the
      // activation is waiting on a scheduler condition only the embedder can
      // satisfy — that is a **background activation**: we return to the host
      // and leave the thread live, and later `drive`/`pump` calls (host stream
      // writes, the next export call) go on servicing it.
      //
      // AND THE PARK NEED NOT BE THIS TASK'S (issue #280). Scoping the
      // wasm-call test to `task.threads` under-approximates the reference
      // embedding, whose loop drains the whole store (`while store.waiting:
      // store.tick()`, run_tests.py `lift_and_run`). What it missed is an
      // activation THIS DRIVER PUT IN FLIGHT: a background task's host import
      // settles on a microtask while this driver is live, this driver's
      // `tick` resumes that task's callback activation, the promising entry
      // hop-parks it (jspi pin (j) — contracts/intrinsics.md §"JSPI
      // integration constraints" 4), and then this predicate — blind to
      // another task's threads — declared the driver done. Nobody else owned
      // that hop: the settlement pump arms only on outstanding real host
      // calls, and the call that caused the resumption had already settled
      // and left `pendingHostCalls`. Trace: `EXIT-done ... awaiting=1`, then
      // an activation nothing services until an unrelated later call happens
      // to drive the store.
      //
      // So the rule: a driver is not done while ANY thread of ANY task is
      // hop-parked. A hop settles on the engine's own schedule, so waiting
      // for it is bounded — the driver that caused it must see it land. The
      // two tests are complementary and both stay: `hopParked` deliberately
      // EXCLUDES genuinely JSPI-suspended activations (SuspensionPoint-owned
      // parks, which only the embedder can satisfy and which are exactly the
      // "background activation" case above), and `midWasmCall` is what still
      // covers this task's own suspended thread.
      const midWasmCall = () => task.threads.some((t) => store.awaiting.has(t));
      const hopParked = () => entryHopThreads(store).length > 0;
      driveDone = () => resolvedSeen && !midWasmCall() && !hopParked();
      // ASYNC-TYPED EXPORTS DO NOT TRAP ON IDLE (#292). definitions.py
      // `canon_lift` runs the driving loop — and with it the
      // empty-candidate-set `trap_if` — only `if not ft.async_` (line 2189);
      // for an async-typed export it returns right after the first
      // `thread.resume()` and driving is the embedder's `Store.tick`, which
      // never traps. wasmtime splits the same way (`run_concurrent` =
      // `poll_until(trap_on_idle=false)` vs the `pub(super)`
      // `run_concurrent_trap_on_idle` behind the blocking `call_async`), and
      // polyengine's Promise-shaped export is the `call_concurrent` side.
      // So the driver EXITS — it does not park and does not trap — and the
      // task is left live for whichever driver next runs the store (the next
      // export call, the settlement pump, a host stream op): exactly the
      // between-calls liveness that already services post-`task.return`
      // producer threads. Repro: an async export parked WAITing on an
      // intra-component future a later export call writes.
      // Sync-typed exports are unchanged: their loop traps on idle in every
      // mode, which is what the paragraphs above describe.
      pending = drive(
        store,
        driveDone,
        `export '${name}'`,
        idlePolicy,
      );
    } catch (e) {
      unwind();
      throw e;
    }
    if (pending === undefined) {
      try {
        if (idlePolicy === "exit" && !driveDone()) return backgroundCompletion();
        return finishHostEntry();
      } catch (e) {
        unwind();
        throw e;
      }
    }
    return pending.then(() => {
      if (idlePolicy === "exit" && !driveDone()) return backgroundCompletion();
      return finishHostEntry();
    }, (e) => {
      unwind();
      throw e;
    });
  };

  return (...hostArgs: ComponentValue[]): unknown => {
    // sync() arm 2: the synchronous variant refuses rather than deferring, and
    // does so FIRST — before the arity check's sibling logic reaches
    // `invokeNow` — because the refusal must be pre-enter to stay
    // non-poisoning. See `refuseOnEntryHops` above for why the mode-keyed
    // gate below cannot cover this variant.
    if (input.refuseOnEntryHops && entryHopThreads(store, inst).length > 0) {
      throw new SyncEntryBusy(name);
    }
    if (hostArgs.length !== ft.params.length) {
      throw new TypeError(
        `${name}: expected ${ft.params.length} argument(s), got ${hostArgs.length}`,
      );
    }
    // THE HOP-QUIESCENCE GATE (jspi mode only; hop_atomicity_test.ts).
    //
    // A promising-wrapped entry settles a microtask AFTER the guest's core
    // call returns, even when nothing suspended (jspi pin (j)) — so there
    // is a hop between core return and the host-side result LIFT, with
    // nothing holding the instance against another host entry. In the
    // reference no such window exists: `canon_lift` for sync options runs
    // core + lift atomically. Admitting another host call into the
    // window lets a full guest turn mutate the memory the pending lift
    // will read — observed as `Trap: list too long` lifting the wosh
    // engine's `tick` (`list<list<u8>>`) after a concurrent `feed-keys`
    // turn reused the return area.
    //
    // The gate: defer this call until the instance has no HOP-parked
    // activation. A hop-park is an `awaiting` thread with no owning
    // `SuspensionPoint` — the same discriminator `hasRunnableWork` uses;
    // genuinely JSPI-suspended activations (SuspensionPoint-owned) keep
    // today's documented interleaving (the wasmtime-tracking divergence in
    // jspi/bridge.ts), which host-import re-entry patterns rely on.
    // Plain mode has no hops and keeps its synchronous fast path exactly.
    if (mode === "jspi" && entryHopThreads(store, inst).length > 0) {
      return awaitHopQuiescence(store, inst).then(() => invokeNow(hostArgs));
    }
    return invokeNow(hostArgs);
  };
}

/**
 * Threads parked on a promising-entry hop: in `store.awaiting` with no
 * `SuspensionPoint` owner in `store.waiting` (that would be a genuine JSPI
 * suspension). Mirrors `Store.hasRunnableWork`'s (b)/(c) split.
 *
 * `inst` narrows the result to one component instance — what the
 * hop-quiescence gate needs, since the memory a pending lift will read
 * belongs to that instance. Omitted, the result is store-wide: what the
 * export driver's `done` predicate needs (issue #280), where the question is
 * not whose memory is at risk but whether any activation this driver put in
 * flight is still mid-hop.
 */
function entryHopThreads(
  store: Store,
  inst?: unknown,
): { awaiting: Promise<unknown> | null }[] {
  if (store.awaiting.size === 0) return [];
  const suspended = new Set<unknown>();
  for (const w of store.waiting) {
    const owner = (w as { owner?: unknown }).owner;
    if (owner !== undefined && owner !== null) suspended.add(owner);
  }
  const out: { awaiting: Promise<unknown> | null }[] = [];
  for (const t of store.awaiting) {
    const tt = t as unknown as {
      task: { inst: unknown };
      awaiting: Promise<unknown> | null;
    };
    if (inst !== undefined && tt.task.inst !== inst) continue;
    if (!suspended.has(t)) out.push(tt);
  }
  return out;
}

/**
 * Wait until `inst` has no hop-parked activation. Each settled hop is
 * serviced synchronously (`serviceSettled` runs the lift segment), after
 * which the activation either completed or re-parked; re-derive and
 * repeat. Progress is guaranteed: a hop promise settles on the engine's
 * own schedule, independent of any other activation of the instance, and
 * a settled-but-unserviced hop resolves the race instantly. Multiple
 * gated callers re-derive independently (no strict FIFO; starvation-free
 * in practice because hops are sub-microtask).
 */
async function awaitHopQuiescence(store: Store, inst: unknown): Promise<void> {
  for (;;) {
    const hops = entryHopThreads(store, inst);
    if (hops.length === 0) return;
    await Promise.race(
      hops.map((t) => (t.awaiting ?? Promise.resolve()).then(
        () => undefined,
        () => undefined,
      )),
    );
    store.serviceSettled();
  }
}

// ---------------------------------------------------------------------------
// Host-initiated resource destructors (#160)
// ---------------------------------------------------------------------------

/**
 * The canonical function type of a destructor: definitions.py
 * `canon_resource_drop` (line 2326) — `FuncType([U32Type()], [], async_ = False)`.
 */
const DTOR_FT: FuncType = {
  params: [{ kind: "u32" }],
  results: [],
  async: false,
};

/**
 * `CanonicalOptions(async_ = False)` (definitions.py line 2325): every field
 * at its inert default. A dtor takes one flat `i32` and returns nothing, so
 * no memory / realloc / post-return / callback is ever reached.
 */
function dtorOptions(instance: ComponentInstanceState): ResolvedOptions {
  return {
    stringEncoding: "utf8",
    memory: null,
    realloc: null,
    postReturn: null,
    callback: null,
    async: false,
    cancellable: false,
    coreType: { params: ["i32"], results: [] },
    instance,
  };
}

/**
 * Build the host-callable entry for a resource destructor — a full canonical
 * **lift**, exactly as definitions.py `canon_resource_drop` (line 2319) does:
 *
 * ```python
 *   opts = CanonicalOptions(async_ = False)
 *   ft = FuncType([U32Type()], [], async_ = False)
 *   dtor = rt.dtor or (lambda rep: [])
 *   callee = inst.store.lift(dtor, ft, opts, rt.impl)
 * ```
 *
 * The host-initiated paths (embedder `drop()`, the GC backstop, `dropOwn`)
 * route through this harness rather than calling the dtor bare, because the
 * activation then has a real `Task` + implicit `Thread`: built-ins reached
 * inside the dtor are well-attributed (a bare call leaves `currentTask()`
 * with no ambient task — `PendingCapability`, or a foreign-task
 * misattribution, the #24 class), and settled tails flow through
 * `serviceSettled` like any other lifted sync call.
 *
 * The returned function takes the rep and returns either `undefined` (the
 * activation completed synchronously — the overwhelmingly common case) or a
 * Promise, exactly like any lifted sync export in jspi mode.
 */
export function createDtorEntry(input: {
  /** Diagnostic name; appears in deadlock/trap messages. */
  name?: string;
  /**
   * The destructor's core function, unwrapped: `createLiftedFunction` applies
   * `enterWasm` itself per `suspensionMode`. `null` is the reference's
   * `rt.dtor or (lambda rep: [])` — the lift still runs.
   */
  dtor: CoreFn | null;
  /** `rt.impl`, the implementing instance the lift enters. */
  instance: ComponentInstanceState;
  suspensionMode?: SuspensionMode;
  stats?: ExecutionStats;
  trapState?: { pending: unknown };
  syncCallStack?: LenderScope[];
  allInstances?: () => Iterable<{ mayLeave: boolean }>;
}): (rep: number) => unknown {
  const mode = input.suspensionMode ?? "plain";
  const raw: CoreFn = input.dtor ?? (() => undefined);
  // A dtor's core type is `(i32) -> ()`, but the *host*-supplied dtors this
  // helper also serves (embedder test doubles, `ResourceTypeInfo` built
  // directly) are ordinary JS functions whose incidental return value would
  // otherwise trip `normalizeCoreValues`' arity check. Discard it — except a
  // thenable, which is the activation itself and must reach `awaitCore`'s
  // park. Not applied in jspi mode: `WebAssembly.promising` only accepts a
  // wasm callable, so the core must be passed through untouched there (and a
  // real wasm dtor returns nothing by construction).
  const core: CoreFn = mode === "jspi" ? raw : ((rep: number) => {
    const r = raw(rep);
    return isPromiseLike(r) ? r : undefined;
  });
  const lifted = createLiftedFunction({
    name: input.name ?? "[resource-dtor]",
    ft: DTOR_FT,
    opts: dtorOptions(input.instance),
    core,
    stats: input.stats ?? newStats(),
    suspensionMode: mode,
    trapState: input.trapState,
    syncCallStack: input.syncCallStack,
    allInstances: input.allInstances,
    // The host does not wait for a destructor: `drop(): void` is
    // non-blocking, and an unfinished dtor's tail is driven by the store.
    allowAsyncCompletion: true,
  });
  return (rep: number) => lifted(rep);
}

/**
 * Run a host-initiated drop of a guest (or host-implemented) resource rep —
 * the observable remainder of `canon_resource_drop` for an owning handle when
 * the holder is the host (`caller = None`, `Store.invoke`).
 *
 * A failure that arrives asynchronously has no frame to propagate into, so it
 * is parked on the store's host-failure channel (first failure wins), where
 * the next driven call surfaces it. The completion promise is deliberately
 * NOT registered in `store.pendingHostCalls`: that registration was #160's
 * lie — it claims *external* work for a promise whose settlement may need
 * this very scheduler. The dtor's genuine external dependencies (its host
 * imports) register themselves when they park. Poisoning on a trap now
 * happens inside the lift harness (`poison()` in `createLiftedFunction`).
 */
export function hostDtorCall(rt: ResourceTypeInfo, rep: number): void {
  const impl = rt.impl;
  // An imported (host-implemented) resource has `impl === null` by
  // construction (executor `bindImportedResources`): there is no component
  // instance to gate entry into, so the dtor is called directly, as before.
  if (impl === null) {
    rt.dtor?.(rep);
    return;
  }
  if (rt.dtorHost === null) {
    // The executor pre-wires `dtorHost` for every defined resource; this is
    // the direct-construction path (embedder test doubles, and any token that
    // reached the host without going through the `resource` initializer).
    rt.dtorHost = createDtorEntry({
      dtor: rt.dtor,
      instance: impl as unknown as ComponentInstanceState,
    });
  }
  const out = rt.dtorHost(rep);
  if (isPromiseLike(out)) {
    const store = (impl as unknown as { store?: Store }).store;
    Promise.resolve(out as Promise<unknown>).catch((e: unknown) => {
      if (store !== undefined && store.hostFailure === undefined) {
        store.hostFailure = e;
      }
    });
  }
}

/**
 * Call into wasm and hand back the result, awaiting it only if it is a
 * Promise.
 *
 * This is the whole of the jspi entry seam. In **plain** mode the entry is not
 * `promising`-wrapped, `callCore` returns core values, and this returns them
 * without yielding — no await, no Promise allocation, the identical
 * synchronous path plain mode always used. In **jspi** mode the entry *is* wrapped, so the
 * call returns a Promise (jspi pin (e)) and we park the thread on it via the
 * `awaitValue` block request; the driving loop resumes us with the values, or
 * throws the rejection in (a post-resume trap).
 */
export function* awaitCore(
  fn: CoreFn,
  args: CoreValue[],
  // deno-lint-ignore no-explicit-any
  thread: any,
): Generator<BlockRequest, CoreValue[], unknown> {
  // Enter wasm with the activation-attached ambient in scope. In jspi mode the
  // engine captures this context when it registers its resumption, so a
  // built-in called by the resumed activation can recover its thread even when
  // nobody is driving (see `withActivation`).
  const raw = withActivation(thread, () => callCore(fn, args));
  // `callCore` normalizes a bare value to a one-element array; a promising
  // entry yields `[Promise]`.
  if (raw.length === 1 && isPromiseLike(raw[0])) {
    const settled = yield {
      readyFunc: null,
      cancellable: false,
      // A rejection of the promising Promise is a core trap by another route
      // (jspi pin (e)); translate it exactly as `callCore` translates a
      // synchronous throw, so the embedder sees one `Trap` vocabulary in both
      // modes (see `mapCoreException`).
      awaitValue: Promise.resolve(raw[0] as unknown as Promise<unknown>).then(
        undefined,
        (e) => {
          throw mapCoreException(e);
        },
      ),
    };
    if (settled === undefined) return [];
    return Array.isArray(settled) ? settled as CoreValue[] : [settled as CoreValue];
  }
  return raw;
}

/** definitions.py `CallbackCode` (line 2220). */
enum CallbackCode {
  EXIT = 0,
  YIELD = 1,
  WAIT = 2,
}
const CALLBACK_CODE_MAX = 2;

/** definitions.py `unpack_callback_result` (line 2226). */
export function unpackCallbackResult(
  packed: number,
): [code: CallbackCode, waitableSetIndex: number] {
  // Reference parity insurance only: callers already guarantee this range via
  // core-result normalization before calling in.
  assert_(
    packed >= 0 && packed < 2 ** 32,
    `unpack-callback-result: packed out of range: ${packed}`,
  );
  const code = packed & 0xf;
  trapIf(code > CALLBACK_CODE_MAX, `invalid callback code ${code}`);
  return [code as CallbackCode, packed >>> 4];
}

/**
 * The body of `canon_lift`'s implicit thread (definitions.py line 2155),
 * as a generator so its block points are real suspension points of the
 * host-side thread model (see task/scheduler.ts).
 */
function* liftBody(input: {
  name: string;
  ft: FuncType;
  opts: ResolvedOptions;
  core: CoreFn;
  stats: ExecutionStats;
  task: Task;
  thread: () => Thread;
  mode: SuspensionMode;
}): Generator<BlockRequest, void, Cancelled> {
  const { name, ft, opts, core, stats, task } = input;
  const thread = input.thread();
  const inst = opts.instance;

  if (!(yield* task.enterImplicitThread(thread))) return;

  const cx = new LiftLowerContext(cabiOptions(opts), inst, task);
  const args = task.start();
  const flatArgs = lowerFlatValues(cx, MAX_FLAT_PARAMS, args, ft.params);

  if (!opts.async) {
    const flatResults = normalizeCoreValues(
      yield* awaitCore(core, flatArgs, thread),
      opts.coreType.results,
      `${name} results`,
    );
    const results = liftFlatValues(
      cx,
      MAX_FLAT_RESULTS,
      new CoreValueIter(flatResults),
      ft.results,
    );
    task.return_(results);
    // Post-return runs after the results were read out of guest memory,
    // with may_leave cleared (reference canon_lift).
    const postReturn = require(opts.postReturn, `${name} post-return`);
    if (postReturn !== null) {
      assert_(inst.mayLeave, "post-return with may_leave already false");
      inst.mayLeave = false;
      callCore(postReturn, flatResults);
      inst.mayLeave = true;
      stats.postReturnsRun++;
    }
    task.exitImplicitThread(thread);
    return;
  }

  if (opts.callback === null) {
    // definitions.py line 2179: `[] = call_and_trap_on_throw(callee, flat_args)`
    // — the guest keeps running on its own stack and blocks inside wasm at
    // whatever built-in it chooses. There is no return-to-host between the
    // call and the block, so the only way to model it is genuine wasm-frame
    // suspension.
    //
    // In jspi mode that is exactly what happens and no special handling is
    // needed: the entry is `promising`-wrapped, so the activation suspends on
    // whichever blocking built-in it reaches and `awaitCore` parks this thread
    // until it finishes. Results arrive through `task.return`, so there is
    // nothing to lift here.
    if (input.mode !== "jspi") {
      needsJspi(
        `stackful async lift of export '${name}' (async canonical options ` +
          `without a callback)`,
      );
    }
    yield* awaitCore(core, flatArgs, thread);
    task.exitImplicitThread(thread);
    return;
  }

  // --- callback ABI (definitions.py lines 2183-2214) ----------------------
  //
  // Stackless by construction: every wasm activation *returns* a packed code,
  // and all waiting happens on the host side between activations. This is the
  // path wit-bindgen 0.60 emits for every async export, and it needs no JSPI.
  // The callback export is the second of the three entries that can reach a
  // blocking built-in (jspi/bridge.ts's invariant), so it is wrapped exactly
  // like the lifted core. Leaving it plain while the core was promising was a
  // *mixed* activation, which pin (c) punishes: the first Suspending import
  // it reached would trap.
  const callback = enterWasm(
    require(opts.callback, `${name} callback`)!,
    input.mode,
  );
  const [packed] = normalizeCoreValues(
    yield* awaitCore(core, flatArgs, thread),
    opts.coreType.results,
    `${name} results`,
  ) as [number];
  yield* runCallbackLoop({ name, task, thread, inst, callback, packed, stats });
  task.exitImplicitThread(thread);
}

// ---------------------------------------------------------------------------
// canon lower
// ---------------------------------------------------------------------------

/**
 * Build the core-callable body for one lowered host import (reference
 * `canon_lower`, definitions.py line 2242).
 *
 * Sync and async lowers share one `Subtask` and one pair of
 * `on_start`/`on_resolve` closures, exactly as the reference does; the sync
 * case is the degenerate one where the callee resolves before returning.
 *
 * The host callee is a plain JS function. If it returns a **Promise**, the
 * subtask resolves when that promise settles:
 *
 *   * async lower — fully supported and JSPI-free. The guest gets a STARTED
 *     subtask back, joins it to a waitable set, returns WAIT from its
 *     callback, and the scheduler delivers the SUBTASK event once the promise
 *     settles. This is the flagship capability of this phase: an ordinary
 *     `async` JS function is a valid Component Model async import.
 *   * sync lower — the guest's wasm frame would have to block
 *     (`thread.wait_until(subtask.resolved)`, line 2286), so: `needsJspi`.
 */
export function createLoweredImport(input: {
  name: string;
  ft: FuncType;
  opts: ResolvedOptions;
  hostFn: (...args: unknown[]) => unknown;
  stats: ExecutionStats;
  /** Executor's suspension mode; decides whether a sync lower may park. */
  mode: SuspensionMode;
  /** Host fn carries the `suspending()` brand (embedder-api.md suspending mark). */
  suspendable: boolean;
  /**
   * Host fn carries the `deferCancel()` brand (embedder-api.md cancellation discard): the
   * import must run to completion, so a cancellation is accepted and ignored
   * instead of taking the default discard.
   */
  deferCancel: boolean;
  /**
   * Host fn carries the `abortable()` brand (embedder-api.md abortable()): every call
   * receives a fresh `AbortSignal` appended after the WIT-declared params, and
   * the runtime aborts it when — and only when — the call is discarded by a
   * guest cancellation.
   */
  abortable: boolean;
}): CoreFn {
  const {
    name,
    ft,
    opts,
    hostFn,
    stats,
    mode,
    suspendable,
    deferCancel,
    abortable,
  } = input;
  const inst = opts.instance;
  const store = inst.store;

  const computed = flattenFunctype(cabiOptions(opts), ft, "lower");
  if (!coreFuncTypeEquals(computed, opts.coreType)) {
    throw new PlanError(
      `import '${name}': computed flat type ${JSON.stringify(computed)} ` +
        `!= plan coreType ${JSON.stringify(opts.coreType)}`,
    );
  }

  // definitions.py lines 2250-2256.
  const maxFlatParams = opts.async ? MAX_FLAT_ASYNC_PARAMS : MAX_FLAT_PARAMS;
  const maxFlatResults = opts.async ? 0 : MAX_FLAT_RESULTS;

  return (...rawFlatArgs: CoreValue[]): unknown => {
    stats.loweredCalls++;
    // Reference canon_lower: trap_if(!inst.may_leave).
    trapIf(
      !inst.mayLeave,
      `cannot leave component instance ${inst.index} (may_leave violation)`,
    );
    const subtask = new Subtask();
    const cx = new LiftLowerContext(cabiOptions(opts), inst, subtask);
    const vi = new CoreValueIter(
      normalizeCoreValues(rawFlatArgs, opts.coreType.params, `${name} args`),
    );

    /**
     * definitions.py's `maybe_on_progress`: a no-op until the subtask has been
     * given a handle index, then the pending-event setter. Assigning it only
     * after the callee returned unresolved is deliberate in the reference —
     * an eagerly-resolving callee must never produce an event.
     */
    let onProgress: () => void = () => {};

    const onStart = (): ComponentValue[] => {
      onProgress();
      assert_(
        subtask.state === SubtaskState.STARTING,
        `${name}: on_start on a started subtask`,
      );
      subtask.state = SubtaskState.STARTED;
      return liftFlatValues(cx, maxFlatParams, vi, ft.params);
    };

    const onResolve = (result: ComponentValue[] | null): void => {
      onProgress();
      if (result === null) {
        assert_(
          subtask.cancellationRequested,
          `${name}: resolved as cancelled without a cancellation request`,
        );
        subtask.resolve(
          subtask.state === SubtaskState.STARTING
            ? SubtaskState.CANCELLED_BEFORE_STARTED
            : SubtaskState.CANCELLED_BEFORE_RETURNED,
          [],
        );
        return;
      }
      assert_(
        subtask.state === SubtaskState.STARTED,
        `${name}: on_resolve on a subtask that never started`,
      );
      // Spilled results use the trailing retptr lane(s) of the flat args
      // (reference passes the same iterator as out_param).
      const flatResults = lowerFlatValues(
        cx,
        maxFlatResults,
        result,
        ft.results,
        vi,
      );
      subtask.resolve(SubtaskState.RETURNED, flatResults);
    };

    // --- invoke the host callee (the reference's `callee(...)`, line 2283) --
    //
    // definitions.py assigns the callee's `OnCancel` here:
    //   `subtask.on_cancel = callee(on_start, on_resolve, caller = ...)`
    //
    // The `OnCancel` is the CALLEE's to supply: `Store.invoke` takes it back
    // from the callee it invoked (`on_cancel = f(on_start, on_resolve, caller
    // = None)`, definitions.py line 572), i.e. the reference expects the
    // embedding to hand back the cancellation behaviour of whatever it is
    // hosting. A wasmtime host gets a real one for free — dropping a Rust
    // future IS cancellation. A JS Promise has no such channel, so polyengine
    // answers on the host's behalf; §"Functions and async" makes the DEFAULT answer the
    // reference's prompt-cancel host (`on_cancel = () => on_resolve(None)`),
    // installed by the async arm below.
    //
    // The no-op assigned HERE is only the placeholder for paths where
    // `subtask.cancel` is unreachable, so no answer can ever be demanded of
    // it: an eagerly-resolving callee never mints a subtask handle (the
    // fast-path return below is a bare state), and a sync-typed import's suspending mark
    // park never mints one either. It is also the FINAL handler for a
    // `deferCancel()`-branded import — accept and ignore, the pre-cancellation discard
    // behaviour, now per-declaration.
    //
    // Leaving `on_cancel` null instead made a *legal* `subtask.cancel` crash
    // with an internal AssertionError, which is neither reference behaviour
    // nor a sanctioned incompleteness signal.
    subtask.onCancel = () => {};
    // abortable() (contracts/embedder-api.md §"Functions and async"): a marked import
    // is handed a fresh `AbortSignal` after its WIT-declared parameters. The
    // mark controls the SIGNATURE UNCONDITIONALLY — a marked function receives
    // a signal on every call, including the paths where it can never fire
    // (sync-typed, eager resolve, `deferCancel`) — so the host's arity is a
    // property of its declaration, not of how a particular call happened to
    // go. `new AbortController()` is evaluated only for marked imports, which
    // keeps bare engine shells with no `AbortController` off this path for the
    // whole unmarked corpus.
    const controller = abortable ? new AbortController() : null;
    const args = onStart();
    const raw = controller === null
      ? hostFn(...args)
      : hostFn(...args, controller.signal);
    const toResults = (v: unknown): ComponentValue[] =>
      ft.results.length === 0 ? [] : [v as ComponentValue];

    if (isPromiseLike(raw)) {
      if (!opts.async) {
        if (mode !== "jspi" || !suspendable) {
          // definitions.py line 2286: `thread.wait_until(subtask.resolved)` —
          // blocking the calling *wasm frame*. Parking needs BOTH jspi mode
          // and the embedder's per-declaration `suspending()` marker: the
          // Suspending wrap is applied per-declaration (`importValue`), so an
          // unmarked import physically cannot suspend, whatever the mode.
          //
          // A capability signal is expressly NON-poisoning (the
          // trap-unwind/lender-release obligation, contracts/intrinsics.md §A):
          // the caller keeps running, so the borrows
          // `onStart` lifted into this subtask must be discharged here or
          // its lenders stay elevated forever and later `resource.drop`s
          // trap "handle still lent out" on a healthy instance (found
          // during the #106 closure; same class as the fact_calls.ts #91
          // sites).
          subtask.unwindLenders();
          needsJspi(
            suspendable
              ? `synchronous lower of import '${name}', whose host ` +
                `implementation returned a Promise (the guest's wasm frame ` +
                `must block)`
              : `synchronous lower of import '${name}', whose host ` +
                `implementation returned a Promise; a sync-typed import may ` +
                `only park the frame when declared with suspending() ` +
                `(contracts/embedder-api.md §"Functions and async")`,
          );
        }
        // The park: the reference's plain, NON-cancellable wait — a
        // cancel request against the caller stays pending-cancel and is
        // delivered at its next cancellable wait, exactly as for any other
        // mid-frame block. The instance-entry gate stays HELD across the park
        // (the #43 hold rule; see `blockCurrentActivation`'s GATE LIFETIME
        // note).
        //
        // The settle handler only RECORDS the outcome. All CABI work —
        // `onResolve`'s result lowering (which may re-enter the guest through
        // realloc) and `deliverResolve` — is deferred to `produce`, which
        // runs at resume time under the suspension point's ambient claim.
        // Lowering from the bare promise continuation instead would execute
        // guest code in an unattributed chunk — the issue-#24 class the
        // attribution sentinels exist to prevent.
        let outcome: { value: unknown } | { error: unknown } | undefined;
      // The async arm runs `onResolve` — result lowering, including possible
      // realloc re-entry into the guest — in this bare promise continuation,
      // where the sync arm above defers all CABI work to `produce` (the
      // issue-#24 attribution note). The asymmetry is deliberate (#93): here
      // no wasm frame is suspended mid-call — the guest returned BLOCKED and
      // is between activations, which is exactly when the reference's
      // `on_resolve` runs (the callee's turn), so there is no activation for
      // the sentinels to attribute this chunk to. Lowering failures are host
      // failures, not guest traps: they land on `store.hostFailure` and the
      // driving loop raises them site-named (pinned by
      // tests/async_lower_onresolve_failure_test.ts).
      const promise = Promise.resolve(raw).then(
          (v) => {
            store.pendingHostCalls.delete(promise);
            outcome = { value: v };
          },
          (e) => {
            store.pendingHostCalls.delete(promise);
            outcome = { error: e };
          },
        );
        // Registered so the driver's deadlock probe counts this park as
        // externally-wakeable (driveAsync: `pendingHostCalls.size === 0` is a
        // precondition of the deadlock verdict) and so teardown can observe
        // the outstanding call, mirroring the async arm below.
        registerHostCall(store, promise);
        // LENDER DISCHARGE ON EVERY SETTLE PATH (#106, the sibling of the
        // fact_calls.ts sync-start park's #102 enumeration):
        //
        //  * produce SUCCESS   -> `onResolve` + `deliverResolve` release the
        //    lenders; the `onSettled` backstop below observes
        //    `resolveDelivered()` and is a no-op.
        //  * produce THROW     -> exempt under the trap-unwind/lender-release
        //    obligation (contracts/intrinsics.md §A: release is owed only on exits
        //    that do NOT poison the caller). Every rejection that reaches
        //    this park is a poisoning trap in the CALLER's own frame:
        //    branded `ComponentException`s on fallible imports were already resolved
        //    into err-shaped VALUES by the conventions layer
        //    (embedder/instantiate.ts `#wrapImportFn`'s `fail` — they take
        //    the success arm above), every other conventions-layer throw is
        //    a `Trap`, and a raw-executor rejection is a declared host bug
        //    that traps (empirical fact (e)). No capability signal can
        //    originate inside `produce`: this park only exists once jspi +
        //    `suspending()` were both granted. The backstop's unwind here is
        //    belt-and-braces bookkeeping on a poisoned instance, not an
        //    obligation.
        //  * abandon           -> produce never runs, and an abandoned park
        //    does NOT poison the caller (pinned by
        //    resource_lender_park_settle_test.ts) — without the hook the
        //    subtask's lenders stayed elevated forever and later
        //    `resource.drop`s trapped "handle still lent out". The hook is
        //    the fix.
        return blockCurrentActivation({
          store,
          task: currentTask(),
          readyFunc: () => outcome !== undefined,
          cancellable: false,
          produce: () => {
            const done = outcome as { value: unknown } | { error: unknown };
            if ("error" in done) {
              // A rejection of a sync-typed import is a host failure: it
              // reaches the guest as a rejection of the import's Promise,
              // which the engine turns back into a wasm trap (empirical
              // fact (e); `SuspensionPoint` routes a produce-throw through
              // exactly that path). Branded `ComponentException`s never reach the raw
              // boundary — the conventions layer resolves them into
              // err-shaped values one layer up (see the settle-path
              // enumeration above).
              throw done.error;
            }
            onResolve(toResults(done.value));
            subtask.deliverResolve();
            assert_(vi.done(), `${name}: unconsumed flat arguments`);
            const flatResults = subtask.flatResults;
            if (flatResults.length === 0) return undefined;
            if (flatResults.length === 1) return flatResults[0];
            return flatResults;
          },
          onSettled: () => subtask.unwindLenders(),
        });
      }
      const promise = Promise.resolve(raw).then(
        (v) => {
          store.pendingHostCalls.delete(promise);
          // cancellation discard: the subtask may already be resolved when the host promise
          // settles — the discard `onCancel` below resolved it
          // CANCELLED_BEFORE_RETURNED (the only pre-settle resolver on this
          // arm). The value has no addressee, and `onResolve` would run
          // straight into its `state === STARTED` assert ("on_resolve on a
          // subtask that never started") and park that AssertionError on
          // `store.hostFailure`, poisoning whatever unrelated embedder call
          // came next.
          // POISONED is the same discard (arch §6 #173): no addressee, and
          // lowering would write into the corpse's memory via its `realloc`.
          if (subtask.resolved() || isInstancePoisoned(opts.instance)) return;
          try {
            onResolve(toResults(v));
          } catch (e) {
            store.hostFailure = e;
          }
        },
        (e) => {
          store.pendingHostCalls.delete(promise);
          // Same guard, different reason: a rejection of a RENOUNCED call is
          // not a host failure. The guest cancelled and was told so; surfacing
          // the rejection would fail an unrelated later call with the error of
          // an operation nobody is waiting for. POISONED is the same discard
          // (arch §6 #173): it would fail a HEALTHY sibling's export call.
          if (subtask.resolved() || isInstancePoisoned(opts.instance)) return;
          store.hostFailure = e;
        },
      );
      registerHostCall(store, promise);
      if (!deferCancel) {
        // cancellation discard DISCARD (contracts/embedder-api.md §"Functions and async";
        // polyengine#241) — the reference's prompt-cancel host,
        // `on_cancel = () => on_resolve(None)` (definitions.py canon_lower's
        // null branch, line ~2267).
        //
        // This runs synchronously inside `canon_subtask_cancel`, which already
        // set `cancellationRequested` before calling us (the assert in
        // `onResolve`'s null branch relies on that ordering). `onResolve(null)`
        // arms the SUBTASK event — a delivery-time thunk — and resolves
        // CANCELLED_BEFORE_RETURNED, so the built-in's `finish()` tail consumes
        // the event, `deliverResolve` releases the lenders (the #106 class,
        // discharged exactly as a RETURNED delivery would), and BOTH cancel
        // forms return the state without blocking. The null path lowers
        // nothing, so there is no realloc re-entry from inside a built-in.
        //
        // The renounced call can no longer wake the guest, so it must stop
        // counting as externally-wakeable for the driver's deadlock probe:
        // deregister it NOW. (The settle continuation above also deletes;
        // `Set.delete` is idempotent.)
        subtask.onCancel = () => {
          store.pendingHostCalls.delete(promise);
          onResolve(null);
          if (controller !== null) {
            // abortable(): tell the host its result was discarded, so it can stop the
            // underlying operation — clear a timer, abort a fetch, close a
            // dial. Reachable only from this arm by construction: a
            // `deferCancel()` import never discards, so its signal never
            // fires.
            //
            // Deferred one microtask. This closure runs SYNCHRONOUSLY inside
            // `canon_subtask_cancel`, i.e. inside a live guest activation, and
            // host abort listeners must not execute there — that is the
            // issue-#24 attribution class, plus arbitrary re-entrancy into a
            // guest mid-built-in. `Promise.resolve().then`, not
            // `queueMicrotask`: the latter does not exist in bare engine
            // shells (see jspi/bridge.ts's SENTINEL_TICK note).
            //
            // The resulting order is: the guest observes
            // CANCELLED_BEFORE_RETURNED first, the host observes the abort a
            // tick later. Any settlement the abort provokes (typically an
            // `AbortError` rejection) arrives at the settle continuation above
            // with the subtask already resolved, so it lands on the cancellation discard
            // resolved-subtask guards and is discarded like any other late
            // settlement — never a `store.hostFailure`.
            Promise.resolve().then(() => controller.abort());
          }
        };
      }
    } else {
      onResolve(toResults(raw));
    }

    // definitions.py line 2284: a sync-*typed* callee must have resolved.
    assert_(
      ft.async || subtask.resolved(),
      `${name}: a non-async-typed import must resolve before returning`,
    );

    if (!opts.async) {
      if (!subtask.resolved()) {
        needsJspi(
          `synchronous lower of import '${name}' on an unresolved subtask`,
        );
      }
      subtask.deliverResolve();
      assert_(vi.done(), `${name}: unconsumed flat arguments`);
      const flatResults = subtask.flatResults;
      if (flatResults.length === 0) return undefined;
      if (flatResults.length === 1) return flatResults[0];
      return flatResults;
    }

    // --- async lower (definitions.py lines 2289-2309) ----------------------
    if (subtask.resolved()) {
      // Eager-resolve fast path: no handle, no event, no waitable — the guest
      // learns the call is done from the return value alone.
      subtask.deliverResolve();
      assert_(
        subtask.flatResults.length === 0,
        `${name}: async lower produced flat results`,
      );
      return SubtaskState.RETURNED;
    }
    const subtaski = inst.handles.add(subtask);
    onProgress = () => subtask.setSubtaskPendingEvent(subtaski);
    return packSubtaskResult(subtask.state, subtaski);
  };
}


/**
 * The callback-ABI dispatch loop of `canon_lift` (definitions.py lines
 * 2183-2214), factored out so both entry points share one implementation:
 *
 *   * a host-boundary lift (`liftBody` above), and
 *   * a FACT cross-component call, where the host invokes an async-lifted
 *     callee on the caller's behalf (`intrinsics/fact_calls.ts`).
 *
 * `packed` is the code the *initial* activation returned; the loop runs until
 * it sees EXIT, invoking the callback export with each delivered event.
 */
export function* runCallbackLoop(input: {
  name: string;
  task: Task;
  thread: Thread;
  inst: ComponentInstanceState;
  callback: CoreFn;
  packed: number;
  stats: ExecutionStats;
}): Generator<BlockRequest, void, Cancelled> {
  const { name, task, thread, inst, callback, stats } = input;
  let [code, si] = unpackCallbackResult(input.packed);

  while (code !== CallbackCode.EXIT) {
    // definitions.py line 2187, verbatim shape: the implicit thread of a
    // needs-exclusive callback task holds the slot on every loop iteration.
    // (The former per-iteration `holding` check tolerated a resolved task
    // that had released the slot at a mid-frame block — the release-at-BLOCK
    // divergence removed by issue #43. Under the hold rule, which is both the
    // reference's and wasmtime's — `do_not_enter` is set for each callback
    // invocation, concurrent.rs :942/:960 — the invariant is unconditional.)
    assert_(
      task.needsExclusive() &&
        inst.exclusiveThread === task.implicitThread,
      "callback loop without holding the exclusive thread",
    );
    // Releasing the exclusive thread across the wait is what lets *another*
    // task of the same instance enter and run while this one waits — the
    // whole point of the callback ABI (definitions.py line 2188). Equally,
    // RETAKING it below is what defers event delivery to a parked-between-
    // invocations task while any invocation of this instance is mid-frame:
    // the `() => inst.exclusiveThread === null` guard on the wait is the
    // reference's `wait_for_event_and(lambda: not inst.exclusive_thread)`
    // (line 2199) and wasmtime's `GuestCall::is_ready` DeliverEvent arm,
    // which requires `!do_not_enter` (concurrent.rs :765).
    inst.exclusiveThread = null;
    let event: EventTuple;
    switch (code) {
      case CallbackCode.YIELD: {
        const cancelled = yield* thread.waitUntil(
          () => inst.exclusiveThread === null,
          true,
        );
        event = cancelled
          ? [EventCode.TASK_CANCELLED, 0, 0]
          : [EventCode.NONE, 0, 0];
        break;
      }
      case CallbackCode.WAIT: {
        const wset = inst.handles.get(si);
        trapIf(
          !(wset instanceof WaitableSet),
          `callback returned WAIT with index ${si}, which is not a waitable set`,
        );
        event = yield* (wset as WaitableSet).waitForEventAnd(
          thread,
          () => inst.exclusiveThread === null,
          true,
        );
        break;
      }
      default:
        trap(`invalid callback code ${code}`);
    }
    assert_(
      inst.exclusiveThread === null,
      "exclusive thread taken while this task was waiting",
    );
    inst.exclusiveThread = task.implicitThread;
    stats.callbackInvocations++;
    const [next] = normalizeCoreValues(
      yield* awaitCore(callback, [event[0], event[1], event[2]], thread),
      ["i32"],
      `${name} callback result`,
    ) as [number];
    [code, si] = unpackCallbackResult(next);
  }
}
