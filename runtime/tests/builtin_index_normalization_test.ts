// The u32-normalization cluster: guest-supplied indices/lengths are u32,
// but core wasm delivers i32 args as signed JS numbers, and several
// built-ins use them without `>>> 0` (contrast intrinsics/mod.ts:538-551
// which does normalize resource handles). Two distinct failure shapes:
//
//   (a)/(b) `Table.remove` (async_builtins.ts subtask.drop/waitable-set.drop,
//   stream_builtins.ts dropEnd for stream.drop-{readable,writable}) calls
//   `get()` (which does not trap on i<0 — see (d)) then unconditionally
//   mutates `array[i] = null; free.push(i)` BEFORE the instanceof check
//   traps on the bogus (undefined) entry. A guest passing 0xFFFFFFFF
//   corrupts the free list before the trap fires.
//   (c) `stream.write` with n = 0xFFFFFFFF (definitions.py
//   `BufferGuestImpl.__init__` 911-920 traps on length > MAX_LENGTH, which
//   is a u32 comparison); GuestBuffer's `length > BUFFER_MAX_LENGTH` check
//   sees a negative JS number and never trips.
//   (d) `Table.get(i)` with i<0: `i >= this.array.length` is false for
//   negative i, and `this.array[i] === null` is false too (index access on
//   a negative key reads `undefined`, not the sentinel `null`) — so `get`
//   returns `undefined` without trapping at all, rather than treating the
//   out-of-range index as a trap.
//
// Authority: definitions.py `Table.get/remove` (682-703, indices are
// non-negative ints; get traps on `i >= len` -- negative i is never a valid
// index either), `BufferGuestImpl.__init__` 911-920 (`Buffer.MAX_LENGTH`).

import { assertEq } from "./support/asserts.ts";
import { Trap } from "../src/cabi/mod.ts";
import { Table } from "../src/cabi/handles.ts";
import {
  createSubtaskDrop,
  createWaitableSetDrop,
} from "../src/intrinsics/async_builtins.ts";
import {
  createStreamDropReadable,
  createStreamDropWritable,
  createStreamNew,
  createStreamWrite,
} from "../src/intrinsics/stream_builtins.ts";
import {
  ComponentInstanceState,
  popCurrentThread,
  pushCurrentThread,
  Store,
  Task,
  Thread,
} from "../src/task/mod.ts";
import type { ResolvedOptions } from "../src/exec/boundary.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function assertTraps(fn: () => unknown, includes?: string): void {
  try {
    fn();
  } catch (e) {
    assert(e instanceof Trap, `expected a Trap, got ${e}`);
    if (includes !== undefined) {
      assert(
        String(e).includes(includes),
        `expected trap containing ${JSON.stringify(includes)}, got: ${e}`,
      );
    }
    return;
  }
  throw new Error("expected a trap");
}

// The i32 core wasm delivers for guest literal 0xFFFFFFFF.
const NEG_ONE = 0xffff_ffff | 0;
assertEq(NEG_ONE, -1, "sanity");

/** A live `MemInst` view over a real WebAssembly.Memory (async_builtins_test.ts style). */
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

// ---------------------------------------------------------------------------
// (d) Table.get(-1) should trap, not return undefined
// ---------------------------------------------------------------------------

Deno.test("Table.get(-1) traps instead of silently returning undefined", () => {
  const t = new Table<string>();
  t.add("a");
  // Reference: Table.get traps on any out-of-range index; a negative index
  // is out of range (indices are non-negative). Ours: `i >= array.length` is
  // false for i=-1, and `array[-1] === null` is false (it's `undefined`), so
  // `get` falls through and returns `undefined` with no trap at all.
  assertTraps(() => t.get(-1));
});

// ---------------------------------------------------------------------------
// (a) subtask.drop(-1) must trap AND leave the free list untouched
// ---------------------------------------------------------------------------

Deno.test("subtask.drop(0xFFFFFFFF) traps without corrupting the handle free list", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const drop = createSubtaskDrop(inst);

  assertEq(inst.handles.free.length, 0, "sanity: free list starts empty");
  assertTraps(() => drop(NEG_ONE));
  // Reference: an out-of-range index traps before any table mutation, so the
  // free list is untouched. Ours: `Table.remove(-1)` writes `array[-1] =
  // null` and pushes -1 onto `free` before the instanceof check traps.
  assertEq(
    inst.handles.free.length,
    0,
    "free list must be untouched by a trapping subtask.drop",
  );
});

// ---------------------------------------------------------------------------
// (b) waitable-set.drop(-1) — same shape
// ---------------------------------------------------------------------------

Deno.test("waitable-set.drop(0xFFFFFFFF) traps without corrupting the handle free list", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const drop = createWaitableSetDrop(inst);

  assertEq(inst.handles.free.length, 0, "sanity: free list starts empty");
  assertTraps(() => drop(NEG_ONE));
  assertEq(
    inst.handles.free.length,
    0,
    "free list must be untouched by a trapping waitable-set.drop",
  );
});

// ---------------------------------------------------------------------------
// (b) stream.drop-readable / stream.drop-writable — same shape
// ---------------------------------------------------------------------------

function mkStreamDropCtx(inst: ComponentInstanceState) {
  return {
    componentInstance: () => inst,
    options: () => {
      throw new Error("not used by drop-*");
    },
    streamElem: () => ({ kind: "u8" } as const),
    futureElem: () => null,
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("stream.drop-readable(0xFFFFFFFF) traps without corrupting the handle free list", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const drop = createStreamDropReadable(
    { streamTable: 0 },
    mkStreamDropCtx(inst),
    inst,
  );

  assertEq(inst.handles.free.length, 0, "sanity: free list starts empty");
  assertTraps(() => drop(NEG_ONE));
  assertEq(
    inst.handles.free.length,
    0,
    "free list must be untouched by a trapping stream.drop-readable",
  );
});

Deno.test("stream.drop-writable(0xFFFFFFFF) traps without corrupting the handle free list", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const drop = createStreamDropWritable(
    { streamTable: 0 },
    mkStreamDropCtx(inst),
    inst,
  );

  assertEq(inst.handles.free.length, 0, "sanity: free list starts empty");
  assertTraps(() => drop(NEG_ONE));
  assertEq(
    inst.handles.free.length,
    0,
    "free list must be untouched by a trapping stream.drop-writable",
  );
});

// ---------------------------------------------------------------------------
// (c) stream.write with n = 0xFFFFFFFF must trap (Buffer.MAX_LENGTH)
// ---------------------------------------------------------------------------

Deno.test("stream.write(n=0xFFFFFFFF) traps instead of parking or completing with 0", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const { view } = mkMemory();
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    // deno-lint-ignore no-explicit-any
    memory: view as any,
    realloc: null,
    postReturn: null,
    callback: null,
    async: true,
    cancellable: false,
    coreType: { params: [], results: [] },
    instance: inst,
  };
  const ctx = {
    componentInstance: () => inst,
    options: () => opts,
    streamElem: () => ({ kind: "u8" } as const),
    futureElem: () => null,
    // deno-lint-ignore no-explicit-any
  } as any;

  const newStream = createStreamNew({ streamTable: 0 }, ctx, inst);
  const write = createStreamWrite(
    { streamTable: 0, options: 0 },
    ctx,
    inst,
  );
  const packed = newStream() as bigint;
  const wi = Number(packed >> 32n);

  const task = new Task(
    { params: [], results: [], async: true },
    { async_: true, callback: true, stringEncoding: "utf8", memory: null },
    inst,
    () => [],
    () => {},
  );
  const thread = new Thread(task, (function* () {})());
  pushCurrentThread(thread);
  try {
    // Reference: `BufferGuestImpl.__init__` traps `length > Buffer.MAX_LENGTH`
    // as a u32 comparison, so 0xFFFFFFFF is always over MAX_LENGTH (2^28-1)
    // and this must trap. Ours: `length > BUFFER_MAX_LENGTH` sees the signed
    // JS number -1, the comparison is false, and the write silently parks
    // (returns BLOCKED) instead.
    assertTraps(() => write(wi, 0, NEG_ONE), "MAX_LENGTH");
  } finally {
    popCurrentThread(thread);
  }
});
