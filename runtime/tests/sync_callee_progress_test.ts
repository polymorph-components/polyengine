import { Trap } from "../src/cabi/trap.ts";
import { requestStoreService } from "../src/exec/boundary.ts";
import { blockCurrentActivation } from "../src/jspi/bridge.ts";
import {
  type BlockRequest,
  ComponentInstanceState,
  markHostActivityArm,
  popLogicalActivation,
  SynchronousActivation,
  takeComponentBoundaryTrap,
  Task,
  type TaskOptions,
  Thread,
  withActivation,
} from "../src/task/mod.ts";
import { assertEq } from "./support/asserts.ts";

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("assertion failed");
}

const SYNC_OPTS: TaskOptions = {
  async_: false,
  callback: false,
  stringEncoding: "utf8",
  memory: null,
};

function root(inst: ComponentInstanceState): { task: Task; thread: Thread } {
  const task = new Task(
    { params: [], results: [], async: true },
    { ...SYNC_OPTS, async_: true },
    inst,
    () => [],
    () => {},
  );
  const thread = new Thread(task, (function* (): Generator<BlockRequest> {})());
  task.implicitThread = thread;
  task.attachCall();
  return { task, thread };
}

async function parkedSyncChild(input: {
  retain?: Promise<unknown>;
  retentionOnly?: boolean;
  asyncTyped?: boolean;
  blockReason?: "component-model" | "host-import";
  producer?: boolean;
} = {}): Promise<
  { result: Promise<number>; parent: Thread; resume: () => void }
> {
  const store = new ComponentInstanceState(99).store;
  const parentInst = new ComponentInstanceState(0, store);
  const inst = new ComponentInstanceState(1, store);
  const parent = root(parentInst).thread;
  const child = new SynchronousActivation(
    inst,
    input.asyncTyped === true,
    parent,
  );
  popLogicalActivation(child.thread);
  const result = withActivation(child.thread, () =>
    blockCurrentActivation({
      store: inst.store,
      task: child.task,
      readyFunc: () => false,
      cancellable: false,
      produce: () => 7,
      blockReason: input.blockReason,
    })) as Promise<number>;
  const point = inst.store.waiting[0];
  const resume = () => point.resume();
  if (input.retain !== undefined) {
    if (input.retentionOnly) markHostActivityArm(input.retain);
    inst.store.pendingHostCalls.add(input.retain);
  }
  if (input.producer) {
    const producerTask = new Task(
      { params: [], results: [], async: false },
      SYNC_OPTS,
      inst,
      () => [],
      () => {},
    );
    const producer = new Thread(
      producerTask,
      // deno-lint-ignore require-yield
      (function* () {
        resume();
      })(),
    );
    producerTask.registerThread(producer);
    producer.resumeLater();
  }
  await Promise.resolve(); // publish boundaryReturned / required-sync identity
  requestStoreService(inst.store);
  return { result, parent, resume };
}

async function semanticRejection(
  result: Promise<unknown>,
): Promise<unknown> {
  try {
    await result;
    throw new Error("expected rejection");
  } catch (carrier) {
    return takeComponentBoundaryTrap(carrier)?.cause ?? carrier;
  }
}

Deno.test("sync logical callee rejects at a genuine CM park", async () => {
  const { result } = await parkedSyncChild();
  const cause = await semanticRejection(result);
  assert(
    cause instanceof Trap &&
      cause.message.includes(
        "cannot block a synchronous task before returning",
      ),
  );
});

Deno.test(
  "unrelated host retention or real import cannot suppress a sync-callee trap",
  async () => {
    for (const retentionOnly of [true, false]) {
      const retained = new Promise<void>(() => {});
      const { result } = await parkedSyncChild({
        retain: retained,
        retentionOnly,
      });
      const cause = await semanticRejection(result);
      assert(
        cause instanceof Trap &&
          cause.message.includes(
            "cannot block a synchronous task before returning",
          ),
      );
    }
  },
);

Deno.test("same-instance runnable producer may satisfy a sync callee", async () => {
  const { result } = await parkedSyncChild({
    // A ready thread of the callee instance is exactly the candidate set in
    // definitions.py:2191-2193. It resolves the parked operation in its turn.
    producer: true,
  });
  assertEq(await result, 7);
});

Deno.test("async-typed callee and host-import latency are allowed to remain pending", async () => {
  for (
    const options of [{ asyncTyped: true }, {
      blockReason: "host-import" as const,
    }]
  ) {
    const { result, resume } = await parkedSyncChild(options);
    const verdict = await Promise.race([
      result.then(() => "settled"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), 10)
      ),
    ]);
    assertEq(verdict, "pending");
    resume();
    await result;
  }
});
