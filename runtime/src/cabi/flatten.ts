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

/**
 * `flattenTypes(ts, opts).length`, memoized on (ts array identity, ptrType).
 *
 * Every arm of `flattenType` reaches `opts` only through
 * `requireMemory(opts).ptrType()` (string/list-without-length read the
 * pointer width; every other arm is opts-free or recurses structurally), so
 * the flattened element count is a pure function of `(ts, ptrType)` — one
 * map per pointer width is the whole of the cache key. `ts` is always a
 * plan-owned `ft.params`/`ft.results` array, the same stability argument
 * `spillTupleType` (values.ts) relies on, so its identity is a valid key.
 *
 * This caches the COUNT, not the flattened array: `values.ts`'s only use of
 * `flattenTypes` on the per-call path is `.length`, and a cached number has
 * no aliasing/mutation hazard to guard (a cached array would need freezing
 * plus a lossy `readonly`-to-mutable cast at every read site — the shape
 * this replaced). Callers that need the actual flat types (instantiate-time
 * `flattenFunctype`) still call `flattenTypes` directly, uncached; that path
 * runs once per function, not once per call, so it doesn't need this.
 *
 * The null-memory path is deliberately NOT cached: `requireMemory` throws
 * when `opts.memory` is null (for any `ts` containing a string/unbounded
 * list), and that throw must still surface on every call, not just the
 * first.
 */
const flatCountCacheByPtrType = {
  i32: new WeakMap<ValType[], number>(),
  i64: new WeakMap<ValType[], number>(),
};

export function flatCount(ts: ValType[], opts: LiftOptions): number {
  const mem = opts.memory;
  if (mem === null) return flattenTypes(ts, opts).length;
  const cache = flatCountCacheByPtrType[mem.ptrType()];
  const hit = cache.get(ts);
  if (hit !== undefined) return hit;
  const count = flattenTypes(ts, opts).length;
  cache.set(ts, count);
  return count;
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
