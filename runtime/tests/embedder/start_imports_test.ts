// Host imports that fire DURING instantiation.
//
// A core module's `start` function runs inside `runInitializers`, i.e. before
// `instantiateComponent`'s promise resolves — and real guests call imports from
// there: componentize-go's output calls `wasi:clocks/monotonic-clock.now()`
// from the Go runtime's `schedinit`. The conventions layer therefore has to be
// fully functional from the moment instantiation begins; it cannot wait to
// learn its own function types from the returned handle.
//
// Pre-fix, both tests below failed with
//   PlanError: import 'host:api/boot/tick': the facade is not bound to an
//   instance yet
// because `Facade#funcType` gated on `bind()`, which runs after instantiation.

import { assertEq } from "../support/asserts.ts";
import { caught, haveFixture, instantiateFixture } from "./support.ts";

const FIXTURE = "runtime/tests/embedder/start-imports.wasm";
const ready = await haveFixture(FIXTURE);

Deno.test({
  name: "start imports: the facade serves imports called during instantiation",
  ignore: !ready,
  fn: async () => {
    const order: string[] = [];
    const pending = instantiateFixture(FIXTURE, {
      "host:api/boot": {
        tick: () => {
          order.push("tick");
          return 4242n;
        },
        // A string parameter: value adaptation on the start path, lowered
        // through the guest's own realloc.
        note: (msg: string) => {
          order.push(`note:${msg}`);
        },
      },
    });
    // Recorded through the SAME promise the caller awaits, so the ordering
    // assertion is about the instantiate promise itself, not about timers.
    pending.then(() => order.push("instantiate-resolved"));
    const c = await pending;

    assertEq(
      order,
      ["tick", "note:booted", "instantiate-resolved"],
      "both imports must be observed BEFORE the instantiate promise resolves",
    );
    // …and the values crossed correctly in both directions: the guest stored
    // what `tick` returned, and `note` received the guest's string.
    assertEq(await c.exports.report(), 4242n);
  },
});

Deno.test({
  name: "start imports: u64 range checking still applies on the start path",
  ignore: !ready,
  fn: async () => {
    // The wrappers are not a degraded pre-instantiation mode: the full value
    // adapter is in play, so a host bug during `start` is reported the same
    // way it would be during a normal call.
    const e = await caught(() =>
      instantiateFixture(FIXTURE, {
        "host:api/boot": {
          tick: () => 5 as unknown as bigint, // u64 wants a bigint
          note: () => {},
        },
      })
    );
    assertEq(e !== undefined, true, "a bad return must not be swallowed");
    assertEq(String(e).includes("u64 expects a bigint"), true, `${e}`);
    assertEq(
      String(e).includes("host:api/boot/tick"),
      true,
      `the site name must survive the start path: ${e}`,
    );
  },
});

Deno.test({
  name: "start imports: an unbranded throw during start is still a trap",
  ignore: !ready,
  fn: async () => {
    const e = await caught(() =>
      instantiateFixture(FIXTURE, {
        "host:api/boot": {
          tick: () => {
            throw new TypeError("host bug at boot");
          },
          note: () => {},
        },
      })
    );
    assertEq(String(e).includes("host bug at boot"), true, `${e}`);
    assertEq(String(e).includes("host:api/boot/tick"), true, `${e}`);
  },
});

Deno.test({
  name: "start imports: requiredImports works before instantiation, as always",
  ignore: !ready,
  fn: async () => {
    const { artifactsOf } = await import("./support.ts");
    const { requiredImports } = await import("../../src/embedder/mod.ts");
    const leaves = requiredImports(await artifactsOf(FIXTURE));
    assertEq(leaves.map((l) => l.jsName).sort(), ["note", "tick"]);
    assertEq(leaves.find((l) => l.jsName === "tick")?.type?.results[0].kind, "u64");
  },
});
