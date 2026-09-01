// Stream pass-through: host -> guest -> host with the guest never reading
// (the #54 investigation's second finding, fixed per contracts/embedder-api.md
// §"Streams and futures"). A stream value is an identity, not a buffer: the readable end must
// survive any number of boundary hops, and once both endpoints are host-side
// the payload must flow host<->host — no guest memory, no wrap failures, no
// same-instance trap for non-numeric elements.
//
// Fixture: examples/guests/stream-pass — `pass-through` returns its input
// stream unchanged; `forward` hands it to the imported `sink`;
// `pass-through-text` does the same for stream<string>.

import { assertEq } from "../support/asserts.ts";
import { artifactsOf, guest, haveFixture, instantiateFixture } from "./support.ts";
import type { ComponentValue, ValType } from "../../src/cabi/types.ts";
import { SharedFutureImpl } from "../../src/task/mod.ts";
import { Future, Stream } from "../../src/embedder/streams.ts";
import {
  hostFuture,
  hostFutureFor,
  hostStream,
  instantiateComponent,
} from "../../src/exec/mod.ts";

const FIXTURE = guest("stream-pass");
const ready = await haveFixture(FIXTURE);

Deno.test({
  name: "pass-through: result position — data flows host->host after the round trip",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<number>();
    const out = await c.exports.passThrough(stream) as Stream<number>;
    assertEq(out instanceof Stream, true, "lifted stream is a Stream handle");

    const fed = (async () => {
      await writer.writeAll(Uint8Array.from([1, 2, 3]));
      await writer.close();
    })();
    const got = await out.read(16);
    await fed;
    assertEq(got instanceof Uint8Array, true, "u8 chunk is a Uint8Array");
    assertEq([...got], [1, 2, 3], "payload arrives intact");
    assertEq(await out.read(16), new Uint8Array(0), "then end-of-stream");
    out.drop();
  },
});

Deno.test({
  name: "pass-through: import position — the sink reads what the host wrote",
  ignore: !ready,
  fn: async () => {
    let sinkArg: unknown;
    const c = await instantiateFixture(FIXTURE, {
      sink: async (s: Stream<number>) => {
        sinkArg = s;
        let n = 0n;
        for await (const chunk of s) n += BigInt(chunk.length);
        return n;
      },
    });
    const { stream, writer } = Stream.create<number>();
    const fed = (async () => {
      await writer.writeAll([9, 8, 7, 6]);
      await writer.close();
    })();
    assertEq(await c.exports.forward(stream), 4n, "sink's count relayed");
    assertEq(sinkArg instanceof Stream, true, "sink received a Stream handle");
    await fed;
  },
});

Deno.test({
  name: "pass-through: non-numeric elements — host<->host rendezvous is legal",
  ignore: !ready,
  fn: async () => {
    // Regression: both host ends used to present one shared HOST_INSTANCE
    // sentinel, so this rendezvous tripped the (guest-only) same-instance
    // restriction: "cannot read from and write to intra-component stream".
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<string>();
    const out = await c.exports.passThroughText(stream) as Stream<string>;
    const fed = (async () => {
      await writer.writeAll(["alpha", "beta"]);
      await writer.close();
    })();
    assertEq(await out.read(8), ["alpha", "beta"]);
    await fed;
    assertEq(await out.read(8), [], "end-of-stream");
    out.drop();
  },
});

Deno.test({
  name: "pass-through: a lifted stream can make a second hop (h->g->h->g->h)",
  ignore: !ready,
  fn: async () => {
    // The readable end transfers per hop (lift removes the handle), so a
    // chain of pass-throughs must keep working — the old once-per-object
    // wrap assert broke the chain at the second lift.
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<number>();
    const once = await c.exports.passThrough(stream) as Stream<number>;
    const twice = await c.exports.passThrough(once) as Stream<number>;
    const fed = (async () => {
      await writer.writeAll(Uint8Array.from([42]));
      await writer.close();
    })();
    assertEq([...await twice.read(4)], [42]);
    await fed;
    twice.drop();
  },
});

Deno.test({
  name: "pass-through: raw layer — the stream value transfers by identity",
  ignore: !ready,
  fn: async () => {
    // The embedder-layer tests above can't see the shared object; pin the
    // mechanism itself at the exec layer: what comes back IS what went in,
    // in both result and import position, so a pure pass-through never
    // copies payload through the guest.
    let received: unknown;
    const arts = await artifactsOf(FIXTURE);
    const h = await instantiateComponent({
      plan: arts.plan,
      componentBytes: arts.componentBytes,
      adapters: arts.adapters,
      imports: {
        sink: (v: unknown) => {
          received = v;
          return 0n;
        },
      },
    });
    const hs = hostStream<number>({ kind: "u8" });
    const out = await (h.exports["pass-through"] as (
      ...a: unknown[]
    ) => Promise<unknown>)(hs.value);
    assertEq(out === hs.value, true, "result position: same shared object");

    const hs2 = hostStream<number>({ kind: "u8" });
    await (h.exports["forward"] as (...a: unknown[]) => Promise<unknown>)(
      hs2.value,
    );
    assertEq(received === hs2.value, true, "import position: same shared object");
  },
});

Deno.test({
  name: "guest-side partial take: a bounded reader drains part of a big typed offer",
  ignore: !ready,
  fn: async () => {
    // #63 review F3 / #67 checklist: the host offers far more than the guest
    // consumes, exercising GuestBuffer partial rendezvous + the writeAll
    // re-offer rounds against a REAL guest (wit-bindgen buffering means the
    // guest's stream.reads may take more than `count` — the writer's total
    // is only bounded, not exact). `take` returns the sum of the `count`
    // elements it consumed, so data integrity is pinned exactly even though
    // the take count is not.
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<number>();
    const N = 256 * 1024;
    const data = Uint8Array.from({ length: N }, (_, i) => (i * 31) & 0xff);
    const expected = BigInt(data[0] + data[1] + data[2]);
    const w = writer.writeAll(data);
    assertEq(await c.exports.take(stream, 3), expected, "sum of first 3");
    const taken = await w;
    assertEq(
      taken >= 3 && taken < N,
      true,
      `writeAll settles short of the offer (took ${taken})`,
    );
  },
});

Deno.test({
  name: "futures: wrapping one shared future is idempotent too",
  ignore: false,
  fn: () => {
    const hf = hostFuture<number>({ kind: "u32" });
    assertEq(hostFutureFor<number>(hf.value) === hf, true, "cached wrapper");
  },
});

Deno.test({
  name: "host<->host u8: partial reads drain a typed write; re-offers stay typed",
  ignore: false,
  fn: async () => {
    // Exercises both halves of the typed-chunk write path (review F3):
    //   * writer arrives SECOND -> partial count -> writeAll re-offers a
    //     subarray view (no extra copy);
    //   * writer arrives FIRST (parked) -> drained across several reads via
    //     the progress cursor.
    // Each read must resolve a Uint8Array with the right bytes, and the
    // writer's total must be exact.
    const hs = hostStream<number>({ kind: "u8" });
    const data = Uint8Array.from([0, 1, 2, 3, 4]);

    const r1 = hs.readable.read(2); // reader parks first
    const wrote = hs.writable.writeAll(data as unknown as number[]);
    const c1 = await r1; // rendezvous #1: writer arrived second
    assertEq(c1 instanceof Uint8Array, true, "chunk 1 typed");
    assertEq([...c1], [0, 1]);
    const c2 = await hs.readable.read(2); // drains the re-offered remainder
    assertEq([...c2], [2, 3]);
    const c3 = await hs.readable.read(2);
    assertEq([...c3], [4]);
    assertEq(await wrote, 5, "writer saw every byte taken");
    assertEq(
      [...data],
      [0, 1, 2, 3, 4],
      "caller's chunk unchanged after settle",
    );
  },
});

Deno.test({
  name: "host<->host u8: a raw plain-array writer still reads back as Uint8Array",
  ignore: false,
  fn: async () => {
    // Raw-layer writers may feed number[]; HostBuffer.taken() packs them so
    // the reader-facing shape stays uniform (and coercion matches the old
    // Uint8Array.from behavior).
    const hs = hostStream<number>({ kind: "u8" });
    const w = hs.writable.write([7, 8, 300]);
    const got = await hs.readable.read(8);
    assertEq(got instanceof Uint8Array, true, "typed despite array source");
    assertEq([...got], [7, 8, 44], "mod-256 coercion parity");
    await w;
  },
});

// ---------------------------------------------------------------------------
// Post-transfer read refusal (#162, contracts/embedder-api.md §"Streams and futures")
// ---------------------------------------------------------------------------

/** Assert `p` rejects with a TypeError whose message names the transfer. */
async function assertTransferRefusal(
  p: Promise<unknown>,
  what: string,
): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  assertEq(err instanceof TypeError, true, `${what}: rejects with a TypeError`);
  assertEq(
    /already been passed to a guest/.test(String((err as Error)?.message)),
    true,
    `${what}: the message names the transfer (got: ${
      String((err as Error)?.message)
    })`,
  );
}

Deno.test({
  name: "deadlock-verdict suppression: reading a Stream handle already passed to a guest is refused",
  ignore: !ready,
  fn: async () => {
    // The guest owns the readable end after the transfer (definitions.py
    // `lower_stream` line 1828 installs it in the callee's table, and the
    // lift removed it from ours), so a host read here would operate a
    // phantom duplicate. Refused loudly. The handle the guest passed BACK is
    // a different handle over the same shared object and reads normally.
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<number>();
    const out = await c.exports.passThrough(stream) as Stream<number>;

    await assertTransferRefusal(stream.read(1), "passed-in Stream");

    const fed = (async () => {
      await writer.writeAll(Uint8Array.from([5, 6]));
      await writer.close();
    })();
    assertEq([...await out.read(8)], [5, 6], "the lifted handle still reads");
    await fed;
    out.drop();
  },
});

Deno.test({
  name:
    "deadlock-verdict suppression: a lifted handle passed back in is refused; the next hop still flows",
  ignore: !ready,
  fn: async () => {
    // The identity round trip of issue #162, end to end: `out` is lifted out
    // of the guest (the host holds its readable end, its activity arm is
    // live), then handed straight back in — which transfers the end away and
    // disarms. Reading `out` afterwards is refused, and the SECOND hop's
    // handle works, which is also the re-arm regression against a real guest.
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<number>();
    const out = await c.exports.passThrough(stream) as Stream<number>;
    const twice = await c.exports.passThrough(out) as Stream<number>;

    await assertTransferRefusal(out.read(1), "re-passed Stream");

    const fed = (async () => {
      await writer.writeAll(Uint8Array.from([11, 12, 13]));
      await writer.close();
    })();
    assertEq([...await twice.read(8)], [11, 12, 13], "data flows to hop two");
    await fed;
    assertEq(await twice.read(8), new Uint8Array(0), "then end-of-stream");
    twice.drop();
  },
});

Deno.test({
  name: "deadlock-verdict suppression: awaiting a Future handle already passed to a guest is refused",
  ignore: false,
  fn: async () => {
    // The `Stream` mirror, at the handle layer (no fixture needed): once
    // `takeValue` has handed the shared object to a lowering site, the guest
    // owns the readable end.
    const codec = {
      element: { kind: "u32" } as ValType,
      toHost: (v: ComponentValue) => v as number,
      fromHost: (v: number) => v as ComponentValue,
    };
    const f = Future.fromHostFuture<number>(
      hostFuture<number>(codec.element),
      codec,
    );
    f.takeValue();
    await assertTransferRefusal(Promise.resolve(f), "passed-in Future");
  },
});

Deno.test({
  name: "deadlock-verdict suppression: a Future read memoized BEFORE the transfer still resolves",
  ignore: false,
  fn: async () => {
    // The read genuinely happened while the host owned the end; only reads
    // STARTED after the transfer are refused. Modelled on a LIFTED future
    // (the host holds the readable end) with a guest-shaped write completing
    // the rendezvous — a host-created future cannot read and write through
    // one wrapper (one in-flight operation per wrapper).
    const codec = {
      element: { kind: "u32" } as ValType,
      toHost: (v: ComponentValue) => v as number,
      fromHost: (v: number) => v as ComponentValue,
    };
    const shared = new SharedFutureImpl(codec.element);
    const f = Future.fromLifted<number>(
      shared as unknown as ComponentValue,
      codec,
    );
    // `then` must be entered BEFORE the transfer to memoize; a
    // `Promise.resolve(f)` would adopt the thenable a microtask later, i.e.
    // after `takeValue()`.
    const pending = new Promise<number>((res, rej) => f.then(res, rej));
    f.takeValue();

    // The guest delivers the value into the parked read.
    let progress = 0;
    const src = {
      remain: () => 1 - progress,
      isZeroLength: () => false,
      read: (n: number) => {
        progress += n;
        return [7];
      },
      write: () => {},
    };
    shared.write(
      Object.freeze({ fakeGuest: true }),
      src as never,
      () => {},
    );
    assertEq(await pending, 7, "the pre-transfer read resolves");
  },
});
