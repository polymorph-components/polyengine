// Regression coverage for facade lifecycle/exclusion (#324, #326, #327,
// #331). The shared wrapper is the authority for alias exclusion; facade
// reservation additionally covers work queued before lazy binding.

import { assertEq } from "../support/asserts.ts";
import { Future, Stream } from "../../src/embedder/streams.ts";
import {
  hostFuture,
  hostStream,
  hostStreamFor,
} from "../../src/exec/host_streams.ts";
import type { DirectDestination } from "@polyengine/protocol";
import { instantiate } from "../../src/embedder/mod.ts";
import { artifactsOf, caught, haveFixture } from "./support.ts";

const u8 = {
  element: { kind: "u8" } as const,
  toHost: (v: unknown) => v as number,
  fromHost: (v: number) => v,
};

function throwsTypeError(f: () => unknown): boolean {
  try {
    f();
    return false;
  } catch (e) {
    return e instanceof TypeError;
  }
}

for (const kind of ["write", "writeAll", "writeDirect"] as const) {
  Deno.test(`${kind}: reserves synchronously while binding is pending`, async () => {
    const { stream, writer } = Stream.create<number>();
    const first = kind === "write"
      ? writer.write(new Uint8Array([1]))
      : kind === "writeAll"
      ? writer.writeAll(new Uint8Array([1]))
      : writer.writeDirect((_dest: DirectDestination) => "done");
    assertEq(
      throwsTypeError(() => writer.write(new Uint8Array([2]))),
      true,
    );
    writer.cancelWrite();
    assertEq(await first, 0, "pre-bind cancellation settles promptly");

    stream.bindElement(u8);
    const retry = writer.write(new Uint8Array([3]));
    assertEq([...(await stream.read(1))], [3]);
    assertEq(await retry, 1, "old continuation cannot affect reuse");
    stream.drop();
  });
}

for (const kind of ["write", "writeAll", "writeDirect"] as const) {
  Deno.test(`${kind}: immediate cancellation on an already-bound stream`, async () => {
    const { stream, writer } = Stream.create<number>();
    stream.bindElement(u8);
    const pending = kind === "write"
      ? writer.write(new Uint8Array([1]))
      : kind === "writeAll"
      ? writer.writeAll(new Uint8Array([1]))
      : writer.writeDirect((dest) => {
        dest.markWritten(1);
        return "done";
      });
    writer.cancelWrite();
    assertEq(await pending, 0);
    const retry = writer.write(new Uint8Array([2]));
    assertEq([...(await stream.read(1))], [2]);
    assertEq(await retry, 1);
    stream.drop();
  });
}

Deno.test("writer modes contend pairwise synchronously", async () => {
  const starts = [
    (w: ReturnType<typeof Stream.create<number>>["writer"]) =>
      w.write(new Uint8Array([1])),
    (w: ReturnType<typeof Stream.create<number>>["writer"]) =>
      w.writeAll(new Uint8Array([1])),
    (w: ReturnType<typeof Stream.create<number>>["writer"]) =>
      w.writeDirect(() => "done"),
  ];
  for (const first of starts) {
    for (const second of starts) {
      const { stream, writer } = Stream.create<number>();
      stream.bindElement(u8);
      const pending = first(writer);
      assertEq(throwsTypeError(() => second(writer)), true);
      writer.cancelWrite();
      await pending;
      stream.drop();
    }
  }
});

Deno.test("successful resource cleanup runs once even when release throws", async () => {
  const released: number[] = [];
  const codec = {
    element: { kind: "u32" } as const,
    toHost: (v: unknown) => v as number,
    fromHost: (v: number) => v,
    release: (v: unknown) => {
      released.push(v as number);
      throw new Error("release failed");
    },
  };
  const { stream, writer } = Stream.create<number>();
  stream.bindElement(codec);
  const read = stream.read(1);
  const error = await caught(() => writer.write([1, 2, 3]));
  assertEq(await read, [1]);
  assertEq(String(error).includes("release failed"), true);
  assertEq(released, [2, 3], "each untaken resource is attempted once");
  stream.drop();
});

Deno.test("cancel during conversion preserves conversion and cleanup failures", async () => {
  for (const thrown of [undefined, new Error("conversion failed")]) {
    let releases = 0;
    const pair = Stream.create<number>();
    const writer = pair.writer;
    const codec = {
      element: { kind: "u32" } as const,
      toHost: (v: unknown) => v as number,
      fromHost: (v: number) => {
        if (v === 2) {
          writer.cancelWrite();
          throw thrown;
        }
        return v;
      },
      release: () => {
        releases++;
        throw new Error("cleanup failed");
      },
    };
    pair.stream.bindElement(codec);
    let rejected = false;
    let reason: unknown;
    await writer.write([1, 2]).then(() => {}, (e) => {
      rejected = true;
      reason = e;
    });
    assertEq(rejected, true);
    assertEq(reason, thrown);
    assertEq(releases, 1, "lowered prefix cleanup is attempted once");
    pair.stream.drop();
  }
});

Deno.test("arbitrary undefined write failure remains a rejection", async () => {
  const codec = {
    element: { kind: "u32" } as const,
    toHost: (v: unknown) => v as number,
    fromHost: (_v: number): never => {
      throw undefined;
    },
  };
  const { stream, writer } = Stream.create<number>();
  stream.bindElement(codec);
  let fulfilled = false;
  let rejected = false;
  let reason: unknown;
  await writer.write([1]).then(
    () => fulfilled = true,
    (e) => {
      rejected = true;
      reason = e;
    },
  );
  assertEq(fulfilled, false);
  assertEq(rejected, true);
  assertEq(reason, undefined);
  stream.drop();
});

Deno.test("read/readDirect busy refusal is synchronous and cancellation permits reuse", async () => {
  const { stream, writer } = Stream.create<number>();
  stream.bindElement(u8);
  const read = stream.read(1);
  assertEq(throwsTypeError(() => stream.read(1)), true);
  assertEq(throwsTypeError(() => stream.readDirect(() => "done")), true);
  stream.cancelRead();
  assertEq([...(await read)], []);

  const direct = stream.readDirect(() => "done");
  assertEq(throwsTypeError(() => stream.read(1)), true);
  stream.cancelRead();
  assertEq(await direct, 0);

  const write = writer.write(new Uint8Array([4]));
  assertEq(
    [...(await stream.read(1))],
    [4],
    "opposite directions remain legal",
  );
  assertEq(await write, 1);
  stream.drop();
});

Deno.test("invalid read capacity rejects, while busy takes synchronous precedence", async () => {
  const { stream } = Stream.create<number>();
  stream.bindElement(u8);

  let invalid: Promise<unknown> | undefined;
  assertEq(
    throwsTypeError(() => invalid = stream.read(-1)),
    false,
    "idle capacity failure is not thrown synchronously",
  );
  const error = await caught(() => invalid!);
  assertEq(error instanceof RangeError, true, `expected RangeError: ${error}`);

  const active = stream.read(1);
  assertEq(
    throwsTypeError(() => stream.read(-1)),
    true,
    "busy exclusion wins before capacity validation",
  );
  stream.cancelRead();
  await active;
  stream.drop();
});

Deno.test("busy transfer checks the shared wrapper across aliases", async () => {
  const host = hostFuture<number>(u8.element);
  const first = Future.fromHostFuture(host, u8);
  const alias = Future.fromLifted<number>(host.value, u8);
  const read = Promise.resolve(first.then((v) => v));
  assertEq(throwsTypeError(() => alias.takeValue()), true);
  first.cancel();
  await read.catch(() => {});
  first.drop();

  const hs = hostStreamFor<number>(
    new (await import("../../src/task/mod.ts"))
      .SharedStreamImpl(u8.element) as never,
  );
  const a = Stream.fromHostStream(hs, u8);
  const b = Stream.fromLifted<number>(hs.value, u8);
  const pending = a.read(1);
  assertEq(throwsTypeError(() => b.takeValue(u8)), true);
  a.cancelRead();
  assertEq([...(await pending)], []);
  a.drop();
});

Deno.test("direct read reservation excludes transfer across a more gap", async () => {
  const host = hostStream<number>(u8.element);
  const stream = Stream.fromHostStream(host, u8);
  const alias = Stream.fromLifted<number>(host.value, u8);
  const firstWrite = host.writable.write([1]);
  const direct = stream.readDirect((src) => {
    src.markRead(1);
    return "more";
  });
  await firstWrite;
  assertEq(throwsTypeError(() => alias.takeValue(u8)), true);
  assertEq(throwsTypeError(() => stream.takeValue(u8)), true);
  const secondWrite = host.writable.write([2]);
  await secondWrite;
  stream.cancelRead();
  assertEq(await direct, 2, "the refused transfer preserves the session");
  stream.drop();
});

Deno.test("completed Future payload cannot be transferred, while awaits stay memoized", async () => {
  const host = hostFuture<number>(u8.element);
  const future = Future.fromHostFuture(host, u8);
  const writing = host.write(7);
  assertEq(await future, 7);
  await writing;
  assertEq(await future, 7);
  assertEq(throwsTypeError(() => future.takeValue()), true);
  future.drop();
});

Deno.test("deferred Future reserves before host adoption", async () => {
  let adopt!: (value: unknown) => void;
  const host = hostFuture<number>(u8.element);
  const future = Future.deferred<number>(
    new Promise((resolve) => adopt = resolve) as never,
    u8,
  );
  const pending = future.then((v) => v);
  adopt(host.value);
  await Promise.resolve();
  const alias = Future.fromLifted<number>(host.value, u8);
  assertEq(throwsTypeError(() => alias.takeValue()), true);
  const write = host.write(8);
  assertEq(await pending, 8);
  await write;
  future.drop();
});

Deno.test("completed stream read permits a later transfer", async () => {
  const host = hostStream<number>(u8.element);
  const stream = Stream.fromHostStream(host, u8);
  const write = host.writable.write([5]);
  assertEq([...(await stream.read(1))], [5]);
  await write;
  assertEq(stream.takeValue(u8) === host.value, true);
});

Deno.test("drop before binding settles queued work and cannot resurrect", async () => {
  const { stream, writer } = Stream.create<number>();
  const pending = writer.write(new Uint8Array([8]));
  stream.drop();
  stream.drop();
  assertEq(await pending, 0);
  assertEq(throwsTypeError(() => stream.takeValue(u8)), true);
  await writer.close();
});

Deno.test("drop before any write and immediately after binding is terminal", async () => {
  const fresh = Stream.create<number>();
  fresh.stream.drop();
  assertEq(throwsTypeError(() => fresh.stream.takeValue(u8)), true);
  assertEq(await fresh.writer.close(), undefined);

  const bound = Stream.create<number>();
  bound.stream.bindElement(u8);
  bound.stream.drop();
  assertEq(await bound.writer.write(new Uint8Array([1])), 0);
});

const wasmReady = await haveFixture("runtime/tests/embedder/busy-read.wasm");

Deno.test({
  name: "busy stream transfer is refused before real Wasm entry",
  ignore: !wasmReady,
  fn: async () => {
    const c = await instantiate(
      await artifactsOf("runtime/tests/embedder/busy-read.wasm"),
      {},
      { jspi: false },
    );
    const { stream, writer } = Stream.create<number>();
    const lifted = await c.exports.passStream(stream) as Stream<number>;
    const active = lifted.read(1);
    const e = await caught(() => c.exports.readStream(lifted));
    assertEq(e instanceof TypeError, true, `expected transfer refusal: ${e}`);
    assertEq(await c.exports.ping(), 42, "guest was not poisoned");
    const write = writer.write(new Uint8Array([9]));
    assertEq([...(await active)], [9], "active read remains intact");
    assertEq(await write, 1);
    lifted.drop();
  },
});

Deno.test({
  name: "busy direct stream transfer is refused before real Wasm entry",
  ignore: !wasmReady,
  fn: async () => {
    const c = await instantiate(
      await artifactsOf("runtime/tests/embedder/busy-read.wasm"),
      {},
      { jspi: false },
    );
    const { stream, writer } = Stream.create<number>();
    const lifted = await c.exports.passStream(stream) as Stream<number>;
    const active = lifted.readDirect((src) => {
      src.markRead(src.remaining().length);
      return "done";
    });
    const e = await caught(() => c.exports.readStream(lifted));
    assertEq(e instanceof TypeError, true, `expected transfer refusal: ${e}`);
    const write = writer.write(new Uint8Array([6]));
    assertEq(await active, 1);
    assertEq(await write, 1);
    assertEq(await c.exports.ping(), 42);
    lifted.drop();
  },
});

Deno.test({
  name: "busy future transfer is refused before real Wasm entry",
  ignore: !wasmReady,
  fn: async () => {
    const c = await instantiate(
      await artifactsOf("runtime/tests/embedder/busy-read.wasm"),
      {},
      { jspi: false },
    );
    const host = hostFuture<number>(u8.element);
    const lifted = c.exports.passFuture(
      Future.fromHostFuture(host, u8),
    ) as Future<number>;
    const active = lifted.then((v) => v);
    const e = await caught(() => c.exports.readFuture(lifted));
    assertEq(e instanceof TypeError, true, `expected transfer refusal: ${e}`);
    const write = host.write(7);
    assertEq(await active, 7);
    await write;
    assertEq(await c.exports.ping(), 42);
    lifted.drop();
  },
});
