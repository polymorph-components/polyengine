// String and char lift/lower (definitions.py `load_string*`,
// `store_string*`, `convert_i32_to_char`, `char_to_i32`).
//
// Host-side strings are plain JS strings (docs/architecture.md §7). Two deliberate
// deviations from definitions.py, both recorded in runtime/README.md:
//
// 1. No encoding provenance. The reference represents a lifted string as
//    (str, src_encoding, tagged_code_units) so that lowering can pick a
//    same-encoding copy fast path. In this host, cross-component calls (and
//    hence transcode fast paths) belong to FACT adapters (docs/architecture.md §4.1); the
//    host boundary deals in JS strings only. Lowering therefore always treats
//    the source as a UTF-16 code-unit sequence — exactly the reference's
//    behavior for src_encoding='utf16' — because that is what a JS string is.
//
// 2. USVString replacement semantics (docs/architecture.md §7): a JS string containing
//    lone surrogates is lowered as if each unpaired surrogate were U+FFFD
//    (WebIDL USVString). The reference never sees unpaired surrogates because
//    lifted Python strings are always well-formed; this only affects
//    host-constructed strings.

import { assert_, trap, trapIf } from "./trap.ts";
import {
  bytesOf,
  loadPtr,
  storeInt,
  trapIfRangeExceedsMemory,
  writeBytes,
} from "./memory.ts";
import { alignTo } from "./layout.ts";
import { type LiftLowerContext, requireMemory } from "./context.ts";
import type { PtrType, StringEncoding } from "./types.ts";

export const REALLOC_I32_MAX = 2 ** 32 - 1;

// Trap wording for realloc-return validation, matching wasmtime
// (`src/runtime/component/func/options.rs:175,185`) so the official suite's
// `values/realloc.wast` expectations match. Semantics are unchanged; only the
// text differs from the earlier hand-written wording.
export const REALLOC_MISALIGNED = "realloc return: result not aligned";
export const REALLOC_OOB = "realloc return: beyond end of memory";
export const MAX_STRING_BYTE_LENGTH = (1 << 28) - 1;

/** definitions.py utf16_tag: the high bit of a pointer-sized integer. */
export function utf16TagBig(ptrType: PtrType): bigint {
  return 1n << BigInt((ptrType === "i32" ? 4 : 8) * 8 - 1);
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf16Decoder = new TextDecoder("utf-16le", {
  fatal: true,
  ignoreBOM: true,
});
const utf8Encoder = new TextEncoder();

/** ISO-8859-1 (true latin1) decode. TextDecoder cannot be used: the WHATWG
 * "latin1"/"iso-8859-1" labels alias windows-1252, which differs in
 * 0x80..0x9F. Identity byte -> code point mapping, chunked. */
function latin1Decode(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    s += String.fromCharCode(...chunk);
  }
  return s;
}

/** WebIDL USVString conversion: unpaired surrogates -> U+FFFD. */
export function toWellFormed(s: string): string {
  return s.toWellFormed();
}

export function encodeUtf16Le(s: string): Uint8Array {
  const wf = toWellFormed(s);
  const out = new Uint8Array(2 * wf.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < wf.length; i++) {
    view.setUint16(2 * i, wf.charCodeAt(i), true);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading (guest memory -> JS string)
// ---------------------------------------------------------------------------

export function loadString(cx: LiftLowerContext, ptr: number): string {
  const mem = requireMemory(cx.opts);
  const begin = loadPtr(mem, ptr);
  const taggedCodeUnits = loadPtr(mem, ptr + mem.ptrSize());
  return loadStringFromRange(cx, begin, taggedCodeUnits);
}

export function loadStringFromRange(
  cx: LiftLowerContext,
  ptr: number | bigint,
  taggedCodeUnits: number | bigint,
): string {
  const mem = requireMemory(cx.opts);
  const tag = utf16TagBig(mem.ptrType());
  const units = BigInt(taggedCodeUnits);

  let alignment: number;
  let byteLengthBig: bigint;
  let encoding: "utf-8" | "utf-16-le" | "latin-1";
  switch (cx.opts.stringEncoding) {
    case "utf8":
      alignment = 1;
      byteLengthBig = units;
      encoding = "utf-8";
      break;
    case "utf16":
      alignment = 2;
      byteLengthBig = 2n * units;
      encoding = "utf-16-le";
      break;
    case "latin1+utf16":
      alignment = 2;
      if ((units & tag) !== 0n) {
        byteLengthBig = 2n * (units ^ tag);
        encoding = "utf-16-le";
      } else {
        byteLengthBig = units;
        encoding = "latin-1";
      }
      break;
  }

  trapIf(byteLengthBig > BigInt(MAX_STRING_BYTE_LENGTH), "string too long");
  const byteLength = Number(byteLengthBig);
  const ptrBig = BigInt(ptr);
  trapIf(ptrBig % BigInt(alignment) !== 0n, "misaligned string pointer");
  trapIfRangeExceedsMemory(
    mem,
    ptrBig,
    byteLengthBig,
    "string pointer/length out of bounds of memory",
  );
  const p = Number(ptrBig);

  const bytes = bytesOf(mem, p, byteLength);
  try {
    switch (encoding) {
      case "utf-8":
        return utf8Decoder.decode(bytes);
      case "utf-16-le":
        return utf16Decoder.decode(bytes);
      case "latin-1":
        return latin1Decode(bytes);
    }
  } catch {
    // Message only: the trap condition is unchanged. wasmtime lifts strings
    // with `core::str::from_utf8` and surfaces Rust's `Utf8Error`, whose two
    // shapes the official suite asserts on separately
    // (`values/strings.wast:85` vs `:101`): a byte sequence that can never be
    // valid, versus one that is a valid prefix cut short by the end of the
    // string.
    trap(
      encoding === "utf-8"
        ? utf8ErrorMessage(bytes)
        : "invalid string encoding",
    );
  }
}

/**
 * Classify a UTF-8 decode failure the way `core::str::from_utf8` does:
 * `Utf8Error::error_len() == None` (input ended mid-sequence) is reported as
 * "incomplete utf-8 byte sequence", anything else as "invalid utf-8".
 * Diagnostics only — callers have already decided to trap.
 */
function utf8ErrorMessage(bytes: Uint8Array): string {
  const INVALID = "invalid utf-8";
  const INCOMPLETE = "incomplete utf-8 byte sequence";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      i += 1;
      continue;
    }
    // Sequence length and the permitted range of the first continuation byte
    // (the second byte carries the overlong/surrogate/range constraints).
    let width: number;
    let loMin = 0x80;
    let loMax = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      width = 2;
    } else if (b === 0xe0) {
      width = 3;
      loMin = 0xa0;
    } else if (b >= 0xe1 && b <= 0xec) {
      width = 3;
    } else if (b === 0xed) {
      width = 3;
      loMax = 0x9f; // no surrogates
    } else if (b >= 0xee && b <= 0xef) {
      width = 3;
    } else if (b === 0xf0) {
      width = 4;
      loMin = 0x90;
    } else if (b >= 0xf1 && b <= 0xf3) {
      width = 4;
    } else if (b === 0xf4) {
      width = 4;
      loMax = 0x8f; // <= U+10FFFF
    } else {
      return INVALID; // continuation byte in leading position, or 0xC0/C1/F5+
    }
    for (let k = 1; k < width; k++) {
      if (i + k >= bytes.length) return INCOMPLETE;
      const c = bytes[i + k];
      const min = k === 1 ? loMin : 0x80;
      const max = k === 1 ? loMax : 0xbf;
      if (c < min || c > max) return INVALID;
    }
    i += width;
  }
  // The decoder rejected input this scan considers well-formed: report the
  // generic verdict rather than claiming a shape we did not find.
  return INVALID;
}

// ---------------------------------------------------------------------------
// Storing (JS string -> guest memory)
// ---------------------------------------------------------------------------

export function storeString(
  cx: LiftLowerContext,
  v: string,
  ptr: number,
): void {
  const mem = requireMemory(cx.opts);
  const [begin, taggedCodeUnits] = storeStringIntoRange(cx, v);
  // Write order matches the reference (store_string, definitions.py:1613-1616):
  // begin pointer first, then tagged length. Unobservable here (no trap can
  // intervene between the two writes), but kept in step for parity.
  storeInt(
    mem,
    mem.ptrSize() === 4 ? begin : BigInt(begin),
    ptr,
    mem.ptrSize(),
  );
  storeInt(
    mem,
    mem.ptrSize() === 4 ? Number(taggedCodeUnits) : taggedCodeUnits,
    ptr + mem.ptrSize(),
    mem.ptrSize(),
  );
}

/**
 * definitions.py store_string_into_range, specialized to a JS-string source
 * (src_encoding = 'utf16', src_code_units = s.length — see module comment).
 * Returns [ptr, tagged_code_units]; tagged units as bigint because the
 * latin1+utf16 tag bit exceeds Number.MAX_SAFE_INTEGER on i64 memories.
 */
export function storeStringIntoRange(
  cx: LiftLowerContext,
  src: string,
): [number, bigint] {
  const srcCodeUnits = src.length;
  switch (cx.opts.stringEncoding as StringEncoding) {
    case "utf8":
      return storeUtf16ToUtf8(cx, src, srcCodeUnits);
    case "utf16":
      return storeStringCopyUtf16(cx, src, srcCodeUnits);
    case "latin1+utf16":
      return storeStringToLatin1OrUtf16(cx, src, srcCodeUnits);
  }
}

/** definitions.py store_string_copy for a utf16 destination. */
function storeStringCopyUtf16(
  cx: LiftLowerContext,
  src: string,
  srcCodeUnits: number,
): [number, bigint] {
  const mem = requireMemory(cx.opts);
  const dstByteLength = 2 * srcCodeUnits;
  assert_(dstByteLength <= REALLOC_I32_MAX);
  const ptr = cx.allocate(2, dstByteLength);
  trapIf(ptr !== alignTo(ptr, 2), REALLOC_MISALIGNED);
  trapIfRangeExceedsMemory(
    mem,
    ptr,
    dstByteLength,
    REALLOC_OOB,
  );
  const encoded = encodeUtf16Le(src);
  assert_(dstByteLength === encoded.length);
  writeBytes(mem, ptr, encoded);
  return [ptr, BigInt(srcCodeUnits)];
}

/** definitions.py store_utf16_to_utf8 -> store_string_to_utf8. */
function storeUtf16ToUtf8(
  cx: LiftLowerContext,
  src: string,
  srcCodeUnits: number,
): [number, bigint] {
  const worstCaseSize = srcCodeUnits * 3;
  return storeStringToUtf8(cx, src, srcCodeUnits, worstCaseSize);
}

function storeStringToUtf8(
  cx: LiftLowerContext,
  src: string,
  srcCodeUnits: number,
  worstCaseSize: number,
): [number, bigint] {
  const mem = requireMemory(cx.opts);
  assert_(srcCodeUnits <= REALLOC_I32_MAX);
  let ptr = cx.allocate(1, srcCodeUnits);
  trapIfRangeExceedsMemory(
    mem,
    ptr,
    srcCodeUnits,
    REALLOC_OOB,
  );
  // Optimistic ASCII copy; on the first non-ASCII code unit, realloc to the
  // worst case, bulk-encode, then shrink.
  for (let i = 0; i < src.length; i++) {
    const cu = src.charCodeAt(i);
    if (cu < 0x80) {
      mem.bytes[ptr + i] = cu;
    } else {
      assert_(worstCaseSize <= REALLOC_I32_MAX);
      ptr = cx.reallocate(ptr, srcCodeUnits, 1, worstCaseSize);
      trapIfRangeExceedsMemory(
        mem,
        ptr,
        worstCaseSize,
        REALLOC_OOB,
      );
      const encoded = utf8Encoder.encode(src); // USVString: replaces lone surrogates
      writeBytes(mem, ptr + i, encoded.subarray(i));
      if (worstCaseSize > encoded.length) {
        ptr = cx.reallocate(ptr, worstCaseSize, 1, encoded.length);
        trapIfRangeExceedsMemory(
          mem,
          ptr,
          encoded.length,
          REALLOC_OOB,
        );
      }
      return [ptr, BigInt(encoded.length)];
    }
  }
  return [ptr, BigInt(srcCodeUnits)];
}

/** definitions.py store_string_to_latin1_or_utf16 (latin1+utf16 dst). */
function storeStringToLatin1OrUtf16(
  cx: LiftLowerContext,
  src: string,
  srcCodeUnits: number,
): [number, bigint] {
  const mem = requireMemory(cx.opts);
  const wf = toWellFormed(src);
  assert_(srcCodeUnits <= REALLOC_I32_MAX);
  let ptr = cx.allocate(2, srcCodeUnits);
  trapIf(ptr !== alignTo(ptr, 2), REALLOC_MISALIGNED);
  trapIfRangeExceedsMemory(
    mem,
    ptr,
    srcCodeUnits,
    REALLOC_OOB,
  );
  let dstByteLength = 0;
  for (let i = 0; i < wf.length; i++) {
    const cu = wf.charCodeAt(i);
    if (cu < 1 << 8) {
      mem.bytes[ptr + dstByteLength] = cu;
      dstByteLength += 1;
    } else {
      // Widen everything written so far to utf16 and continue as utf16.
      const worstCaseSize = 2 * srcCodeUnits;
      assert_(worstCaseSize <= REALLOC_I32_MAX);
      ptr = cx.reallocate(ptr, srcCodeUnits, 2, worstCaseSize);
      trapIf(ptr !== alignTo(ptr, 2), REALLOC_MISALIGNED);
      trapIfRangeExceedsMemory(
        mem,
        ptr,
        worstCaseSize,
        REALLOC_OOB,
      );
      for (let j = dstByteLength - 1; j >= 0; j--) {
        mem.bytes[ptr + 2 * j] = mem.bytes[ptr + j];
        mem.bytes[ptr + 2 * j + 1] = 0;
      }
      const encoded = encodeUtf16Le(wf);
      writeBytes(
        mem,
        ptr + 2 * dstByteLength,
        encoded.subarray(2 * dstByteLength),
      );
      if (worstCaseSize > encoded.length) {
        ptr = cx.reallocate(ptr, worstCaseSize, 2, encoded.length);
        trapIf(ptr !== alignTo(ptr, 2), REALLOC_MISALIGNED);
        trapIfRangeExceedsMemory(
          mem,
          ptr,
          encoded.length,
          REALLOC_OOB,
        );
      }
      const taggedCodeUnits = BigInt(encoded.length / 2) |
        utf16TagBig(mem.ptrType());
      return [ptr, taggedCodeUnits];
    }
  }
  if (dstByteLength < srcCodeUnits) {
    ptr = cx.reallocate(ptr, srcCodeUnits, 2, dstByteLength);
    trapIf(ptr !== alignTo(ptr, 2), REALLOC_MISALIGNED);
    trapIfRangeExceedsMemory(
      mem,
      ptr,
      dstByteLength,
      REALLOC_OOB,
    );
  }
  return [ptr, BigInt(dstByteLength)];
}

// ---------------------------------------------------------------------------
// Char (definitions.py convert_i32_to_char / char_to_i32)
// ---------------------------------------------------------------------------

export function convertI32ToChar(i: number): string {
  assert_(i >= 0);
  trapIf(i >= 0x110000, "char out of range");
  trapIf(0xd800 <= i && i <= 0xdfff, "char is a surrogate");
  return String.fromCodePoint(i);
}

export function charToI32(c: string): number {
  const i = c.codePointAt(0);
  assert_(i !== undefined, "empty char");
  assert_(c.length === (i! > 0xffff ? 2 : 1), "char must be one code point");
  assert_(
    (0 <= i! && i! <= 0xd7ff) || (0xe000 <= i! && i! <= 0x10ffff),
    "char must be a Unicode scalar value",
  );
  return i!;
}
