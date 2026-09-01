// FACT string-transcoder intrinsics (`wasmtime_environ::component::Trampoline
// ::Transcoder`, contracts/intrinsics.md §B).
//
// FACT emits these when a cross-component call has to move a string between
// two components whose canonical `string-encoding` options disagree (or, for
// same-encoding pairs, to *validate* the source). It calls them with raw
// pointers into two linear memories and expects them to do the encoding work
// in place; the surrounding allocation/realloc dance stays in the adapter.
//
// Authorities used, in order:
//   - signatures: wasmtime-environ 47.0.3 `fact/transcode.rs` (`Transcoder::ty`)
//   - call protocol (argument order, multi-pass retries, what each result is
//     used for): `fact/trampoline.rs` `string_copy` / `string_deflate_to_utf8`
//     / `string_to_utf16` / `string_utf16_to_compact` / `string_to_compact`
//   - operation semantics: wasmtime 47.0.3
//     `runtime/vm/component/libcalls.rs` (the twelve `Transcode` libcalls) —
//     the executable reference for this layer, since definitions.py models
//     transcoding as whole-string `store_string_*` rather than as these
//     partial-progress primitives.
//
// Memory64 (`from64`/`to64`) is out of scope (https://github.com/polymorph-components/polyengine/issues/12); the executor
// rejects those at instantiate time.

import { trap } from "../cabi/trap.ts";

/** definitions.py `UTF16_TAG` for 32-bit pointers. */
const UTF16_TAG = 0x8000_0000;

/**
 * A live view of one `WebAssembly.Memory`. Views are re-derived per access:
 * a transcoder can be called after the guest grew a memory, which detaches
 * the previous `ArrayBuffer`.
 */
export class TranscodeMemory {
  #provider: () => WebAssembly.Memory | undefined;
  #label: string;

  constructor(provider: () => WebAssembly.Memory | undefined, label: string) {
    this.#provider = provider;
    this.#label = label;
  }

  bytes(): Uint8Array {
    const m = this.#provider();
    if (m === undefined) {
      throw new Error(`${this.#label} accessed before it was extracted`);
    }
    return new Uint8Array(m.buffer);
  }
}

/** The `Transcode` op names as emitted by the shim (`Transcode::desc()`). */
export type TranscodeOp =
  | "utf8-to-utf8"
  | "utf16-to-utf16"
  | "latin1-to-latin1"
  | "latin1-to-utf16"
  | "latin1-to-utf8"
  | "utf16-to-compact-probably-utf16"
  | "utf16-to-compact-utf16"
  | "utf16-to-latin1"
  | "utf16-to-utf8"
  | "utf8-to-compact-utf16"
  | "utf8-to-latin1"
  | "utf8-to-utf16";

export const TRANSCODE_OPS: readonly TranscodeOp[] = [
  "utf8-to-utf8",
  "utf16-to-utf16",
  "latin1-to-latin1",
  "latin1-to-utf16",
  "latin1-to-utf8",
  "utf16-to-compact-probably-utf16",
  "utf16-to-compact-utf16",
  "utf16-to-latin1",
  "utf16-to-utf8",
  "utf8-to-compact-utf16",
  "utf8-to-latin1",
  "utf8-to-utf16",
];

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const utf8Fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Decode UTF-8, trapping on invalid input the way wasmtime's libcalls do
 * (`core::str::from_utf8(..).map_err(|_| format_err!("invalid utf8
 * encoding"))`).
 */
function decodeUtf8OrTrap(bytes: Uint8Array): string {
  try {
    return utf8Fatal.decode(bytes);
  } catch {
    trap("invalid utf8 encoding");
  }
}

/**
 * Decode a little-endian UTF-16 code-unit range into code points, trapping on
 * an unpaired surrogate (wasmtime: `core::char::decode_utf16` +
 * "invalid utf16 encoding").
 *
 * Yields `[codePoint, unitsConsumed]` so callers can report how much of the
 * source they read, which the partial-progress ops need.
 */
function* decodeUtf16OrTrap(
  bytes: Uint8Array,
  ptr: number,
  units: number,
): Generator<[number, number]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i < units) {
    const u = view.getUint16(ptr + 2 * i, true);
    if (u < 0xd800 || u > 0xdfff) {
      i += 1;
      yield [u, 1];
      continue;
    }
    if (u >= 0xdc00 || i + 1 >= units) trap("invalid utf16 encoding");
    const lo = view.getUint16(ptr + 2 * (i + 1), true);
    if (lo < 0xdc00 || lo > 0xdfff) trap("invalid utf16 encoding");
    i += 2;
    yield [0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00), 2];
  }
}

/** UTF-8 byte length of one code point. */
function utf8Len(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** Encode one code point as UTF-8 at `dst[at..]`; returns bytes written. */
function encodeUtf8At(dst: Uint8Array, at: number, cp: number): number {
  if (cp < 0x80) {
    dst[at] = cp;
    return 1;
  }
  if (cp < 0x800) {
    dst[at] = 0xc0 | (cp >> 6);
    dst[at + 1] = 0x80 | (cp & 0x3f);
    return 2;
  }
  if (cp < 0x10000) {
    dst[at] = 0xe0 | (cp >> 12);
    dst[at + 1] = 0x80 | ((cp >> 6) & 0x3f);
    dst[at + 2] = 0x80 | (cp & 0x3f);
    return 3;
  }
  dst[at] = 0xf0 | (cp >> 18);
  dst[at + 1] = 0x80 | ((cp >> 12) & 0x3f);
  dst[at + 2] = 0x80 | ((cp >> 6) & 0x3f);
  dst[at + 3] = 0x80 | (cp & 0x3f);
  return 4;
}

/**
 * Write one code point as little-endian UTF-16 at u16 index `at`; returns the
 * number of code units written.
 */
function encodeUtf16At(view: DataView, base: number, at: number, cp: number) {
  if (cp < 0x10000) {
    view.setUint16(base + 2 * at, cp, true);
    return 1;
  }
  const c = cp - 0x10000;
  view.setUint16(base + 2 * at, 0xd800 + (c >> 10), true);
  view.setUint16(base + 2 * (at + 1), 0xdc00 + (c & 0x3ff), true);
  return 2;
}

/**
 * `encoding_rs::mem::utf8_latin1_up_to`: the byte index of the first byte that
 * does not start a well-formed UTF-8 sequence for a code point below U+0100.
 * Invalid UTF-8 also stops the scan (it is "not latin1"); the caller's later
 * UTF-16 pass is what turns genuinely invalid input into a trap.
 */
function utf8Latin1UpTo(bytes: Uint8Array, ptr: number, len: number): number {
  let i = 0;
  while (i < len) {
    const b = bytes[ptr + i];
    if (b < 0x80) {
      i += 1;
    } else if (b === 0xc2 || b === 0xc3) {
      const next = i + 1 < len ? bytes[ptr + i + 1] : -1;
      if (next < 0x80 || next > 0xbf) break;
      i += 2;
    } else {
      break;
    }
  }
  return i;
}

/**
 * `inflate_latin1_bytes`: the first `latin1Bytes` bytes of the destination
 * were written as latin1; widen them in place to little-endian u16 code units
 * (walking backwards so the expansion does not clobber unread input).
 */
function inflateLatin1Bytes(
  dst: Uint8Array,
  dstPtr: number,
  latin1Bytes: number,
): void {
  for (let i = latin1Bytes - 1; i >= 0; i--) {
    dst[dstPtr + 2 * i] = dst[dstPtr + i];
    dst[dstPtr + 2 * i + 1] = 0;
  }
}

/**
 * Guard against the one case where reading and writing through the same
 * `Uint8Array` would corrupt data: FACT freshly allocates every destination,
 * so source and destination never overlap, but they *can* live in the same
 * memory. Callers that read and write interleaved snapshot the source first.
 */
function snapshot(bytes: Uint8Array, ptr: number, len: number): Uint8Array {
  return bytes.slice(ptr, ptr + len);
}

/**
 * O(1) defensive counterpart to wasmtime's `assert_no_overlap`
 * (libcalls.rs:166-177): traps (does not merely assert) because this
 * replaces a guarantee FACT's trampoline construction is supposed to
 * provide — src/dst are always independently-allocated regions — so a hit
 * here means that guarantee broke, which is guest-memory-corruption-class
 * severity, not an internal invariant a caller controls.
 *
 * Applied only where a call reads and writes through the SAME backing
 * `Uint8Array` while interleaving reads and writes (byte-range comparison,
 * not per-element — O(1) per call). Ops that first `snapshot()` the source
 * into an independent copy (transcode.ts's `snapshot`, used by every op
 * above that decodes-then-writes) already break aliasing before the first
 * write, so they are exempt by construction and do not call this.
 */
function trapIfOverlap(
  src: Uint8Array,
  srcPtr: number,
  srcLen: number,
  dst: Uint8Array,
  dstPtr: number,
  dstLen: number,
): void {
  if (src.buffer !== dst.buffer) return; // different memories: cannot overlap
  const srcStart = src.byteOffset + srcPtr;
  const srcEnd = srcStart + srcLen;
  const dstStart = dst.byteOffset + dstPtr;
  const dstEnd = dstStart + dstLen;
  if (srcStart < dstEnd && dstStart < srcEnd) {
    trap("transcode src/dst regions overlap");
  }
}

// ---------------------------------------------------------------------------
// The twelve operations
// ---------------------------------------------------------------------------

/**
 * Build the JS function backing one `Transcoder` trampoline.
 *
 * Result shape follows the core signature in `fact/transcode.rs`: no result,
 * one result (a number), or two results (a `[srcRead, dstWritten]` pair — the
 * JS API delivers a multi-value return as an array).
 */
export function createTranscoder(
  op: TranscodeOp,
  from: TranscodeMemory,
  to: TranscodeMemory,
): (...args: number[]) => unknown {
  switch (op) {
    // (srcPtr, srcLen, dstPtr) -> () --------------------------------------
    case "latin1-to-latin1":
      return (srcPtr, srcLen, dstPtr) => {
        const src = from.bytes();
        const dst = to.bytes();
        dst.set(snapshot(src, srcPtr, srcLen), dstPtr);
      };

    case "utf8-to-utf8":
      return (srcPtr, srcLen, dstPtr) => {
        const src = from.bytes();
        const copy = snapshot(src, srcPtr, srcLen);
        decodeUtf8OrTrap(copy); // validation only
        to.bytes().set(copy, dstPtr);
      };

    case "utf16-to-utf16":
      return (srcPtr, srcLen, dstPtr) => {
        const src = from.bytes();
        const copy = snapshot(src, srcPtr, 2 * srcLen);
        // Round-trips the units, but must reject unpaired surrogates.
        for (const _ of decodeUtf16OrTrap(copy, 0, srcLen)) { /* validate */ }
        to.bytes().set(copy, dstPtr);
      };

    case "latin1-to-utf16":
      return (srcPtr, srcLen, dstPtr) => {
        const src = snapshot(from.bytes(), srcPtr, srcLen);
        const dst = to.bytes();
        for (let i = 0; i < srcLen; i++) {
          dst[dstPtr + 2 * i] = src[i];
          dst[dstPtr + 2 * i + 1] = 0;
        }
      };

    // (srcPtr, srcLen, dstPtr) -> dstUnits ---------------------------------
    case "utf8-to-utf16":
      return (srcPtr, srcLen, dstPtr) => {
        const s = decodeUtf8OrTrap(snapshot(from.bytes(), srcPtr, srcLen));
        const dst = to.bytes();
        const view = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
        // The destination holds `srcLen` code units (UTF-16 units are never
        // more numerous than UTF-8 bytes), matching wasmtime's `zip`.
        let units = 0;
        for (let i = 0; i < s.length && units < srcLen; i++) {
          view.setUint16(dstPtr + 2 * units, s.charCodeAt(i), true);
          units++;
        }
        return units;
      };

    case "utf16-to-compact-probably-utf16":
      return (srcPtr, srcLen, dstPtr) => {
        const src = snapshot(from.bytes(), srcPtr, 2 * srcLen);
        let allLatin1 = true;
        for (const [cp] of decodeUtf16OrTrap(src, 0, srcLen)) {
          if (cp > 0xff) allLatin1 = false;
        }
        const dst = to.bytes();
        dst.set(src, dstPtr);
        if (!allLatin1) return (srcLen | UTF16_TAG) >>> 0;
        // Compact in place: keep the low byte of each little-endian unit.
        for (let i = 0; i < srcLen; i++) dst[dstPtr + i] = dst[dstPtr + 2 * i];
        return srcLen;
      };

    // (srcPtr, srcLen, dstPtr) -> [srcRead, dstWritten] --------------------
    case "utf8-to-latin1":
      return (srcPtr, srcLen, dstPtr) => {
        const src = snapshot(from.bytes(), srcPtr, srcLen);
        const read = utf8Latin1UpTo(src, 0, srcLen);
        const dst = to.bytes();
        let written = 0;
        let i = 0;
        while (i < read) {
          const b = src[i];
          if (b < 0x80) {
            dst[dstPtr + written] = b;
            i += 1;
          } else {
            dst[dstPtr + written] = ((b & 0x1f) << 6) | (src[i + 1] & 0x3f);
            i += 2;
          }
          written++;
        }
        return [read, written];
      };

    case "utf16-to-latin1":
      return (srcPtr, srcLen, dstPtr) => {
        const src = from.bytes();
        const dst = to.bytes();
        // This op does not call `snapshot()` (unlike its siblings above):
        // it reads the full `out` prefix before writing anything to `dst`,
        // which is the same aliasing-safety property snapshot() buys
        // elsewhere, just via a builder array instead of a byte copy. The
        // overlap guard is still added here (O(1): a byte-range compare, not
        // per-element) as the one op in this file that is safe by algorithm
        // shape rather than by an explicit `snapshot()` call — cheap
        // insurance against that reasoning becoming stale under a future
        // edit (docs/architecture.md §7; wasmtime asserts overlap on every
        // op unconditionally, libcalls.rs:166-177).
        trapIfOverlap(src, srcPtr, 2 * srcLen, dst, dstPtr, srcLen);
        const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
        // Note: no surrogate validation here, matching wasmtime — a surrogate
        // is simply > 0xFF and ends the latin1 prefix.
        const out: number[] = [];
        for (let i = 0; i < srcLen; i++) {
          const u = view.getUint16(srcPtr + 2 * i, true);
          if (u > 0xff) break;
          out.push(u);
        }
        for (let i = 0; i < out.length; i++) dst[dstPtr + i] = out[i];
        return [out.length, out.length];
      };

    // (srcPtr, srcLen, dstPtr, dstLen, firstPass) -> [srcRead, dstWritten] -
    case "utf16-to-utf8":
      return (srcPtr, srcLen, dstPtr, dstLen, firstPass) => {
        const src = snapshot(from.bytes(), srcPtr, 2 * srcLen);
        const dst = to.bytes();
        let srcRead = 0;
        let dstWritten = 0;
        let consumed = 0;
        for (const [cp, units] of decodeUtf16OrTrap(src, 0, srcLen)) {
          consumed += units;
          // The spec requires the first pass to bail on the first
          // non-ASCII code point (wasmtime: `first_pass && ch >= 0x80`).
          if (firstPass !== 0 && cp >= 0x80) break;
          const remaining = dstLen - dstWritten;
          if (remaining < 4 && remaining < utf8Len(cp)) break;
          srcRead = consumed;
          dstWritten += encodeUtf8At(dst, dstPtr + dstWritten, cp);
        }
        return [srcRead, dstWritten];
      };

    case "latin1-to-utf8":
      return (srcPtr, srcLen, dstPtr, dstLen, firstPass) => {
        const src = snapshot(from.bytes(), srcPtr, srcLen);
        // First pass halts at the first byte that is not ASCII, because a
        // latin1 byte >= 0x80 is two bytes of UTF-8.
        let stop = srcLen;
        if (firstPass !== 0) {
          for (let i = 0; i < srcLen; i++) {
            if (src[i] >= 0x80) {
              stop = i;
              break;
            }
          }
        }
        const dst = to.bytes();
        let read = 0;
        let written = 0;
        while (read < stop) {
          const b = src[read];
          const need = b < 0x80 ? 1 : 2;
          if (written + need > dstLen) break; // partial: caller grows and retries
          written += encodeUtf8At(dst, dstPtr + written, b);
          read++;
        }
        return [read, written];
      };

    // (srcPtr, srcLen, dstPtr, dstLen, latin1BytesSoFar) -> dstUnits -------
    case "utf8-to-compact-utf16":
      return (srcPtr, srcLen, dstPtr, dstLen, latin1Bytes) => {
        const s = decodeUtf8OrTrap(snapshot(from.bytes(), srcPtr, srcLen));
        const dst = to.bytes();
        inflateLatin1Bytes(dst, dstPtr, latin1Bytes);
        const view = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
        // Defensive dst-capacity guard: wasmtime's equivalent
        // (`run_utf8_to_utf16`'s `.zip(dst)`, libcalls.rs:308-312) is bounded
        // by Rust's `Iterator::zip` truncating to the shorter of the two —
        // it can never overrun `dst`. FACT is supposed to size `dstLen` to
        // always have room (a full re-encode of a string that was already
        // partially latin1-encoded never needs more u16 units than
        // `dstLen - latin1Bytes`), so this should be unreachable; trap
        // rather than let a broken caller corrupt guest memory past `dst`'s
        // bound or silently truncate.
        const capacity = dstLen - latin1Bytes;
        if (s.length > capacity) {
          trap("utf8-to-compact-utf16: destination capacity exceeded");
        }
        let units = 0;
        for (let i = 0; i < s.length; i++) {
          view.setUint16(
            dstPtr + 2 * (latin1Bytes + units),
            s.charCodeAt(i),
            true,
          );
          units++;
        }
        return units + latin1Bytes;
      };

    case "utf16-to-compact-utf16":
      return (srcPtr, srcLen, dstPtr, _dstLen, latin1Bytes) => {
        const src = snapshot(from.bytes(), srcPtr, 2 * srcLen);
        const dst = to.bytes();
        inflateLatin1Bytes(dst, dstPtr, latin1Bytes);
        const view = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
        let at = latin1Bytes;
        for (const [cp] of decodeUtf16OrTrap(src, 0, srcLen)) {
          at += encodeUtf16At(view, dstPtr, at, cp);
        }
        // wasmtime returns `src.len() + latin1_bytes_so_far`: the source unit
        // count is the destination unit count for a utf16->utf16 copy.
        return srcLen + latin1Bytes;
      };

    default: {
      const exhaustive: never = op;
      throw new Error(`unknown transcode op ${exhaustive}`);
    }
  }
}
