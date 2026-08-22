// Regression guard for a defect class where `just sched-seeds` (justfile:
// 159-162) silently degrades to plain FIFO reruns instead of exercising
// seeded-shuffle scheduling.
//
// `readSeed()` in ../src/task/scheduler.ts (~line 227) reads
// `POLYENGINE_SCHED_SEED` from the environment, and *deliberately* catches
// the Deno `NotCapable` permission error and falls back to FIFO ("never fail
// to run because we could not read a debugging knob"). That fallback is
// correct production behavior — but it also means that if the runtime
// "test" task in deno.json ever loses `--allow-env=POLYENGINE_SCHED_SEED`,
// every `sched-seeds` leg keeps passing while silently running FIFO instead
// of seeded-shuffle. No other assertion in the suite would ever fail: the
// tests would just get a scheduling order they didn't ask for.
//
// This test pins two things:
//   1. The permission is actually present (so `readSeed()` isn't silently
//      neutered by deno.json regressing).
//   2. When it is present and a valid integer is supplied, the scheduler
//      module actually engaged it at import time (not just that the read
//      succeeded).
//
// This file gets its own isolate per `deno test` file, so the scheduler
// module here has never had `schedulerSeedForTesting` called on it — the
// snapshot below reflects only what `readSeed()` computed from the real
// environment at import time.

import { assertEq } from "./support/asserts.ts";
import { schedulerSeedSnapshotForTesting } from "../src/task/scheduler.ts";

Deno.test("POLYENGINE_SCHED_SEED is readable and engaged by the scheduler", () => {
  let raw: string | undefined;
  try {
    raw = Deno.env.get("POLYENGINE_SCHED_SEED");
  } catch (err) {
    throw new Error(
      "Deno.env.get(\"POLYENGINE_SCHED_SEED\") threw a permission error " +
        "(NotCapable). This means the runtime \"test\" task in " +
        "runtime/deno.json lost --allow-env=POLYENGINE_SCHED_SEED. " +
        "readSeed() (src/task/scheduler.ts) deliberately swallows this " +
        "error and falls back to FIFO in production — which means every " +
        "`just sched-seeds` leg (justfile:159-162) is silently re-running " +
        "plain FIFO instead of seeded-shuffle scheduling, with no other " +
        "test failure to reveal it.\n" +
        `Original error: ${err}`,
    );
  }

  const snapshot = schedulerSeedSnapshotForTesting();

  if (raw === undefined || raw === "") {
    // Unset/empty: readSeed() must resolve to FIFO.
    assertEq(snapshot, null, "expected FIFO (null) seed when env var unset");
    return;
  }

  const parsed = Math.trunc(Number(raw)) >>> 0;
  assertEq(
    snapshot,
    parsed,
    "scheduler module did not pick up POLYENGINE_SCHED_SEED from the " +
      "environment at import time — readSeed() should have parsed it",
  );
});
