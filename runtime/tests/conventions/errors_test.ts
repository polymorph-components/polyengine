// ROW (e) — THE ERROR MODEL (contracts/embedder-api.md §"Error model").
//
// The four claims, in one place because they are one rule seen from four
// sides:
//   1. a guest export's `result<T, E>` err lifts as a `ComponentException`
//      whose `payload` is the WIT err value;
//   2. a host import's `throw new ComponentException(payload)` lowers to the
//      guest's err case;
//   3. a HAND-ROLLED branded exception is honored identically — module identity's
//      zero-import legality, demonstrated by `probe_zero_import.ts`, which
//      imports nothing at all;
//   4. an UNBRANDED host throw is a host BUG and becomes a trap naming the
//      import — never a guest-visible err. This is the inversion of jco's
//      convention, and the reason a host module needs no defensive wrapper.
//
// Plus recognition: `Trap` and `PeerTrappedError` are identified by protocol
// predicate. Trap MESSAGE text is diagnostic, not API — an engine-worded trap
// (a raw `unreachable`) is recorded by brand alone (see support.ts).

import { guest, haveFixture, instantiateFixture, testdata } from "./harness.ts";
import { transcript } from "./support.ts";
import { classify, ComponentException } from "./probe.ts";
import { handRolledException } from "./probe_zero_import.ts";

const HOST_RESULT = "runtime/tests/embedder/host-result.wasm";
const HOST_PAYLOAD = "runtime/tests/embedder/host-result-payload.wasm";

const valuesReady = await haveFixture(guest("values"));

Deno.test({
  name: "conventions/e: a guest err-result lifts as ComponentException(payload)",
  ignore: !valuesReady,
  fn: async () => {
    await transcript("e-guest-err-lifts", async (t) => {
      const c = await instantiateFixture(guest("values"));
      // `echo-result: func(v: result<u32,string>) -> result<u32,string>`.
      // As a VALUE (parameter position) a result is plain `{kind, value}`
      // data that never throws; in RESULT position the same value throws.
      await t.attempt("ok", () => c.exports.echoResult({ kind: "ok", value: 5 }));
      await t.attempt(
        "err",
        () => c.exports.echoResult({ kind: "err", value: "boom" }),
      );
    });
  },
});

const emptyReady = await haveFixture(HOST_RESULT);

Deno.test({
  name: "conventions/e: host ComponentException -> guest err (payloadless side)",
  ignore: !emptyReady,
  fn: async () => {
    await transcript("e-host-throw-empty", async (t) => {
      // `check: func() -> result` — both sides empty. `run()` hands the
      // discriminant back: 0 = the guest saw ok, 1 = the guest saw err.
      const ok = await instantiateFixture(HOST_RESULT, {
        "host:api/fallible": { check: () => undefined },
      });
      await t.attempt("return-undefined", () => ok.exports.run());

      const err = await instantiateFixture(HOST_RESULT, {
        "host:api/fallible": {
          check: () => {
            throw new ComponentException(undefined);
          },
        },
      });
      await t.attempt("throw-componentException", () => err.exports.run());

      // module identity: hand-rolled brand, zero protocol imports on the throwing side.
      const hand = await instantiateFixture(HOST_RESULT, {
        "host:api/fallible": {
          check: () => {
            throw handRolledException(undefined, "hand-rolled err");
          },
        },
      });
      await t.attempt("throw-hand-rolled", () => hand.exports.run());

      // An UNBRANDED throw is a host bug: a trap, not an err value. The
      // message is runtime-AUTHORED (stable project wording) and names the
      // import, so it is recorded.
      const bug = await instantiateFixture(HOST_RESULT, {
        "host:api/fallible": {
          check: () => {
            throw new TypeError("a stray platform error");
          },
        },
      });
      // The trap's brand verdict is the transcript's `tag` — normalize()
      // reads it through the protocol predicate, so the recognition claim is
      // in the golden itself.
      await t.attempt("throw-unbranded", () => bug.exports.run());
    });
  },
});

const payloadReady = await haveFixture(HOST_PAYLOAD);

Deno.test({
  name: "conventions/e: host ComponentException payload lowers into the err case",
  ignore: !payloadReady,
  fn: async () => {
    await transcript("e-host-throw-payload", async (t) => {
      // `try-it: func() -> result<u32, string>`. `run` returns `val` on ok and
      // `1000 + byteLength` on err, so one u32 reports the case AND that the
      // payload survived.
      const ok = await instantiateFixture(HOST_PAYLOAD, {
        "host:api/fallible": { tryIt: () => 12 },
      });
      await t.attempt("ok", () => ok.exports.run());

      const err = await instantiateFixture(HOST_PAYLOAD, {
        "host:api/fallible": {
          tryIt: () => {
            throw new ComponentException("boom");
          },
        },
      });
      await t.attempt("err/canonical", () => err.exports.run());

      // Identical treatment for the hand-rolled brand — the point of module identity.
      const hand = await instantiateFixture(HOST_PAYLOAD, {
        "host:api/fallible": {
          tryIt: () => {
            throw handRolledException("boom", "hand-rolled");
          },
        },
      });
      await t.attempt("err/hand-rolled", () => hand.exports.run());
    });
  },
});

Deno.test({
  name: "conventions/e: predicates recognize a hand-rolled exception, either copy",
  fn: async () => {
    await transcript("e-brand-recognition", async (t) => {
      // No engine involved: the vocabulary claim itself. A hand-rolled brand
      // and the canonical class are the same thing to every predicate, because
      // the brand is a `Symbol.for` registry symbol.
      t.note("canonical", {
        classified: classify(new ComponentException({ kind: "timed-out" })),
      });
      t.note("hand-rolled", {
        classified: classify(handRolledException({ kind: "timed-out" }, "x")),
      });
      t.note("unbranded", { classified: classify(new Error("plain")) });
      // A payloadless err: `payload` is `undefined`, and the property is
      // PRESENT (the empty-side spelling), which normalize() records.
      t.note("payloadless", { value: new ComponentException(undefined) });
    });
  },
});

const passReady = await haveFixture(guest("stream-pass"));

Deno.test({
  name: "conventions/e: a peer TRAP surfaces as PeerTrappedError, not clean EOS",
  ignore: !passReady,
  fn: async () => {
    await transcript("e-peer-trapped", async (t) => {
      const c = await instantiateFixture(guest("stream-pass"), {
        sink: (_d: unknown) => 0n,
      });
      // `open-then-trap(n)`: the guest returns a stream, writes n bytes from a
      // background task, then traps. loud component fault: reads that genuinely COMPLETED keep
      // their result; the fault surfaces on the handle's next operation, and
      // is never presented as a clean end-of-stream.
      const s = await c.exports.openThenTrap(2) as {
        read(n: number): Promise<unknown>;
      };
      t.note("lifted", { classified: classify(s) });
      await t.attempt("read", () => s.read(8));
      // `tag: "peerTrapped"` in the golden IS the predicate verdict, and the
      // walked `cause` chain is realm boundary's requirement that the underlying fault
      // stay reachable.
      await t.attempt("read-after-trap", () => s.read(8));
    });
  },
});
