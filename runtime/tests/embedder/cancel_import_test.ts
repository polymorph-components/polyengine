// Amendment A23 (contracts/embedder-api.md §"Functions and async";
// polyengine#241) through the conventions facade: a guest cancelling an
// in-flight async-typed host import (`subtask.cancel`, reached by
// wit-bindgen's drop-to-cancel path) resolves CANCELLED_BEFORE_RETURNED
// promptly by default, discarding the host promise's eventual settlement.
// An import branded `deferCancel()` (protocol/src/defer_cancel.ts) opts out
// per-declaration: its cancel answers BLOCKED and the guest waits for the
// natural result, exactly the pre-A23 behavior.
//
// Fixture: `examples/guests/cancel-import` (extended for A23; the #239
// corpus lives at the raw exec layer in
// tests/integration/e2e_cancel_import_test.ts). Three straight-line exports,
// each poll-once/drop/return over a different import:
//   - cancel-inflight:    bare `sleep` (undecorated)         -> discard
//   - cancel-defer:       bare `sleep-defer` (deferCancel)    -> defer
//   - cancel-defer-ifc:   `timers.sleep-defer` (deferCancel)  -> defer
// The third is the one that would have caught a brand silently dropped by
// the conventions layer's interface-member relay (`instantiate.ts
// relayMarks`, reached at the `timers` namespace-object wrapper) — a
// regression there would make cancel-defer-ifc behave like the discard
// default instead of the deferred one.

import { guest, haveFixture, instantiateFixture } from "./support.ts";
import { deferCancel } from "@polyengine/protocol";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const ready = await haveFixture(guest("cancel-import"));

// Long enough that "returned promptly" (< 400ms) and "waited for natural
// resolution" (>= 800ms) are unambiguous on typical CI timing jitter.
const A23_SLOW = 1200;

async function instantiateGuest() {
  return await instantiateFixture(guest("cancel-import"), {
    sleep: (ms: bigint) => delay(Number(ms)),
    block: (_ms: bigint) => {
      throw new Error("cancel-import A23 tests never call `block`");
    },
    "sleep-defer": deferCancel((ms: bigint) => delay(Number(ms))),
    timers: {
      "sleep-defer": deferCancel((ms: bigint) => delay(Number(ms))),
    },
  });
}

Deno.test({
  name:
    "A23: cancelInflight discards promptly — the bare-function relay preserves the ABSENCE of the brand",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateGuest();

    const start = performance.now();
    await c.exports.cancelInflight(BigInt(A23_SLOW));
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed < 400,
      `A23 regression: cancelInflight(${A23_SLOW}) took ${elapsed}ms (>= 400ms) ` +
        `— an undecorated import's cancel must discard and resolve ` +
        `CANCELLED_BEFORE_RETURNED promptly, not stall until the dropped ` +
        `subtask's host promise settles naturally.`,
    );

    // The store must stay healthy through the conventions wrapper — no
    // `store.hostFailure`-class wedge from the discard path.
    await c.exports.ping();

    // Leak hygiene: discard is about delivery, not execution — the dropped
    // host timer still fires at ~A23_SLOW regardless (--trace-leaks runs).
    await delay(A23_SLOW + 100);
  },
});

Deno.test({
  name:
    "A23: cancelDefer stalls for natural resolution — the bare-function relay carries the brand",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateGuest();

    const start = performance.now();
    await c.exports.cancelDefer(BigInt(A23_SLOW));
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed >= 800,
      `A23 opt-out regression: cancelDefer(${A23_SLOW}) took only ${elapsed}ms ` +
        `— a deferCancel()-branded import's cancel must answer BLOCKED and ` +
        `wait for the natural result.`,
    );
    assertTrue(
      elapsed < 5000,
      `cancelDefer(${A23_SLOW}) took ${elapsed}ms — expected it to complete`,
    );

    await c.exports.ping();
  },
});

Deno.test({
  name:
    "A23: cancelDeferIfc stalls for natural resolution — the INTERFACE-MEMBER relay carries the brand",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateGuest();

    const start = performance.now();
    await c.exports.cancelDeferIfc(BigInt(A23_SLOW));
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed >= 800,
      `A23 opt-out regression: cancelDeferIfc(${A23_SLOW}) took only ` +
        `${elapsed}ms — a deferCancel()-branded INTERFACE-MEMBER import ` +
        `(\`timers.sleep-defer\`) must answer BLOCKED and wait for the ` +
        `natural result, exactly like a bare-function import. This is the ` +
        `regression the implementation review flagged: the conventions ` +
        `layer's interface-member wrapper (instantiate.ts relayMarks) ` +
        `silently dropping the brand while the bare-function relay still ` +
        `carries it.`,
    );
    assertTrue(
      elapsed < 5000,
      `cancelDeferIfc(${A23_SLOW}) took ${elapsed}ms — expected it to complete`,
    );

    await c.exports.ping();
  },
});
