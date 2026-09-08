// FACT cross-component call intrinsics: `prepare-call`, `sync-start-call` and
// `async-start-call` (contracts/intrinsics.md §A).
//
// These are how one component calls another's *async-lifted* export, or how an
// async-lowered import reaches any export. They have no direct analogue in
// definitions.py, because the reference has no fused adapters: there,
// `canon_lower` calls the callee's `FuncInst` directly and the host performs
// every copy. wasmtime instead compiles a FACT adapter that hoists the copying
// into wasm and asks the host to do the task bookkeeping. JSPI timing and
// instance-poisoning differences are documented at the relevant sites below.
//
// ===========================================================================
// THE PROTOCOL (wasmtime-environ FACT)
// ===========================================================================
//
// Emission sites: `fact/trampoline.rs` `call_prepare` and the
// `compile_*_to_*_adapter` functions. Signatures: `fact.rs`
// `import_prepare_call`, `import_sync_start_call`, `import_async_start_call`.
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
// The `start` / `return` funcrefs implement the reference's `on_start` /
// `on_resolve` copying (`fact/signature.rs`):
//
//   `[async-start]` (async_start_signature)
//       params  = the *caller's* flattened params  (what prepare-call stashed)
//       results = the *callee's* flattened params  (hand straight to the callee)
//     i.e. "given the caller's arguments, produce the callee's" — `on_start`.
//
//   `[async-return]` (async_return_signature)
//       params  = the *callee's* flattened results (+ a retptr when the caller
//                 is async-with-results, or when the caller's results spill)
//       results = the *caller's* flattened results (empty if async/spilled)
//     i.e. "given the callee's results, produce the caller's" — `on_resolve`.
//
// So the host never inspects a value: it calls `start` to get the callee's
// arguments, and calls `return` with whatever the callee produced. This is why
// a FACT task's payload is flat core values (`Task.factPassthrough`).
//
// `prepare-call` must not run the callee: parameters remain stashed until
// `Task.enterImplicitThread` admits it past backpressure and exclusivity.
// Reentrance is valid; `entryRefusal` checks only runtime instance poisoning.

import { assert_, trap } from "../cabi/trap.ts";
import { MAX_FLAT_RESULTS } from "../cabi/mod.ts";
import type { CoreValue, FuncType, ValType } from "../cabi/types.ts";
import {
  type BlockRequest,
  type Cancelled,
  ComponentInstanceState,
  currentTask,
  entryRefusal,
  maybeCurrentTask,
  NeedsJspi,
  needsJspi,
  notifyInstancePoisoned,
  packSubtaskResult,
  PendingCapability,
  Subtask,
  SubtaskState,
  Task,
  type TaskOptions,
  Thread,
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

/** `PREPARE_ASYNC_NO_RESULT` (wasmtime-environ `component.rs`). */
const PREPARE_ASYNC_NO_RESULT = 0xffff_ffff;
/** `PREPARE_ASYNC_WITH_RESULT` (`component.rs`). */
const PREPARE_ASYNC_WITH_RESULT = 0xffff_fffe;
/** `START_FLAG_ASYNC_CALLEE` (`component.rs`). */
export const START_FLAG_ASYNC_CALLEE = 1;

/** Number of fixed leading parameters of `prepare-call` (`fact.rs`). */
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
   * `result_count_or_max_if_async` as wasmtime's `ResultInfo`:
   *
   *   * async caller **with** a result -> `Heap`, retptr = last param
   *   * async caller without a result  -> `Stack`
   *   * sync caller whose results spill (`result_count > MAX_FLAT_RESULTS`)
   *                                    -> `Heap`, retptr = last param
   *   * sync caller otherwise          -> `Stack`
   *
   * In the `Heap` case the retptr must be **appended** to the
   * `[async-return]` arguments: it is the last
   * parameter of `async_return_signature` (`fact/signature.rs`), not
   * something the callee produced.
   */
  resultInfo: { kind: "heap"; retptr: CoreValue } | { kind: "stack" };
  /** True when the caller used the async ABI *and* has a result. */
  asyncCallerWithResult: boolean;
  /**
   * The adapter's lift memory, as named by `prepare-call`. It does not
   * reliably identify the callee's `task.return` memory; see the skipped
   * FACT memory check in `async_builtins.ts`.
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
   * passes as `task_return_type`), or `null` if the plan maps none;
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
   * with no suspension point between them, so two
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
    // Canonical ABI asyncness is distinct from `prepared.calleeAsync` (the
    // function type). An async-typed function can use the sync lift ABI;
    // `canon_lift` selects result handling from its canonical options.
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
    const [
      start,
      return_,
      callerI,
      calleeI,
      taskReturnType,
      calleeAsync,
      enc,
      rc_,
    ] = args;
    assert_(
      typeof start === "function" && typeof return_ === "function",
      "prepare-call: start/return must be funcrefs",
    );
    assert_(
      ctx.prepared.current === null,
      "prepare-call with a preparation already outstanding",
    );
    const params = args.slice(PREPARE_FIXED) as CoreValue[];
    const rc = Number(rc_) >>> 0;
    // Decode the caller's result location before the copy adapter runs.
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
   * started, not when the call was prepared. Under backpressure
   * `enter_implicit_thread` blocks
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
   * `[async-start]` (definitions.py `lift_borrow` adds lenders to
   * the caller's Subtask). async-start-call passes its `Subtask` (whose
   * `deliverResolve` releases them); sync-start-call passes a scope it
   * releases when the blocked caller frame gets its results.
   */
  lenderScope: {
    addLender(h: import("../cabi/handles.ts").ResourceHandle): void;
  };
}): {
  task: Task;
  body: (t: Thread) => Generator<BlockRequest, void, Cancelled>;
} {
  const { prepared, callee, callback, postReturn, ctx, calleeUsesAsyncAbi } =
    input;
  // Absent suspension information must not force a promising entry.
  const mode = input.mode ?? "plain";
  const canBlock = input.canBlock ?? false;
  const memory = prepared.memory;
  const inst = prepared.calleeInst;

  // `task_return_type` is a raw wasmtime `TypeTupleIndex`, not a `plan.types`
  // index. The loader maps it through task-return declarations. A missing
  // mapping leaves placeholder results and disables the result-type check;
  // an empty tuple with a mapping is a known, checkable type.
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
    // into the callee's flat params (`async_start_signature`).
    //
    // An async caller that has a result passes its retptr as the *last* flat
    // parameter; `[async-start]` does not declare it, so it is chopped off
    // here. Sync callers forward everything directly.
    () => {
      // Open the FACT borrow window for the duration of the copy adapter:
      // `[async-start]` is where argument resource transfers run, and it
      // cannot block, so push/pop brackets a
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
    // results into the caller's (`async_return_signature`).
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
      // pointer as a trailing argument, not a callee-produced result.
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
    // `awaitCore` carries the thread ambient across resumption, including
    // its FACT borrow brackets. A suspendable callee also needs its own
    // promising entry so this JS frame is not on the suspended wasm stack.
    // Do not wrap non-blocking callees: promising forces a microtask hop and
    // would turn eager RETURNED status into STARTED. Classification comes
    // from `Executor.suspendableFuncs`, not from function-type asyncness.
    const raw = yield* awaitCore(
      canBlock ? enterWasm(callee, mode) : callee,
      calleeArgs as CoreValue[],
      thread,
    );

    if (!calleeUsesAsyncAbi) {
      // Sync canonical options (definitions.py `canon_lift`): the callee
      // returns its results directly and resolves
      // before returning. Reached via `compile_async_to_sync_adapter`, which
      // passes flags without `START_FLAG_ASYNC_CALLEE`.
      task.return_(raw as CoreValue[]);
      if (postReturn !== null) {
        assert_(inst.mayLeave, "post-return with may_leave already false");
        inst.mayLeave = false;
        // No local finally: a trap skips the reference's restore. Host-boundary
        // unwind may restore sibling flags; see createLiftedFunction's
        // entry-identity rule in exec/boundary.ts.
        callCore(postReturn, raw as CoreValue[]);
        inst.mayLeave = true;
        ctx.stats.postReturnsRun++;
      }
      task.exitImplicitThread(thread);
      return;
    }

    if (callback === null) {
      // Stackful async lift: results arrive through `task.return`, not the
      // core return. `awaitCore` parks the callee's thread, never the
      // async-lowered caller's frame waiting for completion.
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
      // Callback-ABI code can also call synchronous blocking built-ins;
      // apply the same suspension classification on callback re-entry.
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
 * (`compile_sync_to_async_adapter`). The caller's wasm frame cannot continue
 * until this intrinsic delivers its results.
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
    // (the sync analogue of definitions.py `Subtask.deliver_resolve`).
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
      // export", so the callee always uses the async ABI.
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

    // Refuse a poisoned callee, not reentrance into a live one.
    {
      const refusal = entryRefusal(
        prepared.calleeInst,
        prepared.callerInst,
        "cannot enter component instance",
      );
      if (refusal !== null) trap(refusal);
    }
    try {
      const thread = spawn(task, body);
      thread.resume();
    } catch (e) {
      // A trap poisons the callee instance. A *capability signal* does not —
      // see the `isCapabilitySignal` note in exec/boundary.ts.
      if (!(e instanceof NeedsJspi) && !(e instanceof PendingCapability)) {
        // Retire the poisoned callee's stream/future ends: the trap
        // unwinds to a hooked site that walks only the CALLER's chain — a
        // composed component's callee would otherwise strand its host peers.
        notifyInstancePoisoned(prepared.calleeInst, e);
      }
      // Release the caller's lenders on failure too: surviving callers must
      // not retain a borrow obligation from a call that can no longer deliver.
      lenderScope.releaseLenders();
      throw e;
    }

    if (callerResults === null) {
      // The sync `canon_lower` wait suspends the caller while the scheduler
      // runs other threads. Do not substitute a callee-only driving loop:
      // progress may depend on work in the caller's instance.
      if (ctx.suspensionMode === "jspi") {
        // The reference's sync wait is non-cancellable. Release lenders
        // before returning results; the idempotent onSettled backstop also
        // covers abandonment, which never invokes produce.
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
      // Capability failure is non-poisoning, but still ends this lender scope.
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
 * broke the `[async-start-call]` bracket.
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
 * (definitions.py `canon_lower`), so the caller's callback loop and waitable sets
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
      // `compile_async_to_sync_adapter` passes 0.
      calleeUsesAsyncAbi: ((flags ?? 0) & START_FLAG_ASYNC_CALLEE) !== 0,
      mode: ctx.suspensionMode,
      canBlock: ctx.calleeCanBlock?.(callee) ?? false,
      onStarted: () => {
        if (subtask.state === SubtaskState.STARTING) {
          subtask.state = SubtaskState.STARTED;
          // `onProgress` is a no-op until the guest has a handle for this
          // subtask, mirroring `canon_lower`'s `maybe_on_progress`
          // in definitions.py: a call that starts before
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
              // definitions.py `canon_lower`'s `on_resolve`: a
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
      // `deliverResolve` (definitions.py `Subtask.deliver_resolve`).
      lenderScope: subtask,
    });
    // Cross-component cancellation: `subtask.cancel` forwards to the callee
    // task's `request_cancellation`, which delivers
    // TASK_CANCELLED to a cancellable block point — for a callback-ABI callee
    // that is its WAIT/YIELD, so the guest observes the cancellation and calls
    // `task.cancel`, resolving this subtask CANCELLED_BEFORE_RETURNED.
    subtask.onCancel = (callerInst) => task.requestCancellation(callerInst);
    subtask.calleeTask = task;

    // A poisoned callee's refusal names the original trap.
    {
      const refusal = entryRefusal(
        prepared.calleeInst,
        prepared.callerInst,
        "cannot enter component instance",
      );
      if (refusal !== null) trap(refusal);
    }
    let thread: Thread;
    try {
      thread = spawn(task, body);
      thread.resume();
    } catch (e) {
      // See the sync form above and `isCapabilitySignal` in exec/boundary.ts.
      if (!(e instanceof NeedsJspi) && !(e instanceof PendingCapability)) {
        // Retire the poisoned callee's ends, as in the sync form above.
        notifyInstancePoisoned(prepared.calleeInst, e);
      }
      // The subtask never reached `report()`, so it has no handle in the
      // caller's table and nothing will deliver its resolution. Unwind its
      // lenders explicitly so surviving callers can use their handles again.
      unwindSubtaskLenders(subtask);
      throw e;
    }

    const report = (): CoreValue => {
      if (subtask.resolved()) {
        // Eager completion: no handle, no event (`canon_lower`).
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

    // Wait for a reportable state, not for completion: an async-lowered caller
    // must receive a handle when its callee genuinely blocks. JSPI defers even
    // an immediately satisfied Suspending call to a microtask, so reporting
    // mid-hop could mislabel eager completion as STARTED (jspi pin (j)).
    //
    // Outside the entry gate, resolution, thread completion, or a genuine
    // scheduler park makes the state determinate. At the entry gate we first
    // drain the callee instance's runnable work, excluding the caller task:
    // a runnable holder may release the gate; a blocked holder or this caller
    // cannot. This entry-status timing is scheduler policy, not a spec rule.
    // Queue admission already happened synchronously in thread.resume().
    //
    // Plain mode needs no drain: a wasm frame cannot park mid-invocation,
    // so any held gate belongs to the currently executing activation.
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
        // Unwind only if report() fails or the park is abandoned. A successful
        // report may hand the guest a live subtask; its lenders must remain
        // registered until the guest observes resolution.
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
