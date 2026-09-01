// The `SuspensionPoint` <-> `Store.tick` <-> `driveAsync` handshake.
//
// Site 1 (`sync-start-call` parking the caller's wasm activation)
// is the first *lit* suspension site, so this handshake had never executed
// before it existed. It stalled: `driveAsync` serviced ONE parked thread by
// awaiting its promise, but a thread parked on a promising-wrapped nested
// activation only settles once that activation's own suspension points have
// been resumed -- which is `Store.tick`'s job, i.e. the very loop that was
// blocked. The result was a pure-microtask stall: no trap, no rejection, just
// an await nothing would ever settle ("Promise resolution is still pending but
// the event loop has already resolved").
//
// This pins the fix by running the component that exposed it. It drives
// jspi mode EXPLICITLY (`jspi: true`) so the pin holds even for embedders
// that force the mode; auto-detection reaches the
// same mode for this component by itself.
import { assertEquals } from "./asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";

const root = new URL("../../../", import.meta.url);

async function readIfPresent(rel: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    return null;
  }
}

// Same skip-when-absent discipline as tests/integration/e2e_suite_test.ts:
// this pin needs both the built shim and the generated corpus.
const shimWasm = await readIfPresent(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
);
const componentWasm = await readIfPresent(
  "harness/generated/async/async-calls-sync.0.wasm",
);
// This component's guest asserts that each subtask's RETURNED value equals its
// subtask index (async-calls-sync.wast line 183). That value is `$AsyncInner`'s
// `$counter`, handed out in the order the `blocking-call` bodies first run --
// i.e. the order in which BACKPRESSURED tasks are released. That order is only
// pinned under the reference's DETERMINISTIC_PROFILE (definitions.py:1373),
// which is exactly our default FIFO policy; `Store.tick` (line 603) otherwise
// picks with `random.choice`.
//
// `POLYENGINE_SCHED_SEED` deliberately explores schedules BEYOND that profile, so under
// a seed this guest can legitimately observe subtask 5 taking counter 4 and
// execute its own `unreachable`. That is the component's profile-dependent
// assumption failing, not an engine fault -- so these pins are scoped to the
// deterministic profile, where the handshake they exist to protect is fully
// exercised. (The deadlock pins next door carry no such assumption and DO run
// under seeds.)
const seeded = (() => {
  try {
    return (Deno.env.get("POLYENGINE_SCHED_SEED") ?? "") !== "";
  } catch {
    return false;
  }
})();
if (seeded) {
  console.warn(
    "SKIP jspi handshake: POLYENGINE_SCHED_SEED explores schedules beyond the " +
      "deterministic profile this component's guest assumes",
  );
}
const ready = shimWasm !== null && componentWasm !== null && !seeded;
if (!ready) {
  console.warn(
    "SKIP jspi handshake: missing " +
      (shimWasm === null
        ? "translator_shim.wasm (cargo build -p translator-shim --release " +
          "--target wasm32-unknown-unknown)"
        : "harness/generated (cargo run -p testgen)"),
  );
}

async function instantiate() {
  const translator = await Translator.create(shimWasm!);
  const bytes = componentWasm!;
  const { plan, adapters } = translator.translate(bytes);
  return await instantiateComponent({
    plan,
    componentBytes: bytes,
    adapters,
    jspi: true,
  });
}

// A stall in this handshake does not throw -- it simply never settles. Deno
// fails such a test with "Promise resolution is still pending", so awaiting the
// call IS the assertion; the returned value pins that it resolved correctly
// rather than merely resolving.
Deno.test({ name: "jspi handshake: a parked caller is resumed by the scheduler (run1)", ignore: !ready, fn: async () => {
  const handle = await instantiate();
  const run1 = handle.exports.run1 as () => Promise<unknown> | unknown;
  assertEquals(await run1(), 42);
} });

Deno.test({ name: "jspi handshake: a parked caller is resumed by the scheduler (run2)", ignore: !ready, fn: async () => {
  const handle = await instantiate();
  const run2 = handle.exports.run2 as () => Promise<unknown> | unknown;
  assertEquals(await run2(), 42);
} });

// Both exports on ONE instance: the second call must not inherit a wedged
// scheduler (a stale ambient claim or a memoized await tag) from the first.
Deno.test({ name: "jspi handshake: consecutive parked calls on one instance", ignore: !ready, fn: async () => {
  const handle = await instantiate();
  assertEquals(await (handle.exports.run1 as () => unknown)(), 42);
  assertEquals(await (handle.exports.run2 as () => unknown)(), 42);
} });
