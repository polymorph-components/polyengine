// Runtime handshake (docs/architecture.md §9): verify a loaded plan's world
// against the digest embedded by generated bindgen code, failing fast with
// the expected/actual digests on mismatch (contracts/digest.md).

import type { WirePlan } from "../plan/format.ts";
import { computeWorldDigest } from "./digest.ts";

/** @internal */
export interface DigestMismatch {
  expected: string;
  actual: string;
}

/**
 * Thrown by generated `instantiate` wrappers when the loaded plan's world
 * digest does not match the constant bindgen embedded at generation time
 * (contracts/digest.md: "fails fast on mismatch").
 * Raised BEFORE the component is instantiated, so no guest code has run
 * when a caller catches this.
 *
 * Named and catchable: `err instanceof WorldDigestMismatchError`, or
 * `err.name === "WorldDigestMismatchError"` across realms.
 * @internal
 */
export class WorldDigestMismatchError extends Error {
  override readonly name = "WorldDigestMismatchError";
  /** The world these bindings were generated from. */
  readonly world: string;
  /** The full mismatch report (expected/actual digest). */
  readonly mismatch: DigestMismatch;

  constructor(world: string, mismatch: DigestMismatch) {
    super(
      `world digest mismatch for \`${world}\`: bindings expect ` +
        `${mismatch.expected}, loaded plan computes ${mismatch.actual}` +
        " — regenerate the bindings from the component's WIT",
    );
    this.world = world;
    this.mismatch = mismatch;
  }

  /** Digest the generated bindings were built against. */
  get expected(): string {
    return this.mismatch.expected;
  }
  /** Digest computed from the plan actually loaded. */
  get actual(): string {
    return this.mismatch.actual;
  }
}

/**
 * Verify `plan`'s computed world digest against `expectedDigest` (the
 * constant bindgen embedded at generation time). Returns `null` on match,
 * or a `DigestMismatch` report on mismatch.
 * @internal
 */
export async function verifyWorldDigest(
  plan: WirePlan,
  expectedDigest: string,
): Promise<DigestMismatch | null> {
  const actual = await computeWorldDigest(plan);
  if (actual.digest === expectedDigest) return null;
  return {
    expected: expectedDigest,
    actual: actual.digest,
  };
}
