// R3-F1: FACT transcoders read srcPtr/dstPtr as the SIGNED i32 core wasm
// delivers them, with no `>>> 0` normalization (contrast every other
// i32-taking intrinsic: intrinsics/mod.ts:538/544/551/730/733,
// exec/boundary.ts:223,314). A pointer in [2^31, 2^32) is legal once the
// guest's linear memory exceeds 2 GiB (wasmtime's `validate_guest_pointer`
// does its arithmetic in unsigned i64), but here it arrives negative and
// `Uint8Array.prototype.slice`/property-index writes silently read or write
// the wrong offset instead of the byte range FACT bounds-checked.
//
// Repro: runtime/src/intrinsics/transcode.ts:271-487 (snapshot/dst indexing
// use srcPtr/dstPtr verbatim). Reference: contracts/intrinsics.md §A/§B
// ("Semantics authority is wasmtime's libcalls"); wasmtime 47.0.3
// libcalls.rs takes unsigned pointers.

import { assertEq } from "./support/asserts.ts";
import {
  createTranscoder,
  TranscodeMemory,
} from "../src/intrinsics/mod.ts";

// ~2.4 GiB: large enough that an address >= 2^31 is in bounds. V8 reserves
// wasm memory lazily on 64-bit hosts; if this allocation fails here, the
// test cannot exercise the bug and is skipped with a clear reason.
function tryBigMemory(): WebAssembly.Memory | null {
  try {
    return new WebAssembly.Memory({ initial: 40000 });
  } catch {
    return null;
  }
}

// Probe once at module load to decide whether to skip; each test still
// allocates its own memory so state does not leak between cases (all three
// use the same >=2^31 offset).
const bigMemoryAvailable = tryBigMemory() !== null;

Deno.test({
  name:
    "transcode: latin1-to-latin1 with a >=2^31 src pointer copies the wrong bytes",
  ignore: !bigMemoryAvailable,
  fn() {
    // Confirmed on this host: WebAssembly.Memory({initial: 40000}) (~2.44 GiB)
    // allocates successfully.
    const memory = tryBigMemory()!;
    const view = new TranscodeMemory(() => memory, "test");
    const p = 0x9000_0000; // 2415919104, >= 2^31, in bounds for this memory
    const abc = new TextEncoder().encode("abc");
    new Uint8Array(memory.buffer).set(abc, p);

    const signedPtr = p | 0;
    assertEq(signedPtr, -1879048192, "sanity: this is how wasm delivers it");

    const fn = createTranscoder("latin1-to-latin1", view, view);
    fn(signedPtr, 3, 16);

    const got = [...new Uint8Array(memory.buffer).subarray(16, 19)];
    // Reference (wasmtime): the transcoder operates on the byte range FACT
    // bounds-checked (unsigned ptr) and copies "abc" to offset 16.
    assertEq(got, [...abc], "expected 'abc' copied to dst 16..19");
  },
});

Deno.test({
  name:
    "transcode: utf8-to-utf8 with a >=2^31 src pointer copies the wrong bytes",
  ignore: !bigMemoryAvailable,
  fn() {
    const memory = tryBigMemory()!;
    const view = new TranscodeMemory(() => memory, "test");
    const p = 0x9000_0000;
    const src = new TextEncoder().encode("abc");
    new Uint8Array(memory.buffer).set(src, p);

    const signedPtr = p | 0;
    const fn = createTranscoder("utf8-to-utf8", view, view);
    fn(signedPtr, 3, 16);

    const got = [...new Uint8Array(memory.buffer).subarray(16, 19)];
    assertEq(got, [...src], "expected 'abc' copied to dst 16..19");
  },
});

Deno.test({
  name:
    "transcode: latin1-to-utf16 with a >=2^31 DESTINATION pointer silently drops the write",
  ignore: !bigMemoryAvailable,
  fn() {
    const memory = tryBigMemory()!;
    const view = new TranscodeMemory(() => memory, "test");
    const bytes = new Uint8Array(memory.buffer);
    bytes.set([0x41, 0xff], 0); // "A", 0xFF as latin1

    const dstP = 0x9000_0000; // >= 2^31, in bounds for this memory
    const signedDst = dstP | 0;

    const fn = createTranscoder("latin1-to-utf16", view, view);
    fn(0, 2, signedDst);

    // Reference: bytes land at the unsigned destination address FACT
    // bounds-checked. Ours: `dst[negativeIndex] = …` is a silent no-op
    // property write (or, for other ops, `.set()` throws a non-Trap
    // RangeError) — the correct location is left untouched.
    const got = [...new Uint8Array(memory.buffer).subarray(dstP, dstP + 4)];
    assertEq(got, [0x41, 0x00, 0xff, 0x00], "expected inflated utf16 at unsigned dst");
  },
});
