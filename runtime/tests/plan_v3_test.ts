// Plan v3 (contracts/plan-format.md schema, polyengine#89) pins.
//
//   1. `errorContextTables` is a required section, and the
//      `error-context-transfer` trampoline resolves its table arguments
//      through it — NOT through the resource-table mapping it borrowed at v2.
//      The v2 arrangement was not merely "structurally wrong": the
//      resource-table accessor answers successfully whenever a concrete
//      resource table exists at the colliding index, so a composition with an
//      ErrorContext at that slot read and wrote a *different instance's*
//      handle table with no diagnostic at all.
//   2. `task-return` decls carry the raw wasmtime `TypeTupleIndex` (`results`)
//      alongside its interned `plan.types` entry (`resultType`). That pair is
//      the dictionary a FACT callee task needs to know its own declared result
//      type, which re-enables `canon_task_return`'s
//      `trap_if(result_type != task.ft.result)` (definitions.py:2388) for FACT
//      tasks.

import { assertEq } from "./support/asserts.ts";
import { Table } from "../src/cabi/handles.ts";
import { loadPlan, PlanError, SUPPORTED_FORMAT_VERSION } from "../src/plan/mod.ts";
import type { WirePlan } from "../src/plan/format.ts";
import { createTrampoline, type TrampolineContext } from "../src/intrinsics/mod.ts";
import { createTaskReturn } from "../src/intrinsics/async_builtins.ts";
import {
  ComponentInstanceState,
  ErrorContext,
  pushCurrentThread,
  popCurrentThread,
  Store,
  Task,
  Thread,
} from "../src/task/mod.ts";
import type { ValType } from "../src/cabi/types.ts";

function minimalPlan(overrides: Partial<WirePlan> = {}): WirePlan {
  return {
    formatVersion: SUPPORTED_FORMAT_VERSION,
    producer: { shimVersion: "0", wasmtimeEnviron: "47.0.3", features: [] },
    component: { sha256: "0".repeat(64), len: 0 },
    modules: [],
    initializers: [],
    trampolines: [],
    canonicalOptions: [],
    types: [],
    resourceTables: [],
    streamTables: [],
    futureTables: [],
    errorContextTables: [],
    imports: [],
    exports: [],
    worldDigest: "sha256:0",
    ...overrides,
  };
}

function expectPlanError(fn: () => unknown, includes: string): void {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof PlanError)) throw new Error(`expected PlanError, got ${e}`);
    if (!e.message.includes(includes)) {
      throw new Error(`expected message to include ${JSON.stringify(includes)}, got: ${e.message}`);
    }
    return;
  }
  throw new Error(`expected a PlanError including ${JSON.stringify(includes)}`);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

Deno.test("the format version is a strict-equality gate (at 4 since plan v4)", () => {
  assertEq(SUPPORTED_FORMAT_VERSION, 4);
  expectPlanError(
    () => loadPlan(minimalPlan({ formatVersion: 2 })),
    "unsupported plan formatVersion 2",
  );
});

Deno.test("v3: errorContextTables is a required section", () => {
  const wire = minimalPlan() as unknown as Record<string, unknown>;
  delete wire.errorContextTables;
  expectPlanError(
    () => loadPlan(wire as unknown as WirePlan),
    "plan.errorContextTables missing or not an array",
  );
  expectPlanError(
    () => loadPlan(minimalPlan({ errorContextTables: [{}] as never })),
    "errorContextTables[0]: .instance must be a number",
  );
});

Deno.test("v3: errorContextTables map table index -> owning instance", () => {
  const loaded = loadPlan(minimalPlan({
    errorContextTables: [{ instance: 3 }, { instance: 1 }],
  }));
  assertEq(loaded.errorContextTableInstances, [3, 1]);
});

Deno.test("v3: task-return decls require resultType and build the tuple map", () => {
  // A `types` entry for a value type is the ValType JSON itself.
  const tupleType = { kind: "tuple" as const, elements: [] };
  const decl = {
    kind: "task-return",
    index: 0,
    instance: 0,
    results: 7, // raw wasmtime TypeTupleIndex
    resultType: 0, // plan.types index
    options: 0,
  };
  const loaded = loadPlan(minimalPlan({
    types: [tupleType as never],
    trampolines: [decl as never],
  }));
  assertEq(loaded.resultTupleTypes.get(7), 0, "raw TypeTupleIndex -> plan.types");
  assertEq(loaded.resultTupleTypes.get(0), undefined, "no aliasing of the two spaces");

  const missing = { ...decl } as Record<string, unknown>;
  delete missing.resultType;
  expectPlanError(
    () =>
      loadPlan(minimalPlan({
        types: [tupleType as never],
        trampolines: [missing as never],
      })),
    "trampolines[0]: .resultType must be a number or null",
  );
  expectPlanError(
    () =>
      loadPlan(minimalPlan({
        types: [tupleType as never],
        trampolines: [{ ...decl, resultType: 4 } as never],
      })),
    "is not a valid index into plan.types",
  );
  expectPlanError(
    () =>
      loadPlan(minimalPlan({
        types: [tupleType as never, tupleType as never],
        trampolines: [decl as never, { ...decl, index: 1, resultType: 1 } as never],
      })),
    "maps to both type 0 and type 1",
  );
});

// ---------------------------------------------------------------------------
// error-context transfer routing (the #89 silent mis-route)
// ---------------------------------------------------------------------------

Deno.test("v3: error-context transfer uses the error-context table space", () => {
  const store = new Store();
  const ecSrc = new ComponentInstanceState(0, store);
  const ecDst = new ComponentInstanceState(1, store);
  // The colliding-index trap: a *resource* table exists at both indices and
  // names different instances. Pre-v3 the transfer resolved through these and
  // silently moved the handle between the wrong tables; now any read of them
  // from this trampoline is a test failure.
  const ctx = {
    resourceTableInstance: () => {
      throw new Error("error-context transfer must not use resourceTables");
    },
    errorContextTableInstance: (i: number) => (i === 0 ? ecSrc : ecDst),
  } as unknown as TrampolineContext;

  const transfer = createTrampoline({ kind: "error-context-transfer", index: 0 } as never, ctx);
  const e = new ErrorContext("boom");
  const handle = ecSrc.handles.add(e);
  const out = transfer(handle, 0, 1) as number;
  assertEq(ecDst.handles.get(out) === e, true, "landed in the error-context table's instance");
});

Deno.test("v3: an out-of-range error-context table is a loud PlanError", () => {
  const loaded = loadPlan(minimalPlan({ errorContextTables: [{ instance: 0 }] }));
  // The executor's accessor shape, exercised directly: absence must fail
  // loudly rather than defaulting to table 0 (the `?? 0` this replaced).
  const accessor = (i: number) => {
    const instance = loaded.errorContextTableInstances[i];
    if (instance === undefined) {
      throw new PlanError(
        `error-context table ${i} is not in the plan's errorContextTables (plan v3)`,
      );
    }
    return instance;
  };
  assertEq(accessor(0), 0);
  expectPlanError(() => accessor(1), "is not in the plan's errorContextTables");
});

Deno.test("v3: error-context transfer refuses a missing table argument", () => {
  const inst = { handles: new Table<unknown>() };
  const ctx = {
    errorContextTableInstance: () => inst,
  } as unknown as TrampolineContext;
  const transfer = createTrampoline({ kind: "error-context-transfer", index: 0 } as never, ctx);
  let refused = false;
  try {
    (transfer as (...a: unknown[]) => unknown)(0);
  } catch {
    refused = true;
  }
  assertEq(refused, true, "no silent `?? 0` default for a missing table argument");
});

// ---------------------------------------------------------------------------
// canon_task_return's result-type check on a FACT task
// ---------------------------------------------------------------------------

/**
 * Drive `task.return` on a FACT (passthrough) task whose declared result type
 * is `taskResults`, from a trampoline declaring `declared`.
 */
function factTaskReturn(
  declared: ValType[],
  taskResults: ValType[],
  resultTypesKnown: boolean,
): { trapped: boolean; message: string } {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const opts = {
    stringEncoding: "utf8" as const,
    memory: null,
    realloc: null,
    postReturn: null,
    callback: null,
    async_: true,
    cancellable: false,
    coreType: { params: [] as string[], results: [] as string[] },
  };
  const task = new Task(
    { params: [], results: taskResults, async: true },
    opts as never,
    inst,
    () => [],
    () => {},
  );
  task.factPassthrough = true;
  task.factResultTypesKnown = resultTypesKnown;
  task.state = "started";
  const taskReturn = createTaskReturn(
    { results: 0, resultType: 0, options: 0 },
    {
      componentInstance: () => inst,
      options: () => opts,
      resultTypes: () => declared,
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  const thread = new Thread(task, (function* () {})());
  pushCurrentThread(thread);
  try {
    taskReturn();
    return { trapped: false, message: "" };
  } catch (e) {
    return { trapped: true, message: String(e) };
  } finally {
    popCurrentThread(thread);
  }
}

Deno.test("v3: a FACT task.return with a mismatched result type traps", () => {
  const r = factTaskReturn([{ kind: "u32" }], [{ kind: "string" }], true);
  assertEq(r.trapped, true, "mismatch must trap now that v3 maps the type");
  assertEq(
    r.message.includes("result type that is not the task's result type"),
    true,
    r.message,
  );
});

Deno.test("v3: a FACT task.return with a matching result type passes the check", () => {
  const r = factTaskReturn([{ kind: "u32" }], [{ kind: "u32" }], true);
  assertEq(r.trapped, false, r.message);
});

Deno.test("v3: an unmapped FACT result type is still not compared", () => {
  // A callee the plan maps no `task.return` tuple for (a sync-lifted callee
  // behind an async-to-sync adapter) carries a placeholder `ft.results`.
  // Comparing against a placeholder would be a false rejection, not a check.
  const r = factTaskReturn([{ kind: "u32" }], [], false);
  assertEq(r.trapped, false, r.message);
});
