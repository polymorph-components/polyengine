// Parser for the JSON type DSL shared with tests/fixtures/generate.py.
// Keep in lockstep with generate.py::build_type.

import {
  ResourceTableInfo,
  ResourceTypeInfo,
  type ValType,
} from "../../src/cabi/mod.ts";

const PRIMS = new Set([
  "bool",
  "u8",
  "s8",
  "u16",
  "s16",
  "u32",
  "s32",
  "u64",
  "s64",
  "f32",
  "f64",
  "char",
  "string",
]);

// Shared dummy resource type: fixtures only exercise layout/flatten of
// own/borrow, which ignore the resource identity.
export const dummyResourceType = new ResourceTableInfo(
  new ResourceTypeInfo(null),
);

// deno-lint-ignore no-explicit-any
export type TypeDsl = string | { [k: string]: any };

export function parseType(dsl: TypeDsl): ValType {
  if (typeof dsl === "string") {
    if (PRIMS.has(dsl)) return { kind: dsl } as ValType;
    if (dsl === "error-context") return { kind: "error-context" };
    throw new Error(`unknown prim ${dsl}`);
  }
  if ("list" in dsl) {
    const t: ValType = { kind: "list", element: parseType(dsl.list) };
    if (dsl.length !== undefined) {
      (t as { length?: number }).length = dsl.length;
    }
    return t;
  }
  if ("record" in dsl) {
    return {
      kind: "record",
      fields: (dsl.record as [string, TypeDsl][]).map(([label, t]) => ({
        label,
        type: parseType(t),
      })),
    };
  }
  if ("tuple" in dsl) {
    return {
      kind: "tuple",
      elements: (dsl.tuple as TypeDsl[]).map(parseType),
    };
  }
  if ("variant" in dsl) {
    return {
      kind: "variant",
      cases: (dsl.variant as [string, TypeDsl | null][]).map(([label, t]) => ({
        label,
        type: t === null ? null : parseType(t),
      })),
    };
  }
  if ("enum" in dsl) return { kind: "enum", labels: [...dsl.enum] };
  if ("enum-n" in dsl) {
    return {
      kind: "enum",
      labels: Array.from({ length: dsl["enum-n"] }, (_, i) => `c${i}`),
    };
  }
  if ("option" in dsl) return { kind: "option", type: parseType(dsl.option) };
  if ("result" in dsl) {
    const [ok, err] = dsl.result as [TypeDsl | null, TypeDsl | null];
    return {
      kind: "result",
      ok: ok === null ? null : parseType(ok),
      error: err === null ? null : parseType(err),
    };
  }
  if ("map" in dsl) {
    const [k, v] = dsl.map as [TypeDsl, TypeDsl];
    return { kind: "map", key: parseType(k), value: parseType(v) };
  }
  if ("flags" in dsl) return { kind: "flags", labels: [...dsl.flags] };
  if ("flags-n" in dsl) {
    return {
      kind: "flags",
      labels: Array.from({ length: dsl["flags-n"] }, (_, i) => `f${i}`),
    };
  }
  if ("own" in dsl) return { kind: "own", rt: dummyResourceType };
  if ("borrow" in dsl) return { kind: "borrow", rt: dummyResourceType };
  if ("stream" in dsl) {
    return {
      kind: "stream",
      element: dsl.stream === null ? null : parseType(dsl.stream),
    };
  }
  if ("future" in dsl) {
    return {
      kind: "future",
      element: dsl.future === null ? null : parseType(dsl.future),
    };
  }
  throw new Error(`unknown type dsl ${JSON.stringify(dsl)}`);
}
