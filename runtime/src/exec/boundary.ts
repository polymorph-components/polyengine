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
import {
  isPreparedTransfer,
  type PreparedTransfer,
  prepareRawValues,
} from "../cabi/values.ts";
import { assert_, AssertionError, Trap } from "../cabi/trap.ts";
import {
  type BlockRequest,
  componentBoundaryTrapCarrier,
  type ComponentInstanceState,
  consumeSchedulerFailure,
  driveSyncLift,
  entryRefusal,
  EventCode,
  type EventTuple,
  guestActivationLive,
  hasHostRetention,
  hasRealHostCall,
  instancePoisonCause,
  isInstancePoisoned,
  NeedsJspi,
  needsJspi,
  notifyInstancePoisoned,
  packSubtaskResult,
  PendingCapability,
  type Store,
  Subtask,
  SubtaskState,
  SyncEntryBusy,
  takeComponentBoundaryTrap,
  Task,
  type TaskOptions,
  Thread,
  WaitableSet,
  withActivation,
  withSynchronousActivation,
} from "../task/mod.ts";
import { currentTask } from "../task/scheduler.ts";
import type {
  HostCall,
  HostCallAdapter,
  HostSettlement,
} from "./host_settlement.ts";
import { finishHostCall, releaseHostCall } from "./host_settlement.ts";
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
  /** Legacy format-6 wire slot, validated false by the loader. */
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
      // definitions.py LiftLowerContext.reallocate creates and invokes a fresh
      // sync canon_lift (lines 642-658), hence fresh task/thread context. Keep
      // post-return on its originating task; only realloc takes this boundary.
      const p = withSynchronousActivation(
        opts.instance,
        () => callCore(realloc, [o, os, a, n]),
      );
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
    const carried = takeComponentBoundaryTrap(e);
    if (carried !== undefined) return mapCoreException(carried.cause);
    try {
      trap(`guest trapped: ${e.message}`);
    } catch (t) {
      return t;
    }
  }
  const Exception = (WebAssembly as unknown as {
    Exception?: abstract new (...args: never[]) => object;
  }).Exception;
  if (Exception !== undefined && e instanceof Exception) {
    try {
      trap("thrown Wasm exception");
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

/** A pre-existing store-global report, distinct from a guest scheduler trap. */
class HostFailureReport {
  constructor(readonly cause: unknown) {}
}

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
  onBackgroundFailure?: (cause: unknown) => boolean,
): DriveExit | Promise<DriveExit> {
  try {
    return driveLoop(store, done, what, idle, onBackgroundFailure);
  } catch (e) {
    // Sibling host calls and activation tails survive this driver's failure.
    requestStoreService(store);
    throw e;
  }
}

/** `drive`'s loop proper; see `drive` for the exception-exit hand-off. */
function driveLoop(
  store: Store,
  done: () => boolean,
  what: string,
  idle: IdlePolicy,
  onBackgroundFailure?: (cause: unknown) => boolean,
): DriveExit | Promise<DriveExit> {
  traceDrive("drive", store, done, "top");
  if (store.hostFailure !== undefined) throw takeHostFailure(store);
  if (done()) {
    traceDrive("drive", store, done, "EXIT-done");
    requestStoreService(store);
    return "done";
  }
  const drainState = stateFor(store);
  // Use the same ordinary-service authority as the asynchronous coordinator.
  // Nested entry cannot pass its live-activation gate; top-level synchronous
  // entry may still drain ready work before deciding its deadlock verdict.
  while (store.awaiting.size === 0 && serviceOrdinaryStep(store)) {
    if (store.hostFailure !== undefined) throw takeHostFailure(store);
    if (done()) {
      requestStoreService(store);
      return "done";
    }
    if (chargeWorkQuantum(drainState)) {
      // CONTRACT: This is ordinary async scheduling, not definitions.py's
      // direct driveSyncLift loop. Share the coordinator's quantum and cross a
      // platform-task boundary before continuing so guest YIELD cannot starve
      // timers (scheduler-cycle2.md:9-11).
      const handoff = handoffWorkQuantum(store, drainState);
      return handoff.then(() =>
        drive(store, done, what, idle, onBackgroundFailure)
      );
    }
  }
  traceDrive("drive", store, done, "->store-service");
  return driveAsync(store, done, what, idle, onBackgroundFailure);
}

/**
 * Register real host work. Its own reaction requests service after the host
 * settlement's earlier reaction has committed readiness and removed the call.
 * The coordinator never races or polls the Promise itself.
 */
export function registerHostCall(
  store: Store,
  promise: Promise<unknown>,
): void {
  store.pendingHostCalls.add(promise);
  promise.then(
    () => store.requestService(),
    () => store.requestService(),
  );
}

type DrainWaiter = {
  promise: Promise<DriveExit>;
  done: () => boolean;
  idle: IdlePolicy;
  what: string;
  resolve: (exit: DriveExit) => void;
  reject: (cause: unknown) => void;
  onBackgroundFailure?: (cause: unknown) => boolean;
  idleReported: boolean;
  idleProbeArmed: boolean;
};

type DrainState = {
  scheduled: boolean;
  running: boolean;
  requested: boolean;
  yielding: boolean;
  waiters: Set<DrainWaiter>;
  budget: number;
  hopProbe: { hops: Set<unknown>; elapsed: boolean } | null;
  syncHopProbe: { hops: Set<unknown>; elapsed: boolean } | null;
  admissions: Set<Admission>;
};

type Admission = {
  inst: unknown;
  run(): unknown;
  resolve(value: unknown): void;
  reject(cause: unknown): void;
};

const drainStates = new WeakMap<Store, DrainState>();
const DRAIN_TICK = Promise.resolve();
const WORK_QUANTUM = 8;

function stateFor(store: Store): DrainState {
  let state = drainStates.get(store);
  if (state === undefined) {
    state = {
      scheduled: false,
      running: false,
      requested: false,
      yielding: false,
      waiters: new Set(),
      budget: WORK_QUANTUM,
      hopProbe: null,
      syncHopProbe: null,
      admissions: new Set(),
    };
    drainStates.set(store, state);
    store.serviceRequested = () => requestStoreService(store);
  }
  return state;
}

/** Request the store's single event-driven drain. Requests coalesce, but every
 * settlement/event remains recorded in its owning state object. */
export function requestStoreService(store: Store): void {
  const state = stateFor(store);
  state.requested = true;
  if (state.running || state.scheduled || state.yielding) return;
  state.scheduled = true;
  DRAIN_TICK.then(() => runStoreDrain(store, state));
}

/** @internal Test-only visibility into call/service lifecycle ownership. */
export function drainWaiterCountForTesting(store: Store): number {
  return drainStates.get(store)?.waiters.size ?? 0;
}

function ordinaryServiceAllowed(store: Store): boolean {
  return !guestActivationLive(store) && !store.hasPendingResumptions() &&
    unsettledEntryHops(store).length === 0;
}

function hasRunnable(store: Store): boolean {
  return ordinaryServiceAllowed(store) &&
    (store.hasServiceableSettled() || store.readyCandidates().length > 0);
}

/** The sole authority for ordinary store-wide progress. Direct canonical
 * switches and driveSyncLift remain separate. */
function serviceOrdinaryStep(store: Store): boolean {
  if (!ordinaryServiceAllowed(store)) return false;
  if (store.hasServiceableSettled()) return store.serviceSettledStep();
  if (hasEntryHop(store)) return false;
  return store.tick();
}

/** Admission helpers may finish one queued tail, but may neither tick a ready
 * sibling nor cross a live/pending/unsettled activation boundary. */
function serviceAdmissionTailStep(store: Store): boolean {
  if (!ordinaryServiceAllowed(store)) return false;
  return store.serviceSettledStep();
}

/** Offer deferred host entries between complete canonical steps. This runs
 * only under the coordinator's no-live-guest guard, never from mutation sites. */
function serviceAdmissionStep(store: Store, state: DrainState): boolean {
  for (const admission of state.admissions) {
    if (entryHopThreads(store, admission.inst).length > 0) continue;
    state.admissions.delete(admission);
    try {
      admission.resolve(admission.run());
    } catch (e) {
      admission.reject(e);
    }
    return true;
  }
  return false;
}

type RequiredSyncVerdict = "none" | "progress" | "wait";

/** Apply definitions.py's synchronous `canon_lift` loop to a logical FACT
 * child that reached a real CM park. This precedes store-global idle/retention
 * policy: only the callee instance's work can justify the synchronous wait. */
function serviceRequiredSyncStep(
  store: Store,
  state: DrainState,
): RequiredSyncVerdict {
  while (store.requiredSyncParks.length > 0) {
    const point = store.requiredSyncParks[0];
    if (!point.waiting()) {
      store.finishSyncProgress(point);
      continue;
    }
    const owner = point.owner;
    const task = point.logicalOwner.task;
    const root = task?.failureOwner;
    if (
      root?.inst?.activeCalls instanceof Set &&
      !root.inst.activeCalls.has(root)
    ) {
      // The host-visible result was published before this background park.
      store.finishSyncProgress(point);
      continue;
    }
    const inst = point.syncInstance as typeof task.inst;
    if (store.serviceSettledStepFor(inst)) {
      state.syncHopProbe = null;
      return "progress";
    }
    if (point.task?.hasPendingCancel?.() === true && point.ready()) {
      if (store.tickForInstance(inst)) {
        state.syncHopProbe = null;
        return "progress";
      }
    }
    const hops = entryHopThreads(store, inst);
    if (hops.length > 0 || store.pendingResumptions.has(owner)) return "wait";
    if (store.tickForInstance(inst)) {
      state.syncHopProbe = null;
      return "progress";
    }
    store.finishSyncProgress(point);
    const failure = componentBoundaryTrapCarrier(
      new Trap("wasm trap: cannot block a synchronous task before returning"),
      owner,
    );
    point.abandon(failure);
    state.syncHopProbe = null;
    return "progress";
  }
  state.syncHopProbe = null;
  return "none";
}

function chargeWorkQuantum(state: DrainState): boolean {
  return --state.budget <= 0;
}

function handoffWorkQuantum(
  store: Store,
  state: DrainState,
): Promise<void> {
  state.yielding = true;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      state.budget = WORK_QUANTUM;
      state.yielding = false;
      resolve();
      requestStoreService(store);
    }, 0);
  });
}

/** Awaiting engine entries that have not reached a genuine SuspensionPoint.
 * Their Wasm continuation is a mandatory part of the current canonical
 * transfer and must run before ordinary Store.tick scheduling. */
function hasEntryHop(store: Store): boolean {
  return entryHopThreads(store).length > 0;
}

/** An engine-only hop whose activation has not yet produced its own settled
 * tail. Autonomous service must not dispatch another tail across this window:
 * the engine continuation may still register a genuine SuspensionPoint park.
 * A queued settlement is excluded so its own tail can close the hop rather
 * than deadlocking behind itself. */
function unsettledEntryHops(store: Store): unknown[] {
  if (store.awaiting.size === 0) return [];
  const queued = new Set(store.settled.map((s) => s.t));
  return entryHopThreads(store).filter((t) => !queued.has(t));
}

function sameIdentities(a: Set<unknown>, b: readonly unknown[]): boolean {
  return a.size === b.length && b.every((value) => a.has(value));
}

function removeDrainWaiter(store: Store, promise: Promise<unknown>): void {
  const state = drainStates.get(store);
  if (state === undefined) return;
  for (const waiter of state.waiters) {
    if (waiter.promise === promise) {
      state.waiters.delete(waiter);
      // The caller-owned terminal channel has already settled. Resolve this
      // now-obsolete service observation so its `.then` closure is not left on
      // an unreachable pending Promise; publishIfEligible is terminal-guarded.
      waiter.resolve("done");
      return;
    }
  }
}

function rejectOneWaiter(state: DrainState, cause: unknown): boolean {
  for (const waiter of state.waiters) {
    if (
      waiter.onBackgroundFailure !== undefined &&
      !waiter.onBackgroundFailure(cause)
    ) {
      continue;
    }
    state.waiters.delete(waiter);
    if (waiter.onBackgroundFailure === undefined) waiter.reject(cause);
    return true;
  }
  return false;
}

function settleWaiters(store: Store, state: DrainState): void {
  for (const waiter of [...state.waiters]) {
    if (waiter.done()) {
      state.waiters.delete(waiter);
      waiter.resolve("done");
      continue;
    }
    if (
      hasRunnable(store) || store.hasPendingResumptions() ||
      hasEntryHop(store) || hasRealHostCall(store) || hasHostRetention(store)
    ) {
      continue;
    }
    if (waiter.idle === "exit") {
      // Resolving the driver's idle verdict must not discard the call's
      // failure route. An async call remains active after going idle, and a
      // later producer failure still belongs to that unresolved call.
      if (!waiter.idleReported) {
        waiter.idleReported = true;
        waiter.resolve("idle");
      }
      continue;
    }
    if (!waiter.idleProbeArmed) {
      waiter.idleProbeArmed = true;
      setTimeout(() => requestStoreService(store), 0);
      continue;
    }
    state.waiters.delete(waiter);
    try {
      trapIf(
        true,
        `wasm trap: deadlock detected: event loop cannot make further ` +
          `progress (${waiter.what}: no runnable work or host call is outstanding)`,
      );
    } catch (e) {
      waiter.reject(e);
    }
  }
}

/** Apply idle policy after an unsettled implementation hop has had its one
 * event-loop opportunity to become a real park or queue its own settlement. */
function settleUnprogressableHop(state: DrainState): void {
  for (const waiter of [...state.waiters]) {
    if (waiter.done()) {
      state.waiters.delete(waiter);
      waiter.resolve("done");
    } else if (waiter.idle === "exit") {
      if (!waiter.idleReported) {
        waiter.idleReported = true;
        waiter.resolve("idle");
      }
    } else {
      state.waiters.delete(waiter);
      waiter.reject(
        new Trap(
          `wasm trap: deadlock detected: event loop cannot make further ` +
            `progress (${waiter.what}: no runnable work or host call is outstanding)`,
        ),
      );
    }
  }
}

async function runStoreDrain(store: Store, state: DrainState): Promise<void> {
  if (state.running) return;
  state.scheduled = false;
  // A synchronous prefix may have exhausted the shared budget after this
  // drain's microtask was queued. Its platform-task handoff owns rescheduling.
  if (state.yielding) return;
  state.running = true;
  try {
    for (;;) {
      state.requested = false;
      // A request made from consumePendingIfRunning is queued before the guest
      // frame unwinds. Never turn that notification into reentrant scheduling.
      if (guestActivationLive(store)) {
        state.requested = true;
        return;
      }
      if (store.hostFailure !== undefined) {
        const cause = store.hostFailure;
        if (rejectOneWaiter(state, cause)) {
          store.hostFailure = undefined;
          continue;
        } else return;
      }
      try {
        store.refreshSyncRequirements();
        if (serviceAdmissionStep(store, state)) continue;
        const syncVerdict = serviceRequiredSyncStep(store, state);
        if (syncVerdict === "progress") continue;
        if (syncVerdict === "wait") {
          const point = store.requiredSyncParks[0];
          const hops = point === undefined ? [] : entryHopThreads(
            store,
            point.syncInstance as typeof point.logicalOwner.task.inst,
          );
          const blockers = point !== undefined &&
              store.pendingResumptions.has(point.owner)
            ? [...hops, point.owner]
            : hops;
          if (
            state.syncHopProbe === null ||
            !sameIdentities(state.syncHopProbe.hops, blockers)
          ) {
            const probe = { hops: new Set(blockers), elapsed: false };
            state.syncHopProbe = probe;
            setTimeout(() => {
              if (state.syncHopProbe === probe) {
                probe.elapsed = true;
                requestStoreService(store);
              }
            }, 0);
            return;
          }
          if (!state.syncHopProbe.elapsed) return;
          // An engine-only hop gets one platform turn to become a real park or
          // settlement. It is not itself permission for a sync callee to wait.
          state.syncHopProbe = null;
          if (blockers.length > 0 && point !== undefined) {
            store.finishSyncProgress(point);
            point.abandon(
              componentBoundaryTrapCarrier(
                new Trap(
                  "wasm trap: cannot block a synchronous task before returning",
                ),
                point.owner,
              ),
            );
            continue;
          }
          return;
        }
        const unsettledHops = unsettledEntryHops(store);
        if (unsettledHops.length > 0) {
          // Host retention and real host calls both make this a valid wait.
          // Neither is runnable work, so stop until their own notifications.
          if (hasRealHostCall(store) || hasHostRetention(store)) {
            state.hopProbe = null;
            return;
          }
          if (
            state.hopProbe === null ||
            !sameIdentities(state.hopProbe.hops, unsettledHops)
          ) {
            const probe = {
              hops: new Set(unsettledHops),
              elapsed: false,
            };
            state.hopProbe = probe;
            setTimeout(() => {
              if (state.hopProbe === probe) {
                probe.elapsed = true;
                requestStoreService(store);
              }
            }, 0);
            return;
          }
          if (!state.hopProbe.elapsed) {
            return;
          }
          state.hopProbe = null;
          settleUnprogressableHop(state);
          return;
        }
        state.hopProbe = null;
        while (!store.hasPendingResumptions()) {
          if (!serviceOrdinaryStep(store)) break;
          // A settled tail or one scheduler tick is one complete canonical
          // step. Admission gets a turn before another ordinary tick, so a
          // perpetual callback YIELD loop cannot starve a pending sync export.
          store.refreshSyncRequirements();
          if (store.requiredSyncParks.length > 0) break;
          if (serviceAdmissionStep(store, state)) break;
          if (chargeWorkQuantum(state)) {
            await handoffWorkQuantum(store, state);
          }
          if (
            store.awaiting.size > 0 && !store.hasServiceableSettled()
          ) {
            // JSPI continuations and promise settlements queued by this tick
            // precede the next ordinary scheduling choice.
            await Promise.resolve();
          }
        }
      } catch (e) {
        if (consumeSchedulerFailure(store, e)) continue;
        const cause = e instanceof HostFailureReport ? e.cause : e;
        if (!rejectOneWaiter(state, cause)) store.hostFailure ??= cause;
        continue;
      }
      settleWaiters(store, state);
      if (hasRunnable(store)) continue;
      // A real claim is released only when its activation executes, parks, or
      // settles. Those exact transitions request service; do not microtask-poll.
      if (store.hasPendingResumptions()) return;
      // Requests raised while this drain was executing belong to the next
      // microtask. Do not fold them into the current synchronous drain: the
      // notifying canonical mutation must return first.
      return;
    }
  } finally {
    state.running = false;
    if (state.requested) requestStoreService(store);
  }
}

function driveAsync(
  store: Store,
  done: () => boolean,
  what: string,
  idle: IdlePolicy = "trap",
  onBackgroundFailure?: (cause: unknown) => boolean,
  requestService = true,
): Promise<DriveExit> {
  let resolve!: (exit: DriveExit) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<DriveExit>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  stateFor(store).waiters.add({
    promise,
    done,
    idle,
    what,
    resolve,
    reject,
    onBackgroundFailure,
    idleReported: false,
    idleProbeArmed: false,
  });
  if (requestService) requestStoreService(store);
  return promise;
}

export async function driveStoreAsync(
  store: Store,
  done: () => boolean,
  what: string,
): Promise<void> {
  for (;;) {
    try {
      await driveAsync(store, done, what);
      return;
    } catch (e) {
      if (consumeSchedulerFailure(store, e)) continue;
      if (e instanceof HostFailureReport) throw e.cause;
      throw e;
    }
  }
}

function takeHostFailure(store: Store): unknown {
  const e = store.hostFailure;
  store.hostFailure = undefined;
  return new HostFailureReport(e);
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
  /** Guest destructor exceptions must reach FACT's exception barrier, which
   * assigns the canonical UncaughtException trap category. */
  preserveWasmException?: boolean;
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

  const invokeNow = (
    hostInput: ComponentValue[] | PreparedTransfer,
  ): unknown => {
    stats.liftedCalls++;
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
    const prepared: PreparedTransfer | null = isPreparedTransfer(hostInput)
      ? hostInput
      : null;
    const admissionCheckpoint = (): void => {
      const refusal = entryRefusal(
        inst,
        input.guestDtorCaller ?? null,
        `cannot enter component instance ${inst.index}`,
      );
      if (refusal !== null) trap(refusal);
    };
    let hostArgs: ComponentValue[];
    try {
      hostArgs = prepared === null
        ? hostInput as ComponentValue[]
        : prepared.transfer(admissionCheckpoint);
    } catch (e) {
      prepared?.cleanup(e);
      throw e;
    }
    let resolved: ComponentValue[] | null = null;
    let resolvedSeen = false;
    let eligible = false;
    let terminal = false;
    let terminalFailed = false;
    let terminalValue: unknown;
    let terminalCause: unknown;
    let invocationReturned = false;
    let futurePublicationQueued = false;
    let serviceWaiter: Promise<unknown> | null = null;
    let waiter: {
      promise: Promise<unknown>;
      resolve: (value: unknown) => void;
      reject: (cause: unknown) => void;
    } | null = null;

    const detachServiceWaiter = (): void => {
      if (serviceWaiter !== null) {
        removeDrainWaiter(store, serviceWaiter);
        serviceWaiter = null;
      }
    };

    const terminalPromise = (): Promise<unknown> => {
      if (waiter === null) {
        let resolve!: (value: unknown) => void;
        let reject!: (cause: unknown) => void;
        const promise = new Promise<unknown>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        // The origin can fail while a sibling driver is still inside invokeNow,
        // before the facade receives this Promise. Observe internally from
        // creation; the returned promise still rejects for its caller.
        void promise.catch(() => {});
        waiter = { promise, resolve, reject };
        if (terminal) {
          if (terminalFailed) reject(terminalCause);
          else resolve(terminalValue);
        }
      }
      return waiter.promise;
    };

    const publishIfEligible = (): void => {
      if (terminal || !eligible || !resolvedSeen) return;
      if (!invocationReturned && ft.async && ft.results[0]?.kind === "future") {
        return;
      }
      if (
        ft.async && ft.results[0]?.kind === "future" &&
        !futurePublicationQueued
      ) {
        futurePublicationQueued = true;
        Promise.resolve().then(publishIfEligible);
        return;
      }
      // Existing host producer/conversion failures are store-global reports,
      // not task-origin traps. They must remain loud if recorded before this
      // call publishes, but do not poison the instance (#118).
      if (store.hostFailure !== undefined) {
        const report = takeHostFailure(store);
        failCall(
          report instanceof HostFailureReport ? report.cause : report,
        );
        return;
      }
      if (resolved === null) {
        terminalFailed = true;
        terminalCause = new AssertionError(
          `${name}: task resolved as cancelled, but the host never requested cancellation`,
        );
        terminal = true;
        detachServiceWaiter();
        task.detachCall();
        waiter?.reject(terminalCause);
        return;
      }
      terminalValue = resultsToHost(resolved);
      terminal = true;
      detachServiceWaiter();
      task.detachCall();
      // This runs only at a control-return boundary, outside canonical state
      // mutation, so Promise thenable inspection is safe here.
      waiter?.resolve(terminalValue);
    };

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
        prepared,
        admissionCheckpoint,
        preserveWasmException: input.preserveWasmException,
      }),
    );

    const finishHostEntry = (): unknown => {
      trapIf(
        !terminal,
        `${name}: task finished without resolving (deadlock)`,
      );
      if (terminalFailed) throw terminalCause;
      return terminalValue;
    };

    const unwind = (...primary: [] | [unknown]): void => {
      // Failed adapters may skip exit-sync-call; release this task's lenders
      // so unaffected instances do not retain abandoned borrows.
      let cleanupFailure: unknown;
      let cleanupFailed = false;
      try {
        if (primary.length === 0) prepared?.cleanup();
        else prepared?.cleanup(primary[0]);
      } catch (e) {
        cleanupFailed = true;
        cleanupFailure = e;
      }
      for (const t of task.threads as { syncCallStack: unknown[] }[]) {
        while (t.syncCallStack.length > 0) {
          try {
            (t.syncCallStack.pop() as LenderScope).releaseLenders();
          } catch (e) {
            if (!cleanupFailed) {
              cleanupFailed = true;
              cleanupFailure = e;
            }
          }
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
      if (primary.length === 0 && cleanupFailed) throw cleanupFailure;
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

    const failCall = (e: unknown): boolean => {
      if (terminal) return false;
      terminal = true;
      detachServiceWaiter();
      task.detachCall();
      terminalFailed = true;
      terminalCause = e;
      if (
        task.state === "initial" && thread.waiting()
      ) {
        thread.abandonWaiting();
      }
      try {
        unwind(e);
      } finally {
        waiter?.reject(e);
      }
      return true;
    };
    task.onFailure = (e): boolean => {
      if (terminal) return false;
      if (!isCapabilitySignal(e)) poison(e);
      return failCall(e);
    };
    task.onControlReturn = (owner) => {
      if (owner.task !== task || terminal) return;
      eligible = true;
      publishIfEligible();
    };
    task.attachCall();

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
      if (consumeSchedulerFailure(store, e)) return terminalPromise();
      if (e instanceof HostFailureReport) {
        failCall(e.cause);
        if (ft.async) return terminalPromise();
        throw e.cause;
      }
      task.onFailure(e);
      if (ft.async && task.state === "initial") return terminalPromise();
      throw e;
    }
    const crossedPromiseHop = thread.awaiting !== null;
    invocationReturned = true;
    // A plain core invocation has actually returned to JS here. Only a JSPI
    // promising-entry Promise is an implementation hop whose tail may still
    // contain result lifting/post-return work.
    if (resolvedSeen && mode !== "jspi") eligible = true;
    publishIfEligible();

    let outcome: DriveExit | Promise<DriveExit>;
    for (;;) {
      try {
        // Call-owned terminal state is published by explicit activation return
        // or genuine park. No unrelated store quiescence is a memory barrier.
        const driveDone = () => terminal;
        outcome = drive(
          store,
          driveDone,
          `export '${name}'`,
          idlePolicy,
          (cause) => failCall(cause),
        );
        break;
      } catch (e) {
        if (consumeSchedulerFailure(store, e)) {
          // A synchronous driver can encounter a foreign ready task. Routing
          // that task's failure is one scheduler step, not a reason to change
          // this call's return shape or abandon its remaining work.
          continue;
        }
        if (e instanceof HostFailureReport) {
          failCall(e.cause);
          if (ft.async) return terminalPromise();
          throw e.cause;
        }
        // A store-global host report is checked before the driver's done
        // predicate. If this call already published, the report belongs to the
        // subsequent entry/diagnostic channel, not to this healthy result.
        if (terminal) throw e;
        task.onFailure(e);
        if (ft.async) return terminalPromise();
        throw e;
      }
    }
    /**
     * Use the captured exit verdict, not a fresh shared-store predicate.
     */
    const finish = (verdict: DriveExit): unknown =>
      verdict === "idle" ? terminalPromise() : finishHostEntry();
    if (!isPromiseLike(outcome)) {
      try {
        const value = finish(outcome);
        return crossedPromiseHop ? terminalPromise() : value;
      } catch (e) {
        if (consumeSchedulerFailure(store, e)) return terminalPromise();
        if (e instanceof HostFailureReport) {
          failCall(e.cause);
          if (ft.async) return terminalPromise();
          throw e.cause;
        }
        task.onFailure(e);
        if (ft.async && task.state === "initial") return terminalPromise();
        if (ft.async && terminal) return terminalPromise();
        throw e;
      }
    }
    serviceWaiter = outcome;
    if (terminal) detachServiceWaiter();
    // The driver may remain parked on unrelated host work after this call's
    // result becomes eligible. Observe it for this call's own deadlock/fault,
    // but return the call-owned completion channel instead (#350/#357).
    void outcome.then(
      () => publishIfEligible(),
      (e) => {
        if (consumeSchedulerFailure(store, e)) return;
        if (e instanceof HostFailureReport) {
          if (!terminal) failCall(e.cause);
          else store.hostFailure ??= e.cause;
          return;
        }
        if (terminal) {
          store.hostFailure ??= e;
          return;
        }
        task.onFailure?.(e);
      },
    );
    return terminalPromise();
  };

  return (...rawHostArgs: ComponentValue[]): unknown => {
    const prepared = rawHostArgs.length === 1 &&
        isPreparedTransfer(rawHostArgs[0])
      ? rawHostArgs[0] as unknown as PreparedTransfer
      : null;
    const hostArgs = prepared ?? rawHostArgs;
    // A completed JSPI hop may have queued its canonical tail without an
    // active driver. Finish that tail before classifying the window as busy;
    // never bypass an unsettled hop, which would expose result memory.
    if (input.refuseOnEntryHops && store.hasServiceableSettled()) {
      try {
        while (serviceAdmissionTailStep(store)) {
          // Recheck permission after every guest tail.
        }
      } catch (e) {
        if (!consumeSchedulerFailure(store, e)) {
          prepared?.cleanup(e);
          throw e;
        }
      }
    }
    // Synchronous callers refuse before entry rather than waiting on JSPI hops.
    if (
      input.refuseOnEntryHops && entryHopThreads(store, inst).some((t) => {
        const task = (t as {
          task?: { onFailure?: unknown; inst?: { activeCalls?: Set<unknown> } };
        }).task;
        return task?.onFailure === null || task?.onFailure === undefined ||
          task.inst?.activeCalls?.has(task) !== false;
      })
    ) {
      const refusal = new SyncEntryBusy(name);
      // Prepared arguments may already own resources. This is a pre-entry
      // refusal, so retire that custody without allowing cleanup failure to
      // replace the capability signal.
      prepared?.cleanup(refusal);
      throw refusal;
    }
    if (prepared === null && rawHostArgs.length !== ft.params.length) {
      throw new TypeError(
        `${name}: expected ${ft.params.length} argument(s), got ${rawHostArgs.length}`,
      );
    }
    // Preserve core-return/result-lift ordering across promising-entry hops:
    // a new call must not reuse this instance's return memory before lifting.
    // Genuine SuspensionPoint parks are excluded, allowing host-import reentry
    // (`runtime/tests/jspi/hop_atomicity_test.ts`). This is not a general entry lock.
    if (mode === "jspi" && entryHopThreads(store, inst).length > 0) {
      let resolve!: (value: unknown) => void;
      let reject!: (cause: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const admission: Admission = {
        inst,
        run: () => invokeNow(hostArgs),
        resolve,
        reject: (e) => {
          prepared?.cleanup(e);
          reject(e);
        },
      };
      stateFor(store).admissions.add(admission);
      requestStoreService(store);
      return promise;
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
    const point = w as { owner?: unknown; boundaryReturned?: boolean };
    if (
      point.owner !== undefined && point.owner !== null &&
      point.boundaryReturned === true
    ) suspended.add(point.owner);
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
    syncCallStack: input.syncCallStack,
    allInstances: input.allInstances,
    // The host does not wait for a destructor: `drop(): void` is
    // non-blocking, and an unfinished dtor's tail is driven by the store.
    allowAsyncCompletion: !guest,
    guestDtorCaller: input.guestCaller,
    preserveWasmException: guest,
  });
  return (rep: number) => {
    try {
      return lifted(rep);
    } catch (e) {
      const Exception = (WebAssembly as unknown as {
        Exception?: abstract new (...args: never[]) => object;
      }).Exception;
      if (guest && Exception !== undefined && e instanceof Exception) {
        trap("wasm trap: uncaught exception propagated out of component");
      }
      throw e;
    }
  };
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
  mapWasmException = true,
): Generator<BlockRequest, CoreValue[], unknown> {
  // The bridge explicitly maintains ambient claims after this bracket unwinds.
  let raw: CoreValue[];
  try {
    raw = withActivation(thread, () => fn(...args)) as CoreValue[];
    if (raw === undefined) raw = [];
    else if (!Array.isArray(raw)) raw = [raw as unknown as CoreValue];
  } catch (e) {
    const Exception = (WebAssembly as unknown as {
      Exception?: abstract new (...args: never[]) => object;
    }).Exception;
    if (
      !mapWasmException && Exception !== undefined && e instanceof Exception
    ) {
      throw e;
    }
    throw mapCoreException(e);
  }
  // `callCore` normalizes a bare value to a one-element array; a promising
  // entry yields `[Promise]`.
  if (raw.length === 1 && isPromiseLike(raw[0])) {
    const settled = yield {
      readyFunc: null,
      // Map post-resumption RuntimeError just like a synchronous core throw.
      awaitValue: Promise.resolve(raw[0] as unknown as Promise<unknown>).then(
        undefined,
        (e) => {
          const Exception = (WebAssembly as unknown as {
            Exception?: abstract new (...args: never[]) => object;
          }).Exception;
          if (
            !mapWasmException && Exception !== undefined &&
            e instanceof Exception
          ) throw e;
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
  prepared: PreparedTransfer | null;
  admissionCheckpoint: () => void;
  preserveWasmException?: boolean;
}): Generator<BlockRequest, void, unknown> {
  const { name, ft, opts, core, stats, task } = input;
  const thread = input.thread();
  const inst = opts.instance;

  if (!(yield* task.enterImplicitThread(thread))) return;

  const cx = new LiftLowerContext(
    cabiOptions(opts),
    inst,
    task,
    input.prepared?.optionalCustody ?? null,
    input.prepared === null ? null : input.admissionCheckpoint,
  );
  const args = task.start();
  const flatArgs = lowerFlatValues(cx, MAX_FLAT_PARAMS, args, ft.params);
  // Canonical argument lowering is complete and the core callee is about to
  // receive the handles. Later guest failure must not reclaim delivered owns.
  input.prepared?.delivered();

  if (!opts.async) {
    const flatResults = normalizeCoreValues(
      yield* awaitCore(core, flatArgs, thread, !input.preserveWasmException),
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
    yield* awaitCore(core, flatArgs, thread, !input.preserveWasmException);
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
    yield* awaitCore(core, flatArgs, thread, !input.preserveWasmException),
    opts.coreType.results,
    `${name} results`,
  ) as [number];
  yield* runCallbackLoop({ name, task, thread, inst, callback, packed, stats });
  task.exitImplicitThread(thread);
}

// ---------------------------------------------------------------------------
// canon lower
// ---------------------------------------------------------------------------

const HOST_RESULT_DELIVERY_CANCELLED = Symbol(
  "host result delivery cancelled",
);

function prepareLoweredResult(
  call: HostCall,
  settlement: HostSettlement,
  resultTypes: FuncType["results"],
): PreparedTransfer | ComponentValue[] {
  const finished = finishHostCall(call, settlement);
  if (isPreparedTransfer(finished)) return finished;
  if (call.result === "prepared") {
    return finished as ComponentValue[];
  }
  return prepareRawValues(
    resultTypes.length === 0 ? [] : [finished],
    resultTypes,
  );
}

function checkLoweredResultDelivery(
  subtask: Subtask,
  inst: ComponentInstanceState,
): void {
  if (subtask.resolved()) throw HOST_RESULT_DELIVERY_CANCELLED;
  if (isInstancePoisoned(inst)) throw instancePoisonCause(inst);
}

/** Callback-free primitive scalar results need no reentry-bearing commit context. */
function commitTransferFreeResult(
  prepared: PreparedTransfer | ComponentValue[],
  subtask: Subtask,
  inst: ComponentInstanceState,
  onResolve: (result: ComponentValue[] | null) => void,
): void {
  checkLoweredResultDelivery(subtask, inst);
  onResolve(Array.isArray(prepared) ? prepared : prepared.values);
  if (!Array.isArray(prepared)) prepared.delivered();
}

function commitLoweredResult(
  prepared: PreparedTransfer,
  subtask: Subtask,
  inst: ComponentInstanceState,
  cx: LiftLowerContext,
  onResolve: (result: ComponentValue[] | null) => void,
): void {
  const checkpoint = () => checkLoweredResultDelivery(subtask, inst);
  checkpoint();
  try {
    const values = prepared.transfer(checkpoint, false);
    if (prepared.optionalCustody !== null) {
      checkpoint();
      // All facade acquisitions are complete. Start natural producers now,
      // before the callback-free CABI insertion/final RETURNED transition.
      prepared.start(checkpoint);
    }
    cx.preparedCustody = prepared.optionalCustody;
    cx.checkpoint = checkpoint;
    onResolve(values);
    // onResolve completed table insertion and the final state change without
    // another host callback. The canonical receiver owns custody.
    prepared.delivered();
  } catch (e) {
    prepared.cleanup(e);
    throw e;
  } finally {
    cx.preparedCustody = null;
    cx.checkpoint = null;
  }
}

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
  hostFn: HostCallAdapter;
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
      // All effectful preparation, transfer hooks and reallocs are behind us.
      // This final eligibility check is immediately before the callback-free
      // RETURNED transition; an accepted cancellation cannot be overwritten.
      cx.checkpoint?.();
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
    const call: HostCall = controller === null
      ? hostFn(...args)
      : hostFn(...args, controller.signal);
    if (call.kind === "pending") {
      if (!opts.async) {
        if (mode !== "jspi" || !suspendable) {
          // An unmarked import cannot suspend even in JSPI mode. This
          // non-poisoning capability exit must release onStart's lenders
          // (contracts/intrinsics.md, trap-unwind/lender-release obligation).
          // Observe even refused raw HostImports; no conversion continuation.
          void call.observe(() => {});
          call.discard();
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
        // Assigned after observe() returns; setup failures settle asynchronously.
        // deno-lint-ignore prefer-const
        let registered: Promise<void> | undefined;
        const promise = call.observe((done) => {
          if (registered !== undefined) {
            store.pendingHostCalls.delete(registered);
          }
          outcome = done;
          store.requestService();
        });
        registered = promise;
        // Mark this park externally wakeable for drivers and teardown.
        registerHostCall(store, promise);
        // Success delivers lenders in produce. onSettled is the idempotent
        // backstop for produce failure or abandonment, which skips produce.
        return blockCurrentActivation({
          store,
          task: currentTask(),
          readyFunc: () => outcome !== undefined,
          blockReason: "host-import",
          produce: () => {
            // Poisoning records a marker; it need not abandon this suspension.
            // A FACT callee may differ from the still-healthy owning task.
            // Preserve the original cause, including a thrown undefined.
            if (isInstancePoisoned(inst)) throw instancePoisonCause(inst);
            const prepared = prepareLoweredResult(call, outcome!, ft.results);
            if (Array.isArray(prepared)) {
              commitTransferFreeResult(prepared, subtask, inst, onResolve);
            } else {
              commitLoweredResult(prepared, subtask, inst, cx, onResolve);
            }
            subtask.deliverResolve();
            assert_(vi.done(), `${name}: unconsumed flat arguments`);
            const flatResults = subtask.flatResults;
            if (flatResults.length === 0) return undefined;
            if (flatResults.length === 1) return flatResults[0];
            return flatResults;
          },
          onSettled: () => {
            call.discard();
            subtask.unwindLenders();
          },
        });
      }
      // Async lowering runs on host settlement, not in a suspended caller's
      // produce step. Result-lowering failures use the host-failure channel.
      // Assigned after observe() returns; setup failures settle asynchronously.
      // deno-lint-ignore prefer-const
      let registered: Promise<void> | undefined;
      const promise = call.observe((done) => {
        if (registered !== undefined) store.pendingHostCalls.delete(registered);
        // Discard cancelled or poisoned recipients before facade conversion
        // can inspect host data or CABI lowering can enter realloc.
        if (subtask.resolved() || isInstancePoisoned(opts.instance)) return;
        try {
          const prepared = prepareLoweredResult(call, done, ft.results);
          // commitLoweredResult's first check follows structural preparation,
          // so a getter may accept cancellation but cannot trigger later effects.
          if (Array.isArray(prepared)) {
            commitTransferFreeResult(prepared, subtask, inst, onResolve);
          } else {
            commitLoweredResult(prepared, subtask, inst, cx, onResolve);
          }
        } catch (e) {
          if (
            e !== HOST_RESULT_DELIVERY_CANCELLED &&
            !isInstancePoisoned(opts.instance)
          ) {
            store.hostFailure = e;
          }
        } finally {
          store.requestService();
        }
      });
      registered = promise;
      if (!subtask.resolved()) registerHostCall(store, promise);
      if (!deferCancel) {
        // Prompt-cancel host policy (`canon_lower`'s on_resolve(None)).
        // canon_subtask_cancel sets cancellationRequested before calling us.
        // Deregister external work, resolve cancellation, then let event delivery
        // discharge lenders. The null result path performs no realloc.
        subtask.onCancel = () => {
          store.pendingHostCalls.delete(promise);
          call.discard();
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
      // Immediate completion is still subject to the same pre-preparation
      // eligibility rule as an observed pending completion.
      try {
        checkLoweredResultDelivery(subtask, inst);
      } catch (e) {
        // No result preparation is permitted for an ineligible recipient, but
        // the adapter's reusable immediate carrier must not retain this call.
        releaseHostCall(call);
        throw e;
      }
      const prepared = prepareLoweredResult(call, call.settlement, ft.results);
      if (Array.isArray(prepared)) {
        commitTransferFreeResult(prepared, subtask, inst, onResolve);
      } else {
        commitLoweredResult(prepared, subtask, inst, cx, onResolve);
      }
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
}): Generator<BlockRequest, void, unknown> {
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
    if (task.deliverPendingCancel()) {
      stats.callbackInvocations++;
      const [next] = normalizeCoreValues(
        yield* awaitCore(
          callback,
          [EventCode.TASK_CANCELLED, 0, 0],
          thread,
        ),
        ["i32"],
        `${name} callback result`,
      ) as [number];
      [code, si] = unpackCallbackResult(next);
      continue;
    }
    // Admit other needs-exclusive tasks between invocations. Event delivery
    // and cancellation wait for the slot to be free before reclaiming it.
    inst.exclusiveThread = null;
    let event: EventTuple;
    switch (code) {
      case CallbackCode.YIELD: {
        yield* thread.waitUntil(() => inst.exclusiveThread === null);
        event = task.deliverPendingCancel()
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
        event = yield* (wset as WaitableSet).waitForCallbackEvent(
          thread,
          task,
          () => inst.exclusiveThread === null,
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
