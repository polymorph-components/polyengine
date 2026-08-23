// Guest cancellation of an in-flight HOST import (contracts/embedder-api.md
// §"Functions and async", amendment A23; polyengine#241).
//
// THE QUESTION A23 ANSWERS. `Store.invoke` takes the callee's `OnCancel` back
// from the callee itself — `on_cancel = f(on_start, on_resolve, caller = None)`
// (definitions.py line 572) — so the reference deliberately leaves a host
// callee's cancellation behaviour to the embedding. wasmtime hosts get a real
// one for free, because dropping a Rust future IS cancellation. A JS Promise
// offers no such channel, so polyengine answers on the host's behalf, and the
// DEFAULT answer is the reference's own prompt-cancel shape:
// `on_cancel = () => on_resolve(None)` (canon_lower's null branch, line ~2267).
//
// What that buys, and what it costs:
//
//   * the subtask resolves CANCELLED_BEFORE_RETURNED at once, so BOTH cancel
//     forms answer with a state instead of blocking or parking;
//   * the host promise's eventual settlement is DISCARDED — never lowered, a
//     rejection reported nowhere (the guest renounced the call; there is no
//     addressee), and deregistered from deadlock accounting;
//   * the host OPERATION is not interrupted — a Promise cannot be aborted from
//     outside, so its side effects still land. Discard is about DELIVERY.
//
// The last point is the hazard `deferCancel()` exists for: an import with a
// commit point marks itself and keeps the pre-A23 run-to-completion behaviour.
//
// These tests drive `createLoweredImport` + `createSubtaskCancel` directly,
// the same way tests/async_lower_test.ts does, so each step of the reference's
// state machine is observable.

import { assertEq } from "./support/asserts.ts";
import {
  createLoweredImport,
  newStats,
  type ResolvedOptions,
} from "../src/exec/boundary.ts";
import {
  ComponentInstanceState,
  EventCode,
  popCurrentThread,
  pushCurrentThread,
  Store,
  Subtask,
  SubtaskState,
  Task,
  type TaskOptions,
  Thread,
  unpackSubtaskResult,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";
import { BLOCKED, createSubtaskCancel } from "../src/intrinsics/async_builtins.ts";
import {
  abortable,
  deferCancel,
  isAbortable,
  isDeferCancel,
} from "../src/jspi/suspending.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** `func(x: u32) -> u32`, async-typed — the only shape that can be cancelled. */
const FT: FuncType = {
  params: [{ kind: "u32" }],
  results: [{ kind: "u32" }],
  async: true,
};

const TASK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

interface Fixture {
  store: Store;
  inst: ComponentInstanceState;
  memory: WebAssembly.Memory;
  call: (...args: number[]) => unknown;
  asGuest<T>(fn: () => T): T;
}

function mkFixture(hostFn: (...a: unknown[]) => unknown): Fixture {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = {
    addrType: "i32" as const,
    get bytes() {
      return new Uint8Array(memory.buffer);
    },
    get view() {
      return new DataView(memory.buffer);
    },
    get length() {
      return memory.buffer.byteLength;
    },
    ptrType: () => "i32" as const,
    ptrSize: () => 4 as const,
  };
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    // deno-lint-ignore no-explicit-any
    memory: view as any,
    realloc: null,
    postReturn: null,
    callback: null,
    async: true,
    cancellable: false,
    coreType: { params: ["i32", "i32"], results: ["i32"] },
    instance: inst,
  };
  const call = createLoweredImport({
    name: "host-fn",
    ft: FT,
    opts,
    hostFn,
    stats: newStats(),
    mode: "plain",
    suspendable: false,
    // Read off the host value exactly as `executor.ts buildLoweredImport`
    // reads it from the embedder's imports record.
    deferCancel: isDeferCancel(hostFn),
    // A24 likewise: the mark is read off the host value, and it is what makes
    // `createLoweredImport` append a fresh `AbortSignal` to every call.
    abortable: isAbortable(hostFn),
  }) as (...args: number[]) => unknown;

  const task = new Task(FT, TASK_OPTS, inst, () => [], () => {});
  const thread = new Thread(task, (function* () {})());

  return {
    store,
    inst,
    memory,
    call,
    asGuest<T>(fn: () => T): T {
      pushCurrentThread(thread);
      try {
        return fn();
      } finally {
        popCurrentThread(thread);
      }
    },
  };
}

/** A host promise this test settles by hand — the "still in flight" state. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The rejection arm is only settled inside a test that also handles it; the
  // guard keeps an un-awaited rejection from becoming an unhandled-rejection
  // failure of the whole test file.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Start a call and hand back its subtask, mid-flight. */
function inFlight(f: Fixture): { subtaski: number; subtask: Subtask } {
  const packed = f.asGuest(() => f.call(1, 64)) as number;
  const [state, subtaski] = unpackSubtaskResult(packed);
  assertEq(state, SubtaskState.STARTED);
  const subtask = f.inst.handles.get(subtaski) as Subtask;
  assertEq(subtask.resolved(), false);
  return { subtaski, subtask };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

Deno.test("A23: the async cancel form discards and answers CANCELLED_BEFORE_RETURNED", () => {
  // The headline: NOT BLOCKED. `canon_subtask_cancel` calls `on_cancel`, which
  // is now the prompt-cancel host, so `subtask.resolved()` is already true when
  // the built-in re-checks it — every parking branch is skipped and the tail
  // is `finish()`, which returns the state (async_builtins.ts:490-579).
  const d = deferred<number>();
  const f = mkFixture(() => d.promise);
  const { subtaski, subtask } = inFlight(f);

  const cancel = createSubtaskCancel({ async: true }, f.inst);
  const rc = f.asGuest(() => cancel(subtaski));
  assert(typeof rc === "number", `expected a state, got ${typeof rc}`);
  assert(rc !== BLOCKED, "the default host import cancels promptly");
  assertEq(rc, SubtaskState.CANCELLED_BEFORE_RETURNED);
  assertEq(subtask.state, SubtaskState.CANCELLED_BEFORE_RETURNED);
  assertEq(subtask.cancellationRequested, true);
  // `finish()` consumed the SUBTASK event the null `onResolve` armed, and
  // consuming it is what runs `deliverResolve` (subtask.ts:158-163).
  assertEq(subtask.resolveDelivered(), true);
  assertEq(subtask.hasPendingEvent(), false);
});

Deno.test("A23: the SYNC cancel form under jspi also answers synchronously (no park)", () => {
  // The sync form's jspi arm parks on `hasPendingEvent` and sets
  // `hasSyncWaiter` for the duration (SITE 5, async_builtins.ts). A prompt
  // cancel never reaches it: the subtask is resolved before the park decision,
  // so the built-in returns a NUMBER, not a thenable, and the flag never moved
  // (a stuck flag would make a later `waitable.join` trap spuriously — #87).
  const d = deferred<number>();
  const f = mkFixture(() => d.promise);
  const { subtaski, subtask } = inFlight(f);

  const cancel = createSubtaskCancel({ async: false }, f.inst, "jspi");
  const rc = f.asGuest(() => cancel(subtaski));
  assert(typeof rc === "number", `expected a number, got ${typeof rc}`);
  assert(
    !(rc !== null && typeof (rc as unknown as PromiseLike<unknown>) === "object"),
    "the sync form did not park",
  );
  assertEq(rc, SubtaskState.CANCELLED_BEFORE_RETURNED);
  assertEq(subtask.hasSyncWaiter, false);
  assertEq(subtask.resolveDelivered(), true);
});

Deno.test("A23: a late value settle after a discard is inert (no host failure)", async () => {
  // Pre-A23 this poisoned the store: the settle continuation called
  // `onResolve` unconditionally, which ran into its `state === STARTED` assert
  // ("on_resolve on a subtask that never started") and parked that
  // AssertionError on `store.hostFailure` — surfacing on whatever unrelated
  // embedder call came next. The `subtask.resolved()` guard in boundary.ts's
  // async arm is what makes the renounced value a no-op.
  const d = deferred<number>();
  const f = mkFixture(() => d.promise);
  const { subtaski, subtask } = inFlight(f);
  f.asGuest(() => createSubtaskCancel({ async: true }, f.inst)(subtaski));

  d.resolve(42);
  await flush();

  assertEq(f.store.hostFailure, undefined);
  assertEq(f.store.pendingHostCalls.size, 0);
  // Nothing was lowered: the retptr the guest supplied is untouched, and the
  // resolution is still the cancellation.
  assertEq(new DataView(f.memory.buffer).getUint32(64, true), 0);
  assertEq(subtask.state, SubtaskState.CANCELLED_BEFORE_RETURNED);
});

Deno.test("A23: a late REJECTION after a discard is inert (not a host failure)", async () => {
  // The guest renounced the call, so there is no addressee for the error.
  // Pre-A23 the rejection landed on `store.hostFailure` unconditionally and
  // failed the next call into the instance with the error of an operation
  // nobody was waiting for.
  const d = deferred<number>();
  const f = mkFixture(() => d.promise);
  const { subtaski } = inFlight(f);
  f.asGuest(() => createSubtaskCancel({ async: true }, f.inst)(subtaski));

  d.reject(new Error("the renounced host call failed"));
  await flush();

  assertEq(f.store.hostFailure, undefined);
  assertEq(f.store.pendingHostCalls.size, 0);
});

Deno.test("A23: a discarded call stops counting for deadlock detection", () => {
  // `pendingHostCalls` is the driver's "progress is still possible, just not
  // this turn" evidence (`driveAsync`: `pendingHostCalls.size === 0` is a
  // precondition of the deadlock verdict). A renounced call can no longer wake
  // the guest, so leaving it registered would suppress a genuine deadlock
  // verdict for as long as the host promise stays pending — here, forever.
  const d = deferred<number>();
  const f = mkFixture(() => d.promise);
  const { subtaski } = inFlight(f);
  assertEq(f.store.pendingHostCalls.size, 1);

  f.asGuest(() => createSubtaskCancel({ async: true }, f.inst)(subtaski));

  // Deregistered at cancel time, while the underlying promise is still pending.
  assertEq(f.store.pendingHostCalls.size, 0);
});

Deno.test("A23: a discard releases the subtask's lenders, exactly like a RETURNED delivery", () => {
  // The #106 class: a subtask that breaks off without delivering its
  // resolution leaves every handle it borrowed elevated forever, and later
  // `resource.drop`s trap "handle still lent out" on a perfectly healthy
  // instance. Discard is safe from that class *because* it goes through the
  // ordinary delivery path — `onResolve(null)` resolves and the built-in's
  // `finish()` consumes the event, which runs `deliverResolve`.
  const d = deferred<number>();
  const f = mkFixture(() => d.promise);
  const { subtaski, subtask } = inFlight(f);

  const lendable = { numLends: 0 };
  subtask.addLender(lendable as unknown as Parameters<Subtask["addLender"]>[0]);
  assertEq(lendable.numLends, 1);

  f.asGuest(() => createSubtaskCancel({ async: true }, f.inst)(subtaski));

  assertEq(subtask.resolveDelivered(), true);
  assertEq(lendable.numLends, 0);
});

Deno.test("A23: deferCancel() keeps run-to-completion — BLOCKED, then the real result", async () => {
  // The opt-out, end-to-end at this layer: the marked import's `onCancel` stays
  // the accept-and-ignore no-op, so the subtask is still unresolved when
  // `canon_subtask_cancel` re-checks it and the async form answers BLOCKED
  // (definitions.py line 2486). The settle then takes the ordinary path.
  const d = deferred<number>();
  const f = mkFixture(deferCancel(() => d.promise));
  const { subtaski, subtask } = inFlight(f);

  const rc = f.asGuest(() => createSubtaskCancel({ async: true }, f.inst)(subtaski));
  assertEq(rc, BLOCKED);
  assertEq(subtask.resolved(), false);
  assertEq(subtask.state, SubtaskState.STARTED);

  d.resolve(7);
  await flush();

  assertEq(f.store.hostFailure, undefined);
  assertEq(subtask.state, SubtaskState.RETURNED);
  assertEq(new DataView(f.memory.buffer).getUint32(64, true), 7);
  // The guest observes RETURNED through the pending SUBTASK event, carrying
  // the real result — as if the cancellation had never been requested.
  assertEq(subtask.resolveDelivered(), false);
  const [code, index, payload] = subtask.getPendingEvent();
  assertEq(code, EventCode.SUBTASK);
  assertEq(index, subtaski);
  assertEq(payload, SubtaskState.RETURNED);
  assertEq(subtask.resolveDelivered(), true);
});

Deno.test("A23: subtask.drop succeeds after a discard", () => {
  // `Subtask.drop` traps unless the resolution was DELIVERED (definitions.py
  // `Subtask.drop`, line 912). Discard delivers, so the guest's ordinary
  // epilogue — cancel, then drop the handle — works with no special casing.
  const d = deferred<number>();
  const f = mkFixture(() => d.promise);
  const { subtaski, subtask } = inFlight(f);
  f.asGuest(() => createSubtaskCancel({ async: true }, f.inst)(subtaski));

  const removed = f.inst.handles.remove(subtaski) as Subtask;
  assert(removed === subtask, "the handle table returned our subtask");
  removed.drop();
  assertEq([...f.inst.handles].length, 0);
});

// ---------------------------------------------------------------------------
// A24: the per-call AbortSignal (contracts/embedder-api.md §"Functions and
// async"; polyengine#241)
// ---------------------------------------------------------------------------
//
// A23's discard is about DELIVERY: the host operation runs on, and a
// discarded dial keeps dialing. `abortable()` hands the host the platform's
// own cancellation vocabulary — every call of a marked import gets a fresh
// `AbortSignal`, and the runtime aborts it when, and only when, the call is
// discarded. Two properties these tests exist to keep apart: the SIGNATURE is
// unconditional (a marked import always receives a signal), the ABORT is
// discard-only and DEFERRED one microtask past the cancel built-in — host
// listeners must never run inside a live guest activation.

/** Record what the host actually received, call by call. */
function recorder(result: () => unknown) {
  const seen: { count: number; last: unknown } = { count: 0, last: undefined };
  const fn = function (...a: unknown[]) {
    seen.count = a.length;
    seen.last = a[a.length - 1];
    return result();
  };
  return { seen, fn };
}

Deno.test("A24: a marked import receives WIT arity + 1, the extra arg an unaborted AbortSignal", () => {
  // The signature is the mark's unconditional half: `FT` declares one param,
  // so a marked host fn is called with two — the lifted `u32` and the signal.
  const d = deferred<number>();
  const r = recorder(() => d.promise);
  const f = mkFixture(abortable(r.fn));
  inFlight(f);

  assertEq(r.seen.count, FT.params.length + 1);
  assert(
    r.seen.last instanceof AbortSignal,
    `expected an AbortSignal, got ${typeof r.seen.last}`,
  );
  // Nothing has been cancelled, so the signal is inert at call time.
  assertEq((r.seen.last as AbortSignal).aborted, false);
});

Deno.test("A24: an UNMARKED import receives exactly WIT arity (no stray signal)", () => {
  // The control for the test above: the mark is what appends the signal, so
  // an unmarked import's arity must not move. A stray trailing argument would
  // land on a host implementation that declared an optional parameter and
  // silently change its behaviour.
  const d = deferred<number>();
  const r = recorder(() => d.promise);
  const f = mkFixture(r.fn);
  inFlight(f);

  assertEq(r.seen.count, FT.params.length);
  assertEq(r.seen.last, 1);
});

Deno.test("A24: a discard aborts the signal — one microtask LATER, never inside the built-in", async () => {
  // The ordering guarantee. `onCancel` runs synchronously inside
  // `canon_subtask_cancel`, i.e. inside a live guest activation; running host
  // abort listeners there is the issue-#24 attribution class plus arbitrary
  // re-entrancy. So the guest sees CANCELLED_BEFORE_RETURNED first and the
  // host sees the abort a tick later.
  const d = deferred<number>();
  const r = recorder(() => d.promise);
  const f = mkFixture(abortable(r.fn));
  const { subtaski } = inFlight(f);
  const signal = r.seen.last as AbortSignal;

  const rc = f.asGuest(() =>
    createSubtaskCancel({ async: true }, f.inst)(subtaski)
  );
  assertEq(rc, SubtaskState.CANCELLED_BEFORE_RETURNED);
  // SYNCHRONOUSLY after the built-in returned: still unaborted. This is the
  // assertion that pins the deferral rather than merely the abort.
  assertEq(signal.aborted, false);

  await Promise.resolve();
  assertEq(signal.aborted, true);
});

Deno.test("A24: an AbortError rejection provoked by the abort is inert", async () => {
  // The composition with A23's guards: the host reacts to the abort by
  // rejecting, and that rejection belongs to a call the guest renounced. It
  // reaches the settle continuation with the subtask already resolved, so it
  // is discarded like any other late settlement — never `store.hostFailure`,
  // which would fail whatever unrelated embedder call came next.
  const d = deferred<number>();
  const r = recorder(() => d.promise);
  const f = mkFixture(abortable(r.fn));
  const { subtaski, subtask } = inFlight(f);
  const signal = r.seen.last as AbortSignal;
  signal.addEventListener("abort", () => {
    d.reject(new DOMException("the dial was aborted", "AbortError"));
  });

  f.asGuest(() => createSubtaskCancel({ async: true }, f.inst)(subtaski));
  await flush();

  assertEq(signal.aborted, true);
  assertEq(f.store.hostFailure, undefined);
  assertEq(f.store.pendingHostCalls.size, 0);
  assertEq(subtask.state, SubtaskState.CANCELLED_BEFORE_RETURNED);
});

Deno.test("A24: deferCancel + abortable — cancellation never discards, so the signal never fires", async () => {
  // The inert composition the contract calls out. A `deferCancel()` import's
  // cancellation is accepted and ignored (BLOCKED, then the real result), so
  // no discard ever happens and the signal — minted, because the signature is
  // unconditional — stays unaborted for the life of the call.
  const d = deferred<number>();
  const r = recorder(() => d.promise);
  const f = mkFixture(abortable(deferCancel(r.fn)));
  const { subtaski, subtask } = inFlight(f);
  const signal = r.seen.last as AbortSignal;
  assertEq(r.seen.count, FT.params.length + 1);

  const rc = f.asGuest(() =>
    createSubtaskCancel({ async: true }, f.inst)(subtaski)
  );
  assertEq(rc, BLOCKED);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assertEq(signal.aborted, false);

  d.resolve(7);
  await flush();

  assertEq(signal.aborted, false);
  assertEq(f.store.hostFailure, undefined);
  assertEq(subtask.state, SubtaskState.RETURNED);
  assertEq(new DataView(f.memory.buffer).getUint32(64, true), 7);
  const [code, index, payload] = subtask.getPendingEvent();
  assertEq(code, EventCode.SUBTASK);
  assertEq(index, subtaski);
  assertEq(payload, SubtaskState.RETURNED);
});

Deno.test("A24: no cancellation, no abort — a marked import settles normally", async () => {
  // Discard-only, stated positively: an ordinary call of a marked import runs
  // to its natural settlement with the signal untouched, and delivers.
  const d = deferred<number>();
  const r = recorder(() => d.promise);
  const f = mkFixture(abortable(r.fn));
  const { subtaski, subtask } = inFlight(f);
  const signal = r.seen.last as AbortSignal;

  d.resolve(9);
  await flush();

  assertEq(signal.aborted, false);
  assertEq(f.store.hostFailure, undefined);
  assertEq(f.store.pendingHostCalls.size, 0);
  assertEq(subtask.state, SubtaskState.RETURNED);
  assertEq(new DataView(f.memory.buffer).getUint32(64, true), 9);
  const [code, index, payload] = subtask.getPendingEvent();
  assertEq(code, EventCode.SUBTASK);
  assertEq(index, subtaski);
  assertEq(payload, SubtaskState.RETURNED);
});
