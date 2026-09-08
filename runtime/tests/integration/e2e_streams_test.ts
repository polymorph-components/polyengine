// Host-side stream/future ends, end to end through the full pipeline
// (runtime/src/exec/host_streams.ts).
//
// These complete the wit-bindgen async roundtrip trio — `wait-then-double`
// (callback ABI + yield, in e2e_async_test.ts), `sum-stream` (guest consumes a
// host-produced stream) and `future-add` (guest awaits a host-produced future)
// — and add the producer direction with the `stream-echo` / `future-user`
// guests, which use `wit_stream::new()` / `wit_future::new()` and forward in a
// background task.

import { assertEq } from "../support/asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import {
  hostFuture,
  hostFutureFor,
  hostStream,
  hostStreamFor,
  instantiateComponent,
} from "../../src/exec/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const root = new URL("../../../", import.meta.url);
async function readArtifact(rel: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    return null;
  }
}
const shimWasm = await readArtifact(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
);
const translator = shimWasm === null ? null : await Translator.create(shimWasm);
const U32 = { kind: "u32" } as const;

async function instantiate(name: string) {
  const bytes = (await readArtifact(
    `examples/guests/build/${name}.component.wasm`,
  ))!;
  const { plan, adapters } = translator!.translate(bytes);
  return await instantiateComponent({ plan, componentBytes: bytes, adapters });
}

const ready = translator !== null &&
  (await readArtifact("examples/guests/build/stream-echo.component.wasm")) !==
    null;

Deno.test({
  name: "async-probe: sum-stream consumes a host-produced stream",
  ignore: !ready,
  fn: async () => {
    const c = await instantiate("async-probe");
    const s = hostStream<number>(U32);
    // The call parks (the guest is waiting for data), so it returns a Promise.
    const pending = (c.exports["sum-stream"] as (v: unknown) => unknown)(
      s.value,
    );
    assert(
      pending instanceof Promise,
      "a parked async export returns a Promise",
    );
    assertEq(await s.writable.writeAll([1, 2, 3, 4]), 4);
    s.writable.drop(); // end-of-stream: the guest's read loop terminates
    assertEq(await pending, 10n);
  },
});

Deno.test({
  name: "async-probe: future-add awaits a host-produced future",
  ignore: !ready,
  fn: async () => {
    const c = await instantiate("async-probe");
    const f = hostFuture<number>(U32);
    const pending =
      (c.exports["future-add"] as (a: unknown, b: number) => unknown)(
        f.value,
        5,
      );
    await f.write(37);
    assertEq(await pending, 42);
  },
});

Deno.test({
  name: "stream-echo: guest consumes and produces streams concurrently",
  ignore: !ready,
  fn: async () => {
    // `echo-doubled` returns its output stream *immediately* and forwards in a
    // background task (wit-bindgen `wit_stream::new()` + spawn), so the host
    // must be able to read the output while still feeding the input.
    const c = await instantiate("stream-echo");
    const input = hostStream<number>(U32);
    const returned =
      await (c.exports["echo-doubled"] as (v: unknown) => unknown)(
        input.value,
      );
    const output = hostStreamFor<number>(returned as never);
    const feed = (async () => {
      await input.writable.writeAll([1, 2, 3]);
      input.writable.drop();
    })();
    const got: number[] = [];
    for (let i = 0; i < 4 && got.length < 3; i++) {
      const vs = await output.readable.read(4);
      if (vs.length === 0) break;
      got.push(...vs);
    }
    await feed;
    assertEq(got, [2, 4, 6]);
  },
});

Deno.test({
  name: "future-user: both future directions",
  ignore: !ready,
  fn: async () => {
    const c = await instantiate("future-user");
    const f = hostFuture<number>(U32);
    const pending = (c.exports["double-future"] as (a: unknown) => unknown)(
      f.value,
    );
    await f.write(21);
    assertEq(await pending, 42);

    // Guest as producer: `make-future` hands back a future it resolves later.
    const c2 = await instantiate("future-user");
    const returned =
      await (c2.exports["make-future"] as (x: number) => unknown)(
        7,
      );
    assertEq(await hostFutureFor<number>(returned as never).read(), 8);
  },
});

Deno.test({
  name: "host stream: element-type mismatch is loud at lower time",
  ignore: !ready,
  fn: async () => {
    // The element type is hand-passed at this layer (typed derivation is
    // bindgen's job), so the first lower into a guest is where a mismatch can
    // be caught — and it must be, since the element type sizes and lifts every
    // copy.
    const c = await instantiate("async-probe");
    const wrong = hostStream<number>({ kind: "u64" });
    let raised: unknown;
    try {
      await (c.exports["sum-stream"] as (v: unknown) => unknown)(wrong.value);
    } catch (e) {
      raised = e;
    }
    assert(
      String(raised).includes("element type mismatch"),
      `expected a loud element-type mismatch, got: ${raised}`,
    );
  },
});
