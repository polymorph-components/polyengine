// wasi:clocks@0.2 + wasi:clocks@0.3 — monotonicity, `waitFor` actually
// waiting (coarse timing), the union-provider shape (contracts/embedder-api.md
// §"Version canonicalization").

import { assertEq, assertTrue } from "./asserts.ts";
import { clocks } from "../src/clocks.ts";

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

Deno.test("clocks@0.3: waitFor actually waits (coarse timing)", async () => {
  const { imports } = clocks();
  const mono03 = imports["wasi:clocks/monotonic-clock@0.3"] as {
    waitFor(ns: bigint): Promise<void>;
  };
  const t0 = performance.now();
  await mono03.waitFor(30_000_000n); // 30ms
  const elapsed = performance.now() - t0;
  assertTrue(elapsed >= 15, `waited at least ~half the requested duration (got ${elapsed}ms)`);
});

Deno.test("clocks@0.3: waitUntil waits until the given instant", async () => {
  let fakeNow = 0n;
  const { imports } = clocks({ now: () => fakeNow });
  const mono03 = imports["wasi:clocks/monotonic-clock@0.3"] as {
    waitUntil(when: bigint): Promise<void>;
    now(): bigint;
  };
  const t0 = performance.now();
  fakeNow = 0n;
  await mono03.waitUntil(20_000_000n); // 20ms ahead of the fixed `now`
  const elapsed = performance.now() - t0;
  assertTrue(elapsed >= 10, `waitUntil actually parked (got ${elapsed}ms)`);
});

Deno.test("clocks@0.3: the union provider exposes both drafts' functions on one provider", () => {
  const { imports } = clocks();
  const mono03 = imports["wasi:clocks/monotonic-clock@0.3"] as Record<string, unknown>;
  // iroh/experiment-mosh family:
  assertTrue(typeof mono03.waitFor === "function", "waitFor present");
  // polymorph-websocket family:
  assertTrue(typeof mono03.now === "function", "now present");
  assertTrue(typeof mono03.waitUntil === "function", "waitUntil present");
  assertTrue(typeof mono03.getResolution === "function", "getResolution present");
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
  assertTrue(t.nanoseconds >= 0 && t.nanoseconds < 1_000_000_000, "ns in range");
  assertEq(sys.getResolution(), 1_000_000n); // Date.now() is ms-backed
  // The type-only types interface is a registered import target.
  assertTrue("wasi:clocks/types@0.3" in imports, "types@0.3 registered");
});
