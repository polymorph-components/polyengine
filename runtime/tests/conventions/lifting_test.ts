// ROW (c) — LIFTING (contracts/embedder-api.md §"Streams and futures").
// What the host RECEIVES: lifted `stream<T>`/`future<T>` arrive branded (the
// protocol predicates recognize them — never `instanceof` against an engine
// class, which module identity removed from the contract); `stream<u8>` chunks are
// `Uint8Array` through both `read(max)` and async iteration while every other
// element type chunks as `T[]` (the `Chunk<T>` rule, stream/future round-trip); an export whose WIT
// result is `future<T>` returns an EAGER handle, not `Promise<Future>`;
// and awaiting a future whose write end dropped without a value rejects
// `DroppedError` — "no value, ever" discriminated from `future<void>`'s
// legitimate `undefined`.

import { guest, haveFixture, instantiateFixture } from "./harness.ts";
import { transcript } from "./support.ts";
import { classify } from "./probe.ts";

const passReady = await haveFixture(guest("stream-pass"));

Deno.test({
  name: "conventions/c: a lifted stream<u8> chunks as Uint8Array — read(max)",
  ignore: !passReady,
  fn: async () => {
    await transcript("c-lift-stream-u8-read", async (t) => {
      const c = await instantiateFixture(guest("stream-pass"), {
        sink: (_d: unknown) => 0n,
      });
      const s = await c.exports.passThrough([10, 20, 30]) as {
        read(n: number): Promise<unknown>;
      };
      // The predicate is the recognition, and it is the ONLY one this suite
      // will accept: a brand check that any copy of protocol agrees with.
      t.note("lifted", { classified: classify(s) });
      await t.attempt("read", () => s.read(8));
      await t.attempt("read", () => s.read(8));
      await t.attempt("read", () => s.read(8));
      // An empty chunk is end-of-stream (never `undefined`, never a throw).
      await t.attempt("read-eos", () => s.read(8));
    });
  },
});

Deno.test({
  name: "conventions/c: a lifted stream<u8> chunks as Uint8Array — async iteration",
  ignore: !passReady,
  fn: async () => {
    await transcript("c-lift-stream-u8-iterate", async (t) => {
      const c = await instantiateFixture(guest("stream-pass"), {
        sink: (_d: unknown) => 0n,
      });
      const s = await c.exports.passThrough([1, 2, 3]) as AsyncIterable<
        unknown
      >;
      t.note("lifted", { classified: classify(s) });
      for await (const chunk of s) t.note("chunk", { chunk });
      t.note("iteration-ended");
    });
  },
});

Deno.test({
  name: "conventions/c: a lifted stream<string> chunks as T[], not Uint8Array",
  ignore: !passReady,
  fn: async () => {
    await transcript("c-lift-stream-nonu8", async (t) => {
      const c = await instantiateFixture(guest("stream-pass"), {
        sink: (_d: unknown) => 0n,
      });
      // §"Value mapping": `list<T>` for T ≠ u8 is a plain array, and the same
      // rule governs chunks — no typed-array widening, ever silently.
      const s = await c.exports.passThroughText(["a", "b"]) as {
        read(n: number): Promise<unknown>;
      };
      t.note("lifted", { classified: classify(s) });
      await t.attempt("read", () => s.read(8));
      await t.attempt("read", () => s.read(8));
      await t.attempt("read-eos", () => s.read(8));
    });
  },
});

const echoReady = await haveFixture(guest("stream-echo"));

Deno.test({
  name: "conventions/c: a guest-PRODUCED stream<u32> lifts as a branded handle",
  ignore: !echoReady,
  fn: async () => {
    await transcript("c-lift-stream-guest-produced", async (t) => {
      const c = await instantiateFixture(guest("stream-echo"));
      // The guest forwards in a background task and returns the output stream
      // immediately, so this is a genuine guest-minted end, not a pass-through.
      const out = await c.exports.echoDoubled([1, 2, 3]) as {
        read(n: number): Promise<unknown>;
      };
      t.note("lifted", { classified: classify(out) });
      await t.attempt("read", () => out.read(4));
      await t.attempt("read", () => out.read(4));
      await t.attempt("read", () => out.read(4));
      await t.attempt("read-eos", () => out.read(4));
    });
  },
});

const futureUserReady = await haveFixture(guest("future-user"));

Deno.test({
  name: "conventions/c: a future<T> RESULT is an eager handle, not a Promise",
  ignore: !futureUserReady,
  fn: async () => {
    await transcript("c-lift-future-eager-handle", async (t) => {
      const c = await instantiateFixture(guest("future-user"));
      const f = c.exports.makeFuture(7) as PromiseLike<number> & {
        drop(): void;
      };
      // Not awaited. JS promise resolution unconditionally adopts thenables,
      // so a `Promise<Future>` could never resolve TO the handle — `drop`/
      // `cancel` would be unreachable. Hence the eager return.
      t.note("result", {
        classified: classify(f),
        isPromiseInstance: f instanceof Promise,
        hasThen: typeof f.then === "function",
        hasDrop: typeof f.drop === "function",
      });
      // It is PromiseLike, so `await` still yields T.
      await t.attempt("await", () => f);
    });
  },
});

Deno.test({
  name: "conventions/c: awaiting a DROPPED-without-value future rejects DroppedError",
  ignore: !futureUserReady,
  fn: async () => {
    await transcript("c-lift-future-dropped", async (t) => {
      const c = await instantiateFixture(guest("future-user"));
      const f = c.exports.makeFuture(1) as PromiseLike<number> & {
        drop(): void;
      };
      // Reach quiescence with one unrelated task, so the producing call has
      // completed and the handle's host end exists (handle disposal's deferred rule).
      await t.attempt("unrelated-call", () => c.exports.doubleFuture(1));
      // handle disposal: `drop()` is a plain handle operation — total and silent.
      f.drop();
      t.note("dropped");
      // "No value, ever" is a different outcome from `future<void>`'s
      // `undefined`, and the contract discriminates it.
      await t.attempt("await-after-drop", () => Promise.resolve(f));
    });
  },
});
