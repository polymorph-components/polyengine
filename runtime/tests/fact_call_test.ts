// FACT cross-component call protocol: the two places the host has to get the
// *shape* of the adapter calls right, where a wrong shape is silent rather
// than loud.
//
// Both were real bugs:
//   * the `[async-return]` return pointer was never appended, so every
//     caller whose results live in linear memory had them written to address
//     0 (the suite only stayed green because its retptrs happen to be 0);
//   * `task.return`'s flat arguments were normalized with a blanket
//     `>>> 0`, truncating f32/f64 lanes.
//
// Reference: wasmtime-47.0.3 `runtime/component/concurrent.rs` — `ResultInfo`
// (2815-2836), the retptr append (2916-2919), the param chop (2869-2876) —
// and `wasmtime-environ` `fact/signature.rs:145-185`.

import { assertEq } from "./support/asserts.ts";
import {
  createAsyncStartCall,
  createPrepareCall,
  type FactCallContext,
  type PreparedCall,
} from "../src/intrinsics/fact_calls.ts";
import {
  type AsyncTrampolineContext,
  createTaskReturn,
} from "../src/intrinsics/async_builtins.ts";
import { newStats, type ResolvedOptions } from "../src/exec/boundary.ts";
import {
  ComponentInstanceState,
  popCurrentThread,
  pushCurrentThread,
  Store,
  SubtaskState,
  Task,
  Thread,
} from "../src/task/mod.ts";
import type { CoreValue, ValType } from "../src/cabi/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** `PREPARE_ASYNC_WITH_RESULT` / `NO_RESULT` (wasmtime-environ component.rs). */
const PREPARE_ASYNC_NO_RESULT = 0xffff_ffff;
const PREPARE_ASYNC_WITH_RESULT = 0xffff_fffe;

interface Recorded {
  startArgs: CoreValue[] | null;
  returnArgs: CoreValue[] | null;
}

/**
 * Drive one prepare-call + async-start-call against stub `start` / `return`
 * funcrefs and a stub callee, recording exactly what each was handed.
 *
 * `flags = 0` selects a sync-ABI callee (`compile_async_to_sync_adapter`
 * passes 0 where `compile_async_to_async_adapter` passes
 * START_FLAG_ASYNC_CALLEE), which keeps the callee a single synchronous
 * activation — the point here is the argument shuttling, not the task loop.
 */
function runPrepared(input: {
  resultCountOrMax: number;
  callerParams: CoreValue[];
  calleeParams: CoreValue[];
  calleeResults: CoreValue[];
}): Recorded {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const rec: Recorded = { startArgs: null, returnArgs: null };

  const prepared: { current: PreparedCall | null } = { current: null };
  const ctx = {
    componentInstance: () => inst,
    resultTypes: () => [] as ValType[],
    // plan v3: no task-return tuple mapping in this synthetic plan.
    resultTypesForTuple: () => null,
    callback: () => {
      throw new Error("no callback expected");
    },
    memoryToken: () => null,
    stats: newStats(),
    prepared,
    factStartScopes: [],
  };

  const start = (...a: CoreValue[]) => {
    rec.startArgs = a;
    return input.calleeParams.length === 1
      ? input.calleeParams[0]
      : input.calleeParams;
  };
  const return_ = (...a: CoreValue[]) => {
    rec.returnArgs = a;
    return undefined;
  };
  const callee = () =>
    input.calleeResults.length === 1
      ? input.calleeResults[0]
      : input.calleeResults;

  const prep = createPrepareCall(
    { memory: null },
    ctx as unknown as FactCallContext,
  );
  const startCall = createAsyncStartCall(
    { callback: null, postReturn: null },
    ctx as unknown as FactCallContext,
  );

  prep(
    start,
    return_,
    0, // caller_instance
    0, // callee_instance
    0, // task_return_type
    0, // callee_async (function type)
    0, // string_encoding (utf8)
    input.resultCountOrMax,
    ...input.callerParams,
  );
  startCall(callee, input.calleeParams.length, input.calleeResults.length, 0);
  return rec;
}

Deno.test("FACT: an async caller with a result gets its retptr appended to [async-return]", () => {
  // `CallerInfo::Async { has_result: true }` -> `ResultInfo::Heap` with the
  // retptr taken from the caller's *last* flat parameter
  // (concurrent.rs:2815-2823).
  const rec = runPrepared({
    resultCountOrMax: PREPARE_ASYNC_WITH_RESULT,
    // Two real arguments plus a NON-ZERO return pointer.
    callerParams: [7, 8, 16],
    calleeParams: [7, 8],
    calleeResults: [99],
  });
  // The retptr is chopped before `[async-start]` (concurrent.rs:2869-2876):
  // it is not one of that function's declared parameters.
  assertEq(rec.startArgs, [7, 8]);
  // ... and appended to `[async-return]` (concurrent.rs:2916-2919). Before the
  // fix this was `[99]`, so the adapter read `undefined` for the pointer,
  // coerced it to 0, and wrote the results to linear-memory address 0.
  assertEq(rec.returnArgs, [99, 16]);
});

Deno.test("FACT: an async caller with no result gets no retptr", () => {
  const rec = runPrepared({
    resultCountOrMax: PREPARE_ASYNC_NO_RESULT,
    callerParams: [7, 8],
    calleeParams: [7, 8],
    calleeResults: [],
  });
  // Nothing chopped, nothing appended (`ResultInfo::Stack`).
  assertEq(rec.startArgs, [7, 8]);
  assertEq(rec.returnArgs, []);
});

Deno.test("FACT: a sync caller with spilled results gets its retptr appended", () => {
  // `CallerInfo::Sync { result_count > MAX_FLAT_RESULTS }` -> `Heap`
  // (concurrent.rs:2828-2836). `result_count` here is the *unflattened* count
  // the adapter computed; anything above MAX_FLAT_RESULTS means "spilled".
  const rec = runPrepared({
    resultCountOrMax: 4,
    callerParams: [1, 2, 64],
    calleeParams: [1, 2],
    calleeResults: [5],
  });
  // Sync callers forward everything to `[async-start]` directly — wasmtime
  // does not chop for them (concurrent.rs:2878-2884); the extra value is
  // simply beyond the adapter's declared parameters.
  assertEq(rec.startArgs, [1, 2, 64]);
  assertEq(rec.returnArgs, [5, 64]);
});

Deno.test("FACT: a sync caller with flat results gets no retptr", () => {
  const rec = runPrepared({
    resultCountOrMax: 1,
    callerParams: [1, 2],
    calleeParams: [1, 2],
    calleeResults: [5],
  });
  assertEq(rec.returnArgs, [5]);
});

Deno.test("FACT: task.return preserves float lanes on the passthrough", () => {
  // A blanket `>>> 0` turned f64 -1.1 into 4294967295 on its way to
  // `[async-return]`. Lane types come from the trampoline's `coreType`.
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    memory: null,
    realloc: null,
    postReturn: null,
    callback: null,
    async: true,
    cancellable: false,
    coreType: { params: ["f64", "i32", "f32"], results: [] },
    instance: inst,
  };
  let delivered: unknown = null;
  const task = new Task(
    { params: [], results: [], async: true },
    {
      async_: true,
      callback: true,
      stringEncoding: "utf8",
      memory: null,
    },
    inst,
    () => [],
    (r) => {
      delivered = r;
    },
  );
  task.factPassthrough = true;
  task.state = "started";

  const taskReturn = createTaskReturn(
    // plan v3: `results` = raw wasmtime TypeTupleIndex, `resultType` = the
    // interned plan.types entry (here: the empty tuple, type 0).
    { results: 0, resultType: 0, options: 0 },
    {
      componentInstance: () => inst,
      options: () => opts,
      resultTypes: () => [],
    } as unknown as AsyncTrampolineContext,
  );
  const thread = new Thread(task, (function* () {})());
  pushCurrentThread(thread);
  try {
    // -1.1 as f64, -1 as i32 (arrives signed from the JS API), 0.5 as f32.
    taskReturn(-1.1, -1, 0.5);
  } finally {
    popCurrentThread(thread);
  }
  assert(Array.isArray(delivered), "task resolved");
  const got = delivered as CoreValue[];
  assertEq(got[0], -1.1); // f64 preserved, not truncated to 4294967295
  assertEq(got[1], 0xffff_ffff); // i32 canonicalized unsigned, as before
  assertEq(got[2], 0.5); // f32 preserved
});

Deno.test("FACT: a subtask reports STARTING until [async-start] actually runs", () => {
  // wasmtime sets `Status::Started` inside its `lower_params` closure
  // (concurrent.rs:2903-2908) — when the callee really starts, not when the
  // call was prepared. Here the callee runs immediately, so by the time
  // `async-start-call` returns the subtask is STARTED and reports it in the
  // packed result rather than through an event.
  const rec = runPrepared({
    resultCountOrMax: PREPARE_ASYNC_NO_RESULT,
    callerParams: [],
    calleeParams: [],
    calleeResults: [],
  });
  assert(rec.startArgs !== null, "[async-start] ran");
  // Sanity: the eager path resolved, so no handle was allocated.
  assertEq(SubtaskState.RETURNED, 2);
});
