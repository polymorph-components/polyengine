// The parking kernel, unit level (io.ts): Pollable readiness/wake
// semantics, the timer constructor, and poll's fast-path/park split — no
// component involved (block/poll are @suspending-marked, but the marker
// only matters at the wasm boundary; direct JS calls are plain).
// The through-a-real-guest-frame pins live in blocking_guest_test.ts.

import { assertEq, assertTrue } from "./asserts.ts";
import { poll, Pollable } from "../src/io.ts";

const nowNs = (): bigint => BigInt(Math.round(performance.now() * 1e6));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.test("kernel: the default pollable is always ready and block() is synchronous", () => {
  const p = new Pollable();
  assertEq(p.ready(), true);
  // Sync fast path: no Promise, no park.
  assertEq(p.block(), undefined);
});

Deno.test("kernel: a timer pollable parks until its deadline", async () => {
  const p = Pollable.timer(nowNs() + 60_000_000n, nowNs); // 60ms
  assertEq(p.ready(), false, "not ready before the deadline");
  const t0 = performance.now();
  const parked = p.block();
  assertTrue(parked instanceof Promise, "unready block() returns a Promise");
  await parked;
  const elapsed = performance.now() - t0;
  assertTrue(elapsed >= 45, `parked ${elapsed}ms; expected ~60ms`);
  assertEq(p.ready(), true, "ready after the deadline");
  assertEq(p.block(), undefined, "block() is sync once ready");
});

Deno.test("kernel: an externally-woken pollable (the promise-swap producer shape)", async () => {
  // The interop seam a sockets provider uses: readiness over a queue,
  // wake by settling the current epoch's promise and re-arming.
  const queue: number[] = [];
  let wake!: () => void;
  let epoch = new Promise<void>((r) => (wake = r));
  const arrived = () => {
    const w = wake;
    epoch = new Promise<void>((r) => (wake = r));
    w();
  };
  const p = new Pollable(() => queue.length > 0, () => epoch);

  assertEq(p.ready(), false);
  const parked = p.block() as Promise<void>;
  let settled = false;
  parked.then(() => (settled = true));
  await sleep(20);
  assertEq(settled, false, "still parked with an empty queue");
  queue.push(42);
  arrived();
  await parked;
  assertEq(p.ready(), true);
});

Deno.test("kernel: poll takes the sync fast path when anything is ready", () => {
  const ready = new Pollable();
  const never = new Pollable(() => false, () => new Promise(() => {}));
  const result = poll([never, ready, never]);
  assertTrue(!(result instanceof Promise), "fast path returns synchronously");
  assertEq(JSON.stringify(result), "[1]");
});

Deno.test("kernel: poll parks and wakes with the ready index", async () => {
  const never = new Pollable(() => false, () => new Promise(() => {}));
  const timer = Pollable.timer(nowNs() + 40_000_000n, nowNs); // 40ms
  const t0 = performance.now();
  const result = poll([never, timer]);
  assertTrue(result instanceof Promise, "nothing ready: poll parks");
  assertEq(JSON.stringify(await result), "[1]");
  assertTrue(performance.now() - t0 >= 30, "woke no earlier than the timer");
});

Deno.test("kernel: poll on an empty list traps (unbranded throw)", () => {
  let raised: unknown;
  try {
    poll([]);
  } catch (e) {
    raised = e;
  }
  assertTrue(raised instanceof Error, `expected a throw, got ${raised}`);
  assertTrue(!(raised instanceof Promise), "trap is synchronous");
});

Deno.test({
  name:
    "kernel: a timer's wait re-arms after an early fire (no resolved-promise spin)",
  // The re-armed 5ms sleep (and nothing to cancel it through the WIT
  // surface) outlives the test on purpose; timers are fire-and-forget.
  sanitizeOps: false,
  fn: async () => {
    // Force an early fire deterministically with an injected clock: the
    // sleep is computed from `nowNs` (5ms) but the clock never advances,
    // so the chunk ends with `ready()` still false — the shape of timer
    // slop and of the setTimeout ceiling clamp. Pre-fix, the armed promise
    // was cached forever: the second wait() returned it already-settled
    // and block()'s re-check loop degenerated to a hot microtask spin.
    const frozen = 1_000_000n;
    const p = Pollable.timer(frozen + 5_000_000n, () => frozen); // +5ms, clock frozen
    await p.waitPromise(); // first arm fires with ready() still false
    assertEq(p.ready(), false, "clock is frozen: still unready");
    const second = p.waitPromise();
    let settled = false;
    second.then(() => (settled = true));
    await sleep(0); // drain microtasks: a cached resolved promise settles here
    assertEq(settled, false, "second wait() is a fresh, pending sleep");
  },
});

Deno.test({
  name:
    "kernel: a far deadline sleeps in chunks instead of spinning on the clamp",
  // The in-flight ceiling-sized chunk sleep outlives the test on purpose.
  sanitizeOps: false,
  fn: async () => {
    // Past the ~2^31-1 ms setTimeout ceiling engines clamp the delay to
    // ~0. Pre-fix (clamp + cached arm) the wait was permanently settled a
    // tick after the first arm — block()/poll() then spun the microtask
    // queue for the full 60 days. Post-fix each chunk is a real sleep, so
    // the wait promise is still pending well after the clamp would have
    // fired. (60 days keeps Number(bigint) exact; u64-sentinel deadlines
    // take the same path via Math.min.)
    const farNs = nowNs() + 60n * 24n * 3600n * 1_000_000_000n; // +60 days
    const p = Pollable.timer(farNs, nowNs);
    assertEq(p.ready(), false);
    const wait = p.waitPromise();
    let settled = false;
    wait.then(() => (settled = true));
    await sleep(30); // >> the ~1ms clamp fire
    assertEq(settled, false, "far-deadline wait is still parked after 30ms");
  },
});
