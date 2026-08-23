// ROW (f) — `suspending()` (contracts/embedder-api.md §"Functions and async",
// amendments A1/A2).
//
// A sync-typed WIT import is typed to return `T` synchronously. Returning a
// Promise from one parks the calling WASM FRAME, and that is a DECLARED
// capability: the function must be marked, per declaration. The marker is a
// brand (`polyengine.suspending/1`), so a hand-rolled mark with zero protocol
// imports is the same thing to the engine — and for instance methods the CLASS
// PROTOTYPE is the brand authority, read at wrap time, so one mark relays to
// every instance.
//
// The negative arm matters as much: an UNMARKED sync import that returns a
// Promise is refused, naming `suspending()`. Silent degradation is what the
// declaration exists to prevent.

import { haveFixture, instantiateFixture, jspiSupported, testdata } from "./harness.ts";
import { transcript } from "./support.ts";
import { Gauge, SuspendingGauge, suspending } from "./probe.ts";
import { handRolledSuspending } from "./probe_zero_import.ts";

/**
 * A Promise that settles only after a real macrotask hop, so a park is a
 * genuine suspension across the event loop rather than a microtask formality.
 * The transcript records no timing — only that the value came back.
 */
function later<T>(value: T): Promise<T> {
  return new Promise((r) => setTimeout(() => r(value), 0));
}

const importsReady = (await haveFixture(testdata("imports"))) && jspiSupported();

Deno.test({
  name: "conventions/f: a MARKED sync-typed import parks and resumes with the value",
  ignore: !importsReady,
  fn: async () => {
    await transcript("f-suspending-plain-import", async (t) => {
      const c = await instantiateFixture(testdata("imports"), {
        log: () => {},
        "host:api/math": {
          // The canonical spelling: the direct call, the only form available
          // in a record literal.
          add: suspending((a: number, b: number) => later(a + b)),
          greet: (who: string) => `hello ${who}`,
        },
      });
      await t.attempt("run", () => c.exports.run(2, 40));

      // A marked import that returns SYNCHRONOUSLY stays on the value path —
      // it pays the continuation hop, but the result is not a Promise.
      const sync = await instantiateFixture(testdata("imports"), {
        log: () => {},
        "host:api/math": {
          add: suspending((a: number, b: number) => a + b),
          greet: (who: string) => `hello ${who}`,
        },
      });
      await t.attempt("run/marked-but-sync", () => sync.exports.run(2, 40));

      // A9: the mark is a brand, so a hand-rolled one (zero protocol imports)
      // is the same declaration.
      const hand = await instantiateFixture(testdata("imports"), {
        log: () => {},
        "host:api/math": {
          add: handRolledSuspending((a: number, b: number) => later(a + b)),
          greet: (who: string) => `hello ${who}`,
        },
      });
      await t.attempt("run/hand-rolled-mark", () => hand.exports.run(2, 40));
    });
  },
});

Deno.test({
  name: "conventions/f: an UNMARKED sync import returning a Promise is refused",
  ignore: !importsReady,
  fn: async () => {
    await transcript("f-suspending-unmarked-refusal", async (t) => {
      const c = await instantiateFixture(testdata("imports"), {
        log: () => {},
        "host:api/math": {
          // No mark. Parking here would be an undeclared capability.
          add: (a: number, b: number) => later(a + b),
          greet: (who: string) => `hello ${who}`,
        },
      });
      await t.attempt("run", () => c.exports.run(2, 40));
    });
  },
});

Deno.test({
  name: "conventions/f: an explicit jspi:false refuses a MARKED import's Promise",
  ignore: !importsReady,
  fn: async () => {
    await transcript("f-suspending-jspi-false", async (t) => {
      // "rides the engine floor: on a non-JSPI engine a marked import that
      // returns a Promise is refused at the call site (NeedsJspi), never
      // silently degraded." `jspi: false` is the same floor, forced.
      const c = await instantiateFixture(testdata("imports"), {
        log: () => {},
        "host:api/math": {
          add: suspending((a: number, b: number) => later(a + b)),
          greet: (who: string) => `hello ${who}`,
        },
      }, { jspi: false });
      await t.attempt("run", () => c.exports.run(2, 40));
    });
  },
});

const GAUGE = "runtime/tests/embedder/suspending-method.wasm";
const gaugeReady = (await haveFixture(GAUGE)) && jspiSupported();

Deno.test({
  name: "conventions/f: A2 — a mark on the class PROTOTYPE relays to instances",
  ignore: !gaugeReady,
  fn: async () => {
    await transcript("f-suspending-prototype-relay", async (t) => {
      SuspendingGauge.reset();
      // The prototype is the per-declaration brand authority, read at wrap
      // time. The guest-driven CONSTRUCTOR stays synchronous (C2) while the
      // METHOD parks — the `[method]pollable.block` shape.
      const c = await instantiateFixture(GAUGE, {
        "host:api/dev": { Gauge: SuspendingGauge },
      });
      await t.attempt("probe", () => c.exports.probe(41));
      t.note("dtor", { disposed: SuspendingGauge.disposed });

      // The unmarked sibling class, for contrast: a synchronous method on a
      // stateful provider needs no mark at all.
      Gauge.reset();
      const plain = await instantiateFixture(GAUGE, {
        "host:api/dev": { Gauge },
      });
      await t.attempt("probe/unmarked-sync", () => plain.exports.probe(5));
    });
  },
});
