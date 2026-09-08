// Host trampolines and FACT-adapter intrinsics (contracts/intrinsics.md).
// Referenced unsupported kinds fail during instantiation; implemented blocking
// forms use the configured suspension discipline.

import {
  canonResourceDrop,
  canonResourceNew,
  canonResourceRep,
  trap,
} from "../cabi/mod.ts";
import { ResourceHandle } from "../cabi/handles.ts";
import { removeHandleWithUnwind } from "../task/scheduler.ts";
import { trapIf } from "../cabi/trap.ts";
import { assert_ } from "../cabi/trap.ts";
import type { ResourceTypeInfo } from "../cabi/types.ts";
import type { ComponentInstanceState } from "../task/mod.ts";
import {
  dbgId,
  entryRefusal,
  maybeCurrentTask,
  maybeCurrentThread,
} from "../task/mod.ts";
import type { WireTrampoline } from "../plan/format.ts";
import type { CoreFn, ExecutionStats } from "../exec/boundary.ts";
import { UnsupportedFeatureError } from "./errors.ts";
import {
  type AsyncTrampolineContext,
  createBackpressureDec,
  createBackpressureInc,
  createSubtaskCancel,
  createSubtaskDrop,
  createTaskCancel,
  createTaskReturn,
  createThreadYield,
  createWaitableJoin,
  createWaitableSetDrop,
  createWaitableSetNew,
  createWaitableSetPoll,
  createWaitableSetWait,
} from "./async_builtins.ts";
import {
  createAsyncStartCall,
  createPrepareCall,
  createSyncStartCall,
  type FactCallContext,
  type PreparedCall,
} from "./fact_calls.ts";
import {
  type AsyncTransferContext,
  createErrorContextDebugMessage,
  createErrorContextDrop,
  createErrorContextNew,
  createErrorContextTransfer,
  createFutureCancelRead,
  createFutureCancelWrite,
  createFutureDropReadable,
  createFutureDropWritable,
  createFutureNew,
  createFutureRead,
  createFutureTransfer,
  createFutureWrite,
  createStreamCancelRead,
  createStreamCancelWrite,
  createStreamDropReadable,
  createStreamDropWritable,
  createStreamNew,
  createStreamRead,
  createStreamTransfer,
  createStreamWrite,
  type StreamTrampolineContext,
} from "./stream_builtins.ts";
import {
  createTranscoder,
  TRANSCODE_OPS,
  type TranscodeMemory,
  type TranscodeOp,
} from "./transcode.ts";

export * from "./transcode.ts";
export * from "./context.ts";
export * from "./async_builtins.ts";
export * from "./fact_calls.ts";
export * from "./stream_builtins.ts";

/**
 * Where a host trap thrown *inside* a FACT adapter is remembered.
 *
 * FACT's `enter_exception_barrier` (`fact/trampoline.rs`) converts escaping
 * exceptions to `UncaughtException`. Host traps are JS exceptions too, so we
 * remember and restore them to preserve their cause across nested barriers.
 * A guest exception with no pending host trap keeps the generic message.
 *
 * Limitation: this preserves diagnostics, not uncatchability. A guest's own
 * `try_table catch_all` can catch a host trap and continue, contrary to the
 * Component Model's trap semantics. No out-of-band mechanism prevents that.
 */
export interface HostTrapState {
  pending: unknown;
}

/**
 * Trap-code → message, from wasmtime-environ `trap_encoding.rs`
 * (`generate_trap_type!`), whose ordinals are what FACT passes to the
 * `runtime.trap` import. Unlisted codes fall back to the numeric code.
 *
 * Rendered with wasmtime's `"wasm trap: "` prefix (its `impl Display for
 * Trap`), because that is the text the official suite's `assert_trap`
 * commands expect for adapter-raised traps (e.g. `values/realloc.wast`).
 */
const FACT_TRAP_MESSAGES: Record<number, string> = {
  9: "wasm `unreachable` instruction executed",
  17: "cannot enter component instance",
  23: "cannot leave component instance",
  24: "cannot block a synchronous task before returning",
  25: "invalid `char` bit pattern",
  30: "string content out-of-bounds",
  31: "list content out-of-bounds",
  32: "invalid variant discriminant",
  33: "unaligned pointer",
  46: "reference count overflow",
  49: "uncaught exception propagated out of component",
};

/** Ordinal of `Trap::UncaughtException` in wasmtime's trap encoding. */
const TRAP_UNCAUGHT_EXCEPTION = 49;

export { UnsupportedFeatureError } from "./errors.ts";

/** Diagnostic capability category for unsupported trampoline kinds. */
const TRAMPOLINE_CAPABILITY: Record<
  string,
  "core" | "resources" | "task-core"
> = {
  "lower-import": "core",
  "trap": "core",
  "enter-sync-call": "core",
  "exit-sync-call": "core",
  "resource-new": "resources",
  "resource-rep": "resources",
  "resource-drop": "resources",
  "transcoder": "resources",
  "resource-transfer-own": "resources",
  "resource-transfer-borrow": "resources",
};

function capabilityOf(kind: string): "core" | "resources" | "task-core" {
  return TRAMPOLINE_CAPABILITY[kind] ?? "task-core";
}

/**
 * The borrow bookkeeping of one in-flight synchronous cross-component call,
 * bracketed by the FACT adapter's `enter-sync-call` / `exit-sync-call`
 * imports (wasmtime-environ `fact/trampoline.rs`: enter is
 * emitted *before* argument translation and exit *after* the callee returns,
 * so every resource transfer for the call happens inside the bracket).
 *
 * It plays the role definitions.py gives the callee `Subtask`/`Task`:
 *
 *  - `lenders` — handles lent to the callee (`Subtask.lenders`); each
 *    `num_lends` is dropped again when the call returns, which is what makes
 *    a lender's own handle liftable again afterwards.
 *  - `numBorrows` — borrow handles lowered into the callee's table
 *    (`Task.num_borrows`); the callee must drop them all before returning
 *    (definitions.py `Task.return_`: `trap_if(self.num_borrows > 0)`).
 *
 * Structurally satisfies cabi's `TaskBorrowScope` and `SubtaskBorrowScope`.
 */
export class SyncCallScope {
  numBorrows = 0;
  readonly lenders: ResourceHandle[] = [];

  /**
   * definitions.py `Subtask.add_lender`: borrowed handles can be lent onward
   * too. `canon_resource_drop` checks `num_lends` for both own and borrow
   * handles, so the source remains undroppable until delivery releases it.
   */
  addLender(h: ResourceHandle): void {
    h.numLends += 1;
    this.lenders.push(h);
  }

  /** definitions.py `Subtask.deliver_resolve`: release lenders at delivery. */
  releaseLenders(): void {
    for (const h of this.lenders) h.numLends -= 1;
    this.lenders.length = 0;
  }
}

/**
 * The borrow bookkeeping of one FACT `[async-start]` argument-copy window —
 * the prepare/start protocol's analogue of `SyncCallScope`. Live only for
 * the synchronous `callCore(prepared.start, …)` call inside `mkCalleeTask`'s
 * `on_start` (the copy adapters cannot block, so the window never suspends).
 *
 * Reference mapping (definitions.py): `taskScope` is the callee `Task` —
 * `lower_borrow` counts `num_borrows` there, and
 * `Task.return_`/`cancel` trap while it is non-zero; `lenders` is the
 * caller-side `Subtask` (async-start-call) or a plain scope released when
 * the caller's blocked frame gets its results (sync-start-call) —
 * `lift_borrow` adds lenders there, released at `deliver_resolve`.
 */
export interface FactStartScope {
  /** The callee task (satisfies cabi's `TaskBorrowScope`). */
  taskScope: import("../cabi/context.ts").TaskBorrowScope;
  /** The caller-side lender registrar (satisfies `SubtaskBorrowScope`). */
  lenders: { addLender(h: ResourceHandle): void };
}

/** Executor services a trampoline body needs (provided by executor.ts). */
export interface TrampolineContext {
  componentInstance(index: number): ComponentInstanceState;
  resourceToken(index: number): ResourceTypeInfo;
  /**
   * The component instance that *owns* resource table `index`
   * (`TypeResourceTable::Concrete.instance`), i.e. whose handle table the
   * FACT transfer intrinsics move handles between. Throws for abstract
   * (type-only) tables, which have no runtime state.
   */
  resourceTableInstance(index: number): ComponentInstanceState;
  /**
   * A live view of runtime memory `index` (`RuntimeMemoryIndex`), for the
   * string-transcoder trampolines.
   */
  runtimeMemory(index: number): TranscodeMemory;
  /**
   * Stack of in-flight synchronous cross-component calls (innermost last),
   * owned by the executor so all trampolines of one instantiation share it.
   */
  syncCallStack: SyncCallScope[];
  /**
   * Stack of in-flight FACT `[async-start]` argument-copy windows (innermost
   * last; see `FactStartScope`). Separate from `syncCallStack` because the
   * prepare/start protocol has no enter/exit-sync-call bracket — the borrow
   * bookkeeping attaches to the callee `Task` and the caller-side subtask
   * instead (definitions.py `lower_borrow` / `lift_borrow`).
   */
  factStartScopes: FactStartScope[];
  /** See `FactCallContext.calleeCanBlock` (intrinsics/fact_calls.ts). */
  calleeCanBlock?(fn: unknown): boolean;
  /** See `HostTrapState`. */
  trapState: HostTrapState;
  /**
   * Resolved canonical options by index, and the element types of an interned
   * results tuple — needed by the async built-ins (task.return,
   * waitable-set.{wait,poll}). See `AsyncTrampolineContext`.
   */
  options(index: number): import("../exec/boundary.ts").ResolvedOptions;
  resultTypes(index: number): import("../cabi/types.ts").ValType[];
  /** `RuntimeCallbackIndex` -> the extracted callback core function. */
  callback(index: number): CoreFn;
  /** `RuntimeMemoryIndex` -> an identity token for `task.return` checks. */
  memoryToken(index: number): unknown;
  /** The single in-flight FACT preparation (see `PreparedCall`). */
  prepared: { current: PreparedCall | null };
  /** Suspension discipline (jspi/bridge.ts). */
  suspensionMode: import("../jspi/mod.ts").SuspensionMode;
  /** Element types of the plan's stream/future tables. */
  streamElem(index: number): import("../cabi/types.ts").ValType | null;
  futureElem(index: number): import("../cabi/types.ts").ValType | null;
  streamTableInstance(index: number): ComponentInstanceState;
  futureTableInstance(index: number): ComponentInstanceState;
  /**
   * The component instance owning error-context table `index`
   * (`TypeComponentLocalErrorContextTableIndex`, `errorContextTables`).
   * This index space is distinct from resource-table indices.
   */
  errorContextTableInstance(index: number): ComponentInstanceState;
  /**
   * Element types of the *raw* wasmtime `TypeTupleIndex` FACT's
   * `prepare-call` passes as `task_return_type`, or `null` when the plan
   * carries no mapping for it (see `LoadedPlan.resultTupleTypes`).
   */
  resultTypesForTuple(
    tupleIndex: number,
  ): import("../cabi/types.ts").ValType[] | null;
  /** Build the lowered-import body for `lowered` (LoweredIndex). */
  loweredImport(decl: {
    lowered: number;
    options: number;
    type: number;
  }): CoreFn;
  stats: ExecutionStats;
}

/** Shared field shape of resource-new/rep/drop declarations. */
interface ResourceTrampolineDecl {
  instance: number;
  resource: number;
}

/**
 * Create the JS function backing one plan trampoline. Called during
 * initializer/arg/export resolution — i.e. at instantiate time — so an
 * unsupported kind fails instantiation, not the first call
 * (plan-format.md "Executor obligations"). Unreferenced trampolines are
 * never created and therefore never fail.
 */
export function createTrampoline(
  decl: WireTrampoline,
  ctx: TrampolineContext,
): CoreFn {
  const fn = createTrampolineBody(decl, ctx);
  // Preserve host-trap diagnostics across the FACT exception barrier
  // (see `HostTrapState`). This wraps the `trap` trampoline too, which is
  // what keeps a specific trap specific across *nested* adapters: the inner
  // barrier's `trap` trampoline restores and rethrows the real trap, this
  // wrapper re-records it, and the outer barrier restores it again instead
  // of reporting the generic `UncaughtException`.
  return (...args: unknown[]) => {
    try {
      return fn(...args);
    } catch (e) {
      ctx.trapState.pending = e;
      throw e;
    }
  };
}

/** Narrow the trampoline context to what the stream built-ins need. */
function sctx(ctx: TrampolineContext): StreamTrampolineContext {
  return ctx as unknown as StreamTrampolineContext;
}

/** Static instance identity, available even to instantiation-time start functions. */
function declaredInstance(
  decl: WireTrampoline,
  ctx: TrampolineContext,
): ComponentInstanceState {
  const instance = (decl as unknown as { instance?: number }).instance;
  assert_(
    typeof instance === "number",
    `trampoline '${decl.kind}' has no declared component instance`,
  );
  return ctx.componentInstance(instance);
}

// deno-lint-ignore no-explicit-any
const SCOPE_TRACE = (() => {
  try {
    return Deno.env.get("CE_SCOPE_TRACE") === "1";
  } catch {
    return false;
  }
})();

/**
 * Brackets belong to the running thread because activations can interleave.
 * Instantiation-time start functions have no thread and use the executor stack.
 */
function syncScopes(ctx: TrampolineContext, site = "?"): any[] {
  const thread = maybeCurrentThread() as
    | { syncCallStack: any[] }
    | undefined;
  const scopes = thread?.syncCallStack ?? ctx.syncCallStack;
  if (SCOPE_TRACE) {
    console.error(
      `[scope] ${site} act=${
        thread ? dbgId(thread) : "NONE(->ctx fallback)"
      } ` +
        `depth=${scopes.length}`,
    );
  }
  return scopes;
}

function createTrampolineBody(
  decl: WireTrampoline,
  ctx: TrampolineContext,
): CoreFn {
  switch (decl.kind) {
    case "lower-import": {
      const d = decl as Extract<WireTrampoline, { kind: "lower-import" }>;
      return ctx.loweredImport(d);
    }

    case "trap": {
      // FACT `runtime.trap<N>` import: nullary, one per trap code — the code
      // is a static plan-visible field of the trampoline decl, not a call
      // argument (`fact/trampoline.rs` `fn trap` -> `import_trap(trap)`,
      // named `runtime.trap<N>`; contracts/plan-format.md "trap" trampoline).
      const code = (decl as Extract<WireTrampoline, { kind: "trap" }>).code;
      return () => {
        if (code === TRAP_UNCAUGHT_EXCEPTION) {
          const pending = ctx.trapState.pending;
          if (pending !== undefined) {
            // Deliberately *not* cleared: an enclosing adapter's barrier will
            // catch this rethrow and needs to restore the same trap. The slot
            // is reset per lifted-export call (exec/boundary.ts), which is
            // what bounds its lifetime.
            throw pending;
          }
        }
        const message = FACT_TRAP_MESSAGES[code];
        trap(
          message === undefined
            ? `FACT adapter trap (code ${code})`
            : `wasm trap: ${message}`,
        );
      };
    }

    // FACT sync-call borrow brackets (wasmtime-environ `fact.rs`):
    //   async.enter-sync-call(caller_instance: i32, async: i32,
    //                         callee_instance: i32) -> ()
    //   async.exit-sync-call() -> ()
    case "enter-sync-call":
      return (
        callerInstance?: number,
        async_?: number,
        calleeInstance?: number,
      ) => {
        // Reentrance is valid. `entryRefusal` enforces per-instance poisoning,
        // a runtime divergence, and reports the original trap.
        if (
          typeof callerInstance === "number" &&
          typeof calleeInstance === "number"
        ) {
          const callerInst = ctx.componentInstance(callerInstance >>> 0);
          const calleeInst = ctx.componentInstance(calleeInstance >>> 0);
          const refusal = entryRefusal(
            calleeInst,
            callerInst,
            "cannot enter component instance",
          );
          if (refusal !== null) trap(refusal);
        }
        // This bracket manages borrows regardless of the callee's asyncness;
        // the prepare/start protocol creates any separate callee task.
        void async_;
        ctx.stats.enterSyncCalls++;
        // Normal return must match enter/exit on the same activation's stack;
        // trap unwind releases any scopes whose exit was skipped.
        const scopes = syncScopes(ctx, "enter");
        scopes.push(new SyncCallScope());
      };
    case "exit-sync-call":
      return (..._args: unknown[]) => {
        ctx.stats.exitSyncCalls++;
        assert_(
          ctx.stats.exitSyncCalls <= ctx.stats.enterSyncCalls,
          "exit-sync-call without matching enter-sync-call",
        );
        const scope = syncScopes(ctx, "exit").pop();
        assert_(
          scope !== undefined,
          // If this fires, an `exit` reached an activation that never ran the
          // matching `enter`. See `Thread.syncCallStack`.
          "exit-sync-call with an empty sync-call stack",
        );
        // definitions.py `Task.return_`: the callee may not return while it
        // still holds borrow handles.
        trapIf(
          scope!.numBorrows > 0,
          "borrow handles still remain at the end of the call",
        );
        scope!.releaseLenders();
      };

    // Guest-side resource built-ins; reps and handle indices are i32.
    case "resource-new": {
      const d = decl as unknown as ResourceTrampolineDecl;
      const inst = ctx.componentInstance(d.instance);
      const rt = ctx.resourceToken(d.resource);
      return (rep: number) => canonResourceNew(inst, rt, rep >>> 0);
    }
    case "resource-rep": {
      const d = decl as unknown as ResourceTrampolineDecl;
      const inst = ctx.componentInstance(d.instance);
      const rt = ctx.resourceToken(d.resource);
      return (handle: number) => canonResourceRep(inst, rt, handle >>> 0);
    }
    case "resource-drop": {
      const d = decl as unknown as ResourceTrampolineDecl;
      const inst = ctx.componentInstance(d.instance);
      const rt = ctx.resourceToken(d.resource);
      return (handle: number) => {
        canonResourceDrop(inst, rt, handle >>> 0);
      };
    }

    // FACT string transcoders (contracts/intrinsics.md §B). The plan
    // carries the op name plus the source/destination `RuntimeMemoryIndex`es;
    // `./transcode.ts` holds the twelve operations.
    case "transcoder": {
      const d = decl as unknown as {
        op: string;
        from: number;
        from64: boolean;
        to: number;
        to64: boolean;
      };
      if (d.from64 || d.to64) {
        // 64-bit linear memories are out of scope (https://github.com/polymorph-components/polyengine/issues/12); refusing at
        // instantiate time keeps "instantiate-time, never call-time".
        throw new UnsupportedFeatureError(
          "task-core",
          `transcoder '${d.op}' over a 64-bit linear memory`,
        );
      }
      if (!(TRANSCODE_OPS as readonly string[]).includes(d.op)) {
        throw new UnsupportedFeatureError(
          "task-core",
          `unknown string transcode operation '${d.op}'`,
        );
      }
      return createTranscoder(
        d.op as TranscodeOp,
        ctx.runtimeMemory(d.from),
        ctx.runtimeMemory(d.to),
      ) as CoreFn;
    }

    // --- 0.3 async built-ins (contracts/intrinsics.md §B) -------------
    // Blocking forms require JSPI when they cannot complete immediately.
    case "task-return":
      return createTaskReturn(
        decl as unknown as {
          results: number;
          resultType: number | null;
          options: number;
        },
        ctx as AsyncTrampolineContext,
      );
    case "task-cancel":
      return createTaskCancel();
    case "backpressure-inc":
      return createBackpressureInc(declaredInstance(decl, ctx));
    case "backpressure-dec":
      return createBackpressureDec(declaredInstance(decl, ctx));
    case "waitable-set-new":
      return createWaitableSetNew(declaredInstance(decl, ctx));
    case "waitable-set-wait":
      return createWaitableSetWait(
        decl as unknown as { options: number },
        ctx as AsyncTrampolineContext,
        declaredInstance(decl, ctx),
        ctx.suspensionMode,
      );
    case "waitable-set-poll":
      return createWaitableSetPoll(
        decl as unknown as { options: number },
        ctx as AsyncTrampolineContext,
        declaredInstance(decl, ctx),
      );
    case "waitable-set-drop":
      return createWaitableSetDrop(declaredInstance(decl, ctx));
    case "waitable-join":
      return createWaitableJoin(declaredInstance(decl, ctx));
    case "subtask-drop":
      return createSubtaskDrop(declaredInstance(decl, ctx));
    case "subtask-cancel":
      return createSubtaskCancel(
        decl as unknown as { async?: boolean },
        declaredInstance(decl, ctx),
        ctx.suspensionMode,
      );
    case "thread-yield":
      return createThreadYield(
        decl as unknown as { cancellable?: boolean },
        ctx.suspensionMode,
      );

    // --- FACT cross-component calls (see ./fact_calls.ts) -----------------
    case "prepare-call":
      return createPrepareCall(
        decl as unknown as { memory: number | null },
        ctx as unknown as FactCallContext,
      );
    case "sync-start-call":
      return createSyncStartCall(
        decl as unknown as { callback: number | null },
        ctx as unknown as FactCallContext,
      );
    case "async-start-call":
      return createAsyncStartCall(
        decl as unknown as {
          callback: number | null;
          postReturn: number | null;
        },
        ctx as unknown as FactCallContext,
      );

    // --- stream / future / error-context (see ./stream_builtins.ts) -------
    case "stream-new":
      return createStreamNew(
        decl as unknown as { streamTable: number },
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "future-new":
      return createFutureNew(
        decl as unknown as { futureTable: number },
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "stream-read":
      return createStreamRead(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "stream-write":
      return createStreamWrite(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "future-read":
      return createFutureRead(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "future-write":
      return createFutureWrite(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "stream-cancel-read":
      return createStreamCancelRead(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "stream-cancel-write":
      return createStreamCancelWrite(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "future-cancel-read":
      return createFutureCancelRead(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "future-cancel-write":
      return createFutureCancelWrite(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "stream-drop-readable":
      return createStreamDropReadable(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "stream-drop-writable":
      return createStreamDropWritable(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "future-drop-readable":
      return createFutureDropReadable(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "future-drop-writable":
      return createFutureDropWritable(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "error-context-new":
      return createErrorContextNew(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "error-context-debug-message":
      return createErrorContextDebugMessage(
        decl as never,
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "error-context-drop":
      return createErrorContextDrop(declaredInstance(decl, ctx));
    case "stream-transfer":
      return createStreamTransfer(ctx as unknown as AsyncTransferContext);
    case "future-transfer":
      return createFutureTransfer(ctx as unknown as AsyncTransferContext);
    case "error-context-transfer":
      return createErrorContextTransfer(
        ctx as unknown as AsyncTransferContext,
        // Table arguments are `TypeComponentLocalErrorContextTableIndex`es,
        // not resource-table indices.
        (t) => ctx.errorContextTableInstance(t),
      );

    case "resource-transfer-own":
      return (handle: number, srcTable: number, dstTable: number) =>
        transferOwn(ctx, handle >>> 0, srcTable, dstTable);
    case "resource-transfer-borrow":
      return (handle: number, srcTable: number, dstTable: number) =>
        transferBorrow(ctx, handle >>> 0, srcTable, dstTable);

    default:
      throw new UnsupportedFeatureError(
        capabilityOf(decl.kind) === "resources" ? "resources" : "task-core",
        `component requires host trampoline '${decl.kind}'`,
      );
  }
}

// ---------------------------------------------------------------------------
// Resource transfer (FACT `resource.transfer-own` / `transfer-borrow`)
// ---------------------------------------------------------------------------

/**
 * `lift_own` out of the source table followed by `lower_own` into the
 * destination table (definitions.py `lift_own` / `lower_own`): the source
 * handle is *removed* (ownership moves), must be owning, and must not be
 * lent out.
 */
function transferOwn(
  ctx: TrampolineContext,
  handle: number,
  srcTable: number,
  dstTable: number,
): number {
  const src = ctx.resourceTableInstance(srcTable);
  const dst = ctx.resourceTableInstance(dstTable);
  const srcRt = ctx.resourceToken(srcTable);
  const dstRt = ctx.resourceToken(dstTable);

  return removeHandleWithUnwind(src, handle, (h) => {
    trapIf(
      !(h instanceof ResourceHandle),
      "transfer-own: not a resource handle",
    );
    const rh = h as ResourceHandle;
    trapIf(rh.rt !== srcRt, "transfer-own: resource type mismatch");
    // definitions.py `lift_own`: `trap_if(h.num_lends != 0)`.
    trapIf(
      rh.numLends !== 0,
      "cannot remove owned resource while borrowed (handle still lent out)",
    );
    trapIf(!rh.own, "transfer-own: expected an owning handle");
    return dst.handles.add(new ResourceHandle(dstRt, rh.rep, true));
  });
}

/**
 * `lift_borrow` from the source table followed by `lower_borrow` into the
 * destination table. The source handle stays in place. The implementing
 * instance receives the rep directly; other destinations get a non-owning
 * handle. Lenders and borrow counts attach to the FACT start window or sync
 * bracket that represents the reference's Subtask/Task for this call.
 */
function transferBorrow(
  ctx: TrampolineContext,
  handle: number,
  srcTable: number,
  dstTable: number,
): number {
  const src = ctx.resourceTableInstance(srcTable);
  const dst = ctx.resourceTableInstance(dstTable);
  const srcRt = ctx.resourceToken(srcTable);
  const dstRt = ctx.resourceToken(dstTable);

  // Innermost-scope resolution. A FACT `[async-start]` copy window is
  // strictly synchronous and innermost when present (the copy adapters
  // cannot make nested calls), so it wins over any enclosing sync bracket.
  const fact = ctx.factStartScopes[ctx.factStartScopes.length - 1];
  const stack = syncScopes(ctx);
  const scope = stack[stack.length - 1];
  assert_(
    fact !== undefined || scope !== undefined,
    "transfer-borrow outside an enter-sync-call/exit-sync-call bracket " +
      "or FACT start window",
  );

  const h = src.handles.get(handle);
  trapIf(
    !(h instanceof ResourceHandle),
    "transfer-borrow: not a resource handle",
  );
  const rh = h as ResourceHandle;
  trapIf(rh.rt !== srcRt, "transfer-borrow: resource type mismatch");
  // definitions.py `lift_borrow`: the source handle becomes a lender of the
  // callee's activation, which is what makes lifting it as an `own` trap for
  // the duration of the call.
  (fact?.lenders ?? scope!).addLender(rh);
  // definitions.py `lower_borrow`: `if inst is t.rt.impl: return rep` — a
  // component that implements the resource is handed the rep directly and
  // gets no handle (and therefore no `num_borrows` obligation).
  if (dstRt.impl !== null && (dstRt.impl as unknown) === dst) return rh.rep;
  const borrowScope = fact !== undefined ? fact.taskScope : scope!;
  borrowScope.numBorrows += 1;
  return dst.handles.add(new ResourceHandle(dstRt, rh.rep, false, borrowScope));
}
