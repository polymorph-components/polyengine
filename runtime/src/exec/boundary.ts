// Canonical host boundary: sync, callback and stackful lifts, host-import
// lowers, destructor entries, and store drivers. See definitions.py
// `canon_lift` / `canon_lower` and docs/architecture.md §5-7.

import {
  type CanonicalOptions,
  type ComponentValue,
  type CoreFuncType,
  coreFuncTypeEquals,
  type CoreType,
  type CoreValue,
  CoreValueIter,
  flattenFunctype,
  type FuncType,
  liftFlatValues,
  LiftLowerContext,
  lowerFlatValues,
  MAX_FLAT_ASYNC_PARAMS,
  MAX_FLAT_PARAMS,
  MAX_FLAT_RESULTS,
  type MemInst,
  type PtrType,
  type ResourceTypeInfo,
  trap,
  trapIf,
} from "../cabi/mod.ts";
import { assert_, AssertionError } from "../cabi/trap.ts";
import {
  addInstancePoisonedListener,
  type BlockRequest,
  type Cancelled,
  type ComponentInstanceState,
  driveSyncLift,
  entryRefusal,
  EventCode,
  type EventTuple,
  hasRealHostCall,
  instancePoisonCause,
  isInstancePoisoned,
  NeedsJspi,
  needsJspi,
  notifyInstancePoisoned,
  packSubtaskResult,
  PendingCapability,
  realHostCalls,
  type Store,
  storeQuiescent,
  Subtask,
  SubtaskState,
  SyncEntryBusy,
  Task,
  type TaskOptions,
  Thread,
  WaitableSet,
  withActivation,
} from "../task/mod.ts";
import { currentTask } from "../task/scheduler.ts";
import { DeferredHostResult, type HostSettlement } from "./host_settlement.ts";
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
  /** Cancellability for option-indexed built-ins, including
   * `canon_waitable_set_wait` / `canon_waitable_set_poll`. Other built-ins
   * such as thread.yield carry their flags on the trampoline declaration. */
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
    // Flattening tests callback presence, not its resolved function value.
    callback: opts.callback === null ? null : opts.callback,
  };
}

/**
 * Call core wasm and map RuntimeError to a canonical trap (`call_and_trap_on_throw`).
 * Preserve engine diagnostic text; suite wording normalization belongs to
 * harness/src/runner.ts, not the runtime. Other exceptions pass through.
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
 * Shared translation for synchronous core throws and promising-entry
 * rejections: post-suspension traps arrive through the Promise path.
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
// Unlike `canon_lift`'s instance-local sync loop, these embedding drivers
// service the whole store, including host promises and JSPI continuations.
// Callback-ABI host waits need no suspended wasm frame; JSPI entry hops also
// make a call asynchronous even when no host import returned a Promise.

/** True for thenables, which is what "is this host call asynchronous" means. */
function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

// ---------------------------------------------------------------------------
// Optional driver tracing
// ---------------------------------------------------------------------------
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
    verdict = w.ready?.()
      ? "READY"
      : (w.readyFunc === null ? "explicit" : "not-ready");
  } catch (e) {
    verdict = `threw:${e}`;
  }
  return `${kind}[${verdict}]`;
}

function traceDrive(
  loop: string,
  store: Store,
  done: () => boolean,
  branch: string,
): void {
  if (!DRIVE_TRACE) return;
  let doneVerdict = "?";
  try {
    doneVerdict = String(done());
  } catch (e) {
    doneVerdict = `threw:${e}`;
  }
  const waiters = store.waiting.map(describeWaiter).join(",");
  const awaiters = [...store.awaiting].map((t) => {
    const a = t as {
      constructor?: { name?: string };
      task?: { label?: string };
    };
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
 * No-progress policy while `done()` is false. Sync-typed lifts trap, matching
 * definitions.py `canon_lift`'s empty-candidate check. Async-typed lifts exit
 * idle and leave their result Promise pending for a later driver; the
 * reference does not run its sync loop for them. The harness can opt into
 * trapping idle async calls. Pump predicates stop before the idle trap.
 */
type IdlePolicy = "trap" | "exit";

/**
 * Snapshot of why the driver exited: its predicate held, or it ran out of
 * moves under `idle: "exit"`. Callers must use this verdict, not re-test a
 * shared-store predicate after an await; another driver may have changed it.
 */
type DriveExit = "done" | "idle";

/**
 * Pump `store` until `done()` holds. Returns the exit verdict directly if
 * that was settled synchronously, or a Promise of it otherwise.
 *
 * Under `idle: "exit"` the verdict may be `"idle"`, i.e. it returned with
 * `done()` still false; see `IdlePolicy` and `DriveExit`.
 */
function drive(
  store: Store,
  done: () => boolean,
  what: string,
  idle: IdlePolicy = "trap",
): DriveExit | Promise<DriveExit> {
  try {
    return driveLoop(store, done, what, idle);
  } catch (e) {
    // Sibling host calls and activation tails survive this driver's failure.
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
): DriveExit | Promise<DriveExit> {
  for (;;) {
    traceDrive("drive", store, done, "top");
    // Promise-parked threads need microtasks; a synchronous YIELD loop would
    // starve them. Hand those stores to the interleaved async drain.
    while (store.awaiting.size === 0 && store.tick()) {
      traceDrive("drive", store, done, "ticked");
      if (store.hostFailure !== undefined) throw takeHostFailure(store);
    }
    if (store.hostFailure !== undefined) throw takeHostFailure(store);
    if (done()) {
      traceDrive("drive", store, done, "EXIT-done");
      // No async finally will run: hand off any background work here.
      ensureSettlementPump(store);
      return "done";
    }
    // Awaiting activations and pending resumptions need an event-loop turn.
    if (store.awaiting.size > 0 || store.hasPendingResumptions()) {
      traceDrive("drive", store, done, "->async(awaiting/pending)");
      return driveAsync(store, done, what, idle);
    }
    if (store.pendingHostCalls.size === 0) {
      // An idle async task remains live for a later driver.
      if (idle === "exit") {
        traceDrive("drive", store, done, "EXIT-idle");
        ensureSettlementPump(store);
        return "idle";
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
  t: {
    awaiting: Promise<unknown> | null;
    resumeWith(v: unknown, f?: { error: unknown }): void;
  };
  /** Park identity: membership alone cannot distinguish a later re-park. */
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
 * Shared async driver for host activity and settlement pumps. Service tails,
 * tick, then race awaiting activations and host calls. A pump that must stay
 * pending rather than trap on idle must make `done()` true whenever
 * `pendingHostCalls` is empty; idle traps require the opposite exit decision.
 */
export async function driveStoreAsync(
  store: Store,
  done: () => boolean,
  what: string,
): Promise<void> {
  // The exit verdict is for `drive`'s lift caller (see `DriveExit`); the
  // pumps drive to quiescence and have nothing to decide on it.
  await driveAsync(store, done, what);
}

/**
 * Live async drivers per store. Concurrent exports may overlap; fallback
 * pumps stand down cooperatively when another driver arrives. There is no
 * single-driver invariant.
 *
 * Each settlement must be delivered once to its original park. `resumeWith`
 * deletes awaiting membership synchronously; race winners check both that
 * membership and promise identity, then remove queued copies before resuming.
 * Per-promise tags share settlement reactions across racers. Per-store
 * pending-resumption gates give engine continuations a turn before more ticks.
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
// Driver arrival
// ---------------------------------------------------------------------------
//
// Wake incumbents so they release speculative gates and re-evaluate `done`
// without waiting for a possibly unbounded host call to settle.
const driverArrivals = new WeakMap<
  Store,
  { p: Promise<null>; r: () => void }
>();

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
// Host-call arrival
// ---------------------------------------------------------------------------
//
// Promise races watch snapshots. Synchronous export entry or host-activity
// draining can register a call without starting a new async driver. Announce
// every registration so parked drivers refresh their snapshots independently
// of the driver-arrival stand-down signal.
const hostCallArrivals = new WeakMap<
  Store,
  { p: Promise<null>; r: () => void }
>();

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
 * Register real host work and wake parked racers. Use this rather than adding
 * directly to `pendingHostCalls`. HostActivity arms are different: they mean
 * the embedder may act, not that an external result is outstanding.
 */
export function registerHostCall(
  store: Store,
  promise: Promise<unknown>,
): void {
  store.pendingHostCalls.add(promise);
  fireHostCallArrival(store);
}

// ---------------------------------------------------------------------------
// The settlement pump: liveness between export calls
// ---------------------------------------------------------------------------
//
// Every driver exit, including exceptions, hands off real host calls, queued
// tails and hop-parked activations. The keeper drives their wakeups without
// requiring another export call. It stands down for live drivers, stops at
// quiescence rather than task completion, and parks failures on hostFailure.
// Activity arms are excluded. Re-arming a live keeper nudges it to refresh its
// snapshot, including calls registered by a drive it performed itself.

const settlementPumps = new WeakSet<Store>();
const settlementNudges = new WeakMap<
  Store,
  { p: Promise<void>; r: () => void }
>();

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
 * Work needing an owner after driver exit, including exception exits.
 */
function pumpWork(store: Store): boolean {
  return hasRealHostCall(store) || store.settled.length > 0 ||
    entryHopThreads(store).length > 0;
}

/**
 * Ensure a settlement pump owns outstanding host calls, tails and entry hops.
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
      // Queued tails need no await; orphaned entry hops are raced with host work.
      const hops = store.settled.length > 0
        ? []
        : entryHopThreads(store).map((t) => t.awaiting).filter((
          p,
        ): p is Promise<unknown> => p !== null);
      if (store.settled.length === 0) {
        if (real.length === 0 && hops.length === 0) return;
        const nudge = armSettlementNudge(store);
        // Driver exits nudge this snapshot; active drivers own new work meanwhile.
        // Registration continuations, not this race, report host rejections.
        await Promise.race([
          ...real.map((p) => p.then(() => {}, () => {})),
          ...hops.map((p) => p.then(() => {}, () => {})),
          nudge,
        ]);
        if (storeDriverDepth(store) > 0) continue;
      }
      // Drain after every wake: storeQuiescent does not count ready waiters
      // left by a host settlement that already removed its call registration.
      await driveStoreAsync(
        store,
        // Stop before idle traps, at quiescence, or when another driver arrives.
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
): Promise<DriveExit> {
  const depth = storeDriverDepth(store) + 1;
  driverDepth.set(store, depth);
  // Wake incumbents to release speculative gates and let fallback pumps stand down.
  if (depth > 1) fireDriverArrival(store);
  try {
    let claimHops = 0;
    for (;;) {
      traceDrive("driveAsync", store, done, "top");
      // Complete settled activation bookkeeping before any scheduling decision.
      store.serviceSettled();
      if (store.hostFailure !== undefined) throw takeHostFailure(store);
      // Yield for this store's engine resumptions. Only their execution/park
      // or settlement may release them; never clear other owners' entries.
      if (store.hasPendingResumptions()) {
        traceDrive("driveAsync", store, done, "yield-pending");
        // Bound leaked claims, interleaving timer turns to avoid starving
        // the event loop while diagnosing an internal scheduling failure.
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
        // A READY/YIELD loop must not starve promise settlements. Give engine
        // continuations a microtask per tick and service any landed tails first.
        if (store.awaiting.size > 0) {
          await Promise.resolve();
          if (store.hasServiceableSettled()) break;
        }
      }
      if (store.hostFailure !== undefined) throw takeHostFailure(store);
      if (done()) {
        traceDrive("driveAsync", store, done, "EXIT-done");
        return "done";
      }
      // Queued tails and pending resumptions take priority over parking.
      if (store.hasServiceableSettled() || store.hasPendingResumptions()) {
        continue;
      }
      // Race all activations and host calls. Awaiting one chosen activation
      // alone could stop the scheduler that its nested suspension needs.
      if (store.awaiting.size > 0) {
        // With no external work or pending resumption, allow a timer turn for
        // engine hops to settle before declaring idle. Internal activation
        // promises alone do not establish that further progress is possible.
        if (
          store.pendingHostCalls.size === 0 && !store.hasPendingResumptions()
        ) {
          traceDrive("driveAsync", store, done, "deadlock-probe");
          // Queued tails belong to serviceSettled; racing their settled tags
          // repeatedly would create an unbounded microtask loop.
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
            // Revalidate the snapshot after awaiting. Apply the same queued-tail
            // filter to both snapshots, using the current queue for the new one.
            const freshQueued = new Set(store.settled.map((s) => s.t));
            const fresh = ([...store.awaiting] as AwaitWinner["t"][]).filter(
              (t) => !freshQueued.has(t),
            );
            const changed = fresh.length !== parked.length ||
              fresh.some((t, i) => t !== parked[i]);
            if (changed) continue;
            // Even unchanged awaiting membership can acquire external work,
            // pending resumptions or queued tails during the probe.
            if (
              store.pendingHostCalls.size > 0 ||
              store.hasPendingResumptions() ||
              store.hasServiceableSettled()
            ) {
              continue;
            }
            if (store.readyCandidates().length === 0) {
              if (idle === "exit") {
                traceDrive("driveAsync", store, done, "EXIT-idle");
                return "idle";
              }
              trapIf(
                true,
                `wasm trap: deadlock detected: event loop cannot make ` +
                  `further progress (${what}: every suspended activation is ` +
                  `waiting on a suspension only this scheduler could resume, ` +
                  `and none is ready)`,
              );
            }
            // A thread became ready: tick it rather than awaiting its dependents.
            continue;
          }
          // Consume the settlement, either through the queue or the race below.
        }
        // The probe awaited: another driver may have consumed the park, or
        // noteAwaiting may have queued its tail. Recheck before selecting one.
        if (store.awaiting.size === 0 || store.hasServiceableSettled()) {
          continue;
        }
        // Race only parks not already owned by the settled queue.
        const queued = new Set(store.settled.map((s) => s.t));
        const parked = ([...store.awaiting] as AwaitWinner["t"][]).filter(
          (t) => !queued.has(t),
        );
        if (parked.length === 0) {
          // Defensive fallback: the checks above imply a non-empty awaiting
          // set and empty settled queue, so filtering cannot remove all parks.
          if (store.pendingHostCalls.size > 0) {
            await Promise.race([
              ...store.pendingHostCalls,
              armDriverArrival(store),
              armHostCallArrival(store),
            ]).catch(() => {});
            continue;
          }
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
        const others: Promise<AwaitWinner | null>[] = parked.slice(1).map(
          tagAwait,
        );
        for (const h of store.pendingHostCalls) {
          others.push(h.then(() => null, () => null));
        }
        // A sole driver may gate ticks speculatively while the engine runs
        // chosen's activation. Driver arrival breaks the race and releases the
        // gate, preventing an unbounded host wait from blocking a second loop.
        // Remove only an identity this loop inserted, never clear the set.
        // Genuine SuspensionPoint resumptions establish their own entries.
        const sole = storeDriverDepth(store) === 1;
        const added = sole && !store.pendingResumptions.has(chosen);
        if (added) store.addPendingResumption(chosen);
        let winner: AwaitWinner | null;
        try {
          // Arrivals trigger stand-down or snapshot refresh without host settlement.
          winner = await Promise.race([
            chosenTag,
            ...others,
            armDriverArrival(store),
            armHostCallArrival(store),
          ]);
        } finally {
          if (added) store.removePendingResumption(chosen);
        }
        // Deliver the actual winner only if its park is still current.
        // Delete queued copies before resumeWith can synchronously re-park;
        // otherwise serviceSettled could deliver this result to the new park.
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
          return "idle";
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
      // Host settlement order is external. Arrivals must also wake this park
      // so fallback drivers can stand down and all drivers refresh snapshots.
      await Promise.race([
        ...store.pendingHostCalls,
        armDriverArrival(store),
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
      // The last async driver hands off any remaining pump work.
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
 * Plain-entry variant of a sync-typed export, used by resource constructors
 * and the embedder's `sync()` adapter (contracts/embedder-api.md §"Functions
 * and async"). It avoids the Promise shape of promising entries but cannot
 * suspend: blocking capability failures raise `NeedsJspi`, and reaching a
 * Suspending import without an eligible stack traps. Pending instance entry
 * hops cause a pre-entry, non-poisoning `SyncEntryBusy` refusal.
 */
export const SYNC_ENTRY: unique symbol = Symbol("polyengine.syncEntry");

// ---------------------------------------------------------------------------
// Pending async-typed lift results
// ---------------------------------------------------------------------------
//
// An idle exit transfers result settlement to the task's onResolve callback.
// If a later driver poisons the instance first and async-end retirement returns,
// this listener rejects pending results. A throwing retirement hook prevents
// this notification; recording the poison cause alone does not settle them.
const pendingLifts = new WeakMap<object, Set<(cause: unknown) => void>>();

function registerPendingLift(inst: object, reject: (c: unknown) => void): void {
  let s = pendingLifts.get(inst);
  if (s === undefined) pendingLifts.set(inst, s = new Set());
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

/** Build a `Store.lift` / `canon_lift` entry with a Task and implicit Thread.
 * Canonical options select sync result lifting, callback dispatch, or stackful
 * execution; the function type separately selects the sync/async idle policy. */
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
   * Let host-initiated destructors complete asynchronously even in plain
   * mode. Skip driveSyncLift, which cannot advance a host JS dtor's Promise;
   * the store driver still applies the sync-typed idle trap.
   */
  allowAsyncCompletion?: boolean;
  /** Nested guest destructor only: preserve the caller and use the reference
   * sync lift drive, not the host's store-wide completion policy. */
  guestDtorCaller?: ComponentInstanceState | null;
  /**
   * Refuse instance entry hops rather than deferring. SYNC_ENTRY uses plain
   * mode inside a JSPI instantiation, so its own mode cannot identify this
   * instance-wide result-memory hazard. Refusal occurs before entry.
   */
  refuseOnEntryHops?: boolean;
  /**
   * Harness-only blocking-call policy: trap idle async-typed exports rather
   * than leaving their Promise pending. Default false; see `IdlePolicy`.
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
  const guestDtor = input.guestDtorCaller !== undefined;
  // Pair JSPI entries with suspension-capable imports; guest dtors use plain mode.
  const enteredCore = enterWasm(core, mode);
  // See the comment at the `drive` call in `invokeNow` and `IdlePolicy`.
  const idlePolicy: IdlePolicy = ft.async === true && input.trapOnIdle !== true
    ? "exit"
    : "trap";
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
    if (!guestDtor && trapState !== undefined) trapState.pending = undefined;
    // Depth of the sync-call scope stack on entry; see the `finally` below.
    const syncCallDepth = syncCallStack?.length ?? 0;

    // Poison refusal is separate from task admission; preserve the guest
    // destructor's caller for same-instance semantics.
    {
      const refusal = entryRefusal(
        inst,
        input.guestDtorCaller ?? null,
        `cannot enter component instance ${inst.index}`,
      );
      if (refusal !== null) trap(refusal);
    }
    let completed = false;

    let resolved: ComponentValue[] | null = null;
    let resolvedSeen = false;
    /**
     * Idle-path result waiter. onResolve, not thread drain, supplies the answer.
     */
    let onResolvedHook: (() => void) | null = null;
    const task = new Task(
      ft,
      taskOpts,
      inst,
      () => hostArgs,
      (result) => {
        resolved = result;
        resolvedSeen = true;
        stats.tasksResolved++;
        if (onResolvedHook !== null) {
          const f = onResolvedHook;
          onResolvedHook = null;
          f();
        }
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
      // Failed adapters may skip exit-sync-call; release this task's lenders
      // so unaffected instances do not retain abandoned borrows.
      if (completed) return;
      for (const t of task.threads as { syncCallStack: unknown[] }[]) {
        while (t.syncCallStack.length > 0) {
          (t.syncCallStack.pop() as LenderScope).releaseLenders();
        }
      }
      void syncCallStack;
      void syncCallDepth;
      // Host-boundary unwind restores sibling mayLeave flags skipped by FACT.
      // A guest destructor is nested inside a live caller, so it must not
      // restore store-wide flags. The entered instance is excluded in either case.
      for (const i of guestDtor ? [] : allInstances?.() ?? []) {
        if (i as unknown as ComponentInstanceState !== inst) {
          i.mayLeave = true;
        }
      }
    };

    /**
     * Record this instance's failure and retire its async ends/pending lifts.
     * Per-instance poisoning is a runtime policy beyond definitions.py;
     * sibling instances remain usable.
     */
    const poison = (e: unknown): void => {
      notifyInstancePoisoned(
        inst as unknown as { handles: Iterable<unknown> },
        e,
      );
    };

    /**
     * Capability failures unwind adapter bookkeeping without poisoning.
     * They do not synthesize operation completion, task resolution or cancellation.
     */
    const isCapabilitySignal = (e: unknown): boolean =>
      e instanceof NeedsJspi || e instanceof PendingCapability;

    try {
      thread.resume();
      // The reference sync loop drives callee-instance threads. JSPI and
      // asynchronous host dtors need the store driver instead so Promise
      // continuations can run before the idle verdict.
      if (!ft.async && mode !== "jspi" && !input.allowAsyncCompletion) {
        driveSyncLift(task);
      }
      // The dropping activation is still on the stack. In particular, its
      // own JSPI hop must not turn this completed sync call into a Promise.
      if (guestDtor) return finishHostEntry();
    } catch (e) {
      unwind();
      if (!isCapabilitySignal(e)) poison(e);
      throw e;
    }

    /**
     * After an idle exit, settle from onResolve, not the last thread's exit
     * (#315 result-settlement rule; definitions.py `Task.return_`). Background
     * producers may retain threads indefinitely. Already-captured results
     * settle immediately; otherwise register resolution and poison waiters.
     *
     * This callback only shapes lifted values. It does not stop whichever
     * driver now owns the task, nor unwind another driver's active FACT scopes.
     */
    const backgroundCompletion = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        // An idle verdict can follow resolution while a driver-liveness
        // clause remains false. Do not wait for an event that already fired.
        if (resolvedSeen) {
          try {
            resolve(finishHostEntry());
          } catch (e) {
            reject(e);
          }
          return;
        }
        // Poison notification may have run after the driver returned idle but
        // before this continuation installed its listener. Preserve an
        // already-captured task result above; otherwise poisoning first must
        // reject the pending async export with the recorded cause.
        // CONTRACT: contracts/embedder-api.md:180-185; per-instance poisoning
        // is the runtime policy in docs/architecture.md:300-307.
        if (isInstancePoisoned(inst)) {
          reject(instancePoisonCause(inst));
          return;
        }
        const onPoison = (cause: unknown): void => {
          onResolvedHook = null;
          reject(cause);
        };
        registerPendingLift(inst, onPoison);
        onResolvedHook = () => {
          unregisterPendingLift(inst, onPoison);
          try {
            // Safe synchronously inside the resolve callback: pure over
            // already-lifted `ComponentValue`s (`canon_task_return` lifted
            // them into `resolved`; `resultsToHost` reshapes). Host `.then`
            // handlers run on a microtask regardless.
            resolve(finishHostEntry());
          } catch (e) {
            reject(e);
          }
        };
      });

    let outcome: DriveExit | Promise<DriveExit>;
    try {
      const midWasmCall = () => task.threads.some((t) => store.awaiting.has(t));
      const hopParked = () => entryHopThreads(store).length > 0;
      // Driver completion is not thread exhaustion. CONTRACT: an async result
      // is independent of producer lifetime
      // (embedder-api.md:180-185; definitions.py:521-526,2360-2369). A
      // genuine SuspensionPoint may therefore be handed to the settlement
      // pump once the result exists. Entry hops remain part of result-memory
      // ordering and must complete first. Sync lifts retain full activation
      // liveness. Callback tasks may retain waiting producer threads after
      // task.return; awaiting their final exit would prevent result delivery.
      const driveDone = () =>
        resolvedSeen && !hopParked() && (ft.async || !midWasmCall());
      outcome = drive(
        store,
        driveDone,
        `export '${name}'`,
        idlePolicy,
      );
    } catch (e) {
      unwind();
      throw e;
    }
    /**
     * Use the captured exit verdict, not a fresh shared-store predicate.
     */
    const finish = (verdict: DriveExit): unknown =>
      verdict === "idle" ? backgroundCompletion() : finishHostEntry();
    if (!isPromiseLike(outcome)) {
      try {
        return finish(outcome);
      } catch (e) {
        unwind();
        throw e;
      }
    }
    return outcome.then(finish, (e) => {
      unwind();
      throw e;
    });
  };

  return (...hostArgs: ComponentValue[]): unknown => {
    // Synchronous callers refuse before entry rather than waiting on JSPI hops.
    if (input.refuseOnEntryHops && entryHopThreads(store, inst).length > 0) {
      throw new SyncEntryBusy(name);
    }
    if (hostArgs.length !== ft.params.length) {
      throw new TypeError(
        `${name}: expected ${ft.params.length} argument(s), got ${hostArgs.length}`,
      );
    }
    // Preserve core-return/result-lift ordering across promising-entry hops:
    // a new call must not reuse this instance's return memory before lifting.
    // Genuine SuspensionPoint parks are excluded, allowing host-import reentry
    // (`runtime/tests/jspi/hop_atomicity_test.ts`). This is not a general entry lock.
    if (mode === "jspi" && entryHopThreads(store, inst).length > 0) {
      return awaitHopQuiescence(store, inst).then(() => invokeNow(hostArgs));
    }
    return invokeNow(hostArgs);
  };
}

/**
 * Awaiting threads without a SuspensionPoint owner are crossing entry hops,
 * not genuine scheduler parks. Narrow by instance for result-memory safety;
 * omit `inst` for store-wide driver-completion and hand-off checks.
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
 * Await entry hops and service their tails before rechecking. Hops settle on
 * the engine's schedule; genuinely blocked activations are excluded. Multiple
 * gated callers recheck independently, with no FIFO admission guarantee.
 */
async function awaitHopQuiescence(store: Store, inst: unknown): Promise<void> {
  for (;;) {
    const hops = entryHopThreads(store, inst);
    if (hops.length === 0) return;
    await Promise.race(
      hops.map((t) =>
        (t.awaiting ?? Promise.resolve()).then(
          () => undefined,
          () => undefined,
        )
      ),
    );
    store.serviceSettled();
  }
}

// ---------------------------------------------------------------------------
// Resource destructor entries
// ---------------------------------------------------------------------------

/**
 * `canon_resource_drop` uses a sync function taking a u32 rep and no results.
 */
const DTOR_FT: FuncType = {
  params: [{ kind: "u32" }],
  results: [],
  async: false,
};

/**
 * `canon_resource_drop`'s sync options: no memory, realloc, post-return or callback.
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
 * Build the canonical destructor lift with its own Task and implicit Thread
 * (`canon_resource_drop`). Host drops may use promising entry and return a
 * Promise; their store driver owns async completion.
 *
 * A present guestCaller selects a nested, plain sync lift, including when
 * its value is null. Preserve the caller for same-instance poison semantics,
 * reject thenable dtors, and finish without the host's store-wide hop drain.
 * A guest dtor cannot suspend through this JS trampoline frame.
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
  /** Present only for guest drops; null is a guest call without a real caller. */
  guestCaller?: ComponentInstanceState | null;
}): (rep: number) => unknown {
  const guest = input.guestCaller !== undefined;
  const mode = guest ? "plain" : input.suspensionMode ?? "plain";
  const raw: CoreFn = input.dtor ?? (() => undefined);
  // Plain JS dtors may return incidental values; discard them. Preserve host
  // thenables for awaitCore, but reject guest ones. Promising requires the raw
  // wasm callable, whose result arity already matches `(i32) -> ()`.
  const core: CoreFn = mode === "jspi" ? raw : ((rep: number) => {
    const r = raw(rep);
    trapIf(
      guest && isPromiseLike(r),
      "resource destructor did not complete synchronously",
    );
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
    allowAsyncCompletion: !guest,
    guestDtorCaller: input.guestCaller,
  });
  return (rep: number) => lifted(rep);
}

/**
 * Drop a host-held resource rep. Async failures go to the store's host-failure
 * channel (first failure wins); traps are poisoned by the lifted entry.
 * Do not register the dtor completion Promise as external work: it may need
 * this scheduler. Its host imports register their own external dependencies.
 */
export function hostDtorCall(rt: ResourceTypeInfo, rep: number): void {
  const impl = rt.impl;
  // Imported host resources have no implementing component instance to enter.
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
 * Enter wasm under a synchronous ambient bracket. Plain results return
 * directly; promising results park the generator until a driver delivers
 * their value or throws their translated rejection into the body.
 */
export function* awaitCore(
  fn: CoreFn,
  args: CoreValue[],
  // deno-lint-ignore no-explicit-any
  thread: any,
): Generator<BlockRequest, CoreValue[], unknown> {
  // The bridge explicitly maintains ambient claims after this bracket unwinds.
  const raw = withActivation(thread, () => callCore(fn, args));
  // `callCore` normalizes a bare value to a one-element array; a promising
  // entry yields `[Promise]`.
  if (raw.length === 1 && isPromiseLike(raw[0])) {
    const settled = yield {
      readyFunc: null,
      cancellable: false,
      // Map post-resumption RuntimeError just like a synchronous core throw.
      awaitValue: Promise.resolve(raw[0] as unknown as Promise<unknown>).then(
        undefined,
        (e) => {
          throw mapCoreException(e);
        },
      ),
    };
    if (settled === undefined) return [];
    return Array.isArray(settled)
      ? settled as CoreValue[]
      : [settled as CoreValue];
  }
  return raw;
}

/** definitions.py `CallbackCode`. */
enum CallbackCode {
  EXIT = 0,
  YIELD = 1,
  WAIT = 2,
}
const CALLBACK_CODE_MAX = 2;

/** definitions.py `unpack_callback_result`. */
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
 * `canon_lift`'s implicit-thread body, with generator block points for the driver.
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
    // Stackful async execution needs JSPI. Results arrive through task.return,
    // not the core function's return value.
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

  // Callback ABI waits between invocations without JSPI, but callbacks in
  // JSPI mode need the same promising wrapper as the initial core entry.
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
 * Build a `canon_lower` host-import body. Async lowers return a subtask handle
 * for pending host Promises and deliver results through events. A sync lower
 * must wait inside the caller's wasm frame, requiring both JSPI mode and the
 * declaration's `suspending()` marker. Both forms share resolution/lender rules.
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

  // `canon_lower`: async results are written indirectly, not returned in lanes.
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

    // The host supplies cancellation policy (`canon_lower`'s on_cancel).
    // This no-op is final for deferCancel imports and paths without a subtask
    // handle. Pending async calls otherwise install prompt discard below.
    subtask.onCancel = () => {};
    // abortable changes the signature on every call, even when cancellation
    // cannot fire. Unmarked imports do not require AbortController support.
    const controller = abortable ? new AbortController() : null;
    const args = onStart();
    const raw = controller === null
      ? hostFn(...args)
      : hostFn(...args, controller.signal);
    const toResults = (v: unknown): ComponentValue[] =>
      ft.results.length === 0 ? [] : [v as ComponentValue];

    if (raw instanceof DeferredHostResult || isPromiseLike(raw)) {
      const deferred = raw instanceof DeferredHostResult ? raw : null;
      const settlement = deferred?.promise ?? Promise.resolve(raw);
      // Raw HostImports retain their single observing reaction: a boxing hop
      // would let a queued cancellation overtake an already-settled result.
      const fulfilled = (value: unknown): HostSettlement =>
        deferred !== null ? value as HostSettlement : { value };
      const convert = (done: HostSettlement): unknown => {
        if (deferred !== null) return deferred.convert(done);
        if ("error" in done) throw done.error;
        return done.value;
      };
      if (!opts.async) {
        if (mode !== "jspi" || !suspendable) {
          // An unmarked import cannot suspend even in JSPI mode. This
          // non-poisoning capability exit must release onStart's lenders
          // (contracts/intrinsics.md, trap-unwind/lender-release obligation).
          // Observe even refused raw HostImports; no conversion continuation.
          void settlement.catch(() => {});
          deferred?.endScope();
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
        // `canon_lower`'s sync wait is non-cancellable: pending cancellation
        // waits for the caller's next cancellable point. Parking does not
        // release callback exclusivity. Record the host outcome here, but do
        // CABI lowering and lender delivery in produce at scheduler resume.
        let outcome: HostSettlement | undefined;
        const promise = settlement.then(
          (done) => {
            store.pendingHostCalls.delete(promise);
            outcome = fulfilled(done);
          },
          (e) => {
            store.pendingHostCalls.delete(promise);
            outcome = { error: e };
          },
        );
        // Mark this park externally wakeable for drivers and teardown.
        registerHostCall(store, promise);
        // Success delivers lenders in produce. onSettled is the idempotent
        // backstop for produce failure or abandonment, which skips produce.
        return blockCurrentActivation({
          store,
          task: currentTask(),
          readyFunc: () => outcome !== undefined,
          cancellable: false,
          produce: () => {
            // Poisoning records a marker; it need not abandon this suspension.
            // A FACT callee may differ from the still-healthy owning task.
            // Preserve the original cause, including a thrown undefined.
            if (isInstancePoisoned(inst)) throw instancePoisonCause(inst);
            onResolve(toResults(convert(outcome!)));
            subtask.deliverResolve();
            assert_(vi.done(), `${name}: unconsumed flat arguments`);
            const flatResults = subtask.flatResults;
            if (flatResults.length === 0) return undefined;
            if (flatResults.length === 1) return flatResults[0];
            return flatResults;
          },
          onSettled: () => {
            deferred?.endScope();
            subtask.unwindLenders();
          },
        });
      }
      // Async lowering runs on host settlement, not in a suspended caller's
      // produce step. Result-lowering failures use the host-failure channel.
      const promise = settlement.then(
        (done) => {
          store.pendingHostCalls.delete(promise);
          // Discard cancelled or poisoned recipients before lowering can
          // write guest memory or re-enter through realloc.
          if (subtask.resolved() || isInstancePoisoned(opts.instance)) return;
          try {
            onResolve(toResults(convert(fulfilled(done))));
          } catch (e) {
            store.hostFailure = e;
          }
        },
        (e) => {
          store.pendingHostCalls.delete(promise);
          // Late rejection of discarded work must not fail an unrelated call.
          if (subtask.resolved() || isInstancePoisoned(opts.instance)) return;
          store.hostFailure = e;
        },
      );
      registerHostCall(store, promise);
      if (!deferCancel) {
        // Prompt-cancel host policy (`canon_lower`'s on_resolve(None)).
        // canon_subtask_cancel sets cancellationRequested before calling us.
        // Deregister external work, resolve cancellation, then let event delivery
        // discharge lenders. The null result path performs no realloc.
        subtask.onCancel = () => {
          store.pendingHostCalls.delete(promise);
          deferred?.endScope();
          onResolve(null);
          if (controller !== null) {
            // Defer host abort listeners until after the guest built-in returns.
            // Cancellation is already resolved, so abort-induced settlements
            // hit the discard guards. Promise reactions also work in bare shells
            // without queueMicrotask. deferCancel imports never reach this arm.
            Promise.resolve().then(() => controller.abort());
          }
        };
      }
    } else {
      onResolve(toResults(raw));
    }

    // `canon_lower`: a sync-typed callee must have resolved.
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

    // Async lower: eager resolution needs no handle or event.
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
 * `canon_lift` callback loop shared by host lifts and FACT calls.
 * Start with the initial activation's packed code, dispatching events until EXIT.
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
    // Each invocation holds exclusivity through mid-frame suspension, even
    // after task.return. Only the between-invocation wait releases it.
    assert_(
      task.needsExclusive() &&
        inst.exclusiveThread === task.implicitThread,
      "callback loop without holding the exclusive thread",
    );
    // Admit other needs-exclusive tasks between invocations. Event delivery
    // and cancellation wait for the slot to be free before reclaiming it.
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
