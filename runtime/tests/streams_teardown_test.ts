// #84 / #90 / #97: what a *future*'s reader observes when the writable side
// goes away without ever delivering a value.
//
// Background. `SharedStreamImpl` and `SharedFutureImpl` share a rendezvous
// shape, but they do NOT share this outcome: a stream reader may observe
// `CopyResult.DROPPED` (that is end-of-stream), a future reader may not
// (definitions.py:2607 asserts it). The reference keeps the state unreachable
// by trapping an early writable-future drop (definitions.py:1183-1184) — a
// guarantee a *trap-poisoned* instance can no longer be asked to honour, and
// one the host's public `drop()` door bypasses too. Both are handled by the
// same mechanism: the future is marked abandoned (task/streams.ts
// `abandonSharedFuture` / the retirement walk) and its reader gets a `Trap` at
// its rendezvous point — never DROPPED, never COMPLETED, never a hang, never
// an internal `AssertionError`.
//
// Reader timings covered here:
//   (a) parked async reader (callback ABI) — the trap arrives through
//       waitable-set delivery;
//   (b) parked sync/JSPI reader — the trap arrives as the suspension point's
//       rejection (`produce` throws);
//   (c) reader that has not parked yet — `future.read` traps on the spot.
//
// Harness note: these are direct built-in tests (the `async_builtins_test.ts`
// pattern) rather than guest-fixture tests. The states under test need two
// component instances, one of which is poisoned mid-park with a *specific*
// end-ownership split; the existing `examples/guests/stream-pass` fixture
// cannot express the read-after-teardown and multi-end-walk shapes at all,
// and the host-side machinery reaches every one of them exactly.

import { assertEq } from "./support/asserts.ts";
import { AssertionError, Trap } from "../src/cabi/mod.ts";
import {
  createFutureRead,
  createStreamRead,
} from "../src/intrinsics/stream_builtins.ts";
import {
  BLOCKED,
  createWaitableSetWait,
} from "../src/intrinsics/async_builtins.ts";
import type { ResolvedOptions } from "../src/exec/boundary.ts";
import { HostBuffer, hostFuture, hostStream } from "../src/exec/mod.ts";
import {
  BUFFER_MAX_LENGTH,
  ComponentInstanceState,
  CopyResult,
  CopyState,
  isInstancePoisoned,
  notifyInstancePoisoned,
  popCurrentThread,
  pushCurrentThread,
  ReadableFutureEnd,
  ReadableStreamEnd,
  retireInstanceAsyncEnds,
  SharedFutureImpl,
  SharedStreamImpl,
  Store,
  Task,
  type TaskOptions,
  Thread,
  WaitableSet,
  WritableFutureEnd,
  WritableStreamEnd,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const ASYNC_FT: FuncType = { params: [], results: [], async: true };
const CALLBACK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

/** A live `MemInst` view over a real WebAssembly.Memory. */
function mkMemory() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  return {
    memory,
    view: {
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
    },
  };
}

/**
 * Two instances of one store sharing one *unwritten* future:
 *
 *   * `writer` (instance 0) holds the `WritableFutureEnd` — this is the one
 *     the tests poison;
 *   * `reader` (instance 1) holds the `ReadableFutureEnd` and stays healthy.
 *
 * The element type is the zero-width payload (`future` with no value type),
 * which keeps the buffers memory-free without changing any of the rendezvous
 * logic under test.
 */
function mkFutureSplit(mode: "plain" | "jspi" = "plain") {
  const store = new Store();
  const writer = new ComponentInstanceState(0, store);
  const reader = new ComponentInstanceState(1, store);
  const { memory, view } = mkMemory();
  const shared = new SharedFutureImpl(null);
  const wi = writer.handles.add(new WritableFutureEnd(shared));
  const readEnd = new ReadableFutureEnd(shared);
  const ri = reader.handles.add(readEnd);
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
    instance: reader,
  };
  const ctx = {
    componentInstance: () => reader,
    options: () => opts,
    streamElem: () => null,
    futureElem: () => null,
    resultTypes: () => [],
    suspensionMode: mode,
  };
  const task = new Task(ASYNC_FT, CALLBACK_OPTS, reader, () => [], () => {});
  const thread = new Thread(task, (function* () {})());
  return {
    store,
    writer,
    reader,
    shared,
    readEnd,
    ri,
    wi,
    memory,
    ctx,
    task,
    thread,
    read: createFutureRead({ futureTable: 0, options: 0 }, ctx, reader),
    wait: createWaitableSetWait({ options: 0 }, ctx, reader),
    /** Model the trap the walk is always called under. */
    poison(cause: unknown) {
      retireInstanceAsyncEnds(writer, cause);
    },
    run<T>(fn: () => T): T {
      pushCurrentThread(thread);
      try {
        return fn();
      } finally {
        popCurrentThread(thread);
      }
    },
  };
}

function caughtSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

async function caughtAsync(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

/** Every leg makes the same three claims about the observed failure. */
function assertAbandonTrap(e: unknown, causeIncludes: string): void {
  assert(
    !(e instanceof AssertionError),
    `must not be an internal AssertionError: ${e}`,
  );
  assert(e instanceof Trap, `expected a Trap, got ${Deno.inspect(e)}`);
  assert(
    String(e.message).includes("can never complete"),
    `names the outcome: ${e.message}`,
  );
  const cause = (e as { cause?: unknown }).cause;
  assert(cause instanceof Error, `carries the recorded cause: ${cause}`);
  assert(
    String(cause.message).includes(causeIncludes),
    `cause names the fault (${causeIncludes}): ${cause.message}`,
  );
}

// ---------------------------------------------------------------------------
// #84 (a): parked async reader, delivery through the waitable set
// ---------------------------------------------------------------------------

Deno.test("#84(a): a parked async future reader traps when the writer's instance is poisoned", () => {
  const f = mkFutureSplit();
  const wset = new WaitableSet();
  const seti = f.reader.handles.add(wset);
  f.readEnd.join(wset);

  // The reader parks: async `future.read` with nobody on the other side.
  assertEq(f.run(() => f.read(f.ri, 0)), BLOCKED);
  assertEq(f.readEnd.state, CopyState.COPYING);
  // Healthy: the reader's instance is unmarked while it is parked. This is
  // the property `dropSharedForTeardown`'s notify/silently-retire test rests
  // on (see its #84 AUDIT note).
  assertEq(isInstancePoisoned(f.reader), false);

  const boom = new Trap("unreachable");
  f.poison(boom);

  // An event landed (so the reader is not stranded)...
  assertEq(f.readEnd.hasPendingEvent(), true);
  // ...and taking it through waitable-set delivery traps the reader task.
  const e = caughtSync(() => f.run(() => f.wait(seti, 64)));
  assertAbandonTrap(e, "trapped while it held an end");
  assertEq((e as { cause?: { cause?: unknown } }).cause?.cause, boom);
  // The thunk is consumed exactly once — no phantom event is left behind.
  assertEq(f.readEnd.hasPendingEvent(), false);
});

Deno.test("#84(a'): a stream reader keeps the spec-shaped DROPPED outcome", () => {
  // The contrast case: DROPPED *is* end-of-stream for a stream, so the walk
  // must not turn it into a trap.
  const store = new Store();
  const writer = new ComponentInstanceState(0, store);
  const reader = new ComponentInstanceState(1, store);
  const { view } = mkMemory();
  const shared = new SharedStreamImpl(null);
  writer.handles.add(new WritableStreamEnd(shared));
  const readEnd = new ReadableStreamEnd(shared);
  const ri = reader.handles.add(readEnd);
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
    instance: reader,
  };
  const ctx = {
    componentInstance: () => reader,
    options: () => opts,
    streamElem: () => null,
    futureElem: () => null,
    resultTypes: () => [],
    suspensionMode: "plain" as const,
  };
  const read = createStreamRead({ streamTable: 0, options: 0 }, ctx, reader);
  const task = new Task(ASYNC_FT, CALLBACK_OPTS, reader, () => [], () => {});
  const thread = new Thread(task, (function* () {})());
  pushCurrentThread(thread);
  try {
    assertEq(read(ri, 0, 4), BLOCKED);
  } finally {
    popCurrentThread(thread);
  }
  retireInstanceAsyncEnds(writer, new Trap("unreachable"));
  assertEq(readEnd.hasPendingEvent(), true);
  const [, , payload] = readEnd.getPendingEvent();
  // definitions.py packs `result | (progress << 4)`: DROPPED with 0 progress.
  assertEq(payload & 0xf, CopyResult.DROPPED);
});

// ---------------------------------------------------------------------------
// #84 (b): parked sync/JSPI reader — the suspension point's `produce` throws
// ---------------------------------------------------------------------------

Deno.test("#84(b): a JSPI-blocked future reader's suspension rejects with the trap", async () => {
  const f = mkFutureSplit("jspi");
  // Synchronous (`async: false`) copy: `finishCopy` SITE 4 blocks the wasm
  // frame via `blockCurrentActivation`, which hands back a Promise.
  const syncOpts = { ...f.ctx.options(), async: false };
  const syncCtx = { ...f.ctx, options: () => syncOpts };
  const read = createFutureRead({ futureTable: 0, options: 0 }, syncCtx, f.reader);
  const parked = f.run(() => read(f.ri, 0)) as unknown as Promise<number>;
  assertEq(f.readEnd.state, CopyState.COPYING);
  assertEq(f.readEnd.hasSyncWaiter, true);
  // A JSPI-blocked peer is healthy while parked, exactly like a callback-ABI
  // one (#84 audit item; see `dropSharedForTeardown`).
  assertEq(isInstancePoisoned(f.reader), false);

  f.poison(new Trap("unreachable"));
  // The scheduler resumes the suspension point; `produce` throws, which the
  // bridge turns into the promise's rejection (the engine's trap path).
  assertEq(f.store.tick(), true);
  assertAbandonTrap(await caughtAsync(parked), "trapped while it held an end");
});

// ---------------------------------------------------------------------------
// #84 (c): the reader had not parked yet
// ---------------------------------------------------------------------------

Deno.test("#84(c): future.read after the teardown traps instead of asserting", () => {
  const f = mkFutureSplit();
  f.poison(new Trap("unreachable"));
  const e = caughtSync(() => f.run(() => f.read(f.ri, 0)));
  assertAbandonTrap(e, "trapped while it held an end");
});

Deno.test("#84(c'): a spec-dropped future (the writer delivered its value) is untouched", () => {
  // Distinguishing teardown-dropped from spec-dropped: a future whose value
  // WAS delivered carries no abandonment reason, so nothing about the normal
  // path changes. definitions.py:1183-1184 makes the writable end's drop legal
  // only in this state.
  const f = mkFutureSplit();
  const buf = new HostBuffer(null, [null], 1);
  let result: CopyResult | null = null;
  // A host writer parks its one value; the guest reader takes it.
  f.shared.write({ host: "w" }, buf as never, (r) => result = r);
  assertEq(f.run(() => f.read(f.ri, 0)), CopyResult.COMPLETED);
  assertEq(result, CopyResult.COMPLETED);
  assertEq(f.shared.abandonReason, null);
  // The end is DONE, so the walk owes the reader nothing.
  const end = f.writer.handles.get(f.wi) as WritableFutureEnd;
  end.state = CopyState.DONE;
  f.poison(new Trap("unreachable"));
  assertEq(f.shared.abandonReason, null);
});

// ---------------------------------------------------------------------------
// #84: the walk completes even when one end's notification throws
// ---------------------------------------------------------------------------

Deno.test("#84: one end's failing notification does not strand the remaining ends", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  // A non-instance peer stand-in: not poisoned, so it is notified normally.
  const peer = {};

  // End 1: a stream whose parked peer's settler throws (a host callback, an
  // event thunk — anything the notification runs).
  const bad = new SharedStreamImpl(null);
  const boom = new Error("peer settler exploded");
  bad.setPending(peer, new HostBuffer(null, null, 4) as never, () => {}, () => {
    throw boom;
  });
  inst.handles.add(new WritableStreamEnd(bad));

  // End 2 and 3: ordinary ends that must still be retired.
  const okStream = new SharedStreamImpl(null);
  let okResult: CopyResult | null = null;
  okStream.setPending(
    peer,
    new HostBuffer(null, null, 4) as never,
    () => {},
    (r) => okResult = r,
  );
  inst.handles.add(new ReadableStreamEnd(okStream));
  const okFuture = new SharedFutureImpl(null);
  inst.handles.add(new WritableFutureEnd(okFuture));

  const raised = caughtSync(() => retireInstanceAsyncEnds(inst, new Trap("x")));

  // The first failure is rethrown...
  assertEq(raised, boom);
  // ...and every other end was still retired.
  assertEq(okResult, CopyResult.DROPPED);
  assertEq(okStream.dropped, true);
  assertEq(okFuture.dropped, true);
  assert(
    okFuture.abandonReason instanceof Error,
    "the unwritten future is marked abandoned",
  );
  assertEq(bad.dropped, true);
});

// ---------------------------------------------------------------------------
// #90: host drop-before-write on a lowered future
// ---------------------------------------------------------------------------

/** Lower a host future into `inst`, the way `lower_future` does. */
function lowerInto(
  host: { value: unknown },
  inst: ComponentInstanceState,
): number {
  const shared = host.value as SharedFutureImpl;
  (shared as { boundStore?: unknown }).boundStore ??= inst.store;
  (shared as { onLowered?: ((i: unknown) => void) | null }).onLowered?.(inst);
  return inst.handles.add(new ReadableFutureEnd(shared));
}

Deno.test("#90: dropping a lowered, never-written host future traps its parked reader", () => {
  const f = mkFutureSplit();
  // Re-do the split with a *host* writable side: the host future's shared
  // object is the one the guest reads.
  const store = new Store();
  const reader = new ComponentInstanceState(1, store);
  const host = hostFuture<null>(null);
  const ri = lowerInto(host, reader);
  const readEnd = reader.handles.get(ri) as ReadableFutureEnd;
  const opts = { ...f.ctx.options(), instance: reader };
  const ctx = { ...f.ctx, componentInstance: () => reader, options: () => opts };
  const read = createFutureRead({ futureTable: 0, options: 0 }, ctx, reader);
  const task = new Task(ASYNC_FT, CALLBACK_OPTS, reader, () => [], () => {});
  const thread = new Thread(task, (function* () {})());
  const run = <T>(fn: () => T): T => {
    pushCurrentThread(thread);
    try {
      return fn();
    } finally {
      popCurrentThread(thread);
    }
  };
  const wset = new WaitableSet();
  const seti = reader.handles.add(wset);
  readEnd.join(wset);
  assertEq(run(() => read(ri, 0)), BLOCKED);

  // The public door: no throw, and the parked reader is armed.
  host.drop();
  host.drop(); // idempotent
  const wait = createWaitableSetWait({ options: 0 }, ctx, reader);
  const e = caughtSync(() => run(() => wait(seti, 64)));
  assertAbandonTrap(e, "without writing a value");
});

Deno.test("#90: dropping a lowered, never-written host future with no reader parked", () => {
  const store = new Store();
  const reader = new ComponentInstanceState(1, store);
  const host = hostFuture<null>(null);
  lowerInto(host, reader);
  host.drop();
  const shared = host.value as unknown as SharedFutureImpl;
  assertEq(shared.dropped, true);
  assert(shared.abandonReason instanceof Error, "marked abandoned");
  // ...and the reader that shows up later traps rather than tripping the
  // `future read shape` assert (task/streams.ts).
  const e = caughtSync(() =>
    shared.read({}, new HostBuffer(null, null, 1) as never, () => {})
  );
  assertAbandonTrap(e, "without writing a value");
});

Deno.test("#90: an unlowered future's drop is plain cleanup, and dispose never throws", () => {
  const host = hostFuture<null>(null);
  host.drop();
  const shared = host.value as unknown as SharedFutureImpl;
  assertEq(shared.dropped, true);
  assertEq(shared.abandonReason, null);
  host.drop();
});

Deno.test("#90: write-then-drop is unchanged", async () => {
  const store = new Store();
  const reader = new ComponentInstanceState(1, store);
  const host = hostFuture<null>(null);
  lowerInto(host, reader);
  const w = host.write(null);
  // The guest reader takes the value.
  const shared = host.value as unknown as SharedFutureImpl;
  let taken: CopyResult | null = null;
  shared.read({ guest: 1 }, new HostBuffer(null, null, 1) as never, (r) =>
    taken = r);
  await w;
  assertEq(taken, CopyResult.COMPLETED);
  host.drop();
  assertEq(shared.abandonReason, null);
});

// ---------------------------------------------------------------------------
// #97: the host buffer bound
// ---------------------------------------------------------------------------

Deno.test("#97: HostBuffer enforces Buffer.MAX_LENGTH", () => {
  assertEq(BUFFER_MAX_LENGTH, 2 ** 28 - 1);
  // At the bound: allowed (definitions.py:938 asserts `<= MAX_LENGTH`).
  const ok = new HostBuffer(null, null, BUFFER_MAX_LENGTH);
  assertEq(ok.remain(), BUFFER_MAX_LENGTH);
  for (const bad of [BUFFER_MAX_LENGTH + 1, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    const e = caughtSync(() => new HostBuffer(null, null, bad));
    assert(e instanceof RangeError, `loud typed error for ${bad}: ${e}`);
    assert(
      String((e as Error).message).includes("MAX_LENGTH"),
      `names the bound: ${(e as Error).message}`,
    );
  }
  // Nonsense lengths are rejected at the same door.
  assert(
    caughtSync(() => new HostBuffer(null, null, -1)) instanceof RangeError,
    "negative length rejected",
  );
});

// ---------------------------------------------------------------------------
// #97: a host-cancelled read is indistinguishable from EOS — pinned
// ---------------------------------------------------------------------------

Deno.test("#97: cancelRead resolves the read exactly like end-of-stream does", async () => {
  // DELIBERATE (see the doc comments at exec/host_streams.ts
  // `HostReadableEnd.cancelRead` and embedder/streams.ts `Stream.cancelRead`):
  // both outcomes hand back the empty chunk, which the conventions layer
  // reads as a clean end. This test exists so the equivalence cannot be
  // changed silently — the canceller is the observer, so the ambiguity is
  // resolvable by the only code that can see it.
  const cancelled = hostStream<number>(null);
  const cancelledRead = cancelled.readable.read(4);
  cancelled.readable.cancelRead();
  assertEq(await cancelledRead, []);

  const ended = hostStream<number>(null);
  const endedRead = ended.readable.read(4);
  // The writable end going away is genuine end-of-stream.
  ended.writable.drop();
  assertEq(await endedRead, []);
});

// ---------------------------------------------------------------------------
// #100: "poisoned" is a MARKER, not a liveness proxy — a mid-FACT-call
// CALLER's healthy parked task must not be silently retired
// ---------------------------------------------------------------------------
//
// The stranding shape from the issue. Instance A (caller) is mid
// cross-component (FACT) call into instance B (callee). A DIFFERENT,
// perfectly healthy task of A is parked on an end of a stream/future whose
// peer end B holds. B traps; the poisoning walk runs over B's table and
// reaches A's parked side. The old health test (non-enterability) read A
// as a corpse — A was non-enterable merely because it was mid-call — and
// retired it in silence: stranded, the outcome #66 exists to prevent. The
// narrowed test (task/scheduler.ts's per-instance poison marker, recorded at
// the `notifyInstancePoisoned` seam) gives A the spec-shaped outcome instead:
// DROPPED for a stream, the #84 abandonment trap for an unwritten future.
// CM#705 (polyengine#173) has since deleted `may_enter` outright, so the
// marker is not merely the better predicate but the only one available.
//
// Both directions are pinned here: the dead-guest discipline (a parked task of
// the POISONED instance itself is still silently retired) has its own leg
// below, so narrowing the predicate cannot quietly become "always notify".

/** Options/ctx for a guest built-in call in `inst`. */
function mkCtx(
  inst: ComponentInstanceState,
  // deno-lint-ignore no-explicit-any
  view: any,
) {
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    memory: view,
    realloc: null,
    postReturn: null,
    callback: null,
    async: true,
    cancellable: false,
    coreType: { params: ["i32", "i32"], results: ["i32"] },
    instance: inst,
  };
  return {
    componentInstance: () => inst,
    options: () => opts,
    streamElem: () => null,
    futureElem: () => null,
    resultTypes: () => [],
    suspensionMode: "plain" as const,
  };
}

/** Run `fn` as a task of `inst` (the built-ins read the current thread). */
function inTask<T>(inst: ComponentInstanceState, fn: () => T): T {
  const task = new Task(ASYNC_FT, CALLBACK_OPTS, inst, () => [], () => {});
  const thread = new Thread(task, (function* () {})());
  pushCurrentThread(thread);
  try {
    return fn();
  } finally {
    popCurrentThread(thread);
  }
}

/**
 * `caller` is mid-cross-component-call into `callee`. Post-CM#705 that state
 * carries no instance-level flag at all (the pre-#705 host-entry chain, whose
 * cleared `may_enter` on BOTH instances is what the old health test tripped
 * over, no longer exists), so this is documentation: neither instance is
 * marked, and only the marker decides.
 */
function enterMidFactCall(
  caller: ComponentInstanceState,
  callee: ComponentInstanceState,
): void {
  assertEq(isInstancePoisoned(caller), false);
  assertEq(isInstancePoisoned(callee), false);
}

Deno.test("#100: a mid-FACT-call caller's parked stream reader gets DROPPED, not silence", () => {
  const store = new Store();
  const caller = new ComponentInstanceState(0, store); // A: healthy
  const callee = new ComponentInstanceState(1, store); // B: traps
  const { view } = mkMemory();
  const shared = new SharedStreamImpl(null);
  callee.handles.add(new WritableStreamEnd(shared));
  const readEnd = new ReadableStreamEnd(shared);
  const ri = caller.handles.add(readEnd);

  // A's other task parks on the read — a healthy park.
  const read = createStreamRead(
    { streamTable: 0, options: 0 },
    mkCtx(caller, view),
    caller,
  );
  assertEq(inTask(caller, () => read(ri, 0, 4)), BLOCKED);
  assertEq(readEnd.state, CopyState.COPYING);

  // A calls into B; B traps. The poison goes through the one seam every
  // poisoning site uses, which is what records the marker.
  enterMidFactCall(caller, callee);
  notifyInstancePoisoned(callee, new Trap("unreachable"));

  // A is alive: it gets end-of-stream, not silence.
  assertEq(shared.dropped, true);
  assertEq(readEnd.hasPendingEvent(), true);
  const [, , payload] = readEnd.getPendingEvent();
  assertEq(payload & 0xf, CopyResult.DROPPED);
});

Deno.test("#100: a mid-FACT-call caller's parked future reader gets the abandonment trap", () => {
  const store = new Store();
  const caller = new ComponentInstanceState(0, store);
  const callee = new ComponentInstanceState(1, store);
  const { view } = mkMemory();
  const shared = new SharedFutureImpl(null);
  // B owes a value it can never deliver once it traps (#84).
  callee.handles.add(new WritableFutureEnd(shared));
  const readEnd = new ReadableFutureEnd(shared);
  const ri = caller.handles.add(readEnd);
  const ctx = mkCtx(caller, view);
  const read = createFutureRead({ futureTable: 0, options: 0 }, ctx, caller);
  const wait = createWaitableSetWait({ options: 0 }, ctx, caller);
  const wset = new WaitableSet();
  const seti = caller.handles.add(wset);
  readEnd.join(wset);

  assertEq(inTask(caller, () => read(ri, 0)), BLOCKED);

  enterMidFactCall(caller, callee);
  const boom = new Trap("unreachable");
  notifyInstancePoisoned(callee, boom);

  assertEq(readEnd.hasPendingEvent(), true);
  const e = caughtSync(() => inTask(caller, () => wait(seti, 64)));
  assertAbandonTrap(e, "trapped while it held an end");
  assertEq((e as { cause?: { cause?: unknown } }).cause?.cause, boom);
});

Deno.test("#100: the poisoned instance's OWN parked task is still retired silently", () => {
  // The other direction — the dead-guest discipline the narrowed predicate
  // must preserve. A parked side of the instance being poisoned would, if
  // notified, leave a phantom event in a waitable of an instance that can
  // never be entered again (review B2).
  const store = new Store();
  const doomed = new ComponentInstanceState(0, store);
  const peerInst = new ComponentInstanceState(1, store);
  const { view } = mkMemory();
  const shared = new SharedStreamImpl(null);
  peerInst.handles.add(new WritableStreamEnd(shared));
  const readEnd = new ReadableStreamEnd(shared);
  const ri = doomed.handles.add(readEnd);
  const read = createStreamRead(
    { streamTable: 0, options: 0 },
    mkCtx(doomed, view),
    doomed,
  );
  assertEq(inTask(doomed, () => read(ri, 0, 4)), BLOCKED);

  notifyInstancePoisoned(doomed, new Trap("unreachable"));

  assertEq(shared.dropped, true);
  assertEq(readEnd.hasPendingEvent(), false);
  // Silent retirement leaves the end where the trap left it (`resetPending`
  // clears the rendezvous, not the end's state): the corpse's task never runs
  // again, so nothing observes it.
  assertEq(readEnd.state, CopyState.COPYING);
});

Deno.test("#100: a host peer parked on a poisoned guest's end is still notified", () => {
  // Host sentinels are not component instances, so the predicate never reads
  // them as poisoned.
  const store = new Store();
  const guest = new ComponentInstanceState(0, store);
  const shared = new SharedStreamImpl(null);
  let result: CopyResult | null = null;
  shared.setPending(
    null,
    new HostBuffer(null, null, 4) as never,
    () => {},
    (r) => result = r,
  );
  guest.handles.add(new WritableStreamEnd(shared));
  notifyInstancePoisoned(guest, new Trap("unreachable"));
  assertEq(result, CopyResult.DROPPED);
});
