import { StreamProducerError } from "@polyengine/protocol";
import { lowerFuture } from "../../src/cabi/async_values.ts";
import type { ComponentValue } from "../../src/cabi/types.ts";
import {
  LiftLowerContext,
  mkCanonicalOptions,
} from "../../src/cabi/context.ts";
import {
  Future,
  lowerFutureSource,
  lowerStreamSource,
  Stream,
} from "../../src/embedder/streams.ts";
import {
  HostBuffer,
  hostFutureFor,
  hostStreamFor,
} from "../../src/exec/host_streams.ts";
import {
  ComponentInstanceState,
  type ReadableFutureEnd,
  type SharedFutureImpl,
  type SharedStreamImpl,
  Store,
} from "../../src/task/mod.ts";
import { assertEq } from "../support/asserts.ts";

const cause = new Error("producer failed");
const codec = {
  element: { kind: "u32" } as const,
  where: "import 'test:producer/fail'.read",
  toHost: (v: unknown) => v as number,
  fromHost: (v: number) => v,
};
const bytesCodec = { ...codec, element: { kind: "u8" } as const };
const futureType = { kind: "future", element: codec.element } as const;
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const asValue = (shared: SharedFutureImpl | SharedStreamImpl) =>
  shared as unknown as ComponentValue;

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => resolve = r),
    resolve,
  };
}

async function rejected(p: PromiseLike<unknown>): Promise<unknown> {
  return await Promise.resolve(p).then(
    () => undefined,
    (e) => e,
  );
}

function assertProducerFailure(error: unknown, expectedCause = cause): void {
  assertEq(error instanceof StreamProducerError, true, String(error));
  assertEq((error as StreamProducerError).cause, expectedCause);
  assertEq(String(error).includes(codec.where), true, String(error));
}

function producerFailure(
  error: unknown,
  expectedCause = cause,
): StreamProducerError {
  assertProducerFailure(error, expectedCause);
  return error as StreamProducerError;
}

function failingStream<T>(first?: T) {
  let reject!: (reason: unknown) => void;
  let pulled = false;
  const source = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (!pulled && first !== undefined) {
            pulled = true;
            return Promise.resolve({ done: false, value: first });
          }
          return new Promise<IteratorResult<T>>((_, r) => reject = r);
        },
      };
    },
  };
  return { source, fail: () => reject(cause) };
}

function trackedReadable<T>(
  values: T[] = [],
  cancelFailure?: unknown,
) {
  let cancellations = 0;
  const source = new ReadableStream<T>({
    start(controller) {
      for (const value of values) controller.enqueue(value);
    },
    cancel() {
      cancellations++;
      if (cancelFailure !== undefined) return Promise.reject(cancelFailure);
    },
  });
  return { source, cancellations: () => cancellations };
}

Deno.test("producer failure: failure before binding remains abandonment after guest lowering", async () => {
  const raw = lowerFutureSource(Promise.reject(cause), codec);
  const future = Future.fromLifted<number>(raw, codec);
  await turn();
  const error = producerFailure(await rejected(future));
  assertEq(await rejected(future), error);

  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const index = lowerFuture(
    new LiftLowerContext(mkCanonicalOptions(), inst),
    raw as SharedFutureImpl,
    futureType,
  );
  const end = inst.handles.get(index) as ReadableFutureEnd;
  let result: unknown;
  let guestError: unknown;
  try {
    end.copy(inst, new HostBuffer(codec.element, null, 1) as never, (r) => {
      result = r;
    });
  } catch (e) {
    guestError = e;
  }
  // `SharedFutureImpl.read` traps on abandonment; it must never manufacture
  // the reference's valid CopyResult.DROPPED callback for this unwritten end.
  assertEq(result, undefined);
  assertEq((guestError as Error).cause, error);
  // The failure predates binding, so no store existed to receive it.
  assertEq(store.hostFailure, undefined);
});

Deno.test("producer failure: a bound future wakes its parked host reader and retires activity", async () => {
  let fail!: (reason: unknown) => void;
  const raw = lowerFutureSource(
    new Promise<number>((_, reject) => fail = reject),
    codec,
  );
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const cx = new LiftLowerContext(mkCanonicalOptions(), inst);
  // Use the real canonical lower path so binding and host activity are genuine.
  lowerFuture(cx, raw as SharedFutureImpl, futureType);
  const future = Future.fromLifted<number>(
    asValue(raw as SharedFutureImpl),
    codec,
  );
  const pending = rejected(future);
  await turn();
  fail(cause);
  const error = producerFailure(await pending);
  assertEq(store.hostFailure, error);
  assertEq((raw as SharedFutureImpl).pendingBuffer, null);
  assertEq(store.pendingHostCalls.size, 0);
  assertEq(await rejected(future), error);
});

Deno.test("producer failure: a bound rejection before host await retains identity and retires activity", async () => {
  let fail!: (reason: unknown) => void;
  const raw = lowerFutureSource(
    new Promise<number>((_, reject) => fail = reject),
    codec,
  );
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  lowerFuture(
    new LiftLowerContext(mkCanonicalOptions(), inst),
    raw as SharedFutureImpl,
    futureType,
  );
  fail(cause);
  await turn();
  const future = Future.fromLifted<number>(
    asValue(raw as SharedFutureImpl),
    codec,
  );
  const error = producerFailure(await rejected(future));
  assertEq(store.hostFailure, error);
  assertEq((raw as SharedFutureImpl).pendingBuffer, null);
  assertEq(store.pendingHostCalls.size, 0);
});

Deno.test("producer failure: an unrelated read rejection remains primary", async () => {
  let fail!: (reason: unknown) => void;
  const raw = lowerFutureSource(
    new Promise<number>((_, reject) => fail = reject),
    codec,
  );
  const host = hostFutureFor<number>(raw);
  const primary = new Error("primary read failure");
  host.readResult = async () => {
    fail(cause);
    await turn(); // producer failure is recorded before this rejection resumes
    throw primary;
  };
  const future = Future.fromLifted<number>(raw, codec);
  assertEq(await rejected(future), primary);
});

Deno.test("producer failure: a COMPLETED future payload wins a later pump failure", async () => {
  let resolve!: (value: number) => void;
  const raw = lowerFutureSource(
    new Promise<number>((r) => resolve = r),
    codec,
  ) as SharedFutureImpl;
  const store: { hostFailure?: unknown } = {};
  raw.boundStore = store;
  const write = raw.write;
  raw.write = (inst, src, _done) => {
    // Complete the already-parked reader, but keep the producer write pending
    // so the subsequent throw remains its failure rather than being ignored
    // after Promise resolution.
    write.call(raw, inst, src, () => {});
    throw cause;
  };
  const host = hostFutureFor<number>(asValue(raw));
  const readResult = host.readResult.bind(host);
  const release = deferred();
  host.readResult = async () => {
    const result = await readResult();
    await release.promise;
    return result;
  };
  const future = Future.fromLifted<number>(asValue(raw), codec);
  const completed = Promise.resolve(future);
  await turn(); // park the host read before the producer writes and then fails
  resolve(7);
  await turn();
  const error = producerFailure(store.hostFailure);
  release.resolve();
  assertEq(await completed, 7);
  const reread = await rejected(Future.fromLifted<number>(asValue(raw), codec));
  assertEq(reread instanceof TypeError, true, `single-use reread: ${reread}`);
  assertEq(store.hostFailure, error, "the later producer failure is preserved");
});

Deno.test("producer failure: pending read, iterator, and readable reject", async () => {
  for (
    const consume of [
      (s: Stream<number>) => rejected(s.read(1)),
      (s: Stream<number>) => rejected(s[Symbol.asyncIterator]().next()),
      (s: Stream<number>) => rejected(s.readable().getReader().read()),
    ]
  ) {
    const { source, fail } = failingStream<number>();
    const stream = Stream.fromLifted<number>(
      lowerStreamSource(source, codec),
      codec,
    );
    const pending = consume(stream);
    fail();
    const error = producerFailure(await pending);
    assertEq(await rejected(stream.read(1)), error);
  }
});

Deno.test("producer failure: a completed chunk wins a fault recorded before its continuation", async () => {
  const { source, fail } = failingStream([7]);
  const raw = lowerStreamSource(source, codec) as SharedStreamImpl;
  const store: { hostFailure?: unknown } = {};
  raw.boundStore = store;
  const host = hostStreamFor<number>(asValue(raw));
  const read = host.readable.read.bind(host.readable);
  const release = deferred();
  host.readable.read = async (max) => {
    const result = await read(max);
    await release.promise;
    return result;
  };
  const stream = Stream.fromLifted<number>(asValue(raw), codec);
  const completed = stream.read(1);
  await turn(); // first chunk completed below the gate; the next pull is parked
  fail();
  await turn();
  const error = producerFailure(store.hostFailure);
  release.resolve();
  assertEq(await completed, [7]);
  assertEq(await rejected(stream.read(1)), error);
});

Deno.test("producer failure: unfinished direct reads reject at zero and partial progress", async () => {
  for (const first of [undefined, new Uint8Array([1, 2, 3])]) {
    const { source, fail } = failingStream(first);
    const stream = Stream.fromLifted<number>(
      lowerStreamSource(source, bytesCodec),
      bytesCodec,
    );
    let progress = 0;
    const pending = stream.readDirect((src) => {
      src.markRead(1);
      progress++;
      return "more";
    });
    await turn();
    fail();
    const error = producerFailure(await rejected(pending));
    assertEq(progress, first === undefined ? 0 : 3);
    assertEq(await rejected(stream.read(1)), error);
  }
});

Deno.test("producer failure: direct session ended by done keeps its result", async () => {
  const { source, fail } = failingStream(new Uint8Array([1, 2, 3]));
  const raw = lowerStreamSource(source, bytesCodec) as SharedStreamImpl;
  const store: { hostFailure?: unknown } = {};
  raw.boundStore = store;
  const host = hostStreamFor<number>(asValue(raw));
  const readDirect = host.readable.readDirect.bind(host.readable);
  const release = deferred();
  host.readable.readDirect = async (consume, info) => {
    const result = await readDirect(consume, info);
    await release.promise;
    return result;
  };
  const stream = Stream.fromLifted<number>(
    asValue(raw),
    bytesCodec,
  );
  const completed = stream.readDirect((src) => {
    src.markRead(src.remaining().length);
    return "done";
  });
  await turn(); // direct copy completed below the gate; the next pull is parked
  fail();
  await turn();
  const error = producerFailure(store.hostFailure);
  // Release the already-completed low-level direct result only after the real
  // producer's next pull failed and recorded the fault.
  release.resolve();
  assertEq(await completed, 3);
  assertEq(await rejected(stream.read(1)), error);
});

Deno.test("producer cleanup: zero and partial short writes cancel an unfinished readable source", async () => {
  for (const take of [0, 1]) {
    const tracked = trackedReadable<number[]>([[1, 2]]);
    const raw = lowerStreamSource(tracked.source, codec) as SharedStreamImpl;
    const host = hostStreamFor<number>(asValue(raw));
    if (take !== 0) assertEq(await host.readable.read(take), [1]);
    await turn();
    assertEq(raw.pendingBuffer !== null, true, `take=${take}: writer parked`);
    host.readable.drop();
    await turn();
    assertEq(tracked.cancellations(), 1, `take=${take}`);
    assertEq(
      tracked.source.locked,
      false,
      `take=${take}: reader lock released`,
    );
  }
});

Deno.test("producer cleanup: lowering failure releases its prefix and cancels the readable source", async () => {
  const tracked = trackedReadable<number[]>([[1, 2]]);
  const released: ComponentValue[] = [];
  const loweringFailure = new Error("lowering failed");
  const resourceCodec = {
    ...codec,
    fromHost(value: number): ComponentValue {
      if (value === 2) throw loweringFailure;
      return value;
    },
    release(value: ComponentValue) {
      released.push(value);
    },
  };
  const raw = lowerStreamSource(tracked.source, resourceCodec);
  const stream = Stream.fromLifted<number>(raw, resourceCodec);
  producerFailure(await rejected(stream.read(1)), loweringFailure);
  assertEq(released, [1]);
  assertEq(tracked.cancellations(), 1);
  assertEq(tracked.source.locked, false);
});

Deno.test("producer cleanup: write failure remains primary when readable cancellation rejects", async () => {
  const cancelFailure = new Error("cancel failed");
  const tracked = trackedReadable<number[]>([[1]], cancelFailure);
  const raw = lowerStreamSource(tracked.source, codec) as SharedStreamImpl;
  const host = hostStreamFor<number>(asValue(raw));
  const writeFailure = new Error("write failed");
  host.writable.writeAll = () => Promise.reject(writeFailure);
  const stream = Stream.fromLifted<number>(asValue(raw), codec);
  producerFailure(await rejected(stream.read(1)), writeFailure);
  assertEq(tracked.cancellations(), 1);
  assertEq(tracked.source.locked, false);
  assertEq(raw.pendingBuffer, null);
});

Deno.test("producer cleanup: rejecting cancellation after a clean short write still retires the pump", async () => {
  const tracked = trackedReadable<number[]>(
    [[1, 2]],
    new Error("cancel failed"),
  );
  const raw = lowerStreamSource(tracked.source, codec) as SharedStreamImpl;
  const store: { hostFailure?: unknown } = {};
  raw.boundStore = store;
  const host = hostStreamFor<number>(asValue(raw));
  assertEq(await host.readable.read(1), [1]);
  await turn();
  assertEq(raw.pendingBuffer !== null, true, "remaining write is parked");
  host.readable.drop();
  await turn();
  assertEq(tracked.cancellations(), 1);
  assertEq(tracked.source.locked, false);
  assertEq(raw.pendingBuffer, null);
  assertEq(store.hostFailure, undefined);
});

Deno.test("producer cleanup: parked reader drop cancels exactly once even when cancellation rejects", async () => {
  const tracked = trackedReadable<number[]>([], new Error("cancel failed"));
  const raw = lowerStreamSource(tracked.source, codec);
  hostStreamFor<number>(raw).readable.drop();
  await turn();
  assertEq(tracked.cancellations(), 1);
  assertEq(tracked.source.locked, false);
});

Deno.test("producer cleanup: reader drop drains an already-read owned batch", async () => {
  let controller!: ReadableStreamDefaultController<number[]>;
  const cancellation = deferred();
  let cancellations = 0;
  const released: ComponentValue[] = [];
  const source = new ReadableStream<number[]>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancellations++;
      return cancellation.promise;
    },
  });
  const resourceCodec = {
    ...codec,
    release(value: ComponentValue) {
      released.push(value);
    },
  };
  const raw = lowerStreamSource(source, resourceCodec);
  await Promise.resolve(); // let the pump issue reader.read()
  hostStreamFor<number>(raw).readable.drop();
  // Resolve the pump's own read in the same turn as reader loss. The batch is
  // no longer in the web stream when cancellation runs, so pump cleanup owns it.
  controller.enqueue([1, 2, 3]);
  await turn();
  assertEq(released, [1, 2, 3]);
  assertEq(cancellations, 1);
  assertEq(source.locked, true, "hung cancellation does not hide disposal");
  cancellation.resolve();
  await turn();
  assertEq(source.locked, false);
});

Deno.test("producer cleanup: normal readable EOF releases without cancellation", async () => {
  let cancellations = 0;
  const source = new ReadableStream<number[]>({
    start(controller) {
      controller.enqueue([1]);
      controller.close();
    },
    cancel() {
      cancellations++;
    },
  });
  const raw = lowerStreamSource(source, codec);
  const host = hostStreamFor<number>(raw);
  assertEq(await host.readable.read(1), [1]);
  assertEq(await host.readable.read(1), []);
  assertEq(cancellations, 0);
  assertEq(source.locked, false);
});
