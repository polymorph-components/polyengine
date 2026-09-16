// #345 corrects #295: the async form of `subtask.cancel` must hold
// `hasSyncWaiter` across the #92 determinacy park.
//
// CanonicalABI.md:4308-4313 says arbitrary code can run during `on_cancel`
// and that the claim prevents reentrant threads from stealing the event. The
// JSPI park (named divergence #92, docs/architecture.md §6) finishes delivery
// of that logical `on_cancel`; a JS callback return is not its completion.
//
// Pinned here: sibling join/poll cannot steal a terminal event while the
// callee is hop-parked; after an unresolved cancellation returns BLOCKED the
// claim is released and ordinary join/poll delivery works.

import { assertEq, assertTrap } from "./support/asserts.ts";
import {
  BLOCKED,
  createSubtaskCancel,
  createWaitableJoin,
} from "../src/intrinsics/async_builtins.ts";
import {
  ComponentInstanceState,
  currentTask,
  EventCode,
  Store,
  Subtask,
  SubtaskState,
  Task,
  type TaskOptions,
  Thread,
  unpackSubtaskResult,
  WaitableSet,
  withActivation,
} from "../src/task/mod.ts";
import type { SuspensionPoint } from "../src/jspi/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";
import {
  createAsyncStartCall,
  createPrepareCall,
  type FactCallContext,
  START_FLAG_ASYNC_CALLEE,
} from "../src/intrinsics/fact_calls.ts";
import { newStats } from "../src/exec/boundary.ts";

const FT: FuncType = { params: [], results: [], async: true };
const OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

Deno.test(
  "#345: unresolved async cancellation returns BLOCKED, releases its claim, " +
    "then join/poll delivers the later resolution",
  async () => {
    const store = new Store();
    const inst = new ComponentInstanceState(0, store);
    const subtask = new Subtask();
    subtask.onCancel = () => {};
    const subtaski = inst.handles.add(subtask);
    const calleeTask = new Task(FT, OPTS, inst, () => [], () => {});
    const calleeThread = new Thread(calleeTask, (function* () {})());
    calleeTask.threads.push(calleeThread);
    subtask.calleeTask = calleeTask;
    const callerTask = new Task(FT, OPTS, inst, () => [], () => {});
    const callerThread = new Thread(callerTask, (function* () {})());
    const asGuest = <T>(fn: () => T): T => withActivation(callerThread, fn);
    const pending = asGuest(() =>
      createSubtaskCancel({ async: true }, inst, "jspi")(subtaski)
    ) as unknown as Promise<number>;
    assertEq(subtask.hasSyncWaiter, true);

    calleeTask.threads.length = 0;
    store.tick();
    assertEq(await pending, BLOCKED);
    assertEq(subtask.hasSyncWaiter, false);

    const wset = new WaitableSet();
    const seti = inst.handles.add(wset);
    asGuest(() => createWaitableJoin(inst)(subtaski, seti));
    assertEq(wset.poll(callerTask), [EventCode.NONE, 0, 0]);
    const lender = { numLends: 0 };
    subtask.addLender(lender);
    subtask.resolve(SubtaskState.CANCELLED_BEFORE_RETURNED, []);
    subtask.setSubtaskPendingEvent(subtaski);
    assertEq(
      wset.poll(callerTask),
      [EventCode.SUBTASK, subtaski, SubtaskState.CANCELLED_BEFORE_RETURNED],
    );
    assertEq(subtask.resolveDelivered(), true);
    assertEq(lender.numLends, 0);
    assertEq(wset.poll(callerTask), [EventCode.NONE, 0, 0]);
  },
);

Deno.test("#345: abandoning the async determinacy park releases its claim", async () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const subtask = new Subtask();
  subtask.onCancel = () => {};
  const subtaski = inst.handles.add(subtask);
  const calleeTask = new Task(FT, OPTS, inst, () => [], () => {});
  calleeTask.threads.push(new Thread(calleeTask, (function* () {})()));
  subtask.calleeTask = calleeTask;
  const callerTask = new Task(FT, OPTS, inst, () => [], () => {});
  const callerThread = new Thread(callerTask, (function* () {})());
  const parked = withActivation(
    callerThread,
    () => createSubtaskCancel({ async: true }, inst, "jspi")(subtaski),
  ) as unknown as Promise<number>;
  const rejection = parked.catch((e) => e);
  assertEq(subtask.hasSyncWaiter, true);
  const point = store.waiting.find((w) =>
    typeof (w as { abandon?: unknown }).abandon === "function"
  ) as SuspensionPoint<unknown> | undefined;
  if (point === undefined) throw new Error("missing cancellation park");
  const reason = new Error("store teardown");
  point.abandon(reason);
  assertEq(subtask.hasSyncWaiter, false);
  assertEq(await rejection, reason);
});

function startFactSubtask(
  calleeFn?: () => unknown,
  canBlock = false,
  store = new Store(),
) {
  const caller = new ComponentInstanceState(0, store);
  const callee = new ComponentInstanceState(1, store);
  const set = new WaitableSet();
  const seti = callee.handles.add(set);
  const wait = (seti << 4) | 2;
  let cancelled = false;
  let resolve = false;
  const ctx: FactCallContext = {
    componentInstance: (i) => [caller, callee][i],
    resultTypes: () => [],
    resultTypesForTuple: () => [],
    callback: () => (code: number) => {
      if (code === EventCode.TASK_CANCELLED) cancelled = true;
      if (resolve) {
        (currentTask() as Task).cancel();
        return 0;
      }
      return wait;
    },
    postReturn: () => {
      throw new Error("unexpected post-return");
    },
    memoryToken: () => null,
    stats: newStats(),
    suspensionMode: "jspi",
    prepared: { current: null },
    factStartScopes: [],
    calleeCanBlock: () => canBlock,
  };
  const callerTask = new Task(FT, OPTS, caller, () => [], () => {});
  const callerThread = new Thread(callerTask, (function* () {})());
  const asGuest = <T>(f: () => T) => withActivation(callerThread, f);
  callee.backpressure = 1;
  const packed = asGuest(() => {
    createPrepareCall({ memory: null }, ctx)(
      () => undefined,
      () => undefined,
      0,
      1,
      0,
      1,
      0,
      0xffff_ffff,
    );
    return createAsyncStartCall({ callback: 0, postReturn: null }, ctx)(
      calleeFn ?? (() => wait),
      0,
      0,
      START_FLAG_ASYNC_CALLEE,
    );
  });
  const [state, i] = unpackSubtaskResult(packed as number);
  assertEq(state, SubtaskState.STARTING);
  callee.backpressure = 0;
  assertEq(store.tick(), true);
  const st = caller.handles.get(i) as Subtask;
  assertEq(st.state, SubtaskState.STARTED);
  assertEq(st.hasPendingEvent(), true);
  return {
    store,
    caller,
    set,
    i,
    st,
    asGuest,
    cancelled: () => cancelled,
    resolveOnCallback: () => resolve = true,
  };
}

for (const progressBeforeCancel of [true, false]) {
  Deno.test(`sync subtask.cancel holds claim and lenders past STARTED (${progressBeforeCancel})`, async () => {
    const f = startFactSubtask();
    if (!progressBeforeCancel) f.st.getPendingEvent();
    const lender = { numLends: 0 };
    f.st.addLender(lender);
    const pending = f.asGuest(() =>
      createSubtaskCancel({ async: false }, f.caller, "jspi")(f.i)
    ) as unknown as Promise<number>;
    assertEq(pending instanceof Promise, true);
    assertEq(f.st.hasSyncWaiter, true);
    if (!progressBeforeCancel) f.st.setSubtaskPendingEvent(f.i);
    assertEq(
      f.store.tick(),
      true,
      "pending cancellation callback is serviceable",
    );
    assertEq(f.cancelled(), true);
    assertEq(f.st.state, SubtaskState.STARTED);
    assertEq(f.st.resolved(), false, "STARTED progress is not resolution");
    assertEq(f.st.hasSyncWaiter, true);
    assertEq(lender.numLends, 1);
    const joinSet = new WaitableSet();
    const joinSeti = f.caller.handles.add(joinSet);
    assertTrap(() =>
      f.asGuest(() => createWaitableJoin(f.caller)(f.i, joinSeti))
    );
    assertEq(lender.numLends, 1);

    f.resolveOnCallback();
    const signal = new Subtask();
    signal.join(f.set);
    signal.setSubtaskPendingEvent(1);
    assertEq(f.store.tick(), true);
    assertEq(f.st.resolved(), true);
    assertEq(f.st.hasSyncWaiter, true);
    assertEq(f.store.tick(), true);
    assertEq(await pending, SubtaskState.CANCELLED_BEFORE_RETURNED);
    assertEq(f.st.resolveDelivered(), true);
    assertEq(f.st.hasSyncWaiter, false);
    assertEq(lender.numLends, 0);
  });
}
