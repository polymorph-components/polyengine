// Minimal assertion helpers (no external deps): deep equality tuned to the
// cabi value shapes (bigint, NaN, Uint8Array, `{kind, value}` variant objects).

import { Trap } from "../../src/cabi/mod.ts";

export function deepEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }
  if (typeof a !== typeof b) return false;
  if (
    a === null || b === null || typeof a === "bigint" ||
    typeof a === "string" || typeof a === "boolean" ||
    typeof a === "undefined"
  ) {
    return a === b;
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b))) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (!deepEqual(ka, kb)) return false;
    return ka.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    );
  }
  return false;
}

function show(v: unknown): string {
  if (typeof v === "bigint") return `${v}n`;
  if (v instanceof Uint8Array) return `Uint8Array([${[...v].join(",")}])`;
  if (Array.isArray(v)) return `[${v.map(show).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${
      Object.entries(v as object).map(([k, x]) => `${k}:${show(x)}`).join(",")
    }}`;
  }
  if (typeof v === "number" && Object.is(v, NaN)) return "NaN";
  return JSON.stringify(v) ?? String(v);
}

export function assertEq(got: unknown, want: unknown, msg = ""): void {
  if (!deepEqual(got, want)) {
    throw new Error(
      `${msg ? msg + ": " : ""}expected ${show(want)}, got ${show(got)}`,
    );
  }
}

export function assertTrap(fn: () => unknown, msg = ""): void {
  try {
    const got = fn();
    throw new Error(
      `${msg ? msg + ": " : ""}expected trap, got ${show(got)}`,
    );
  } catch (e) {
    if (e instanceof Trap) return;
    throw e;
  }
}
