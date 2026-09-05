// FACT string-transcoder intrinsics (runtime/src/intrinsics/transcode.ts).
//
// Each case is checked against the behavior of the corresponding wasmtime
// libcall (`runtime/vm/component/libcalls.rs`), which is the reference
// for this layer: FACT's generated adapters depend not just on the bytes
// written but on the exact return values (how much of the source was
// consumed, how much of the destination was filled, the compact-utf16 tag),
// because those drive its realloc/retry logic.

import { assertEq } from "./support/asserts.ts";
import { Trap } from "../src/cabi/mod.ts";
import {
  createTranscoder,
  TRANSCODE_OPS,
  TranscodeMemory,
} from "../src/intrinsics/mod.ts";
import type { TranscodeOp } from "../src/intrinsics/mod.ts";

/** A standalone memory usable as both transcode source and destination. */
function mem(): {
  memory: WebAssembly.Memory;
  view: TranscodeMemory;
  bytes: () => Uint8Array;
} {
  const memory = new WebAssembly.Memory({ initial: 1 });
  return {
    memory,
    view: new TranscodeMemory(() => memory, "test"),
    bytes: () => new Uint8Array(memory.buffer),
  };
}

function write(m: ReturnType<typeof mem>, at: number, bytes: number[]): void {
  m.bytes().set(Uint8Array.from(bytes), at);
}

function read(m: ReturnType<typeof mem>, at: number, len: number): number[] {
  return [...m.bytes().subarray(at, at + len)];
}

/** UTF-16LE bytes for a JS string. */
function u16le(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    out.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8);
  }
  return out;
}

function call(
  op: TranscodeOp,
  from: ReturnType<typeof mem>,
  to: ReturnType<typeof mem>,
  ...args: number[]
): unknown {
  return createTranscoder(op, from.view, to.view)(...args);
}

function assertTraps(fn: () => unknown, includes: string): void {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof Trap)) throw e;
    assertEq(String(e).includes(includes), true, `message: ${e}`);
    return;
  }
  throw new Error(`expected a trap mentioning '${includes}'`);
}

// ---------------------------------------------------------------------------
// Same-encoding copies: (srcPtr, srcLen, dstPtr) -> (), validation included
// ---------------------------------------------------------------------------

Deno.test("transcode: latin1-to-latin1 is a plain copy", () => {
  const m = mem();
  write(m, 0, [0x00, 0x7f, 0x80, 0xff]);
  call("latin1-to-latin1", m, m, 0, 4, 64);
  assertEq(read(m, 64, 4), [0x00, 0x7f, 0x80, 0xff]);
});

Deno.test("transcode: utf8-to-utf8 copies and validates", () => {
  const m = mem();
  write(m, 0, [...new TextEncoder().encode("héllo")]);
  const len = new TextEncoder().encode("héllo").length;
  call("utf8-to-utf8", m, m, 0, len, 64);
  assertEq(
    new TextDecoder().decode(m.bytes().subarray(64, 64 + len)),
    "héllo",
  );
  write(m, 0, [0xff]);
  assertTraps(() => call("utf8-to-utf8", m, m, 0, 1, 64), "invalid utf8");
});

Deno.test("transcode: utf16-to-utf16 copies and rejects lone surrogates", () => {
  const m = mem();
  write(m, 0, u16le("ab"));
  call("utf16-to-utf16", m, m, 0, 2, 64);
  assertEq(read(m, 64, 4), u16le("ab"));
  // A high surrogate with no low surrogate following.
  write(m, 0, [0x00, 0xd8, 0x61, 0x00]);
  assertTraps(() => call("utf16-to-utf16", m, m, 0, 2, 64), "invalid utf16");
});

Deno.test("transcode: latin1-to-utf16 inflates each byte", () => {
  const m = mem();
  write(m, 0, [0x41, 0xff]);
  call("latin1-to-utf16", m, m, 0, 2, 64);
  assertEq(read(m, 64, 4), [0x41, 0x00, 0xff, 0x00]);
});

// ---------------------------------------------------------------------------
// Inflating conversions with a code-unit count result
// ---------------------------------------------------------------------------

Deno.test("transcode: utf8-to-utf16 returns code units written", () => {
  const m = mem();
  const src = new TextEncoder().encode("aé\u{1F600}"); // 1 + 2 + 4 bytes
  write(m, 0, [...src]);
  const units = call("utf8-to-utf16", m, m, 0, src.length, 64) as number;
  // "a" + "é" + surrogate pair = 4 UTF-16 code units.
  assertEq(units, 4);
  assertEq(read(m, 64, 8), u16le("aé\u{1F600}"));

  write(m, 0, [0xc3]); // truncated two-byte sequence
  assertTraps(() => call("utf8-to-utf16", m, m, 0, 1, 64), "invalid utf8");
});

Deno.test("transcode: utf16-to-compact-probably-utf16 tags its result", () => {
  const m = mem();
  // All code points below 0x100 -> compacted to latin1, untagged length.
  write(m, 0, u16le("ab\u00ff"));
  assertEq(call("utf16-to-compact-probably-utf16", m, m, 0, 3, 64), 3);
  assertEq(read(m, 64, 3), [0x61, 0x62, 0xff]);

  // One code point above 0x100 -> stays utf16, length tagged with UTF16_TAG.
  const m2 = mem();
  write(m2, 0, u16le("a\u0100"));
  assertEq(
    call("utf16-to-compact-probably-utf16", m2, m2, 0, 2, 64),
    (2 | 0x8000_0000) >>> 0,
  );
  assertEq(read(m2, 64, 4), u16le("a\u0100"));
});

// ---------------------------------------------------------------------------
// Deflating conversions returning [srcRead, dstWritten]
// ---------------------------------------------------------------------------

Deno.test("transcode: utf8-to-latin1 stops at the first non-latin1 point", () => {
  const m = mem();
  const src = new TextEncoder().encode("aé€"); // 'a', U+00E9 (2B), U+20AC (3B)
  write(m, 0, [...src]);
  // 'a' + 'é' are latin1 (3 source bytes, 2 latin1 bytes); U+20AC is not.
  assertEq(call("utf8-to-latin1", m, m, 0, src.length, 64), [3, 2]);
  assertEq(read(m, 64, 2), [0x61, 0xe9]);
});

Deno.test("transcode: utf16-to-latin1 stops at the first unit above 0xFF", () => {
  const m = mem();
  write(m, 0, u16le("ab\u0100c"));
  assertEq(call("utf16-to-latin1", m, m, 0, 4, 64), [2, 2]);
  assertEq(read(m, 64, 2), [0x61, 0x62]);
});

Deno.test("transcode: utf16-to-utf8 honors first_pass and dst capacity", () => {
  const m = mem();
  write(m, 0, u16le("abé"));
  // First pass bails at the first non-ASCII code point: 2 units read,
  // 2 bytes written.
  assertEq(call("utf16-to-utf8", m, m, 0, 3, 64, 16, 1), [2, 2]);
  assertEq(read(m, 64, 2), [0x61, 0x62]);
  // Second pass (first_pass = 0) transcodes everything.
  assertEq(call("utf16-to-utf8", m, m, 0, 3, 96, 16, 0), [3, 4]);
  assertEq(read(m, 96, 4), [0x61, 0x62, 0xc3, 0xa9]);
  // A destination too small for the next code point ends the transcode early,
  // which is how FACT learns it must grow the buffer and call again.
  assertEq(call("utf16-to-utf8", m, m, 0, 3, 128, 2, 0), [2, 2]);
});

Deno.test("transcode: latin1-to-utf8 honors first_pass and dst capacity", () => {
  const m = mem();
  write(m, 0, [0x61, 0x62, 0xe9]);
  assertEq(call("latin1-to-utf8", m, m, 0, 3, 64, 16, 1), [2, 2]);
  assertEq(call("latin1-to-utf8", m, m, 0, 3, 96, 16, 0), [3, 4]);
  assertEq(read(m, 96, 4), [0x61, 0x62, 0xc3, 0xa9]);
  // Capacity 3 fits "ab" (2 bytes) but not the 2-byte encoding of 0xE9.
  assertEq(call("latin1-to-utf8", m, m, 0, 3, 128, 3, 0), [2, 2]);
});

// ---------------------------------------------------------------------------
// The second half of a latin1+utf16 lowering: re-inflate then continue
// ---------------------------------------------------------------------------

Deno.test("transcode: utf8-to-compact-utf16 inflates the latin1 prefix", () => {
  const m = mem();
  // FACT already wrote "ab" as latin1 into the destination and now hands us
  // the *remaining* source plus that byte count.
  write(m, 64, [0x61, 0x62]);
  const rest = new TextEncoder().encode("\u0100c");
  write(m, 0, [...rest]);
  const units = call(
    "utf8-to-compact-utf16",
    m,
    m,
    0,
    rest.length,
    64,
    16,
    2,
  ) as number;
  assertEq(units, 4); // "ab" + U+0100 + "c"
  assertEq(read(m, 64, 8), u16le("ab\u0100c"));
});

Deno.test("transcode: utf16-to-compact-utf16 inflates the latin1 prefix", () => {
  const m = mem();
  write(m, 64, [0x61, 0x62]);
  write(m, 0, u16le("\u0100c"));
  assertEq(call("utf16-to-compact-utf16", m, m, 0, 2, 64, 16, 2), 4);
  assertEq(read(m, 64, 8), u16le("ab\u0100c"));
});

// ---------------------------------------------------------------------------
// Coverage + rejections
// ---------------------------------------------------------------------------

Deno.test("transcode: every wasmtime Transcode op is constructible", () => {
  // The shim emits `Transcode::desc()` strings; if wasmtime grows an op, the
  // executor must fail loudly at instantiate rather than mis-dispatch.
  assertEq(TRANSCODE_OPS.length, 12);
  const m = mem();
  for (const op of TRANSCODE_OPS) {
    assertEq(typeof createTranscoder(op, m.view, m.view), "function");
  }
});

Deno.test("transcode: memories are re-read after growth", () => {
  // A transcoder can run after the guest grew a memory, which detaches the
  // previous ArrayBuffer; TranscodeMemory re-derives its view per call.
  const m = mem();
  const fn = createTranscoder("latin1-to-latin1", m.view, m.view);
  m.memory.grow(1);
  m.bytes().set(Uint8Array.from([1, 2, 3]), 0);
  fn(0, 3, 64);
  assertEq(read(m, 64, 3), [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// Defensive guards (issue #96): unreachable under FACT's real guarantees —
// exercised here by calling the intrinsic directly with an invariant FACT
// itself would never violate (a too-small dst capacity / overlapping
// regions), which is exactly what a synthetic unit-level test needs to
// reach without going through a full FACT-generated call.
// ---------------------------------------------------------------------------

Deno.test("transcode: utf8-to-compact-utf16 traps when dst capacity is exceeded", () => {
  const m = mem();
  // "abc" is 3 latin1-ineligible... actually any 3-char ASCII string needs 3
  // u16 units; advertise a dst capacity of only 2 units total (dstLen=2,
  // latin1BytesSoFar=0) so `capacity (2) < s.length (3)`.
  const rest = new TextEncoder().encode("abc");
  write(m, 0, [...rest]);
  assertTraps(
    () => call("utf8-to-compact-utf16", m, m, 0, rest.length, 64, 2, 0),
    "destination capacity exceeded",
  );
});

Deno.test("transcode: utf8-to-compact-utf16 does not trap when dst capacity exactly fits", () => {
  const m = mem();
  const rest = new TextEncoder().encode("abc");
  write(m, 0, [...rest]);
  // latin1BytesSoFar=1 (1 unit already written) + 3 more units == dstLen 4.
  write(m, 64, [0x7a]);
  const units = call(
    "utf8-to-compact-utf16",
    m,
    m,
    0,
    rest.length,
    64,
    4,
    1,
  ) as number;
  assertEq(units, 4);
});

Deno.test("transcode: utf16-to-latin1 traps on overlapping src/dst in the same memory", () => {
  const m = mem();
  write(m, 0, u16le("ab\u0100c"));
  // dst at byte 2 overlaps the src u16 range [0, 8) in the same memory.
  assertTraps(
    () => call("utf16-to-latin1", m, m, 0, 4, 2),
    "overlap",
  );
});

Deno.test("transcode: utf16-to-latin1 does not trap on non-overlapping regions", () => {
  const m = mem();
  write(m, 0, u16le("ab\u0100c"));
  assertEq(call("utf16-to-latin1", m, m, 0, 4, 64), [2, 2]);
  assertEq(read(m, 64, 2), [0x61, 0x62]);
});

Deno.test("transcode: utf16-to-latin1 does not trap across independent memories", () => {
  const from = mem();
  const to = mem();
  write(from, 0, u16le("ab\u0100c"));
  // Same offsets in independent ArrayBuffers must not be flagged as overlap.
  assertEq(call("utf16-to-latin1", from, to, 0, 4, 0), [2, 2]);
  assertEq(read(to, 0, 2), [0x61, 0x62]);
});
