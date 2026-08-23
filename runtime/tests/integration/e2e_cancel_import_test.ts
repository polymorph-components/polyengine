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
import { suspending } from "@polyengine/protocol";

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

async function instantiate() {
  const imports = {
    // Plain async import: a Promise settles through the task core with no
    // JSPI involved.
    sleep: (ms: bigint) => delay(Number(ms)),
    // Sync-typed import wrapped in `suspending()` (contracts/embedder-api.md
    // §"Functions and async" amendment A1): calling it parks the guest's
    // wasm frame mid-activation until the Promise settles — the #239 A1
    // park shape.
    block: suspending((ms: bigint) => delay(Number(ms))),
  };
  return await instantiateComponent({
    plan,
    componentBytes: guestWasm,
    adapters,
    imports,
  });
}

// deno-lint-ignore no-explicit-any
type Exports = any;

const WEDGE_ASSERTION =
  "driveAsync: a resumed-activation claim was never released " +
  "(the activation neither parked, finished, nor trapped)";

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
    const component = await instantiate();
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
    const component = await instantiate();
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
    const component = await instantiate();
    const e = component.exports as Exports;

    // `start-poll-drop(hold, dropAfter)` spawns a detached task and returns
    // almost immediately — call that t=0. Per src/lib.rs `start_poll_drop`:
    //   t=0:         sleep(hold) starts (S1), polled once so it is genuinely
    //                in flight.
    //   t=dropAfter: the task wakes and DROPS S1's future -> `subtask.cancel`.
    //                This runtime's host-import subtasks have a no-op
    //                `on_cancel` (runtime/src/exec/boundary.ts, search
    //                `subtask.onCancel = () => {}`), so the cancel does NOT
    //                return promptly — it parks the guest until S1 resolves
    //                NATURALLY, i.e. at t=hold.
    //   t=hold:      the cancel returns; the task then runs its tail
    //                `sleep(hold)`.
    //   t=2*hold:    the detached task finally ends.
    // With hold=SLOW=1000, dropAfter=100: the detached task ends at t=2000.
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

    // Remaining guest time: 2*SLOW - 500 = 1500ms. Wait 1650ms (150ms
    // margin) so the detached task has provably ended before the test
    // returns.
    await delay(1650);
  },
);

Deno.test(
  "cancel-import #239: detached task races two imports, drops the loser",
  async () => {
    const component = await instantiate();
    const e = component.exports as Exports;

    // `start-race-drop(slow, fast)` spawns a detached task and returns
    // almost immediately — call that t=0. Per src/lib.rs `start_race_drop`:
    //   t=0:     both sleep(slow) and sleep(fast) start via
    //            `futures::future::select`.
    //   t=fast:  the fast sleep wins the select; the still-in-flight slow
    //            future (the loser) is dropped at the end of its scope ->
    //            `subtask.cancel`. Same no-op-`on_cancel` defect as
    //            start-poll-drop above: the cancel parks the guest until
    //            the loser resolves NATURALLY, at t=slow.
    //   t=slow:  the cancel returns; the task then runs its tail
    //            `sleep(slow)`.
    //   t=2*slow: the detached task finally ends.
    // With slow=SLOW=1000, fast=100: the detached task ends at t=2000.
    const fast = 100;
    await e["start-race-drop"](BigInt(SLOW), BigInt(fast));

    for (let i = 0; i < 5; i++) {
      await delay(50);
      await assertPing(e, `poll ${i} while start-race-drop is racing/dropping`);
    }

    // 5 polls * 50ms = 250ms elapsed. Remaining guest time: 2*SLOW - 250 =
    // 1750ms. Wait 1900ms (150ms margin) so the detached task has provably
    // ended before the test returns.
    await delay(1900);
  },
);
