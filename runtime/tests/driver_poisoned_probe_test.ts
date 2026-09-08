// F2: the deadlock probe consults `readyCandidates()`, which `tick` does not.
//
// THE SHAPE (store-level: the end-to-end participants are two live activations
// of ONE instance under stackful async lifts, one JSPI-suspended while its
// sibling traps — no checked-in example guest has them).
//
//   * instance I is poisoned; a waiting entry of I is `ready()`;
//   * `Store.tick` filters poisoned instances out of its candidate set
//     (task/scheduler.ts:1171) and returns false — nothing can run;
//   * the driver's deadlock probe reads the UNFILTERED `readyCandidates()`
//     (exec/boundary.ts:1111), concludes "a thread became READY", and
//     `continue`s. Next turn: identical. Forever, one macrotask per turn.
//
// definitions.py `canon_lift`'s sync loop traps on an empty candidate set. The
// verdict must agree with what `tick` can actually run, so the abandoned
// export call must REJECT with the deadlock trap, not idle-spin.

import { assertEq } from "./support/asserts.ts";
import { driveStoreAsync } from "../src/exec/mod.ts";
import { notifyInstancePoisoned, Store } from "../src/task/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

Deno.test({
  name:
    "F2: a driver whose only ready thread belongs to a poisoned instance traps instead of spinning",
  fn: async () => {
    const store = new Store();
    const inst = { handles: [] as unknown[] };
    notifyInstancePoisoned(inst, new Error("the sibling activation trapped"));

    // The abandoned export's own activation: parked on a promise nobody will
    // ever settle (its wasm frame died with the instance).
    const parked = {
      task: { inst },
      awaiting: new Promise<unknown>(() => {}) as Promise<unknown> | null,
      resumeWith(): void {
        throw new Error("a poisoned instance's thread must never resume");
      },
    };
    store.noteAwaiting(parked, parked.awaiting!);

    // The sibling suspension point that stays `ready()` forever: `tick` will
    // never pick it (poisoned), but `readyCandidates()` still reports it.
    const sp = {
      owner: parked,
      task: { inst },
      ready: () => true,
      waiting: () => true,
      resume(): void {
        throw new Error("a poisoned instance's thread must never resume");
      },
    };
    // deno-lint-ignore no-explicit-any
    store.startWaiting(sp as any);

    let finished = false;
    const driving = driveStoreAsync(
      store,
      () => finished,
      "export 'abandoned'",
    );
    let outcome: { ok: true } | { err: unknown } | undefined;
    driving.then(() => (outcome = { ok: true }), (e) => (outcome = { err: e }));

    // The probe costs one macrotask per turn; a correct verdict needs a couple
    // of them. Bounded, per the brief.
    for (let i = 0; i < 20 && outcome === undefined; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }

    // Whatever happened, do not leave a spinning loop behind.
    finished = true;
    await driving.catch(() => {});
    for (let i = 0; i < 5 && outcome === undefined; i++) {
      await Promise.resolve();
    }

    assert(
      outcome !== undefined && "err" in outcome,
      "the driver never settled: the deadlock probe kept re-arming because " +
        "`readyCandidates()` reports a thread `tick` refuses to run",
    );
    const msg = String(
      (outcome.err as { message?: string })?.message ?? outcome.err,
    );
    assertEq(msg.includes("deadlock detected"), true);
    assertEq(msg.includes("export 'abandoned'"), true);
  },
});
