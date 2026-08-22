// Permission-only regression guard, mirroring runtime/tests/sched_seed_guard_test.ts.
//
// The harness imports the same runtime scheduler module (../src/task/scheduler.ts's
// `readSeed()`) via runtime-executor.ts, and `just sched-seeds` (justfile:
// 159-162) re-runs the harness's conformance suite with
// POLYENGINE_SCHED_SEED=1 / =4242 to exercise seeded-shuffle scheduling on
// this side too. readSeed() deliberately swallows a missing-permission
// (NotCapable) error and falls back to FIFO — correct in production, but it
// means a regressed harness "test" task (deno.json) silently turns every
// sched-seeds leg on the harness side back into plain FIFO, with nothing
// else in the suite failing to reveal it.
//
// Engagement (that the scheduler actually parses and uses the seed) is
// covered on the runtime side; this test only pins that the permission
// itself is present here.

Deno.test("POLYENGINE_SCHED_SEED is readable (harness test task permission)", () => {
  try {
    Deno.env.get("POLYENGINE_SCHED_SEED");
  } catch (err) {
    throw new Error(
      "Deno.env.get(\"POLYENGINE_SCHED_SEED\") threw a permission error " +
        "(NotCapable). This means the harness \"test\" task in " +
        "harness/deno.json lost --allow-env=POLYENGINE_SCHED_SEED. The " +
        "runtime's readSeed() (runtime/src/task/scheduler.ts) deliberately " +
        "swallows this and falls back to FIFO in production, so every " +
        "`just sched-seeds` leg (justfile:159-162) that runs the harness " +
        "conformance suite is silently re-running plain FIFO instead of " +
        "seeded-shuffle scheduling.\n" +
        `Original error: ${err}`,
    );
  }
});
