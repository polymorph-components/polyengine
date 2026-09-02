// Flattening (definitions.py `## Flattening`): component function types to
// core function signatures, and component value types to flat core types.

import {
  type CaseType,
  type CoreFuncType,
  type CoreType,
  despecialize,
  discriminantType,
  type FieldType,
  type FuncType,
  type ValType,
} from "./types.ts";
import type { CanonicalOptions, LiftOptions } from "./context.ts";
import { requireMemory } from "./context.ts";

export const MAX_FLAT_PARAMS = 16;
export const MAX_FLAT_ASYNC_PARAMS = 4;
export const MAX_FLAT_RESULTS = 1;

export type FlattenContext = "lift" | "lower";

export function flattenFunctype(
  opts: CanonicalOptions,
  ft: FuncType,
  context: FlattenContext,
): CoreFuncType {
  let flatParams = flattenTypes(ft.params, opts);
  let flatResults = flattenTypes(ft.results, opts);
  if (!opts.async_) {
    if (flatParams.length > MAX_FLAT_PARAMS) {
      flatParams = [requireMemory(opts).ptrType()];
    }
    if (flatResults.length > MAX_FLAT_RESULTS) {
      switch (context) {
        case "lift":
          flatResults = [requireMemory(opts).ptrType()];
          break;
        case "lower":
          flatParams = [...flatParams, requireMemory(opts).ptrType()];
          flatResults = [];
          break;
      }
    }
    return { params: flatParams, results: flatResults };
  } else {
    switch (context) {
      case "lift":
        if (flatParams.length > MAX_FLAT_PARAMS) {
          flatParams = [requireMemory(opts).ptrType()];
        }
        if (opts.callback) {
          flatResults = ["i32"];
        } else {
          flatResults = [];
        }
        break;
      case "lower":
        if (flatParams.length > MAX_FLAT_ASYNC_PARAMS) {
          flatParams = [requireMemory(opts).ptrType()];
        }
        if (flatResults.length > 0) {
          flatParams = [...flatParams, requireMemory(opts).ptrType()];
        }
        flatResults = ["i32"];
        break;
    }
    return { params: flatParams, results: flatResults };
  }
}

export function flattenTypes(ts: ValType[], opts: LiftOptions): CoreType[] {
  return ts.flatMap((t) => flattenType(t, opts));
}

export function flattenType(t: ValType, opts: LiftOptions): CoreType[] {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
    case "u8":
    case "u16":
    case "u32":
    case "s8":
    case "s16":
    case "s32":
    case "char":
      return ["i32"];
    case "s64":
    case "u64":
      return ["i64"];
    case "f32":
      return ["f32"];
    case "f64":
      return ["f64"];
    case "string": {
      const pt = requireMemory(opts).ptrType();
      return [pt, pt];
    }
    case "error-context":
      return ["i32"];
    case "list":
      return flattenList(d.element, d.length ?? null, opts);
    case "record":
      return flattenRecord(d.fields, opts);
    case "variant":
      return flattenVariant(d.cases, opts);
    case "flags":
      return ["i32"];
    case "own":
    case "borrow":
    case "stream":
    case "future":
      return ["i32"];
  }
}

export function flattenList(
  elemType: ValType,
  maybeLength: number | null,
  opts: LiftOptions,
): CoreType[] {
  if (maybeLength !== null) {
    const flat: CoreType[] = [];
    const one = flattenType(elemType, opts);
    for (let i = 0; i < maybeLength; i++) flat.push(...one);
    return flat;
  }
  const pt = requireMemory(opts).ptrType();
  return [pt, pt];
}

export function flattenRecord(
  fields: FieldType[],
  opts: LiftOptions,
): CoreType[] {
  const flat: CoreType[] = [];
  for (const f of fields) flat.push(...flattenType(f.type, opts));
  return flat;
}

export function flattenVariant(
  cases: CaseType[],
  opts: LiftOptions,
): CoreType[] {
  const flat: CoreType[] = [];
  for (const c of cases) {
    if (c.type !== null) {
      flattenType(c.type, opts).forEach((ft, i) => {
        if (i < flat.length) {
          flat[i] = join(flat[i], ft);
        } else {
          flat.push(ft);
        }
      });
    }
  }
  return [...flattenType(discriminantType(cases), opts), ...flat];
}

export function join(a: CoreType, b: CoreType): CoreType {
  if (a === b) return a;
  if ((a === "i32" && b === "f32") || (a === "f32" && b === "i32")) {
    return "i32";
  }
  return "i64";
}
