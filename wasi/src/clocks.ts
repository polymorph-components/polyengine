// `wasi:clocks@0.2` + `wasi:clocks@0.3` (contracts/embedder-api.md
// §"WASI examination"; the union clock: `monotonic-clock@0.3.0` exposes
// different function sets across the consumer corpus (`wait-for` vs
// `now`+`wait-until`) at the SAME version string — same track, divergent
// drafts, served by one union provider per contracts/embedder-api.md
// §"Version canonicalization").
// The @0.3 track also carries system-clock (0.3's wall-clock reshape) and
// the type-only types interface, per the WASI 0.3.1 release WIT.

import { Pollable } from "./io.ts";

export interface ClocksOptions {
  /** Override the monotonic clock's `now()` (nanoseconds); default `performance.now()`-derived. */
  now?: () => bigint;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** `wasi:clocks@0.2` + `wasi:clocks@0.3` provider fragment (two track keys). */
export function clocks(options: ClocksOptions = {}): { imports: Record<string, unknown> } {
  const nowFn = options.now ?? ((): bigint => BigInt(Math.round(performance.now() * 1e6)));
  // A coarse but honest resolution: this clock is JS-timer-backed, not a
  // real hardware tick; 1 microsecond avoids claiming false precision.
  const RESOLUTION_NS = 1_000n;

  const monotonic02 = {
    now: nowFn,
    resolution: (): bigint => RESOLUTION_NS,
    // Real timers (the parking kernel, io.ts): an always-ready timer stub
    // livelocks any guest that sleeps by parking — tokio's reactor being
    // the known consumer. `block()`/`poll()` on these park the frame until
    // the deadline; `ready()` consults the clock, so the wake is exact.
    subscribeInstant: (when: bigint): Pollable => Pollable.timer(when, nowFn),
    subscribeDuration: (howLong: bigint): Pollable =>
      Pollable.timer(nowFn() + howLong, nowFn),
  };

  const wallClock02 = {
    now: (): { seconds: bigint; nanoseconds: number } => {
      const ms = Date.now();
      return {
        seconds: BigInt(Math.floor(ms / 1000)),
        nanoseconds: (ms % 1000) * 1_000_000,
      };
    },
    resolution: (): { seconds: bigint; nanoseconds: number } => ({
      seconds: 0n,
      nanoseconds: 1_000_000,
    }),
  };

  // The union provider: both drafts' functions live on the one `@0.3` track provider; per-leaf
  // structural resolution (contracts/embedder-api.md §"Version
  // canonicalization") lets each consumer link only the subset it imports.
  const monotonic03 = {
    now: nowFn,
    getResolution: (): bigint => RESOLUTION_NS,
    waitUntil: async (when: bigint): Promise<void> => {
      const deltaNs = when - nowFn();
      await sleep(Number(deltaNs) / 1e6);
    },
    waitFor: async (howLong: bigint): Promise<void> => {
      await sleep(Number(howLong) / 1e6);
    },
  };

  // 0.3 reshapes wall-clock into system-clock (WASI 0.3.1 release:
  // clocks/system-clock.wit): `now() -> instant` — a RECORD with SIGNED
  // seconds (record instant { seconds: s64, nanoseconds: u32 }; the same
  // value shape as 0.2's datetime) — and `get-resolution() -> duration`
  // (plain u64 nanoseconds, unlike 0.2's datetime-shaped resolution).
  const systemClock03 = {
    now: (): { seconds: bigint; nanoseconds: number } => {
      const ms = Date.now();
      return {
        seconds: BigInt(Math.floor(ms / 1000)),
        nanoseconds: (ms % 1000) * 1_000_000,
      };
    },
    getResolution: (): bigint => 1_000_000n, // Date.now() is millisecond-backed
  };

  return {
    imports: {
      "wasi:clocks/monotonic-clock@0.2": monotonic02,
      "wasi:clocks/wall-clock@0.2": wallClock02,
      "wasi:clocks/monotonic-clock@0.3": monotonic03,
      "wasi:clocks/system-clock@0.3": systemClock03,
      // Type-only interface (`type duration = u64`): nothing to
      // implement, registered so the import target resolves (the
      // cli/types@0.3 precedent).
      "wasi:clocks/types@0.3": {},
    },
  };
}
