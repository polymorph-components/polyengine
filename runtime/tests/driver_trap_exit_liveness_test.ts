// F4: a driver that exits by THROWING leaves sibling work unowned.
//
// THE SHAPE (store-level; the participants are two instances of one
// instantiation, one trapping while the other's activation is in flight)
//
//   (a) `drive`'s tick loop resumes sibling B, which registers a real host
//       call, then resumes a thread that traps. The throw leaves through
//       `drive` without ever reaching `ensureSettlementPump` (armed only on
//       the `done()` path, exec/boundary.ts:468). B's call settles, B goes
//       READY — and nobody ticks the store.
//   (b) `driveAsync`'s trap exit arms the pump only when a REAL host call
//       remains (`ensureSettlementPump` bails otherwise), so a sibling's
//       hop-park landing in `store.settled` sits there unserviced — and a
//       non-empty `settled` makes `Store.tick` refuse for every later driver.
//
// arch §6 #173 (siblings stay usable) and the #280 rule ("a driver is not
// done while ANY thread of ANY task is hop-parked") both assume a normal
// exit; run_tests.py `lift_and_run` drains the whole store either way.

import { assertEq } from "./support/asserts.ts";
import { driveStoreAsync, registerHostCall } from "../src/exec/mod.ts";
import { createDtorEntry } from "../src/exec/boundary.ts";
import { ComponentInstanceState, Store } from "../src/task/mod.ts";
import { Trap } from "../src/cabi/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** The thread that traps when resumed. Ready only once `arm()` has run, so
 * the tick order below is fixed without relying on `chooseCandidate`. */
class TrappingThread {
  readonly task = { inst: { handles: [] as unknown[] } };
  #armed = false;
  arm(): void {
    this.#armed = true;
  }
  ready(): boolean {
    return this.#armed;
  }
  waiting(): boolean {
    return true;
  }
  resume(): never {
    this.#armed = false;
    throw new Trap("wasm trap: unreachable");
  }
}

Deno.test({
  name:
    "F4a: drive's throw path still hands sibling liveness to the settlement pump",
  fn: async () => {
    const store = new Store();
    const trapper = new TrappingThread();

    // The healthy SIBLING instance's thread: its resumption registers a real
    // host call (the async-lower shape) and arms the trapper.
    let settle!: () => void;
    const raw = new Promise<void>((r) => (settle = r));
    let registered = false;
    const sibling = {
      task: { inst: { handles: [] as unknown[] } },
      resumed: 0,
      awake: true,
      ready(): boolean {
        return this.awake;
      },
      waiting(): boolean {
        return true;
      },
      wake(): void {
        this.awake = true;
      },
      resume(): void {
        this.awake = false;
        this.resumed++;
        if (registered) return;
        registered = true;
        const call: Promise<void> = raw.then(() => {
          store.pendingHostCalls.delete(call);
          sibling.wake();
        });
        registerHostCall(store, call);
        trapper.arm();
      },
    };
    // deno-lint-ignore no-explicit-any
    store.startWaiting(sibling as any);
    // deno-lint-ignore no-explicit-any
    store.startWaiting(trapper as any);

    // A plain-mode lifted call whose own activation completes synchronously:
    // everything below happens in its `drive` loop.
    const impl = new ComponentInstanceState(1, store);
    const lifted = createDtorEntry({ dtor: () => undefined, instance: impl });

    let thrown: unknown;
    try {
      lifted(0);
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof Trap, `expected the sibling trap, got ${thrown}`);
    assertEq(sibling.resumed, 1);
    assertEq(store.pendingHostCalls.size, 1);

    // The sibling's host call answers. Its continuation readies the sibling
    // and deletes its own entry — readying is all it does; somebody has to
    // tick the store, and after a throwing exit that is the settlement pump.
    settle();
    for (let i = 0; i < 20 && sibling.resumed < 2; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }

    assert(
      sibling.resumed >= 2,
      "the healthy sibling was never resumed: `drive` threw without arming " +
        "the settlement pump, so its in-flight host call had no keeper",
    );
    assertEq(store.pendingHostCalls.size, 0);
  },
});

Deno.test({
  name:
    "F4b: driveAsync's trap exit leaves no unserviced sibling tail in store.settled",
  fn: async () => {
    const store = new Store();
    const trapper = new TrappingThread();

    // The sibling hop-parks when resumed (a promising entry settling one
    // microtask after the core call returns — jspi pin (j)).
    let settle!: (v: unknown) => void;
    const hop = new Promise<unknown>((r) => (settle = r));
    const sibling = {
      task: { inst: { handles: [] as unknown[] } },
      awake: true,
      awaiting: null as Promise<unknown> | null,
      tails: 0,
      ready(): boolean {
        return this.awake;
      },
      waiting(): boolean {
        return true;
      },
      resume(): void {
        this.awake = false;
        this.awaiting = hop;
        store.noteAwaiting(this, hop);
        trapper.arm();
      },
      resumeWith(): void {
        this.awaiting = null;
        store.awaiting.delete(this);
        this.tails++;
      },
    };
    // deno-lint-ignore no-explicit-any
    store.startWaiting(sibling as any);
    // deno-lint-ignore no-explicit-any
    store.startWaiting(trapper as any);

    const driving = driveStoreAsync(store, () => false, "export 'trapping'");
    let thrown: unknown;
    await driving.catch((e) => (thrown = e));
    assert(thrown instanceof Trap, `expected the sibling trap, got ${thrown}`);
    assertEq(store.awaiting.size, 1);

    // The hop lands. Its tail is queued in `store.settled`, which gates
    // `Store.tick` for EVERY later driver until someone services it.
    settle(undefined);
    for (let i = 0; i < 20 && sibling.tails === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }

    assert(
      sibling.tails === 1,
      "the sibling's activation tail was never serviced: `driveAsync` threw " +
        "and left it queued in `store.settled`, where it gates `Store.tick` " +
        "for every later driver",
    );
    assertEq(store.settled.length, 0);
  },
});
