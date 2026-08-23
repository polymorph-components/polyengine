// ROW (b) — LOWERING SOURCES (contracts/embedder-api.md §"Streams and
// futures": "Lowering accepts the natural JS producers"). Where the guest
// expects `stream<T>` the host may pass an array, a `ReadableStream`, an
// `AsyncIterable`, or a `Stream` handle; where it expects `future<T>`, a
// `Promise`, a `Future` handle, or any thenable. Plus amendment A12: an import
// whose WIT RESULT is `future<T>` returns the future SOURCE — the call
// completes immediately and the future settles on the producer's schedule.
//
// Determinism note: every case drives exactly one guest task and awaits it to
// completion. The transcripts record the values that crossed, never the order
// in which independent tasks got scheduled.

import { guest, haveFixture, instantiateFixture } from "./harness.ts";
import { transcript } from "./support.ts";
import { asyncIterable, classify, readable, thenable } from "./probe.ts";

const probeReady = await haveFixture(guest("async-probe"));

Deno.test({
  name: "conventions/b: stream<u32> lowering sources — array, RS, async iter",
  ignore: !probeReady,
  fn: async () => {
    await transcript("b-stream-sources", async (t) => {
      const c = await instantiateFixture(guest("async-probe"));
      // One export, four spellings of the same payload. Equal sums are the
      // whole claim: the adaptation is a source question, never a value one.
      await t.attempt("array", () => c.exports.sumStream([1, 2, 3, 4]));
      await t.attempt(
        "readable-stream",
        () => c.exports.sumStream(readable([1, 2, 3, 4])),
      );
      await t.attempt(
        "async-iterable",
        () => c.exports.sumStream(asyncIterable([1, 2, 3, 4])),
      );
      // An empty finite source is end-of-stream immediately, not a hang.
      await t.attempt("empty-array", () => c.exports.sumStream([]));
    });
  },
});

Deno.test({
  name: "conventions/b: future<u32> lowering sources — Promise, thenable",
  ignore: !probeReady,
  fn: async () => {
    await transcript("b-future-sources", async (t) => {
      const c = await instantiateFixture(guest("async-probe"));
      await t.attempt(
        "promise",
        () => c.exports.futureAdd(Promise.resolve(40), 2),
      );
      // A PLAIN THENABLE — not a Promise, not a handle. The contract names
      // `Promise<T>` and `Future<T>`; a thenable is the shape JS treats as
      // interchangeable with a Promise everywhere else, so what the engine
      // does with one is worth pinning either way.
      await t.attempt("thenable", () => c.exports.futureAdd(thenable(40), 2));
      // An immediate (non-thenable) value in future position.
      await t.attempt("plain-value", () => c.exports.futureAdd(40, 2));
    });
  },
});

const futureUserReady = await haveFixture(guest("future-user"));

Deno.test({
  name: "conventions/b: a Future HANDLE is a lowering source (same store)",
  ignore: !futureUserReady,
  fn: async () => {
    await transcript("b-future-handle-source", async (t) => {
      const c = await instantiateFixture(guest("future-user"));
      // C2: an export whose WIT result is `future<T>` returns the handle
      // EAGERLY — call without awaiting to hold it.
      const f = c.exports.makeFuture(41) as unknown;
      t.note("export-result", { classified: classify(f), value: f });

      // A16: such a handle is DEFERRED — its host end materializes when the
      // producing call completes. Lowering it before then is refused, loudly.
      await t.attempt("lower-while-in-flight", () => c.exports.doubleFuture(f));

      // Drive the instance to quiescence with an unrelated single task, so the
      // producing call has completed. (Deterministic: the probe task's own
      // completion is what is awaited, and the producer needs no further host
      // action.)
      await t.attempt("unrelated-call", () => c.exports.doubleFuture(1));
      await t.attempt("lower-after-settled", () => c.exports.doubleFuture(f));
    });
  },
});

const passReady = await haveFixture(guest("stream-pass"));

Deno.test({
  name: "conventions/b: a Stream HANDLE is a lowering source (A5 round trip)",
  ignore: !passReady,
  fn: async () => {
    await transcript("b-stream-handle-source", async (t) => {
      const c = await instantiateFixture(guest("stream-pass"), {
        sink: (_data: unknown) => 0n,
      });
      // Hop 1: an array lowers in, the guest hands the readable end straight
      // back out without reading it. What arrives is a Stream handle.
      const s1 = await c.exports.passThrough([1, 2, 3]) as {
        read(n: number): Promise<unknown>;
      };
      t.note("hop1", { classified: classify(s1) });
      // Read ONE element off it, so the end carries observable position.
      await t.attempt("hop1/read", () => s1.read(8));

      // Hop 2: that HANDLE is the lowering source. A5: lifting a stream the
      // host already handled is idempotent — a handle over the same underlying
      // END. Note it is NOT the same wrapper OBJECT: the contract promises an
      // end, and the engine mints a fresh wrapper per lift.
      const s2 = await c.exports.passThrough(s1) as typeof s1;
      t.note("hop2", {
        classified: classify(s2),
        sameWrapperObject: (s2 as unknown) === (s1 as unknown),
      });

      // A15's companion refusal: s1's end went to the guest, so a host read
      // through the old handle would operate a phantom duplicate.
      await t.attempt("hop1/read-after-transfer", () => s1.read(8));

      // The identity proof: s2 resumes where s1 stopped — same end, and the
      // payload never touched guest memory.
      await t.attempt("hop2/read", () => s2.read(8));
      await t.attempt("hop2/read-again", () => s2.read(8));
      await t.attempt("hop2/read-eos", () => s2.read(8));
    });
  },
});

Deno.test({
  name: "conventions/b: a Stream handle lowered into an IMPORT reaches the host",
  ignore: !passReady,
  fn: async () => {
    await transcript("b-stream-handle-import-position", async (t) => {
      let seen = "none";
      const c = await instantiateFixture(guest("stream-pass"), {
        // The guest hands the host's own stream back through an import. A5:
        // "host -> guest -> host pass-through works with the guest never
        // reading; the payload then moves host<->host without touching guest
        // memory."
        sink: async (data: { read(n: number): Promise<unknown> }) => {
          seen = classify(data);
          let total = 0n;
          for (;;) {
            const chunk = await data.read(8) as Uint8Array;
            if (chunk.length === 0) break;
            for (const b of chunk) total += BigInt(b);
          }
          return total;
        },
      });
      await t.attempt("forward", () => c.exports.forward([5, 6, 7]));
      t.note("sink-argument", { classified: seen });
    });
  },
});

const futureImportReady = await haveFixture(guest("future-import"));

Deno.test({
  name: "conventions/b: A12 — an import whose result is future<T> returns the source",
  ignore: !futureImportReady,
  fn: async () => {
    await transcript("b-a12-future-result-import", async (t) => {
      // The load-bearing property: `next-value` is a SYNC WIT func. Its
      // returned thenable is lowered as the future ITSELF — the import call
      // completes immediately — not adopted as the call's async completion.
      let settle: (v: number) => void = () => {};
      const c = await instantiateFixture(guest("future-import"), {
        nextValue: () => new Promise<number>((res) => (settle = res)),
        sendSink: async (data: { read(n: number): Promise<Uint8Array> }) => {
          // The tcp `send` shape: the guest writes `data` only AFTER this
          // import returns, so adopting the thenable would be a livelock.
          let n = 0;
          for (;;) {
            const chunk = await data.read(16);
            if (chunk.length === 0) break;
            n += chunk.length;
          }
          return n;
        },
        recvPair: () => {
          let done!: (v: number) => void;
          const settled = new Promise<number>((r) => (done = r));
          const source = (async function* () {
            yield new Uint8Array([1, 2, 3]);
            yield new Uint8Array([4]);
            done(99);
          })();
          return [source, settled];
        },
      });

      const running = c.exports.runNext();
      // The import has already been entered AND RETURNED — the guest holds the
      // future and is parked on it. Nothing here races: the guest cannot make
      // progress until the producer settles, whatever the scheduler does.
      settle(42);
      await t.attempt("run-next", () => running);

      // The livelock probe: `run-send` writes the stream only after the sync
      // import returned, so a reply at all is the A12 property.
      await t.attempt("run-send", () => c.exports.runSend(4));
      // The tcp-receive shape: stream + future out of one sync import.
      await t.attempt("run-recv", () => c.exports.runRecv());
    });
  },
});
