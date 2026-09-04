// Bidirectional mapping between wast-JSON `Value` (harness/src/schema.ts —
// scalars as decimal strings, floats as bit patterns) and the runtime's
// `ComponentValue` (runtime/src/cabi/types.ts — definitions.py's semantics in
// our own representation, contracts/descriptor-ir.md §"Host value shapes":
// variant/enum/option/result as `{kind: label, value: payload}` objects with
// despecialized labels `none`/`some`/`ok`/`error`, tuple as despecialized
// record `{"0": v, ...}`, flags as `{label: boolean}`).
//
// Every wast-JSON `Value` is self-describing (`type`/`case`/`status` fields
// carry the type), so converting an *argument* list needs no separate
// FuncType — the value's own tag says how to build the ComponentValue.
// Comparing an *actual* ComponentValue against an `assert_return` expected
// value works the same way: the expected value's tag drives the comparison
// (including bit-exact float compares and NaN pattern classes), so no
// FuncType is needed there either — matching how `RuntimeExecutor` invokes
// exports as plain JS functions (`component.exports[field](...)`) without
// ever seeing a `FuncType` itself (see `runtime/src/exec/boundary.ts`
// `createLiftedFunction`, which resolves it internally).

import type { RecordField, Value } from "./schema.ts";

const scratch = new DataView(new ArrayBuffer(8));

function f32FromBits(bits: bigint | number): number {
  scratch.setUint32(0, Number(bits) >>> 0, true);
  return scratch.getFloat32(0, true);
}

function f64FromBits(bits: bigint): number {
  scratch.setBigUint64(0, BigInt.asUintN(64, bits), true);
  return scratch.getFloat64(0, true);
}

function f32ToBits(f: number): number {
  scratch.setFloat32(0, f, true);
  return scratch.getUint32(0, true);
}

function f64ToBits(f: number): bigint {
  scratch.setFloat64(0, f, true);
  return scratch.getBigUint64(0, true);
}

// definitions.py deterministic-profile NaN classes (also runtime/src/cabi
// canonicalizes every NaN it produces to exactly CANONICAL_FLOAT{32,64}_NAN
// — sign 0, quiet bit set, no other payload — so `nan:arithmetic` and
// `nan:canonical` are equivalent in practice for this runtime; both are
// accepted per-class for forward compatibility with a less-deterministic
// engine).
function isCanonicalNan32(bits: number): boolean {
  return (bits & 0x7fffffff) === 0x7fc00000;
}
function isArithmeticNan32(bits: number): boolean {
  return ((bits >>> 23) & 0xff) === 0xff && (bits & 0x400000) !== 0;
}
function isCanonicalNan64(bits: bigint): boolean {
  return (bits & 0x7fffffffffffffffn) === 0x7ff8000000000000n;
}
function isArithmeticNan64(bits: bigint): boolean {
  return ((bits >> 52n) & 0x7ffn) === 0x7ffn && (bits & (1n << 51n)) !== 0n;
}

/** Convert a wast-JSON scalar/compound Value into a runtime ComponentValue,
 * for use as an invoke argument. */
// deno-lint-ignore no-explicit-any
export function toComponentValue(v: Value): any {
  switch (v.type) {
    case "bool":
      return v.value === "true";
    case "u8":
    case "u16":
    case "u32":
    case "s8":
    case "s16":
    case "s32":
    case "i32":
      return Number(v.value as string);
    case "u64":
    case "s64":
    case "i64":
      return BigInt(v.value as string);
    case "f32":
      return f32FromBits(BigInt(v.value as string));
    case "f64":
      return f64FromBits(BigInt(v.value as string));
    case "char":
    case "string":
      return v.value as string;
    case "enum":
      return { kind: v.value as string, value: null };
    case "list":
    case "tuple": {
      const items = (v.value as Value[]).map(toComponentValue);
      if (v.type === "tuple") {
        const record: Record<string, unknown> = {};
        items.forEach((it, i) => record[String(i)] = it);
        return record;
      }
      return items;
    }
    case "record": {
      const record: Record<string, unknown> = {};
      for (const f of v.value as RecordField[]) {
        record[f.name] = toComponentValue(f.value);
      }
      return record;
    }
    case "variant": {
      const payload = v.value === null
        ? null
        : toComponentValue(v.value as unknown as Value);
      return { kind: v.case as string, value: payload };
    }
    case "option":
      return v.value === null
        ? { kind: "none", value: null }
        : { kind: "some", value: toComponentValue(v.value as unknown as Value) };
    case "result": {
      const payload = v.value === null
        ? null
        : toComponentValue(v.value as unknown as Value);
      // Internal spelling of the error case is "error", not "err"
      // (contracts/descriptor-ir.md §"Host value shapes").
      return { kind: v.status === "ok" ? "ok" : "error", value: payload };
    }
    case "flags": {
      const set = new Set(v.value as string[]);
      const record: Record<string, boolean> = {};
      for (const label of set) record[label] = true;
      return record;
    }
    default:
      throw new Error(`toComponentValue: unsupported value type '${v.type}'`);
  }
}

/**
 * Compare an `assert_return`-expected wast-JSON Value against the runtime's
 * actual ComponentValue. Returns undefined on match, a diagnostic string on
 * mismatch. Bit-exact for floats (decoding the expected bit-pattern string,
 * or matching a NaN pattern class for `nan:canonical`/`nan:arithmetic`).
 */
export function compareValue(
  expected: Value,
  actual: unknown,
  path = "",
): string | undefined {
  const where = path || "<root>";
  switch (expected.type) {
    case "bool": {
      const want = expected.value === "true";
      return actual === want
        ? undefined
        : `${where}: expected bool ${want}, got ${JSON.stringify(actual)}`;
    }
    case "u8":
    case "u16":
    case "u32":
    case "s8":
    case "s16":
    case "s32":
    case "i32": {
      const want = Number(expected.value as string);
      return actual === want
        ? undefined
        : `${where}: expected ${expected.type} ${want}, got ${
          JSON.stringify(actual)
        }`;
    }
    case "u64":
    case "s64":
    case "i64": {
      const want = BigInt(expected.value as string);
      return actual === want
        ? undefined
        : `${where}: expected ${expected.type} ${want}, got ${
          JSON.stringify(String(actual))
        }`;
    }
    case "f32": {
      if (typeof actual !== "number") {
        return `${where}: expected f32 number, got ${typeof actual}`;
      }
      const bits = f32ToBits(actual);
      const raw = expected.value as string;
      if (raw === "nan:canonical") {
        return isCanonicalNan32(bits)
          ? undefined
          : `${where}: expected nan:canonical, got bits 0x${
            bits.toString(16)
          }`;
      }
      if (raw === "nan:arithmetic") {
        return isArithmeticNan32(bits)
          ? undefined
          : `${where}: expected nan:arithmetic, got bits 0x${
            bits.toString(16)
          }`;
      }
      const want = Number(raw) >>> 0;
      return bits === want
        ? undefined
        : `${where}: expected f32 bits 0x${want.toString(16)}, got 0x${
          bits.toString(16)
        }`;
    }
    case "f64": {
      if (typeof actual !== "number") {
        return `${where}: expected f64 number, got ${typeof actual}`;
      }
      const bits = f64ToBits(actual);
      const raw = expected.value as string;
      if (raw === "nan:canonical") {
        return isCanonicalNan64(bits)
          ? undefined
          : `${where}: expected nan:canonical, got bits 0x${
            bits.toString(16)
          }`;
      }
      if (raw === "nan:arithmetic") {
        return isArithmeticNan64(bits)
          ? undefined
          : `${where}: expected nan:arithmetic, got bits 0x${
            bits.toString(16)
          }`;
      }
      const want = BigInt.asUintN(64, BigInt(raw));
      return bits === want
        ? undefined
        : `${where}: expected f64 bits 0x${want.toString(16)}, got 0x${
          bits.toString(16)
        }`;
    }
    case "char":
    case "string": {
      return actual === expected.value
        ? undefined
        : `${where}: expected ${JSON.stringify(expected.value)}, got ${
          JSON.stringify(actual)
        }`;
    }
    case "enum": {
      if (typeof actual !== "object" || actual === null) {
        return `${where}: expected enum object, got ${JSON.stringify(actual)}`;
      }
      const label = (actual as Record<string, unknown>).kind;
      return label === expected.value
        ? undefined
        : `${where}: expected enum '${expected.value}', got '${label}'`;
    }
    case "list": {
      const items = expected.value as Value[];
      // list<u8> lifts as a Uint8Array (docs/architecture.md §7); accept both.
      const arr = actual instanceof Uint8Array
        ? Array.from(actual)
        : actual;
      if (!Array.isArray(arr)) {
        return `${where}: expected list array, got ${JSON.stringify(actual)}`;
      }
      if (arr.length !== items.length) {
        return `${where}: expected list length ${items.length}, got ${arr.length}`;
      }
      for (let i = 0; i < items.length; i++) {
        const m = compareValue(items[i], arr[i], `${where}[${i}]`);
        if (m !== undefined) return m;
      }
      return undefined;
    }
    case "tuple": {
      const items = expected.value as Value[];
      if (typeof actual !== "object" || actual === null) {
        return `${where}: expected tuple record, got ${JSON.stringify(actual)}`;
      }
      const rec = actual as Record<string, unknown>;
      for (let i = 0; i < items.length; i++) {
        const m = compareValue(items[i], rec[String(i)], `${where}.${i}`);
        if (m !== undefined) return m;
      }
      return undefined;
    }
    case "record": {
      const fields = expected.value as RecordField[];
      if (typeof actual !== "object" || actual === null) {
        return `${where}: expected record object, got ${JSON.stringify(actual)}`;
      }
      const rec = actual as Record<string, unknown>;
      for (const f of fields) {
        const m = compareValue(f.value, rec[f.name], `${where}.${f.name}`);
        if (m !== undefined) return m;
      }
      return undefined;
    }
    case "variant": {
      if (typeof actual !== "object" || actual === null) {
        return `${where}: expected variant object, got ${JSON.stringify(actual)}`;
      }
      const rec = actual as Record<string, unknown>;
      const label = rec.kind;
      if (typeof label !== "string") {
        return `${where}: expected a { kind, value } variant object, got ${
          JSON.stringify(actual)
        }`;
      }
      if (label !== expected.case) {
        return `${where}: expected variant case '${expected.case}', got '${label}'`;
      }
      if (expected.value === null) return undefined;
      return compareValue(
        expected.value as unknown as Value,
        rec.value,
        `${where}.${label}`,
      );
    }
    case "option": {
      if (typeof actual !== "object" || actual === null) {
        return `${where}: expected option object, got ${JSON.stringify(actual)}`;
      }
      const rec = actual as Record<string, unknown>;
      if (expected.value === null) {
        return rec.kind === "none"
          ? undefined
          : `${where}: expected none, got ${JSON.stringify(actual)}`;
      }
      if (rec.kind !== "some") {
        return `${where}: expected some(...), got ${JSON.stringify(actual)}`;
      }
      return compareValue(expected.value as unknown as Value, rec.value, `${where}.some`);
    }
    case "result": {
      if (typeof actual !== "object" || actual === null) {
        return `${where}: expected result object, got ${JSON.stringify(actual)}`;
      }
      const rec = actual as Record<string, unknown>;
      if (expected.status === "ok") {
        if (rec.kind !== "ok") {
          return `${where}: expected ok(...), got ${JSON.stringify(actual)}`;
        }
        if (expected.value === null) return undefined;
        return compareValue(expected.value as unknown as Value, rec.value, `${where}.ok`);
      }
      if (rec.kind !== "error") {
        return `${where}: expected error(...), got ${JSON.stringify(actual)}`;
      }
      if (expected.value === null) return undefined;
      return compareValue(
        expected.value as unknown as Value,
        rec.value,
        `${where}.error`,
      );
    }
    case "flags": {
      const want = new Set(expected.value as string[]);
      if (typeof actual !== "object" || actual === null) {
        return `${where}: expected flags object, got ${JSON.stringify(actual)}`;
      }
      const rec = actual as Record<string, boolean>;
      const got = new Set(
        Object.keys(rec).filter((k) => rec[k]),
      );
      if (want.size !== got.size || [...want].some((w) => !got.has(w))) {
        return `${where}: expected flags {${[...want].join(",")}}, got {${
          [...got].join(",")
        }}`;
      }
      return undefined;
    }
    default:
      return `${where}: unsupported expected value type '${expected.type}'`;
  }
}

/** Bigint-safe JSON.stringify substitute for error/diagnostic messages:
 * plain JSON.stringify throws on bigint (lifted i64 results are bigints).
 * Maps bigint -> "<n>n" and falls back to String(v) if stringify still
 * throws for some other reason (e.g. cyclic values). */
export function describeValue(v: unknown): string {
  try {
    return JSON.stringify(
      v,
      (_k, val) => typeof val === "bigint" ? `${val}n` : val,
    ) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Collapses a raw invoke() return by the export's *declared* arity
 * (from the plan's FuncType.results.length, see computeExportArities in
 * runtime-executor.ts), validating the observed shape against it per the
 * runtime's arity convention (`resultsToHost` in
 * runtime/src/exec/boundary.ts:327-331): 0 results -> undefined, 1 ->
 * bare value, 2+ -> array. Throws on a shape mismatch rather than
 * silently discarding or coercing (issue #188).
 *
 * Deliberate deviation from issue #188's suggested fix: for arity 1 the
 * issue suggests rejecting an array `raw`. That's wrong — a single
 * `list<T>`/tuple result IS legitimately a JS array, and disambiguating
 * "one result that happens to be an array" from "N results" is exactly
 * why computeExportArities (runtime-executor.ts:83-88) exists in the
 * first place. So arity 1 only requires `raw !== undefined` (a
 * ComponentValue is never undefined — runtime/src/cabi/types.ts:244-253),
 * with no shape restriction. */
export function collapseResultsByArity(
  raw: unknown,
  declaredArity: number | undefined,
  field: string,
): unknown[] {
  if (declaredArity === undefined) {
    // Defensive fallback only: the export wasn't found in the plan's
    // arity map. No declared shape to validate against.
    return raw === undefined ? [] : [raw];
  }
  if (declaredArity === 0) {
    if (raw !== undefined) {
      throw new Error(
        `invoke '${field}': declared 0 results but got ${describeValue(raw)}`,
      );
    }
    return [];
  }
  if (declaredArity === 1) {
    if (raw === undefined) {
      throw new Error(
        `invoke '${field}': declared 1 result but got undefined`,
      );
    }
    return [raw];
  }
  if (!Array.isArray(raw) || raw.length !== declaredArity) {
    const got = Array.isArray(raw)
      ? `array of length ${raw.length}`
      : describeValue(raw);
    throw new Error(
      `invoke '${field}': declared ${declaredArity} results but got ${got}`,
    );
  }
  return raw;
}

/** Compare an expected `Value[]` list against actual ComponentValue results
 * (per the runtime's arity convention: 0 results -> undefined, 1 -> bare
 * value, 2+ -> array — see `resultsToHost` in runtime/src/exec/boundary.ts). */
export function compareValues(
  expected: Value[],
  actual: unknown,
): string | undefined {
  let actualList: unknown[];
  if (expected.length === 0) {
    // Issue #188: don't vacuously pass — an unexpected actual value here
    // (e.g. a spurious result from an arity-0 export) must be reported.
    if (actual !== undefined) {
      return `expected 0 results, got ${describeValue(actual)}`;
    }
    actualList = [];
  } else if (expected.length === 1) {
    actualList = [actual];
  } else {
    if (!Array.isArray(actual)) {
      return `expected ${expected.length} results, got ${describeValue(actual)}`;
    }
    actualList = actual;
  }
  if (actualList.length !== expected.length) {
    return `expected ${expected.length} results, got ${actualList.length}`;
  }
  for (let i = 0; i < expected.length; i++) {
    const m = compareValue(expected[i], actualList[i], `result[${i}]`);
    if (m !== undefined) return m;
  }
  return undefined;
}
