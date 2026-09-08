// Shell surface bootstrap — MUST be the first import in `tools/shell/entry.ts`
// (see that file's header for why import order matters here). Installs
// encoding, SHA-256 digest and base64 helpers on globalThis when absent.
//
// Implements the lane's encoding subset, not the full Encoding API: UTF-8
// encode, UTF-8/UTF-16LE decode, fatal errors and BOM handling; no encodeInto.
// Encoding replaces lone surrogates with U+FFFD. Fatal decoding rejects malformed
// input, including unpaired UTF-16 surrogates, as required by CABI load_string.
// This differs intentionally from lowering's USVString replacement. Non-fatal
// decoding substitutes U+FFFD, and ignoreBOM=false strips a leading BOM.

// deno-lint-ignore no-explicit-any
const g = globalThis as any;

function utf8Encode(str: string): Uint8Array {
  // Encode UCS-2/UTF-16 code units directly; an unpaired surrogate becomes
  // U+FFFD's UTF-8 encoding (ef bf bd) rather than throwing, matching the
  // WHATWG UTF-8 encoder (which never emits WTF-8).
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + (cp - 0xd800) * 0x400 + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd; // unpaired low surrogate
    }
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(
        0xe0 | (cp >> 12),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function utf8Decode(bytes: Uint8Array, fatal: boolean): string {
  let out = "";
  let i = 0;
  const n = bytes.length;
  const fail = (): string => {
    if (fatal) throw new TypeError("The encoded data was not valid UTF-8.");
    return "\ufffd";
  };
  while (i < n) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    }
    let need: number, cp: number, min: number;
    if ((b0 & 0xe0) === 0xc0) {
      need = 1;
      cp = b0 & 0x1f;
      min = 0x80;
    } else if ((b0 & 0xf0) === 0xe0) {
      need = 2;
      cp = b0 & 0x0f;
      min = 0x800;
    } else if ((b0 & 0xf8) === 0xf0) {
      need = 3;
      cp = b0 & 0x07;
      min = 0x10000;
    } else {
      out += fail();
      i++;
      continue;
    }
    if (i + need >= n + 1 && i + need > n) {
      out += fail();
      i++;
      continue;
    }
    let ok = true;
    let acc = cp;
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      acc = (acc << 6) | (b & 0x3f);
    }
    if (!ok || acc < min || acc > 0x10ffff || (acc >= 0xd800 && acc <= 0xdfff)) {
      out += fail();
      i++;
      continue;
    }
    if (acc <= 0xffff) {
      out += String.fromCharCode(acc);
    } else {
      const c = acc - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    }
    i += 1 + need;
  }
  return out;
}

function utf16leDecode(bytes: Uint8Array, fatal: boolean): string {
  const fail = (): string => {
    if (fatal) throw new TypeError("The encoded data was not valid UTF-16LE.");
    return "\ufffd";
  };
  if (bytes.length % 2 !== 0) {
    // Truncated trailing byte.
    if (fatal) throw new TypeError("The encoded data was not valid UTF-16LE.");
  }
  let out = "";
  const n = bytes.length - (bytes.length % 2);
  for (let i = 0; i < n; i += 2) {
    const unit = bytes[i] | (bytes[i + 1] << 8);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const hasNext = i + 3 < n + 1 && i + 2 < n;
      const nextUnit = hasNext ? (bytes[i + 2] | (bytes[i + 3] << 8)) : -1;
      if (nextUnit >= 0xdc00 && nextUnit <= 0xdfff) {
        out += String.fromCharCode(unit, nextUnit);
        i += 2;
        continue;
      }
      out += fail();
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += fail();
      continue;
    }
    out += String.fromCharCode(unit);
  }
  return out;
}

function stripBOM(s: string, ignoreBOM: boolean): string {
  return !ignoreBOM && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

class PolyfillTextEncoder {
  readonly encoding = "utf-8";
  encode(input = ""): Uint8Array {
    return utf8Encode(String(input));
  }
}

class PolyfillTextDecoder {
  #encoding: string;
  #fatal: boolean;
  #ignoreBOM: boolean;
  constructor(
    encoding = "utf-8",
    opts: { fatal?: boolean; ignoreBOM?: boolean } = {},
  ) {
    const norm = encoding.toLowerCase();
    if (norm !== "utf-8" && norm !== "utf8" && norm !== "utf-16le") {
      // Scope is exactly what the runtime uses (see header); anything else
      // is a real gap, not a silent fallback.
      throw new RangeError(`unsupported TextDecoder encoding: ${encoding}`);
    }
    this.#encoding = norm === "utf8" ? "utf-8" : norm;
    this.#fatal = opts.fatal ?? false;
    this.#ignoreBOM = opts.ignoreBOM ?? false;
  }
  get encoding(): string {
    return this.#encoding;
  }
  get fatal(): boolean {
    return this.#fatal;
  }
  get ignoreBOM(): boolean {
    return this.#ignoreBOM;
  }
  decode(input?: ArrayBufferView | ArrayBuffer): string {
    const bytes = input === undefined
      ? new Uint8Array(0)
      : input instanceof Uint8Array
      ? input
      : new Uint8Array(
        input instanceof ArrayBuffer ? input : (input as ArrayBufferView).buffer,
      );
    const decoded = this.#encoding === "utf-16le"
      ? utf16leDecode(bytes, this.#fatal)
      : utf8Decode(bytes, this.#fatal);
    return stripBOM(decoded, this.#ignoreBOM);
  }
}

// ---------------------------------------------------------------------------
// `crypto.subtle.digest("SHA-256", …)` polyfill.
//
// Neither shell exposes WebCrypto at all (discovered empirically running
// `RuntimeExecutor.create`, which digests the shim build via
// `runtime/src/shim/translator.ts`; the same call pattern recurs in
// `runtime/src/exec/executor.ts`, `runtime/src/digest/{digest,verify}.ts`,
// `runtime/src/cache/core.ts` — grepped for every `crypto.` call site under
// `runtime/src`; `crypto.randomUUID()` in `runtime/src/cache/dir.ts` is the
// only other use and is on a disk-cache path `RuntimeExecutor`/the
// conformance harness never reaches, so it is out of scope here). Only
// `digest("SHA-256", …)` is polyfilled — narrow, matching actual call sites,
// not a general WebCrypto shim.
//
// A pure-JS FIPS 180-4 SHA-256 (no external dependency, not a hot path: a
// few-hundred-KB buffer digested once per shim build / cache entry).
export function sha256(bytes: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const bitLenLow = (bytes.length * 8) >>> 0;
  const bitLenHigh = Math.floor((bytes.length * 8) / 0x100000000);
  const withOne = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  withOne.set(bytes);
  withOne[bytes.length] = 0x80;
  const view = new DataView(withOne.buffer);
  view.setUint32(withOne.length - 4, bitLenLow, false);
  view.setUint32(withOne.length - 8, bitLenHigh, false);

  const w = new Int32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < withOne.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, hh = h6, hi = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & hh);
      const temp1 = (hi + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      hi = hh;
      hh = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + hh) | 0;
    h7 = (h7 + hi) | 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((x, i) => outView.setUint32(i * 4, x, false));
  return out;
}

function toArrayBuffer(input: BufferSource): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(
    (input as ArrayBufferView).buffer,
    (input as ArrayBufferView).byteOffset,
    (input as ArrayBufferView).byteLength,
  );
}

class PolyfillSubtleCrypto {
  // deno-lint-ignore require-await
  async digest(algorithm: string | { name: string }, data: BufferSource): Promise<ArrayBuffer> {
    const name = typeof algorithm === "string" ? algorithm : algorithm.name;
    if (name.toUpperCase() !== "SHA-256") {
      throw new Error(`unsupported digest algorithm in shell polyfill: ${name}`);
    }
    return sha256(toArrayBuffer(data)).buffer as ArrayBuffer;
  }
}

// ---------------------------------------------------------------------------
// `atob`/`btoa` polyfill.
//
// Neither shell exposes these (browser/Deno/Node globals not part of any JS
// engine's own surface — the shell's job queue tests above happened not to
// exercise them, but `runtime/src/plan/loader.ts` (`atob`, decoding an
// inline-module's base64 payload out of the translator shim's plan JSON) and
// `runtime/src/cache/web.ts` (`atob`/`btoa`, the plan-cache's base64 codec)
// both call them — discovered running the full corpus, which the `binary`
// directory (b64-embedded core modules) exercises immediately. Standard
// forgiving-base64 codec over WHATWG's binary-string convention (one JS
// UTF-16 code unit == one byte, 0-255; throws outside that range, matching
// browser `btoa`).
const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function btoaPolyfill(binary: string): string {
  let out = "";
  for (let i = 0; i < binary.length; i += 3) {
    const c0 = binary.charCodeAt(i);
    const c1 = binary.charCodeAt(i + 1);
    const c2 = binary.charCodeAt(i + 2);
    if (c0 > 255 || (i + 1 < binary.length && c1 > 255) || (i + 2 < binary.length && c2 > 255)) {
      throw new DOMExceptionLike(
        "The string to be encoded contains characters outside of the Latin1 range.",
      );
    }
    const n = (c0 << 16) | ((isNaN(c1) ? 0 : c1) << 8) | (isNaN(c2) ? 0 : c2);
    out += BASE64_CHARS[(n >> 18) & 63];
    out += BASE64_CHARS[(n >> 12) & 63];
    out += i + 1 < binary.length ? BASE64_CHARS[(n >> 6) & 63] : "=";
    out += i + 2 < binary.length ? BASE64_CHARS[n & 63] : "=";
  }
  return out;
}

function atobPolyfill(b64: string): string {
  const clean = b64.replace(/[\t\n\f\r ]/g, "");
  const stripped = clean.replace(/=+$/, "");
  if (stripped.length % 4 === 1) {
    throw new DOMExceptionLike("Invalid base64 string.");
  }
  let out = "";
  let bits = 0;
  let value = 0;
  for (const ch of stripped) {
    const idx = BASE64_CHARS.indexOf(ch);
    if (idx < 0) throw new DOMExceptionLike("Invalid base64 string.");
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}

class DOMExceptionLike extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCharacterError";
  }
}

export function installPolyfills(): void {
  if (typeof g.TextEncoder !== "function") {
    g.TextEncoder = PolyfillTextEncoder;
  }
  if (typeof g.TextDecoder !== "function") {
    g.TextDecoder = PolyfillTextDecoder;
  }
  if (typeof g.crypto === "undefined") {
    g.crypto = { subtle: new PolyfillSubtleCrypto() };
  } else if (typeof g.crypto.subtle === "undefined") {
    g.crypto.subtle = new PolyfillSubtleCrypto();
  }
  if (typeof g.atob !== "function") g.atob = atobPolyfill;
  if (typeof g.btoa !== "function") g.btoa = btoaPolyfill;
}

installPolyfills();
