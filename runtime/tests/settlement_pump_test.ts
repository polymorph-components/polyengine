// The settlement pump (exec/boundary.ts): liveness between export calls.
//
// A host-import promise that settles while NO driver is live only mutates
// scheduler state — the registration site's continuation readies the guest
// thread but nothing ticks the store. Before the settlement pump, that work
// sat queued until the next export call or host stream/future operation; a
// guest whose wakeup is a host clock (the componentize-go keep-alive-ticker
// shape: a task parked WAIT whose pending host call is a wasi:clocks
// `wait-for`) was frozen between embedder calls. These tests pin the pump's
// contract at store level, in the style of host_pump_test.ts:
//
//   * a `Store` and a fake guest thread (the `SchedulableThread` surface);
//   * host imports modelled exactly as the async-lower registration site in
//     exec/boundary.ts does it: a promise in `store.pendingHostCalls` whose
//     settle continuation deletes itself and readies the guest, and does NOT
//     tick the store;
//   * "an export call just returned" modelled as one `driveStoreAsync` round
//     with an immediately-true `done` — the pump is armed at driver exit.
//
// Verified against the pre-pump runtime: T-1 and T-2 time out (the guest is
// never resumed), T-3 and T-4 pass vacuously/identically.

import { assertEq } from "./support/asserts.ts";
import { driveStoreAsync } from "../src/exec/mod.ts";
import { markHostActivityArm, Store } from "../src/task/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** The slice of `ComponentInstance` that `Store.tick` touches. */
function fakeInst() {
  return {
  };
}

/** A stand-in guest thread: `Store.tick` resumes it whenever `ready()`. */
class FakeThread {
  #ready: boolean;
  readonly task: { inst: ReturnType<typeof fakeInst> };
  constructor(private readonly body: () => void, ready = false) {
    this.#ready = ready;
    this.task = { inst: fakeInst() };
  }
  ready(): boolean {
    return this.#ready;
  }
  waiting(): boolean {
    return !this.#ready;
  }
  wake(): void {
    this.#ready = true;
  }
  resume(): void {
    this.#ready = false;
    this.body();
  }
}

/**
 * Register a host import exactly as `createLoweredImport`'s async arm does
 * (boundary.ts: delete from `pendingHostCalls`, deliver, and here "deliver"
 * readies the guest — never a tick).
 */
function hostImport(store: Store, settle: Promise<unknown>, onSettle: () => void): void {
  const p: Promise<void> = settle.then(() => {
    store.pendingHostCalls.delete(p);
    onSettle();
  });
  store.pendingHostCalls.add(p);
}

function withTimeout<T>(p: Promise<T>, label: string, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, rj) => {
      timer = setTimeout(() => rj(new Error(`TIMEOUT ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

/** One export-call round, as far as the pump is concerned: drive, exit. */
async function exportCallReturns(store: Store): Promise<void> {
  await driveStoreAsync(store, () => true, "test: export call returns");
}

Deno.test({
  name:
    "T-1: a host-call settlement resumes a parked guest with no embedder activity",
  fn: async () => {
    const store = new Store();
    let resolved!: () => void;
    const ran = new Promise<void>((r) => (resolved = r));

    const guest = new FakeThread(() => resolved());
    store.startWaiting(guest);

    // The guest called an async host import during "the export call"; the
    // import settles a macrotask later, long after the call returned.
    hostImport(store, new Promise((r) => setTimeout(r, 5)), () => guest.wake());
    await exportCallReturns(store);

    // No further embedder activity of any kind.
    await withTimeout(ran, "guest resumed by the settlement pump");
    assertEq(store.hostFailure, undefined);
    // Let the pump unwind to quiescence before the sanitizers look.
    await new Promise((r) => setTimeout(r, 2));
  },
});

Deno.test({
  name: "T-2: a self-re-arming host call sustains progress (keep-alive ticker shape)",
  fn: async () => {
    const store = new Store();
    const ROUNDS = 5;
    let round = 0;
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));

    // Each resume re-arms a fresh host import — registered DURING the pump's
    // own drive, which is the stale-snapshot case the nudge machinery covers.
    const guest: FakeThread = new FakeThread(() => {
      round++;
      if (round === ROUNDS) {
        done();
        return;
      }
      hostImport(store, new Promise((r) => setTimeout(r, 1)), () => guest.wake());
    });
    store.startWaiting(guest);

    hostImport(store, new Promise((r) => setTimeout(r, 1)), () => guest.wake());
    await exportCallReturns(store);

    await withTimeout(finished, `all ${ROUNDS} ticker rounds`);
    assertEq(round, ROUNDS);
    assertEq(store.hostFailure, undefined);
    await new Promise((r) => setTimeout(r, 2));
  },
});

Deno.test({
  name: "T-3: activity arms alone never arm the pump — no ticks, no trap, no spin",
  fn: async () => {
    const store = new Store();

    let ticks = 0;
    const realTick = store.tick.bind(store);
    (store as unknown as { tick: () => boolean }).tick = () => {
      ticks++;
      return realTick();
    };

    // Only a host-activity arm is outstanding: "the embedder may still act"
    // is exactly the state where between-calls drivers must stay parked (the
    // documented hang, host_streams.ts module header).
    const arm = new Promise<void>(() => {});
    markHostActivityArm(arm);
    store.pendingHostCalls.add(arm);

    await exportCallReturns(store);
    const after = ticks;

    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
    assertEq(ticks, after);
    assertEq(store.hostFailure, undefined);
  },
});

Deno.test({
  name: "T-4: a settlement-time failure parks on hostFailure for the next call",
  fn: async () => {
    const store = new Store();
    const boom = new Error("host import rejected");

    // Modelled on the async arm's rejection continuation (boundary.ts): the
    // site parks the failure; the pump must neither swallow nor spin on it.
    const p: Promise<void> = new Promise((_, rj) => setTimeout(() => rj(boom), 5))
      .then(undefined, (e) => {
        store.pendingHostCalls.delete(p);
        store.hostFailure = e;
      });
    store.pendingHostCalls.add(p);
    await exportCallReturns(store);

    // Wait out the settlement plus pump unwind.
    await new Promise((r) => setTimeout(r, 20));
    assertEq(store.hostFailure, boom);

    // The next driving call surfaces it — the existing channel, unchanged.
    let caught: unknown;
    try {
      await driveStoreAsync(store, () => false, "test: next call");
    } catch (e) {
      caught = e;
    }
    assertEq(caught, boom);
    assertEq(store.hostFailure, undefined);
  },
});
