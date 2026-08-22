// The 0.3 task scheduler (docs/architecture.md §6) — the `Store` of definitions.py plus
// the current-thread context that every canonical built-in reads.
//
// ===========================================================================
// SCHEDULING POLICY (orchestrator decision, docs/architecture.md §6)
// ===========================================================================
//
// definitions.py makes two explicitly nondeterministic choices:
//
//   * `Store.tick` (line 597):  `random.choice(list(candidates))` over ready
//     threads;
//   * `WaitableSet.get_pending_event` (line 821): `random.shuffle(self.elems)`
//     before picking a waitable with a pending event;
//   * `Thread.wait_until` (line 396): `if ready_func() and not
//     DETERMINISTIC_PROFILE and random.randint(0,1): return` — an optional
//     "don't block even though you could" fast path.
//
// All three are *allowed* nondeterminism, not required: any single consistent
// choice is a conforming schedule. This scheduler therefore runs a
// **deterministic FIFO ready queue** by default — candidates are resumed in
// the order they became ready, waitable sets deliver events in join order,
// and `wait_until` always blocks (the reference's `DETERMINISTIC_PROFILE`
// branch). Reproducible schedules are worth a great deal when debugging a
// concurrency bug, and FIFO is also the fairest of the cheap policies.
//
// Setting `POLYENGINE_SCHED_SEED=<integer>` switches to a **seeded shuffle**: the same
// choice points become pseudo-random but reproducible from the seed, which is
// how we explore the schedule space that the FIFO default deliberately pins.
// A test that passes under FIFO but fails under some seed has found a real
// order-dependence — in our runtime or in the guest. The seed is read once at
// module load; `schedulerSeedForTesting` exists so tests can drive both modes
// without a subprocess.
//
// ===========================================================================
// THREADS WITHOUT STACK SWITCHING
// ===========================================================================
//
// definitions.py implements `Thread` on real OS threads with lock handoff
// (`cont_new`/`resume`/`block`, lines 270-305) purely to get one-shot
// continuations. We get the same structure from **JS generators**: a thread
// body is a generator function that `yield`s a block request and is resumed
// by `next(cancelled)`. That is a faithful model precisely because the
// stackless (callback-ABI) path never blocks *inside* a wasm frame — every
// wasm call returns a callback code before the host decides to wait. Blocking
// inside a wasm frame (stackful async lifts; a sync lower on an unresolved
// subtask) genuinely requires JSPI and is M2 phase 3; those sites fail loudly
// rather than pretending (see `needsJspi`).

import { assert_, trapIf } from "../cabi/trap.ts";

/** definitions.py `Cancelled` (line 248). */
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
  /**
   * JSPI seam. When present the thread is not waiting on a scheduler
   * condition at all — it is waiting for a **Promise**, namely the one a
   * `promising`-wrapped wasm entry returned. The driving loop awaits it and
   * resumes the body with the resolved value (or throws the rejection into
   * the body, so a post-resume trap unwinds exactly like a synchronous one —
   * jspi pin (e)).
   *
   * This is what lets one generator body serve both modes: in plain mode the
   * core call returns a value and the body never yields such a request, so
   * the synchronous path is bit-for-bit what it was before JSPI existed.
   */
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
 * Failure raised where the reference genuinely needs to suspend a wasm frame.
 *
 * This is deliberately *not* a `Trap`: the component is not at fault and the
 * program is not ill-formed — our runtime is incomplete. Reporting it as a
 * trap would let a conformance run score a missing capability as a correct
 * rejection, which is the exact failure mode contracts/plan-format.md's
 * error-phase split exists to prevent.
 */
export class NeedsJspi extends Error {
  constructor(what: string) {
    super(`needs JSPI (M2 phase 3): ${what}`);
    this.name = "NeedsJspi";
  }
}

export function needsJspi(what: string): never {
  throw new NeedsJspi(what);
}

/**
 * Failure raised where a capability scheduled for a later M2 phase is
 * required. Same rationale as `NeedsJspi`: never a `Trap`.
 */
export class PendingCapability extends Error {
  constructor(what: string) {
    super(`pending-capability: ${what}`);
    this.name = "PendingCapability";
  }
}

/**
 * Hook invoked when a trap breaks an instance's enter/leave bracket in
 * `Store.tick` (instance poisoning — see the comment at the call site).
 * task/streams.ts registers the stream/future-end retirement walk here
 * (#66). An injection seam rather than an import: streams.ts (via
 * waitable.ts) already imports this module, and a scheduler → streams import
 * would make `CopyEnd extends Waitable` evaluation-order-sensitive.
 */
let onInstancePoisoned:
  | ((inst: { handles: Iterable<unknown> }, cause: unknown) => void)
  | null = null;

/** @internal — see `onInstancePoisoned`; registered once by task/streams.ts. */
export function setOnInstancePoisoned(
  f: (inst: { handles: Iterable<unknown> }, cause: unknown) => void,
): void {
  onInstancePoisoned = f;
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
  // First cause wins: a poisoned instance can collect follow-on failures
  // (late settles retired against it, repeated bracket breaks), and the
  // original trap is the one worth reporting on later entry refusals
  // (polyengine#145 ask 1).
  if (!poisonedInstances.has(inst)) poisonedInstances.set(inst, cause);
  onInstancePoisoned?.(inst, cause);
}

/** Poisoned instances → poisoning cause, for late-settle retirement
 * (`Thread.resumeWith`) and entry-refusal diagnostics (`withPoisonCause`,
 * polyengine#145). A WeakMap mirror of streams.ts's `retiredInstances`, kept
 * here because thread.ts cannot import streams.ts (the same
 * evaluation-order constraint that made `setOnInstancePoisoned` an
 * injection seam). */
const poisonedInstances = new WeakMap<object, unknown>();

export function isInstancePoisoned(inst: object): boolean {
  return poisonedInstances.has(inst);
}

/**
 * May a settled activation tail for parked thread `t` be DISPATCHED now
 * (issue #156)? True iff its instance is host-enterable — `Thread.resumeWith`
 * brackets the resumption with `enterFrom(null)` — or POISONED, in which case
 * `resumeWith`'s early return retires it and deferring would leak forever.
 *
 * CONTRACT: a parked entry without a reachable `task.inst` (the partial
 * thread doubles the host-pump tests park in `Store.awaiting`) holds no
 * reentrance state, so there is nothing to defer on: dispatchable.
 */
// deno-lint-ignore no-explicit-any
export function dispatchableTail(t: any): boolean {
  const inst = t?.task?.inst;
  if (inst === undefined || inst === null) return true;
  return isInstancePoisoned(inst) || inst.mayEnterFrom(null);
}

/**
 * The recorded cause of an instance's poisoning: the original trap that
 * broke the enter/leave bracket (polyengine#145). `undefined` when the instance
 * is not poisoned — and, degenerately, when the poisoning cause itself was
 * a thrown `undefined`; use `isInstancePoisoned` for the predicate.
 */
export function instancePoisonCause(inst: object): unknown {
  return poisonedInstances.get(inst);
}

/**
 * Append the recorded poison cause to an entry-refusal trap message
 * (polyengine#145 ask 1). "cannot enter component instance" covers two states
 * that send an embedder down entirely different debugging paths — a
 * transient reentrance overlap (retry later, look for caller-side call
 * overlap) and a permanently poisoned instance (the corpse of an earlier
 * trap, which this suffix names). Only the poisoned case gets the suffix:
 * the transient message stays byte-identical, and the suffix is
 * conformance-safe because the official suite matches trap messages by
 * substring (harness/src/runner.ts).
 */
export function withPoisonCause(inst: object, base: string): string {
  if (!poisonedInstances.has(inst)) return base;
  const cause = describeCause(poisonedInstances.get(inst));
  return `${base} — instance poisoned by: ${cause}`;
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
 * Test hook: snapshot the module's current seed without mutating it. Used by
 * the `just sched-seeds` regression guard (sched_seed_guard_test.ts) to
 * confirm `readSeed()` actually picked up `POLYENGINE_SCHED_SEED` from the
 * environment at import time, rather than silently falling back to FIFO for
 * lack of `--allow-env`.
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
 * Pick one candidate. FIFO (index 0 — candidates are supplied in
 * ready-order) unless a seed is configured, in which case a seeded uniform
 * choice, mirroring the reference's `random.choice`.
 */
export function chooseCandidate<T>(candidates: readonly T[]): T {
  assert_(candidates.length > 0, "chooseCandidate on an empty candidate set");
  if (seed === null) return candidates[0];
  return candidates[nextRandom() % candidates.length];
}

// ---------------------------------------------------------------------------
// Current-thread context (definitions.py `current_thread`, line 306)
// ---------------------------------------------------------------------------

/**
 * The reference keeps the running thread in a thread-local
 * (`thread_local_handler`). A JS generator has no such ambient slot, so the
 * scheduler maintains an explicit stack: `resume()` pushes, and every
 * canonical built-in reads the top. It is a stack rather than a single slot
 * because a *host* import called from a guest can lift into another component
 * instance, nesting one activation inside another exactly as the reference's
 * recursive `store.lift` does.
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
 * Run `fn` with `t` as the ambient, for `fn`'s SYNCHRONOUS extent.
 *
 * This is the wasm-entry bracket (`awaitCore`). It is the same `threadStack`
 * the scheduler's own `resume()` bracket uses, deliberately: a wasm entry made
 * from *inside* an engine-driven resumption (a FACT callee reached from a
 * resumed activation — fact_calls.ts) has an empty scheduler bracket, and the
 * entry itself is then the most specific statement of who is running.
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
 * The WASM-ENTRY brackets alone — a subset of `threadStack`.
 *
 * Kept separately because it is the exact analogue of what the retired
 * async-context store held: the store was written by `withActivation` and by
 * nothing else, so a built-in reached under a scheduler `resume()` bracket
 * that had not (yet) entered wasm saw NO store, even though `threadStack`
 * named a thread. `Store.consumePendingIfRunning` — the driver-gate
 * release whose scheduling effects the corpus pins precisely — asked exactly
 * that question, so it must keep asking exactly that question — measured:
 * routing it through the full `threadStack` instead moved 64 conformance
 * commands. Ambient *resolution* is a different question and uses the full
 * `threadStack`.
 */
// deno-lint-ignore no-explicit-any
const entryStack: any[] = [];

/**
 * "Whose wasm frame are we lexically inside, or running on behalf of?" — the
 * async-context store's replacement, used only by
 * `Store.consumePendingIfRunning`.
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
 * ACTIVATIONS THE ENGINE IS RUNNING OUTSIDE OUR FRAMES — innermost last.
 *
 * ===========================================================================
 * WHAT REPLACED THE ASYNC-CONTEXT STORE, AND WHY IT NEEDS NO ENGINE MAGIC
 * ===========================================================================
 *
 * A wasm activation under JSPI does not stay inside our JS frames. Two
 * distinct mechanics take it outside them, and BOTH are ours to observe:
 *
 *   (i)  A GENUINE SUSPENSION. A `Suspending`-wrapped built-in returned a
 *        Promise; the engine parks the activation and resumes it in a
 *        microtask of its own when that Promise settles. There is exactly one
 *        source of such a Promise in this runtime — `blockCurrentActivation`
 *        mints it, `SuspensionPoint.resume`/`.abandon` settle it — so the
 *        moment of resumption is ours, including for a **background
 *        activation** whose lifted call already returned (that resumption
 *        still runs through `SuspensionPoint.resume`, from `Store.tick`).
 *
 *   (ii) THE MICROTASK HOP ON EVERY `Suspending` CALL — jspi pin (j),
 *        `tests/jspi/fastpath_hop_test.ts`. Even when the built-in produced
 *        its value synchronously and nothing suspended, the guest's frame
 *        resumes through a microtask, i.e. AFTER our `withActivation` bracket
 *        (and `callCore`, and the whole driving frame) has unwound. This one
 *        is easy to overlook because nothing looks asynchronous at the call
 *        site; it is nonetheless the dominant case, and the one that produced
 *        `exit-sync-call with an empty sync-call stack` when it was missed
 *        (trap-if-done.wast:448, big-interleaving-test.wast).
 *
 * Both are claimed explicitly — (i) in `SuspensionPoint.resume`, (ii) in the
 * wrapper `suspendingImport` puts around every blocking-capable trampoline —
 * naming the activation captured from the ambient while its bracket was still
 * live. That is exactly the value the async-context store used to
 * reproduce: the store was set by `withActivation` around the wasm entry, and
 * the engine restored it because it had captured the context when it
 * registered the continuation. We now record the same activation ourselves,
 * at the same instant, by construction — no Node `async_hooks` builtin, no
 * `AsyncContext` proposal, nothing beyond Promises (docs/architecture.md §4.3; M3A-1).
 *
 * NOTE ON ORDINARY `await`s. Nothing here needs a context to survive a plain
 * `await` any more, and nothing ever did on its own merits: the driving loops
 * (`drive`/`driveAsync` in exec/boundary.ts, the host-stream pump) run outside
 * every activation and read no ambient. What they do is *resume* threads, and
 * every resumption re-establishes the ambient explicitly — a scheduler-driven
 * one through `Thread.#resumeInternal`'s `pushCurrentThread` bracket, an
 * engine-driven one through this queue.
 *
 * LIFO, TOP-IS-CURRENT — and that direction is load-bearing, not incidental.
 * Activations NEST: an outer activation's built-in can synchronously enter an
 * inner activation's wasm (`async-start-call` running its callee through
 * `awaitCore`), and the inner one is the one executing. Reading the OLDEST
 * claim instead of the newest was measured at 45 conformance failures.
 *
 * The opposite shape — A settles B's suspension so B runs AFTER A — is
 * deliberately NOT represented here: `SuspensionPoint.resume` pushes only when
 * nothing is currently running, so B never shadows A. B is picked up by its
 * own first `Suspending` call. (Until 2026-08-22 a third ambient tier — the
 * driver's `resumingThread` slot — also named B here; it was retired with the
 * slot, see `resolveAmbient` and `Store.pendingResumptions`.)
 *
 * An activation leaves this stack when it parks again
 * (`blockCurrentActivation`) or finishes (its `awaitValue` promise settles —
 * `Store.noteAwaiting`).
 */
// deno-lint-ignore no-explicit-any
const activationClaims: any[] = [];

/**
 * Record that the engine will run `t`'s wasm outside our frames.
 *
 * Idempotent in MEMBERSHIP but not in POSITION: re-claiming MOVES an
 * existing claim to the top. The stack's contract is "top = the innermost
 * activation the engine is running outside our frames", and a re-claim is
 * direct evidence that `t` is running RIGHT NOW (its Suspending import just
 * returned into its wasm). The previous early-return kept stale order: a
 * nested callee's claim whose release edge is a promise reaction
 * (`Store.noteAwaiting` -> `Store.releasePendingOf`) outlives the callee by a
 * microtask, and an outer activation's continuation chunk that resumed in
 * that window re-claimed itself as a NOOP — leaving the finished callee on
 * top, so every ambient read in the rest of the chunk (the next hop's
 * `owner` capture, and any unsafe intrinsic like `context.set`, which has
 * no hop to re-anchor on) answered the wrong thread. Found as issue #24:
 * wit-bindgen's callback epilogue restored its task pointer into another
 * thread's context slots, and the next disciplined callback invocation
 * panicked on a null slot (async_support.rs:578).
 *
 * A null/undefined activation is "no claim" — the instantiation-time shape
 * that has no thread at all.
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

// #24 probe.
// deno-lint-ignore no-explicit-any
function traceAmbient(what: string, t: any): void {
  // Lazy import avoidance: reuse context.ts's ids via a local map.
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
 * Drop `t`'s activation-ambient claim, if it holds one.
 *
 * The two closing edges: the activation PARKS on a fresh suspension
 * (`blockCurrentActivation`), or it FINISHES — its `awaitValue` promise
 * settles, normally or by rejection, and `Store.noteAwaiting`'s eager settle
 * continuation calls this. The `task.implicitThread` indirection covers the
 * second edge for claims taken against a task's implicit thread.
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
// The resumed-but-not-yet-run gate (a SEPARATE concern from the ambient above)
// ---------------------------------------------------------------------------
//
// This used to be a module-global single slot, `resumingThread`, doing two
// jobs: (1) the DRIVER's scheduling gate ("a suspension was settled and its
// activation has not run yet — do not schedule anything else"), and (2) tier 3
// of ambient resolution. Job (2) was retired on 2026-08-22 (issue #158) after
// measurement showed it never decided a read; job (1) is real, but it is
// per-Store SET semantics, not a global identity slot — see
// `Store.pendingResumptions` below, and `resolveAmbient` for the retirement
// evidence.

const AMBIENT_TRACE = (() => {
  try {
    return Deno.env.get("CE_AMBIENT_TRACE") === "1";
  } catch {
    return false;
  }
})();

/** Diagnostic (#24 probe): the full ambient state, for tracing. */
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
 * Diagnostic: module-scope AMBIENT state that must NOT survive a completed
 * call. The scheduling gate is no longer module-scope — a store's
 * `pendingResumptions` set is the per-Store analogue and is checked there.
 */
export function ambientResidue(): { stack: number; claim: boolean } {
  return {
    stack: threadStack.length,
    claim: activationClaims.length > 0,
  };
}

/**
 * THE ambient precedence, in one place. Every reader goes through this.
 *
 *   1. `threadStack` -- a synchronous bracket we pushed ourselves: either
 *      `Thread.#resumeInternal`'s `resume()` bracket, `withActivation`'s
 *      wasm-entry bracket, or `suspendingImport`'s built-in-call bracket.
 *      Most specific: we are literally inside that activation's execution.
 *   2. the TOP of `activationClaims` -- the innermost activation the engine
 *      is running outside our frames (a `Suspending` hop or a resumption).
 *      LIFO, because activations nest: an outer activation's built-in can
 *      synchronously enter an inner one's wasm.
 *   (There is no tier 3. A third tier — `resumingThread`, the driver's
 *      settle-time claim — existed from M3A-1 until 2026-08-22 and was
 *      RETIRED, see below.)
 *
 * Tier 2 replaced an async-context store (M3A-1). The store held
 * precisely "the innermost wasm activation currently executing, across the
 * engine's hops and resumptions", because it was written by `withActivation`
 * around the wasm entry and the engine restored it on every continuation it
 * had captured inside that extent. Tiers 1+2 now state that directly. The
 * equivalence is not asserted from the armchair: it was established
 * differentially, by running the whole conformance corpus with both the store
 * and this queue live and comparing them at every read (zero disagreements
 * over 1395 commands), and the corpus pins the result.
 *
 * Having TWO readers with different orders is not a hypothetical hazard: for
 * two rounds `currentThread` used store-first while `maybeCurrentThread` still
 * used slot-first, and since the FACT bracket sites read the latter, the
 * bracket was attributed to the driver's claim instead of its own activation
 * (`exit-sync-call with an empty sync-call stack`). Fixing the precedence in
 * one reader measured as "no change" because the failing sites used the other.
 * Do not add a third reader; extend this one. (`activationOf` above is not a
 * second reader -- it answers a different question, "whose wasm frame are we
 * running on behalf of", and is used only by
 * `Store.consumePendingIfRunning`.)
 *
 * TIER 3 RETIRED, 2026-08-22 (issue #158). The bottom tier used to be
 * `resumingThread`, the driver's settle-time claim -- a last resort that named
 * whichever activation was settled or claimed across an await, right for that
 * one and wrong for every other in-flight activation. It was removed on the
 * strength of a re-run of the M3A-1 differential methodology: an instrumented
 * build counted every read where tiers 1-2 were empty and the slot was live,
 * and measured ZERO deciding reads across the conformance corpus (FIFO,
 * 1257/0), both seeded shuffles (`POLYENGINE_SCHED_SEED` 1 and 4242),
 * test-runtime (all jspi pins), and the smoke-tls three-async-component #24
 * corpus. A removal build then ran green on every engine lane we have:
 * test-runtime, test-protocol, conformance (1257/0, no expectation changes),
 * sched-seeds, the shells (sm + node + jsc + bun, all "OK, matches
 * expectation"), the browsers (chromium + firefox), smoke-tls and smoke-c0.
 * The reading: post-#24 the sentinel discipline (tier 2's claim/release edges)
 * always answers first, so the slot's attribution role was vestigial. Its
 * other, live role -- the scheduling gate -- survives as the per-Store
 * `Store.pendingResumptions` set.
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
    // Reaching this is not an internal invariant violation, so it must not be
    // an `AssertionError`: it is a *known incompleteness*. wasmtime lets a
    // core module's start function call canonical built-ins during
    // instantiation, before any task exists, and definitions.py has no model
    // for that — `current_thread()` (line 306) simply presumes a running
    // task, because in the reference a built-in is only ever reached from
    // inside one.
    //
    // Instance-scoped built-ins already avoid this by taking their instance
    // from the trampoline declaration (see intrinsics/async_builtins.ts). What
    // lands here is a *task*-scoped built-in (task.return, task.cancel,
    // thread.yield, subtask.*) called at instantiation time, which needs the
    // instantiation-time task context the spec implies but does not spell out.
    // Exercised by test/async/dont-block-start.wast:3.
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
 * THE ambient, NARROWED BY THE INSTANCE WHOSE CORE FRAME IS EXECUTING.
 *
 * For a built-in whose declaration names a component instance, "who is
 * running" is not an open question about the whole store: the call arrived
 * from a core frame OF THAT INSTANCE, so the running activation is one of
 * that instance's. This narrows `resolveAmbient` accordingly — same tiers,
 * same order, candidates filtered — and falls back to the unscoped answer
 * when the instance has no candidate at all (the instantiation-time shape,
 * and any built-in reached before its instance has a task).
 *
 * WHY IT IS NEEDED (polyengine#24's residue; polyvisor#49 trap 1,
 * `runtime/tests/context_attribution_test.ts`). A JSPI continuation chunk —
 * the tail of a suspended activation, e.g. wit-bindgen's callback epilogue
 * restoring its task pointer with `context.set` (rt/async_support.rs:592) —
 * runs with an EMPTY `threadStack` and, unlike a hop, has no re-anchoring
 * edge of its own. Tier 2 then answers the newest claim, which is whichever
 * SIBLING activation suspended most recently. The attribution sentinels
 * (jspi/bridge.ts) plant that claim one microtask ahead of the chunk, which
 * is exact when the engine queues the resumption while the settle reaction
 * returns (measured so in Deno's V8) — and NOT exact in Chromium, where a
 * wider gap lets a sibling's sentinel land in between. Measured there 3/3:
 * one task's epilogue wrote its state pointer into another task's slots, and
 * the starved task's next callback entry hit `assert!(!state.is_null())`
 * (async_support.rs:578) -> unreachable.
 *
 * Ordering discipline cannot fix that class — engine chunk boundaries are not
 * observable, so every microtask-ordering scheme is a hope. Instance identity
 * is not a hope: it is static (the declaration), and it is decisive because
 * ONE INSTANCE CAN ONLY HAVE ONE ACTIVATION MID-FRAME AT A TIME — a callback
 * invocation holds `inst.exclusiveThread` for its whole extent, suspensions
 * included (definitions.py line 2187 / `runCallbackLoop`), and a sync or
 * stackful-async lift holds the entry gate. Two activations that can race for
 * an unbracketed read are therefore necessarily of different instances, which
 * is exactly what this discriminates.
 *
 * SPEC BASIS. `canon_context_get`/`canon_context_set` (definitions.py 2348 /
 * 2358) read `current_thread().storage`, and in the reference a built-in is
 * only ever reached from inside the activation that called it — the identity
 * is exact by construction, never inferred. This runtime has to reconstruct
 * it; narrowing the reconstruction to the declaring instance moves it TOWARD
 * the reference (it can only ever remove candidates the reference would never
 * have named), never away.
 */
// deno-lint-ignore no-explicit-any
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

/** definitions.py `current_task()` (line 309). */
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

/** definitions.py `current_instance()` (line 312). */
// deno-lint-ignore no-explicit-any
export function currentInstance(): any {
  return currentTask().inst;
}

// ---------------------------------------------------------------------------
// Store (definitions.py `class Store`, line 562)
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
 * The embedder-visible scheduler state (definitions.py `Store`). One per
 * instantiated component in this runtime — the reference shares one `Store`
 * across component instances of a linked graph, and so do we: `Executor`
 * creates a single `Store` and hands it to every `ComponentInstanceState`.
 *
 * `waiting` is kept as an **array, in insertion order**, which is what makes
 * the default policy FIFO: `readyCandidates()` preserves the order in which
 * threads started waiting.
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
   * An exception raised by a host import's promise (a rejection, or a trap
   * thrown while lowering its results). It cannot propagate out of the
   * microtask that produced it, so it is parked here and rethrown by whoever
   * is driving the store — which is the call the guest is blocked in.
   */
  hostFailure: unknown = undefined;

  /**
   * Resumed-but-not-yet-run activations of THIS store — the driver's
   * scheduling gate, not an ambient.
   *
   * Keeping this distinct from `activationClaims` matters. This set answers
   * "may I schedule something else right now?" (`Store.tick` and both driving
   * loops refuse while it is non-empty, which is what forces a microtask yield
   * so the resumed activation actually runs). `activationClaims` answers
   * "whose code is this?". Conflating them — driving off the ambient queue —
   * wedges the loops, because an activation that merely hopped legitimately
   * holds an ambient while the scheduler is free to proceed.
   *
   * PER-STORE and MULTI-ENTRY since 2026-08-22 (issues #158 mechanism B,
   * #210). It was one module-global slot with a one-claimant assert, which
   * (a) could not represent two legitimately-pending engine resumptions — a
   * running activation X delivering a resume to Z while Y's resumption was
   * still pending crashed on the assert — and (b) made every driver on every
   * store yield while ANY store held a claim, so an idle store's
   * `driveStoreAsync` died at the 10,000-hop assert (~311ms) while another
   * store merely dwelt on a slow host import. The assert's invariant was
   * tier-3 attribution unambiguity, which no longer exists (see
   * `resolveAmbient`), so it is gone with the slot; the entries and their
   * release edges are otherwise unchanged, per entry.
   *
   * Cross-store de-serialization is safe by disjointness: an activation
   * belongs to exactly one store. Same-store it is strictly more conservative
   * than the old slot — the gate keeps refusing until EVERY pending entry has
   * died, rather than crashing on the second.
   *
   * Release edges, per entry: the activation PARKS again
   * (`blockCurrentActivation` -> `consumePendingIfRunning`), it FINISHES (its
   * `awaitValue` promise settles -> `noteAwaiting` -> `releasePendingOf`), or
   * the driver drops its own speculative entry (`removePendingResumption`).
   */
  readonly pendingResumptions: Set<unknown> = new Set<unknown>();

  /**
   * Record that a suspension of this store has been settled and its
   * activation has not run yet. Idempotent; a null/undefined activation is
   * "no entry" (the instantiation-time shape that has no thread at all).
   *
   * No one-claimant assert: two entries are legitimate (see
   * `pendingResumptions`). Two SuspensionPoints of ONE task cannot be pending
   * simultaneously — a task's single activation suspends at one point at a
   * time — so collapsing entries by identity loses nothing.
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
   * Drop the pending entry iff its activation is demonstrably RUNNING — i.e.
   * the entry names the same thread the ACTIVATION AMBIENT names for the code
   * calling us. An entry exists to cover the window between settling a
   * suspension and the resumed activation running; once that activation's own
   * code is on the stack the window is closed, and holding the entry would
   * gate the store on an activation that has already had its turn — while a
   * running activation's built-in settles ANOTHER activation's suspension
   * (`subtask.cancel` delivering a cancellation to a parked callee,
   * cancellable.wast) that other entry must legitimately stay.
   *
   * The comparison is against `activationOf()` — the wasm-ENTRY brackets,
   * deliberately not the full `threadStack` (see `entryStack`: routing it
   * through the full stack moved 64 conformance commands).
   */
  consumePendingIfRunning(): void {
    const a = activationOf();
    if (a !== null && a !== undefined) this.pendingResumptions.delete(a);
  }

  /**
   * Drop the pending entry naming `t` — the settle-side half: an entry taken
   * when `t`'s suspension was settled dies when `t`'s activation finishes (its
   * `awaitValue` promise settles; `noteAwaiting` calls this from the eager
   * settle continuation) or parks again (`blockCurrentActivation` consumes via
   * `consumePendingIfRunning`).
   *
   * The `task.implicitThread` indirection covers entries taken against a
   * task's implicit thread. `t` FINISHING also ends its activation ambient,
   * so both are dropped here.
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

  /** Ready waiting threads, in wait order (the FIFO of the default policy). */
  readyCandidates(): SchedulableThread[] {
    return this.waiting.filter((t) => t.ready());
  }

  /**
   * Threads parked on a Promise (the jspi `awaitValue` seam). They are not in
   * `waiting` — nothing the scheduler can do makes them ready — so the driving
   * loop tracks them separately and resumes them when their promise settles.
   */
  // deno-lint-ignore no-explicit-any
  readonly awaiting: Set<any> = new Set();

  /**
   * Settled-but-unserviced activation tails, in settle order.
   *
   * A settled `awaitValue` is the rest of an activation that already finished
   * its wasm: result shaping, the callback loop, `exit_implicit_thread` (and
   * with it the exclusive-thread release). The reference runs all of that
   * atomically inside `Thread.resume`; under jspi it lands a few engine
   * microtasks after the observable effects of the activation (`task.return`
   * flips `resolved` DURING the wasm, the settle only afterwards — jspi
   * pin (j)). Any scheduling decision taken in that window sees phantom
   * state — a finished callee still "holding" its exclusive slot made
   * cancellable.wast report STARTING for an entry the reference admits. So
   * settlement is recorded EAGERLY (at park time, below), `tick` refuses to
   * run anything while a tail is unserviced, and the driving loop services
   * this queue first.
   */
  readonly settled: {
    // deno-lint-ignore no-explicit-any
    t: any;
    value: unknown;
    failure: { error: unknown } | undefined;
  }[] = [];

  /**
   * Park `t` on `promise` (jspi `awaitValue`), with EAGER settle tracking.
   *
   * The `.then` here is also what closes the claim discipline for
   * resumptions the driver did not settle itself (a guest built-in resolving
   * another activation's suspension — `subtask.cancel` delivering a
   * cancellation): the claim taken at settle time must survive until the
   * resumed activation parks again or finishes, and "finished" is exactly
   * this continuation firing. See `releasePendingOf`.
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
   * Service settled activation tails. Returns whether anything ran. EVERY
   * driving loop must call this before (and interleaved with) `tick` — the
   * queue gates `tick`, so a driver that never services it wedges the store
   * (observed: host-stream pumping between export calls). A `resumeWith` may
   * throw (trap unwinding); callers propagate or park it exactly as they do
   * for `tick`.
   *
   * A tail whose instance is NOT host-enterable is DEFERRED IN PLACE — left
   * in the queue, skipped here — until the lock releases (issue #156).
   * `resumeWith` brackets the resumption with `enterFrom(null)`, and under
   * the shared synthetic per-instantiation root a host entry into ANY
   * instance of the graph locks the root, so while one instance is entered a
   * sibling's tail cannot be dispatched: dispatching it tripped
   * `resumeWith`'s enterability assert (which, mutating before asserting,
   * also stranded the thread and lost the settle).
   *
   * Deferral is safe because `!inst.mayEnterFrom(null)` is EXACTLY `tick`'s
   * candidate-filter predicate on the same instance: while a tail of `inst`
   * is deferred, `tick` cannot resume any thread of `inst` either, so the
   * phantom-state gate the queue exists to enforce is preserved per-instance
   * by construction.
   *
   * The ordering discipline is therefore per-instance settle order. Cross-
   * instance order relaxes only when enterability defers a tail, which is
   * conforming schedule nondeterminism: in definitions.py the tail runs
   * atomically inside the entered bracket, so a host entry admitted during a
   * park necessarily orders before the parked activation's tail there.
   *
   * A POISONED instance's tail is still dispatched: `resumeWith`'s poison
   * early-return retires it, and deferring it would leak forever — a
   * poisoned leaf keeps its lock permanently.
   */
  serviceSettled(): boolean {
    let did = false;
    // Rescan from the head after every dispatch: a dispatched tail runs guest
    // code synchronously, which can change lock/poison state and can re-enter
    // `serviceSettled` (mutating the queue under us).
    scan: for (;;) {
      for (let i = 0; i < this.settled.length; i++) {
        const s = this.settled[i];
        // Stale: the thread was resumed elsewhere (driveAsync's race-winner
        // path). Drop it regardless of enterability; it is not progress.
        if (!this.awaiting.has(s.t)) {
          this.settled.splice(i, 1);
          continue scan;
        }
        if (!dispatchableTail(s.t)) continue;
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
   * "Would a `serviceSettled` call make progress right now?" — i.e. some
   * entry is stale (would be removed) or serviceable (would be dispatched).
   * A queue holding ONLY deferred tails (issue #156) answers false: `tick`
   * must not be gated by them, and the driving loops must not spin on them.
   */
  hasServiceableSettled(): boolean {
    for (const s of this.settled) {
      if (!this.awaiting.has(s.t)) return true;
      if (dispatchableTail(s.t)) return true;
    }
    return false;
  }

  /**
   * "Does component instance `inst` still have runnable work?" — the
   * drain-to-quiescence predicate behind the **deferred entry decision**
   * (issue #43).
   *
   * wasmtime decides an async-lowered call's initial status only after the
   * executor has drained the work queued ahead of it: a queued
   * `GuestCall(StartImplicit)` is popped, and if `is_ready` is false
   * (`do_not_enter || backpressure`) the caller is told STARTING
   * (concurrent.rs :1497-1522, :3040-3160). That formulation is FIFO-order
   * dependent; polyengine uses the order-robust restatement (issue #43): *the
   * call reports STARTING only if the callee is still unstarted after the
   * instance's runnable work has been exhausted* — drain to quiescence, not
   * pop-one. That is what keeps `sync-streams.wast` green under
   * `POLYENGINE_SCHED_SEED` shuffles, which wasmtime's own rule would not be.
   * Adjudicated 2026-08-10 (issue #43): entry-status timing is NOT
   * normative — this predicate implements a scheduler *policy*, picked so
   * the suite's schedule-overfitted STARTED assertion holds under any
   * seed; the hold-rule gate itself is the spec semantics.
   *
   * "Runnable work of `inst`" is, exhaustively:
   *
   *   (a) a settled-but-unserviced activation tail (`settled`) — bookkeeping
   *       the reference runs atomically inside `Thread.resume`, so the
   *       instance is mid-step, not quiescent;
   *   (b) a waiting entry (thread or `SuspensionPoint`) of `inst` that is
   *       `ready()` — the scheduler will resume it on the next tick. A gate
   *       holder parked mid-frame on an un-rendezvous'd operation is NOT
   *       ready and therefore contributes nothing: that is the "holder
   *       cannot be drained" case, whose answer is STARTING;
   *   (c) a thread of `inst` in `awaiting` whose promise is not a scheduler
   *       park — i.e. genuinely in flight across an engine microtask hop.
   *       A JSPI-parked activation appears in `awaiting` *and* owns a
   *       `SuspensionPoint` in `waiting` (`SuspensionPoint.owner`), and is
   *       accounted for by (b) instead; counting it here would make the
   *       instance permanently non-quiescent.
   *
   * `excludeTask` is the CALLER's task, and is excluded everywhere: the
   * caller cannot be drained — it is the activation asking the question.
   * This is what makes the "only obstacle is the current running activation"
   * shape (a nested lower from inside the gate holder's own invocation)
   * answer STARTING immediately, with no park at all.
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
   * definitions.py `Store.tick` (line 597): resume one ready thread, bracketed
   * by the reentrance gate for a host-initiated entry (`enter_from(None)` /
   * `leave_to(None)`).
   *
   * Returns false when no thread was ready, so callers can distinguish
   * "made progress" from "stuck" without inspecting the queue themselves.
   */
  tick(): boolean {
    // One suspension resolved per turn.
    //
    // Settling a suspension hands control to wasm in a *microtask*, not
    // synchronously — so `tick` returns with the resumed activation not yet
    // run and its pending entry still outstanding. Resolving a second one
    // before that happens would let the first activation's built-ins
    // attribute themselves to the wrong task (observed as `exit-sync-call`
    // popping another task's bracket). Refusing to make progress while an
    // entry is pending forces the caller to yield to the microtask queue
    // first, which is exactly what `driveAsync` does.
    //
    // THIS STORE's entries only (issue #210): activations never cross stores,
    // so another store's pending resumption says nothing about what this one
    // may schedule.
    if (this.pendingResumptions.size > 0) return false;
    // Same discipline, other edge: a settled-but-unserviced activation tail
    // (see `settled`) is mid-"atomic resume" from the reference's point of
    // view; scheduling anything before servicing it acts on phantom state.
    //
    // Only a SERVICEABLE tail gates: a tail DEFERRED on a non-enterable
    // instance (issue #156) cannot be dispatched now, and gating on it would
    // wedge the store (and hot-spin the drivers). It does not need to gate,
    // because its instance is self-excluded from the candidate set by the
    // enterability filter below — the same predicate on the same instance —
    // so no thread of that instance can be resumed while its tail waits.
    if (this.hasServiceableSettled()) return false;
    // Ready is not sufficient: the thread's instance must also be enterable
    // from the host. The reference *asserts* this in `Store.tick` — a waiting
    // thread's instance is always re-enterable there, because its host entry
    // has either left or is itself a waiting thread. That does not hold here.
    //
    // Instances of one linked graph share a Store and, with it, the synthetic
    // per-instantiation root (plan v3 amendment 4): `enterFrom(null)` locks
    // the callee AND the root, so while ANY instance is entered from the host
    // — e.g. a sync export parked on an async host import, which in this
    // runtime is a real suspension rather than a blocked OS thread — no
    // instance in the graph is host-enterable. A sibling instance whose
    // thread goes ready in that window (event-driven wakeups do this on every
    // clock turn) would then trip the assertion, and the failure escapes
    // through whatever host-import promise is in flight.
    //
    // So "ready but not enterable" is treated as no progress, exactly as the
    // sync driving loop already does by restricting its candidate set to the
    // callee instance (`driveSyncLift` below; definitions.py `canon_lift`).
    // This cannot livelock: the entered call's host import settles from host
    // JS independently of `tick`, and when that call returns, `leaveTo(null)`
    // unlocks the root and the skipped threads run on the next turn.
    const candidates = this.readyCandidates().filter((t) =>
      t.task.inst.mayEnterFrom(null)
    );
    if (candidates.length === 0) return false;
    const thread = chooseCandidate(candidates);
    const inst = thread.task.inst;
    inst.enterFrom(null);
    // Deliberately NOT a `finally`: if the resumed thread traps, the reference
    // never reaches `leave_to` either (definitions.py `Store.tick`, line 597,
    // where a Trap propagates out of `thread.resume()`), so the instance stays
    // locked — the Component Model's instance poisoning. See the `poison`
    // helper in exec/boundary.ts for the full rationale.
    //
    // Capability signals are the exception, for the same reason as there: a
    // `NeedsJspi`/`PendingCapability` marks an operation this runtime cannot
    // perform, not a component fault. In the reference that operation blocks
    // and then completes, so `leave_to` *is* reached and the instance stays
    // enterable — poisoning here would turn one unsupported operation into a
    // permanently dead instance.
    try {
      thread.resume();
    } catch (e) {
      if (e instanceof NeedsJspi || e instanceof PendingCapability) {
        inst.leaveTo(null);
      } else {
        // The bracket stays broken (instance poisoned, comment above), so
        // its live stream/future ends can never rendezvous again — retire
        // them so parked host peers settle instead of hanging (#66).
        //
        // The synthetic root (plan v3 amendment 4) is released, though: it is
        // in this entry's entering set but must not turn per-instance
        // poisoning into store-wide poisoning. See
        // `ComponentInstanceState.releaseSyntheticRootOnPoison`.
        //
        // Routed through `notifyInstancePoisoned` (not the raw hook) so the
        // poison MARKER is recorded too (polyengine#145): `Thread.resumeWith`'s
        // quiet-retire of late settled tails and `dispatchableTail`'s
        // dispatch-or-defer decision (#156) both read it, and without the
        // marker a settled tail of this instance would hit the backstop
        // assert or defer forever.
        inst.releaseSyntheticRootOnPoison?.();
        notifyInstancePoisoned(
          inst as unknown as { handles: Iterable<unknown> },
          e,
        );
      }
      throw e;
    }
    inst.leaveTo(null);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Host-call classification (shared by the drivers in exec/)
// ---------------------------------------------------------------------------

/**
 * Host-activity "arm" promises, by identity: entries a driver parks in
 * `Store.pendingHostCalls` purely to say "the embedder may still act". They
 * are NOT outstanding work — treating them as such is the "activity keeps
 * `pendingHostCalls` non-empty forever" hazard documented in
 * exec/host_streams.ts — so the between-calls drivers filter them out via
 * `hasRealHostCall`/`realHostCalls`. The registry lives here (rather than in
 * exec/host_streams.ts, which mints the arms) so exec/boundary.ts's
 * settlement pump can share the classification without an import cycle.
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
 * Is there anything left that only a turn of the event loop could advance?
 * Activity arms do not count: they say "the embedder may still act", which is
 * precisely the state in which a between-calls driver should stop and let the
 * operation's promise stay pending (the documented hang, exec/host_streams.ts
 * module header).
 *
 * `store.settled` (settled-but-unserviced activation tails) DOES count: it
 * gates `tick`, so exiting with a tail queued is a lost wakeup — the store is
 * wedged until some other driver appears.
 */
export function storeQuiescent(store: Store): boolean {
  return store.settled.length === 0 && store.awaiting.size === 0 &&
    !hasRealHostCall(store);
}

/**
 * The reference's `canon_lift` sync driving loop (line 2213):
 *
 * ```python
 * while task.state != Task.State.RESOLVED:
 *   candidates = { t for t in inst.threads if t.ready() and t is not inst.exclusive_thread }
 *   trap_if(not candidates)
 *   random.choice(list(candidates)).resume()
 * ```
 *
 * Note the candidate set is `inst.threads` — threads *of the callee instance*
 * — and excludes the exclusive thread, and that an empty set is a **trap**
 * (the spec's deadlock trap), not a hang.
 */
export function driveSyncLift(
  task: {
    state: string;
    inst: { threads: Iterable<SchedulableThread>; exclusiveThread: unknown };
  },
): void {
  while (task.state !== "resolved") {
    const candidates = [...task.inst.threads].filter(
      (t) => t.ready() && (t as unknown) !== task.inst.exclusiveThread,
    );
    trapIf(
      candidates.length === 0,
      "deadlock: synchronous task cannot resolve and no thread is ready",
    );
    chooseCandidate(candidates).resume();
  }
}
