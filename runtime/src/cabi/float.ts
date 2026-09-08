// Float bit handling (definitions.py NaN canonicalization and
// reinterpretation helpers).
//
// Use the reference's deterministic NaN policy on lift and store/lower.
// JS numbers do not reliably preserve NaN payloads, so raw payload identity
// is not part of this value boundary's contract.

export const CANONICAL_FLOAT32_NAN = 0x7fc00000;
export const CANONICAL_FLOAT64_NAN = 0x7ff8000000000000n;

const scratch = new DataView(new ArrayBuffer(8));

export function coreF32ReinterpretI32(i: number): number {
  scratch.setUint32(0, i, true);
  return scratch.getFloat32(0, true);
}

export function coreF64ReinterpretI64(i: bigint): number {
  scratch.setBigUint64(0, i, true);
  return scratch.getFloat64(0, true);
}

export function coreI32ReinterpretF32(f: number): number {
  scratch.setFloat32(0, f, true);
  return scratch.getUint32(0, true);
}

export function coreI64ReinterpretF64(f: number): bigint {
  scratch.setFloat64(0, f, true);
  return scratch.getBigUint64(0, true);
}

export function canonicalizeNan32(f: number): number {
  if (Number.isNaN(f)) return coreF32ReinterpretI32(CANONICAL_FLOAT32_NAN);
  return f;
}

export function canonicalizeNan64(f: number): number {
  if (Number.isNaN(f)) return coreF64ReinterpretI64(CANONICAL_FLOAT64_NAN);
  return f;
}

export function decodeI32AsFloat(i: number): number {
  return canonicalizeNan32(coreF32ReinterpretI32(i));
}

export function decodeI64AsFloat(i: bigint): number {
  return canonicalizeNan64(coreF64ReinterpretI64(i));
}

// definitions.py maybe_scramble_nan{32,64}: deterministic profile only —
// write the canonical NaN bit pattern explicitly, never relying on engine
// NaN propagation through DataView.

export function maybeScrambleNan32(f: number): number {
  if (Number.isNaN(f)) return coreF32ReinterpretI32(CANONICAL_FLOAT32_NAN);
  return f;
}

export function maybeScrambleNan64(f: number): number {
  if (Number.isNaN(f)) return coreF64ReinterpretI64(CANONICAL_FLOAT64_NAN);
  return f;
}

export function encodeFloatAsI32(f: number): number {
  if (Number.isNaN(f)) return CANONICAL_FLOAT32_NAN;
  return coreI32ReinterpretF32(f);
}

export function encodeFloatAsI64(f: number): bigint {
  if (Number.isNaN(f)) return CANONICAL_FLOAT64_NAN;
  return coreI64ReinterpretF64(f);
}
