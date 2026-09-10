// wasmtime-model entry semantics: the HOLD RULE + the DEFERRED ENTRY DECISION
// (issue #43).
//
// These tests pin the semantics established by the CM-4 investigation
// (issue #43, where the evidence is distilled; the exam kit is archived at
// 4f3351f:exams/wasmtime-exclusivity/), which corrected
// the earlier (false) belief that wasmtime releases its instance-entry gate
// when a task resolves. It does not:
//
//   * GATE LIFETIME (hold rule) — wasmtime's `ConcurrentInstanceState.
//     do_not_enter` is set by `enter_instance` and cleared by `exit_instance`
//     only (concurrent.rs :2004-2021), both of which bracket a whole *core
//     invocation*; `task_return` never touches it (:3329-3378). That is
//     exactly the lifetime of `definitions.py`'s `inst.exclusive_thread`
//     (`enter_implicit_thread` :477 / `exit_implicit_thread` :503;
//     `block_internal` :378 leaves it alone). A RESOLVED task parked
//     mid-frame in a synchronous built-in therefore STILL gates its instance.
//
//   * ENTRY DECISION (deferred) — an async-lowered guest->guest call does not
//     read the gate at the call instant. wasmtime queues the callee and
//     suspends the caller until the first subtask status event, so the
//     executor first drains the work queued ahead of the call
//     (concurrent.rs :1497-1522, :3040-3160). polyengine uses the order-robust
//     restatement (issue #43) — *the
//     call reports STARTING only if the callee is still unstarted after the
//     instance's runnable work has been drained to quiescence* — because
//     wasmtime's own FIFO-dependent formulation would not survive
//     `POLYENGINE_SCHED_SEED` shuffles. `Store.hasRunnableWork` is that drain
//     predicate; `createAsyncStartCall` (intrinsics/fact_calls.ts) is its
//     only consumer.
//
// Adjudicated 2026-08-10 (issue #43): entry-status *timing* is not
// normative. The HOLD RULE is spec semantics; the deferred decision is
// polyengine's scheduler policy, which makes the suite's schedule-overfitted
// `sync-streams.wast:145` STARTED assertion (an upstream test defect —
// pristine definitions.py answers STARTING) hold under any seed.
//
// The shape exercised below is the pump/poke one: a callback-lifted "pump"
// task resolves (`task.return`) and then parks mid-frame in a synchronous
// read that is NOT ready, while a same-instance "poke" task tries to enter.
// Expected, per the wasmtime model: poke is NOT admitted for the whole parked
// span (STARTING at the lower), and starts only once the pump's invocation
// exits. Note this is deliberately the OPPOSITE of the exam's
// `test_resolved_task_gates_entry` (cm4-run-tests.patch, archived at
// 4f3351f:exams/wasmtime-exclusivity/), which encoded
// polyengine's since-removed release-at-resolution rule.
//
// The no-interleaving assertion uses the shared-state discipline of the
// reference's own `test_callback_interleaving`: a flag the interloper sets,
// checked from inside the parked span.

import { assertEq } from "./support/asserts.ts";
import {
  type BlockRequest,
  type Cancelled,
  ComponentInstanceState,
  SubtaskState,
  Task,
  type TaskOptions,
  Thread,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const ASYNC_FT: FuncType = { params: [], results: [], async: true };

/** Async-typed, callback ABI — `needs_exclusive()` is true (definitions.py :472). */
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
  function* threadBody(): Generator<BlockRequest, void, Cancelled> {
    yield* body(thread);
  }
  const thread: Thread = new Thread(task, threadBody());
  return thread;
}

function mkTask(inst: ComponentInstanceState): Task {
  return new Task(ASYNC_FT, CALLBACK_OPTS, inst, () => [], () => {});
}

Deno.test(
  "wasmtime model (hold rule): a RESOLVED task parked mid-frame still gates " +
    "its instance, and the deferred entry decision reports STARTING",
  () => {
    const inst = new ComponentInstanceState(0);
    const store = inst.store;

    // The pump: enters, resolves (`task.return`), then parks mid-frame in a
    // synchronous read that is not ready. Under the hold rule its slot is
    // untouched by both the resolution and the block.
    let readReady = false;
    /** Set by the poke task's body — the interleaving witness. */
    let pokeEntered = 0;
    /** What the pump saw of `pokeEntered` while it was parked. */
    let pumpSawWhileParked = -1;

    const pump = mkTask(inst);
    const pumpThread = spawn(pump, function* (thread) {
      const entered = yield* pump.enterImplicitThread(thread);
      assert(entered, "the first entry into an idle instance is never refused");
      pump.start();
      pump.return_([]);
      assertEq(pump.state, "resolved");
      // definitions.py `block_internal` (:378): blocking does NOT release
      // `inst.exclusive_thread`. Same as wasmtime suspending its guest fiber
      // with the `enter_instance` bracket still open (concurrent.rs
      // `wait_for_event` :2199-2213).
      yield* thread.waitUntil(() => readReady, false);
      pumpSawWhileParked = pokeEntered;
      pump.exitImplicitThread(thread);
    });

    pumpThread.resume();
    assertEq(pump.state, "resolved");
    assertEq(
      inst.exclusiveThread === pumpThread,
      true,
      "a resolved task parked mid-frame still holds the gate (hold rule)",
    );

    // The poke: a same-instance async-lowered call. Its callee thread is
    // spawned and resumed eagerly (as `createAsyncStartCall` does), so it
    // parks at `enter_implicit_thread`'s gate wait; the caller's STARTING /
    // STARTED answer is decided later, by the drain.
    const poke = mkTask(inst);
    let pokeState: SubtaskState = SubtaskState.STARTING;
    const pokeThread = spawn(poke, function* (thread) {
      const entered = yield* poke.enterImplicitThread(thread);
      assert(entered, "poke is gated, not cancelled");
      pokeEntered++;
      poke.start();
      pokeState = SubtaskState.STARTED;
      poke.return_([]);
      pokeState = SubtaskState.RETURNED;
      poke.exitImplicitThread(thread);
    });
    pokeThread.resume();

    // Gated at entry: still STARTING, parked, and the gate is the pump's.
    assertEq(pokeState, SubtaskState.STARTING);
    assertEq(pokeThread.waiting(), true);
    assertEq(pokeThread.ready(), false, "the gate is held: poke is not ready");
    assertEq(pokeEntered, 0);

    // THE DEFERRED ENTRY DECISION. The caller drains the callee instance's
    // runnable work to quiescence and only then reads the status. Here the
    // gate holder is parked on an un-rendezvous'd read, so it is not runnable:
    // the instance is already quiescent and the answer is STARTING.
    assertEq(
      store.hasRunnableWork(inst, /* excludeTask */ null),
      false,
      "the holder is parked-unready: no drain can make progress",
    );
    assertEq(pokeState, SubtaskState.STARTING, "reported status: STARTING");

    // No same-instance execution during the parked span — the property the
    // hold rule exists to guarantee (Explainer.md Invariant #3, single shadow
    // stack), and the one polyengine's removed release rule gave up (the IROH-1
    // collision window).
    assertEq(store.tick(), false, "nothing in the instance is runnable");
    assertEq(pokeEntered, 0, "the interloper was NOT admitted while parked");

    // Unblock the pump. NOW the instance has runnable work again, so a drain
    // performed at this instant would run the holder to invocation exit — the
    // sync-streams.wast:145 shape, where the caller then observes STARTED.
    readReady = true;
    assertEq(
      store.hasRunnableWork(inst, null),
      true,
      "the holder became ready: the drain has work to do",
    );

    // Drain to quiescence.
    let steps = 0;
    while (store.tick()) assert(++steps < 100, "drain terminates");

    assertEq(pumpSawWhileParked, 0, "the pump saw no interleaved execution");
    assertEq(
      pokeEntered,
      1,
      "poke was admitted only after the pump's invocation exited",
    );
    assertEq(pokeState, SubtaskState.RETURNED);
    assertEq(inst.exclusiveThread, null, "the gate is free once both exited");
    assertEq(store.hasRunnableWork(inst, null), false, "quiescent");
  },
);

Deno.test(
  "wasmtime model (deferred entry): the CALLER is excluded from the drain, " +
    "so a nested lower from inside the gate holder reports STARTING at once",
  () => {
    // The one case the drain can never resolve: the only obstacle is the
    // activation asking the question (a lower issued from within the holder's
    // own invocation). wasmtime cannot drain it either — it is the caller —
    // so the answer is STARTING immediately, with no park. `hasRunnableWork`
    // encodes this by excluding the caller's task from the scan.
    const inst = new ComponentInstanceState(0);
    const store = inst.store;

    let go = false;
    const holder = mkTask(inst);
    const holderThread = spawn(holder, function* (thread) {
      const entered = yield* holder.enterImplicitThread(thread);
      assert(entered, "idle instance");
      holder.start();
      // Parked, but READY: from any other task's point of view this is
      // drainable work.
      yield* thread.waitUntil(() => go, false);
      holder.return_([]);
      holder.exitImplicitThread(thread);
    });
    holderThread.resume();
    go = true;

    assertEq(
      store.hasRunnableWork(inst, /* excludeTask */ null),
      true,
      "to a third party the ready holder is drainable work",
    );
    assertEq(
      store.hasRunnableWork(inst, /* excludeTask */ holder),
      false,
      "to the holder itself there is nothing to drain: STARTING immediately",
    );
  },
);
