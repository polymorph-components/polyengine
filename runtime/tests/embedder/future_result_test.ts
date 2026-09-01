// Host imports whose results carry futures — the `wasi:sockets@0.3` TCP
// shapes (`send: func(stream<u8>) -> future<…>`, `receive: func() ->
// tuple<stream<u8>, future<…>>`), probed via the `future-import` fixture.
//
// The load-bearing rule (contracts/embedder-api.md §"Streams and futures",
// §"Streams and futures"): an import whose WIT result type is `future<T>` treats a
// thenable return as the FUTURE SOURCE — the import completes immediately
// and the future settles on the producer's schedule. Without that rule the
// dispatch wrapper adopts the Promise as the call's async completion, which
// for `run-send` is a livelock: the future only settles after the guest
// writes the stream, and the guest only writes the stream after the import
// returns.

import { assertEq } from "../support/asserts.ts";
import { guest, haveFixture, instantiateFixture } from "./support.ts";
import { Stream } from "../../src/embedder/streams.ts";

const FIXTURE = guest("future-import");
const have = await haveFixture(FIXTURE);

Deno.test({
  name: "futures: a sync import returning future<u32> accepts a plain Promise",
  ignore: !have,
  async fn() {
    let resolve!: (v: number) => void;
    const c = await instantiateFixture(FIXTURE, {
      nextValue: () => new Promise<number>((r) => (resolve = r)),
      sendSink: () => {
        throw new Error("unused");
      },
      recvPair: () => {
        throw new Error("unused");
      },
    });
    const pending = c.exports.runNext() as Promise<number>;
    // The import has already returned (the guest holds the future and is
    // parked on it); the producer settles it now.
    resolve(42);
    assertEq(await pending, 42);
  },
});

Deno.test({
  name:
    "futures: the tcp-send shape — the guest writes the stream AFTER the sync import returns (livelock probe)",
  ignore: !have,
  async fn() {
    let total = 0;
    const c = await instantiateFixture(FIXTURE, {
      nextValue: () => {
        throw new Error("unused");
      },
      // The wasi:sockets tcp-socket.send contract: consume the guest's
      // stream, settle the returned future with a value only known once
      // the stream ends. Returning this Promise must NOT park the call.
      sendSink: (data: Stream<number>) =>
        (async () => {
          for await (const chunk of data) total += (chunk as Uint8Array).length;
          return total;
        })(),
      recvPair: () => {
        throw new Error("unused");
      },
    });
    // run-send streams 7 bytes of value 1 in two chunks, then awaits the
    // future: only reachable if send-sink returned without parking.
    assertEq(await c.exports.runSend(7), 7);
    assertEq(total, 7);
  },
});

Deno.test({
  name: "futures: the tcp-receive shape — tuple<stream<u8>, future<u32>> from one sync import",
  ignore: !have,
  async fn() {
    const c = await instantiateFixture(FIXTURE, {
      nextValue: () => {
        throw new Error("unused");
      },
      sendSink: () => {
        throw new Error("unused");
      },
      recvPair: () => {
        let settle!: (v: number) => void;
        const done = new Promise<number>((r) => (settle = r));
        const source = (async function* () {
          yield new Uint8Array([1, 2, 3]);
          yield new Uint8Array([4]);
          settle(99);
        })();
        return [source, done];
      },
    });
    // The guest sums the stream (1+2+3+4) and awaits the future (99).
    const [sum, v] = (await c.exports.runRecv()) as [number, number];
    assertEq(sum, 10);
    assertEq(v, 99);
  },
});

Deno.test({
  name: "futures: a rejecting future-source Promise is a producer failure, not an err value",
  ignore: !have,
  async fn() {
    const c = await instantiateFixture(FIXTURE, {
      nextValue: () => Promise.reject(new Error("producer exploded")),
      sendSink: () => {
        throw new Error("unused");
      },
      recvPair: () => {
        throw new Error("unused");
      },
    });
    let threw: unknown;
    try {
      await c.exports.runNext();
    } catch (e) {
      threw = e;
    }
    assertEq(threw !== undefined, true, "the consuming call fails");
    assertEq(
      String(threw).includes("producer exploded") ||
        String((threw as Error).cause ?? "").includes("producer exploded"),
      true,
      `the cause names the producer failure, got: ${threw}`,
    );
  },
});
