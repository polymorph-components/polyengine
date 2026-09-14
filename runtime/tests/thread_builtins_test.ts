import { assertEq } from "./support/asserts.ts";
import type { FuncType } from "../src/cabi/types.ts";
import {
  ComponentInstanceState,
  popCurrentThread,
  pushCurrentThread,
  Store,
  Task,
  Thread,
  withSynchronousActivation,
} from "../src/task/mod.ts";
import {
  createThreadIndex,
  createThreadNewIndirect,
  createThreadResumeLater,
  createThreadSuspendThenResume,
  createThreadYieldThenResume,
  type ThreadTrampolineContext,
} from "../src/intrinsics/thread_builtins.ts";
import { createTaskReturn } from "../src/intrinsics/async_builtins.ts";

const FT: FuncType = { params: [], results: [], async: true };

function fixture(table: WebAssembly.Table) {
  const inst = new ComponentInstanceState(0, new Store());
  const task = new Task(
    FT,
    {
      async_: true,
      callback: false,
      stringEncoding: "utf8",
      memory: null,
    },
    inst,
    () => [],
    () => {},
  );
  task.state = "started";
  const parent = new Thread(task, (function* () {})());
  task.implicitThread = parent;
  task.registerThread(parent);
  const ctx: ThreadTrampolineContext = {
    componentInstance: () => inst,
    runtimeTable: () => table,
    suspensionMode: "plain",
    enterThreadFunction: (fn) => fn,
  };
  return { inst, task, parent, ctx };
}

function moduleFromWatBytes(bytes: number[]): WebAssembly.Instance {
  return new WebAssembly.Instance(
    new WebAssembly.Module(new Uint8Array(bytes)),
  );
}

// (module (table (export "t") 3 funcref)
//   (func $ok (param i32)) (func $wrong (param i64) (result i32) i32.const 0)
//   (elem (i32.const 0) $ok $wrong))
const TABLE_FIXTURE = [
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  14,
  3,
  96,
  1,
  127,
  0,
  96,
  1,
  126,
  0,
  96,
  1,
  126,
  1,
  127,
  3,
  4,
  3,
  0,
  1,
  2,
  4,
  4,
  1,
  112,
  0,
  4,
  7,
  5,
  1,
  1,
  116,
  1,
  0,
  9,
  9,
  1,
  0,
  65,
  0,
  11,
  3,
  0,
  1,
  2,
  10,
  12,
  3,
  2,
  0,
  11,
  2,
  0,
  11,
  4,
  0,
  65,
  0,
  11,
];

Deno.test("thread.new-indirect validates before registration and starts only after resume-later", () => {
  const module = moduleFromWatBytes(TABLE_FIXTURE);
  const table = module.exports.t as WebAssembly.Table;
  const f = fixture(table);
  const create = createThreadNewIndirect(
    { instance: 0, startFuncTable: 0 },
    f.ctx,
  );
  const resume = createThreadResumeLater({ instance: 0 }, f.ctx);

  pushCurrentThread(f.parent);
  try {
    const beforeThreads = [...f.inst.threads].length;
    for (const [index, closure] of [[1, 7], [2, 7n], [3, 7]] as const) {
      try {
        create(index, closure);
        throw new Error(`index ${index} unexpectedly accepted`);
      } catch {
        assertEq(
          [...f.inst.threads].length,
          beforeThreads,
          "failed new has no effects",
        );
      }
    }
    const childIndex = create(0, 7) as number;
    assertEq([...f.inst.threads].length, 2, "child registered suspended");
    resume(childIndex);
    assertEq(f.inst.store.tick(), true, "child scheduled");
    assertEq([...f.inst.threads].length, 1, "child unregistered on return");
    const child64 = create(1, 7n) as number;
    resume(child64);
    assertEq(f.inst.store.tick(), true, "i64 child scheduled");
    assertEq(createThreadIndex({ instance: 0 }, f.ctx)(), f.parent.index);
  } finally {
    popCurrentThread(f.parent);
  }
});

Deno.test("SUPPORTED LIMITATION: equivalent non-final thread start types are rejected without execution", async () => {
  // CONTRACT: Core function-type equality accepts equivalent non-final and
  // derived types (definitions.py:2673-2674). WebAssembly's JS API exposes no
  // signature reflection, while ref.test against our final canonical type
  // rejects these valid inputs. Translator metadata is the required fix; this
  // test records an implementation rejection, not spec-invalid guest input.
  const bytes = await Deno.readFile(
    new URL("./fixtures/thread-type-equivalence.wasm", import.meta.url),
  );
  const module = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  const table = module.exports.table as WebAssembly.Table;
  const runs = module.exports.runs as WebAssembly.Global;
  const f = fixture(table);
  const create = createThreadNewIndirect(
    { instance: 0, startFuncTable: 0 },
    f.ctx,
  );

  pushCurrentThread(f.parent);
  try {
    const finalThread = create(0, 7) as number;
    assertEq([...f.inst.threads].length, 2, "final control is accepted");
    for (const index of [1, 2]) {
      let rejected = false;
      try {
        create(index, 7);
      } catch {
        rejected = true;
      }
      assertEq(rejected, true, `equivalent type ${index} hits limitation`);
      assertEq(runs.value, 0, "validation must not execute any target");
      assertEq(
        [...f.inst.threads].length,
        2,
        "rejection has no registration effect",
      );
    }
    const resume = createThreadResumeLater({ instance: 0 }, f.ctx);
    resume(finalThread);
    f.inst.store.tick();
    assertEq(
      runs.value,
      1,
      "accepted final control executes only when resumed",
    );
  } finally {
    popCurrentThread(f.parent);
  }
});

Deno.test("thread switch validates operands before delivering pending cancellation", () => {
  const module = moduleFromWatBytes(TABLE_FIXTURE);
  const f = fixture(module.exports.t as WebAssembly.Table);
  const create = createThreadNewIndirect(
    { instance: 0, startFuncTable: 0 },
    f.ctx,
  );
  const switchedCtx = { ...f.ctx, suspensionMode: "jspi" as const };
  const suspendThenResume = createThreadSuspendThenResume(
    { instance: 0, cancellable: true },
    switchedCtx,
  );
  const yieldThenResume = createThreadYieldThenResume(
    { instance: 0, cancellable: true },
    switchedCtx,
  );

  pushCurrentThread(f.parent);
  try {
    f.task.state = "pending-cancel";
    for (
      const [fn, target] of [
        [suspendThenResume, 999],
        [yieldThenResume, f.parent.index!],
      ] as const
    ) {
      let trapped = false;
      try {
        fn(target);
      } catch {
        trapped = true;
      }
      assertEq(trapped, true, "invalid target traps before cancellation");
      assertEq(f.task.state, "pending-cancel", "pending cancel not consumed");
    }

    const child = create(0, 7) as number;
    f.task.state = "pending-cancel";
    assertEq(suspendThenResume(child), 1, "valid target receives cancellation");
    assertEq(f.task.state, "cancel-delivered");
    assertEq(
      f.inst.threads.get(child).explicitlySuspended(),
      true,
      "target not switched",
    );
  } finally {
    popCurrentThread(f.parent);
  }
});

Deno.test("exceptional explicit-thread cleanup does not synthesize resolution", () => {
  const module = moduleFromWatBytes(TABLE_FIXTURE);
  const f = fixture(module.exports.t as WebAssembly.Table);
  const child = new Thread(f.task, (function* () {})());
  f.task.registerThread(child);
  f.task.abortThread(child);
  assertEq(f.task.state, "started", "cleanup did not resolve the task");
  assertEq([...f.inst.threads].length, 1, "only the parent remains");
});

Deno.test("same-instance synchronous activation keeps task.return on the logical task", () => {
  const module = moduleFromWatBytes(TABLE_FIXTURE);
  const f = fixture(module.exports.t as WebAssembly.Table);
  let outerResolved = false;
  f.task.onResolve = () => {
    outerResolved = true;
  };
  const taskReturn = createTaskReturn(
    { results: 0, resultType: null, options: 0 },
    {
      componentInstance: () => f.inst,
      options: () => ({
        async: true,
        callback: null,
        memory: null,
        realloc: null,
        postReturn: null,
        stringEncoding: "utf8",
        cancellable: false,
        instance: f.inst,
        coreType: { params: [], results: [] },
      }),
      resultTypes: () => [],
    } as never,
    f.inst,
  );

  pushCurrentThread(f.parent);
  try {
    let trapped = false;
    try {
      withSynchronousActivation(f.inst, () => taskReturn());
    } catch {
      trapped = true;
    }
    assertEq(trapped, true, "sync logical task.return traps");
    assertEq(outerResolved, false, "outer task was not resolved");
    assertEq(f.task.state, "started");
  } finally {
    popCurrentThread(f.parent);
  }
});
