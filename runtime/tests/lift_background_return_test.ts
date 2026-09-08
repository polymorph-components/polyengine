// An async-typed lift whose driver exited `idle` BEFORE `task.return` settles
// when the task returns — polyengine#313.
//
// THE SHAPE. A callback-ABI export spawns futures that outlive the call (the
// wit-bindgen `spawn_local` pattern: an event loop, a driver, an accept loop)
// and goes idle without an answer, so its own driver exits `"idle"` and the
// host gets a Promise from `backgroundCompletion()`. A later export call on
// the same store drives the store, resumes one of those futures, and it calls
// `task.return`. The task's result exists from that moment on; the task's
// LAST thread, meanwhile, never unregisters — the immortal future keeps
// `task.threads` non-empty for the instance's life. Settling on thread drain
// therefore hangs the host forever; settling on the task's resolve callback
// (definitions.py `Task.return_` -> `on_resolve`) is both correct and enough.
//
// Store-level, in the style of `lift_done_verdict_test.ts`: no checked-in
// example guest has the participants.

import { assertEq } from "./support/asserts.ts";
import {
  createLiftedFunction,
  newStats,
  type ResolvedOptions,
} from "../src/exec/mod.ts";
import {
  ComponentInstanceState,
  currentThread,
  Store,
  Thread,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** `async func()` — no params, no results, so no memory is needed. */
const FT: FuncType = { params: [], results: [], async: true };

/** The task seam the cores below reach through `currentThread()`. */
type TaskSeam = {
  return_(r: never[]): void;
  registerThread(t: Thread): void;
};

function taskOf(): TaskSeam {
  const thread = currentThread() as unknown as { task: unknown };
  return thread.task as TaskSeam;
}

Deno.test({
  name:
    "an async lift that went idle before task.return settles when the task returns (#313)",
  fn: async () => {
    const store = new Store();
    const inst = new ComponentInstanceState(0, store);
    const opts: ResolvedOptions = {
      stringEncoding: "utf8",
      memory: null,
      realloc: null,
      postReturn: null,
      // Callback ABI: the packed code the core returns is CallbackCode.EXIT
      // (0), so the loop exits at once and the implicit thread unregisters.
      callback: () => (() => 0) as never,
      async: true,
      cancellable: false,
      coreType: { params: [], results: ["i32"] },
      instance: inst,
    };

    // The test-owned condition the returner future parks on: the "later
    // event" that gives the export its answer.
    let wake = false;
    let immortal!: Thread;

    const boot = createLiftedFunction({
      name: "boot",
      ft: FT,
      opts,
      core: () => {
        const task = taskOf();
        // A spawned future that never becomes ready: the model of the
        // consumer's long-lived background work. It alone keeps this task's
        // thread list non-empty forever.
        immortal = new Thread(
          task as never,
          (function* () {
            yield { readyFunc: () => false, cancellable: false };
          })(),
        );
        task.registerThread(immortal);
        immortal.resume();
        // The future that will eventually produce the export's result.
        const returner = new Thread(
          task as never,
          (function* () {
            yield { readyFunc: () => wake, cancellable: false };
            task.return_([]);
          })(),
        );
        task.registerThread(returner);
        returner.resume();
        // EXIT synchronously: the implicit thread leaves at once (releasing
        // the exclusive slot), the task is unresolved with two live threads,
        // and the driver has no ready candidate and no host call outstanding
        // — the `"idle"` verdict, taken synchronously.
        return 0;
      },
      stats: newStats(),
    });

    const out = boot() as Promise<unknown>;
    assert(
      out instanceof Promise,
      "an async-typed lift that exits idle must return a Promise",
    );

    // Pinning that the test really went through the idle path: nothing can
    // give this task an answer until `wake` flips.
    const early = await Promise.race([
      out.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 0)),
    ]);
    assertEq(early, "pending");

    // The later event, plus a driver to notice it: a second export call on
    // the same instance. `boot`'s implicit thread released the exclusive slot
    // when it exited, so this one enters; its driver's tick drain resumes the
    // returner, which calls `task.return` on the FIRST task.
    wake = true;
    const ping = createLiftedFunction({
      name: "ping",
      ft: FT,
      opts,
      core: () => {
        taskOf().return_([]);
        return 0;
      },
      stats: newStats(),
    });
    await ping();

    const settled = await Promise.race([
      out.then((v) => ({ v })),
      new Promise((r) => setTimeout(() => r("pending"), 0))
        .then(() => new Promise((r) => setTimeout(() => r("pending"), 0))),
    ]);
    assertEq(settled, { v: undefined });
    assert(
      immortal.waiting(),
      "the immortal thread must still be parked: otherwise the task drained " +
        "and the test proves nothing about resolving on task.return",
    );
    assertEq(store.hostFailure, undefined);
    assertEq(store.pendingHostCalls.size, 0);
  },
});
