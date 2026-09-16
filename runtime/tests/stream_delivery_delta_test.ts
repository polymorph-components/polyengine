// Focused regression coverage for the stream/future delivery delta authorized
// from WebAssembly/component-model#719 head 35e9769957627c2, plus the two
// independently identified Wasmtime-row bugs (payloadless maximum counts and
// error-context result-area bounds).

import { assertEq } from "./support/asserts.ts";
import { Trap } from "../src/cabi/mod.ts";
import {
  BLOCKED,
  createWaitableSetPoll,
  createWaitableSetWait,
} from "../src/intrinsics/async_builtins.ts";
import {
  createErrorContextDebugMessage,
  createFutureDropReadable,
  createFutureNew,
  createFutureRead,
  createFutureWrite,
  createStreamCancelRead,
  createStreamCancelWrite,
  createStreamDropReadable,
  createStreamDropWritable,
  createStreamNew,
  createStreamRead,
  createStreamTransfer,
  createStreamWrite,
  type StreamTrampolineContext,
} from "../src/intrinsics/stream_builtins.ts";
import type { ResolvedOptions } from "../src/exec/boundary.ts";
import {
  BUFFER_MAX_LENGTH,
  ComponentInstanceState,
  CopyResult,
  CopyState,
  ErrorContext,
  EventCode,
  popCurrentThread,
  pushCurrentThread,
  SharedStreamImpl,
  Store,
  Task,
  Thread,
  WaitableSet,
  type WritableFutureEnd,
  type WritableStreamEnd,
} from "../src/task/mod.ts";

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

function assertTrap(fn: () => unknown, text: string): void {
  try {
    fn();
  } catch (e) {
    assert(e instanceof Trap, `expected Trap, got ${Deno.inspect(e)}`);
    assert(String(e.message).includes(text), `unexpected trap: ${e.message}`);
    return;
  }
  throw new Error("expected trap");
}

function memoryView(memory: WebAssembly.Memory) {
  return {
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
}

function fixture(kind: "stream" | "future", elem: { kind: "u8" } | null) {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    // deno-lint-ignore no-explicit-any
    memory: memoryView(memory) as any,
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
    streamElem: () => elem,
    futureElem: () => elem,
    resultTypes: () => [],
    suspensionMode: "plain" as const,
    streamTableInstance: () => inst,
    futureTableInstance: () => inst,
  } as unknown as StreamTrampolineContext;
  const task = new Task(
    { params: [], results: [], async: true },
    { async_: true, callback: true, stringEncoding: "utf8", memory: null },
    inst,
    () => [],
    () => {},
  );
  const thread = new Thread(task, (function* () {})());
  const newPair = kind === "stream"
    ? createStreamNew({ streamTable: 0 }, ctx, inst)
    : createFutureNew({ futureTable: 0 }, ctx, inst);
  const packed = newPair() as bigint;
  const ri = Number(packed & 0xffff_ffffn);
  const wi = Number(packed >> 32n);
  return {
    inst,
    memory,
    ctx,
    ri,
    wi,
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

Deno.test("idle drop is one-shot and drop-before-join remains observable", () => {
  const f = fixture("stream", { kind: "u8" });
  const writer = f.inst.handles.get(f.wi) as WritableStreamEnd;
  f.run(() =>
    createStreamDropReadable({ streamTable: 0 }, f.ctx, f.inst)(f.ri)
  );
  assertEq(writer.hasPendingEvent(), true);
  const set = new WaitableSet();
  writer.join(set);
  const [code, index, payload] = set.getPendingEvent();
  assertEq([code, index, payload], [
    EventCode.STREAM_WRITE,
    f.wi,
    CopyResult.DROPPED,
  ]);
  assertEq(writer.hasPendingEvent(), false);
  assertEq(writer.state, CopyState.DONE);
});

Deno.test("FACT transfer preserves endpoint identity and reports destination index", () => {
  const f = fixture("stream", { kind: "u8" });
  const end = f.inst.handles.get(f.ri);
  f.run(() =>
    createStreamDropWritable({ streamTable: 0 }, f.ctx, f.inst)(f.wi)
  );
  const dstInst = new ComponentInstanceState(1, f.inst.store);
  // Give the destination an independent occupied prefix so its assigned index
  // cannot coincidentally equal the source slot.
  while (dstInst.handles.add(new WaitableSet()) <= f.ri) {
    // keep filling
  }
  const ctx = {
    ...(f.ctx as unknown as Record<string, unknown>),
    streamTableInstance: (index: number) => index === 0 ? f.inst : dstInst,
    streamElem: () => ({ kind: "u8" }),
  } as unknown as StreamTrampolineContext;
  const transfer = createStreamTransfer(ctx as never);
  const dst = f.run(() => transfer(f.ri, 0, 1)) as number;
  assert(dst !== f.ri, "test must force a distinct destination index");
  assert(
    end === dstInst.handles.get(dst),
    "FACT transfer must move the same endpoint",
  );
  const moved = end as { getPendingEvent(): [EventCode, number, number] };
  const [, index, payload] = moved.getPendingEvent();
  assertEq(index, dst);
  assertEq(payload, CopyResult.DROPPED);
});

for (const first of ["read", "write"] as const) {
  for (const [firstLength, secondLength] of [[0, 0], [0, 1], [1, 0]] as const) {
    Deno.test(`same-instance nonnumeric ${first} ${firstLength}/${secondLength} is permitted`, () => {
      const shared = new SharedStreamImpl({ kind: "string" });
      const inst = {};
      const buffer = (length: number) => ({
        t: { kind: "string" } as const,
        remain: () => length,
        isZeroLength: () => length === 0,
      });
      const call = (side: "read" | "write", length: number) => {
        if (side === "read") {
          shared.read(inst, buffer(length) as never, () => {}, () => {});
        } else shared.write(inst, buffer(length) as never, () => {}, () => {});
      };
      call(first, firstLength);
      call(first === "read" ? "write" : "read", secondLength);
    });
  }
}

for (const pending of ["read", "write"] as const) {
  for (
    const scenario of [
      { name: "zero", originalLength: 0, transfers: [] },
      { name: "exact-full", originalLength: 4, transfers: [4] },
      { name: "multiple-partial", originalLength: 8, transfers: [3, 2, 3] },
    ] as const
  ) {
    Deno.test(`PR719 stream ${pending} event observes peer drop after detaching ${scenario.name} buffer`, () => {
      const f = fixture("stream", { kind: "u8" });
      const read = createStreamRead(
        { streamTable: 0, options: 0 },
        f.ctx,
        f.inst,
      );
      const write = createStreamWrite(
        { streamTable: 0, options: 0 },
        f.ctx,
        f.inst,
      );
      const originalEnd = f.inst.handles.get(
        pending === "read" ? f.ri : f.wi,
      ) as WritableStreamEnd;
      f.run(() => {
        const first = pending === "read"
          ? read(f.ri, 64, scenario.originalLength)
          : write(f.wi, 0, scenario.originalLength);
        assertEq(first, BLOCKED);
        for (const n of scenario.transfers) {
          const arriving = pending === "read"
            ? write(f.wi, 0, n)
            : read(f.ri, 64, n);
          assertEq((arriving as number) & 0xf, CopyResult.COMPLETED);
        }
        // The opposite end starts one more operation. Because the original
        // buffer is now full (including the zero-length case), this detaches
        // that original buffer and leaves the new peer operation parked.
        const peerPark = pending === "read"
          ? write(f.wi, 0, 1)
          : read(f.ri, 64, 1);
        assertEq(peerPark, BLOCKED);
      });
      assertEq(originalEnd.hasPendingEvent(), true);

      // Cancel the newly parked peer operation, consume its cancellation, and
      // then drop that peer through the real canonical intrinsics. The
      // original event remains pending throughout.
      const cancelPeer = pending === "read"
        ? createStreamCancelWrite(
          { streamTable: 0, async: true },
          f.ctx,
          f.inst,
        )
        : createStreamCancelRead(
          { streamTable: 0, async: true },
          f.ctx,
          f.inst,
        );
      const peerIndex = pending === "read" ? f.wi : f.ri;
      assertEq(
        (f.run(() => cancelPeer(peerIndex)) as number) & 0xf,
        CopyResult.CANCELLED,
      );
      const dropPeer = pending === "read"
        ? createStreamDropWritable({ streamTable: 0 }, f.ctx, f.inst)
        : createStreamDropReadable({ streamTable: 0 }, f.ctx, f.inst);
      f.run(() => dropPeer(peerIndex));

      // Wait and poll each exercise a real event-consumption path.
      const set = new WaitableSet();
      const seti = f.inst.handles.add(set);
      originalEnd.join(set);
      const consume = pending === "read"
        // The fixture context includes both stream and async methods.
        // deno-lint-ignore no-explicit-any
        ? createWaitableSetWait({ options: 0 }, f.ctx as any, f.inst)
        // deno-lint-ignore no-explicit-any
        : createWaitableSetPoll({ options: 0 }, f.ctx as any, f.inst);
      const code = f.run(() => consume(seti, 128)) as number;
      const payload = new DataView(f.memory.buffer).getUint32(132, true);
      assertEq(
        code,
        pending === "read" ? EventCode.STREAM_READ : EventCode.STREAM_WRITE,
      );
      assertEq(payload & 0xf, CopyResult.DROPPED);
      assertEq(payload >>> 4, scenario.originalLength);
      assertEq(originalEnd.state, CopyState.DONE);
    });
  }
}

Deno.test("PR719 stream peer drop takes precedence over CM-3 cancel remap", () => {
  const f = fixture("stream", { kind: "u8" });
  const read = createStreamRead({ streamTable: 0, options: 0 }, f.ctx, f.inst);
  const write = createStreamWrite(
    { streamTable: 0, options: 0 },
    f.ctx,
    f.inst,
  );
  const cancel = createStreamCancelWrite(
    { streamTable: 0, async: true },
    f.ctx,
    f.inst,
  );
  f.run(() => {
    assertEq(write(f.wi, 0, 4), BLOCKED);
    assertEq((read(f.ri, 64, 4) as number) >>> 4, 4);
  });
  const writer = f.inst.handles.get(f.wi) as WritableStreamEnd;
  // Detach the completed original write by parking a fresh peer read, cancel
  // that read, then drop the peer through its intrinsic.
  assertEq(f.run(() => read(f.ri, 64, 1)), BLOCKED);
  const cancelRead = createStreamCancelRead(
    { streamTable: 0, async: true },
    f.ctx,
    f.inst,
  );
  assertEq(
    (f.run(() => cancelRead(f.ri)) as number) & 0xf,
    CopyResult.CANCELLED,
  );
  const dropRead = createStreamDropReadable(
    { streamTable: 0 },
    f.ctx,
    f.inst,
  );
  f.run(() => dropRead(f.ri));
  const result = f.run(() => cancel(f.wi)) as number;
  assertEq(result & 0xf, CopyResult.DROPPED);
  assertEq(result >>> 4, 4);
  assertEq(writer.state, CopyState.DONE);
});

Deno.test("PR719 does not retroactively rewrite a delivered stream event", () => {
  const f = fixture("stream", { kind: "u8" });
  const read = createStreamRead({ streamTable: 0, options: 0 }, f.ctx, f.inst);
  const write = createStreamWrite(
    { streamTable: 0, options: 0 },
    f.ctx,
    f.inst,
  );
  const result = f.run(() => {
    assertEq(write(f.wi, 0, 1), BLOCKED);
    return read(f.ri, 64, 1) as number;
  });
  assertEq(result & 0xf, CopyResult.COMPLETED);
  const dropRead = createStreamDropReadable(
    { streamTable: 0 },
    f.ctx,
    f.inst,
  );
  f.run(() => dropRead(f.ri));
  assertEq(result & 0xf, CopyResult.COMPLETED);
});

Deno.test("PR719 future CANCELLED upgrades to DROPPED, while COMPLETED stays stable", () => {
  const cancelled = fixture("future", null);
  const write = createFutureWrite(
    { futureTable: 0, options: 0 },
    cancelled.ctx,
    cancelled.inst,
  );
  assertEq(cancelled.run(() => write(cancelled.wi, 0)), BLOCKED);
  const cancelledEnd = cancelled.inst.handles.get(
    cancelled.wi,
  ) as WritableFutureEnd;
  // The public cancel intrinsic consumes an immediately-produced event in the
  // same call, so this delivery-window state is necessarily driven at the
  // CopyEnd seam: arm cancellation without consuming it, then lose the peer.
  cancelledEnd.state = CopyState.CANCELLING_COPY;
  cancelledEnd.shared.cancel();
  cancelledEnd.shared.drop();
  const [, , dropped] = cancelledEnd.getPendingEvent();
  assertEq(dropped, CopyResult.DROPPED);
  assertEq(cancelledEnd.state, CopyState.DONE);

  const completed = fixture("future", null);
  const read2 = createFutureRead(
    { futureTable: 0, options: 0 },
    completed.ctx,
    completed.inst,
  );
  const write2 = createFutureWrite(
    { futureTable: 0, options: 0 },
    completed.ctx,
    completed.inst,
  );
  assertEq(completed.run(() => write2(completed.wi, 0)), BLOCKED);
  assertEq(completed.run(() => read2(completed.ri, 0)), CopyResult.COMPLETED);
  const completedEnd = completed.inst.handles.get(
    completed.wi,
  ) as WritableFutureEnd;
  const dropRead = createFutureDropReadable(
    { futureTable: 0 },
    completed.ctx,
    completed.inst,
  );
  completed.run(() => dropRead(completed.ri));
  const [, , kept] = completedEnd.getPendingEvent();
  assertEq(kept, CopyResult.COMPLETED);
  assertEq(completedEnd.state, CopyState.DONE);
});

Deno.test("payloadless builtins transfer Buffer.MAX_LENGTH without allocation", () => {
  const f = fixture("stream", null);
  const read = createStreamRead({ streamTable: 0, options: 0 }, f.ctx, f.inst);
  const write = createStreamWrite(
    { streamTable: 0, options: 0 },
    f.ctx,
    f.inst,
  );
  f.run(() => {
    assertEq(read(f.ri, 0, BUFFER_MAX_LENGTH), BLOCKED);
    assertEq(write(f.wi, 0, BUFFER_MAX_LENGTH), 0xfffffff0);
  });
});

Deno.test("error-context debug-message validates its result area before realloc", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const memory = new WebAssembly.Memory({ initial: 1 });
  let reallocs = 0;
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    // deno-lint-ignore no-explicit-any
    memory: memoryView(memory) as any,
    realloc: () => (_old, _oldSize, _align, _newSize) => {
      reallocs++;
      return 100;
    },
    postReturn: null,
    callback: null,
    async: false,
    cancellable: false,
    coreType: { params: [], results: [] },
    instance: inst,
  };
  const ctx = {
    options: () => opts,
  } as unknown as StreamTrampolineContext;
  const debug = createErrorContextDebugMessage({ options: 0 }, ctx, inst);
  const i = inst.handles.add(new ErrorContext("a"));
  debug(i, 65528);
  assertEq(reallocs, 1);
  assertEq(new DataView(memory.buffer).getUint32(65528, true), 100);
  assertTrap(() => debug(i, 65532), "invalid debug message pointer");
  assertEq(reallocs, 1, "invalid result area traps before realloc");
});
