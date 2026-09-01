// Per-declaration suspendable host imports — contracts/embedder-api.md
// §"Functions and async" (the `suspending()` marker), through
// the conventions facade.
//
// Before the suspending() mark, the boundary REJECTED a Promise from a sync-typed lower in every
// mode (`NeedsJspi`, boundary.ts) — auto-detection lit the CM-async
// builtins' suspension sites but never the host-lower site, because no
// consumer and no suite command drives one (callback-ABI consumers use
// async-typed imports). The suspending() mark makes the park real: a `suspending()`-marked
// import may return a Promise, the calling wasm FRAME suspends on the
// engine's JSPI, and the settled value is lowered at resume time under the
// suspension point's ambient claim (the issue-#24 attribution discipline).
//
// Fixtures: `crates/translator-shim/testdata/imports.wasm` (sync-typed
// add/greet/log; greet's string result drives guest realloc at lowering
// time) and `tests/embedder/start-imports.wasm` (imports called from a core
// `start` function — the pin (c) legality boundary).

import { assertEq } from "../support/asserts.ts";
import { assert as assertTrue } from "../jspi/asserts.ts";
import {
  caught,
  haveFixture,
  instantiateFixture,
  readArtifact,
  testdata,
} from "./support.ts";
import { suspending } from "@polyengine/protocol";
import {
  anySuspendingImport,
  isSuspending,
  isSupported,
} from "../../src/jspi/mod.ts";

const ready = (await haveFixture(testdata("imports"))) && isSupported();

/** A Promise that settles only after a real macrotask hop, so a "park" is a
 * genuine suspension across the event loop, never a microtask formality. */
function later<T>(value: T): Promise<T> {
  return new Promise((r) => setTimeout(() => r(value), 0));
}

Deno.test({
  name: "suspending(): a marked sync-typed import parks the frame and resumes with the value",
  ignore: !ready,
  fn: async () => {
    const logged: number[] = [];
    const c = await instantiateFixture(testdata("imports"), {
      log: (x: number) => void logged.push(x),
      "host:api/math": {
        add: suspending((a: number, b: number) => later(a + b)),
        greet: (who: string) => `hello ${who}`,
      },
    });
    // run = log(add(a, b)); return it. The frame parks inside `add`, and the
    // POST-RESUME continuation still reaches the unmarked `log` import with
    // the settled value — the resumed chunk runs with correct attribution.
    assertEq(await c.exports.run(2, 40), 42);
    assertEq(logged, [42]);
  },
});

Deno.test({
  name: "suspending(): resume-time result lowering drives guest realloc (string result)",
  ignore: !ready,
  fn: async () => {
    // greet: string -> string. Lowering the settled result re-enters the
    // guest through realloc — the CABI work suspending mark defers to `produce` so it
    // runs under the suspension point's claim, not in a bare promise
    // continuation (issue #24's mis-attribution class).
    const c = await instantiateFixture(testdata("imports"), {
      log: () => {},
      "host:api/math": {
        add: (a: number, b: number) => a + b,
        greet: suspending((who: string) => later(`hello ${who}`)),
      },
    });
    assertEq(await c.exports.greetLen(), "hello ab".length);
  },
});

Deno.test({
  name: "suspending(): a marked import returning synchronously stays on the value path",
  ignore: !ready,
  fn: async () => {
    // Marking declares that the import MAY park, not that it must: a plain
    // return takes the Suspending fast path (jspi pin (j) adds only the
    // continuation hop, which is unobservable at this level).
    const c = await instantiateFixture(testdata("imports"), {
      log: () => {},
      "host:api/math": {
        add: suspending((a: number, b: number) => a + b),
        greet: (who: string) => `hello ${who}`,
      },
    });
    assertEq(await c.exports.run(20, 22), 42);
  },
});

Deno.test({
  name: "unmarked sync import returning a Promise still refuses, naming suspending()",
  ignore: !ready,
  fn: async () => {
    // Fail-on-pre-fix shape, upgraded message: without the marker there is
    // no Suspending wrap, so the frame physically cannot park — the refusal
    // must tell the embedder about the suspending mark marker rather than dead-end on
    // "needs JSPI" alone.
    const c = await instantiateFixture(testdata("imports"), {
      log: () => {},
      "host:api/math": {
        add: (a: number, b: number) => later(a + b), // NOT marked
        greet: (who: string) => `hello ${who}`,
      },
    });
    const e = await caught(() => c.exports.run(1, 2));
    assertTrue(e !== undefined, "expected the export call to reject");
    assertTrue(
      String(e).includes("suspending()"),
      `refusal should name the marker, got: ${e}`,
    );
  },
});

Deno.test({
  name: "explicit jspi:false forces plain mode; a marked import's Promise still refuses",
  ignore: !ready,
  fn: async () => {
    // The embedder's explicit override outranks marker evidence (chooseMode:
    // `jspi: false` always forces plain — the engine-floor escape hatch).
    const c = await instantiateFixture(testdata("imports"), {
      log: () => {},
      "host:api/math": {
        add: suspending((a: number, b: number) => later(a + b)),
        greet: (who: string) => `hello ${who}`,
      },
    }, { jspi: false });
    const e = await caught(() => c.exports.run(1, 2));
    assertTrue(e !== undefined, "expected the export call to reject");
    assertTrue(
      String(e).includes("must block"),
      `plain-mode refusal names the blocked frame, got: ${e}`,
    );
  },
});

Deno.test({
  name: "suspending(): a rejected host promise surfaces as the export call's failure",
  ignore: !ready,
  fn: async () => {
    // A rejection at resume time routes through the suspension point's fail
    // path: the engine unwinds the parked frame (empirical fact (e): a
    // post-resume trap is an ordinary rejection). Branded ComponentExceptions never
    // reach this layer raw — this is the unbranded-failure path.
    const c = await instantiateFixture(testdata("imports"), {
      log: () => {},
      "host:api/math": {
        add: suspending(() =>
          new Promise((_r, reject) =>
            setTimeout(() => reject(new Error("entropy pool on fire")), 0)
          )
        ),
        greet: (who: string) => `hello ${who}`,
      },
    });
    const e = await caught(() => c.exports.run(1, 2));
    assertTrue(e !== undefined, "expected the export call to reject");
    assertTrue(
      String(e).includes("entropy pool on fire"),
      `the host's failure should surface, got: ${e}`,
    );
  },
});

const fallibleReady =
  (await readArtifact("runtime/tests/embedder/host-result.wasm")) !== null &&
  isSupported();

Deno.test({
  name: "suspending(): a ComponentException rejection over a park becomes the guest's err case, not a trap",
  ignore: !fallibleReady,
  fn: async () => {
    // The branded-throw contract survives the suspension: #wrapImportFn
    // chains the marked import's Promise through its ok/fail adapters, so a
    // ComponentException REJECTION settles the boundary promise with the err-shaped
    // value — the parked frame resumes into `result::err` (run() == 1), and
    // nothing traps. The sync-throw variant of this pin lives in
    // host_imports_test.ts; this is the same rail at resume time.
    const { ComponentException } = await import("@polyengine/protocol");
    const c = await instantiateFixture(
      "runtime/tests/embedder/host-result.wasm",
      {
        "host:api/fallible": {
          check: suspending(() =>
            new Promise((_r, reject) =>
              setTimeout(() => reject(new ComponentException(undefined)), 0)
            )
          ),
        },
      },
    );
    // run(): u32 — the guest hands back the flat discriminant it observed.
    assertEq(await c.exports.run(), 1, "1 == the guest observed err");
  },
});

const startReady =
  (await readArtifact("runtime/tests/embedder/start-imports.wasm")) !== null &&
  (await haveFixture(testdata("imports"))) && isSupported();

Deno.test({
  name: "suspending(): a marked import reached from a start function traps (pin (c)), even returning synchronously",
  ignore: !startReady,
  fn: async () => {
    // THE documented cost of marking (suspending.ts doc): a Suspending
    // import called outside a promising activation traps unconditionally —
    // and a start function is never a promising activation. This is the
    // Component Model's own rule (a start function may not block) enforced
    // by the engine, and it fires even when the marked import would have
    // returned synchronously. Unmarked, the same fixture instantiates fine
    // (start_imports_test.ts pins that).
    const e = await caught(() =>
      instantiateFixture("runtime/tests/embedder/start-imports.wasm", {
        "host:api/boot": {
          tick: suspending(() => 7n), // synchronous return; marking alone trips pin (c)
          note: (_msg: string) => {},
        },
      })
    );
    assertTrue(e !== undefined, "expected instantiation to fail");
    assertTrue(
      String(e).includes("cannot block a synchronous task"),
      `expected the dont-block-start wording, got: ${e}`,
    );
  },
});

Deno.test("suspending(): marker mechanics (brand, identity, record scan)", () => {
  const fn = (x: number) => x;
  const marked = suspending(fn);
  assertTrue(marked === fn, "suspending() marks in place");
  assertTrue(isSuspending(marked), "brand readable");
  assertTrue(!isSuspending((x: number) => x), "unmarked fn clean");
  assertTrue(!isSuspending({}), "non-functions never branded");
  // Record scan: top-level and interface-member leaves, exactly the shapes
  // `lookupHostImport` reaches. NB `suspending()` marks in place, so the
  // negative case needs genuinely fresh functions.
  assertTrue(anySuspendingImport({ log: marked }));
  assertTrue(anySuspendingImport({ "ns:pkg/i@1.0": { f: marked } }));
  assertTrue(
    !anySuspendingImport({ log: () => 0, "ns:pkg/i@1.0": { g: () => 1 } }),
  );
  assertTrue(!anySuspendingImport(undefined));
  assertTrue(!anySuspendingImport({}));
});

// ---------------------------------------------------------------------------
// suspending mark: decorator form, resource methods/statics, receiver binding
// ---------------------------------------------------------------------------

Deno.test({
  name: "suspending mark: @suspending on a provider-class method parks, with `this` bound to the provider",
  ignore: !ready,
  fn: async () => {
    // Two pins in one: the stage-3 decorator marks the prototype method the
    // plain arm reads off the instance, and the suspending mark receiver rule makes the
    // extracted method see its instance state (pre-suspending mark the plain arm called
    // extracted functions unbound — a stateful class provider broke with
    // `this === undefined`).
    class MathProvider {
      #bias: number;
      constructor(bias: number) {
        this.#bias = bias;
      }
      @suspending
      add(a: number, b: number): Promise<number> {
        return later(a + b + this.#bias);
      }
      greet(who: string): string {
        return `hello ${who}`;
      }
    }
    const c = await instantiateFixture(testdata("imports"), {
      log: () => {},
      "host:api/math": new MathProvider(100),
    });
    assertEq(await c.exports.run(2, 40), 142);
  },
});

Deno.test({
  name: "suspending mark: receiver binding alone — an unmarked stateful class provider works synchronously",
  ignore: !ready,
  fn: async () => {
    // The receiver fix is independent of parking: no marks, no Promises,
    // plain mode — instance state must still be reachable.
    class MathProvider {
      #bias = 1000;
      add(a: number, b: number): number {
        return a + b + this.#bias;
      }
      greet(who: string): string {
        return `hello ${who}`;
      }
    }
    const c = await instantiateFixture(testdata("imports"), {
      log: () => {},
      "host:api/math": new MathProvider(),
    }, { jspi: false });
    assertEq(await c.exports.run(2, 40), 1042);
  },
});

const methodReady =
  (await readArtifact("runtime/tests/embedder/suspending-method.wasm")) !==
    null && isSupported();

Deno.test({
  name: "suspending mark: @suspending on a host-resource METHOD parks the frame (the pollable.block shape)",
  ignore: !methodReady,
  fn: async () => {
    // The load-bearing scope extension: `[method]gauge.read` is the same
    // WIT shape as `[method]pollable.block`, the site the tier-(c) WASI
    // blocking profile hangs off. The brand authority is the class
    // prototype, read at wrap time; the guest-driven CONSTRUCTOR stays
    // synchronous while the method parks.
    class Gauge {
      #v: number;
      constructor(v: number) {
        this.#v = v;
      }
      @suspending
      read(): Promise<number> {
        return later(this.#v * 2);
      }
      @suspending
      static calibrate(): Promise<number> {
        return later(7);
      }
    }
    const c = await instantiateFixture(
      "runtime/tests/embedder/suspending-method.wasm",
      { "host:api/dev": { Gauge } },
    );
    assertEq(await c.exports.probe(21), 42);
    assertEq(await c.exports.calib(), 7);
  },
});

Deno.test("suspending mark: the decorator refuses non-method positions at class-definition time", () => {
  let raised: unknown;
  try {
    // deno-lint-ignore no-unused-vars
    class Bad {
      // deno-lint-ignore no-explicit-any
      @(suspending as any)
      get x(): number {
        return 1;
      }
    }
  } catch (e) {
    raised = e;
  }
  assertTrue(raised instanceof TypeError, `expected TypeError, got ${raised}`);
  assertTrue(
    String(raised).includes("getter"),
    `should name the offending kind, got: ${raised}`,
  );
});

Deno.test("suspending mark: the legacy experimentalDecorators convention is refused with guidance", () => {
  // Simulate what `experimentalDecorators: true` would pass: (prototype,
  // key, descriptor). Marking the prototype would brand the wrong object
  // and corrupt the descriptor, so it must throw instead.
  const proto = { read() {} };
  let raised: unknown;
  try {
    // deno-lint-ignore no-explicit-any
    (suspending as any)(
      proto,
      "read",
      Object.getOwnPropertyDescriptor(proto, "read"),
    );
  } catch (e) {
    raised = e;
  }
  assertTrue(raised instanceof TypeError, `expected TypeError, got ${raised}`);
  assertTrue(
    String(raised).includes("stage-3"),
    `should point at the fix, got: ${raised}`,
  );
});
