// The cancel-discard opt-out marker (contracts/embedder-api.md §"Functions
// and async"; polyengine#241).
//
// What is pinned HERE is the vocabulary half: the mark is a process-global
// brand, so it is readable by any runtime copy and hand-rollable by a
// zero-import host module, and the decorator's loud refusals hold. The
// behavior the mark BUYS — default discard vs. run-to-completion — is pinned
// where the subtask machinery lives (runtime/tests/host_import_cancel_test.ts).

import { assert, assertEquals, assertFalse, assertThrows } from "./assert.ts";
import { deferCancel, isDeferCancel, isSuspending, suspending } from "../src/mod.ts";

Deno.test("deferCancel() marks in place and the brand reads back", () => {
  const fn = (a: number) => a;
  const marked = deferCancel(fn);
  assert(marked === fn, "the value is marked in place");
  assert(isDeferCancel(marked));
  assertFalse(isDeferCancel((a: number) => a));
  assertFalse(isDeferCancel({}));
  assertFalse(isDeferCancel(undefined));
  assertFalse(isDeferCancel(null));
  // An object carrying the brand is not markable-as-an-import: the predicate
  // is function-only, exactly like `isSuspending`.
  assertFalse(
    isDeferCancel({ [Symbol.for("polyengine.deferCancel/1")]: true }),
  );
});

Deno.test("the mark is the process-global brand, not a module-local symbol", () => {
  const fn = deferCancel(() => 1);
  assertEquals(
    (fn as unknown as Record<symbol, unknown>)[
      Symbol.for("polyengine.deferCancel/1")
    ],
    true,
  );
  // Hand-rolled: a zero-import host module can opt out of discard with
  // nothing but the registry symbol (brands are markers, not gatekeepers).
  const hand = Object.defineProperty(
    () => 1,
    Symbol.for("polyengine.deferCancel/1"),
    { value: true },
  );
  assert(isDeferCancel(hand));
});

Deno.test("the mark is non-enumerable (invisible to imports-record walks)", () => {
  const fn = deferCancel(() => 1);
  assertEquals(Object.getOwnPropertySymbols(fn).length, 1);
  assertEquals(
    Object.propertyIsEnumerable.call(fn, Symbol.for("polyengine.deferCancel/1")),
    false,
  );
  // Re-marking is a no-op, not a TypeError on a non-configurable property.
  deferCancel(fn);
  assert(isDeferCancel(fn));
});

Deno.test("@deferCancel marks instance and static methods", () => {
  class Provider {
    @deferCancel
    flush(): number {
      return 1;
    }

    @deferCancel
    static commit(): number {
      return 2;
    }
  }
  // The brand authority for instance methods is the CLASS PROTOTYPE.
  assert(isDeferCancel(Provider.prototype.flush));
  assert(isDeferCancel(Provider.commit));
});

Deno.test("the decorator refuses non-method positions at class-definition time", () => {
  // A silent no-op would surface as a DISCARDED COMMIT — the guest told the
  // write was cancelled while it lands anyway — arbitrarily far from the
  // mistake. Refuse at class-definition time instead.
  for (const kind of ["getter", "setter", "field", "class", "accessor"]) {
    assertThrows(
      () => deferCancel((() => 1) as CallableFunction, { kind }),
      TypeError,
      `cannot decorate a ${kind}`,
    );
  }
});

Deno.test("the legacy experimentalDecorators convention is refused with guidance", () => {
  // Under that convention the decorator receives the PROTOTYPE, not the
  // method: marking it would brand the wrong object AND corrupt the descriptor.
  const e = assertThrows(
    () => deferCancel((() => 1) as CallableFunction, "flush", { value: () => 1 }),
    TypeError,
  );
  assert(e.message.includes("experimentalDecorators"));
  assert(e.message.includes("deferCancel(fn)"));
});

Deno.test("deferCancel(): a non-function is refused", () => {
  assertThrows(
    () => deferCancel({} as unknown as CallableFunction),
    TypeError,
    "expected a function",
  );
});

Deno.test("independent of suspending() — both brands may ride one function", () => {
  // Different questions (calling convention vs. cancellation answer), so
  // neither predicate may see the other's mark, and marking one must not
  // disturb the other.
  const both = deferCancel(suspending(() => 1));
  assert(isDeferCancel(both));
  assert(isSuspending(both));
  assertEquals(Object.getOwnPropertySymbols(both).length, 2);

  const onlyDefer = deferCancel(() => 1);
  assertFalse(isSuspending(onlyDefer));
  const onlySuspend = suspending(() => 1);
  assertFalse(isDeferCancel(onlySuspend));
});
