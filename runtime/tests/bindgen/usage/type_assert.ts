// Tiny type-level assertion helpers shared by the bindgen usage samples.
// These have no runtime behavior — they exist purely to pin generated-type
// shapes at `deno check` time ("type-level assertions ...
// pinning kind/value union member shapes incl. absent-value, nested option
// boxing, tuple-as-tuple, camelCase fields, bigint positions, Uint8Array,
// Promise-shaped exports, ...").

/** `true` iff `A` and `B` are the exact same type (mutual assignability in
 * both directions, including union member shape — this is the standard
 * "distributive conditional" equality trick, not `A extends B`, which
 * would also accept wider/narrower types). */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

/** Compile-time-only assertion: `Expect<true>` type-checks, `Expect<false>`
 * does not. No runtime value is produced or required at call sites. */
export type Expect<T extends true> = T;
