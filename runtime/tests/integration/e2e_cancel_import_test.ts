// Issue #239 end-to-end regression: `driveAsync` (runtime/src/exec/boundary.ts)
// used to hold a store-wide scheduling gate (`Store.pendingResumptions`)
// across an await bounded only by the HOST's answer, whenever two drivers
// were live on the same store and one was parked in its awaiting-race. The
// second driver spun at the top of its own loop and died in ~311ms with:
//
//   driveAsync: a resumed-activation claim was never released (the
//   activation neither parked, finished, nor trapped)
//
// `runtime/tests/same_store_driver_test.ts` pins the store-level unit shape
// of the fix. This file is the end-to-end proof against a real wit-bindgen
// guest (`examples/guests/cancel-import`), covering every shape the guest
// models: two concurrent export calls, a detached task parked mid-frame with
// no export call outstanding, and a detached task cancelling an in-flight
// async import (`subtask.cancel` via wit-bindgen's drop-to-cancel path).
//
// Requires build artifacts (both produced from source in this repo):
//   - target/wasm32-unknown-unknown/release/translator_shim.wasm
//       cargo build -p translator-shim --release --target wasm32-unknown-unknown
//   - examples/guests/build/cancel-import.component.wasm
//       ./examples/build.sh

import { assertEq } from "../support/asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";
import { abortable, deferCancel, suspending } from "@polyengine/protocol";

const root = new URL("../../../", import.meta.url);

async function readArtifact(rel: string, hint: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    throw new Error(`missing build artifact ${rel} — run: ${hint}`);
  }
}

const shimWasm = await readArtifact(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  "cargo build -p translator-shim --release --target wasm32-unknown-unknown",
);
const guestWasm = await readArtifact(
  "examples/guests/build/cancel-import.component.wasm",
  "./examples/build.sh",
);

const translator = await Translator.create(shimWasm);
const { plan, adapters } = translator.translate(guestWasm);

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Scoped per instantiation (per test), per the dispatch: abortable()'s `abortable()`
// import must observe the abort exactly once per discard and never on a
// natural-completion path, and giving each instance its own counter keeps
// concurrently-run tests from bleeding into one another.
async function instantiate() {
  let abortsObserved = 0;
  const imports = {
    // Plain async import: a Promise settles through the task core with no
    // JSPI involved.
    sleep: (ms: bigint) => delay(Number(ms)),
    // Sync-typed import wrapped in `suspending()` (contracts/embedder-api.md
    // §"Functions and async" §"Functions and async"): calling it parks the guest's
    // wasm frame mid-activation until the Promise settles — the #239 suspending mark
    // park shape.
    block: suspending((ms: bigint) => delay(Number(ms))),
    // cancellation discard opt-out (contracts/embedder-api.md §"Functions and async"): branding an
    // async-typed import `deferCancel` keeps the pre-cancellation discard run-to-completion
    // behavior on cancel, per-declaration.
    "sleep-defer": deferCancel((ms: bigint) => delay(Number(ms))),
    // Interface-scoped sibling, exercising the raw executor's brand read at
    // an interface-member leaf (`buildLoweredImport` path walk).
    timers: {
      "sleep-defer": deferCancel((ms: bigint) => delay(Number(ms))),
    },
    // abortable() (contracts/embedder-api.md §"Functions and async"): branding an async-typed
    // import `abortable()` hands the host a per-call `AbortSignal` appended
    // after the WIT-declared `ms` param, aborted one microtask after a guest
    // cancellation discards the call. The listener clears the timer, so a
    // discard never leaves a stray `setTimeout` running — no trailing wait
    // needed for it in the tests below.
    "sleep-abort": abortable((ms: bigint, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, Number(ms));
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          abortsObserved++;
          reject(new DOMException("sleep-abort discarded", "AbortError"));
        });
      })
    ),
  };
  const component = await instantiateComponent({
    plan,
    componentBytes: guestWasm,
    adapters,
    imports,
  });
  return { component, getAbortsObserved: () => abortsObserved };
}

// deno-lint-ignore no-explicit-any
type Exports = any;

const WEDGE_ASSERTION =
  "driveAsync: a resumed-activation claim was never released " +
  "(the activation neither parked, finished, nor trapped)";

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function assertPing(e: Exports, where: string): Promise<void> {
  let value: unknown;
  try {
    value = await e.ping();
  } catch (err) {
    throw new Error(
      `issue #239 regression at ${where}: ping() threw instead of ` +
        `resolving to 42 — this is exactly the wedge described by the ` +
        `assertion "${WEDGE_ASSERTION}". Original error: ${err}`,
    );
  }
  assertEq(
    value,
    42,
    `issue #239 regression at ${where}: ping() resolved to ${value}, not ` +
      `42 — the store is wedged (see "${WEDGE_ASSERTION}")`,
  );
}

// "Slow" host-import duration shared by every test below. Must comfortably
// outlast a single ping poll (started at +50ms) plus the ~311ms/10,000-hop
// spin the pre-fix wedge needs to die — 1000ms leaves ~650ms of margin over
// that spin once the first poll lands, which the negative control below
// confirms is still enough to trip the assertion.
const SLOW = 1000;

Deno.test(
  "cancel-import #239: two concurrent export calls — blockFor + ping polls",
  async () => {
    const { component } = await instantiate();
    const e = component.exports as Exports;

    // Start a slow, mid-frame-parking export call WITHOUT awaiting it: this
    // is the reduced form of the wedge — a second driver (ping) must be able
    // to make progress on the same store while the first driver (blockFor)
    // is parked awaiting the host's answer.
    //
    // Timeline (relative to this call): block-for(SLOW) parks the guest
    // frame on `block` from t=0 to t=SLOW=1000. `blockFor` is awaited below,
    // so nothing outlives this test — no arithmetic needed beyond "await it".
    const slow = e["block-for"](BigInt(SLOW)) as Promise<void>;

    for (let i = 0; i < 5; i++) {
      await delay(50);
      await assertPing(e, `poll ${i} while blockFor(${SLOW}) is outstanding`);
    }

    // Let the slow call finish so nothing leaks past the test.
    await slow;
  },
);

Deno.test(
  "cancel-import #239: detached task parks mid-frame, no export call outstanding",
  async () => {
    const { component } = await instantiate();
    const e = component.exports as Exports;

    // `start-block` spawns a detached task and returns almost immediately
    // (the spawn does not block the export's own completion) — call that
    // t=0. Per src/lib.rs `start_block`: the detached task first
    // `sleep(300).await`s, THEN calls `block(SLOW)`, parking the guest
    // frame from t=300 to t=300+SLOW=1300. The detached task ends at t=1300.
    //
    // The polling window must straddle t=300 — polls that only run before
    // the park (as an earlier revision of this test did, +50..+250ms) never
    // observe the parked-with-no-export-call-outstanding shape at all. Poll
    // every 50ms from +50ms out to +700ms (14 polls) so several land solidly
    // inside the parked window (300..1300).
    await e["start-block"](BigInt(SLOW));

    for (let i = 0; i < 14; i++) {
      await delay(50);
      const elapsed = (i + 1) * 50;
      await assertPing(
        e,
        `poll ${i} at t+${elapsed}ms after start-block(${SLOW}) ` +
          `(parked window is 300..1300)`,
      );
    }

    // 14 polls * 50ms = 700ms elapsed. Remaining guest time: 1300 - 700 =
    // 600ms. Wait 750ms (150ms margin) so the detached task has provably
    // ended before the test returns.
    await delay(750);
  },
);

Deno.test(
  "cancel-import #239: detached task cancels an in-flight import (subtask.cancel)",
  async () => {
    const { component } = await instantiate();
    const e = component.exports as Exports;

    // `start-poll-drop(hold, dropAfter)` spawns a detached task and returns
    // almost immediately — call that t=0. Per src/lib.rs `start_poll_drop`:
    //   t=0:         sleep(hold) starts (S1), polled once so it is genuinely
    //                in flight.
    //   t=dropAfter: the task wakes and DROPS S1's future -> `subtask.cancel`.
    //                `sleep` is undecorated, so this gets the cancellation discard default
    //                (contracts/embedder-api.md §"Functions and async"): discard.
    //                The subtask resolves CANCELLED_BEFORE_RETURNED at once
    //                and the cancel returns PROMPTLY, at t=dropAfter — it no
    //                longer waits for S1 to resolve naturally.
    //   t=dropAfter: the task then runs its tail `sleep(hold)`.
    //   t=dropAfter+hold: the detached task finally ends.
    // With hold=SLOW=1000, dropAfter=100: the detached task ends at t=1100.
    // (S1's host timer still fires at t=hold=1000 regardless — discard is
    // about delivery, not execution — but nothing observes it.)
    const dropAfter = 100;
    await e["start-poll-drop"](BigInt(SLOW), BigInt(dropAfter));

    for (let i = 0; i < 5; i++) {
      await delay(50);
      await assertPing(e, `poll ${i} while start-poll-drop's subtask is live`);
    }

    // `dropAfter` (100ms) has elapsed by ~250ms in; keep polling across the
    // cancellation point. 10 polls total * 50ms = 500ms elapsed.
    for (let i = 0; i < 5; i++) {
      await delay(50);
      await assertPing(e, `poll ${i} after start-poll-drop's cancel point`);
    }

    // Remaining guest time under cancellation discard: dropAfter + hold - 500 = 1100 - 500 =
    // 600ms. The old pre-cancellation discard wait (1650ms) still comfortably covers that —
    // over-waiting is fine, kept as-is rather than trimmed.
    await delay(1650);
  },
);

Deno.test(
  "cancel-import #239: detached task races two imports, drops the loser",
  async () => {
    const { component } = await instantiate();
    const e = component.exports as Exports;

    // `start-race-drop(slow, fast)` spawns a detached task and returns
    // almost immediately — call that t=0. Per src/lib.rs `start_race_drop`:
    //   t=0:     both sleep(slow) and sleep(fast) start via
    //            `futures::future::select`.
    //   t=fast:  the fast sleep wins the select; the still-in-flight slow
    //            future (the loser) is dropped at the end of its scope ->
    //            `subtask.cancel`. `sleep` is undecorated, so this gets the
    //            cancellation discard default: discard, resolving CANCELLED_BEFORE_RETURNED
    //            at once — the cancel returns PROMPTLY at t=fast, no longer
    //            waiting for the loser to resolve naturally.
    //   t=fast:  the task then runs its tail `sleep(slow)`.
    //   t=fast+slow: the detached task finally ends.
    // With slow=SLOW=1000, fast=100: the detached task ends at t=1100.
    const fast = 100;
    await e["start-race-drop"](BigInt(SLOW), BigInt(fast));

    for (let i = 0; i < 5; i++) {
      await delay(50);
      await assertPing(e, `poll ${i} while start-race-drop is racing/dropping`);
    }

    // 5 polls * 50ms = 250ms elapsed. Remaining guest time under cancellation discard:
    // fast + slow - 250 = 1100 - 250 = 850ms. The old pre-cancellation discard wait (1900ms)
    // still comfortably covers that — kept as-is rather than trimmed.
    await delay(1900);
  },
);

// ---------------------------------------------------------------------------
// cancellation discard (contracts/embedder-api.md §"Functions and async"; polyengine#241): the
// per-declaration cancel-discard opt-out, proved at the raw exec layer.
// `cancel-inflight`/`cancel-defer`/`cancel-defer-ifc` are a straight-line
// export (no detached task, no ping-polling): poll `sleep`/`sleep-defer`
// once, drop it, return. What's under test is how long THIS export call
// itself takes.
// ---------------------------------------------------------------------------

// Long enough that "returned promptly" (< 400ms) and "waited for natural
// resolution" (>= 800ms) are unambiguous on typical CI timing jitter.
const A23_SLOW = 1200;

Deno.test(
  "cancel-import cancellation discard: discard-by-default returns promptly, not after natural resolution",
  async () => {
    const { component } = await instantiate();
    const e = component.exports as Exports;

    const start = performance.now();
    await e["cancel-inflight"](BigInt(A23_SLOW));
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed < 400,
      `cancellation discard regression: cancel-inflight(${A23_SLOW}) took ${elapsed}ms (>= 400ms) — ` +
        `an undecorated import's cancel must discard and resolve ` +
        `CANCELLED_BEFORE_RETURNED promptly (contracts/embedder-api.md ` +
        `§"Functions and async"), not stall until the dropped subtask's host promise ` +
        `settles naturally. A regression here means the discard path in ` +
        `createLoweredImport's async arm (runtime/src/exec/boundary.ts) has ` +
        `been lost and cancellation is back to run-to-completion for every ` +
        `import.`,
    );

    // Leak hygiene: discard is about DELIVERY, not EXECUTION — the dropped
    // host timer still fires at ~A23_SLOW regardless. Outlive it before the
    // test returns (the sanitizer runs with --trace-leaks).
    await delay(A23_SLOW + 100);
  },
);

Deno.test(
  "cancel-import cancellation discard: deferCancel() opt-out still runs the cancelled import to completion",
  async () => {
    const { component } = await instantiate();
    const e = component.exports as Exports;

    const start = performance.now();
    await e["cancel-defer"](BigInt(A23_SLOW));
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed >= 800,
      `cancellation discard opt-out regression: cancel-defer(${A23_SLOW}) took only ${elapsed}ms ` +
        `— an import branded deferCancel() (protocol/src/defer_cancel.ts) must ` +
        `keep the pre-cancellation discard behavior: cancelling it answers BLOCKED and the ` +
        `guest waits for the natural result, so this export should not ` +
        `return before the host timer it dropped actually settles.`,
    );
    assertTrue(
      elapsed < 5000,
      `cancel-defer(${A23_SLOW}) took ${elapsed}ms — expected it to complete, ` +
        `not hang indefinitely`,
    );
  },
);

Deno.test(
  "cancel-import cancellation discard: ping is healthy after both discard and deferCancel cancellations",
  async () => {
    // A fresh instance isn't the point here — the point is that neither
    // cancellation path (discard, nor deferCancel-parked) leaves the store
    // in a bad state (`store.hostFailure`-class wedge) for a THIRD call on
    // the same instance to trip over.
    const { component } = await instantiate();
    const e = component.exports as Exports;

    await e["cancel-inflight"](BigInt(A23_SLOW));
    await e["cancel-defer"](BigInt(A23_SLOW));
    await assertPing(e, "after cancel-inflight + cancel-defer");

    // Outlive cancel-inflight's discarded host timer before returning.
    await delay(A23_SLOW + 100);
  },
);

// ---------------------------------------------------------------------------
// abortable() (contracts/embedder-api.md §"Functions and async"; polyengine#241): the
// `abortable()` mark hands the host a per-call `AbortSignal`, aborted one
// microtask after a guest cancellation discards the call — proved at the raw
// exec layer against a real wit-bindgen guest.
// ---------------------------------------------------------------------------

// Long enough that "returned promptly" (< 400ms) and "ran to natural
// completion" (>= 100ms) are unambiguous on typical CI timing jitter.
const A24_SLOW = 1200;

Deno.test(
  "cancel-import abortable(): abortable() import observes the abort when its call is discarded",
  async () => {
    const { component, getAbortsObserved } = await instantiate();
    const e = component.exports as Exports;

    const start = performance.now();
    await e["cancel-abort"](BigInt(A24_SLOW));
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed < 400,
      `abortable() regression: cancel-abort(${A24_SLOW}) took ${elapsed}ms (>= 400ms) — ` +
        `an abortable()-branded import's cancel must still discard promptly ` +
        `, the same as an unmarked import; abortable() only adds the signal.`,
    );

    // The abort is scheduled a microtask after the cancel built-in returns
    // (contracts/embedder-api.md §"Functions and async"), not synchronously inside
    // it — flush a few ticks before checking that the host actually
    // observed it. A regression here means the host never learned its
    // result was discarded and the dropped timer just kept running
    // unaborted (the exact gap abortable() closes over plain cancellation discard discard).
    await delay(20);
    assertEq(
      getAbortsObserved(),
      1,
      "abortable() regression: the abortable()-branded import's AbortSignal never " +
        "fired after its subtask was discarded by the guest's cancellation " +
        "— cancel-import's `sleep-abort` should have had its AbortSignal " +
        "aborted exactly once.",
    );

    // The AbortError rejection this provokes is a late settlement on an
    // already-cancelled subtask (cancellation discard's resolved-subtask guards) — it must
    // stay inert through the real composition, not surface as a store
    // failure that wedges a later call.
    await assertPing(e, "after cancel-abort's discard+abort");

    // Leak hygiene: the abort listener clears the timer on discard, so
    // there is no stray `setTimeout` to outlive here (unlike cancellation discard's plain
    // discard, whose dropped timer keeps running to natural completion).
  },
);

Deno.test(
  "cancel-import abortable(): abortable() import run to natural completion never aborts",
  async () => {
    const { component, getAbortsObserved } = await instantiate();
    const e = component.exports as Exports;

    const start = performance.now();
    await e["run-abortable"](150n);
    const elapsed = performance.now() - start;

    assertTrue(
      elapsed >= 100,
      `run-abortable(150) took only ${elapsed}ms — expected it to await ` +
        `sleep-abort to natural completion (no cancellation on this path)`,
    );
    assertEq(
      getAbortsObserved(),
      0,
      "abortable() regression: the abortable()-branded import's AbortSignal fired " +
        "on a call that ran to natural completion with no guest " +
        "cancellation anywhere — the signal must fire only on discard.",
    );
  },
);

// ---------------------------------------------------------------------------
// Issue #280: an activation this driver put in flight, abandoned mid-hop.
//
// The export driver's exit predicate was "the task resolved AND no thread OF
// THIS TASK is mid-wasm-call". A BACKGROUND task's callback activation —
// resumed by this driver's own `tick`, hop-parked in `store.awaiting` while
// the promising entry settles — is not a thread of this task, so `done()`
// went true and the driver walked away from work it had just started.
// Nothing else owned it: the settlement pump arms only on outstanding real
// host calls (`hasRealHostCall`), and the host call whose settlement caused
// the resumption is gone from `pendingHostCalls` by then. The activation sat
// in `store.awaiting` until some unrelated later call happened to drive the
// store — issue #280's trace `#25 EXIT-done awaiting=1`, reproduced verbatim
// by the pre-fix runtime here.
// ---------------------------------------------------------------------------

Deno.test(
  "cancel-import #280: an export driver may not exit leaving a hop-parked activation of another task",
  async () => {
    // Every `sleep` call hands back a promise this test settles by hand, so
    // the settlement lands exactly where the issue puts it: on a microtask
    // inside a LATER export call's driver.
    const gates: Array<() => void> = [];
    const imports = {
      sleep: (_ms: bigint) => new Promise<void>((r) => gates.push(() => r())),
      block: suspending((ms: bigint) => delay(Number(ms))),
      "sleep-defer": deferCancel((ms: bigint) => delay(Number(ms))),
      timers: { "sleep-defer": deferCancel((ms: bigint) => delay(Number(ms))) },
      "sleep-abort": abortable((ms: bigint, _signal: AbortSignal) =>
        delay(Number(ms))
      ),
    };
    const component = await instantiateComponent({
      plan,
      componentBytes: guestWasm,
      adapters,
      imports,
    });
    const e = component.exports as Exports;
    const store = component.componentInstances[0].store;

    // `start-poll-drop` returns as soon as its detached task parks, so from
    // here on the guest task is BACKGROUND: resolved, no driver of its own.
    // Per src/lib.rs it issues S1 (polled once, in flight), then awaits S2.
    await e["start-poll-drop"](1n, 1n);
    assertEq(gates.length, 2, "S1 and S2 should both be in flight");

    // Retire S1 so no real host call is left to arm the settlement pump for
    // the window under test (the guest's own drop of S1 is a discard, which
    // is about delivery, not about the host promise).
    gates[0]();
    await delay(20);

    // S2 settles with no export call outstanding: the pump drives it, the
    // detached task drops S1 and issues S3. S3 is now the ONLY host call.
    gates[1]();
    await delay(20);
    assertEq(gates.length, 3, "the detached task should be parked on S3");

    // THE WINDOW. `ping()` starts the second export call; resolving S3
    // synchronously right after makes it settle on a microtask while that
    // driver is live. The driver resumes the background task's callback
    // activation — a promising entry, so it hop-parks — and the activation's
    // tail (which retires the resumed task) is the driver's to see land.
    const pong = e.ping() as Promise<number>;
    gates[2]();
    assertEq(await pong, 42, "ping must still answer");

    // Nothing else drives the store from here: no host call is outstanding,
    // so the settlement pump does not arm. A hop still in `store.awaiting`
    // after this point is owned by nobody.
    await delay(50);
    assertTrue(
      store.awaiting.size === 0,
      `issue #280 regression: ping()'s driver exited leaving ` +
        `${store.awaiting.size} hop-parked activation(s) of a background ` +
        `task in store.awaiting, with no host call outstanding to arm the ` +
        `settlement pump — the trace's "EXIT-done ... awaiting=1". The ` +
        `driver must not report done while any thread, of any task, is ` +
        `hop-parked.`,
    );

    // Leak hygiene: nothing is waiting on the remaining gate, but settle it
    // so no promise is left dangling behind the test.
    for (const g of gates) g();
    await delay(20);
  },
);
