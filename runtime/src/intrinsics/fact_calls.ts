// FACT cross-component call intrinsics: `prepare-call`, `sync-start-call` and
// `async-start-call` (contracts/intrinsics.md §A).
//
// These are how one component calls another's *async-lifted* export, or how an
// async-lowered import reaches any export. They have no direct analogue in
// definitions.py, because the reference has no fused adapters: there,
// `canon_lower` calls the callee's `FuncInst` directly and the host performs
// every copy. wasmtime instead compiles a FACT adapter that hoists the copying
// into wasm and asks the host to do only the task bookkeeping. The *semantics*
// are the reference's; only the division of labour differs.
//
// ===========================================================================
// THE PROTOCOL (wasmtime-environ 47.0.3)
// ===========================================================================
//
// Emission sites: `fact/trampoline.rs` — `call_prepare` (line 513),
// `compile_async_to_async_adapter` (474), `compile_sync_to_async_adapter`
// (607), `compile_async_to_sync_adapter` (643). Signatures: `fact.rs`
// `import_prepare_call` (584), `import_sync_start_call` (620),
// `import_async_start_call` (643), with `PREPARE_CALL_FIXED_PARAMS` at
// `fact.rs:47`.
//
//   prepare-call(start: funcref, return: funcref,
//                caller_instance: i32, callee_instance: i32,
//                task_return_type: i32, callee_async: i32,
//                string_encoding: i32, result_count_or_max_if_async: i32,
//                ...caller's own flat params) -> ()
//
//   sync-start-call (callee: funcref, lift_param_count: i32)
//                       -> the caller's flat results
//   async-start-call(callee: funcref, param_count: i32,
//                    result_count: i32, flags: i32) -> i32   (packed subtask)
//
// **The `start` / `return` funcrefs are the reference's `on_start` /
// `on_resolve`.** That is the load-bearing finding, and their signatures
// (`fact/signature.rs`) say so exactly:
//
//   `[async-start]` (async_start_signature, line 61)
//       params  = the *caller's* flattened params  (what prepare-call stashed)
//       results = the *callee's* flattened params  (hand straight to the callee)
//     i.e. "given the caller's arguments, produce the callee's" — `on_start`.
//
//   `[async-return]` (async_return_signature, line 145)
//       params  = the *callee's* flattened results (+ a retptr when the caller
//                 is async-with-results, or when the caller's results spill)
//       results = the *caller's* flattened results (empty if async/spilled)
//     i.e. "given the callee's results, produce the caller's" — `on_resolve`.
//
// So the host never inspects a value: it calls `start` to get the callee's
// arguments, and calls `return` with whatever the callee produced. This is why
// a FACT task's payload is flat core values (`Task.factPassthrough`).
//
// Two details that fall out of the emission sites:
//
//   * `prepare-call` must NOT run the callee. The callee may be exerting
//     backpressure, and the whole point of splitting prepare from start is to
//     let the host stash the parameters until it clears (fact.rs:580-583).
//     The stashed state feeds `Task.enterImplicitThread`, which is exactly
//     where the reference's backpressure gate lives.
//   * Reentrance between *related* instances is resolved statically:
//     `trampoline.rs:116-127` emits an unconditional
//     `trap(Trap::CannotEnterComponent)` when the lower and lift instances are
//     the same or are ancestors of one another. So the flat-instance-tree gap
//     recorded in task/mod.ts is NOT load-bearing here — wasmtime has already
//     decided those cases at translation time, and the remaining runtime check
//     is the ordinary "is the callee instance currently executing" one, which
//     a flat tree answers correctly.

import { assert_, trap } from "../cabi/trap.ts";
import { MAX_FLAT_RESULTS } from "../cabi/mod.ts";
import type { CoreValue, FuncType, ValType } from "../cabi/types.ts";
import {
  type BlockRequest,
  type Cancelled,
  ComponentInstanceState,
  NeedsJspi,
  currentTask,
  maybeCurrentTask,
  needsJspi,
  notifyInstancePoisoned,
  packSubtaskResult,
  PendingCapability,
  Subtask,
  SubtaskState,
  Task,
  type TaskOptions,
  Thread,
  entryRefusal,
} from "../task/mod.ts";
import { blockCurrentActivation, enterWasm } from "../jspi/mod.ts";
import {
  awaitCore,
  callCore,
  type CoreFn,
  type ExecutionStats,
  normalizeCoreValues,
  runCallbackLoop,
} from "../exec/boundary.ts";
import { traceCopy } from "./stream_builtins.ts";

/** `PREPARE_ASYNC_NO_RESULT` (wasmtime-environ `component.rs:39`). */
const PREPARE_ASYNC_NO_RESULT = 0xffff_ffff;
/** `PREPARE_ASYNC_WITH_RESULT` (`component.rs:45`). */
const PREPARE_ASYNC_WITH_RESULT = 0xffff_fffe;
/** `START_FLAG_ASYNC_CALLEE` (`component.rs:52`). */
export const START_FLAG_ASYNC_CALLEE = 1;

/** Number of fixed leading parameters of `prepare-call` (`fact.rs:47`). */
const PREPARE_FIXED = 8;

/** The state `prepare-call` stashes for the following `*-start-call`. */
export interface PreparedCall {
  /** `[async-start]` adapter export — the reference's `on_start`. */
  start: CoreFn;
  /** `[async-return]` adapter export — the reference's `on_resolve`. */
  return_: CoreFn;
  callerInst: ComponentInstanceState;
  calleeInst: ComponentInstanceState;
  /** `TypeTupleIndex` of the callee's (lifted) results. */
  taskReturnType: number;
  /** Whether the callee's *function type* is async. */
  calleeAsync: boolean;
  stringEncoding: number;
  resultCountOrMax: number;
  /** The caller's own flat arguments, as forwarded to `prepare-call`. */
  params: CoreValue[];
  /**
   * Where the *caller's* results go, decoded from
   * `result_count_or_max_if_async` exactly as wasmtime's `ResultInfo`
   * (`concurrent.rs:2815-2836`):
   *
   *   * async caller **with** a result -> `Heap`, retptr = last param
   *   * async caller without a result  -> `Stack`
   *   * sync caller whose results spill (`result_count > MAX_FLAT_RESULTS`)
   *                                    -> `Heap`, retptr = last param
   *   * sync caller otherwise          -> `Stack`
   *
   * In the `Heap` case the retptr must be **appended** to the
   * `[async-return]` arguments (`concurrent.rs:2916-2919`) — it is the last
   * parameter of `async_return_signature` (fact/signature.rs:166,178), not
   * something the callee produced.
   */
  resultInfo: { kind: "heap"; retptr: CoreValue } | { kind: "stack" };
  /** True when the caller used the async ABI *and* has a result. */
  asyncCallerWithResult: boolean;
  /**
   * The memory `prepare-call` names (`component/info.rs:1059`: "the memory
   * used to verify that the memory specified for the `task.return` that is
   * called at runtime matches the one specified in the lifted export").
   *
   * Decoded faithfully, but NOT usable for that verification: it is the
   * *adapter's* view (`adapter.lift.options...memory`) and is `None` for
   * callees whose own `task.return` options do name a memory. wasmtime gets
   * away with the check because it holds the lift memory first-hand and its
   * comparison is one-sided (concurrent.rs:3344-3358). Kept because it is the
   * wire field and the task's options are structurally built from it; see the
   * comment on the memory half of the check in async_builtins.ts.
   */
  memory: unknown | null;
}

/** Executor services these intrinsics need. */
export interface FactCallContext {
  componentInstance(index: number): ComponentInstanceState;
  /** Element types of an interned results tuple (a `plan.types` index). */
  resultTypes(index: number): ValType[];
  /**
   * Element types for a *raw* wasmtime `TypeTupleIndex` (what `prepare-call`
   * passes as `task_return_type`), or `null` if the plan maps none — plan v3,
   * see `LoadedPlan.resultTupleTypes`.
   */
  resultTypesForTuple(tupleIndex: number): ValType[] | null;
  /** `RuntimeCallbackIndex` -> the callee's callback core function. */
  callback(index: number): CoreFn;
  /** `RuntimeMemoryIndex` -> the memory `task.return` must match, if any. */
  memoryToken(index: number): unknown;
  stats: ExecutionStats;
  /** Suspension discipline (jspi/bridge.ts). */
  suspensionMode: import("../jspi/mod.ts").SuspensionMode;
  /**
   * Can this specific callee's code reach a suspension point? Computed per
   * core instance at instantiation (see `Executor.suspendableFuncs`). Decides
   * whether the callee gets its own `promising` entry.
   */
  calleeCanBlock?(fn: unknown): boolean;
  /**
   * The single in-flight prepared call. wasmtime keeps this per *task*; a
   * single slot is equivalent here because `prepare-call` and its
   * `*-start-call` are emitted back-to-back in one adapter body
   * (`trampoline.rs:486-508`) with no suspension point between them, so two
   * preparations can never be outstanding at once. Asserted, not assumed.
   */
  prepared: { current: PreparedCall | null };
  /** See `TrampolineContext.factStartScopes` (intrinsics/mod.ts). */
  factStartScopes: import("./mod.ts").FactStartScope[];
}

/** definitions.py-shaped canonical options a FACT task must remember. */
function taskOptionsFor(
  prepared: PreparedCall,
  callback: CoreFn | null,
  memory: unknown,
  calleeUsesAsyncAbi: boolean,
): TaskOptions {
  return {
    // NOTE the distinction definitions.py draws and this code initially got
    // wrong: `Task.ft.async` is the *function type*'s asyncness (what
    // `prepare-call` passes as `callee_async`), while `Task.opts.async_` is
    // the *canonical options*' asyncness — and `canon_lift` branches on the
    // latter (`if not opts.async_:` at line 2168). A function can be
    // async-*typed* yet lifted with sync options, in which case the reference
    // takes its plain synchronous path. Branching on the type instead sent
    // those callees down the stackful path and reported a bogus JSPI
    // requirement (`test/async/cross-abi-calls.wast`'s `async-calls-sync-*`).
    async_: calleeUsesAsyncAbi,
    callback: callback !== null,
    stringEncoding: stringEncodingName(prepared.stringEncoding),
    memory,
  };
}

/**
 * wasmtime's `StringEncoding` discriminant (`component/types.rs`), as passed
 * through `prepare-call`.
 */
function stringEncodingName(v: number): string {
  switch (v) {
    case 0:
      return "utf8";
    case 1:
      return "utf16";
    case 2:
      return "latin1+utf16";
    default:
      return "utf8";
  }
}

// ---------------------------------------------------------------------------
// prepare-call
// ---------------------------------------------------------------------------

export function createPrepareCall(
  decl: { memory: number | null },
  ctx: FactCallContext,
): CoreFn {
  return (...args: unknown[]) => {
    assert_(
      args.length >= PREPARE_FIXED,
      `prepare-call: expected at least ${PREPARE_FIXED} arguments`,
    );
    const [start, return_, callerI, calleeI, taskReturnType, calleeAsync, enc, rc_] =
      args;
    assert_(
      typeof start === "function" && typeof return_ === "function",
      "prepare-call: start/return must be funcrefs",
    );
    assert_(
      ctx.prepared.current === null,
      "prepare-call with a preparation already outstanding",
    );
    // GAP (tracked): wasmtime performs a `check_blocking` here —
    //   if let (CallerInfo::Sync { .. }, true) = (&caller_info, callee_async) {
    //       store.0.check_blocking()?;   // concurrent.rs:2802-2807
    //   }
    // i.e. a *sync-lowered* caller reaching an *async-typed* callee must
    // itself have been created by an async export, else it traps: only a task
    // that is allowed to block may make a blocking call. We cannot evaluate it
    // yet — it needs a "may this task block" bit on `Task`, which the reference
    // models through its thread/task structure rather than a flag. Its absence
    // means we accept some components wasmtime rejects; it never causes a
    // wrong answer for an accepted one. `test/async/trap-if-block-and-sync.wast`
    // is the file that exercises it, and that file is independently blocked on
    // the wasmparser pin drift, so nothing observable depends on it today.
    const params = args.slice(PREPARE_FIXED) as CoreValue[];
    const rc = Number(rc_) >>> 0;
    // wasmtime `ResultInfo` (concurrent.rs:2815-2836).
    const lastParam = (): CoreValue => {
      assert_(params.length > 0, "prepare-call: retptr missing");
      return params[params.length - 1];
    };
    let resultInfo: PreparedCall["resultInfo"];
    let asyncCallerWithResult = false;
    if (rc === PREPARE_ASYNC_WITH_RESULT) {
      resultInfo = { kind: "heap", retptr: lastParam() };
      asyncCallerWithResult = true;
    } else if (rc === PREPARE_ASYNC_NO_RESULT) {
      resultInfo = { kind: "stack" };
    } else if (rc > MAX_FLAT_RESULTS) {
      // Sync caller whose results spilled: the adapter appended a retptr to
      // its own parameters (`flatten_functype` lower/spill path).
      resultInfo = { kind: "heap", retptr: lastParam() };
    } else {
      resultInfo = { kind: "stack" };
    }
    ctx.prepared.current = {
      start: start as CoreFn,
      return_: return_ as CoreFn,
      callerInst: ctx.componentInstance(Number(callerI) >>> 0),
      calleeInst: ctx.componentInstance(Number(calleeI) >>> 0),
      taskReturnType: Number(taskReturnType) >>> 0,
      calleeAsync: Number(calleeAsync) !== 0,
      stringEncoding: Number(enc) >>> 0,
      resultCountOrMax: rc,
      params,
      memory: decl.memory === null ? null : ctx.memoryToken(decl.memory),
      resultInfo,
      asyncCallerWithResult,
    };
    // Deliberately does not touch the callee: see the header. The callee may
    // be under backpressure, and `*-start-call` is what runs it.
  };
}

// ---------------------------------------------------------------------------
// The shared callee activation
// ---------------------------------------------------------------------------

/**
 * Build the `Task` for a prepared call and the generator body that runs the
 * callee on it. Shared by both `*-start-call` forms; they differ only in how
 * they *wait* for the result.
 */
function mkCalleeTask(input: {
  prepared: PreparedCall;
  callee: CoreFn;
  callback: CoreFn | null;
  postReturn: CoreFn | null;
  ctx: FactCallContext;
  /**
   * Whether the callee was lifted with **async canonical options**
   * (`START_FLAG_ASYNC_CALLEE`). Distinct from `prepared.calleeAsync`, which
   * is the function *type*'s asyncness — see `taskOptionsFor`.
   */
  calleeUsesAsyncAbi: boolean;
  /** Suspension discipline for this instantiation (jspi/bridge.ts). */
  mode?: import("../jspi/mod.ts").SuspensionMode;
  /** Whether THIS callee can reach a suspension point. */
  canBlock?: boolean;
  /**
   * Called when `[async-start]` has actually run, i.e. when the callee really
   * started. wasmtime sets its `Status::Started` event at exactly this point,
   * inside the `lower_params` closure (concurrent.rs:2903-2908) — *not* when
   * the call was prepared. Under backpressure `enter_implicit_thread` blocks
   * first, so a subtask observed before this fires must still report STARTING.
   */
  onStarted?: () => void;
  /**
   * Receives the caller-side flat results produced by `[async-return]`, or
   * `null` when the callee resolved as *cancelled* (definitions.py
   * `Task.cancel` -> `on_resolve(None)`).
   */
  onCallerResults: (r: CoreValue[] | null) => void;
  /**
   * Caller-side lender registrar for borrows transferred during
   * `[async-start]` (definitions.py `lift_borrow` line 1517 adds lenders to
   * the caller's Subtask). async-start-call passes its `Subtask` (whose
   * `deliverResolve` releases them); sync-start-call passes a scope it
   * releases when the blocked caller frame gets its results.
   */
  lenderScope: { addLender(h: import("../cabi/handles.ts").ResourceHandle): void };
}): { task: Task; body: (t: Thread) => Generator<BlockRequest, void, Cancelled> } {
  const { prepared, callee, callback, postReturn, ctx, calleeUsesAsyncAbi } =
    input;
  // CONTRACT: default to `plain` when the context predates this field. Only
  // `jspi` may wrap, and wrapping a non-wasm callee throws outright, so the
  // conservative reading of an absent mode is "no suspension discipline".
  const mode = input.mode ?? "plain";
  // CONTRACT: default false -- a context that cannot answer the question gets
  // the non-wrapping (plain-shaped) behaviour, which is the conservative one:
  // it never forces asynchrony that the ABI forbids.
  const canBlock = input.canBlock ?? false;
  const memory = prepared.memory;
  const inst = prepared.calleeInst;

  // `ft` for the task: only `async` and `results` are consulted —
  // `Task.needsExclusive` reads the former, `canon_task_return`'s result-type
  // check reads the latter (which is why `prepare-call` carries
  // `task_return_type` at all: fact.rs's comment on `PrepareCall.memory` says
  // the same for the memory check).
  // `task_return_type` arrives as wasmtime's *own* `TypeTupleIndex` — a
  // runtime argument, not a plan field. Plan v3 (contracts/plan-format.md v3
  // amendment 3) supplies the dictionary for it: every `task-return`
  // trampoline decl carries that raw index alongside its interned
  // `plan.types` entry, so the callee task CAN now carry its declared result
  // types and `canon_task_return`'s `trap_if(result_type != task.ft.result)`
  // applies to FACT tasks too (async_builtins.ts).
  //
  // `null` = the plan has no `task.return` trampoline for this tuple, i.e.
  // the callee cannot call `task.return` at all (a sync-lifted callee reached
  // through an async-to-sync adapter). Then the check has nothing to compare
  // against and stays skipped — flagged by `factResultTypesKnown` rather than
  // by an empty-results coincidence.
  const declaredResults = ctx.resultTypesForTuple(prepared.taskReturnType);
  const ft: FuncType = {
    params: [],
    results: declaredResults ?? [],
    async: prepared.calleeAsync,
  };

  const task = new Task(
    ft,
    taskOptionsFor(prepared, callback, memory, calleeUsesAsyncAbi),
    inst,
    // on_start: the adapter's `[async-start]` turns the caller's flat params
    // into the callee's flat params (fact/signature.rs:61).
    //
    // An async caller that has a result passes its retptr as the *last* flat
    // parameter; `[async-start]` does not declare it, so it is chopped off
    // here exactly as wasmtime does (concurrent.rs:2869-2876, "Async callers,
    // if they have a result, use the last parameter as a return pointer so
    // chop that off"). Sync callers forward everything directly.
    () => {
      // Open the FACT borrow window for the duration of the copy adapter:
      // `[async-start]` is where argument resource transfers run, and it
      // cannot block (see the WASM-ENTRY note below), so push/pop brackets a
      // strictly synchronous window. Borrow bookkeeping lands on this
      // (callee) task's `numBorrows` and the caller's lender scope — see
      // intrinsics/mod.ts `FactStartScope`.
      ctx.factStartScopes.push({ taskScope: task, lenders: input.lenderScope });
      let calleeArgs: CoreValue[];
      try {
        calleeArgs = callCore(
          prepared.start,
          prepared.asyncCallerWithResult
            ? prepared.params.slice(0, -1)
            : prepared.params,
        ) as CoreValue[];
      } finally {
        ctx.factStartScopes.pop();
      }
      input.onStarted?.();
      return calleeArgs;
    },
    // on_resolve: the adapter's `[async-return]` turns the callee's flat
    // results into the caller's (fact/signature.rs:145).
    (result) => {
      if (result === null) {
        // Cancelled before returning: there is nothing for `[async-return]`
        // to copy. The subtask's CANCELLED_BEFORE_* state carries the news,
        // so signal it rather than a normal empty result.
        input.onCallerResults(null);
        return;
      }
      // `[async-return]` takes the callee's flat results and, when the
      // caller's results live in linear memory, the caller-supplied return
      // pointer as a trailing argument (fact/signature.rs:166,178; appended by
      // wasmtime at concurrent.rs:2916-2919). Omitting it made the adapter
      // read `undefined` for that parameter, which coerces to 0 — every
      // spilled result was written to linear-memory address 0.
      const args = result as CoreValue[];
      const withRetptr = prepared.resultInfo.kind === "heap"
        ? [...args, prepared.resultInfo.retptr]
        : args;
      input.onCallerResults(
        callCore(prepared.return_, withRetptr) as CoreValue[],
      );
    },
  );
  task.factPassthrough = true;
  task.factResultTypesKnown = declaredResults !== null;

  const body = function* (
    thread: Thread,
  ): Generator<BlockRequest, void, Cancelled> {
    if (!(yield* task.enterImplicitThread(thread))) return;
    const calleeArgs = task.start();
    traceCopy(`mkCalleeTask callee canBlock=${canBlock} mode=${mode}`);
    // WASM ENTRY (3 of 3 that can reach a blocking built-in).
    //
    // The other two — a lifted export's core function and a callback export —
    // are entered through `awaitCore`, which establishes the
    // activation-attached ambient. This one was not, and it is precisely the
    // entry that owns a FACT sync-call bracket: `enter-sync-call` runs here
    // under this task, and if the callee suspends, the engine resumes it later
    // with no driver. Without the ambient travelling with the activation the
    // matching `exit-sync-call` had no task in scope at all (traced in M2
    // phase 3h as `ENTER-SYNC owner=K26` / `EXIT-SYNC owner=EXECUTOR`).
    //
    // Entries deliberately NOT wrapped: `realloc`, `post-return`, resource
    // destructors and the `[async-start]`/`[async-return]` copy adapters.
    // None of them may block — they cannot reach a canonical built-in that
    // suspends — so the engine can never resume them, and wrapping would only
    // cost an ALS frame on the hot copy path.
    // The callee is its own activation and must get its own `promising`
    // entry, not merely an ambient scope: otherwise it runs *inside* whatever
    // `Suspending` trampoline invoked us, putting our JS frame between the
    // caller's promising entry and any suspension the callee reaches --
    // `SuspendError: trying to suspend JS frames` (jspi pin (b), mechanics.ts
    // line 12). This is only coherent together with site 1 below blocking
    // rather than raising `NeedsJspi`, since a promising callee resolves on a
    // later turn by construction.
    // NOTE (M2 stackful round): this wrap is RIGHT for a callee that blocks and
    // Wrap ONLY a callee that can actually reach a suspension point.
    //
    // The wrap is required when the callee blocks: without its own `promising`
    // entry it would suspend inside whatever `Suspending` trampoline invoked
    // us, with our JS frame in between (`SuspendError: trying to suspend JS
    // frames`, jspi pin (b)). But `enterWasm` returns a Promise
    // unconditionally, so wrapping a callee that CANNOT block forces
    // asynchrony the ABI forbids: an eagerly-completing callee must report its
    // subtask RETURNED, and a wrapped one reports STARTED. That broke all six
    // `async-calls-sync-*` cases of cross-abi-calls.wast.
    //
    // There is no per-CALL discriminator -- the same call site serves both --
    // so the answer is per-callee, derived from whether the callee's core
    // instance imports any blocking trampoline (`Executor.suspendableFuncs`).
    const raw = yield* awaitCore(
      canBlock ? enterWasm(callee, mode) : callee,
      calleeArgs as CoreValue[],
      thread,
    );

    if (!calleeUsesAsyncAbi) {
      // Sync canonical options (definitions.py `canon_lift` line 2168, `if not
      // opts.async_`): the callee returns its results directly and resolves
      // before returning. Reached via `compile_async_to_sync_adapter`, which
      // passes flags without `START_FLAG_ASYNC_CALLEE`.
      task.return_(raw as CoreValue[]);
      if (postReturn !== null) {
        assert_(inst.mayLeave, "post-return with may_leave already false");
        inst.mayLeave = false;
        // NO local try/finally here, deliberately (#91, verified rather than
        // assumed). definitions.py `canon_lift` (lines 2170-2174) has the
        // same bare bracket: a trapping post-return skips `may_leave = True`
        // and, since `Store.lift`'s `leave_to` is also skipped, leaves the
        // instance poisoned — restoring `may_leave` locally would contradict
        // both. What this runtime additionally needs, because it supports
        // post-trap re-entry, is that no *live* instance is stranded with
        // `may_leave === false`; exec/boundary.ts `unwind` covers exactly
        // that: at the host boundary no lift or lower is in flight, so it
        // asserts that resting state for every instance outside the poisoned
        // entered set. This instance is either in that set (poisoned, left
        // as the trap left it) or restored there.
        callCore(postReturn, raw as CoreValue[]);
        inst.mayLeave = true;
        ctx.stats.postReturnsRun++;
      }
      task.exitImplicitThread(thread);
      return;
    }

    if (callback === null) {
      // Stackful async lift -- definitions.py `canon_lift` line 2178:
      //
      //     if not opts.callback:
      //       [] = call_and_trap_on_throw(callee, flat_args)
      //       task.exit_implicit_thread()
      //       return
      //
      // That is the whole path. The callee runs to completion on its own
      // stack, returning NO results and calling `task.return` itself; any
      // blocking happened *inside* it, through the canonical built-ins. Which
      // is exactly what the callee's own `promising` entry provides when it
      // can block -- the `awaitCore` above parks the CALLEE's thread, not the
      // caller's, so nothing here parks an async-lowered caller (the mistake
      // the cross-abi differential caught).
      normalizeCoreValues(raw, [], "stackful callee result");
      task.exitImplicitThread(thread);
      return;
    }
    const [packed] = normalizeCoreValues(raw, ["i32"], "callee result") as [
      number,
    ];
    yield* runCallbackLoop({
      name: "fact-callee",
      task,
      thread,
      inst,
      // The callback re-entry is the second of the three entries that can
      // reach a blocking built-in (jspi/bridge.ts's invariant) and gets the
      // same per-callee treatment as the initial entry above: a callee that
      // parks (WAIT) and then, on a later callback activation, reaches a
      // *synchronous* blocking built-in (wit-bindgen's `block_on` shape —
      // e.g. a composed iroh endpoint signing a CertificateVerify via
      // `waitable-set.wait` mid-handshake) suspends inside the plain
      // callback frame otherwise: `SuspendError` (jspi pin (c)). Caught by
      // the first composed consumer workload (wosh client), not by
      // cross-abi-calls.wast, whose callees only ever block via WAIT codes.
      callback: canBlock ? enterWasm(callback!, mode) : callback!,
      packed,
      stats: ctx.stats,
    });
    task.exitImplicitThread(thread);
  };

  return { task, body };
}

/** Take the outstanding preparation, or trap if the adapter skipped it. */
function takePrepared(ctx: FactCallContext, what: string): PreparedCall {
  const p = ctx.prepared.current;
  assert_(p !== null, `${what} without a preceding prepare-call`);
  ctx.prepared.current = null;
  return p!;
}

// ---------------------------------------------------------------------------
// sync-start-call
// ---------------------------------------------------------------------------

/**
 * A sync-lowered import calling an async-lifted export
 * (`compile_sync_to_async_adapter`, trampoline.rs:607). The caller's wasm frame
 * is blocked for the duration, so this must produce the results *now*.
 */
export function createSyncStartCall(
  decl: { callback: number | null },
  ctx: FactCallContext,
): CoreFn {
  return (callee?: unknown, _liftParamCount?: number) => {
    const prepared = takePrepared(ctx, "sync-start-call");
    assert_(typeof callee === "function", "sync-start-call: callee funcref");
    const callback = decl.callback === null
      ? null
      : ctx.callback(decl.callback);

    let callerResults: CoreValue[] | null = null;
    // The caller's frame is blocked for the whole call, so resolution
    // delivery = this intrinsic returning results: release lenders then
    // (the sync analogue of `Subtask.deliver_resolve`, definitions.py 904).
    // Inlined rather than reusing `SyncCallScope` to keep this module free
    // of a value-level import cycle with intrinsics/mod.ts.
    const lentHandles: { numLends: number }[] = [];
    const lenderScope = {
      addLender(h: { numLends: number }): void {
        h.numLends += 1;
        lentHandles.push(h);
      },
      releaseLenders(): void {
        for (const h of lentHandles) h.numLends -= 1;
        lentHandles.length = 0;
      },
    };
    const { task, body } = mkCalleeTask({
      prepared,
      callee: callee as CoreFn,
      callback,
      postReturn: null,
      ctx,
      // `sync-start-call` exists only for "sync-lowered import to async-lifted
      // export" (fact.rs:608), so the callee always uses the async ABI.
      calleeUsesAsyncAbi: true,
      mode: ctx.suspensionMode,
      canBlock: ctx.calleeCanBlock?.(callee) ?? false,
      onCallerResults: (r) => {
        // sync-start-call's callee always uses the async ABI (comment above),
        // but the *caller* side here is the sync `canon_lower` path: the
        // reference's on_resolve(None) case is reached only when a
        // cancellation was requested, and a sync-lowered subtask has no
        // handle and hence no cancel channel — so `r` can never be null here.
        assert_(r !== null, "sync-start-call: caller results missing");
        callerResults = r;
      },
      lenderScope,
    });

    // Reference `Store.lift`: the reentrance gate, with the *caller* as the
    // entering context (definitions.py `entering_set(caller)`).
    // A poisoned callee's refusal names the original trap (polyengine#145).
    {
      const refusal = entryRefusal(
        prepared.calleeInst,
        prepared.callerInst,
        "cannot enter component instance",
      );
      if (refusal !== null) trap(refusal);
    }
    prepared.calleeInst.enterFrom(prepared.callerInst);
    let ok = false;
    try {
      const thread = spawn(task, body);
      thread.resume();
      ok = true;
    } catch (e) {
      // A trap leaves the instance poisoned: `leave_to` is not reached
      // (definitions.py `Store.lift`, line 578). A *capability signal* does
      // not — see the `isCapabilitySignal` note in exec/boundary.ts.
      if (e instanceof NeedsJspi || e instanceof PendingCapability) {
        prepared.calleeInst.leaveTo(prepared.callerInst);
      } else {
        // Retire the poisoned CALLEE's stream/future ends (#66): this is a
        // bracket-break site like `Store.tick`'s, and the trap unwinds to a
        // hooked site that walks only the CALLER's chain — a composed
        // component's callee would otherwise strand its host peers.
        notifyInstancePoisoned(prepared.calleeInst, e);
      }
      // The lent handles are the CALLER's, and the caller is not poisoned by
      // either exit (contracts/intrinsics.md v0.2 amendment 2: this runtime
      // deliberately supports post-trap re-entry on the caller side, where
      // the reference kills the whole store, so the sync-call scopes it
      // skipped have to be unwound explicitly). Leaving `numLends` elevated
      // would make every later `lift_own`/`resource.drop` of those handles
      // trap "handle still lent out" (#91). Release is idempotent, and the
      // success path below is unchanged.
      lenderScope.releaseLenders();
      throw e;
    }
    if (ok) prepared.calleeInst.leaveTo(prepared.callerInst);

    if (callerResults === null) {
      // The callee did not resolve within its first activation. definitions.py
      // `canon_lower`'s sync path blocks here — `thread.wait_until(
      // subtask.resolved)` (line 2286) — suspending the *caller's* wasm frame
      // while the scheduler runs other threads. That is JSPI role 2 (docs/architecture.md
      // §6), and it is the first place a purely stackless runtime genuinely
      // cannot proceed.
      //
      // Note this is NOT the sync driving loop of `canon_lift`: that loop
      // drives the callee instance's own threads and is only correct when the
      // callee can finish without anything from the caller. Here the caller is
      // mid-frame and may be exactly what the callee is waiting for, so
      // pumping the callee alone would spin rather than make progress.
      // Note: the callee's thread stays parked in `store.waiting` when we bail
      // here. That is deliberate — unwinding it would run callee cleanup the
      // guest never asked for — but it does mean the store keeps a thread that
      // will never be resumed. Harmless today (the enclosing host call is
      // failing anyway, and the instance is not poisoned because no trap
      // escaped a task), and it disappears once JSPI lets this path actually
      // block instead of bailing.
      if (ctx.suspensionMode === "jspi") {
        // JSPI role 2 (docs/architecture.md §6): park the *caller's* wasm activation until
        // the callee resolves, exactly as definitions.py `canon_lower`'s sync
        // path does with `thread.wait_until(subtask.resolved)` (line 2286).
        // The scheduler keeps ticking the callee meanwhile; when it produces
        // results our `readyFunc` goes true and the engine resumes the caller.
        //
        // Not cancellable: a sync-lowered caller has no way to observe or
        // request cancellation mid-call -- the reference's wait here carries
        // no cancellation branch.
        // LENDER RELEASE ON EVERY SETTLE PATH (#102).
        //
        // Enumeration of how this `SuspensionPoint` can reach a terminal
        // state (jspi/bridge.ts `SuspensionPoint`), and whether `produce`
        // runs on each:
        //
        //  1. `resume(false)` -> `produce` returns the packed result.
        //     RUNS. This is the success path; release stays INSIDE `produce`,
        //     before the results are shaped, so its ordering relative to the
        //     produced value is unchanged by this fix.
        //  2. `resume(false)` -> `produce` throws (a trap computed at resume
        //     time). PARTIALLY RUNS. Release is `produce`'s first statement
        //     so it is already discharged here, but the `onSettled` backstop
        //     makes that independent of statement order.
        //  3. `resume(true)` — a CANCELLED resume. Unreachable by
        //     construction: this park is `cancellable: false` and
        //     `SuspensionPoint.resume` asserts `cancellable || !cancelled`
        //     (#93). Note the assert fires BEFORE `#done` is set, so such a
        //     call leaves the point still parked and never settles it — a
        //     scheduler bug, not a guest-reachable exit; there is no
        //     non-poisoning continuation to release into.
        //  4. `abandon(reason)` — store teardown / abandonment: fails the
        //     import's Promise WITHOUT calling `produce`. DOES NOT RUN. This
        //     is the #102 hole; `onSettled` covers it.
        //  5. Never settled at all (the store is dropped while this point
        //     sits in `store.waiting`, e.g. the caller's whole host call was
        //     abandoned). No JS runs, so nothing can release; the lent
        //     handles die with the store, which is the reference's own
        //     outcome. Out of scope for amendment 2 (no non-poisoning exit).
        //  6. Trap-poisoning of the parked instance: does not settle this
        //     point by itself — it reaches the guest either as (2) (a
        //     produce-time trap) or as (4) (teardown abandons the park), so
        //     it is covered by those two rows, not a third mechanism.
        //
        // `releaseLenders` is idempotent (#91), so the backstop is a no-op
        // whenever `produce` already ran.
        return blockCurrentActivation({
          store: prepared.callerInst.store,
          task: currentTask(),
          readyFunc: () => callerResults !== null,
          cancellable: false,
          produce: () => {
            lenderScope.releaseLenders();
            return shapeResults(callerResults as CoreValue[] | null);
          },
          onSettled: () => lenderScope.releaseLenders(),
        });
      }
      // A capability signal is expressly NON-poisoning (see above), so
      // stranding the caller's lenders here is strictly worse than on the
      // trap path: the caller is guaranteed to keep running (#91).
      lenderScope.releaseLenders();
      needsJspi(
        "sync-start-call whose async-lifted callee did not resolve in its " +
          "first activation (the caller's wasm frame must block)",
      );
    }
    lenderScope.releaseLenders();
    return shapeResults(callerResults as CoreValue[] | null);
  };
}

/**
 * Release a never-delivered subtask's lenders after a trap or capability bail
 * broke the `[async-start-call]` bracket (#91).
 *
 * Now a thin alias of `Subtask.unwindLenders` — the same unwind serves the
 * host-import parks (exec/boundary.ts, #106) — kept for the local name the
 * `[async-start-call]` comments reference.
 */
function unwindSubtaskLenders(subtask: Subtask): void {
  subtask.unwindLenders();
}

/** The core-ABI shape of a returned results vector (0 / 1 / many). */
function shapeResults(out: CoreValue[] | null): CoreValue | undefined {
  if (out === null || out.length === 0) return undefined;
  if (out.length === 1) return out[0];
  return out as unknown as CoreValue;
}

// ---------------------------------------------------------------------------
// async-start-call
// ---------------------------------------------------------------------------

/**
 * An async-lowered import calling any export (`compile_async_to_async_adapter`
 * / `compile_async_to_sync_adapter`). Returns the packed subtask status the
 * guest already knows how to interpret — the same
 * `state | (subtaski << 4)` encoding `canon_lower` produces
 * (definitions.py line 2308), so the caller's callback loop and waitable sets
 * work unchanged.
 */
export function createAsyncStartCall(
  decl: { callback: number | null; postReturn: number | null },
  ctx: FactCallContext,
): CoreFn {
  return (
    callee?: unknown,
    _paramCount?: number,
    _resultCount?: number,
    flags?: number,
  ) => {
    const prepared = takePrepared(ctx, "async-start-call");
    assert_(typeof callee === "function", "async-start-call: callee funcref");
    const callback = decl.callback === null
      ? null
      : ctx.callback(decl.callback);

    // The caller-side view of this call. Everything downstream — waitable
    // sets, `subtask.drop`, the SUBTASK event — is the machinery already built
    // for host-import subtasks in exec/boundary.ts.
    // Starts STARTING and becomes STARTED only when `[async-start]` runs (see
    // `onStarted`). A callee held at the backpressure gate is therefore
    // reported as STARTING, and the STARTED transition delivers its own event
    // if the guest has already been handed a subtask index.
    const subtask = new Subtask();

    let onProgress: () => void = () => {};

    const { task, body } = mkCalleeTask({
      prepared,
      callee: callee as CoreFn,
      callback,
      postReturn: decl.postReturn === null
        ? null
        : ctx.callback(decl.postReturn),
      ctx,
      // `compile_async_to_async_adapter` sets START_FLAG_ASYNC_CALLEE;
      // `compile_async_to_sync_adapter` passes 0 (trampoline.rs:508 and :764).
      calleeUsesAsyncAbi: ((flags ?? 0) & START_FLAG_ASYNC_CALLEE) !== 0,
      mode: ctx.suspensionMode,
      canBlock: ctx.calleeCanBlock?.(callee) ?? false,
      onStarted: () => {
        if (subtask.state === SubtaskState.STARTING) {
          subtask.state = SubtaskState.STARTED;
          // `onProgress` is a no-op until the guest has a handle for this
          // subtask, mirroring `canon_lower`'s `maybe_on_progress`
          // (definitions.py line 2296): a call that starts before
          // `async-start-call` returns reports STARTED in its packed result
          // instead, with no event.
          onProgress();
        }
      },
      onCallerResults: (r) => {
        // `[async-return]` already wrote the caller's results (through the
        // retptr the caller supplied), so there is nothing to carry here: the
        // guest learns of completion from the SUBTASK event.
        if (!subtask.resolved()) {
          subtask.resolve(
            r === null
              // definitions.py `canon_lower`'s `on_resolve` (line 2267): a
              // cancelled callee resolves CANCELLED_BEFORE_{STARTED,RETURNED}
              // depending on how far it got.
              ? (subtask.state === SubtaskState.STARTING
                ? SubtaskState.CANCELLED_BEFORE_STARTED
                : SubtaskState.CANCELLED_BEFORE_RETURNED)
              : SubtaskState.RETURNED,
            [],
          );
        }
        onProgress();
      },
      // Borrow lenders attach to the caller-side subtask, released by its
      // `deliverResolve` (definitions.py `Subtask.deliver_resolve`, line 904).
      lenderScope: subtask,
    });
    // Cross-component cancellation: `subtask.cancel` forwards to the callee
    // task's `request_cancellation` (definitions.py line 519), which delivers
    // TASK_CANCELLED to a cancellable block point — for a callback-ABI callee
    // that is its WAIT/YIELD, so the guest observes the cancellation and calls
    // `task.cancel`, resolving this subtask CANCELLED_BEFORE_RETURNED.
    subtask.onCancel = (callerInst) => task.requestCancellation(callerInst);
    subtask.calleeTask = task;

    // A poisoned callee's refusal names the original trap (polyengine#145).
    {
      const refusal = entryRefusal(
        prepared.calleeInst,
        prepared.callerInst,
        "cannot enter component instance",
      );
      if (refusal !== null) trap(refusal);
    }
    prepared.calleeInst.enterFrom(prepared.callerInst);
    let ok = false;
    let thread: Thread;
    try {
      thread = spawn(task, body);
      thread.resume();
      ok = true;
    } catch (e) {
      // See the sync form above and `isCapabilitySignal` in exec/boundary.ts.
      if (e instanceof NeedsJspi || e instanceof PendingCapability) {
        prepared.calleeInst.leaveTo(prepared.callerInst);
      } else {
        // Bracket-break site — retire the poisoned callee's ends (#66),
        // as in the sync form above.
        notifyInstancePoisoned(prepared.calleeInst, e);
      }
      // The subtask never reached `report()`, so it has no handle in the
      // caller's table and nothing will ever deliver its resolution — but it
      // holds `num_lends` on the caller's handles. Resolve it as cancelled
      // (the state the reference's `on_resolve(None)` would give a call that
      // never started/returned) and deliver, which is what releases the
      // lenders (definitions.py `Subtask.deliver_resolve`, line 902). See the
      // sync form above for why the caller must not be left holding them.
      unwindSubtaskLenders(subtask);
      throw e;
    }
    if (ok) prepared.calleeInst.leaveTo(prepared.callerInst);

    const report = (): CoreValue => {
      if (subtask.resolved()) {
        // Eager completion: no handle, no event (definitions.py line 2293).
        subtask.deliverResolve();
        traceCopy(`async-start-call -> RETURNED (eager)`);
        return SubtaskState.RETURNED;
      }
      const subtaski = prepared.callerInst.handles.add(subtask);
      onProgress = () => subtask.setSubtaskPendingEvent(subtaski);
      const packed = packSubtaskResult(subtask.state, subtaski);
      traceCopy(
        `async-start-call -> state=${subtask.state} i=${subtaski} ` +
          `packed=0x${(packed as number).toString(16)}`,
      );
      return packed;
    };

    // NO WAIT FOR RESOLUTION HERE, deliberately. An async-lowered caller must
    // not block on its callee's *completion* -- that is the entire point of
    // async lowering: it takes a subtask handle and learns of completion
    // through events. An earlier attempt (M2 "Fix 1") parked the caller here
    // until the callee resolved. It made cross-abi-calls agree in both modes,
    // and it broke the thing it had no business touching: the caller's
    // activation was now suspended, so the sync-lowered parked caller of
    // `handshake_test.ts` was never resumed and the run hung. Correct-looking,
    // semantically wrong.
    //
    // What jspi mode DOES need is a wait for **determinacy** (jspi pin (j),
    // `fastpath_hop_test.ts`): the engine defers a promising callee's
    // continuation to a microtask at EVERY Suspending call -- even one whose
    // value was available synchronously -- so a callee the reference would
    // run to completion inside this call (`canon_lift` drives the thread to
    // its first real block point before `canon_lower` returns) is still
    // mid-hop when `report()` runs. Reporting then is reporting a state the
    // reference can never observe: STARTED for a call that eagerly RETURNED
    // (big-interleaving's `call-import` scripts), or a missed synchronous
    // cancellation (its `subtask-cancel` scripts).
    //
    // "Determinate" is exactly one of:
    //   * the subtask resolved (task.return ran mid-activation), or
    //   * the callee's thread finished (results flow through the body), or
    //   * the callee genuinely parked on a scheduler condition -- its
    //     SuspensionPoint (or its body's own wait) sits in `store.waiting`.
    // A genuinely-blocking callee reaches its first real block point without
    // anything from the caller, so unlike Fix 1 this wait cannot deadlock:
    // it is the reference's atomic run-to-first-block, reconstructed across
    // the engine's microtask hops.
    //
    // THE DEFERRED ENTRY DECISION (issue #43; wasmtime's model — source
    // walkthrough distilled on the issue, exam kit archived at
    // 4f3351f:exams/wasmtime-exclusivity/). The determinacy wait above is
    // also where the initial *status* is decided, so it is where the
    // deferral lives.
    //
    // In wasmtime a guest->guest call queues the callee's `StartImplicit`
    // and the caller suspends until the first subtask status event
    // (concurrent.rs :3040-3160); the executor first drains the work queued
    // ahead of it, so a ready gate holder runs to invocation exit and
    // releases `do_not_enter` BEFORE the new call's readiness is evaluated
    // (:1497-1522). polyengine's callee thread is likewise already spawned and
    // parked at `enter_implicit_thread`'s gate wait at this point; what
    // changes here is only WHEN the caller reads `subtask.state`.
    //
    // Order-robust formulation (issue #43; a non-normative scheduler
    // policy — entry-status timing is not normative — chosen over wasmtime's
    // FIFO-dependent one so the seeded-shuffle reruns stay green): while the
    // callee is still parked at the entry gate, the caller waits until the
    // callee instance's runnable work is exhausted
    // (`Store.hasRunnableWork`). Then:
    //   * the holder was ready -> it ran to `exit_implicit_thread`, released
    //     the gate, the callee entered: `subtask.state` is STARTED (or the
    //     callee already RETURNED) -- test/async/sync-streams.wast:145;
    //   * the holder was NOT ready (parked mid-frame on an un-rendezvous'd
    //     operation), or the holder IS this caller (a nested lower, excluded
    //     from the scan): quiescence is immediate and the caller reports
    //     STARTING -- hold semantics, observably.
    //
    // Backpressure-queue admission is untouched: the callee registered in
    // `num_waiting_to_enter` synchronously at `thread.resume()` above,
    // before any draining, so the deterministic-profile ordering pins
    // (async-calls-sync.wast) see the same admission order as before.
    //
    // PLAIN MODE IS DELIBERATELY UNTOUCHED, and provably needs no drain: a
    // needs-exclusive task holds `exclusiveThread` only across a core
    // invocation (the callback loop releases it across every wait), and
    // without JSPI a wasm frame cannot park mid-invocation at all. So in
    // plain mode the gate, when held, is held by the *currently running*
    // activation -- the one obstacle a drain can never remove. Zero cost for
    // sync-only components, and no suspendability reclassification:
    // `async-start-call` was already `Suspending`-wrapped for the
    // determinacy park (exec/executor.ts, "async-start-call is wrapped").
    if (ctx.suspensionMode === "jspi") {
      const store = prepared.callerInst.store;
      const calleeInst = prepared.calleeInst;
      // The caller's task: excluded from the drain scan (it is the asker).
      // `maybeCurrentTask` rather than `currentTask` because a host-driven
      // entry can reach here with no ambient task at all.
      const callerTask = maybeCurrentTask();
      // STARTING + parked == parked at the entry gate: `[async-start]` runs
      // immediately after `enter_implicit_thread` succeeds, so any callee
      // that got past the gate has already left STARTING.
      const gatedAtEntry = (): boolean =>
        subtask.state === SubtaskState.STARTING &&
        !subtask.resolved() &&
        !thread.done() &&
        thread.waiting();
      const determinate = (): boolean =>
        gatedAtEntry()
          ? !store.hasRunnableWork(calleeInst, callerTask)
          : subtask.resolved() ||
            thread.done() ||
            store.waiting.some((w) => w.task === task);
      if (!determinate()) {
        // Same settle-path enumeration as the sync form above (#102). Here
        // the lender scope is the `Subtask` itself, discharged by
        // `deliverResolve`, and `report()` is what eventually delivers it —
        // either eagerly (the resolved branch) or, for a live subtask, via
        // the handle it hands the guest. So the backstop must fire ONLY when
        // `report()` did not complete: on the success path the subtask is
        // typically still live and in the caller's table, and unwinding it
        // there would cancel a perfectly good call.
        //
        // `report()` not completing means the guest never received the
        // subtask index (it either threw before `handles.add`, or after it
        // with the index lost), so nothing will ever deliver this subtask's
        // resolution — exactly the state `unwindSubtaskLenders` exists for
        // (contracts/intrinsics.md v0.2 amendment 2).
        let produced = false;
        return blockCurrentActivation({
          store: prepared.callerInst.store,
          task: currentTask(),
          readyFunc: determinate,
          cancellable: false,
          produce: () => {
            const r = report();
            produced = true;
            return r;
          },
          onSettled: () => {
            if (!produced) unwindSubtaskLenders(subtask);
          },
        });
      }
    }
    return report();
  };
}

/** Create a thread whose body needs a reference to the thread itself. */
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
