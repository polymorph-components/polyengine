// A trap raised by `HostActivity.pump()`'s SYNCHRONOUS half is mishandled.
//
// Every host stream/future op sets `parked.write`/`parked.read` and then calls
// `activity.pump()` from INSIDE its `new Promise(executor)`. `pump()`'s
// `serviceSettled()/tick()` loop has no try/catch, so a guest thread that
// traps under that `tick` throws out through the executor. Two outcomes, both
// wrong (exec/host_streams.ts:373-394 vs the `#pumpAsync` catch at :447-451):
//   (a) the trapping instance held an end of this stream — the poison
//       retirement walk already settled the op's promise, so the executor's
//       throw lands on a settled promise and is DISCARDED; nothing records
//       `store.hostFailure`. A component fault is "always loud"
//       (contracts/embedder-api.md §"Streams and futures"); this one is mute.
//   (b) the trapping instance held no end — the promise rejects, but
//       `parked.*` stays true and the host buffer stays in the shared pending
//       slot, so the end is wedged: every later op throws "already in flight".

import { assertEq } from "./support/asserts.ts";
import { hostStreamFor } from "../src/exec/mod.ts";
import { ReadableStreamEnd, SharedStreamImpl, Store } from "../src/task/mod.ts";
import { Trap } from "../src/cabi/trap.ts";
import type { ComponentValue, ValType } from "../src/cabi/types.ts";

const U8: ValType = { kind: "u8" };

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/**
 * The slice of `ComponentInstance` the poisoning path touches: `Store.tick`
 * routes a resume trap through `notifyInstancePoisoned`, whose walk
 * (task/streams.ts `retireInstanceAsyncEnds`) iterates `inst.handles` looking
 * for `CopyEnd`s. `handles: []` = an instance holding no stream end.
 */
function fakeInst(handles: unknown[] = []) {
  return { handles };
}

/** A guest thread stand-in; `Store.tick` resumes it whenever `ready()`. */
class FakeThread {
  #ready = true;
  readonly task: { inst: ReturnType<typeof fakeInst> };
  constructor(
    private readonly body: () => void,
    inst: ReturnType<typeof fakeInst>,
  ) {
    this.task = { inst };
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
  park(): void {
    this.#ready = false;
  }
  resume(): void {
    this.#ready = false;
    this.body();
  }
}

/** A host stream end wired to `store`, as a lower into a guest would wire it. */
function hostEndOn<T>(store: Store, element: ValType | null) {
  const shared = new SharedStreamImpl(element);
  (shared as unknown as { boundStore: unknown }).boundStore = store;
  return {
    shared,
    host: hostStreamFor<T>(shared as unknown as ComponentValue),
  };
}

/** Bounded settle probe — N macrotask turns, no long sleeps. */
async function settleTurns(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// (b) the trapping instance holds no end of this stream: the end must not be
//     left permanently "in flight".
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "host write: a trap from the sync pump does not wedge the writable end in flight",
  fn: async () => {
    const store = new Store();
    const { host } = hostEndOn<number>(store, U8);

    // A ready thread of an unrelated instance (no stream ends) that traps the
    // moment the host op's `pump()` ticks the store.
    const trap = new Trap("boom");
    store.startWaiting(
      new FakeThread(() => {
        throw trap;
      }, fakeInst()),
    );

    const first = host.writable.write([1]);
    let firstErr: unknown = undefined;
    let firstOk = false;
    first.then(() => (firstOk = true), (e) => (firstErr = e));
    await settleTurns(3);
    assert(
      firstOk || firstErr !== undefined,
      "the first write neither resolved nor rejected",
    );

    // The fault has been delivered (or recorded). The END, however, belongs
    // to the embedder and must still be usable: the trap was raised by an
    // instance that holds no end of this stream, so nothing about this
    // stream's state legitimately changed.
    let second: Promise<number> | undefined;
    let secondThrow: unknown = undefined;
    try {
      second = host.writable.write([2]);
    } catch (e) {
      secondThrow = e;
    }
    assert(
      secondThrow === undefined,
      `the writable end is wedged after the pump trap: ${
        (secondThrow as Error)?.message
      }`,
    );
    second?.catch(() => {});
    host.writable.drop();
    await settleTurns(2);
  },
});

Deno.test({
  name:
    "host read: a trap from the sync pump does not wedge the readable end in flight",
  fn: async () => {
    const store = new Store();
    const { host } = hostEndOn<number>(store, U8);

    const trap = new Trap("boom");
    store.startWaiting(
      new FakeThread(() => {
        throw trap;
      }, fakeInst()),
    );

    const first = host.readable.read(8);
    let settled = false;
    first.then(() => (settled = true), () => (settled = true));
    await settleTurns(3);
    assert(settled, "the first read neither resolved nor rejected");

    let second: Promise<number[]> | undefined;
    let secondThrow: unknown = undefined;
    try {
      second = host.readable.read(8);
    } catch (e) {
      secondThrow = e;
    }
    assert(
      secondThrow === undefined,
      `the readable end is wedged after the pump trap: ${
        (secondThrow as Error)?.message
      }`,
    );
    second?.catch(() => {});
    host.readable.drop();
    await settleTurns(2);
  },
});

// ---------------------------------------------------------------------------
// (a) the trapping instance holds an end of THIS stream: the fault must stay
//     loud (embedder-api.md §"Streams and futures").
// ---------------------------------------------------------------------------

Deno.test({
  name: "host write: a trap from the sync pump is not swallowed silently",
  fn: async () => {
    const store = new Store();
    const shared = new SharedStreamImpl(U8);
    (shared as unknown as { boundStore: unknown }).boundStore = store;
    const host = hostStreamFor<number>(shared as unknown as ComponentValue);

    // This time the trapping instance holds the guest end of the very stream
    // the host is writing to: `Store.tick`'s poisoning path runs the
    // retirement walk over `handles`, which drops `shared` and settles our
    // parked write (DROPPED-shaped) BEFORE the trap propagates out of
    // `pump()` — so the executor's throw hits an already-settled promise.
    const guestEnd = new ReadableStreamEnd(shared);
    const trap = new Trap("boom");
    store.startWaiting(
      new FakeThread(() => {
        throw trap;
      }, fakeInst([guestEnd])),
    );

    const p = host.writable.write([1]);
    let rejected: unknown = undefined;
    let resolved: number | undefined = undefined;
    await p.then((n) => (resolved = n), (e) => (rejected = e));
    await settleTurns(3);

    // Loud, one way or the other: either the op rejects with the fault, or the
    // driver channel carries it (what `#pumpAsync` does with the same trap).
    assert(
      rejected !== undefined || store.hostFailure !== undefined,
      `the component fault was swallowed: write resolved ${resolved}, ` +
        `store.hostFailure=${store.hostFailure}`,
    );
    if (rejected !== undefined) assertEq(rejected, trap);
    await settleTurns(2);
  },
});
