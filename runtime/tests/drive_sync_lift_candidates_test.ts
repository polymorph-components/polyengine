// Pins issue #299: `driveSyncLift`'s candidate set must match the reference
// `canon_lift` sync driving loop (definitions.py, post-CM#705, lines
// 2190-2192) — `{ t for t in inst.threads if t.ready() }`, with NO exclusion
// of `inst.exclusiveThread`. A stale pre-CM#705 exclusion would wrongly trap
// "deadlock" on a ready thread that happens to be the exclusive thread.
import { assertEq } from "./support/asserts.ts";
import { driveSyncLift } from "../src/task/scheduler.ts";

Deno.test("driveSyncLift resumes a ready thread even if it is inst.exclusiveThread", () => {
  let resumed = false;
  const exclusiveThread = {
    ready: () => true,
    waiting: () => false,
    resume: () => {
      resumed = true;
      task.state = "resolved";
    },
    task: null as unknown,
  };

  const task = {
    state: "started",
    inst: {
      threads: [exclusiveThread],
      exclusiveThread, // same object: must NOT be excluded from candidates
    },
  };

  driveSyncLift(task);

  assertEq(resumed, true);
  assertEq(task.state, "resolved");
});
