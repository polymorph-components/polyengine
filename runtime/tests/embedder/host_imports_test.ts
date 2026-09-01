// Host-implemented resources and host imports through the conventions facade
// (contracts/embedder-api.md §"Resources" — the right-hand column of the 2x4
// ownership table — and §"Module wiring and instantiation").
//
// Fixtures: `crates/translator-shim/testdata/{imports,imported-resource}.wasm`.
// The same fixtures at the raw boundary are in
// tests/integration/e2e_imports_test.ts, where `own`/`borrow` are bare reps and
// the host has to keep its own identity table — the friction this layer deletes.

import { assertEq } from "../support/asserts.ts";
import { caught, haveFixture, instantiateFixture, testdata } from "./support.ts";
import { ComponentException, Trap } from "@polyengine/protocol";
import { INTERNAL_HOST_REGISTRIES } from "../../src/embedder/instantiate.ts";

const ready = await haveFixture(testdata("imports"));

Deno.test({
  name: "imports: world-level bare import + interface leaves are camelCase",
  ignore: !ready,
  fn: async () => {
    const logged: number[] = [];
    const c = await instantiateFixture(testdata("imports"), {
      // A world-level (bare) import sits at the record's top level.
      log: (x: number) => void logged.push(x),
      // An interface import is keyed by its verbatim WIT id.
      "host:api/math": {
        add: (a: number, b: number) => a + b,
        greet: (who: string) => `hello ${who}`,
      },
    });
    assertEq(await c.exports.run(2, 40), 42);
    assertEq(logged, [42]);
    assertEq(await c.exports.greetLen(), "hello ab".length);
  },
});

Deno.test({
  name: "imports: requiredImports enumerates the linkable leaves with types",
  ignore: !ready,
  fn: async () => {
    const { requiredImports } = await import("../../src/embedder/mod.ts");
    const { artifactsOf } = await import("./support.ts");
    const leaves = requiredImports(await artifactsOf(testdata("imports")));
    assertEq(leaves.length, 3);
    assertEq(leaves[0].interfaceId, "log");
    assertEq(leaves[0].path, []);
    assertEq(leaves[0].kind, "func");
    assertEq(leaves[0].jsName, "log");
    assertEq(leaves[0].member.form, "plain");
    assertEq(leaves[1].interfaceId, "host:api/math");
    assertEq(leaves[1].leaf, "add");
    assertEq(leaves[1].jsName, "add");
    assertEq(leaves[1].type?.params.map((p) => p.type.kind), ["u32", "u32"]);
    assertEq(leaves[1].type?.results.map((r) => r.kind), ["u32"]);
    assertEq(leaves[1].type?.async, false);
    assertEq(leaves[2].leaf, "greet");
  },
});

Deno.test({
  name: "imports: a missing leaf is reported at instantiate, naming the path",
  ignore: !ready,
  fn: async () => {
    const e = await caught(() =>
      instantiateFixture(testdata("imports"), {
        log: () => {},
        "host:api/math": { add: (a: number) => a }, // `greet` missing
      })
    );
    assertEq(String(e).includes("host:api/math/greet"), true, `${e}`);
  },
});

// ---------------------------------------------------------------------------
// Host-implemented resources
// ---------------------------------------------------------------------------

const resReady = await haveFixture(testdata("imported-resource"));

class Cell {
  static disposed: number[] = [];
  constructor(readonly v: number) {}
  [Symbol.dispose]() {
    Cell.disposed.push(this.v);
  }
}

Deno.test({
  name: "host resources: own out, borrow in, dtor on the guest's drop",
  ignore: !resReady,
  fn: async () => {
    Cell.disposed = [];
    const made: Cell[] = [];
    const seen: Cell[] = [];
    const c = await instantiateFixture(testdata("imported-resource"), {
      "host:api/res": {
        // The resource CLASS sits at the resource's position — no
        // `hostResourceType` token, no rep bookkeeping.
        R: Cell,
        make: (v: number) => {
          const cell = new Cell(v);
          made.push(cell);
          return cell; // host passes own<R>: the runtime registers it
        },
        value: (r: Cell) => {
          seen.push(r); // host receives borrow<R>: its own instance back
          return r.v;
        },
      },
    });

    // `roundtrip` does make -> value(borrow) -> drop, all inside one call.
    assertEq(await c.exports.roundtrip(7), 7);
    assertEq(made.length, 1);
    assertEq(
      seen[0] === made[0],
      true,
      "a borrow arrives as the host's OWN instance, by identity",
    );
    assertEq(
      Cell.disposed,
      [7],
      "the guest dropping its last own handle runs [Symbol.dispose]",
    );

    // A handle the guest keeps is not disposed until it says so.
    const handle = await c.exports.makeAndKeep(11);
    assertEq(Cell.disposed, [7], "still held by the guest");
    await c.exports.dropHandle(handle);
    assertEq(Cell.disposed, [7, 11]);
  },
});

Deno.test({
  name: "host resources: the class must actually be provided",
  ignore: !resReady,
  fn: async () => {
    const e = await caught(() =>
      instantiateFixture(testdata("imported-resource"), {
        "host:api/res": { make: () => ({}), value: () => 1 },
      })
    );
    assertEq(String(e).includes("resource type 'R'"), true, `${e}`);
  },
});

// ---------------------------------------------------------------------------
// The error model at the host-import boundary
// ---------------------------------------------------------------------------

const errReady = await haveFixture("runtime/tests/embedder/host-result.wasm");

/** `check: func() -> result` imported; `run: func() -> u32` returns the disc. */
async function hostResult(check: () => void) {
  return await instantiateFixture("runtime/tests/embedder/host-result.wasm", {
    "host:api/fallible": { check },
  });
}

Deno.test({
  name: "error model: a host import returning normally is the ok side",
  ignore: !errReady,
  fn: async () => {
    const c = await hostResult(() => {});
    assertEq(await c.exports.run(), 0, "0 == the guest observed ok");
  },
});

Deno.test({
  name: "error model: throw new ComponentException(payload) is the err side",
  ignore: !errReady,
  fn: async () => {
    // The branded throw — and the ONLY thing that crosses as an err value.
    const c = await hostResult(() => {
      throw new ComponentException(undefined);
    });
    assertEq(await c.exports.run(), 1, "1 == the guest observed err");
  },
});

Deno.test({
  name: "error model: an unbranded throw becomes a trap naming the import",
  ignore: !errReady,
  fn: async () => {
    // The inversion of jco's convention: a stray platform error is a HOST BUG,
    // never a guest-visible err. This is what makes the consumers' defensive
    // `platformCall`-style wrappers unnecessary by construction.
    const c = await hostResult(() => {
      throw new TypeError("cannot read properties of undefined");
    });
    const e = await caught(() => c.exports.run());
    assertEq(e instanceof Trap, true, `expected a Trap, got ${e}`);
    assertEq(
      String(e).includes("host:api/fallible/check"),
      true,
      `the trap must name the import leaf: ${e}`,
    );
    assertEq(String(e).includes("TypeError"), true, `${e}`);
    assertEq(String(e).includes("ComponentException"), true, "…and say how to signal err");
  },
});

Deno.test({
  name: "error model: a Trap thrown by the host passes through unchanged",
  ignore: !errReady,
  fn: async () => {
    const c = await hostResult(() => {
      throw new Trap("host said stop");
    });
    const e = await caught(() => c.exports.run());
    assertEq(e instanceof Trap, true, `${e}`);
    assertEq(String(e).includes("host said stop"), true, `${e}`);
    assertEq(
      String(e).includes("unbranded"),
      false,
      "a Trap must not be re-wrapped as a host bug",
    );
  },
});

Deno.test({
  name: "error model: a Promise from a SYNC-typed import is a JSPI requirement",
  ignore: !errReady,
  fn: async () => {
    // `check` is a sync WIT func, so returning a Promise means the guest frame
    // must park — the engine-floor caveat the contract makes visible in types
    // (§"Functions and async"). What matters for the error model is what this
    // is NOT: it must not resolve as `ok`, and it must not be mis-branded as
    // an unbranded-throw host bug, because the host did neither.
    const c = await hostResult(() =>
      Promise.reject(new ComponentException(undefined)) as unknown as void
    );
    const e = await caught(() => c.exports.run());
    assertEq(e !== undefined, true, "it must not resolve as ok");
    assertEq(
      String(e).includes("JSPI"),
      true,
      `expected the JSPI requirement, got: ${e}`,
    );
    assertEq(
      String(e).includes("host:api/fallible/check"),
      true,
      `it must still name the import: ${e}`,
    );
    assertEq(
      String(e).includes("unbranded"),
      false,
      "a parked import is not a host bug and must not be branded as one",
    );
  },
});

// ---------------------------------------------------------------------------
// The err PAYLOAD round trip (fixture: host-result-payload.wasm)
// ---------------------------------------------------------------------------

const payloadReady = await haveFixture(
  "runtime/tests/embedder/host-result-payload.wasm",
);

/**
 * `try-it: func() -> result<u32, string>` imported; `run: func() -> u32`
 * returns the ok value, or `1000 + errByteLength` for the err case.
 */
async function payloadFixture(tryIt: () => number) {
  return await instantiateFixture(
    "runtime/tests/embedder/host-result-payload.wasm",
    { "host:api/fallible": { tryIt } },
  );
}

Deno.test({
  name: "error model: a fallible import's ok value reaches the guest",
  ignore: !payloadReady,
  fn: async () => {
    const c = await payloadFixture(() => 7);
    assertEq(await c.exports.run(), 7);
  },
});

Deno.test({
  name: "error model: ComponentException's PAYLOAD reaches the guest's err case",
  ignore: !payloadReady,
  fn: async () => {
    // The whole branded-throw path end to end: `throw new ComponentException("boom")`
    // -> `{error: "boom"}` -> the err side of `result<u32, string>` ->
    // the string lowered into the guest through ITS realloc. `1004` is
    // `1000 + "boom".length`, so it pins the case AND the payload.
    const c = await payloadFixture(() => {
      throw new ComponentException("boom");
    });
    assertEq(await c.exports.run(), 1004, "err case + 4-byte payload");
  },
});

Deno.test({
  name: "error model: a longer err payload rides realloc unchanged",
  ignore: !payloadReady,
  fn: async () => {
    const msg = "connection refused by the host";
    const c = await payloadFixture(() => {
      throw new ComponentException(msg);
    });
    assertEq(await c.exports.run(), 1000 + msg.length);
  },
});

Deno.test({
  name: "error model: an unbranded throw from a FALLIBLE import is still a trap",
  ignore: !payloadReady,
  fn: async () => {
    // Having an err side does not make a stray platform error into one.
    const c = await payloadFixture(() => {
      throw new RangeError("nope");
    });
    const e = await caught(() => c.exports.run());
    assertEq(e instanceof Trap, true, `expected a Trap, got ${e}`);
    assertEq(String(e).includes("host:api/fallible/try-it"), true, `${e}`);
  },
});

// ---------------------------------------------------------------------------
// B2: a borrow of a never-registered host instance is CALL-SCOPED
// ---------------------------------------------------------------------------

const borrowReady = await haveFixture("runtime/tests/embedder/host-borrow.wasm");

Deno.test({
  name: "host resources: a borrow-allocated rep is released when the call returns",
  ignore: !borrowReady,
  fn: async () => {
    // contracts/embedder-api.md 2x4 table, bottom-right: "a
    // never-registered instance gets a rep allocated **for the call's
    // duration**". The rep->instance map is STRONG and a guest dropping a
    // borrow handle runs no destructor, so without a call-scoped release this
    // leaks both the rep and a permanent reference to the host object.
    const c = await instantiateFixture(
      "runtime/tests/embedder/host-borrow.wasm",
      { "host:api/res": { R: Cell, value: (r: Cell) => r.v } },
    );
    const registries = (c as unknown as Record<symbol, Map<number, {
      liveCount: number;
    }>>)[INTERNAL_HOST_REGISTRIES];
    const registry = registries.get(0)!;

    assertEq(registry.liveCount, 0, "nothing registered yet");
    const cell = new Cell(99);
    assertEq(await c.exports.peek(cell), 99, "the guest saw the host instance");
    assertEq(
      registry.liveCount,
      0,
      "the call-scoped rep must be gone once the call returned",
    );

    // Still usable afterwards: a fresh rep is minted per call, and nothing
    // accumulates across calls.
    for (let i = 0; i < 5; i++) assertEq(await c.exports.peek(cell), 99);
    assertEq(registry.liveCount, 0, "no accumulation across calls");
  },
});

Deno.test({
  name: "host resources: an own-registered instance survives the call, as owned",
  ignore: !borrowReady,
  fn: async () => {
    // The other half of the rule: only a rep minted *for* the borrow is
    // call-scoped. An instance the guest already owns keeps its rep.
    const c = await instantiateFixture(
      "runtime/tests/embedder/host-borrow.wasm",
      { "host:api/res": { R: Cell, value: (r: Cell) => r.v } },
    );
    const registries = (c as unknown as Record<symbol, Map<number, {
      liveCount: number;
      repFor(i: unknown): number;
      hasRep(r: number): boolean;
    }>>)[INTERNAL_HOST_REGISTRIES];
    const registry = registries.get(0)!;
    const cell = new Cell(5);
    const rep = registry.repFor(cell); // as if the guest had been given an own
    assertEq(registry.liveCount, 1);
    assertEq(await c.exports.peek(cell), 5);
    assertEq(
      registry.hasRep(rep),
      true,
      "a pre-existing registration is NOT released by a borrow",
    );
    assertEq(registry.liveCount, 1);
  },
});

Deno.test({
  name: "host resources: a resource import with no importedResources table is loud",
  ignore: !borrowReady,
  fn: async () => {
    const { artifactsOf } = await import("./support.ts");
    const a = await artifactsOf("runtime/tests/embedder/host-borrow.wasm");
    // Simulate a v0.1 shim that never emitted the table (plan-format.md v0.2).
    const stripped = {
      ...a,
      plan: { ...a.plan, importedResources: [] },
    };
    const { instantiate } = await import("../../src/embedder/mod.ts");
    const e = await caught(() =>
      instantiate(stripped, {
        "host:api/res": { R: Cell, value: (r: Cell) => r.v },
      })
    );
    assertEq(
      String(e).includes("importedResources"),
      true,
      `expected a build-time diagnostic, got: ${e}`,
    );
    assertEq(String(e).includes("'R'"), true, `it must name the type: ${e}`);
  },
});
