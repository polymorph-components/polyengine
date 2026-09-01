// `requiredImports()` — the supported enumeration of a component's linkable
// import leaves (contracts/embedder-api.md §"Module wiring and
// instantiation").
//
// `plan.imports` proved the right authority, and every embedder
// that needed it would otherwise hand-roll the same walk.
// Blessing it removes that. It is also this layer's own input: the facade
// builds its import wrappers from exactly this list.

import type { WirePlan } from "../plan/format.ts";
import { loadPlan } from "../plan/loader.ts";
import type { LoadedPlan } from "../plan/loader.ts";
import type { ValType } from "../cabi/types.ts";
import { camelCase, type LeafName, parseLeafName, pascalCase } from "./casing.ts";

/** Function type summary of an import leaf (names are docs-only; §"Functions"). */
export interface FuncSummary {
  params: { name: string; type: ValType }[];
  results: ValType[];
  /** True for an `async func` — an import may then be a plain async function. */
  async: boolean;
}

/** One linkable import leaf. */
export interface ImportLeaf {
  /**
   * The record key this leaf is provided under: a fully-qualified WIT
   * interface id verbatim (version included) for interface imports, or the
   * component's bare world-level import name.
   */
  interfaceId: string;
  /** Path from the record key to the leaf, verbatim (mangled names included). */
  path: string[];
  /** The raw, still-mangled leaf name (`[method]counter.increment`). */
  leaf: string;
  /** `func`, `resource`, `instance`, … — the plan's own kind string. */
  kind: string;
  /** Decoded resource membership of `leaf`. */
  member: LeafName;
  /**
   * The JS name this leaf is looked up under: camelCase for functions and
   * world-level imports, PascalCase for a resource *type* (the class), and —
   * for a mangled leaf — the JS name of the class **member** it dispatches to.
   */
  jsName: string;
  /** For a mangled leaf: the PascalCase class it belongs to. */
  jsClass?: string;
  /** Present for `kind === "func"`. */
  type?: FuncSummary;
}

/** Anything `requiredImports` accepts. */
export type PlanLike = WirePlan | LoadedPlan | { plan: WirePlan };

function toLoaded(input: PlanLike): LoadedPlan {
  if ("wire" in input && "types" in input) return input as LoadedPlan;
  const wire = "plan" in input ? (input as { plan: WirePlan }).plan : input;
  return loadPlan(wire as WirePlan);
}

/** Enumerate the component's linkable import leaves. */
export function requiredImports(input: PlanLike): ImportLeaf[] {
  const loaded = toLoaded(input);
  return loaded.wire.imports.map((imp) => {
    const leaf = imp.path.length === 0
      ? imp.name
      : imp.path[imp.path.length - 1];
    const member = parseLeafName(leaf);
    const out: ImportLeaf = {
      interfaceId: imp.name,
      path: [...imp.path],
      leaf,
      kind: imp.kind,
      member,
      jsName: jsNameOf(member, imp.kind),
    };
    if (member.form !== "plain") out.jsClass = pascalCase(member.resource);
    if (imp.type !== undefined) {
      const t = loaded.types[imp.type];
      if (t !== undefined && t.kind === "func") {
        out.type = {
          params: t.funcType.params.map((p, i) => ({
            name: t.paramNames[i] ?? String(i),
            type: p,
          })),
          results: t.funcType.results,
          async: t.funcType.async === true,
        };
      }
    }
    return out;
  });
}

function jsNameOf(member: LeafName, kind: string): string {
  switch (member.form) {
    case "plain":
      return kind === "resource"
        ? pascalCase(member.name)
        : camelCase(member.name);
    case "constructor":
      return "constructor";
    case "method":
    case "static":
      return camelCase(member.member);
  }
}
