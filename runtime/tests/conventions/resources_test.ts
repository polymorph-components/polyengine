// ROW (d) — HOST-IMPLEMENTED RESOURCES (contracts/embedder-api.md
// §"Resources"): "a resource is a class instance on both sides of the
// boundary". The host provides a PLAIN CLASS — the WIT constructor is the JS
// constructor, methods are camelCase members, statics are static members — and
// the runtime owns the instance↔rep mapping. Method `self` IS the instance: no
// reps, no side tables. When the guest drops its
// last own handle the runtime calls `instance[Symbol.dispose]?.()`.
//
// The transcript's load-bearing content is the ORDER of host-observable
// effects: construct, method, static, dispose — and that dispose lands on the
// guest's drop, not at some later collection.

import { haveFixture, instantiateFixture, testdata } from "./harness.ts";
import { transcript } from "./support.ts";
import { Cell, Gauge, MathProvider } from "./probe.ts";

const resReady = await haveFixture(testdata("imported-resource"));

Deno.test({
  name: "conventions/d: a plain class IS the resource; own out, borrow in, dtor on drop",
  ignore: !resReady,
  fn: async () => {
    await transcript("d-host-resource-plain-class", async (t) => {
      Cell.reset();
      const events: string[] = [];
      const c = await instantiateFixture(testdata("imported-resource"), {
        "host:api/res": {
          R: Cell,
          // The host passes `own<R>`: the runtime registers the instance and
          // the guest owns its handle.
          make: (v: number) => {
            events.push(`make(${v})`);
            return new Cell(v);
          },
          // The host receives `borrow<R>`: its OWN instance back — identity,
          // not a rebuilt wrapper. `sameInstance` is the whole claim.
          value: (r: Cell) => {
            events.push(`value(self.v=${r.v}, isCell=${r instanceof Cell})`);
            return r.v;
          },
        },
      });

      // `roundtrip` does make -> value(borrow) -> drop inside one guest task.
      await t.attempt("roundtrip", () => c.exports.roundtrip(7));
      t.note("effects", { events, disposed: Cell.disposed });

      // `make-and-keep` leaves the handle ALIVE in the guest: no dispose yet.
      const h = await t.attempt("make-and-keep", () =>
        c.exports.makeAndKeep(9)) as number;
      t.note("before-guest-drop", { disposed: Cell.disposed });
      // …and `drop-handle` runs the destructor, right there.
      await t.attempt("drop-handle", () => c.exports.dropHandle(h));
      t.note("after-guest-drop", { disposed: Cell.disposed });
    });
  },
});

const gaugeReady = await haveFixture(
  "runtime/tests/embedder/suspending-method.wasm",
);
const GAUGE = "runtime/tests/embedder/suspending-method.wasm";

Deno.test({
  name: "conventions/d: constructor + method + static on one host class",
  ignore: !gaugeReady,
  fn: async () => {
    await transcript("d-host-resource-members", async (t) => {
      Gauge.reset();
      // ONE entry — the class — serves `[constructor]gauge`,
      // `[method]gauge.read` and `[static]gauge.calibrate`. The mangled-name
      // assembly is the runtime's obligation, never the embedder's.
      const c = await instantiateFixture(GAUGE, {
        "host:api/dev": { Gauge },
      });
      // `probe` constructs, reads through the method, then drops.
      await t.attempt("probe", () => c.exports.probe(41));
      t.note("after-probe", { disposed: Gauge.disposed });
      // `calib` calls the STATIC — no instance involved.
      await t.attempt("calib", () => c.exports.calib());
      await t.attempt("calib-again", () => c.exports.calib());
      t.note("statics", { calibrations: Gauge.calibrations });
    });
  },
});

const importsReady = await haveFixture(testdata("imports"));

Deno.test({
  name: "conventions/d: suspending mark — a class instance is a legal interface provider",
  ignore: !importsReady,
  fn: async () => {
    await transcript("d-interface-provider-class", async (t) => {
      // suspending mark: "interface members are invoked with their containing object as
      // receiver", matching the resource static arm. A provider whose methods
      // read `this` is therefore a fully supported spelling — the failure mode
      // this pins is a silent unbound call, which reads as a wrong answer.
      const c = await instantiateFixture(testdata("imports"), {
        log: () => {},
        "host:api/math": new MathProvider(5),
      });
      await t.attempt("run", () => c.exports.run(1, 1));

      // …and a plain object literal is the other spelling, unchanged.
      const c2 = await instantiateFixture(testdata("imports"), {
        log: () => {},
        "host:api/math": {
          add: (a: number, b: number) => a + b,
          greet: (who: string) => `hi ${who}`,
        },
      });
      await t.attempt("run/object-literal", () => c2.exports.run(1, 1));
      await t.attempt("greetLen/object-literal", () => c2.exports.greetLen());
    });
  },
});
