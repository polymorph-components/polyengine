// wasi:clocks@0.2 + wasi:clocks@0.3 — monotonicity, the union-provider
// shape (contracts/embedder-api.md §"Version canonicalization"), and
// `waitUntil`/`waitFor` parking through the shared timer kernel (io.ts
// `Pollable.timer`/`block`; wasi-clocks/clocks.wit monotonic-clock
// `wait-until` MUST NOT complete before the given instant, `wait-for`
// MUST wait the entire duration).

import { assertEq, assertTrue } from "./asserts.ts";
import { clocks } from "../src/clocks.ts";

const CEILING_MS = 2 ** 31 - 1; // io.ts TIMER_CHUNK_MAX_MS

type Mono03 = {
  waitUntil(when: bigint): Promise<void>;
  waitFor(ns: bigint): Promise<void>;
};

interface FakeTimers {
  queue: { delayMs: number; fire: () => void }[];
  restore: () => void;
}

/** Replaces `globalThis.setTimeout` with a queue capture: no real timer is
 * ever scheduled, so tests control firing/clock-advance deterministically
 * and leave nothing running afterward (no sanitizer opt-outs needed). */
function fakeTimers(): FakeTimers {
  const queue: { delayMs: number; fire: () => void }[] = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: () => void, delayMs = 0) => {
    queue.push({ delayMs, fire: cb });
    return 0;
  }) as unknown as typeof globalThis.setTimeout;
  return {
    queue,
    restore: () => {
      globalThis.setTimeout = original;
    },
  };
}

/** Fires the sole queued timer and drains the microtask chain it triggers
 * (the fired `setTimeout` resolve -> `Pollable`'s re-check -> a possible
 * re-arm, which queues a fresh entry synchronously within that chain). */
async function fire(fq: FakeTimers): Promise<void> {
  const [item] = fq.queue.splice(0, 1);
  item.fire();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// { name, start } starts either `waitUntil` or `waitFor` for the given
// relative offset from `now` (an absolute instant for waitUntil, a bare
// duration for waitFor) — the shared test bodies below run once per method.
const methods: {
  name: "waitUntil" | "waitFor";
  start: (mono: Mono03, now: bigint, offsetNs: bigint) => Promise<void>;
}[] = [
  { name: "waitUntil", start: (m, now, off) => m.waitUntil(now + off) },
  { name: "waitFor", start: (m, _now, off) => m.waitFor(off) },
];

Deno.test("clocks: monotonic-clock@0.2 now() is non-decreasing", () => {
  const { imports } = clocks();
  const mono = imports["wasi:clocks/monotonic-clock@0.2"] as { now(): bigint };
  const a = mono.now();
  const b = mono.now();
  assertTrue(b >= a, "successive now() calls never decrease");
});

Deno.test("clocks: wall-clock@0.2 now() returns seconds+nanoseconds with ns < 1e9", () => {
  const { imports } = clocks();
  const wall = imports["wasi:clocks/wall-clock@0.2"] as {
    now(): { seconds: bigint; nanoseconds: number };
  };
  const t = wall.now();
  assertTrue(typeof t.seconds === "bigint");
  assertTrue(t.nanoseconds < 1_000_000_000);
});

Deno.test("clocks@0.3: the union provider exposes both drafts' functions on one provider", () => {
  const { imports } = clocks();
  const mono03 = imports["wasi:clocks/monotonic-clock@0.3"] as Record<
    string,
    unknown
  >;
  // iroh/experiment-mosh family:
  assertTrue(typeof mono03.waitFor === "function", "waitFor present");
  // polymorph-websocket family:
  assertTrue(typeof mono03.now === "function", "now present");
  assertTrue(typeof mono03.waitUntil === "function", "waitUntil present");
  assertTrue(
    typeof mono03.getResolution === "function",
    "getResolution present",
  );
});

Deno.test("clocks: now() is overridable for deterministic tests", () => {
  const { imports } = clocks({ now: () => 42n });
  const mono = imports["wasi:clocks/monotonic-clock@0.2"] as { now(): bigint };
  assertEq(mono.now(), 42n);
});

Deno.test("clocks@0.3: system-clock (0.3's wall-clock reshape) — instant record, duration resolution", () => {
  const { imports } = clocks();
  const sys = imports["wasi:clocks/system-clock@0.3"] as {
    now(): { seconds: bigint; nanoseconds: number };
    getResolution(): bigint;
  };
  const t = sys.now();
  assertTrue(t.seconds > 1_500_000_000n, "a plausible epoch second");
  assertTrue(
    t.nanoseconds >= 0 && t.nanoseconds < 1_000_000_000,
    "ns in range",
  );
  assertEq(sys.getResolution(), 1_000_000n); // Date.now() is ms-backed
  // The type-only types interface is a registered import target.
  assertTrue("wasi:clocks/types@0.3" in imports, "types@0.3 registered");
});

for (const m of methods) {
  Deno.test(`clocks@0.3: ${m.name} at/before the deadline needs no timer`, async () => {
    const fq = fakeTimers();
    try {
      const now = 10_000_000_000n;
      const { imports } = clocks({ now: () => now });
      const mono03 = imports["wasi:clocks/monotonic-clock@0.3"] as Mono03;
      // waitUntil: the exact instant and a past instant; waitFor: zero.
      const offsets = m.name === "waitFor" ? [0n] : [0n, -1_000_000n];
      for (const off of offsets) await m.start(mono03, now, off);
      assertEq(fq.queue.length, 0, "no timer queued when already due");
    } finally {
      fq.restore();
    }
  });

  Deno.test(`clocks@0.3: ${m.name} caps an over-ceiling delay and completes over multiple chunks`, async () => {
    const fq = fakeTimers();
    try {
      let now = 10_000_000_000n;
      const start = now;
      const { imports } = clocks({ now: () => now });
      const mono03 = imports["wasi:clocks/monotonic-clock@0.3"] as Mono03;
      const totalMs = CEILING_MS + 10_000; // two chunks: ceiling, then the remainder
      let done = false;
      m.start(mono03, start, BigInt(totalMs) * 1_000_000n).then(
        () => (done = true),
      );
      await Promise.resolve();
      assertEq(fq.queue.length, 1, "one timer armed");
      assertEq(
        fq.queue[0].delayMs,
        CEILING_MS,
        "first chunk capped at the ceiling",
      );

      // Advance past the first (ceiling-sized) chunk: not yet at the deadline.
      now += BigInt(CEILING_MS) * 1_000_000n;
      await fire(fq);
      assertTrue(!done, "not resolved after the first chunk alone");
      assertEq(fq.queue.length, 1, "rearmed for the remainder");
      assertEq(
        fq.queue[0].delayMs,
        10_000,
        "remaining delay is the untimed tail",
      );

      // Advance the remainder and complete: the second chunk resolves the wait.
      now += 10_000n * 1_000_000n;
      await fire(fq);
      assertTrue(done, "resolved once the final chunk reaches the deadline");
      assertEq(fq.queue.length, 0, "no timer left armed");
    } finally {
      fq.restore();
    }
  });

  Deno.test(`clocks@0.3: ${m.name} rechecks the clock on every fire and rearms the remaining delay`, async () => {
    const fq = fakeTimers();
    try {
      let now = 10_000_000_000n;
      const { imports } = clocks({ now: () => now });
      const mono03 = imports["wasi:clocks/monotonic-clock@0.3"] as Mono03;
      let done = false;
      m.start(mono03, now, 20_000_000n).then(() => (done = true)); // 20ms
      await Promise.resolve();
      assertEq(fq.queue.length, 1, "one timer armed");
      assertEq(fq.queue[0].delayMs, 20, "initial delay matches the offset");

      // Spurious fire with the clock unchanged: not due yet.
      await fire(fq);
      assertTrue(!done, "not resolved: clock never advanced");
      assertEq(fq.queue.length, 1, "rearmed a fresh timer");
      assertEq(
        fq.queue[0].delayMs,
        20,
        "rearmed with the same remaining delay",
      );

      // Partial advance: still short of the deadline.
      now += 12_000_000n; // 8ms remaining
      await fire(fq);
      assertTrue(!done, "not resolved: still short of the deadline");
      assertEq(fq.queue.length, 1, "rearmed again");
      assertEq(
        fq.queue[0].delayMs,
        8,
        "rearmed with the reduced remaining delay",
      );

      // Reach the deadline: this fire resolves the wait.
      now += 8_000_000n;
      await fire(fq);
      assertTrue(done, "resolved once the clock reaches the deadline");
    } finally {
      fq.restore();
    }
  });

  Deno.test(`clocks@0.3: ${m.name} resolves on an ordinary single-chunk wait (sub-ms remainder)`, async () => {
    const fq = fakeTimers();
    try {
      let now = 10_000_000_000n;
      const { imports } = clocks({ now: () => now });
      const mono03 = imports["wasi:clocks/monotonic-clock@0.3"] as Mono03;
      const offsetNs = 500_000n; // 0.5ms
      let done = false;
      m.start(mono03, now, offsetNs).then(() => (done = true));
      await Promise.resolve();
      assertEq(fq.queue.length, 1, "one timer armed");
      now += offsetNs; // clock reaches the deadline before the chunk fires
      await fire(fq);
      assertTrue(done, "resolves once the sub-ms chunk fires at the deadline");
    } finally {
      fq.restore();
    }
  });
}
