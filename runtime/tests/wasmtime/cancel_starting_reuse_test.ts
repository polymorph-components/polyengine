// Semantic adaptation of Wasmtime's
// async/cancel-starting-subtask-does-not-leak.wast. That WAST lowers
// Wasmtime's private concurrent-resource-table capacity to 100, then performs
// 1,000 STARTING → cancel → delivery → drop cycles. Polyengine has no such
// production tuning knob, so exercise the same lifecycle and assert bounded
// reuse directly rather than installing a vacuous no-op provider.

import { assertEq } from "../support/asserts.ts";
import {
  type BlockRequest,
  ComponentInstanceState,
  Store,
  Subtask,
  SubtaskState,
  Task,
  type TaskOptions,
  Thread,
} from "../../src/task/mod.ts";
import type { FuncType } from "../../src/cabi/types.ts";
import {
  createSubtaskCancel,
  createSubtaskDrop,
} from "../../src/intrinsics/async_builtins.ts";

function parkedEntryThread(task: Task): Thread {
  const holder: { thread?: Thread } = {};
  const body = (function* (): Generator<BlockRequest, void, unknown> {
    if (!(yield* task.enterImplicitThread(holder.thread!))) return;
    throw new Error("backpressured STARTING task unexpectedly entered");
  })();
  const thread = new Thread(task, body);
  holder.thread = thread;
  return thread;
}

Deno.test("Wasmtime adaptation: cancelled STARTING subtasks reuse a bounded handle slot", () => {
  const inst = new ComponentInstanceState(0, new Store());
  // Hold every callee at Task.enterImplicitThread's backpressure gate. This is
  // the real STARTING state exercised by the upstream WAST, not a manually
  // assigned Subtask enum value.
  inst.backpressure = 1;
  const cancel = createSubtaskCancel({ async: true }, inst);
  const drop = createSubtaskDrop(inst);
  let largestBackingTable = inst.handles.array.length;

  for (let iteration = 0; iteration < 1_000; iteration++) {
    const subtask = new Subtask();
    const lender = { numLends: 0 };
    subtask.addLender(lender);
    const ft: FuncType = { params: [], results: [], async: true };
    const opts: TaskOptions = {
      async_: true,
      callback: false,
      stringEncoding: "utf8",
      memory: null,
    };
    const task = new Task(ft, opts, inst, () => [], (result) => {
      subtask.resolve(
        result === null
          ? SubtaskState.CANCELLED_BEFORE_STARTED
          : SubtaskState.RETURNED,
        [],
      );
    });
    const thread = parkedEntryThread(task);
    thread.resume();
    subtask.onCancel = () => task.requestCancellation(null);
    subtask.calleeTask = task;
    const handle = inst.handles.add(subtask);
    subtask.setSubtaskPendingEvent(handle);

    assertEq(subtask.state, SubtaskState.STARTING, "precondition");
    assertEq(
      cancel(handle),
      SubtaskState.CANCELLED_BEFORE_STARTED,
      "cancel status",
    );
    assertEq(subtask.resolveDelivered(), true, "resolution delivered");
    assertEq(lender.numLends, 0, "lender released");
    assertEq(thread.done(), true, "cancelled entry thread retired");
    drop(handle);

    assertEq([...inst.handles].length, 0, "no live subtask handles");
    assertEq([...inst.threads].length, 0, "subtask cycle created no threads");
    largestBackingTable = Math.max(
      largestBackingTable,
      inst.handles.array.length,
    );
  }

  // Slot zero is reserved and one slot is repeatedly allocated. Growth here
  // would reproduce the leak which the native capacity control detects.
  assertEq(largestBackingTable, 2, "handle backing table stayed bounded");
  assertEq(inst.handles.free.length, 1, "one reusable slot remains");
});
