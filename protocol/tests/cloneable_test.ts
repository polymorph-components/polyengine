// Round-trip law and refusals for the structured-clone-safe forms
// (contracts/embedder-api.md §"Realm boundaries and structured-clone-safe
// forms"; issue #131).
//
// The clone step is a REAL `structuredClone` throughout, never a hand-rolled
// stand-in: the whole point of the envelope is that it survives the platform
// serializer, and a stand-in would test the encoder against itself.

import { assert, assertEquals, assertFalse, assertThrows } from "./assert.ts";
import {
  COMPONENT_EXCEPTION,
  ComponentException,
  defineBrand,
  defineRealmLocal,
  DroppedError,
  ERROR_CONTEXT,
  fromCloneable,
  hasBrand,
  InvalidHandleError,
  isComponentException,
  isDroppedError,
  isInvalidHandleError,
  isPeerTrappedError,
  isStreamProducerError,
  isTrap,
  PeerTrappedError,
  STREAM,
  STREAM_WRITER,
  StreamProducerError,
  toCloneable,
  Trap,
  WASI_EXIT,
} from "../src/mod.ts";

/** The sanctioned crossing, end to end. */
function roundTrip(v: unknown): unknown {
  return fromCloneable(structuredClone(toCloneable(v)));
}

Deno.test("ComponentException round-trips exact for every matcher", () => {
  const e = new ComponentException({ kind: "denied", value: 7 }, "nope");
  const out = roundTrip(e) as ComponentException<
    { kind: string; value: number }
  >;
  assert(isComponentException(out));
  assertEquals(out.message, "nope");
  assertEquals(out.name, "ComponentException");
  assertEquals(out.payload, { kind: "denied", value: 7 });
  assertEquals(out.stack, e.stack, "the sender's stack is the useful one");
});

Deno.test("a payloadless variant keeps `value` ABSENT", () => {
  const out = roundTrip(
    new ComponentException({ kind: "timed-out" }),
  ) as ComponentException<Record<string, unknown>>;
  assertEquals(out.payload, { kind: "timed-out" });
  assertFalse("value" in out.payload, "`value` must not materialize");
});

Deno.test("an undefined payload survives as undefined, not absent", () => {
  const out = roundTrip(
    new ComponentException(undefined),
  ) as ComponentException;
  assert(isComponentException(out));
  assertEquals(out.payload, undefined);
});

Deno.test("nested record/list payloads keep binary content", () => {
  const e = new ComponentException({
    kind: "io",
    value: { chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([])], n: 2n },
  });
  const out = roundTrip(e) as ComponentException<
    { kind: string; value: { chunks: Uint8Array[]; n: bigint } }
  >;
  assertEquals(Array.from(out.payload.value.chunks[0]), [1, 2, 3]);
  assertEquals(out.payload.value.chunks[1].length, 0);
  assert(out.payload.value.chunks[0] instanceof Uint8Array);
  assert(out.payload.value.n === 2n, "bigint passes through");
});

Deno.test("Trap / DroppedError / InvalidHandleError round-trip", () => {
  const t = roundTrip(new Trap("boom")) as Trap;
  assert(isTrap(t));
  assertEquals([t.name, t.message], ["Trap", "boom"]);

  const d = roundTrip(new DroppedError()) as DroppedError;
  assert(isDroppedError(d));
  assertEquals(d.message, "the write end was dropped without a value");

  const i = roundTrip(new InvalidHandleError("gone")) as InvalidHandleError;
  assert(isInvalidHandleError(i));
  assertEquals(i.message, "gone");
});

Deno.test("PeerTrappedError keeps message, progress and its cause chain", () => {
  const inner = new Trap("guest trapped");
  const e = new PeerTrappedError("stream write", inner, 3);
  const out = roundTrip(e) as PeerTrappedError;
  assert(isPeerTrappedError(out));
  assertEquals(out.message, e.message, "message verbatim, not re-derived");
  assertEquals(out.progress, 3);
  assert(isTrap(out.cause), "a branded cause rehydrates branded");
  assertEquals((out.cause as Trap).message, "guest trapped");
});

Deno.test("progress stays out of the envelope when the sender had none", () => {
  // (`progress` is a declared class field, so the property itself exists on
  // every instance; what must not happen is a fabricated VALUE.)
  const enc = toCloneable(new PeerTrappedError("w", new Trap())) as Record<
    string,
    unknown
  >;
  assertFalse("progress" in enc);
  const out = roundTrip(
    new PeerTrappedError("w", new Trap()),
  ) as PeerTrappedError;
  assertEquals(out.progress, undefined);
});

Deno.test("StreamProducerError carries an unbranded cause as an Error", () => {
  const cause = new RangeError("out of range");
  const out = roundTrip(
    new StreamProducerError("site", cause),
  ) as StreamProducerError;
  assert(isStreamProducerError(out));
  const c = out.cause as Error;
  assert(c instanceof Error, "an unbranded cause rehydrates as a plain Error");
  assertEquals([c.name, c.message], ["RangeError", "out of range"]);
});

Deno.test("a cause chain survives to full depth through an unbranded link", () => {
  // The runtime's real peer-fault shape (runtime/src/task/streams.ts:876-883):
  // the recorded poisoning failure is a plain `new Error(msg, { cause })`
  // whose cause is the underlying branded `Trap`. The trap at the bottom must
  // still satisfy `isTrap` after the crossing, or a proxy cannot distinguish
  // a peer fault from a clean drop's cousin (round-trip law).
  const e = new PeerTrappedError(
    "read",
    new Error("instance trapped while holding an end", {
      cause: new Trap("guest trapped: unreachable"),
    }),
    3,
  );
  const out = roundTrip(e) as PeerTrappedError;
  assert(isPeerTrappedError(out));
  assertEquals(out.progress, 3);

  const middle = out.cause as Error;
  assert(middle instanceof Error, "the unbranded link stays an Error");
  assertEquals(
    [middle.name, middle.message],
    ["Error", "instance trapped while holding an end"],
  );
  assertFalse(isTrap(middle), "the middle link is unbranded and stays so");
  assertFalse(isPeerTrappedError(middle));

  const trap = middle.cause as Trap;
  assert(isTrap(trap), "the trap at depth 2 survives the unbranded link");
  assertEquals(trap.message, "guest trapped: unreachable");
});

Deno.test("a cause absent at the sender stays absent", () => {
  const out = roundTrip(new Trap("bare")) as Trap;
  assertFalse("cause" in out, "absent and undefined-valued are different");
});

Deno.test("a hand-rolled brand encodes identically to the class", () => {
  const rolled = Object.assign(new Error("boom"), {
    [COMPONENT_EXCEPTION]: true,
    payload: { kind: "denied" },
  });
  const canonical = new ComponentException({ kind: "denied" }, "boom");
  const a = toCloneable(rolled) as Record<string, unknown>;
  const b = toCloneable(canonical) as Record<string, unknown>;
  delete a.stack;
  delete b.stack;
  assertEquals(a, b, "brand detection never consults instanceof");

  const out = roundTrip(rolled) as ComponentException<{ kind: string }>;
  assert(isComponentException(out));
  assertEquals(out.payload.kind, "denied");
});

Deno.test("error-context round-trips as a branded message carrier", () => {
  const ctx = { message: "guest said no" };
  defineBrand(ctx, ERROR_CONTEXT);
  const out = roundTrip(ctx) as { message: string };
  assert(hasBrand(out, ERROR_CONTEXT));
  assertEquals(out.message, "guest said no");
});

Deno.test("an ErrorContext-shaped value encodes despite its pill", () => {
  // The realm-local pill and an envelope-encodable brand coexist on a lifted
  // `ErrorContext`; the envelope wins (walk semantics).
  const ctx = { message: "both" };
  defineBrand(ctx, ERROR_CONTEXT);
  defineRealmLocal(ctx);
  const out = roundTrip(ctx) as { message: string };
  assert(hasBrand(out, ERROR_CONTEXT));
  assertEquals(out.message, "both");
});

Deno.test("a wasi exit unwind round-trips by brand, not by import", () => {
  const exit = Object.assign(new Error("exit(3)"), { ok: false, code: 3 });
  exit.name = "ExitError";
  defineBrand(exit, WASI_EXIT);
  const out = roundTrip(exit) as Error & { ok: boolean; code?: number };
  assert(hasBrand(out, WASI_EXIT));
  assertEquals([out.name, out.message], ["ExitError", "exit(3)"]);
  assertEquals([out.ok, out.code], [false, 3]);
  assertEquals(out.stack, exit.stack);

  const clean = Object.assign(new Error("exit(0)"), { ok: true });
  defineBrand(clean, WASI_EXIT);
  const cleanOut = roundTrip(clean) as Error & { ok: boolean; code?: number };
  assertEquals(cleanOut.ok, true);
  assertFalse("code" in cleanOut);
});

Deno.test("an unbranded Error rides the `error` row", () => {
  const out = roundTrip(new TypeError("bad")) as Error;
  assert(out instanceof Error);
  assertEquals([out.name, out.message], ["TypeError", "bad"]);
});

Deno.test("containers are rebuilt fresh, leaves pass through", () => {
  const v = { list: [1, "a", true, null], nested: { n: 1n }, u: undefined };
  const enc = toCloneable(v) as typeof v;
  assertFalse(enc === v, "fresh containers");
  const out = roundTrip(v) as typeof v;
  assertEquals(out.list, [1, "a", true, null]);
  assert(out.nested.n === 1n);
  assert("u" in out && out.u === undefined);
});

Deno.test("Map/Set/Date pass through unwalked", () => {
  const d = new Date(0);
  const enc = toCloneable({ d, m: new Map([["k", 1]]) }) as {
    d: Date;
    m: Map<string, number>;
  };
  assert(enc.d === d, "passed by reference, unwalked");
  const out = roundTrip({ d, m: new Map([["k", 1]]) }) as {
    d: Date;
    m: Map<string, number>;
  };
  assertEquals(out.d.getTime(), 0);
  assertEquals(out.m.get("k"), 1);
});

// --- refusals ------------------------------------------------------------

Deno.test("a realm-local leaf is refused, with its path named", () => {
  const handle = {};
  defineRealmLocal(handle);
  const e = assertThrows(
    () => toCloneable({ payload: { items: [1, handle] } }),
    InvalidHandleError,
    "value.payload.items[1]",
  );
  assert(isInvalidHandleError(e));
  assert(e.message.includes("Proxy the interface, not the handle"));
});

Deno.test("a STREAM-branded value is realm-local too", () => {
  const stream = {};
  defineBrand(stream, STREAM);
  assertThrows(
    () => toCloneable({ s: stream }),
    InvalidHandleError,
    "value.s is realm-local",
  );
});

Deno.test("a STREAM_WRITER-branded value is realm-local too", () => {
  // Belt-and-suspenders (cloneable.ts `isRealmLocalValue`): a real
  // `StreamWriter` already refuses via the realm-local pill (`defineRealmLocal` in
  // its constructor); this covers a hand-rolled writer that carries only
  // the brand.
  const writer = {};
  defineBrand(writer, STREAM_WRITER);
  assertThrows(
    () => toCloneable({ w: writer }),
    InvalidHandleError,
    "value.w is realm-local",
  );
});

Deno.test("functions and symbols are TypeErrors naming the path", () => {
  assertThrows(() => toCloneable({ f: () => {} }), TypeError, "value.f");
  assertThrows(
    () => toCloneable([{ "odd key": Symbol("s") }]),
    TypeError,
    `value[0]["odd key"]`,
  );
});

Deno.test("a genuine cycle is refused; DAG aliasing is duplicated", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertThrows(() => toCloneable(cyclic), TypeError, "value.self");

  const shared = { n: 1 };
  const dag = toCloneable({ a: shared, b: shared }) as {
    a: unknown;
    b: unknown;
  };
  assertFalse(dag.a === dag.b, "aliasing is not preserved, only cycles refuse");
});

Deno.test("an input already carrying the tag key is refused", () => {
  assertThrows(
    () => toCloneable({ inner: { "polyengine.cloneable/1": "error" } }),
    TypeError,
    "value.inner",
  );
});

Deno.test("an unknown tag fails loud at fromCloneable", () => {
  assertThrows(
    () =>
      fromCloneable({ x: { "polyengine.cloneable/1": "polyengine.woo/9" } }),
    TypeError,
    "value.x carries an unknown cloneable tag",
  );
});

Deno.test("a foreign prototype is refused", () => {
  class Widget {}
  assertThrows(() => toCloneable({ w: new Widget() }), TypeError, "value.w");
});

// --- the replace hook ----------------------------------------------------

Deno.test("replace substitutes plain data, which is then walked", () => {
  const handle = {};
  defineRealmLocal(handle);
  const seen: string[] = [];
  const enc = toCloneable({ h: handle }, {
    replace: (leaf, path) => {
      seen.push(path);
      assert(leaf === handle);
      return { proxyId: 42, nested: [1, 2] };
    },
  }) as { h: { proxyId: number; nested: number[] } };
  assertEquals(seen, ["value.h"]);
  assertEquals(enc.h, { proxyId: 42, nested: [1, 2] });
  // ...and the substitute really is walked: a handle inside it still refuses.
  const other = {};
  defineRealmLocal(other);
  assertThrows(
    () =>
      toCloneable({ h: handle }, {
        replace: (leaf) => leaf === handle ? { deep: other } : undefined,
      }),
    InvalidHandleError,
    "value.h.deep",
  );
});

Deno.test("replace returning undefined or the leaf falls through", () => {
  const handle = {};
  defineRealmLocal(handle);
  assertThrows(
    () => toCloneable(handle, { replace: () => undefined }),
    InvalidHandleError,
    "value is realm-local",
  );
  assertThrows(
    () => toCloneable(handle, { replace: (leaf) => leaf }),
    InvalidHandleError,
    "value is realm-local",
  );
});

// --- pill mechanics ------------------------------------------------------

Deno.test("the pill trips the serializer, and only the serializer", () => {
  const handle: Record<string, unknown> = { id: 1 };
  defineRealmLocal(handle);

  let name = "";
  try {
    structuredClone(handle);
  } catch (e) {
    name = (e as Error).name;
  }
  assertEquals(name, "DataCloneError", "a raw clone throws in the SENDER");

  assertEquals(JSON.stringify(handle), `{"id":1}`, "JSON omits functions");
  const spread = { ...handle };
  assertEquals(typeof spread["polyengine.realmLocal/1"], "function");
  assertEquals(spread.id, 1, "spread copies an inert reference, never throws");

  // Buried inside a record posted raw, it still trips.
  let buried = "";
  try {
    structuredClone({ deep: { list: [handle] } });
  } catch (e) {
    buried = (e as Error).name;
  }
  assertEquals(buried, "DataCloneError");
});

// --- the actual point: a real realm boundary -----------------------------

Deno.test("the envelope survives a real cross-realm postMessage", async () => {
  const worker = new Worker(import.meta.resolve("./cloneable_worker.ts"), {
    type: "module",
  });
  try {
    const results = await new Promise<Record<string, boolean>>(
      (resolve, reject) => {
        worker.onmessage = (ev) => resolve(ev.data as Record<string, boolean>);
        worker.onerror = (ev) => reject(new Error(String(ev.message)));
        worker.postMessage({
          exception: toCloneable(
            new ComponentException({ kind: "denied", value: 7 }, "nope"),
          ),
          peer: toCloneable(
            new PeerTrappedError(
              "stream write",
              new Error("instance trapped while holding an end", {
                cause: new Trap("guest trapped"),
              }),
              3,
            ),
          ),
        });
      },
    );
    for (const [k, ok] of Object.entries(results)) {
      assert(ok, `worker check failed: ${k}`);
    }
    assert(Object.keys(results).length > 0);
  } finally {
    worker.terminate();
  }
});
