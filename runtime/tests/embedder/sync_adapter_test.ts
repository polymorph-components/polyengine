// `sync()` — the sync() synchronous adapter for WIT-sync exports (contracts/
// embedder-api.md §"Functions and async", §"Functions and async").
//
// Fixtures: `examples/guests/build/values.component.wasm` (plain sync/
// fallible exports), `examples/guests/build/resources.component.wasm`
// (guest-implemented resource — constructor/method/static), and
// `crates/translator-shim/testdata/async-lift.wasm` (a single async-typed
// export, callback ABI, eager `task.return` — exercises the "async has no
// synchronous form" refusal without needing a genuine suspension).

import { assertEq } from "../support/asserts.ts";
import {
  caught,
  guest,
  haveFixture,
  instantiateFixture,
  testdata,
} from "./support.ts";
import { ComponentException } from "@polyengine/protocol";
import { sync } from "../../src/embedder/mod.ts";

const readyValues = await haveFixture(guest("values"));
const readyResources = await haveFixture(guest("resources"));
const readyAsync = await haveFixture(testdata("async-lift"));

const IFACE = "polyengine:resources/counters";

Deno.test({
  name: "sync(): a plain sync export returns its value synchronously, " +
    "matching the Promise surface",
  ignore: !readyValues,
  fn: async () => {
    const { exports } = await instantiateFixture(guest("values"));
    const syncEcho = sync(exports.echoU64);
    const result = syncEcho(7n);
    assertEq(
      result instanceof Promise,
      false,
      "the sync form must not return a thenable",
    );
    assertEq(result, 7n);
    assertEq(await exports.echoU64(7n), 7n, "matches the Promise surface");
  },
});

Deno.test({
  name: "sync(): a fallible export throws ComponentException synchronously",
  ignore: !readyValues,
  fn: async () => {
    const { exports } = await instantiateFixture(guest("values"));
    const syncEcho = sync(exports.echoResult);
    let caughtErr: unknown;
    let hopped = false;
    Promise.resolve().then(() => {
      hopped = true;
    });
    try {
      syncEcho({ kind: "err", value: "boom" });
    } catch (e) {
      caughtErr = e;
    }
    assertEq(
      hopped,
      false,
      "no microtask elapsed between the call and the throw",
    );
    assertEq(caughtErr instanceof ComponentException, true, `got: ${caughtErr}`);
    assertEq((caughtErr as ComponentException).payload, "boom");
    // Drain the queued microtask so it doesn't leak into a later test.
    await new Promise((r) => queueMicrotask(() => r(undefined)));
  },
});

Deno.test({
  name: "sync(): an async-typed export throws TypeError naming async",
  ignore: !readyAsync,
  fn: async () => {
    const { exports } = await instantiateFixture(testdata("async-lift"));
    assertEq(typeof exports.f, "function");
    // The default surface stays Promise-shaped for the async export too.
    assertEq(await exports.f(41), 42);
    const err = await caught(() => sync(exports.f));
    assertEq(err instanceof TypeError, true, `got: ${err}`);
    assertEq(
      String(err).includes("async"),
      true,
      `expected the async-export reason: ${err}`,
    );
  },
});

Deno.test({
  name: "sync(): an unbranded function or a primitive throws TypeError",
  ignore: !readyValues,
  fn: async () => {
    await instantiateFixture(guest("values")); // establishes fixture readiness
    assertEq(
      (await caught(() => sync(function plain() {}))) instanceof TypeError,
      true,
    );
    assertEq((await caught(() => sync(42))) instanceof TypeError, true);
    assertEq((await caught(() => sync(null))) instanceof TypeError, true);
    assertEq((await caught(() => sync("x"))) instanceof TypeError, true);
  },
});

Deno.test({
  name: "sync(): resource instance/class views (plain mode)",
  ignore: !readyResources,
  fn: async () => {
    const { exports } = await instantiateFixture(guest("resources"));
    const c = exports[IFACE];
    const a = new c.Counter(5n); // constructors are unaffected by sync()
    assertEq(a instanceof c.Counter, true);

    const view = sync(a);
    assertEq(sync(a) === view, true, "sync(instance) is memoized");
    assertEq(view.get(), 5n);
    assertEq(view.increment(), 6n);
    assertEq(await a.get(), 6n, "matches the Promise surface's own view");

    // A bare prototype method function cannot supply a receiver.
    const bareMethod = c.Counter.prototype.increment;
    const err = await caught(() => sync(bareMethod));
    assertEq(err instanceof TypeError, true, `got: ${err}`);
    assertEq(
      String(err).includes("sync(instance)"),
      true,
      `expected the sync(instance) hint: ${err}`,
    );

    // Statics view.
    const b = new c.Counter(10n);
    const staticsView = sync(c.Counter);
    assertEq(sync(c.Counter) === staticsView, true, "sync(cls) is memoized");
    const merged = staticsView.merge(a, b);
    assertEq(merged instanceof c.Counter, true);
    assertEq(await merged.get(), 16n);

    merged.drop();
  },
});

Deno.test({
  name: "sync(): resource instance/class views (jspi mode — SYNC_ENTRY path)",
  ignore: !readyResources,
  fn: async () => {
    // jspi mode promising-wraps every lifted entry, so the default Promise
    // surface is unavoidably async even for a completing-synchronously
    // activation; `sync()` routes through the plain-entered `SYNC_ENTRY`
    // variant instead (exec/boundary.ts) and must behave identically.
    const { exports } = await instantiateFixture(guest("resources"), {}, {
      jspi: true,
    });
    const c = exports[IFACE];
    const a = new c.Counter(2n);
    const view = sync(a);
    assertEq(view.increment(), 3n);
    assertEq(view.get(), 3n);
    assertEq(await a.get(), 3n);
    a.drop();
  },
});

Deno.test({
  name: "sync(): record view recurses, passes through non-branded members, " +
    "is memoized",
  ignore: !readyValues || !readyResources,
  fn: async () => {
    const { exports } = await instantiateFixture(guest("values"));
    const view = sync(exports);
    assertEq(sync(exports) === view, true, "sync(record) is memoized");
    assertEq(view.echoU64(1n), 1n, "a branded member maps to its sync form");

    const resInst = await instantiateFixture(guest("resources"));
    const resView = sync(resInst.exports);
    const iface = resView[IFACE];
    assertEq(typeof iface.makeCounter, "function", "recurses into interfaces");
    const counter = iface.makeCounter(3n);
    assertEq(counter instanceof resInst.exports[IFACE].Counter, true);
    counter.drop();
  },
});

Deno.test({
  name: "sync(): the default export surface stays Promise-shaped",
  ignore: !readyValues,
  fn: async () => {
    const { exports } = await instantiateFixture(guest("values"));
    const p = exports.echoU64(9n);
    assertEq(p instanceof Promise, true);
    assertEq(await p, 9n);
  },
});
