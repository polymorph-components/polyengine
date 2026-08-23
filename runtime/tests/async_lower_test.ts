// Async `canon_lower` against **host** imports — the flagship Deno capability
// of this phase (docs/architecture.md §6): a JS `async` function is a valid Component Model
// async import, with no JSPI anywhere.
//
// Why no JSPI is needed: the guest is stackless. It lowers the import, gets a
// STARTED subtask handle back, joins it to a waitable set and returns the WAIT
// callback code — i.e. it *returns to the host* before waiting. When the JS
// promise settles, the scheduler delivers a SUBTASK event and calls the
// guest's callback export again. Nothing is ever suspended mid-wasm.
//
// These tests drive `createLoweredImport` directly (rather than through a WAT
// fixture) so the reference's state machine is checked step by step:
// definitions.py `canon_lower` lines 2242-2309.

import { assertEq } from "./support/asserts.ts";
import {
  createLoweredImport,
  newStats,
  type ResolvedOptions,
} from "../src/exec/boundary.ts";
import {
  ComponentInstanceState,
  EventCode,
  NeedsJspi,
  pushCurrentThread,
  popCurrentThread,
  Store,
  Subtask,
  SubtaskState,
  Task,
  type TaskOptions,
  Thread,
  unpackSubtaskResult,
  WaitableSet,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";
import { BLOCKED, createSubtaskCancel } from "../src/intrinsics/async_builtins.ts";
// A23: the cancel-discard opt-out, read off the host function exactly as
// `executor.ts buildLoweredImport` reads it from the embedder's imports record.
import { deferCancel, isDeferCancel } from "../src/jspi/suspending.ts";
import { Trap } from "../src/cabi/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** `func(x: u32) -> u32`, async-typed. */
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
  thread: Thread;
  memory: WebAssembly.Memory;
  call: (...args: number[]) => unknown;
  /** Run `fn` as if the guest were executing (the current-thread context). */
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
    // Async lower of (u32) -> u32: one flat param, plus a retptr because the
    // result is non-empty, and a packed i32 result (cabi `flattenFunctype`).
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
    // Mirrors `buildLoweredImport`: the brand is read off the host value, so a
    // fixture whose host fn is wrapped in `deferCancel()` gets the opt-out.
    deferCancel: isDeferCancel(hostFn),
  }) as (...args: number[]) => unknown;

  const task = new Task(FT, TASK_OPTS, inst, () => [], () => {});
  const thread = new Thread(task, (function* () {})());

  return {
    store,
    inst,
    thread,
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

Deno.test("async lower: a synchronous host function takes the eager fast path", () => {
  const f = mkFixture((x) => (x as number) + 1);
  // retptr = 64: somewhere harmless in the first page.
  const packed = f.asGuest(() => f.call(41, 64)) as number;
  // definitions.py line 2293: an eagerly-resolved subtask returns the bare
  // state, with no handle and no event.
  assertEq(packed, SubtaskState.RETURNED);
  assertEq(new DataView(f.memory.buffer).getUint32(64, true), 42);
  // No handle was allocated, so there is nothing for the guest to drop.
  assertEq([...f.inst.handles].length, 0);
});

Deno.test("async lower: a Promise-returning host function yields a STARTED subtask", async () => {
  let settle!: (v: number) => void;
  const f = mkFixture(() => new Promise<number>((r) => (settle = r)));
  const packed = f.asGuest(() => f.call(41, 64)) as number;
  const [state, subtaski] = unpackSubtaskResult(packed);
  // definitions.py line 2308: `state | (subtaski << 4)`.
  assertEq(state, SubtaskState.STARTED);
  assert(subtaski > 0, "an unresolved subtask gets a handle index");

  const subtask = f.inst.handles.get(subtaski) as Subtask;
  assert(subtask instanceof Subtask, "the handle is a Subtask");
  assertEq(subtask.resolved(), false);
  assertEq(subtask.hasPendingEvent(), false);
  // The store knows a host call is outstanding — that is what tells the
  // driving loop to await a microtask turn rather than declare deadlock.
  assertEq(f.store.pendingHostCalls.size, 1);

  settle(42);
  await new Promise((r) => setTimeout(r, 0));

  // Settlement resolved the subtask and armed its event.
  assertEq(subtask.resolved(), true);
  assertEq(subtask.state, SubtaskState.RETURNED);
  assertEq(subtask.hasPendingEvent(), true);
  assertEq(f.store.pendingHostCalls.size, 0);
  // The result was lowered through the retptr the guest supplied.
  assertEq(new DataView(f.memory.buffer).getUint32(64, true), 42);

  // Reading the event is what delivers the resolution.
  assertEq(subtask.resolveDelivered(), false);
  const [code, index, payload] = subtask.getPendingEvent();
  assertEq(code, EventCode.SUBTASK);
  assertEq(index, subtaski);
  assertEq(payload, SubtaskState.RETURNED);
  assertEq(subtask.resolveDelivered(), true);
});

Deno.test("async lower: the subtask event reaches a joined waitable set", async () => {
  let settle!: (v: number) => void;
  const f = mkFixture(() => new Promise<number>((r) => (settle = r)));
  const packed = f.asGuest(() => f.call(1, 64)) as number;
  const [, subtaski] = unpackSubtaskResult(packed);
  const subtask = f.inst.handles.get(subtaski) as Subtask;

  const wset = new WaitableSet();
  subtask.join(wset);
  assertEq(wset.hasPendingEvent(), false);

  settle(7);
  await new Promise((r) => setTimeout(r, 0));

  // This is exactly what a callback-ABI guest observes after returning
  // `WAIT | (seti << 4)`: the set now has the SUBTASK event.
  assertEq(wset.hasPendingEvent(), true);
  const [code, index] = wset.getPendingEvent();
  assertEq(code, EventCode.SUBTASK);
  assertEq(index, subtaski);
});

Deno.test("async lower: a rejected host promise is parked for the driver", async () => {
  const boom = new Error("host import failed");
  const f = mkFixture(() => Promise.reject(boom));
  f.asGuest(() => f.call(1, 64));
  await new Promise((r) => setTimeout(r, 0));
  // The rejection cannot propagate out of its microtask, so it waits on the
  // store for whoever is driving it — which is the call the guest is inside.
  assertEq(f.store.hostFailure, boom);
});

Deno.test("sync lower of a Promise-returning host import needs JSPI", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const syncFt: FuncType = {
    params: [],
    results: [{ kind: "u32" }],
    async: false,
  };
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    memory: null,
    realloc: null,
    postReturn: null,
    callback: null,
    async: false,
    cancellable: false,
    coreType: { params: [], results: ["i32"] },
    instance: inst,
  };
  const call = createLoweredImport({
    name: "sync-host-fn",
    ft: syncFt,
    opts,
    hostFn: () => Promise.resolve(1),
    stats: newStats(),
    deferCancel: false,
    // Plain mode: the A1 park arm is jspi-only, so this stays the guard pin
    // for the no-JSPI path. The marked+jspi park itself is pinned by
    // tests/embedder/suspending_imports_test.ts.
    mode: "plain",
    suspendable: false,
  });
  const task = new Task(syncFt, {
    async_: false,
    callback: false,
    stringEncoding: "utf8",
    memory: null,
  }, inst, () => [], () => {});
  const thread = new Thread(task, (function* () {})());
  pushCurrentThread(thread);
  let raised: unknown;
  try {
    call();
  } catch (e) {
    raised = e;
  } finally {
    popCurrentThread(thread);
  }
  // definitions.py line 2286 (`thread.wait_until(subtask.resolved)`): the
  // guest's *wasm frame* would have to block. That is JSPI role 2 and it is
  // reported as such, never faked and never turned into a trap.
  assert(
    raised instanceof NeedsJspi,
    `expected NeedsJspi, got ${raised}`,
  );
  assert(
    String(raised).includes("Promise"),
    `message should explain the cause, got: ${raised}`,
  );
});

Deno.test("A23: deferCancel() opts a host import out of discard — subtask.cancel returns BLOCKED", async () => {
  // definitions.py `canon_subtask_cancel` (line 2469): the request is passed
  // to the callee's `on_cancel`; if the callee does not resolve promptly, the
  // async form returns BLOCKED and the subtask stays live.
  //
  // That is what a `deferCancel()`-branded import does — accept and ignore
  // (contracts/embedder-api.md amendment A23; polyengine#241). It was the
  // behavior of EVERY host import before A23; it is now the opt-in for imports
  // with a commit point, where reporting CANCELLED_BEFORE_RETURNED would lie
  // about a write that lands anyway. The default is discard, pinned in
  // tests/host_import_cancel_test.ts.
  let settle!: (v: number) => void;
  const f = mkFixture(
    deferCancel(() => new Promise<number>((r) => (settle = r))),
  );
  const packed = f.asGuest(() => f.call(1, 64)) as number;
  const [, subtaski] = unpackSubtaskResult(packed);
  const subtask = f.inst.handles.get(subtaski) as Subtask;

  const cancel = createSubtaskCancel({ async: true }, f.inst);
  const rc = f.asGuest(() => cancel(subtaski)) as number;
  assertEq(rc, BLOCKED);
  // The request is recorded, and the subtask is untouched otherwise.
  assertEq(subtask.cancellationRequested, true);
  assertEq(subtask.resolved(), false);
  assertEq(subtask.state, SubtaskState.STARTED);

  // For a deferred import cancellation is a request, not a guarantee: the host
  // call still settles, and the subtask resolves RETURNED exactly as it would
  // have.
  settle(99);
  await new Promise((r) => setTimeout(r, 0));
  assertEq(f.store.hostFailure, undefined);
  assertEq(subtask.resolved(), true);
  assertEq(subtask.state, SubtaskState.RETURNED);
  assertEq(new DataView(f.memory.buffer).getUint32(64, true), 99);

  // ... and the resolution is delivered cleanly through the event.
  assertEq(subtask.resolveDelivered(), false);
  const [code, index, payload] = subtask.getPendingEvent();
  assertEq(code, EventCode.SUBTASK);
  assertEq(index, subtaski);
  assertEq(payload, SubtaskState.RETURNED);
  assertEq(subtask.resolveDelivered(), true);
});

Deno.test("async lower: a second subtask.cancel traps (deferCancel: already cancelled)", () => {
  // definitions.py line 2475: `trap_if(subtask.cancellation_requested)`.
  //
  // Reaching that trap needs a subtask that is still UNRESOLVED after its
  // first cancel — under A23 only a `deferCancel()` import leaves one, since
  // the default discard resolves and delivers on the first cancel (the
  // resolveDelivered trap, pinned in the test below). Keeping this arm on the
  // brand keeps the reference-parity property pinned rather than retiring it.
  const f = mkFixture(deferCancel(() => new Promise<number>(() => {})));
  const packed = f.asGuest(() => f.call(1, 64)) as number;
  const [, subtaski] = unpackSubtaskResult(packed);
  const cancel = createSubtaskCancel({ async: true }, f.inst);
  assertEq(f.asGuest(() => cancel(subtaski)), BLOCKED);
  let raised: unknown;
  try {
    f.asGuest(() => cancel(subtaski));
  } catch (e) {
    raised = e;
  }
  assert(raised instanceof Trap, `expected a Trap, got ${raised}`);
  assert(
    String(raised).includes("already cancelled"),
    `unexpected message: ${raised}`,
  );
});

Deno.test("A23: a second subtask.cancel after a DISCARD traps on the delivered resolution", () => {
  // definitions.py line 2473: `trap_if(subtask.resolve_delivered())`, checked
  // BEFORE the cancellation_requested trap. The default (unbranded) import
  // discards on the first cancel — resolving CANCELLED_BEFORE_RETURNED and
  // delivering it through the built-in's `finish()` tail — so the second
  // cancel names a subtask whose resolution is already delivered and hits this
  // trap instead. Both orderings of the reference's guards stay pinned.
  const f = mkFixture(() => new Promise<number>(() => {}));
  const packed = f.asGuest(() => f.call(1, 64)) as number;
  const [, subtaski] = unpackSubtaskResult(packed);
  const cancel = createSubtaskCancel({ async: true }, f.inst);
  assertEq(
    f.asGuest(() => cancel(subtaski)),
    SubtaskState.CANCELLED_BEFORE_RETURNED,
  );
  let raised: unknown;
  try {
    f.asGuest(() => cancel(subtaski));
  } catch (e) {
    raised = e;
  }
  assert(raised instanceof Trap, `expected a Trap, got ${raised}`);
  assert(
    String(raised).includes("already delivered"),
    `unexpected message: ${raised}`,
  );
});
