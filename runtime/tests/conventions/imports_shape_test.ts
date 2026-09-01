// ROW (a) — the imports record's SHAPE (contracts/embedder-api.md §"Module
// wiring and instantiation"): one nested record keyed by verbatim interface
// id, world-level bare imports at the top level, leaves under their camelCase
// JS names, resource CLASSES at the resource's position, and mangled member
// leaves (`[method]r.m`, `[static]r.m`, `[constructor]r`) dispatching on that
// class.
//
// The transcript pins BOTH halves and their agreement: what `requiredImports`
// says the component needs, and the record that actually satisfies it. Those
// two drifting apart is the failure this row exists to catch — an embedder
// reads the first and writes the second.

import {
  artifactsOf,
  haveFixture,
  instantiateFixture,
  requiredImports,
  testdata,
} from "./harness.ts";
import { transcript } from "./support.ts";
import { Cell, Gauge, MathProvider } from "./probe.ts";

/** The leaf projection the transcript records: contract fields only. */
// deno-lint-ignore no-explicit-any
function leafRow(l: any): Record<string, unknown> {
  const row: Record<string, unknown> = {
    interfaceId: l.interfaceId,
    path: l.path,
    leaf: l.leaf,
    kind: l.kind,
    jsName: l.jsName,
    memberForm: l.member.form,
  };
  if (l.jsClass !== undefined) row.jsClass = l.jsClass;
  if (l.type) {
    // Param NAMES are docs-only (§"Functions and async": excluded from the
    // world digest) but the ARITY and types are the linkable shape.
    // deno-lint-ignore no-explicit-any
    row.params = l.type.params.map((p: any) => p.type.kind);
    // deno-lint-ignore no-explicit-any
    row.results = l.type.results.map((r: any) => r.kind);
    row.async = l.type.async;
  }
  return row;
}

const importsReady = await haveFixture(testdata("imports"));

Deno.test({
  name: "conventions/a: imports record — bare + interface leaves, camelCase",
  ignore: !importsReady,
  fn: async () => {
    await transcript("a-imports-record-plain", async (t) => {
      const leaves = requiredImports(await artifactsOf(testdata("imports")));
      t.note("requiredImports", { leaves: leaves.map(leafRow) });

      const logged: number[] = [];
      // The canonical form: a world-level bare import at the top level, an
      // interface import keyed by its verbatim WIT id. The interface provider
      // is a CLASS INSTANCE whose `add` reads instance state, so a
      // mis-bound receiver would show up as a wrong answer, not a pass.
      const imports = {
        log: (x: number) => void logged.push(x),
        "host:api/math": new MathProvider(0),
      };
      t.note("record-keys", { keys: Object.keys(imports).sort() });

      const c = await instantiateFixture(testdata("imports"), imports);
      await t.attempt("call/run", () => c.exports.run(2, 40));
      t.note("bare-import-received", { logged });
      await t.attempt("call/greetLen", () => c.exports.greetLen());
    });
  },
});

Deno.test({
  name: "conventions/a: suspending mark — an interface member's receiver is its provider",
  ignore: !importsReady,
  fn: async () => {
    await transcript("a-interface-receiver", async (t) => {
      // Same component, a provider carrying instance state. A world-level bare
      // import has no containing object and is called unbound; an interface
      // member is invoked with the provider as receiver.
      const c = await instantiateFixture(testdata("imports"), {
        log: () => {},
        "host:api/math": new MathProvider(100),
      });
      // 2 + 40 + bias(100)
      await t.attempt("call/run", () => c.exports.run(2, 40));
    });
  },
});

const resReady = await haveFixture(testdata("imported-resource"));

Deno.test({
  name: "conventions/a: imports record — a resource CLASS at the type's slot",
  ignore: !resReady,
  fn: async () => {
    await transcript("a-imports-record-resource", async (t) => {
      const leaves = requiredImports(
        await artifactsOf(testdata("imported-resource")),
      );
      t.note("requiredImports", { leaves: leaves.map(leafRow) });

      Cell.reset();
      const c = await instantiateFixture(testdata("imported-resource"), {
        "host:api/res": {
          // The resource CLASS sits at the resource's position — no rep
          // token, no side table (§"Resources").
          R: Cell,
          make: (v: number) => new Cell(v),
          value: (r: Cell) => r.v,
        },
      });
      await t.attempt("call/roundtrip", () => c.exports.roundtrip(7));
      t.note("host-observed", { made: Cell.made, disposed: Cell.disposed });
    });
  },
});

const gaugeReady = await haveFixture(
  "runtime/tests/embedder/suspending-method.wasm",
);

Deno.test({
  name: "conventions/a: imports record — mangled member leaves, one class",
  ignore: !gaugeReady,
  fn: async () => {
    await transcript("a-imports-record-members", async (t) => {
      const leaves = requiredImports(
        await artifactsOf("runtime/tests/embedder/suspending-method.wasm"),
      );
      // `[constructor]gauge`, `[method]gauge.read`, `[static]gauge.calibrate`
      // all carry `jsClass: "Gauge"` and dispatch on the ONE class entry.
      t.note("requiredImports", { leaves: leaves.map(leafRow) });

      Gauge.reset();
      const c = await instantiateFixture(
        "runtime/tests/embedder/suspending-method.wasm",
        { "host:api/dev": { Gauge } },
      );
      await t.attempt("call/probe", () => c.exports.probe(41));
      await t.attempt("call/calib", () => c.exports.calib());
      t.note("host-observed", {
        calibrations: Gauge.calibrations,
        disposed: Gauge.disposed,
      });
    });
  },
});
