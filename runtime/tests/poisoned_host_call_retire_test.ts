// F3: poisoning an instance does not retire the corpse's outstanding host
// calls, so their LATE settlement lands on `store.hostFailure` — the channel
// the next driver on the store reads, i.e. a healthy sibling's export call.
//
// THE SHAPE
//   * instance I async-lowers a host import; the call sits in
//     `store.pendingHostCalls` with a continuation that owns the outcome;
//   * a sibling activation of I traps; I is poisoned (a corpse);
//   * the import's promise settles anyway. The continuation is unguarded
//     (exec/boundary.ts:2497-2523): `subtask.resolved()` is false, so a
//     rejection is parked on `store.hostFailure`.
//
// arch §6 #173 ("sibling instances of the same instantiation stay usable")
// and boundary.ts:1616 both say the corpse must be inert. A renounced call's
// late rejection is already discarded for exactly this reason; a POISONED
// call's must be too.

import { assertEq } from "./support/asserts.ts";
import {
  createLoweredImport,
  newStats,
  type ResolvedOptions,
} from "../src/exec/boundary.ts";
import {
  ComponentInstanceState,
  notifyInstancePoisoned,
  popCurrentThread,
  pushCurrentThread,
  Store,
  Task,
  type TaskOptions,
  Thread,
} from "../src/task/mod.ts";
import { Trap } from "../src/cabi/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

/** `func()` — async-typed, no results: nothing to lower, so the only thing
 * under test is where the late settlement's outcome goes. */
const FT: FuncType = { params: [], results: [], async: true };

const TASK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

Deno.test(
  "F3: a poisoned instance's outstanding host call is retired — its late " +
    "rejection does not reach store.hostFailure",
  async () => {
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
    let rejectRaw!: (e: unknown) => void;
    const raw = new Promise<unknown>((_, rej) => (rejectRaw = rej));
    const opts: ResolvedOptions = {
      stringEncoding: "utf8",
      // deno-lint-ignore no-explicit-any
      memory: view as any,
      realloc: null,
      postReturn: null,
      callback: null,
      async: true,
      cancellable: false,
      coreType: { params: [], results: ["i32"] },
      instance: inst,
    };
    const call = createLoweredImport({
      name: "host-fn-in-flight",
      ft: FT,
      opts,
      hostFn: () => raw,
      stats: newStats(),
      mode: "plain",
      suspendable: false,
      deferCancel: false,
      abortable: false,
    }) as (...args: number[]) => unknown;

    const task = new Task(FT, TASK_OPTS, inst, () => [], () => {});
    const thread = new Thread(task, (function* () {})());
    pushCurrentThread(thread);
    try {
      // No params and no results: the async lower takes no retptr lane.
      call();
    } finally {
      popCurrentThread(thread);
    }
    assertEq(store.pendingHostCalls.size, 1);
    assertEq(store.hostFailure, undefined);

    // A sibling activation of the same instance traps: the instance is a
    // corpse from here on (polyengine's named divergence, arch §6 #173).
    notifyInstancePoisoned(inst, new Trap("wasm trap: unreachable"));

    // The corpse's import settles late. Nobody is waiting for it.
    rejectRaw(new Error("late host rejection of an abandoned call"));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // Discarded, exactly as a renounced call's rejection is (:2517-2522).
    // Left on `hostFailure` it fails the next driven call on this store —
    // a HEALTHY sibling instance's export — with the corpse's error.
    const parked = store.hostFailure;
    assertEq(
      parked === undefined
        ? "<none>"
        : String((parked as { message?: string })?.message ?? parked),
      "<none>",
    );
    // And it no longer counts as outstanding external work.
    assertEq(store.pendingHostCalls.size, 0);
  },
);
