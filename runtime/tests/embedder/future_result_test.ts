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
import { caught, guest, haveFixture, instantiateFixture } from "./support.ts";
import {
  Future,
  lowerFutureSource,
  type Stream,
} from "../../src/embedder/streams.ts";
import { hostFuture, hostFutureFor } from "../../src/exec/host_streams.ts";
import type { HostResourceRegistry } from "../../src/embedder/resources.ts";
import { INTERNAL_HOST_REGISTRIES } from "../../src/embedder/instantiate.ts";
import { sync } from "../../src/embedder/sync.ts";
import { StreamProducerError, Trap } from "@polyengine/protocol";
import type { SharedFutureImpl } from "../../src/task/mod.ts";

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const ownFixture = "runtime/tests/embedder/future-own.wasm";
const ownReady = await haveFixture(ownFixture);
for (
  const mode of [
    "drop-before-source",
    "drop-parked",
    "cancel-parked",
    "take",
    "fail",
    "take-fail",
  ] as const
) {
  Deno.test({
    name: `future own cleanup: ${mode}`,
    ignore: !ownReady,
    async fn() {
      let disposed = 0;
      class R {
        [Symbol.dispose]() {
          disposed++;
        }
      }
      const c = await instantiateFixture(ownFixture, { r: R });
      const registry =
        (c as unknown as Record<symbol, Map<number, HostResourceRegistry>>)[
          INTERNAL_HOST_REGISTRIES
        ].get(0)!;
      let resolve!: (value: R) => void;
      const source = new Promise<R>((r) => resolve = r);
      if (mode === "drop-before-source") {
        await c.exports.drop(source);
        resolve(new R());
      } else {
        const f = c.exports.pass(source) as Future<R>;
        resolve(new R());
        await turn();
        assertEq([disposed, registry.liveCount], [0, 1]);
        if (mode === "cancel-parked") {
          f.cancel();
        } else {
          const error = await caught(() =>
            mode === "drop-parked"
              ? c.exports.drop(f)
              : mode === "fail"
              ? c.exports.fail(f)
              : c.exports.take(f, mode === "take-fail")
          );
          assertEq(
            error instanceof Error,
            mode === "fail" || mode === "take-fail",
          );
        }
      }
      await turn();
      assertEq([disposed, registry.liveCount], [1, 0]);
    },
  });
}

Deno.test({
  name:
    "future own cleanup: mapped destructor failure is recorded exactly once",
  ignore: !ownReady,
  async fn() {
    for (const cleanupError of [undefined, new Error("own cleanup failed")]) {
      let disposed = 0;
      class R {
        [Symbol.dispose]() {
          disposed++;
          throw cleanupError;
        }
      }
      const c = await instantiateFixture(ownFixture, { r: R });
      const registry =
        (c as unknown as Record<symbol, Map<number, HostResourceRegistry>>)[
          INTERNAL_HOST_REGISTRIES
        ].get(0)!;
      const f = c.exports.pass(Promise.resolve(new R())) as Future<R>;
      await turn();
      assertEq([disposed, registry.liveCount], [0, 1]);
      assertEq(sync(c.exports.drop)(f), undefined);
      await turn();
      assertEq([disposed, registry.liveCount], [1, 0]);
      // Sync drop returns before pump cleanup; no export consumes the
      // resulting producer-failure slot before this observation.
      const reported = c.handle.componentInstances[0].store.hostFailure;
      assertEq(
        reported instanceof StreamProducerError,
        true,
        String(reported),
      );
      assertEq((reported as StreamProducerError).cause, cleanupError);
      f.drop();
      await turn();
      assertEq([disposed, registry.liveCount], [1, 0]);
    }
  },
});

// Narrow seam tests: source consumption is not a transactional destination commit.
for (
  const stage of [
    "before-read",
    "after-read",
    "after-completion",
    "drop",
  ] as const
) {
  for (const cleanupThrows of [false, true]) {
    Deno.test(`future source accounting: ${stage}, cleanupThrows=${cleanupThrows}`, async () => {
      const primary = new Error("injected write failure");
      let releases = 0;
      const value = lowerFutureSource(Promise.resolve(7), {
        element: { kind: "u32" },
        where: "test own future producer",
        fromHost: (v: number) => v,
        toHost: (v) => v as number,
        release: (v) => {
          assertEq(v, 7);
          releases++;
          if (cleanupThrows) throw undefined;
        },
      });
      const shared = value as SharedFutureImpl;
      // Observe producer reporting without a scheduler or fabricated pump.
      const store: { hostFailure?: unknown } = {};
      shared.boundStore = store;
      const write = shared.write;
      if (stage === "drop") shared.drop();
      else {shared.write = (inst, src, done) => {
          if (stage === "after-read") src.read(1);
          if (stage === "after-completion") write.call(shared, inst, src, done);
          throw primary;
        };}
      const host = hostFutureFor<number>(value);
      const reading = stage === "after-completion" ? host.read() : null;
      await turn();
      if (reading !== null) assertEq(await reading, 7);
      const consumed = stage === "after-read" || stage === "after-completion";
      assertEq(releases, consumed ? 0 : 1);
      if (
        stage === "after-completion" || (stage === "drop" && !cleanupThrows)
      ) {
        assertEq(store.hostFailure, undefined);
      } else {
        assertEq(store.hostFailure instanceof StreamProducerError, true);
        assertEq(
          (store.hostFailure as StreamProducerError).cause,
          stage === "drop" ? undefined : primary,
        );
      }
      host.drop();
      await turn();
      assertEq(releases, consumed ? 0 : 1, "no second release on disposal");
    });
  }
}

const FIXTURE = guest("future-import");
const have = await haveFixture(FIXTURE);

const cleanupFixture = "runtime/tests/embedder/resource-overlap-future.wasm";
const cleanupReady = await haveFixture(cleanupFixture);
for (const synchronous of [false, true]) {
  for (const callFails of [false, true]) {
    Deno.test({
      name:
        `future result cleanup: sync=${synchronous}, callFails=${callFails}`,
      ignore: !cleanupReady,
      async fn() {
        const cleanupError = new Error("borrow disposal failed");
        const primary = new Trap("primary future call failure");
        let disposals = 0;
        class R {
          [Symbol.dispose]() {
            disposals++;
            throw cleanupError;
          }
        }
        const source = hostFuture<number>({ kind: "u32" });
        let resultDrops = 0;
        const drop = source.drop.bind(source);
        source.drop = () => {
          resultDrops++;
          drop();
        };
        const future = Future.fromHostFuture(source, {
          element: { kind: "u32" },
          where: "cleanup test",
          toHost: (v) => v as number,
          fromHost: (v) => v,
        });
        // Forward reference: the closure runs later, after `registry`/`rep`
        // below are filled in.
        const c = await instantiateFixture(cleanupFixture, {
          r: R,
          next: () => future,
          finish: () => {
            registry.dtor(rep);
            if (callFails) throw primary;
          },
        });
        const registry =
          (c as unknown as Record<symbol, Map<number, HostResourceRegistry>>)[
            INTERNAL_HOST_REGISTRIES
          ].get(0)!;
        const cell = new R();
        const rep = registry.repFor(cell);
        let observed: unknown;
        try {
          await (synchronous ? sync(c.exports.run)(cell) : c.exports.run(cell));
        } catch (e) {
          observed = e;
        }
        assertEq(observed, callFails ? primary : cleanupError);
        assertEq(disposals, 1);
        assertEq(registry.liveCount, 0);
        assertEq(resultDrops, callFails ? 0 : 1);
        if (callFails) source.drop();
      },
    });
  }
}

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
  name:
    "futures: the tcp-receive shape — tuple<stream<u8>, future<u32>> from one sync import",
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
  name:
    "futures: a rejecting future-source Promise is a producer failure, not an err value",
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
