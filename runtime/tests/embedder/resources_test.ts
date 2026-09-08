// Resources as classes, guest side: the `resources` fixture through the
// conventions facade (contracts/embedder-api.md §"Resources").
//
// What the raw boundary exposes here is bare reps and hand-transcribed
// `[method]counter.increment` keys (see tests/integration/e2e_resources_test.ts,
// the same fixture without this layer): that friction is what this
// test asserts away.

import { assertEq } from "../support/asserts.ts";
import { caught, guest, haveFixture, instantiateFixture } from "./support.ts";
import { InvalidHandleError } from "@polyengine/protocol";
import { ResourceTypeInfo } from "../../src/cabi/types.ts";
import {
  GuestResource,
  makeWrapper,
  takeRep,
  wrapperState,
} from "../../src/embedder/resources.ts";

const ready = await haveFixture(guest("resources"));
const IFACE = "polyengine:resources/counters";

Deno.test("resources: identity and ownership rejection leave a wrapper intact", async () => {
  const rt = new ResourceTypeInfo(null, null);
  const other = new ResourceTypeInfo(null, null);
  const owned = makeWrapper(GuestResource, 7, rt, true);
  for (const own of [false, true]) {
    const e = await caught(() => takeRep(owned, other, own, "resource"));
    assertEq(e instanceof InvalidHandleError, true);
    assertEq(String(e).includes("resource type mismatch"), true);
    assertEq(wrapperState(owned)?.valid, true);
  }
  assertEq(takeRep(owned, rt, true, "own<R>"), 7);
  assertEq(wrapperState(owned)?.valid, false);

  const borrowed = makeWrapper(GuestResource, 7, rt, false);
  const e = await caught(() => takeRep(borrowed, rt, true, "own<R>"));
  assertEq(e instanceof InvalidHandleError, true);
  assertEq(String(e).includes("borrowed"), true);
  assertEq(wrapperState(borrowed)?.valid, true);
  assertEq(takeRep(borrowed, rt, false, "borrow<R>"), 7);
  borrowed.drop();
});

Deno.test({
  name:
    "resources: foreign instantiation owns and borrows are rejected before entry",
  ignore: !ready,
  fn: async () => {
    const a = await counters();
    const b = await counters();
    using x = new a.Counter(11n);
    using y = new b.Counter(22n);
    for (const call of [() => b.bump(x, 1n), () => b.consume(x)]) {
      const e = await caught(call);
      assertEq(e instanceof InvalidHandleError, true);
      assertEq(String(e).includes("resource type mismatch"), true);
      assertEq(await x.get(), 11n, "source wrapper remains live");
      assertEq(await y.get(), 22n, "target guest was not entered");
      assertEq(await a.liveCounters(), 1);
      assertEq(await b.liveCounters(), 1);
    }
  },
});

Deno.test({
  name:
    "resources: own-lowering refuses a live borrowed wrapper before consumption",
  ignore: !ready,
  fn: async () => {
    const c = await counters();
    using owned = new c.Counter(11n);
    const state = wrapperState(owned)!;
    // Same wrapper producer as the incoming-borrow bridge, followed by the
    // production export own-lowering path. Not a guest-to-host borrow fixture.
    using borrowed = makeWrapper(c.Counter, state.rep, state.rt, false);
    const e = await caught(() => c.consume(borrowed));
    assertEq(e instanceof InvalidHandleError, true);
    assertEq(String(e).includes("borrowed"), true);
    assertEq(wrapperState(borrowed)?.valid, true);
    assertEq(await c.bump(borrowed, 1n), 12n, "reborrowing remains legal");
    assertEq(await owned.get(), 12n, "the actual owner was not consumed");
    assertEq(await c.liveCounters(), 1);
  },
});

// deno-lint-ignore no-explicit-any
async function counters(): Promise<any> {
  const inst = await instantiateFixture(guest("resources"));
  return inst.exports[IFACE];
}

Deno.test({
  name:
    "resources: the interface exposes a PascalCase class and camelCase funcs",
  ignore: !ready,
  fn: async () => {
    const c = await counters();
    const names = Object.keys(c).sort();
    assertEq(names.includes("Counter"), true, `got: ${names}`);
    assertEq(names.includes("makeCounter"), true, `got: ${names}`);
    assertEq(names.includes("liveCounters"), true, `got: ${names}`);
    // The mangled leaves are assembled into the class, never left on the
    // interface object.
    assertEq(
      names.some((n) => n.startsWith("[")),
      false,
      `mangled keys must not survive: ${names}`,
    );
    assertEq(typeof c.Counter.prototype.increment, "function");
    assertEq(typeof c.Counter.merge, "function", "statics are static members");
  },
});

Deno.test({
  name: "resources: construct, call methods, drop — dtor observable",
  ignore: !ready,
  fn: async () => {
    const c = await counters();
    assertEq(await c.liveCounters(), 0);

    const a = new c.Counter(5n);
    assertEq(a instanceof c.Counter, true);
    assertEq(await c.liveCounters(), 1);
    assertEq(await a.get(), 5n);
    assertEq(await a.increment(), 6n);
    assertEq(await a.get(), 6n, "the borrow left the handle usable");
    assertEq(await c.liveCounters(), 1);

    a.drop();
    assertEq(await c.liveCounters(), 0, "drop() runs the guest destructor");
    // Dropping twice is a no-op, not a double-dtor.
    a.drop();
    assertEq(await c.liveCounters(), 0);
    assertEq(
      (await caught(() => a.get())) instanceof InvalidHandleError,
      true,
      "a dropped wrapper is loud on further use",
    );
  },
});

Deno.test({
  name: "resources: `using` disposal is observable through live-counters",
  ignore: !ready,
  fn: async () => {
    const c = await counters();
    {
      using x = new c.Counter(1n);
      assertEq(await x.get(), 1n);
      assertEq(await c.liveCounters(), 1);
    }
    assertEq(await c.liveCounters(), 0, "[Symbol.dispose] dropped the handle");
  },
});

Deno.test({
  name: "resources: a static consuming two owns invalidates BOTH wrappers",
  ignore: !ready,
  fn: async () => {
    // `merge: static func(a: counter, b: counter) -> counter` — the contract's
    // "host passes own<R>: wrapper invalidated (transferred)" row, twice, plus
    // the return: a fresh owned instance.
    const c = await counters();
    const a = new c.Counter(3n);
    const b = new c.Counter(4n);
    assertEq(await c.liveCounters(), 2);

    const sum = await c.Counter.merge(a, b);
    assertEq(sum instanceof c.Counter, true, "the result is a class instance");
    assertEq(await sum.get(), 7n);
    // The guest ran both destructors inside `merge`; only `sum` is alive.
    assertEq(await c.liveCounters(), 1);

    for (const [name, w] of [["a", a], ["b", b]] as const) {
      const e = await caught(() => w.get());
      assertEq(
        e instanceof InvalidHandleError,
        true,
        `${name} must be invalidated by the own-transfer, got ${e}`,
      );
      assertEq(String(e).includes("transferred as own"), true, `${e}`);
    }
    sum.drop();
    assertEq(await c.liveCounters(), 0);
  },
});

Deno.test({
  name: "resources: free functions take borrows (still valid) and owns (not)",
  ignore: !ready,
  fn: async () => {
    const c = await counters();
    const a = await c.makeCounter(5n);
    const b = await c.makeCounter(10n);
    assertEq(a instanceof c.Counter, true, "make-counter returns own<counter>");

    // borrow<counter> arguments: the caller's handles survive the call.
    assertEq(await c.sumBoth(a, b), 15n);
    assertEq(await c.bump(a, 2n), 7n);
    assertEq(await c.liveCounters(), 2);

    // `consume: func(c: counter) -> u64` takes ownership.
    assertEq(await c.consume(a), 7n);
    assertEq(await c.liveCounters(), 1);
    assertEq(
      (await caught(() => c.bump(a, 1n))) instanceof InvalidHandleError,
      true,
    );
    assertEq(await c.consume(b), 10n);
    assertEq(await c.liveCounters(), 0);
  },
});

Deno.test({
  name: "resources: a non-handle where a resource is expected is loud",
  ignore: !ready,
  fn: async () => {
    const c = await counters();
    assertEq(
      String(await caught(() => c.consume(42))).includes(
        "expected a resource class instance",
      ),
      true,
    );
    assertEq(
      String(await caught(() => c.consume({}))).includes(
        "not a resource handle",
      ),
      true,
    );
  },
});

Deno.test({
  name: "resources: guest constructors complete synchronously in jspi mode",
  ignore: !ready,
  fn: async () => {
    // jspi mode promising-wraps every lifted entry, so the entry returns a
    // Promise even when the activation never suspends — which a JS class
    // constructor cannot await. Constructor exports carry a plain-entered
    // variant for exactly this (exec/boundary.ts SYNC_ENTRY);
    // this pins `new` working under forced jspi, method calls included
    // (the polymorph-iroh endpoint's `new EndpointOptions(identity)` is the
    // consumer shape that found the gap).
    const inst = await instantiateFixture(guest("resources"), {}, {
      jspi: true,
    });
    const c = inst.exports[IFACE];
    const a = new c.Counter(5n);
    assertEq(a instanceof c.Counter, true);
    assertEq(await a.get(), 5n);
    assertEq(await a.increment(), 6n);
    a.drop();
    assertEq(await c.liveCounters(), 0);
  },
});
