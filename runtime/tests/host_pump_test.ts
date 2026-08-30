// Host-stream pumping between export calls — regressions for C0 findings
// R-1 and R-2, plus a pin on the documented embedder-never-acts behaviour.
//
// WHY THESE ARE STORE-LEVEL AND NOT END-TO-END
// ===========================================
//
// The shape that exposes R-1 is a guest whose stream *writer* is parked on a
// Promise-returning host import while the host reads the exported stream with
// no export call in flight. None of the checked-in example guests
// (examples/guests/**) has an import at all — the shape lives in the
// out-of-tree polymorph-iroh exec-model guest, which the runtime test suite
// cannot depend on. So these tests model the same three participants directly:
//
//   * a `Store` and a fake guest thread (the same `SchedulableThread` surface
//     `Store.tick` uses: `ready`/`waiting`/`resume`/`task.inst`);
//   * a host import modelled exactly as the async-lower registration site in
//     exec/boundary.ts does it — `createLoweredImport`'s `isPromiseLike(raw)`
//     branch, the `Promise.resolve(raw).then(...)` whose continuations
//     `store.pendingHostCalls.delete(promise)` and then `onResolve`, followed
//     by `store.pendingHostCalls.add(promise)` (currently ~1534-1548): a
//     promise registered in `store.pendingHostCalls` whose settlement readies
//     the guest thread and *does not tick the store*;
//   * a real host stream end (`hostStreamFor` over a real
//     `SharedStreamImpl`), so the rendezvous and `HostActivity` under test are
//     the production ones.
//
// Verified to fail on the pre-fix runtime: R-1 times out (the host read never
// resolves past the first chunk), R-2 reports `store.hostFailure` set to
// `TypeError: Cannot read properties of undefined (reading 'awaiting')`.

import { assertEq } from "./support/asserts.ts";
import { hostStreamFor } from "../src/exec/mod.ts";
import { SharedStreamImpl, Store } from "../src/task/mod.ts";
import type { ComponentValue, ValType } from "../src/cabi/types.ts";

const U8: ValType = { kind: "u8" };

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** The slice of `ComponentInstance` that `Store.tick` touches. */
function fakeInst() {
  return {
  };
}

/**
 * A stand-in for a guest thread: `Store.tick` resumes it whenever `ready()`,
 * and `resume()` runs one step of `body`.
 */
class FakeThread {
  #ready: boolean;
  readonly task: { inst: ReturnType<typeof fakeInst> };
  constructor(private readonly body: () => void, ready = true) {
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
  park(): void {
    this.#ready = false;
  }
  resume(): void {
    this.#ready = false;
    this.body();
  }
}

/** A host stream end wired to `store`, as `liftStream` would have wired it. */
function hostEndOn<T>(store: Store, element: ValType | null) {
  const shared = new SharedStreamImpl(element);
  (shared as unknown as { boundStore: unknown }).boundStore = store;
  return {
    shared,
    host: hostStreamFor<T>(shared as unknown as ComponentValue),
  };
}

const GUEST_INSTANCE = Object.freeze({ fakeGuest: true });

/** A writable buffer over a JS array, the guest side of the rendezvous. */
class SrcBuffer {
  progress = 0;
  readonly taken: unknown[] = [];
  constructor(readonly t: ValType | null, private readonly values: number[]) {}
  remain(): number {
    return this.values.length - this.progress;
  }
  isZeroLength(): boolean {
    return this.values.length === 0;
  }
  read(n: number): unknown[] {
    const out = this.values.slice(this.progress, this.progress + n);
    this.progress += n;
    return out;
  }
  write(vs: unknown[]): void {
    for (const v of vs) this.taken.push(v);
    this.progress += vs.length;
  }
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

// ---------------------------------------------------------------------------
// R-1
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "R-1: a host read completes while the guest writer parks on an async host import",
  fn: async () => {
    const store = new Store();
    const { shared, host } = hostEndOn<number>(store, U8);

    const CHUNKS = 5;
    const CHUNK = 4;
    let chunk = 0;

    // The guest's detached pump task: write one chunk, then "call" a
    // Promise-returning host import and park until it settles. The import is
    // registered exactly as `createLoweredImport`'s `isPromiseLike(raw)`
    // branch does it (boundary.ts, the `Promise.resolve(raw).then(...)` /
    // `store.pendingHostCalls.add(promise)` pair, currently ~1534-1548): into
    // `store.pendingHostCalls`, with a settle continuation that readies the
    // guest but does NOT tick the store — only a driving loop does that, and
    // between export calls the only driving loop is the host pump under
    // test.
    const guest: FakeThread = new FakeThread(() => {
      if (chunk === CHUNKS) {
        shared.drop(); // end of stream
        return;
      }
      const values = Array.from({ length: CHUNK }, (_, i) => chunk * CHUNK + i);
      chunk++;
      const src = new SrcBuffer(U8, values);
      shared.write(
        GUEST_INSTANCE,
        src as never,
        (reclaim) => reclaim(),
        () => {},
      );
      // The host import: settles a macrotask later.
      const p: Promise<void> = new Promise<void>((r) => setTimeout(r, 1)).then(
        () => {
          store.pendingHostCalls.delete(p);
          guest.wake();
        },
      );
      store.pendingHostCalls.add(p);
    });
    store.startWaiting(guest);

    const got: number[] = [];
    for (let i = 0; i < CHUNKS + 2; i++) {
      const vs = await withTimeout(host.readable.read(64), `read#${i}`);
      if (vs.length === 0) break;
      got.push(...vs);
    }
    assertEq(got.length, CHUNKS * CHUNK);
    assertEq(got[0], 0);
    assertEq(got[got.length - 1], CHUNKS * CHUNK - 1);
    assertEq(store.hostFailure, undefined);
    host.readable.drop();
  },
});

// ---------------------------------------------------------------------------
// R-2
// ---------------------------------------------------------------------------

/** A promise-parked (jspi-style) activation, as `Store.awaiting` holds them. */
function mkParked(store: Store, promise: Promise<unknown>) {
  const t = {
    awaiting: promise as Promise<unknown> | null,
    resumed: 0,
    resumeWith(_v: unknown, _f?: { error: unknown }) {
      this.resumed++;
      this.awaiting = null;
      store.awaiting.delete(this);
    },
  };
  store.noteAwaiting(t, promise);
  return t;
}

Deno.test({
  name: "R-2: a concurrently emptied `awaiting` set does not poison the store",
  fn: async () => {
    // The shape: the pump is running (a host read parked with promise-parked
    // activations outstanding) and a CONCURRENT driver — an in-flight export
    // call's `driveAsync`, whose race path resumes whichever thread settled —
    // takes a thread out of `store.awaiting` while the pump is suspended
    // across an `await`. The pre-fix `#drainAsync` re-read
    // `[...store.awaiting][0]` after that `await` without re-checking
    // emptiness and threw
    //   `TypeError: Cannot read properties of undefined (reading 'awaiting')`
    // into `store.hostFailure`, from where the next, unrelated export call
    // rethrew it — one stalled host stream poisoning the whole instance.
    //
    // The interleaving that hits the window depends on how many microtask
    // hops the pump has taken, so sweep the offset rather than betting on one
    // schedule; the assertion is the invariant (`hostFailure` stays clear and
    // later work is unaffected), not a particular ordering.
    for (let hops = 0; hops <= 6; hops++) {
      const store = new Store();
      const { shared, host } = hostEndOn<number>(store, U8);

      // One activation whose promise is already settled (so the settled-tail
      // queue is non-empty, which is what makes the pump take an extra hop),
      // and one that never settles on its own.
      mkParked(store, Promise.resolve());
      const stuck = mkParked(store, new Promise<void>(() => {}));

      const reading = host.readable.read(8);

      // The concurrent driver.
      const other = (async () => {
        for (let i = 0; i < hops; i++) await Promise.resolve();
        if (store.awaiting.has(stuck)) stuck.resumeWith(undefined);
      })();

      await other;
      await new Promise((r) => setTimeout(r, 2));
      assert(
        store.hostFailure === undefined,
        `hops=${hops}: pump poisoned the store: ${store.hostFailure}`,
      );

      // The read still works, and a later unrelated operation on the same
      // store sees a clean `hostFailure` channel.
      const src = new SrcBuffer(U8, [1, 2, 3]);
      shared.write(
        GUEST_INSTANCE,
        src as never,
        (reclaim) => reclaim(),
        () => {},
      );
      assertEq((await withTimeout(reading, `raced read hops=${hops}`)).length, 3);
      host.readable.drop();
      await new Promise((r) => setTimeout(r, 2));
      assert(
        store.hostFailure === undefined,
        `hops=${hops}: a later operation inherited a failure: ${store.hostFailure}`,
      );
    }
  },
});

// ---------------------------------------------------------------------------
// The documented embedder-never-acts semantics (host_streams.ts module header)
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "host pump: an embedder that never does its half hangs — no trap, no spin",
  fn: async () => {
    const store = new Store();
    const { host } = hostEndOn<number>(store, U8);

    // Instrument the scheduler: a busy-spinning pump would keep calling
    // `tick` (and/or `serviceSettled`) forever while nothing can progress.
    let ticks = 0;
    const realTick = store.tick.bind(store);
    (store as unknown as { tick: () => boolean }).tick = () => {
      ticks++;
      return realTick();
    };

    // Nobody is on the other end and no guest thread exists: the read can
    // never be satisfied. Documented outcome: it stays pending.
    let settled = "pending";
    host.readable.read(8).then(
      () => (settled = "resolved"),
      (e) => (settled = `rejected: ${(e as Error).message}`),
    );
    const afterFirstPump = ticks;

    // Bounded probe: many macrotask turns must pass with no further ticking
    // (no spin), no rejection and no trap parked in `hostFailure` (no false
    // deadlock detection).
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));

    assertEq(settled, "pending");
    assertEq(store.hostFailure, undefined);
    assert(
      ticks === afterFirstPump,
      `pump kept ticking while parked: ${afterFirstPump} -> ${ticks}`,
    );

    // And the hang is a *hang*, not a wedge: the embedder doing its half
    // still resolves it.
    host.readable.drop();
    await new Promise((r) => setTimeout(r, 1));
    assertEq(settled, "resolved");
  },
});
