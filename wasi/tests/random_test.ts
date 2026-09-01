// wasi:random@0.2 — shapes and lengths (contracts/embedder-api.md
// §"WASI examination": "random shapes").

import { assertEq, assertTrue } from "./asserts.ts";
import { random } from "../src/random.ts";

Deno.test("random: get-random-bytes returns exactly `len` bytes", () => {
  const { imports } = random();
  const r = imports["wasi:random/random@0.2"] as {
    getRandomBytes(len: bigint): Uint8Array;
  };
  assertEq(r.getRandomBytes(16n).length, 16);
  assertEq(r.getRandomBytes(0n).length, 0);
});

Deno.test("random: get-random-bytes spans the 64KiB getRandomValues quota", () => {
  // Fail-on-pre-fix pin: a single getRandomValues call rejects >65536 bytes
  // (QuotaExceededError), and the WIT allows no shorter return — the
  // provider must chunk the fill and still hand back exactly `len` bytes.
  const { imports } = random();
  const r = imports["wasi:random/random@0.2"] as {
    getRandomBytes(len: bigint): Uint8Array;
  };
  const len = 3 * 65536 + 17; // three full chunks + a ragged tail
  const bytes = r.getRandomBytes(BigInt(len));
  assertEq(bytes.length, len);
  // Every chunk actually got filled: a 32-byte window of a CSPRNG output is
  // all-zero with probability 2^-256 — treat that as impossible. Check the
  // start of each chunk and the ragged tail.
  for (const off of [0, 65536, 2 * 65536, 3 * 65536, len - 17]) {
    const window = bytes.subarray(off, Math.min(off + 32, len));
    assertTrue(
      window.some((b) => b !== 0),
      `window at ${off} is all-zero (chunk not filled)`,
    );
  }
});

Deno.test("random: get-random-u64 returns a bigint", () => {
  const { imports } = random();
  const r = imports["wasi:random/random@0.2"] as { getRandomU64(): bigint };
  assertTrue(typeof r.getRandomU64() === "bigint");
});

Deno.test("random: insecure mirrors random's shapes", () => {
  const { imports } = random();
  const insecure = imports["wasi:random/insecure@0.2"] as {
    getInsecureRandomBytes(len: bigint): Uint8Array;
    getInsecureRandomU64(): bigint;
  };
  assertEq(insecure.getInsecureRandomBytes(8n).length, 8);
  assertTrue(typeof insecure.getInsecureRandomU64() === "bigint");
});

Deno.test("random: insecure-seed defaults to a documented deterministic value", () => {
  const { imports } = random();
  const seedIface = imports["wasi:random/insecure-seed@0.2"] as {
    insecureSeed(): readonly [bigint, bigint];
  };
  const [a, b] = seedIface.insecureSeed();
  assertEq(a, 0n);
  assertEq(b, 1n);
  // Predictable across calls, as the WIT doc comment for insecure-seed
  // explicitly allows.
  const [a2, b2] = seedIface.insecureSeed();
  assertEq(a2, a);
  assertEq(b2, b);
});

Deno.test("random: insecure-seed is override-able", () => {
  const { imports } = random({ insecureSeed: [7n, 9n] });
  const seedIface = imports["wasi:random/insecure-seed@0.2"] as {
    insecureSeed(): readonly [bigint, bigint];
  };
  const [a, b] = seedIface.insecureSeed();
  assertEq(a, 7n);
  assertEq(b, 9n);
});

Deno.test("random: a virtualized source replaces the CSPRNG, WIT shapes intact", () => {
  // The mod.ts COMPOSITION form-3 scenario: tests selectively stubbing
  // randomness while every WIT shape and rule stays enforced.
  let counter = 0;
  const { imports } = random({ source: (len) => Uint8Array.from({ length: len }, () => counter++) });
  const r = imports["wasi:random/random@0.2"] as {
    getRandomBytes(len: bigint): Uint8Array;
    getRandomU64(): bigint;
  };
  assertEq(JSON.stringify([...r.getRandomBytes(4n)]), JSON.stringify([0, 1, 2, 3]));
  const u64 = r.getRandomU64(); // bytes 4..11, little-endian
  assertEq(u64, new DataView(Uint8Array.from([4, 5, 6, 7, 8, 9, 10, 11]).buffer).getBigUint64(0, true));
  // insecure routes through the same source; insecure-seed stays governed
  // by its own option.
  const insecure = imports["wasi:random/insecure@0.2"] as { getInsecureRandomBytes(len: bigint): Uint8Array };
  assertEq(insecure.getInsecureRandomBytes(2n).length, 2);
});

Deno.test("random: a short-reading source is a loud host error, not guest corruption", () => {
  const { imports } = random({ source: () => new Uint8Array(3) });
  const r = imports["wasi:random/random@0.2"] as { getRandomBytes(len: bigint): Uint8Array };
  let threw: unknown;
  try {
    r.getRandomBytes(8n);
  } catch (e) {
    threw = e;
  }
  assertTrue(threw instanceof TypeError, `a TypeError names the contract, got ${threw}`);
});

Deno.test("random@0.3: the same three interfaces ride the 0.3 track", () => {
  const { imports } = random({ insecureSeed: [7n, 8n] });
  for (const iface of ["random", "insecure", "insecure-seed"]) {
    assertTrue(`wasi:random/${iface}@0.3` in imports, `${iface}@0.3 registered`);
  }
  const r = imports["wasi:random/random@0.3"] as { getRandomBytes(len: bigint): Uint8Array };
  // max-len permits short reads; chunk-to-full returns exactly max-len.
  assertEq(r.getRandomBytes(16n).length, 16);
  const seed = imports["wasi:random/insecure-seed@0.3"] as { insecureSeed(): [bigint, bigint] };
  assertEq(seed.insecureSeed()[0], 7n);
});
