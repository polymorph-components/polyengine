// Direct-access byte edges through the CONVENTIONS facade
// (contracts/embedder-api.md §"Streams and futures", amendment A21,
// 2026-08-22, polyengine#128).
//
// The raw seam and session live in runtime/tests/direct_streams_test.ts;
// this file pins what the *handle* layer adds on top:
//
//   * `StreamWriter.writeDirect` parks until the lowering site binds the
//     element type, then requires `u8` — the `write` refusal shape;
//   * `Stream.readDirect` goes through the same `#require()` gate as `read`
//     (unbound refusal, and the A15 post-transfer guard), plus the `u8` check;
//   * the A7 interplay: a peer trap rejects the session with
//     `PeerTrappedError` carrying the delivered byte count.
//
// Fixture note: `examples/guests/stream-echo` is `stream<u32>`, so it cannot
// carry A21 (which is `stream<u8>` only). The u8 fixture is
// `examples/guests/stream-pass` — `take` (guest consumes a host-fed
// `stream<u8>`), `open-then-trap` (guest produces bytes then traps) and
// `pass-through-text` (a non-u8 element type, for the refusal). No new
// fixtures were built.

import { assertEq } from "../support/asserts.ts";
import { caught, guest, haveFixture, instantiateFixture } from "./support.ts";
import {
  type DirectDestination,
  type DirectSource,
  PeerTrappedError,
  Stream,
} from "../../src/embedder/mod.ts";

const FIXTURE = guest("stream-pass");
const ready = await haveFixture(FIXTURE);

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

Deno.test({
  name: "A21 e2e: StreamWriter.writeDirect feeds a real guest",
  ignore: !ready,
  fn: async () => {
    // `take: async func(input: stream<u8>, count: u32) -> u64` reads `count`
    // elements and returns their sum. The producer never builds a chunk: it
    // writes straight into the guest's landing zone.
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<number>();
    const data = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]);
    const expected = BigInt(data[0] + data[1] + data[2]);

    let sent = 0;
    let aliasedSomething = false;
    // Issued BEFORE the stream is passed to the guest: the writer parks until
    // the lowering site binds the element type.
    const session = writer.writeDirect((dest: DirectDestination) => {
      const win = dest.remaining();
      // The landing zone is guest linear memory, not a runtime scratch.
      aliasedSomething ||= win.byteLength > 0;
      const k = Math.min(win.length, data.length - sent);
      win.set(data.subarray(sent, sent + k));
      dest.markWritten(k);
      sent += k;
      return sent < data.length ? "more" : "done";
    });

    assertEq(await c.exports.take(stream, 3), expected, "sum of the first 3");
    const total = await session;
    assert(aliasedSomething, "the producer saw a non-empty landing zone");
    assert(
      total >= 3 && total <= data.length,
      `session total is bounded by the offer (got ${total})`,
    );
  },
});

Deno.test({
  name:
    "A21 e2e: Stream.readDirect consumes guest output, and a peer trap rejects with the delivered count",
  ignore: !ready,
  fn: async () => {
    // `open-then-trap: async func(n: u32) -> stream<u8>` writes n bytes from
    // a background task and then traps, so the write end dies in the
    // poisoned handle table while our session is parked. Bytes copied BEFORE
    // the fault are delivered; the session then rejects rather than faking a
    // clean end (amendment A7, inherited by A21).
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const out = await c.exports.openThenTrap(3) as Stream<number>;
    const got: number[] = [];
    const e = await caught(() =>
      out.readDirect((src: DirectSource) => {
        const win = src.remaining();
        got.push(...win);
        src.markRead(win.length);
        return "more"; // never volunteers to stop: the trap ends the session
      })
    );
    assert(e instanceof PeerTrappedError, `branded: ${e}`);
    assertEq(got.length, 3, "bytes written before the trap were delivered");
    assertEq(e.progress, 3, "PeerTrappedError carries the session total");
  },
});

Deno.test({
  name:
    "A21: readDirect inherits read's refusals (unbound, and the A15 transfer guard)",
  ignore: !ready,
  fn: async () => {
    // Unbound: `Stream.create()` has no element type until a lowering site
    // supplies one. `read`'s refusal, verbatim — unlike the WRITER, which
    // parks.
    const fresh = Stream.create<number>().stream;
    const unbound = await caught(() => fresh.readDirect(() => "done"));
    assert(unbound instanceof TypeError, `unbound: TypeError, got ${unbound}`);
    assert(
      String(unbound.message).includes("has not been " + "passed to a guest"),
      `unbound names the reason: ${unbound}`,
    );

    // A15 (#162): once the handle's shared object has been passed to a guest,
    // the guest owns the readable end and a host read here would operate a
    // phantom duplicate.
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<number>();
    const out = await c.exports.passThrough(stream) as Stream<number>;
    const e = await caught(() => stream.readDirect(() => "done"));
    assert(e instanceof TypeError, `transferred: TypeError, got ${e}`);
    assert(
      String(e.message).includes("already been passed to a guest"),
      `names the A15 guard: ${e}`,
    );
    await writer.close();
    out.drop();
  },
});

Deno.test({
  name: "A21: a non-u8 element type is refused on both direct forms",
  ignore: !ready,
  fn: async () => {
    // `pass-through-text` is `stream<string>`: the writer parks until that
    // lowering binds the element type, and THEN discovers it is not u8.
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<string>();
    const out = await c.exports.passThroughText(stream) as Stream<string>;
    for (
      const [who, e] of [
        ["writeDirect", await caught(() => writer.writeDirect(() => "done"))],
        ["readDirect", await caught(() => out.readDirect(() => "done"))],
      ] as const
    ) {
      assert(e instanceof TypeError, `${who}: TypeError, got ${e}`);
      assert(
        String(e.message).includes("stream<u8> only"),
        `${who} names A21's scope: ${e}`,
      );
    }
    await writer.close();
    out.drop();
  },
});

Deno.test({
  name:
    "A21: host<->host through a round trip — two direct sessions are refused",
  ignore: !ready,
  fn: async () => {
    // `pass-through` hands the stream straight back (A5 identity), so both
    // endpoints end up host-side. A chunk form on either side is fine; two
    // direct sessions are not, and the ARRIVING one is what fails.
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<number>();
    const out = await c.exports.passThrough(stream) as Stream<number>;

    const session = writer.writeDirect((dest) => {
      dest.remaining().set(Uint8Array.from([1, 2, 3]));
      dest.markWritten(3);
      return "done";
    });
    // Let the producer's session actually park before the consumer arrives:
    // `writeDirect` awaits `whenBound()` first, so which side is "arriving"
    // is otherwise decided by microtask ordering.
    await new Promise((r) => setTimeout(r, 0));

    const e = await caught(() => out.readDirect(() => "done"));
    assert(e instanceof TypeError, `TypeError, got ${e}`);
    assert(
      String(e.message).includes("at least one side"),
      `names the rule: ${e}`,
    );

    // The parked session is undisturbed: the chunk form still drains it.
    const got = await out.read(16);
    assertEq([...got], [1, 2, 3], "the chunk read completes the session");
    assertEq(await session, 3);
    out.drop();
  },
});

Deno.test({
  name:
    "A21: host<->host at the same floor — each direct form against the peer chunk form",
  ignore: !ready,
  fn: async () => {
    // Both mixed rows of the host↔host matrix, through the conventions layer
    // and across a real boundary round trip (`pass-through`).
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });

    // writeDirect vs a chunk read: the marked prefix becomes the chunk.
    {
      const { stream, writer } = Stream.create<number>();
      const out = await c.exports.passThrough(stream) as Stream<number>;
      const w = writer.writeDirect((dest: DirectDestination) => {
        const win = dest.remaining();
        win.set(Uint8Array.from([5, 6, 7, 8]).subarray(0, win.length));
        dest.markWritten(Math.min(4, win.length));
        return "done";
      });
      const got = await out.read(16);
      assertEq([...got], [5, 6, 7, 8], "the direct producer's bytes arrive");
      assertEq(await w, 4);
      out.drop();
    }

    // readDirect vs a chunk write: the view IS the offered chunk (A5 borrow).
    {
      const { stream, writer } = Stream.create<number>();
      const out = await c.exports.passThrough(stream) as Stream<number>;
      const w = writer.write(Uint8Array.from([1, 2, 3]));
      const got: number[] = [];
      const n = await out.readDirect((src: DirectSource) => {
        const win = src.remaining();
        got.push(...win);
        src.markRead(win.length);
        return "done";
      });
      assertEq(n, 3, "the consumer's session total");
      assertEq(got, [1, 2, 3]);
      assertEq(await w, 3, "the chunk write completes");
      out.drop();
    }
  },
});
