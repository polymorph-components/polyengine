import {
  createLiftedFunction,
  driveStoreAsync,
  newStats,
  requestStoreService,
  type ResolvedOptions,
} from "../src/exec/mod.ts";
import {
  ComponentInstanceState,
  currentThread,
  markHostActivityArm,
  Store,
  Thread,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";
import { assert, assertEquals } from "./jspi/asserts.ts";
import { isSupported } from "../src/jspi/mechanics.ts";
import { instantiateActivation } from "./jspi/support.ts";

class YieldingThread {
  resumed = 0;
  stop = false;
  readonly task = { inst: {} };

  ready(): boolean {
    return !this.stop;
  }

  waiting(): boolean {
    return !this.stop;
  }

  resume(): void {
    this.resumed++;
  }
}

function awaitingThread(store: Store, promise: Promise<unknown>) {
  const t = {
    awaiting: promise as Promise<unknown> | null,
    task: { inst: {} },
    resumeWith() {
      t.awaiting = null;
      store.awaiting.delete(t);
    },
  };
  store.noteAwaiting(t, promise);
  return t;
}

Deno.test("event-driven drain yields to timers during sustained runnable work", async () => {
  const store = new Store();
  const thread = new YieldingThread();
  store.startWaiting(thread);

  let timerRan = false;
  const timer = new Promise<void>((resolve) => {
    setTimeout(() => {
      timerRan = true;
      thread.stop = true;
      resolve();
    }, 0);
  });

  requestStoreService(store);
  await timer;
  await Promise.resolve();

  assert(timerRan, "the drain starved the platform timer queue");
  assert(
    thread.resumed >= 8,
    `expected one bounded work quantum, got ${thread.resumed}`,
  );
  assertEquals(store.hostFailure, undefined);
});

Deno.test("callback ABI lift yields to a timer before task.return", async () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const ft: FuncType = { params: [], results: [], async: true };
  let stopYielding = false;
  let callbackCalls = 0;
  const run = createLiftedFunction({
    name: "callback-fairness",
    ft,
    opts: {
      stringEncoding: "utf8",
      memory: null,
      realloc: null,
      postReturn: null,
      callback: () =>
        (() => {
          callbackCalls++;
          if (!stopYielding) return 1;
          const task = (currentThread() as unknown as { task: never }).task;
          (task as unknown as { return_(result: never[]): void }).return_([]);
          return 0;
        }) as never,
      async: true,
      cancellable: false,
      coreType: { params: [], results: ["i32"] },
      instance: inst,
    },
    core: () => 1,
    stats: newStats(),
  });

  setTimeout(() => stopYielding = true, 0);
  const result = run();
  assert(
    result instanceof Promise,
    "fairness handoff must return a Promise before the timer runs",
  );
  await result;

  assert(stopYielding, "callback loop completed before the timer ran");
  assert(
    callbackCalls >= 8,
    `expected a full shared work quantum, got ${callbackCalls} callbacks`,
  );
  assertEquals(store.hostFailure, undefined);
});

Deno.test("mixed queued and unsettled entry hops do not spin on the settled hop", async () => {
  const store = new Store();
  awaitingThread(store, Promise.resolve());
  awaitingThread(store, new Promise<void>(() => {}));

  requestStoreService(store);
  let timerRan = false;
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      timerRan = true;
      resolve();
    }, 20);
  });

  assert(timerRan, "a settled hop was repeatedly raced and starved timers");
  assertEquals(
    store.settled.length,
    1,
    "queued hop crossed the unsettled barrier",
  );
  assertEquals(store.awaiting.size, 2, "an entry hop was disturbed");
  assertEquals(store.hostFailure, undefined);
});

Deno.test("one request drains every immediately settled activation tail", async () => {
  const store = new Store();
  const resumed: number[] = [];
  for (let i = 0; i < 3; i++) {
    const tail = {
      awaiting: Promise.resolve(),
      task: { inst: {} },
      resumeWith() {
        resumed.push(i);
        tail.awaiting = null as unknown as Promise<void>;
        store.awaiting.delete(tail);
      },
    };
    store.noteAwaiting(tail, tail.awaiting);
  }
  await Promise.resolve();

  requestStoreService(store);
  await Promise.resolve();

  assertEquals(resumed.join(","), "0,1,2");
  assertEquals(store.settled.length, 0);
  assertEquals(store.awaiting.size, 0);
});

Deno.test("a pending claim stops queued-tail service until its release", async () => {
  const store = new Store();
  let resumes = 0;
  const tail = awaitingThread(store, Promise.resolve());
  tail.resumeWith = () => {
    resumes++;
    tail.awaiting = null;
    store.awaiting.delete(tail);
  };
  const claim = {};
  await Promise.resolve();
  store.addPendingResumption(claim);
  assert(
    store.pendingResumptions.has(claim),
    "test claim was released before the blocked service request",
  );

  requestStoreService(store);
  let timerRan = false;
  queueMicrotask(() => store.removePendingResumption(claim));
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      timerRan = true;
      resolve();
    }, 20);
  });

  assert(timerRan, "blocked queued work starved the platform timer");
  assertEquals(resumes, 1, "released tail must execute exactly once");
  assertEquals(store.settled.length, 0);
});

Deno.test({
  name: "same-instance JSPI entry waits through more than one tail quantum",
  ignore: !isSupported(),
  fn: async () => {
    const wasm = await instantiateActivation({
      block: new WebAssembly.Suspending((x: number) => x),
    });
    const store = new Store();
    const inst = new ComponentInstanceState(0, store);
    let tails = 0;
    for (let i = 0; i < 9; i++) {
      const awaiting = Promise.resolve();
      const tail = {
        awaiting: awaiting as Promise<unknown> | null,
        task: { inst },
        resumeWith() {
          tails++;
          tail.awaiting = null;
          store.awaiting.delete(tail);
        },
      };
      store.noteAwaiting(tail, awaiting);
    }
    await Promise.resolve();

    const run = createLiftedFunction({
      name: "post-hop-entry",
      ft: { params: [{ kind: "u32" }], results: [{ kind: "u32" }] },
      opts: {
        stringEncoding: "utf8",
        memory: null,
        realloc: null,
        postReturn: null,
        callback: null,
        async: false,
        cancellable: false,
        coreType: { params: ["i32"], results: ["i32"] },
        instance: inst,
      },
      core: wasm.other,
      stats: newStats(),
      suspensionMode: "jspi",
    });

    const result = run(42);
    assert(result instanceof Promise, "gated JSPI entry must remain async");
    assertEquals(await result, 1042);
    assertEquals(tails, 9, "entry resumed before every hop tail completed");
    assertEquals(store.awaiting.size, 0);
  },
});

Deno.test("ordinary service stops when the first tail creates an unqueued hop", async () => {
  const store = new Store();
  let secondRan = false;
  const hop = {
    awaiting: new Promise<void>(() => {}),
    task: { inst: {} },
  };
  const first = {
    awaiting: Promise.resolve(),
    task: { inst: {} },
    resumeWith() {
      first.awaiting = null as unknown as Promise<void>;
      store.awaiting.delete(first);
      store.awaiting.add(hop);
    },
  };
  const second = {
    awaiting: Promise.resolve(),
    task: { inst: {} },
    resumeWith() {
      secondRan = true;
      second.awaiting = null as unknown as Promise<void>;
      store.awaiting.delete(second);
    },
  };
  store.awaiting.add(first);
  store.awaiting.add(second);
  store.settled.push(
    { t: first, value: undefined, failure: undefined },
    { t: second, value: undefined, failure: undefined },
  );

  requestStoreService(store);
  await Promise.resolve();
  assertEquals(secondRan, false, "second tail crossed the new hop barrier");
  assertEquals(store.settled.length, 1);

  const park = {
    owner: hop,
    task: hop.task,
    ready: () => false,
    waiting: () => true,
    resume() {},
  };
  store.startWaiting(park);
  await Promise.resolve();
  assertEquals(
    secondRan,
    true,
    "second tail stayed blocked after a genuine park",
  );
});

Deno.test("an existing unqueued entry hop blocks a global service attempt", async () => {
  const store = new Store();
  awaitingThread(store, new Promise<void>(() => {}));
  const ready = new YieldingThread();
  store.startWaiting(ready);

  requestStoreService(store);
  await Promise.resolve();
  assertEquals(ready.resumed, 0, "ordinary tick crossed an unqueued entry hop");
});

Deno.test("host retention suppresses ordinary and hop-probe deadlock verdicts", async () => {
  for (const withHop of [false, true]) {
    const store = new Store();
    const arm = new Promise<void>(() => {});
    markHostActivityArm(arm);
    store.pendingHostCalls.add(arm);
    if (withHop) awaitingThread(store, new Promise<void>(() => {}));

    let settled = false;
    driveStoreAsync(store, () => false, `retained ${withHop ? "hop" : "idle"}`)
      .then(() => settled = true, () => settled = true);
    requestStoreService(store);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assertEquals(settled, false, "retained host capability falsely deadlocked");
    assertEquals(store.hostFailure, undefined);
  }
});

Deno.test("continuation-driven drains share the fairness budget", async () => {
  const store = new Store();
  let resumes = 0;
  let timerRan = false;
  const thread = {
    task: { inst: {} },
    ready: () => !timerRan,
    waiting: () => !timerRan,
    resume() {
      resumes++;
      // Force the next quantum through another coordinator invocation rather
      // than the same `while (tick())` loop.
      store.addPendingResumption(thread);
      queueMicrotask(() => store.removePendingResumption(thread));
    },
  };
  store.startWaiting(thread);
  let keepAlive = false;
  const driving = driveStoreAsync(store, () => keepAlive, "fairness test")
    .catch(() => {});
  setTimeout(() => timerRan = true, 0);
  requestStoreService(store);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert(timerRan, "continuation-driven drain invocations starved the timer");
  assert(resumes >= 8, `fairness budget reset between drains at ${resumes}`);
  const stoppedAt = resumes;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(resumes, stoppedAt, "quiescent coordinator kept spinning");
  keepAlive = true;
  requestStoreService(store);
  await driving;
});

Deno.test("finite guest work continues past task.return and a fairness yield", async () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const ft: FuncType = { params: [], results: [], async: true };
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    memory: null,
    realloc: null,
    postReturn: null,
    callback: () => (() => 0) as never,
    async: true,
    cancellable: false,
    coreType: { params: [], results: ["i32"] },
    instance: inst,
  };
  let steps = 0;
  let finished = false;
  let timerRan = false;
  const run = createLiftedFunction({
    name: "post-result-finite-work",
    ft,
    opts,
    core: () => {
      const task = (currentThread() as unknown as { task: never }).task;
      const background = new Thread(
        task,
        (function* () {
          for (let i = 0; i < 20; i++) {
            steps++;
            yield { readyFunc: () => true, cancellable: false };
          }
          finished = true;
        })(),
      );
      (task as unknown as { registerThread(t: Thread): void }).registerThread(
        background,
      );
      background.resume();
      (task as unknown as { return_(result: never[]): void }).return_([]);
      return 0;
    },
    stats: newStats(),
  });

  setTimeout(() => timerRan = true, 0);
  await run();
  assert(
    !finished,
    "background work finished before public task.return delivery",
  );
  while (!finished) await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(steps, 20);
  assert(timerRan, "post-result work starved the platform timer");
  const stoppedAt = steps;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(
    steps,
    stoppedAt,
    "finished background work left resident service",
  );
});
