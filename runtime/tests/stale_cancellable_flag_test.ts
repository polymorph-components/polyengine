// `Thread.cancellable` is set at each block point and never cleared on resume,
// so a callback task's implicit thread still looks cancellable while its frame
// RUNS holding `inst.exclusiveThread`. `Task.requestCancellation` then picks it
// (`excludeImplicit` is false — the holder IS the implicit thread) and calls
// `Thread.resume`, which asserts "resume() on a running or finished thread".
// The reference evaluates cancellability live (`cancellable = lock_available`,
// definitions.py 2167/2175): with the slot held it is False, so
// `request_cancellation` (499-503) records PENDING_CANCEL and delivers it at
// the task's next cancellable wait.

import { assertEq } from "./support/asserts.ts";
import {
  type BlockRequest,
  type Cancelled,
  ComponentInstanceState,
  Store,
  Task,
  type TaskOptions,
  Thread,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

const ASYNC_FT: FuncType = { params: [], results: [], async: true };

const CALLBACK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

function spawn(
  task: Task,
  body: (t: Thread) => Generator<BlockRequest, void, Cancelled>,
): Thread {
  // Forward reference: the generator body only runs once `thread` below
  // is assigned (spawn returns before the body executes).
  function* threadBody(): Generator<BlockRequest, void, Cancelled> {
    yield* body(thread);
  }
  const thread: Thread = new Thread(task, threadBody());
  return thread;
}

Deno.test("requestCancellation reaching a RUNNING implicit thread parks as pending-cancel", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const a = new Task(ASYNC_FT, CALLBACK_OPTS, inst, () => [], () => {});

  let thrown: unknown = null;
  let stateAfterRequest = "";

  const ta = spawn(a, function* (thread) {
    yield* a.enterImplicitThread(thread); // takes inst.exclusiveThread
    a.start();
    // A cancellable wait that returns normally; `thread.cancellable` stays true.
    yield* thread.waitUntil(() => true, true);
    // Now the frame is RUNNING and holds the exclusive slot. This stands in
    // for a nested task of the caller's instance running `subtask.cancel` on
    // A's handle through a FACT sync start-call.
    try {
      a.requestCancellation(null);
    } catch (e) {
      thrown = e;
    }
    stateAfterRequest = a.state;
    // Reference: the request is pending and is delivered at the next
    // cancellable block point.
    const cancelled = yield* thread.waitUntil(() => true, true);
    if (cancelled) a.cancel();
    else a.return_([]);
    a.exitImplicitThread(thread);
  });
  ta.resume();
  for (let i = 0; i < 20 && store.tick(); i++);

  if (thrown !== null) {
    throw new Error(
      `requestCancellation on a running implicit thread threw instead of ` +
        `parking the request: ${thrown}`,
    );
  }
  assertEq(stateAfterRequest, "pending-cancel");
  assertEq(a.state, "resolved");
});
