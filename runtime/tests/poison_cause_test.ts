// polyengine#145 ask 1: entry refusals on a poisoned instance name the
// original trap. The scheduler records the FIRST poisoning cause per instance
// (follow-on failures against a corpse are noise) and `withPoisonCause`
// appends it to the refusal message. Since CM#705 (polyengine#173) poisoning
// is the ONLY reason an entry is refused, so the helper's pass-through
// behavior on an unmarked instance is just the "nothing to say" case rather
// than a second refusal class. The e2e face is asserted in
// integration/e2e_hello_test.ts, the trampoline face in
// enter_sync_call_reentrance_test.ts.
//
// No hook manipulation here: if task/streams.ts's retirement walk happens to
// be registered on the poisoning seam (another test file in this process
// imported it), `retireInstanceAsyncEnds` is a no-op on a stub instance with
// an empty handle table.

import { assertEq } from "./support/asserts.ts";
import {
  instancePoisonCause,
  isInstancePoisoned,
  notifyInstancePoisoned,
  withPoisonCause,
} from "../src/task/scheduler.ts";
import { Trap } from "../src/cabi/trap.ts";

function fakeInst(): { handles: Iterable<unknown> } {
  return { handles: [] };
}

Deno.test("poison cause: recorded, queryable, first cause wins", () => {
  const inst = fakeInst();
  assertEq(isInstancePoisoned(inst), false, "fresh instance is not poisoned");
  assertEq(instancePoisonCause(inst), undefined, "no cause before poisoning");

  const original = new Trap(
    "cannot leave component instance 1 (may_leave violation)",
  );
  notifyInstancePoisoned(inst, original);
  assertEq(isInstancePoisoned(inst), true, "poisoned after notify");
  assertEq(instancePoisonCause(inst) === original, true, "cause identity");

  // A later trap against the same corpse must not displace the
  // original cause — it is the one worth reporting.
  notifyInstancePoisoned(inst, new Trap("second victim"));
  assertEq(
    instancePoisonCause(inst) === original,
    true,
    "first cause wins over follow-on failures",
  );
});

Deno.test("poison cause: refusal message carries the original trap", () => {
  const inst = fakeInst();
  notifyInstancePoisoned(inst, new Trap("boom in cabi_realloc"));
  assertEq(
    withPoisonCause(inst, "cannot enter component instance 8"),
    "cannot enter component instance 8" +
      " — instance poisoned by: Trap: boom in cabi_realloc",
  );
});

Deno.test("poison cause: an unmarked instance gets the base unchanged", () => {
  const inst = fakeInst(); // never poisoned, so there is no cause to append
  assertEq(
    withPoisonCause(inst, "cannot enter component instance"),
    "cannot enter component instance",
  );
});

Deno.test("poison cause: non-Error and unprintable causes degrade safely", () => {
  const plain = fakeInst();
  notifyInstancePoisoned(plain, "a thrown string");
  assertEq(
    withPoisonCause(plain, "base"),
    "base — instance poisoned by: a thrown string",
  );

  const unprintable = fakeInst();
  notifyInstancePoisoned(unprintable, {
    toString(): string {
      throw new Error("nope");
    },
  });
  assertEq(
    withPoisonCause(unprintable, "base"),
    "base — instance poisoned by: (unprintable poison cause)",
  );
});
