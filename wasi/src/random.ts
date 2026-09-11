// `wasi:random@0.2` + `wasi:random@0.3` — random, insecure, insecure-seed
// (contracts/embedder-api.md §"WASI examination"; 0.2 leaves confirmed
// against `engine-go/main.wasm`'s import surface: `get-random-bytes`; 0.3
// shapes from the WASI 0.3.1 release — same three interfaces, same
// function names, `len` renamed `max-len` with short reads permitted; see
// the divergence note on `GET_RANDOM_VALUES_MAX`). One impl serves both
// tracks: chunk-to-full is conforming on each.

export interface RandomOptions {
  /** Override the deterministic default `insecure-seed` value. */
  insecureSeed?: readonly [bigint, bigint];
  /**
   * Replace the CSPRNG (virtualization: tests selectively stubbing
   * randomness while keeping the WIT shapes). Must return EXACTLY `len`
   * bytes — the @0.2 contract's no-short-reads rule is enforced here, so
   * a misbehaving source is a loud host error, not a guest corruption.
   * Serves `random`, `insecure`, and `get-*-u64` alike; `insecure-seed`
   * stays governed by `insecureSeed`.
   */
  source?: (len: number) => Uint8Array;
}

/**
 * `crypto.getRandomValues` rejects requests over 65536 bytes
 * (QuotaExceededError), while the 0.2 WIT this fragment serves requires
 * exactly `len` bytes back ("Return `len` cryptographically-secure random
 * or pseudo-random bytes", random.wit @0.2.x) — no shorter-return
 * latitude, and callers (Rust `getrandom`, the Go runtime) fill fixed-size
 * buffers trusting the length. So: chunk the fill, never clamp it.
 *
 * TRACK DIVERGENCE, for a future @0.3 fragment: `wasi:random@0.3.0`
 * renames the parameter to `max-len` and PERMITS short reads
 * ("Implementations MAY return fewer bytes than requested"; callers must
 * loop; ≥1 byte required for max-len > 0). Authority moved with the WASI
 * consolidation: `WebAssembly/WASI proposals/random/wit/random.wit` — the
 * archived wasi-random repo's 0.3 rc still shows the old exact-len text.
 * Chunk-to-full remains conforming there too ("up to max-len" includes
 * exactly max-len) and makes conforming callers' mandatory loops terminate
 * in one pass, so this helper serves both tracks unchanged.
 *
 * Either way the fill stays synchronous, satisfying both tracks' "must not
 * block ... including on requests for [large] numbers of bytes".
 */
const GET_RANDOM_VALUES_MAX = 65536;

function cryptoBytes(len: bigint): Uint8Array {
  const out = new Uint8Array(Number(len));
  for (let i = 0; i < out.length; i += GET_RANDOM_VALUES_MAX) {
    crypto.getRandomValues(
      out.subarray(i, Math.min(i + GET_RANDOM_VALUES_MAX, out.length)),
    );
  }
  return out;
}

/** The fill, honoring a virtualized `source` and its exact-length contract. */
function makeRandomBytes(
  source: ((len: number) => Uint8Array) | undefined,
): (len: bigint) => Uint8Array {
  if (source === undefined) return cryptoBytes;
  return (len: bigint): Uint8Array => {
    const out = source(Number(len));
    if (out.length !== Number(len)) {
      throw new TypeError(
        `random source returned ${out.length} bytes, need exactly ${len} ` +
          `(the @0.2 WIT permits no short reads)`,
      );
    }
    return out;
  };
}

function makeRandomU64(bytes: (len: bigint) => Uint8Array): () => bigint {
  return (): bigint => {
    const out = bytes(8n);
    return new DataView(out.buffer, out.byteOffset, 8).getBigUint64(0, true);
  };
}

/**
 * A fixed default: `wasi:random/insecure-seed` is explicitly documented (WIT
 * doc comment, io.wit deps) as allowed to be entirely deterministic — it
 * exists to seed hash-map DoS resistance, not for cryptographic use. This
 * shim defaults to a fixed, obviously-synthetic pair (documented here as
 * exactly that) so runs are reproducible; pass `insecureSeed` to override.
 */
const DEFAULT_INSECURE_SEED: readonly [bigint, bigint] = [0n, 1n];

/** `wasi:random@0.2` + `@0.3` provider fragment (two track keys). */
export function random(
  options: RandomOptions = {},
): { imports: Record<string, unknown> } {
  const seed = options.insecureSeed ?? DEFAULT_INSECURE_SEED;
  const randomBytes = makeRandomBytes(options.source);
  const randomU64 = makeRandomU64(randomBytes);
  const randomIface = {
    getRandomBytes: randomBytes,
    getRandomU64: randomU64,
  };
  // "insecure" only means "not required to be a CSPRNG" — it is still
  // wired to the real CSPRNG here for simplicity; only `insecure-seed`
  // is deliberately, documentedly predictable.
  const insecureIface = {
    getInsecureRandomBytes: randomBytes,
    getInsecureRandomU64: randomU64,
  };
  const insecureSeedIface = {
    insecureSeed: (): readonly [bigint, bigint] => seed,
  };
  return {
    imports: {
      "wasi:random/random@0.2": randomIface,
      "wasi:random/insecure@0.2": insecureIface,
      "wasi:random/insecure-seed@0.2": insecureSeedIface,
      // The @0.3 track: identical function names; `max-len` PERMITS short
      // reads but chunk-to-full returns exactly max-len, which "up to
      // max-len" includes (module header) — one impl, both tracks.
      "wasi:random/random@0.3": randomIface,
      "wasi:random/insecure@0.3": insecureIface,
      "wasi:random/insecure-seed@0.3": insecureSeedIface,
    },
  };
}
