import { assertEq } from "./support/asserts.ts";
import {
  createLiftedFunction,
  newStats,
  registerHostCall,
  type ResolvedOptions,
} from "../src/exec/mod.ts";
import {
  ComponentInstanceState,
  currentThread,
  Store,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

const FT: FuncType = { params: [], results: [], async: true };

Deno.test("#323: a foreign driver failure does not unwind the live producer", async () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
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
  const gate = Promise.withResolvers<number>();
  let releases = 0;
  let producerThread!: {
    syncCallStack: { releaseLenders(): void }[];
  };
  const ownerWait = {
    owner: undefined as unknown,
    ready: () => false,
    waiting: () => true,
    resume: () => {},
  };
  const producer = createLiftedFunction({
    name: "producer",
    ft: FT,
    opts,
    core: () => {
      producerThread = currentThread() as typeof producerThread;
      producerThread.syncCallStack.push({
        releaseLenders: () => releases++,
      });
      const task = (currentThread() as unknown as {
        task: { return_(result: never[]): void };
      }).task;
      task.return_([]);
      ownerWait.owner = currentThread();
      store.startWaiting(ownerWait as never);
      return gate.promise;
    },
    stats: newStats(),
  });

  const result = producer() as Promise<void>;
  assertEq(await result, undefined);

  const boom = new Error("foreign driver failure");
  let wake!: () => void;
  const host = new Promise<void>((resolve) => (wake = resolve));
  registerHostCall(store, host);
  store.hostFailure = boom;
  wake();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEq(releases, 0, "foreign failure must not unwind producer scopes");

  store.stopWaiting(ownerWait as never);
  producerThread.syncCallStack.pop();
  gate.resolve(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
