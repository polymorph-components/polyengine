// #66: a component fault must never strand or silently satisfy a host
// stream/future operation (contracts/embedder-api.md amendment A7).
//
// Mechanism under test: a trap breaks the enter/leave bracket, the instance
// is poisoned (mayEnter stays false forever), and the retirement walk
// (task/streams.ts `retireInstanceAsyncEnds`, hooked at both bracket-break
// sites) drops every live stream/future end in the poisoned table and
// records the failure — so parked host peers settle and the conventions
// layer rejects them with `PeerTrappedError` instead of hanging or faking a
// clean end-of-stream. Import-position: a trapping host import drops the
// lifted stream/future args it abandoned (instantiate.ts releaseAsyncArgs).
//
// Fixture: examples/guests/stream-pass — `consume-then-trap` (reads, then
// unreachable), `open-then-trap` (writes from a background task, then
// unreachable), plus `forward`/`sink` for the import-position shape.

import { assertEq } from "../support/asserts.ts";
import { caught, guest, haveFixture, instantiateFixture } from "./support.ts";
import { PeerTrappedError, Trap } from "@polyengine/protocol";
import { Stream } from "../../src/embedder/streams.ts";
import { hostStream } from "../../src/exec/mod.ts";

const FIXTURE = guest("stream-pass");
const ready = await haveFixture(FIXTURE);

Deno.test({
  name: "trap retire: a write parked on a trapped consumer rejects with PeerTrappedError",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<number>();
    // More bytes than the guest will consume: whatever wit-bindgen's read
    // granularity is, the offer cannot be fully taken before the trap.
    const big = new Uint8Array(256 * 1024);
    const w = writer.writeAll(big).then(
      (n) => ({ outcome: "resolved" as const, n }),
      (e) => ({ outcome: "rejected" as const, e }),
    );
    const callErr = await caught(() => c.exports.consumeThenTrap(stream, 2));
    assertEq(callErr instanceof Trap, true, `export call traps: ${callErr}`);

    const settled = await w;
    assertEq(
      settled.outcome,
      "rejected",
      `parked writeAll must reject, got ${Deno.inspect(settled)}`,
    );
    const err = (settled as { e: unknown }).e;
    assertEq(err instanceof PeerTrappedError, true, `branded: ${err}`);
    assertEq(
      typeof (err as PeerTrappedError).progress === "number" &&
        (err as PeerTrappedError).progress! < big.length,
      true,
      "progress rides the error and is short of the offer",
    );
    assertEq(
      String((err as Error).message).includes("trapped"),
      true,
      `names the fault: ${err}`,
    );
  },
});

Deno.test({
  name: "trap retire: reads from a stream whose writer trapped reject, data first",
  ignore: !ready,
  fn: async () => {
    // `open-then-trap` writes n bytes from a background task, then traps:
    // the write end dies in the poisoned table. Data copied BEFORE the trap
    // is delivered; after that a read rejects instead of resolving [] (EOS
    // would be wrong data reported as success).
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const out = await c.exports.openThenTrap(3) as Stream<number>;
    let got = 0;
    let err: unknown;
    try {
      for (;;) {
        const chunk = await out.read(4096);
        if (chunk.length === 0) break;
        got += chunk.length;
      }
    } catch (e) {
      err = e;
    }
    assertEq(err instanceof PeerTrappedError, true, `branded: ${err}`);
    assertEq(got, 3, "bytes written before the trap were delivered");
  },
});

Deno.test({
  name: "trap retire: operations started after the trap reject immediately",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<number>();
    const w = writer.writeAll(new Uint8Array(64 * 1024)).catch(() => {});
    await caught(() => c.exports.consumeThenTrap(stream, 1));
    await w;
    const e = await caught(() => writer.write(Uint8Array.from([9])));
    assertEq(e instanceof PeerTrappedError, true, `pre-op branding: ${e}`);
  },
});

Deno.test({
  name: "trap retire: a future whose writer trapped rejects PeerTrappedError, not DroppedError",
  ignore: !ready,
  fn: async () => {
    // The guest parks on the gate stream, so the call resolves and the host
    // can park a read on the future FIRST; releasing the gate then makes the
    // guest trap holding the unwritten write end. The parked await must
    // brand the fault rather than report the "write end dropped without a
    // value" clean-drop shape. (A trap that fires while the export call is
    // still driving arrives as the call's own Trap rejection instead — that
    // path is loud already and not this test's subject.)
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream: gate, writer: gateWriter } = Stream.create<number>();
    const f = c.exports.futureThenTrap(gate);
    const fRead = caught(() => Promise.resolve(f));
    // Let the future read park, then release the gate.
    await new Promise((r) => setTimeout(r, 0));
    await gateWriter.write(Uint8Array.from([1]));
    const e = await fRead;
    assertEq(e instanceof PeerTrappedError, true, `branded: ${e}`);
  },
});

Deno.test({
  name: "trap retire: a trapping import drops its lifted stream args (E2 shape)",
  ignore: !ready,
  fn: async () => {
    // The guest hands the stream to `sink`, which throws unbranded (a host
    // bug -> trap). The lift already transferred the readable end to the
    // host, so the poison walk cannot see it; the import's fail path drops
    // the abandoned args instead. In this pure shape — the trapping guest
    // holds NO other end of the stream — the parked writer settles with the
    // truthful "reader went away" short count, not a PeerTrappedError (the
    // call itself carries the trap). A guest that DOES die holding another
    // end of the same stream gets the poison branding from the walk instead;
    // the two rules overlap there and branding wins.
    const c = await instantiateFixture(FIXTURE, {
      sink: () => {
        throw new Error("sink exploded");
      },
    });
    const { stream, writer } = Stream.create<number>();
    const w = writer.writeAll(Uint8Array.from([1, 2, 3]));
    const callErr = await caught(() => c.exports.forward(stream));
    assertEq(callErr instanceof Trap, true, `the call traps: ${callErr}`);
    assertEq(await w, 0, "parked writeAll settles short instead of hanging");
  },
});

Deno.test({
  name: "clean paths stay unbranded: writer close is end-of-stream, not an error",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(FIXTURE, { sink: () => 0n });
    const { stream, writer } = Stream.create<number>();
    const out = await c.exports.passThrough(stream) as Stream<number>;
    const fed = (async () => {
      await writer.writeAll(Uint8Array.from([5]));
      await writer.close();
    })();
    assertEq([...await out.read(4)], [5]);
    await fed;
    assertEq((await out.read(4)).length, 0, "clean EOS resolves, no throw");
    out.drop();
  },
});

// ---------------------------------------------------------------------------
// One in-flight operation per host end (the guard the #66 repro exposed:
// a second same-direction op used to "rendezvous" against our own parked
// buffer and resolve as if a peer took the data).
// ---------------------------------------------------------------------------

Deno.test({
  name: "host ends: a second same-direction op throws instead of self-rendezvousing",
  ignore: false,
  fn: async () => {
    const hs = hostStream<number>({ kind: "u8" });
    const w1 = hs.writable.write([1, 2, 3]); // parks (no reader)
    let err: unknown;
    try {
      await hs.writable.write([4]);
    } catch (e) {
      err = e;
    }
    assertEq(err instanceof TypeError, true, `write guard: ${err}`);
    assertEq(
      String(err).includes("already in flight"),
      true,
      `message names the misuse: ${err}`,
    );

    // Reading while a write is parked stays legal (different ends): it is
    // the rendezvous itself.
    assertEq([...(await hs.readable.read(8)) as unknown as Uint8Array], [1, 2, 3]);
    assertEq(await w1, 3);

    const r1 = hs.readable.read(8); // parks (no writer)
    let err2: unknown;
    try {
      await hs.readable.read(8);
    } catch (e) {
      err2 = e;
    }
    assertEq(err2 instanceof TypeError, true, `read guard: ${err2}`);
    hs.readable.cancelRead();
    await r1;
  },
});
