// The abort-on-discard marker (contracts/embedder-api.md §"Functions and
// async", amendment A24; polyengine#241).
//
// What is pinned HERE is the vocabulary half: the mark is a process-global
// brand, so it is readable by any runtime copy and hand-rollable by a
// zero-import host module, and the decorator's loud refusals hold. The
// behavior the mark BUYS — a per-call `AbortSignal`, aborted a microtask after
// an A23 discard — is pinned where the subtask machinery lives
// (runtime/tests/host_import_cancel_test.ts).

import { assert, assertEquals, assertFalse, assertThrows } from "./assert.ts";
import {
  abortable,
  deferCancel,
  isAbortable,
  isDeferCancel,
  isSuspending,
  suspending,
} from "../src/mod.ts";

Deno.test("A24: abortable() marks in place and the brand reads back", () => {
  const fn = (a: number) => a;
  const marked = abortable(fn);
  assert(marked === fn, "the value is marked in place");
  assert(isAbortable(marked));
  assertFalse(isAbortable((a: number) => a));
  assertFalse(isAbortable({}));
  assertFalse(isAbortable(undefined));
  assertFalse(isAbortable(null));
  // An object carrying the brand is not markable-as-an-import: the predicate
  // is function-only, exactly like `isSuspending`/`isDeferCancel`.
  assertFalse(isAbortable({ [Symbol.for("polyengine.abortable/1")]: true }));
});

Deno.test("A24: the mark is the process-global brand, not a module-local symbol", () => {
  const fn = abortable(() => 1);
  assertEquals(
    (fn as unknown as Record<symbol, unknown>)[
      Symbol.for("polyengine.abortable/1")
    ],
    true,
  );
  // Hand-rolled: a zero-import host module can opt into the signal with
  // nothing but the registry symbol (brands are markers, not gatekeepers).
  const hand = Object.defineProperty(
    () => 1,
    Symbol.for("polyengine.abortable/1"),
    { value: true },
  );
  assert(isAbortable(hand));
});

Deno.test("A24: the mark is non-enumerable (invisible to imports-record walks)", () => {
  const fn = abortable(() => 1);
  assertEquals(Object.getOwnPropertySymbols(fn).length, 1);
  assertEquals(
    Object.propertyIsEnumerable.call(fn, Symbol.for("polyengine.abortable/1")),
    false,
  );
  // Re-marking is a no-op, not a TypeError on a non-configurable property.
  abortable(fn);
  assert(isAbortable(fn));
});

Deno.test("A24: @abortable marks instance and static methods", () => {
  class Provider {
    @abortable
    dial(): number {
      return 1;
    }

    @abortable
    static connect(): number {
      return 2;
    }
  }
  // The brand authority for instance methods is the CLASS PROTOTYPE.
  assert(isAbortable(Provider.prototype.dial));
  assert(isAbortable(Provider.connect));
});

Deno.test("A24: the decorator refuses non-method positions at class-definition time", () => {
  // A silent no-op would surface as a `signal` parameter that is forever
  // `undefined` — the host quietly never learning its work was renounced —
  // arbitrarily far from the mistake. Refuse at class-definition time instead.
  for (const kind of ["getter", "setter", "field", "class", "accessor"]) {
    assertThrows(
      () => abortable((() => 1) as CallableFunction, { kind }),
      TypeError,
      `cannot decorate a ${kind}`,
    );
  }
});

Deno.test("A24: the legacy experimentalDecorators convention is refused with guidance", () => {
  // Under that convention the decorator receives the PROTOTYPE, not the
  // method: marking it would brand the wrong object AND corrupt the descriptor.
  const e = assertThrows(
    () => abortable((() => 1) as CallableFunction, "dial", { value: () => 1 }),
    TypeError,
  );
  assert(e.message.includes("experimentalDecorators"));
  assert(e.message.includes("abortable(fn)"));
});

Deno.test("abortable(): a non-function is refused", () => {
  assertThrows(
    () => abortable({} as unknown as CallableFunction),
    TypeError,
    "expected a function",
  );
});

Deno.test("A24: the three marks are independent — each predicate sees only its own", () => {
  // Three different questions (calling convention / what a cancellation
  // answers / whether the host is told), so no predicate may see another's
  // mark, and marking one must not disturb the others.
  const all = abortable(deferCancel(suspending(() => 1)));
  assert(isAbortable(all));
  assert(isDeferCancel(all));
  assert(isSuspending(all));
  assertEquals(Object.getOwnPropertySymbols(all).length, 3);

  const onlyAbort = abortable(() => 1);
  assertFalse(isDeferCancel(onlyAbort));
  assertFalse(isSuspending(onlyAbort));

  const onlyDefer = deferCancel(() => 1);
  assertFalse(isAbortable(onlyDefer));
  const onlySuspend = suspending(() => 1);
  assertFalse(isAbortable(onlySuspend));
});
