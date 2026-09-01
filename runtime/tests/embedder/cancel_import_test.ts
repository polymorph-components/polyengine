// Cancellation discard-by-default (contracts/embedder-api.md §"Functions and async";
// polyengine#241) through the conventions facade: a guest cancelling an
// in-flight async-typed host import (`subtask.cancel`, reached by
// wit-bindgen's drop-to-cancel path) resolves CANCELLED_BEFORE_RETURNED
// promptly by default, discarding the host promise's eventual settlement.
// An import branded `deferCancel()` (protocol/src/defer_cancel.ts) opts out
// per-declaration: its cancel answers BLOCKED and the guest waits for the
// natural result, exactly the pre-cancellation discard behavior.
//
// Fixture: `examples/guests/cancel-import` (extended for cancellation discard; the #239
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
import { abortable, deferCancel } from "@polyengine/protocol";

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
      throw new Error("cancel-import cancellation discard tests never call `block`");
    },
    "sleep-defer": deferCancel((ms: bigint) => delay(Number(ms))),
    timers: {
      "sleep-defer": deferCancel((ms: bigint) => delay(Number(ms))),
    },
    // Never exercised by the cancellation discard tests below, but the plan requires every
    // declared import to be provided — abortable() only controls arity,
    // not whether the import must be present.
    "sleep-abort": abortable((ms: bigint, _signal: AbortSignal) =>
      delay(Number(ms))
    ),
  });
}

// abortable() (contracts/embedder-api.md §"Functions and async"; polyengine#241) through the
// conventions facade. Scoped per instantiation: each test gets its own
// counters/flags so they can't bleed into one another.
function instantiateAbortableGuest() {
  let abortsObserved = 0;
  let signalWellFormed = false;
  const instancePromise = instantiateFixture(guest("cancel-import"), {
    sleep: (ms: bigint) => delay(Number(ms)),
    block: (_ms: bigint) => {
      throw new Error("cancel-import abortable() tests never call `block`");
    },
    "sleep-defer": deferCancel((ms: bigint) => delay(Number(ms))),
    timers: {
      "sleep-defer": deferCancel((ms: bigint) => delay(Number(ms))),
    },
    // abortable(): this is the regression pin for the conventions facade's
    // trailing-arg forwarding (instantiate.ts "CONTRACT"). Without
    // that forwarding loop, `signal` arrives `undefined` here and this
    // listener wire-up throws on `signal.addEventListener` — the test fails
    // loudly either way.
    "sleep-abort": abortable((ms: bigint, signal: AbortSignal) => {
      signalWellFormed = signal instanceof AbortSignal;
      return new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, Number(ms));
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          abortsObserved++;
          reject(new DOMException("sleep-abort discarded", "AbortError"));
        });
      });
    }),
  });
  return {
    instancePromise,
    getAbortsObserved: () => abortsObserved,
    getSignalWellFormed: () => signalWellFormed,
  };
}

Deno.test({
  name:
    "cancellation discard: cancelInflight discards promptly — the bare-function relay preserves the ABSENCE of the brand",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateGuest();

    const start = performance.now();
    await c.exports.cancelInflight(BigInt(A23_SLOW));
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed < 400,
      `cancellation discard regression: cancelInflight(${A23_SLOW}) took ${elapsed}ms (>= 400ms) ` +
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
    "cancellation discard: cancelDefer stalls for natural resolution — the bare-function relay carries the brand",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateGuest();

    const start = performance.now();
    await c.exports.cancelDefer(BigInt(A23_SLOW));
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed >= 800,
      `cancellation discard opt-out regression: cancelDefer(${A23_SLOW}) took only ${elapsed}ms ` +
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
    "cancellation discard: cancelDeferIfc stalls for natural resolution — the INTERFACE-MEMBER relay carries the brand",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateGuest();

    const start = performance.now();
    await c.exports.cancelDeferIfc(BigInt(A23_SLOW));
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed >= 800,
      `cancellation discard opt-out regression: cancelDeferIfc(${A23_SLOW}) took only ` +
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

// ---------------------------------------------------------------------------
// abortable() (contracts/embedder-api.md §"Functions and async"; polyengine#241) through the
// conventions facade: this is the regression pin for `instantiate.ts`'s
// "CONTRACT" trailing-arg forwarding hunk. Without it, the host's
// `signal` parameter is `undefined`, the abort listener never wires up, and
// `abortsObserved` stays 0 — see the negative control in the dispatch report.
// ---------------------------------------------------------------------------

const A24_SLOW = 1200;

Deno.test({
  name:
    "abortable(): cancelAbort's AbortSignal fires on discard, well-formed, through the facade",
  ignore: !ready,
  fn: async () => {
    const { instancePromise, getAbortsObserved, getSignalWellFormed } =
      instantiateAbortableGuest();
    const c = await instancePromise;

    const start = performance.now();
    await c.exports.cancelAbort(BigInt(A24_SLOW));
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed < 400,
      `abortable() regression: cancelAbort(${A24_SLOW}) took ${elapsed}ms (>= 400ms) ` +
        `— an abortable()-branded import's cancel must still discard ` +
        `promptly, the same as an unmarked import.`,
    );

    // The abort lands a microtask after the cancel built-in returns
    // (contracts/embedder-api.md §"Functions and async") — flush a few ticks.
    await delay(20);
    assertTrue(
      getAbortsObserved() === 1,
      "abortable() regression: cancelAbort's AbortSignal never fired through the " +
        "conventions facade after its subtask was discarded. Without " +
        "instantiate.ts's CONTRACT trailing-arg forwarding, the " +
        "host's `signal` parameter is undefined and this listener never " +
        "wires up in the first place — the facade silently drops the " +
        "signal the mark exists to deliver.",
    );
    assertTrue(
      getSignalWellFormed(),
      "abortable() regression: the import received something other than a real " +
        "AbortSignal through the conventions facade — `signal instanceof " +
        "AbortSignal` was false.",
    );

    // Inert through the real composition: the store must stay healthy.
    await c.exports.ping();

    // Leak hygiene: the abort listener clears the timer on discard — no
    // stray `setTimeout` to outlive here.
  },
});

Deno.test({
  name:
    "abortable(): runAbortable completes naturally through the facade, never aborts",
  ignore: !ready,
  fn: async () => {
    const { instancePromise, getAbortsObserved } = instantiateAbortableGuest();
    const c = await instancePromise;

    const start = performance.now();
    await c.exports.runAbortable(150n);
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed >= 100,
      `runAbortable(150) took only ${elapsed}ms — expected it to await ` +
        `sleep-abort to natural completion (no cancellation on this path)`,
    );
    assertTrue(
      getAbortsObserved() === 0,
      "abortable() regression: the AbortSignal fired on a call that ran to " +
        "natural completion with no guest cancellation anywhere.",
    );
  },
});
