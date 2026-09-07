// A lift that exited `done` resolves even if another driver hop-parks before
// its continuation runs — polyengine#310.
//
// THE REGRESSION (0.6.5 -> 0.6.6). `createLiftedFunction`'s asynchronous
// completion path used to be
//
//   pending.then(() => {
//     if (idlePolicy === "exit" && !driveDone()) return backgroundCompletion();
//     return finishHostEntry();
//   })
//
// which RE-DERIVES `driveDone()` a microtask after the driver already decided.
// `driveDone` is a predicate over store-wide state (`hopParked()` looks at
// every task's threads, #280), and other drivers of the same store mutate it:
// in the traced consumer the settlement pump serviced a settled host call
// belonging to another task, the activation it resumed transiently hop-parked,
// and the lift — whose own driver had exited `EXIT-done` one microtask
// earlier — took `backgroundCompletion()`. That path waits for the task's LAST
// thread to unregister, so for an export that spawns long-lived background
// futures (the consumer's `boot`: engine driver, event pump, accept loop) the
// host's Promise never settles.
//
// THE SHAPE here, store-level in the style of `parked_driver_host_call_test.ts`
// (no checked-in example guest has the participants):
//
//   * a real async-typed, callback-ABI lifted export whose core returns a
//     Promise, so its thread parks on it and the drive necessarily goes
//     through `driveAsync` — i.e. the export completes on the `.then` path
//     where the re-derivation lived;
//   * the core resolves the task (`task.return`) and spawns an IMMORTAL
//     second thread into the same task (`readyFunc: () => false`), the model
//     of the consumer's background futures: it keeps `task.threads` non-empty
//     forever, which is what makes `backgroundCompletion()` a black hole
//     rather than a detour;
//   * a foreign ready thread, resumed by the very tick that follows the
//     export thread's resumption, queues a microtask that puts a foreign
//     HOP-park into `store.awaiting` (`entryHopThreads` = awaiting with no
//     `SuspensionPoint` owner). It lands after the driver's `done()` test and
//     before the lift's continuation — exactly the window the trace shows.
//
// Pre-fix the export's Promise never settles; with the verdict plumbed out of
// the driver (`DriveExit`) it resolves.

import { assertEq } from "./support/asserts.ts";
import { createLiftedFunction, newStats, type ResolvedOptions } from "../src/exec/mod.ts";
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
