// Scheduler and canonical built-in ambient (docs/architecture.md §6).
//
// The default chooses ready threads in waiting-list order and events in join
// order. These are deterministic choices within definitions.py `Store.tick`
// and `WaitableSet.get_pending_event`'s allowed nondeterminism, not ordering by
// the instant a readiness predicate became true. POLYENGINE_SCHED_SEED selects
// reproducible pseudo-random candidates; `Thread.waitUntil` always takes the
// reference's deterministic-profile blocking path.
//
// Generator bodies handle waits between wasm calls. Mid-wasm blocking requires
// JSPI; the bridge presents suspended frames to the same scheduler.

import { assert_, trapIf } from "../cabi/trap.ts";
import type { ComponentInstanceLike } from "../cabi/context.ts";

/** definitions.py `Cancelled`. */
export const CANCELLED_FALSE = false;
export const CANCELLED_TRUE = true;
export type Cancelled = boolean;

/**
 * What a thread body yields when it wants to stop running. Mirrors the
 * reference's `Thread.wait_until` (`ready_func` + `cancellable`); `suspend`
 * is `wait_until` with no ready condition (`ready_func === null`), and
 * `yield_` is `wait_until(() => true)`.
 */
export interface BlockRequest {
  /** Resumable once this returns true; `null` = only an explicit resume. */
  readyFunc: (() => boolean) | null;
  cancellable: boolean;
  /** Promise park, separate from scheduler readiness. Settlement resumes the
   * generator with a value or throws the rejection into its unwind path. */
  awaitValue?: Promise<unknown>;
}

/**
 * A thread body: yields block requests, and receives back either the
 * cancelled flag (for a scheduler block point) or the resolved value of an
 * `awaitValue` request.
 */
// deno-lint-ignore no-explicit-any
export type ThreadBody = Generator<BlockRequest, void, any>;

/**
 * Missing wasm-frame suspension capability, not a component `Trap`.
 * Keep capability failures distinct from valid conformance rejections
 * (contracts/plan-format.md's error-phase split).
 */
export class NeedsJspi extends Error {
  constructor(what: string) {
    super(`needs JSPI: ${what}`);
    this.name = "NeedsJspi";
  }
}

export function needsJspi(what: string): never {
  throw new NeedsJspi(what);
}

/**
 * Transient, non-poisoning refusal before synchronous entry would race a
 * pending JSPI result lift. Constructors and `sync()` cannot defer; retry
 * after the hop settles or use the Promise-shaped surface, which waits
 * (contracts/embedder-api.md §"Functions and async").
 */
export class SyncEntryBusy extends Error {
  constructor(what: string) {
    super(
      `sync entry refused: ${what} (the component instance has activity in ` +
        `flight; retry once it settles, or use the Promise-shaped call)`,
    );
    this.name = "SyncEntryBusy";
  }
}

/**
 * Failure raised where a not-yet-implemented capability is required. Same
 * rationale as `NeedsJspi`: never a `Trap`.
 */
export class PendingCapability extends Error {
  constructor(what: string) {
    super(`pending-capability: ${what}`);
    this.name = "PendingCapability";
  }
}

/**
 * Stream/future-end retirement on instance poisoning. Registration avoids a
 * scheduler -> streams -> waitable -> scheduler evaluation-order cycle.
 */
let onInstancePoisoned:
  | ((inst: { handles: Iterable<unknown> }, cause: unknown) => void)
  | null = null;

let onHandleRemovalFailed:
  | ((inst: ComponentInstanceLike, entry: unknown, cause: unknown) => void)
  | null = null;

/** Preserve destructive table removal, retiring an async end only if its
 * validation/drop fails. The hook avoids a handles -> streams import cycle. */
export function removeHandleWithUnwind<T>(
  inst: ComponentInstanceLike,
  i: number,
  use: (entry: unknown) => T,
): T {
  const entry = inst.handles.remove(i);
  try {
    return use(entry);
  } catch (cause) {
    try {
      onHandleRemovalFailed?.(inst, entry, cause);
    } catch {
      // A peer notification must not replace the original failure.
    }
    throw cause;
  }
}

/** @internal — see `onInstancePoisoned`; registered once by task/streams.ts. */
export function setOnInstancePoisoned(
  f: (inst: { handles: Iterable<unknown> }, cause: unknown) => void,
  removalFailed?: (
    inst: ComponentInstanceLike,
    entry: unknown,
    cause: unknown,
  ) => void,
): void {
  onInstancePoisoned = f;
  if (removalFailed !== undefined) onHandleRemovalFailed = removalFailed;
}

/**
 * Additional observers, including pending-lift rejection in exec/boundary.ts.
 * They run after stream/future retirement returns. A throwing retirement hook
 * or listener stops notification; the diagnostic map still retains the first cause.
 */
const instancePoisonedListeners = new Set<
  (inst: { handles: Iterable<unknown> }, cause: unknown) => void
>();

/** @internal — see `instancePoisonedListeners`. */
export function addInstancePoisonedListener(
  f: (inst: { handles: Iterable<unknown> }, cause: unknown) => void,
): void {
  instancePoisonedListeners.add(f);
}

/**
 * @internal — invoke the poisoning hook. For the bracket-break sites that
 * live outside this module (`Thread.resumeWith`, exec/boundary.ts `poison`):
 * one seam, all sites.
 */
export function notifyInstancePoisoned(
  inst: { handles: Iterable<unknown> },
  cause: unknown,
): void {
  // Preserve the original cause across follow-on failures.
  if (!poisonedInstances.has(inst)) poisonedInstances.set(inst, cause);
  onInstancePoisoned?.(inst, cause);
  for (const f of instancePoisonedListeners) f(inst, cause);
}

/** Poison causes shared by late-settle retirement and entry diagnostics. */
const poisonedInstances = new WeakMap<object, unknown>();

export function isInstancePoisoned(inst: object): boolean {
  return poisonedInstances.has(inst);
}

/**
 * Original poison cause. Use `isInstancePoisoned` to distinguish an unmarked
 * instance from one whose cause was a thrown `undefined`.
 */
export function instancePoisonCause(inst: object): unknown {
  return poisonedInstances.get(inst);
}

/**
 * Append the original poison cause, or leave `base` unchanged if unmarked.
 */
export function withPoisonCause(inst: object, base: string): string {
  if (!poisonedInstances.has(inst)) return base;
  const cause = describeCause(poisonedInstances.get(inst));
  return `${base} — instance poisoned by: ${cause}`;
}

/**
 * Return a refusal message for a poisoned callee, otherwise `null`.
 * Live-instance reentry is allowed by definitions.py `Store.lift`; this
 * runtime's per-instance poisoning policy is separate from task exclusivity
 * and JSPI hop serialization. Same-instance calls, including guest self-drop
 * destructors, bypass the poison refusal.
 */
export function entryRefusal(
  callee: object,
  caller: unknown,
  base: string,
): string | null {
  if (caller !== callee && isInstancePoisoned(callee)) {
    return withPoisonCause(callee, base);
  }
  return null;
}

function describeCause(cause: unknown): string {
  try {
    // String(err) renders "Name: message" — for a `Trap`, exactly the
    // original trap line the embedder needs to see.
    return String(cause);
  } catch {
    return "(unprintable poison cause)";
  }
}

// ---------------------------------------------------------------------------
// Deterministic choice
// ---------------------------------------------------------------------------

function readSeed(): number | null {
  let raw: string | undefined;
  try {
    raw = Deno.env.get("POLYENGINE_SCHED_SEED");
  } catch {
    // No env permission: FIFO. Never fail to *run* because we could not read
    // a debugging knob.
    return null;
  }
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n) >>> 0;
}

let seed: number | null = readSeed();
let rngState = 0;

/** Test hook: switch policy at runtime. `null` restores FIFO. */
export function schedulerSeedForTesting(value: number | null): void {
  seed = value === null ? null : value >>> 0;
  rngState = seed ?? 0;
}

/**
 * Test hook: inspect the seed, including whether environment access succeeded.
 */
export function schedulerSeedSnapshotForTesting(): number | null {
  return seed;
}

export function schedulerPolicy(): "fifo" | "seeded-shuffle" {
  return seed === null ? "fifo" : "seeded-shuffle";
}

/** xorshift32 — small, deterministic, and adequate for schedule exploration. */
function nextRandom(): number {
  let x = rngState || 0x9e3779b9;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  rngState = x;
  return x;
}

/**
 * Pick the first supplied candidate, or a seeded pseudo-random candidate.
 */
export function chooseCandidate<T>(candidates: readonly T[]): T {
  assert_(candidates.length > 0, "chooseCandidate on an empty candidate set");
  if (seed === null) return candidates[0];
  return candidates[nextRandom() % candidates.length];
}

// ---------------------------------------------------------------------------
// Current-thread context (definitions.py `current_thread`)
// ---------------------------------------------------------------------------

/**
 * Synchronous execution brackets, innermost last. Nested host-mediated calls
 * require a stack rather than a single current-thread slot.
 */
// deno-lint-ignore no-explicit-any
const threadStack: any[] = [];

// The concrete Thread type lives in ./thread.ts; typing this stack as the
// structural minimum avoids an import cycle (thread.ts needs the scheduler
// for chooseCandidate, the scheduler needs the stack for current_thread).
export interface CurrentThreadLike {
  storage: number[];
  // deno-lint-ignore no-explicit-any
  task: any;
}

export function pushCurrentThread(t: CurrentThreadLike): void {
  threadStack.push(t);
}

export function popCurrentThread(t: CurrentThreadLike): void {
  const top = threadStack.pop();
  assert_(top === t, "current-thread stack imbalance");
}

/**
 * Run `fn` with `t` as ambient for its synchronous extent only. Wasm entries
 * and built-in bodies use this even during engine-driven resumptions, when
 * no scheduler `resume()` bracket remains.
 */
// deno-lint-ignore no-explicit-any
export function withActivation<T>(t: any, fn: () => T): T {
  threadStack.push(t);
  entryStack.push(t);
  try {
    return fn();
  } finally {
    entryStack.pop();
    const top = threadStack.pop();
    assert_(top === t, "withActivation: current-thread stack imbalance");
  }
}

/**
 * `withActivation` brackets only. Consuming a pending resumption requires
 * evidence of activation execution, not merely a scheduler generator step.
 * Ambient resolution uses the broader `threadStack` instead.
 */
// deno-lint-ignore no-explicit-any
const entryStack: any[] = [];

/**
 * Activation execution evidence used only by `consumePendingIfRunning`.
 */
// deno-lint-ignore no-explicit-any
function activationOf(): any {
  return entryStack[entryStack.length - 1] ??
    activationClaims[activationClaims.length - 1] ?? undefined;
}

// ---------------------------------------------------------------------------
// Engine-driven resumptions: the explicit activation-ambient stack
// ---------------------------------------------------------------------------

/**
 * Engine-driven activation claims, innermost last. JSPI resumptions and
 * even plain-value `Suspending` returns can run after synchronous brackets
 * unwind (`tests/jspi/fastpath_hop_test.ts`). The bridge captures the owner
 * before the hop and reclaims it with continuation sentinels.
 *
 * Nested execution moves the running owner to the top. Settling B while A
 * still runs must not shadow A: `SuspensionPoint.resume` claims B immediately
 * only when no ambient exists. Parking releases the claim; `noteAwaiting`
 * releases it on completion or rejection. Driver awaits carry no ambient.
 */
// deno-lint-ignore no-explicit-any
const activationClaims: any[] = [];

/**
 * Move `t` to the top, including on re-claim: a nested callee's release
 * reaction may lag behind the caller's next chunk. Nullish owners do nothing.
 */
// deno-lint-ignore no-explicit-any
export function claimActivationAmbient(t: any): void {
  if (t === null || t === undefined) return;
  if (AMBIENT_TRACE) traceAmbient("claim", t);
  const i = activationClaims.indexOf(t);
  if (i === activationClaims.length - 1 && i !== -1) return; // already top
  if (i !== -1) activationClaims.splice(i, 1);
  activationClaims.push(t);
}

// Optional ambient tracing.
// deno-lint-ignore no-explicit-any
function traceAmbient(what: string, t: any): void {
  // Local diagnostic identities avoid another dependency on context.ts.
  console.error(
    `[amb] ${what} ${dbgId(t)} | stack=[${threadStack.map(dbgId).join(",")}] ` +
      `claims=[${activationClaims.map(dbgId).join(",")}]` +
      `\n${(new Error().stack ?? "").split("\n").slice(2, 6).join("\n")}`,
  );
}
const dbgIds = new WeakMap<object, number>();
let nextDbgId = 1;
export function dbgId(t: unknown): string {
  if (t === null || t === undefined || typeof t !== "object") return String(t);
  let id = dbgIds.get(t);
  if (id === undefined) {
    id = nextDbgId++;
    dbgIds.set(t, id);
  }
  return `T${id}`;
}

/**
 * Release on park or activation settlement, with an implicit-thread fallback
 * for claims recorded through the task rather than this exact thread.
 */
// deno-lint-ignore no-explicit-any
export function releaseActivationAmbient(t: any): void {
  if (t === null || t === undefined) return;
  if (AMBIENT_TRACE) traceAmbient("release", t);
  let i = activationClaims.indexOf(t);
  if (i === -1) {
    const implicit = (t as { task?: { implicitThread?: unknown } })?.task
      ?.implicitThread;
    if (implicit === undefined || implicit === null) return;
    i = activationClaims.indexOf(implicit);
    if (i === -1) return;
  }
  activationClaims.splice(i, 1);
}

// ---------------------------------------------------------------------------
// Ambient diagnostics
// ---------------------------------------------------------------------------

const AMBIENT_TRACE = (() => {
  try {
    return Deno.env.get("CE_AMBIENT_TRACE") === "1";
  } catch {
    return false;
  }
})();

/** Full ambient state for tracing. */
export function ambientDebug(): {
  stack: unknown[];
  claims: unknown[];
} {
  return {
    stack: [...threadStack],
    claims: [...activationClaims],
  };
}

/**
 * Module-scope ambient residue; scheduling gates live on each Store.
 */
export function ambientResidue(): { stack: number; claim: boolean } {
  return {
    stack: threadStack.length,
    claim: activationClaims.length > 0,
  };
}

/**
 * Ambient precedence: innermost synchronous bracket, then newest engine
 * activation claim. `pendingResumptions` is never an ambient source: it
 * names work owed a turn, not necessarily the activation executing now.
 */
function resolveAmbient(): CurrentThreadLike | undefined {
  return threadStack[threadStack.length - 1] ??
    activationClaims[activationClaims.length - 1] ??
    undefined;
}

export function currentThread<T = CurrentThreadLike>(): T {
  if (AMBIENT_TRACE && threadStack.length === 0) {
    console.error(
      `[ambient] bracket empty; claims=${activationClaims.length} ` +
        `head=${activationClaims[0]?.constructor?.name ?? "none"}`,
    );
  }
  const t = resolveAmbient();
  if (t === undefined) {
    // Task-scoped built-ins during core start need an instantiation-time
    // task context this runtime does not implement. Instance-scoped built-ins
    // can instead use their trampoline declaration.
    throw new PendingCapability(
      "instantiation-time task context — a task-scoped canonical built-in " +
        "ran outside any task (a core start function calling task.return / " +
        "task.cancel / thread.yield / subtask.*; see " +
        "test/async/dont-block-start.wast)",
    );
  }
  return t as T;
}

export function maybeCurrentThread(): CurrentThreadLike | undefined {
  return resolveAmbient();
}

/**
 * Resolve using the declaring instance: a matching top synchronous bracket,
 * then the newest matching activation claim, then the unscoped fallback.
 * Engine continuation timing can interleave sibling-instance sentinels;
 * static instance identity removes those candidates
 * (`runtime/tests/context_attribution_test.ts`). It does not distinguish
 * concurrent activations of the same instance; their order still depends on
 * the brackets and claims. In definitions.py `canon_context_get` and
 * `canon_context_set`, identity comes directly from `current_thread`.
 */
export function currentThreadForInstance<T = CurrentThreadLike>(
  inst: unknown,
): T {
  const t = resolveAmbientForInstance(inst);
  if (t !== undefined) return t as T;
  // No candidate of this instance: the unscoped ladder, including its
  // `PendingCapability` for the instantiation-time shape.
  return currentThread<T>();
}

function resolveAmbientForInstance(
  inst: unknown,
): CurrentThreadLike | undefined {
  if (inst === null || inst === undefined) return resolveAmbient();
  const top = threadStack[threadStack.length - 1];
  if (top !== undefined && instOf(top) === inst) return top;
  for (let i = activationClaims.length - 1; i >= 0; i--) {
    const c = activationClaims[i];
    if (instOf(c) === inst) return c;
  }
  return undefined;
}

// deno-lint-ignore no-explicit-any
function instOf(t: any): unknown {
  return t?.task?.inst;
}

/** definitions.py `current_task`. */
// deno-lint-ignore no-explicit-any
export function currentTask(): any {
  return currentThread().task;
}

/**
 * The running task, or `null` outside any task — e.g. a core module's start
 * function during instantiation, which the reference has no model for.
 */
// deno-lint-ignore no-explicit-any
export function maybeCurrentTask(): any | null {
  return maybeCurrentThread()?.task ?? null;
}

/** definitions.py `current_instance`. */
// deno-lint-ignore no-explicit-any
export function currentInstance(): any {
  return currentTask().inst;
}

// ---------------------------------------------------------------------------
// Store (definitions.py `Store`)
// ---------------------------------------------------------------------------

/** Structural view of a Thread, as the store's ready queue needs it. */
export interface SchedulableThread {
  ready(): boolean;
  waiting(): boolean;
  resume(cancelled?: Cancelled): void;
  // deno-lint-ignore no-explicit-any
  task: any;
}

/**
 * Scheduler state shared by the component instances of an Executor.
 * `waiting` preserves insertion order for the default candidate policy.
 */
export class Store {
  readonly waiting: SchedulableThread[] = [];

  /**
   * Host-import promises this store is waiting on. Non-empty means progress
   * is possible but only after a microtask turn — see `drive` in
   * exec/boundary.ts. (definitions.py has no analogue: its host functions run
   * on real threads.)
   */
  readonly pendingHostCalls: Set<Promise<unknown>> = new Set();

  /**
   * Asynchronous host or background-driver failure, parked for a driver to
   * surface. The consuming driver need not belong to the originating call.
   */
  hostFailure: unknown = undefined;

  /**
   * Per-store scheduling gate, not an ambient source. Several resumptions
   * can be outstanding; `tick` waits until all entries are released, without
   * blocking independent stores. An entry ends when its activation runs or
   * parks (`consumePendingIfRunning`), finishes (`noteAwaiting`), or the
   * driver removes its own speculative entry.
   */
  readonly pendingResumptions: Set<unknown> = new Set<unknown>();

  /**
   * Record an activation owed a turn. Idempotent by identity; nullish values
   * do not create entries.
   */
  addPendingResumption(t: unknown): void {
    if (t === null || t === undefined) return;
    if (AMBIENT_TRACE) traceAmbient("pending+", t);
    this.pendingResumptions.add(t);
  }

  /** Is some settled-but-not-yet-run activation of this store pending? */
  hasPendingResumptions(): boolean {
    return this.pendingResumptions.size > 0;
  }

  /** Drop exactly `t` (the driver's own speculative entry). */
  removePendingResumption(t: unknown): void {
    if (AMBIENT_TRACE) traceAmbient("pending-", t);
    this.pendingResumptions.delete(t);
  }

  /**
   * Release only the executing activation's entry, not another activation
   * it may have just resumed. `activationOf` excludes scheduler-only brackets.
   */
  consumePendingIfRunning(): void {
    const a = activationOf();
    if (a !== null && a !== undefined) this.pendingResumptions.delete(a);
  }

  /**
   * Activation settlement ends both ambient and scheduling claims, including
   * claims recorded against the task's implicit thread.
   */
  // deno-lint-ignore no-explicit-any
  releasePendingOf(t: any): void {
    releaseActivationAmbient(t);
    this.pendingResumptions.delete(t);
    const implicit = (t as { task?: { implicitThread?: unknown } })?.task
      ?.implicitThread;
    if (implicit !== undefined && implicit !== null) {
      this.pendingResumptions.delete(implicit);
    }
  }

  startWaiting(t: SchedulableThread): void {
    assert_(!this.waiting.includes(t), "thread already in the waiting list");
    this.waiting.push(t);
  }

  stopWaiting(t: SchedulableThread): void {
    const i = this.waiting.indexOf(t);
    assert_(i !== -1, "thread not in the waiting list");
    this.waiting.splice(i, 1);
  }

  /**
   * Ready, non-poisoned threads in wait order. Drivers use this same filter
   * for deadlock probes so readiness agrees with what `tick` can resume.
   */
  readyCandidates(): SchedulableThread[] {
    return this.waiting.filter((t) =>
      t.ready() && !isInstancePoisoned(t.task?.inst)
    );
  }

  /**
   * Threads parked on a Promise (the jspi `awaitValue` seam). They are not in
   * `waiting` — nothing the scheduler can do makes them ready — so the driving
   * loop tracks them separately and resumes them when their promise settles.
   */
  // deno-lint-ignore no-explicit-any
  readonly awaiting: Set<any> = new Set();

  /**
   * Settled activation tails in settlement order. Result lifting, callback
   * dispatch and implicit-thread exit follow the wasm call; JSPI separates
   * them by microtasks where definitions.py `Thread.resume` keeps them in one
   * step. Record settlement eagerly and service tails before `tick` so later
   * threads do not observe unfinished bookkeeping or unreleased exclusivity.
   */
  readonly settled: {
    // deno-lint-ignore no-explicit-any
    t: any;
    value: unknown;
    failure: { error: unknown } | undefined;
  }[] = [];

  /**
   * Track settlement at park time, including resumptions initiated by guest
   * built-ins rather than a driver. Completion or rejection releases claims.
   */
  // deno-lint-ignore no-explicit-any
  noteAwaiting(t: any, promise: Promise<unknown>): void {
    this.awaiting.add(t);
    promise.then(
      (value) => {
        this.settled.push({ t, value, failure: undefined });
        this.releasePendingOf(t);
      },
      (e) => {
        this.settled.push({ t, value: undefined, failure: { error: e } });
        this.releasePendingOf(t);
      },
    );
  }

  /**
   * Dispatch tails in queue order without an entry-lock test. Every driver
   * must service this queue before and between ticks; exceptions propagate
   * to that driver. Stale entries are discarded, and `resumeWith` retires
   * poisoned-instance tails without running their bodies.
   */
  serviceSettled(): boolean {
    let did = false;
    // Rescan from the head after every dispatch: a dispatched tail runs guest
    // code synchronously, which can change lock/poison state and can re-enter
    // `serviceSettled` (mutating the queue under us).
    scan: for (;;) {
      for (let i = 0; i < this.settled.length; i++) {
        const s = this.settled[i];
        // Another driver already resumed this thread.
        if (!this.awaiting.has(s.t)) {
          this.settled.splice(i, 1);
          continue scan;
        }
        this.settled.splice(i, 1);
        (s.t as {
          resumeWith(v: unknown, f?: { error: unknown }): void;
        }).resumeWith(s.value, s.failure);
        did = true;
        continue scan;
      }
      // A full scan found nothing stale and nothing serviceable.
      return did;
    }
  }

  /**
   * Every queued entry can dispatch or be discarded as stale. A non-empty
   * queue therefore gates `tick` and prevents drivers from parking.
   */
  hasServiceableSettled(): boolean {
    return this.settled.length > 0;
  }

  /**
   * Work to drain before deciding an async callee is still STARTING:
   * queued tails, ready waiters, and awaiting threads crossing an engine
   * hop. A thread owning a SuspensionPoint is genuinely blocked, so only
   * that point's readiness counts. Exclude the caller's task throughout:
   * it cannot be drained while asking this question. This is the runtime's
   * entry-status scheduling policy, not an additional spec entry gate.
   */
  hasRunnableWork(inst: unknown, excludeTask: unknown): boolean {
    // deno-lint-ignore no-explicit-any
    const instOf = (x: any): unknown => x?.task?.inst;
    // deno-lint-ignore no-explicit-any
    const mine = (x: any): boolean =>
      instOf(x) === inst && x?.task !== excludeTask;
    for (const s of this.settled) {
      if (mine(s.t)) return true;
    }
    for (const w of this.waiting) {
      if (mine(w) && w.ready()) return true;
    }
    if (this.awaiting.size === 0) return false;
    const parked = new Set<unknown>();
    for (const w of this.waiting) {
      // deno-lint-ignore no-explicit-any
      const owner = (w as any).owner;
      if (owner !== undefined && owner !== null) parked.add(owner);
    }
    for (const t of this.awaiting) {
      if (mine(t) && !parked.has(t)) return true;
    }
    return false;
  }

  /**
   * Resume one ready thread, following definitions.py `Store.tick` with
   * JSPI ordering and poison filters. False means no step ran, including
   * when a pending resumption or queued tail must be serviced first.
   */
  tick(): boolean {
    // Let this store's settled suspensions reach their engine continuations
    // before scheduling another thread.
    if (this.pendingResumptions.size > 0) return false;
    // Finish queued bookkeeping before observing readiness.
    if (this.hasServiceableSettled()) return false;
    const candidates = this.readyCandidates();
    if (candidates.length === 0) return false;
    const thread = chooseCandidate(candidates);
    const inst = thread.task.inst;
    // Capability failures do not poison; other escaping failures do.
    try {
      thread.resume();
    } catch (e) {
      if (!(e instanceof NeedsJspi) && !(e instanceof PendingCapability)) {
        notifyInstancePoisoned(
          inst as unknown as { handles: Iterable<unknown> },
          e,
        );
      }
      throw e;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Host-call classification (shared by the drivers in exec/)
// ---------------------------------------------------------------------------

/**
 * Activity arms mean the embedder may still act, not that it owes a result.
 * Between-call pumps exclude them from outstanding-work checks. Shared here
 * to avoid a boundary/host_streams import cycle.
 */
const hostActivityArms = new WeakSet<Promise<unknown>>();

/** Mark `p` as an activity arm (exec/host_streams.ts `HostActivity`). */
export function markHostActivityArm(p: Promise<unknown>): void {
  hostActivityArms.add(p);
}

/** Is there host-call work outstanding that is not just an activity arm? */
export function hasRealHostCall(store: Store): boolean {
  for (const p of store.pendingHostCalls) {
    if (!hostActivityArms.has(p)) return true;
  }
  return false;
}

/** Every outstanding host call that is real work (not an activity arm). */
export function realHostCalls(store: Store): Promise<unknown>[] {
  const out: Promise<unknown>[] = [];
  for (const p of store.pendingHostCalls) {
    if (!hostActivityArms.has(p)) out.push(p);
  }
  return out;
}

/**
 * No queued tails, awaiting activations, or real host calls. Activity arms
 * and ready waiting threads do not count; callers must drain ticks first.
 */
export function storeQuiescent(store: Store): boolean {
  return store.settled.length === 0 && store.awaiting.size === 0 &&
    !hasRealHostCall(store);
}

/**
 * definitions.py `canon_lift`'s sync loop: drive ready threads of the callee
 * instance until resolution, trapping if none are ready. Unlike the host
 * driver, this neither drains the whole store nor awaits JSPI microtasks.
 */
export function driveSyncLift(
  task: {
    state: string;
    inst: { threads: Iterable<SchedulableThread> };
  },
): void {
  while (task.state !== "resolved") {
    const candidates = [...task.inst.threads].filter((t) => t.ready());
    trapIf(
      candidates.length === 0,
      "deadlock: synchronous task cannot resolve and no thread is ready",
    );
    chooseCandidate(candidates).resume();
  }
}
