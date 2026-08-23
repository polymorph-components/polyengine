// #93 (test half): pinning how a trap raised while lowering an async-lower
// host import's RESULT surfaces to the embedder.
//
// exec/boundary.ts:1645-1658 (the async, non-suspendable arm of
// `createLoweredImport`) runs `onResolve`'s result lowering in a bare
// `.then()` continuation, not under `blockCurrentActivation`'s `produce`
// (unlike the sync/suspendable arm just above it, :1595-1601, which defers
// all CABI work to `produce` for exactly the issue-#24 attribution reason).
// A throw there is caught locally and parked on `store.hostFailure`
// (:1652-1655) — the same channel a rejected host Promise uses — rather than
// propagating as an ordinary exception or a subtask-machinery trap.
//
// This test does not judge whether that routing is correct (issue #93 asks
// for a comment at the site, which is the orchestrator's call on
// boundary.ts); it pins the current, observed behaviour so a future change
// is a deliberate diff, not a silent one.

import { assertEq } from "./support/asserts.ts";
import {
  createLoweredImport,
  newStats,
  type ResolvedOptions,
} from "../src/exec/boundary.ts";
import {
  ComponentInstanceState,
  pushCurrentThread,
  popCurrentThread,
  Store,
  Task,
  type TaskOptions,
  Thread,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

/** `func() -> string`, async-typed — a result type that must allocate to lower. */
const FT: FuncType = {
  params: [],
  results: [{ kind: "string" }],
  async: true,
};

const TASK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

Deno.test(
  "async lower: a RESULT-lowering trap at settle time (no realloc for a " +
    "string result) lands in store.hostFailure, not a subtask trap",
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
    const opts: ResolvedOptions = {
      stringEncoding: "utf8",
      // deno-lint-ignore no-explicit-any
      memory: view as any,
      // No realloc: lowering a `string` result needs to allocate the guest
      // buffer, and `cabi/context.ts:99` traps
      // ("realloc required but not provided") when asked to without one.
      realloc: null,
      postReturn: null,
      callback: null,
      async: true,
      cancellable: false,
      // Async lower: results travel via the trailing retptr lane, so the
      // core signature is unchanged by the result type (definitions.py
      // lines 2250-2256: `max_flat_results = 0` when async).
      coreType: { params: ["i32"], results: ["i32"] },
      instance: inst,
    };
    const call = createLoweredImport({
      name: "host-fn-string-result",
      ft: FT,
      opts,
      hostFn: () => Promise.resolve("hello"),
      stats: newStats(),
      mode: "plain",
      suspendable: false,
      deferCancel: false,
    }) as (...args: number[]) => unknown;

    const task = new Task(FT, TASK_OPTS, inst, () => [], () => {});
    const thread = new Thread(task, (function* () {})());
    pushCurrentThread(thread);
    let packed: unknown;
    try {
      // retptr = 64: somewhere harmless in the first page.
      packed = call(64);
    } finally {
      popCurrentThread(thread);
    }
    // The call itself returns a STARTED subtask handle — the trap has not
    // happened yet, because the host Promise has not settled.
    assertEq(typeof packed, "number");
    assertEq(store.hostFailure, undefined);

    await new Promise((r) => setTimeout(r, 0));

    // The settle-time lowering trap ("realloc required but not provided")
    // was caught by the bare `.then()` continuation and parked here, exactly
    // as a rejected host Promise would be (:1652-1655) — not raised as an
    // uncaught exception, and not delivered to the guest through the
    // subtask's SUBTASK event.
    assertEq(store.hostFailure !== undefined, true);
    const msg = String((store.hostFailure as { message?: string })?.message ?? store.hostFailure);
    assertEq(msg.includes("realloc required but not provided"), true);
    // Consumed: the subtask never resolved, and the driving loop is the one
    // responsible for rethrowing `store.hostFailure` — pinning that plumbing
    // (rather than this local test rethrowing it) is exactly the point.
  },
);
