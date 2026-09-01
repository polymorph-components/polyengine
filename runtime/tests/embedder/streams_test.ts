// Streams and futures through the conventions facade
// (contracts/embedder-api.md §"Streams and futures").

import { assertEq } from "../support/asserts.ts";
import { caught, guest, haveFixture, instantiateFixture } from "./support.ts";
import { DroppedError, StreamProducerError } from "@polyengine/protocol";
import {
  Future,
  Stream,
} from "../../src/embedder/streams.ts";
import { hostStream, hostStreamFor } from "../../src/exec/mod.ts";
import { LiftLowerContext, mkCanonicalOptions } from "../../src/cabi/context.ts";
import { Table } from "../../src/cabi/handles.ts";
import { liftStream } from "../../src/cabi/async_values.ts";
import { ReadableStreamEnd, SharedStreamImpl } from "../../src/task/mod.ts";

const ready = await haveFixture(guest("async-probe")) &&
  await haveFixture(guest("stream-echo")) &&
  await haveFixture(guest("future-user"));

Deno.test({
  name: "async: an async export is Promise-shaped and suspends transparently",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(guest("async-probe"));
    // `wait-then-double: async func(x: u32) -> u32` yields at least once.
    assertEq(await c.exports.waitThenDouble(21), 42);
  },
});

Deno.test({
  name: "streams: a guest stream<u32> parameter accepts a plain array",
  ignore: !ready,
  fn: async () => {
    // "Lowering accepts the natural JS producers … the layer owns the
    // pumping": the embedder writes no host end, no writeAll loop, no drop.
    const c = await instantiateFixture(guest("async-probe"));
    assertEq(await c.exports.sumStream([1, 2, 3, 4]), 10n);
  },
});

Deno.test({
  name: "streams: … a ReadableStream …",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(guest("async-probe"));
    const rs = new ReadableStream<number[]>({
      start(controller) {
        controller.enqueue([1, 2]);
        controller.enqueue([3, 4, 5]);
        controller.close();
      },
    });
    assertEq(await c.exports.sumStream(rs), 15n);
  },
});

Deno.test({
  name: "streams: … and an async iterable",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(guest("async-probe"));
    async function* gen() {
      yield 10;
      yield 20;
    }
    assertEq(await c.exports.sumStream(gen()), 30n);
  },
});

Deno.test({
  name: "streams: Stream.create() gives a writer, bound at the lowering site",
  ignore: !ready,
  fn: async () => {
    // The element type is a runtime-internal `ValType`, so a host-created
    // stream learns it from the call it is passed to; writes issued before
    // that simply park.
    const c = await instantiateFixture(guest("async-probe"));
    const { stream, writer } = Stream.create<number>();
    const pending = c.exports.sumStream(stream);
    await writer.writeAll([5, 6, 7]);
    await writer.close();
    assertEq(await pending, 18n);
  },
});

Deno.test({
  name: "futures: a guest future<u32> parameter accepts a plain Promise",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(guest("async-probe"));
    // `future-add: async func(f: future<u32>, y: u32) -> u32`.
    assertEq(await c.exports.futureAdd(Promise.resolve(37), 5), 42);
  },
});

Deno.test({
  name: "streams: a guest-returned stream is a Stream<T> with an asyncIterator",
  ignore: !ready,
  fn: async () => {
    // `echo-doubled: async func(input: stream<u32>) -> stream<u32>` returns
    // its output immediately and forwards in a background task, so the host
    // must be able to read the output while still feeding the input.
    const c = await instantiateFixture(guest("stream-echo"));
    const { stream: input, writer } = Stream.create<number>();
    const out = await c.exports.echoDoubled(input);
    assertEq(out instanceof Stream, true, "lifted stream<T> is a Stream handle");

    const feed = (async () => {
      await writer.writeAll([1, 2, 3]);
      await writer.close();
    })();
    const got: number[] = [];
    for await (const chunk of out) {
      got.push(...(chunk as number[]));
      if (got.length >= 3) break;
    }
    await feed;
    assertEq(got, [2, 4, 6]);
    out.drop();
  },
});

Deno.test({
  name: "streams: read(max) chunks, and an empty chunk is end-of-stream",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(guest("stream-echo"));
    const { stream: input, writer } = Stream.create<number>();
    const out = await c.exports.echoDoubled(input);
    const feed = (async () => {
      await writer.writeAll([7]);
      await writer.close();
    })();
    assertEq(await out.read(4), [14]);
    await feed;
    assertEq(await out.read(4), [], "an empty chunk means end");
  },
});

Deno.test({
  name: "futures: a guest-returned future is awaitable directly",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(guest("future-user"));
    // `make-future: async func(x: u32) -> future<u32>`.
    // NOT awaited: a `future<T>` in function-result position is returned as
    // the handle itself (see `Future.deferred` — a thenable cannot survive
    // promise adoption). It is PromiseLike, so `await` still yields T.
    const f = c.exports.makeFuture(7);
    assertEq(f instanceof Future, true, "lifted future<T> is a Future handle");
    assertEq(await f, 8, "Future is PromiseLike — await it directly");
  },
});

Deno.test({
  name: "futures: awaiting a dropped future rejects with DroppedError",
  ignore: !ready,
  fn: async () => {
    // R-fix review note 4: "no value, ever" is a different outcome from "the
    // value was undefined" (a `future<void>`), and must be discriminated.
    const c = await instantiateFixture(guest("future-user"));
    const f = c.exports.makeFuture(1);
    // Let the guest call resolve so the handle exists, then drop it unread.
    await new Promise((r) => setTimeout(r, 0));
    f.drop();
    const e = await caught(() => Promise.resolve(f));
    assertEq(e instanceof DroppedError, true, `expected DroppedError, got ${e}`);
    assertEq(String(e).includes("dropped"), true, `${e}`);
  },
});

Deno.test({
  name: "streams: a Stream handle may be transferred to a guest only once",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(guest("async-probe"));
    const { stream, writer } = Stream.create<number>();
    const p = c.exports.sumStream(stream);
    const e = await caught(() => c.exports.sumStream(stream));
    assertEq(
      String(e).includes("only be transferred once"),
      true,
      `re-passing one stream value must be loud, got: ${e}`,
    );
    await writer.close();
    await p;
  },
});

Deno.test({
  name: "streams: wrapping one shared object is idempotent (same wrapper back)",
  ignore: false,
  fn: () => {
    // §"Streams and futures" (pass-through investigation): a stream that round-trips
    // host -> guest -> host lifts back as the SAME wrapper the host already
    // holds. The old behavior — a hard "already wrapped" assert — turned the
    // spec-legal transfer chain into a failure; the hazard it guarded
    // (a second HostActivity silently orphaning the first wrapper's pumping)
    // is gone by construction when the wrapper is cached per shared object.
    const hs = hostStream<number>({ kind: "u32" });
    const again = hostStreamFor<number>(hs.value);
    assertEq(again === hs, true, "hostStreamFor returns the cached wrapper");
    assertEq(again.value === hs.value, true, "same shared object");
  },
});

Deno.test({
  name: "streams: a shared object crossing into a second store is refused",
  ignore: false,
  fn: () => {
    // R-fix review note 4's other half, at the layer that can actually see it:
    // `liftAsyncValue` records the driving `Store` the first time a shared
    // object is lifted or lowered, and refuses a second one — multi-store is
    // unsupported misuse, and silently pumping the first store would be a
    // deadlock that reads like a hang.
    const shared = new SharedStreamImpl({ kind: "u32" });
    const mkInst = (store: unknown) => {
      const handles = new Table<unknown>();
      const i = handles.add(new ReadableStreamEnd(shared));
      return { inst: { handles, mayLeave: true, store }, index: i };
    };
    const t = { kind: "stream", element: { kind: "u32" } } as const;
    const storeA = { name: "A" }, storeB = { name: "B" };

    const a = mkInst(storeA);
    const cxA = new LiftLowerContext(mkCanonicalOptions(), a.inst as never);
    liftStream(cxA, a.index, t as never); // binds the shared object to store A

    const b = mkInst(storeB);
    const cxB = new LiftLowerContext(mkCanonicalOptions(), b.inst as never);
    let err: unknown;
    try {
      liftStream(cxB, b.index, t as never);
    } catch (e) {
      err = e;
    }
    assertEq(
      String(err).includes("crossed into a second store"),
      true,
      `expected the cross-store assert, got: ${err}`,
    );
  },
});

// ---------------------------------------------------------------------------
// B1: a producer failure must fail the in-flight call, not truncate its data
// ---------------------------------------------------------------------------

Deno.test({
  name: "streams: a producer that fails mid-pump FAILS the consuming call",
  ignore: !ready,
  // Sanitizers on (the default): this test fails if the pump leaves a floating
  // rejection behind, which is exactly half of what it is guarding.
  fn: async () => {
    // Pre-fix behaviour, reproduced by review: the bad element threw inside
    // the pump, the `finally` dropped the write end, the guest saw a clean
    // end-of-stream after ONE element and the call resolved with `1n` — wrong
    // data reported as success — and the throw escaped as an unhandled
    // rejection that killed the process.
    const c = await instantiateFixture(guest("async-probe"));
    const e = await caught(() => c.exports.sumStream([1, "x", 3]));

    // (1) the call must NOT resolve with truncated data
    assertEq(e !== undefined, true, "the consuming call must not resolve");
    assertEq(
      e instanceof StreamProducerError,
      true,
      `expected StreamProducerError, got ${e}`,
    );
    // (2) the surfaced error names the site and carries the cause
    assertEq(
      String(e).includes("sum-stream"),
      true,
      `the error must name the site: ${e}`,
    );
    assertEq(
      String(e).includes("u32 expects an integer number"),
      true,
      `…and the underlying cause: ${e}`,
    );
    assertEq(
      (e as StreamProducerError).cause instanceof TypeError,
      true,
      "`cause` is the original lowering failure",
    );
    // (3) no floating rejection: give the pump a turn to settle, then let the
    // test sanitizers assert the process is clean.
    await new Promise((r) => setTimeout(r, 10));
  },
});

Deno.test({
  name: "streams: a producer that THROWS (not a bad value) fails the same way",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(guest("async-probe"));
    async function* boom() {
      yield 1;
      throw new Error("producer exploded");
    }
    const e = await caught(() => c.exports.sumStream(boom()));
    assertEq(e instanceof StreamProducerError, true, `got ${e}`);
    assertEq(String(e).includes("producer exploded"), true, `${e}`);
    assertEq(String(e).includes("sum-stream"), true, `${e}`);
    await new Promise((r) => setTimeout(r, 10));
  },
});

Deno.test({
  name: "streams: a ReadableStream that errors mid-flight fails the call",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(guest("async-probe"));
    const rs = new ReadableStream<number[]>({
      start(controller) {
        controller.enqueue([1, 2]);
        controller.error(new Error("source aborted"));
      },
    });
    const e = await caught(() => c.exports.sumStream(rs));
    assertEq(e instanceof StreamProducerError, true, `got ${e}`);
    assertEq(String(e).includes("source aborted"), true, `${e}`);
    await new Promise((r) => setTimeout(r, 10));
  },
});

Deno.test({
  name: "futures: a rejecting Promise producer reports its cause, not a bare drop",
  ignore: !ready,
  fn: async () => {
    // `future<T>` has no error channel of its own, so the guest can only ever
    // observe a dropped future — but the CAUSE must still be attributable.
    const c = await instantiateFixture(guest("async-probe"));
    const e = await caught(() =>
      c.exports.futureAdd(Promise.reject(new Error("no value for you")), 5)
    );
    assertEq(e !== undefined, true, "the call must not resolve silently");
    assertEq(String(e).includes("no value for you"), true, `${e}`);
    assertEq(String(e).includes("future-add"), true, `it names the site: ${e}`);
    await new Promise((r) => setTimeout(r, 10));
  },
});

// Issue #182: `Future.deferred` derives `#hostP` from the promise that
// produces the underlying host end (the export call). If that promise
// rejects, `cancel()` — and simply never touching the handle at all — must
// not raise a process-level unhandled rejection; `drop()` already guards
// this (streams.ts:585), `cancel()` did not. These exercise `Future.deferred`
// directly, with no wasm guest involved, since the hazard is entirely at the
// handle layer.

/** A minimal `ElemCodec<number>`; these tests never reach `toHost`/`fromHost`. */
const dummyCodec = {
  element: null,
  toHost: (v: unknown) => v as number,
  fromHost: (v: number) => v as unknown,
  where: "test future",
};

Deno.test({
  name:
    "futures (#182): cancel() on a deferred future whose producing call rejected does not raise an unhandled rejection",
  ignore: false,
  fn: async () => {
    const pending = Promise.reject(new Error("producer call exploded"));
    // deno-lint-ignore no-explicit-any
    const f = Future.deferred(pending, dummyCodec as any);
    // Before the fix, this `.then((h) => h.cancel())` chain had no rejection
    // handler, so once `pending` settled rejected on a later microtask tick,
    // Deno's unhandled-rejection sanitizer would fail the test.
    f.cancel();
    // Give the rejection a turn to (not) escape as unhandled.
    await new Promise((r) => setTimeout(r, 10));
  },
});

Deno.test({
  name:
    "futures (#182): a deferred future never awaited/dropped/cancelled does not raise an unhandled rejection",
  ignore: false,
  fn: async () => {
    const pending = Promise.reject(new Error("producer call exploded"));
    // deno-lint-ignore no-explicit-any
    Future.deferred(pending, dummyCodec as any);
    // The handle is deliberately discarded here, untouched — the backstop
    // at construction time (streams.ts `Future.deferred`) is what must catch
    // this, since no handle method is ever called to attach a swallow.
    await new Promise((r) => setTimeout(r, 10));
  },
});

Deno.test({
  name:
    "futures (#182): the rejection is still observable through the normal await/read path (semantics unchanged)",
  ignore: false,
  fn: async () => {
    const pending = Promise.reject(new Error("producer call exploded"));
    // deno-lint-ignore no-explicit-any
    const f = Future.deferred(pending, dummyCodec as any);
    const e = await caught(() => Promise.resolve(f));
    assertEq(e instanceof Error, true, `expected an Error, got ${e}`);
    assertEq(
      String((e as Error).message).includes("producer call exploded"),
      true,
      `the read path must still surface the real failure: ${e}`,
    );
  },
});
