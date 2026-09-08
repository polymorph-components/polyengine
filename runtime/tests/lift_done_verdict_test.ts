// A lift that exited `done` resolves even if another driver hop-parks before
// its continuation runs — polyengine#310.
//
// Completion must use the driver's `DriveExit`, not re-evaluate `driveDone`
// in a later microtask: another task can change the store-wide hop state.
// The callback-ABI export resolves its task but leaves a non-ready background
// thread alive. A foreign thread queues a hop-park between the driver's done
// verdict and the lift continuation. Re-evaluating there would incorrectly
// wait for the background thread and leave the host Promise unsettled.

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

/**
 * A foreign hop-parked activation: in `store.awaiting`, with nothing owning
 * it in `store.waiting`. `entryHopThreads` reads exactly these two fields.
 */
function foreignHop() {
  return { task: { inst: {} }, awaiting: new Promise<unknown>(() => {}) };
}

/**
 * The other driver's guest thread: ready only once the export's own thread has
 * left the task, so it is ticked in the same synchronous stretch as the
 * driver's `done()` test — and not before it.
 */
class ForeignThread {
  resumed = 0;
  readonly task = { inst: {} };
  constructor(
    private readonly armed: () => boolean,
    private readonly onResume: () => void,
  ) {}
  ready(): boolean {
    return this.resumed === 0 && this.armed();
  }
  waiting(): boolean {
    return this.resumed === 0;
  }
  resume(): void {
    this.resumed++;
    this.onResume();
  }
}

Deno.test({
  name:
    "a lift that exited done resolves even if another driver hop-parks before its continuation runs (#310)",
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

    const hop = foreignHop();
    // Armed by the export thread's own exit: `task.threads` then holds only
    // the immortal background thread.
    let taskThreads: () => number = () => 2;
    const foreign = new ForeignThread(
      () => taskThreads() === 1,
      // Queued during the tick, so it runs after the driver's `done()` test
      // (same synchronous stretch) and before the lift's `.then` (queued only
      // when `driveAsync`'s promise resolves, one microtask later).
      () => queueMicrotask(() => store.awaiting.add(hop)),
    );
    store.startWaiting(foreign);

    let background!: Thread;
    const fn = createLiftedFunction({
      name: "boot",
      ft: FT,
      opts,
      core: () => {
        const thread = currentThread() as unknown as { task: never };
        const task = thread.task as unknown as {
          return_(r: never[]): void;
          registerThread(t: Thread): void;
          threads: unknown[];
        };
        // The consumer's spawned background futures: registered into this
        // task and parked on a condition nothing ever satisfies.
        background = new Thread(
          task as never,
          (function* () {
            yield { readyFunc: () => false, cancellable: false };
          })(),
        );
        task.registerThread(background);
        background.resume();
        // `task.return` — the export has its answer while its background
        // work keeps running.
        task.return_([]);
        taskThreads = () => task.threads.length;
        // Park the export's own activation on a Promise, which is what forces
        // the drive onto the asynchronous (`.then`) completion path.
        return Promise.resolve().then(() => 0);
      },
      stats: newStats(),
    });

    const out = fn() as Promise<unknown>;
    assert(
      out instanceof Promise,
      "an async-typed lift whose core parks must return a Promise",
    );

    const settled = await Promise.race([
      out.then(() => "resolved"),
      // A few macrotask turns: everything this test needs is microtask work,
      // so anything still pending here is pending forever.
      new Promise((r) => setTimeout(() => r("pending"), 0))
        .then(() => new Promise((r) => setTimeout(() => r("pending"), 0))),
    ]);
    assertEq(foreign.resumed, 1);
    assert(
      store.awaiting.has(hop),
      "the test never injected the foreign hop-park, so it proves nothing",
    );
    assertEq(settled, "resolved");
    assert(
      background.waiting(),
      "the background thread must still be parked: without it the task is " +
        "over and `backgroundCompletion` would settle on its own",
    );
    assertEq(store.hostFailure, undefined);

    // Leave nothing live behind: the injected hop is parked on a promise that
    // never settles, and the background thread on a condition that never
    // holds, so any driver that inherited them would spin.
    store.awaiting.delete(hop);
    assertEq(store.pendingHostCalls.size, 0);
  },
});
