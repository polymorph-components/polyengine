// Canonical world digest — TypeScript side, computed from a *wire* plan
// (runtime/src/plan/format.ts's `WirePlan`, i.e. the shim's plan.json
// schema — contracts/plan-format.md). Counterpart:
// crates/bindgen/src/digest.rs, computed from `wit_parser::Resolve`. Both
// must produce byte-identical canonical JSON (and therefore identical
// sha256) for supported world shapes (runtime/tests/digest_test.ts).
// The wire plan's own `worldDigest` field is legacy
// (contracts/plan-format.md), retained for wire compatibility only; this
// module computes the normative digest independently.
//
// Normalization is governed by contracts/digest.md, with the Rust counterpart
// in crates/bindgen/src/digest.rs. Short
// version: sort import/export lists by name; keep everything else
// (record fields, variant cases, enum/flags label order, function
// parameter order) positional because it's ABI-relevant; drop parameter
// *labels* (not ABI-relevant, this runtime has no named-argument calling
// convention) and all docs/stability metadata (not present in the plan at
// all); identify resources by qualified name, not by table index.
//
// Current implementation limits: imported resources are refused. With one
// named exported resource, every table index maps to that name. With multiple
// names, only directly named table indices are resolved; extra table aliases
// cause refusal. Unlike plan/loader.ts, this digest implementation does not
// use concrete tables' ResourceIndex to unify aliases. This is not a missing
// plan capability. Flat import names also do not reconstruct nested interfaces.

import type {
  WireExport,
  WireImport,
  WirePlan,
  WireTypeDecl,
  WireValType,
} from "../plan/format.ts";

// Version of the canonical `cewd` document, independent of plan formatVersion.
/** @internal */
export const CEWD_VERSION = 1;

/** @internal */
export class DigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestError";
  }
}

/** @internal */
export interface WorldDigestResult {
  canonicalJson: string;
  digest: string;
}

/** JSON value shape used for the canonical tree (plain data, no `undefined`). */
// deno-lint-ignore no-explicit-any
type Canon = any;

/**
 * Compute the canonical world digest from a loaded wire plan.
 * @internal
 */
export async function computeWorldDigest(
  plan: WirePlan,
): Promise<WorldDigestResult> {
  const resourceNames = buildResourceNameMap(plan);
  const imports = plan.imports.map((imp) =>
    canonImport(plan, imp, resourceNames)
  );
  const exports = plan.exports
    .map((exp) => canonExportItem(plan, exp, resourceNames))
    .filter((c): c is Canon => c !== null);
  const doc = {
    cewd: CEWD_VERSION,
    imports: sortByName(imports),
    exports: sortByName(exports),
  };
  const canonicalJson = canonicalStringify(doc);
  const digestBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson),
  );
  const digest = "sha256:" + hex(digestBytes);
  return { canonicalJson, digest };
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

// ---------------------------------------------------------------------------
// Resource naming (plan resourceTables index -> qualified name)
// ---------------------------------------------------------------------------

function buildResourceNameMap(plan: WirePlan): Map<number, string> {
  // This implementation names exported resources only. Refuse imports
  // rather than accidentally assign them the single exported name below.
  if (
    plan.importedResources !== undefined && plan.importedResources.length > 0
  ) {
    throw new DigestError(
      `digest: plan declares ${plan.importedResources.length} imported ` +
        `resource(s); resolving which own/borrow occurrences reference an ` +
        `imported resource (vs. a defined/exported one) requires an ` +
        `alias map this plan format does not yet provide (see ` +
        `runtime/src/digest/digest.ts module docs) — refusing rather than ` +
        `risk a silently-wrong digest`,
    );
  }

  const named = new Map<number, string>(); // resourceTables index -> name, as directly declared by a type export
  walkExportsForResourceNames(plan.exports, [], named);

  if (named.size <= 1) {
    // Single-name fallback: all tables receive that name. This does not
    // prove that unnamed tables denote the same nominal resource.
    const theOne = named.size === 1 ? [...named.values()][0] : undefined;
    const all = new Map<number, string>();
    if (theOne !== undefined) {
      for (let i = 0; i < plan.resourceTables.length; i++) all.set(i, theOne);
    }
    return all;
  }
  // Multiple names: this implementation cannot attribute extra table aliases.
  if (named.size < plan.resourceTables.length) {
    throw new DigestError(
      `digest: world has ${named.size} named resource type(s) but ` +
        `${plan.resourceTables.length} resourceTables entries, and more ` +
        `than one named resource — resourceTables alias resolution across ` +
        `component-linking instance boundaries is not implemented (see ` +
        `runtime/src/digest/digest.ts module docs); cannot safely identify ` +
        `which own/borrow occurrence means which resource`,
    );
  }
  return named;
}

function walkExportsForResourceNames(
  exports: WireExport[],
  path: string[],
  out: Map<number, string>,
): void {
  for (const exp of exports) {
    if (exp.kind === "instance") {
      walkExportsForResourceNames(exp.exports, [...path, exp.name], out);
    } else if (exp.kind === "type" && exp.type.kind === "resource") {
      out.set(exp.type.resource, [...path, exp.name].join("/"));
    }
  }
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

function canonImport(
  plan: WirePlan,
  imp: WireImport,
  resourceNames: Map<number, string>,
): Canon {
  // Flatten path segments followed by import name. This does not reconstruct
  // bindgen's nested interface items; interface-qualified imports can therefore
  // produce a digest mismatch even when their function signatures agree.
  const name = imp.path.length > 0
    ? [...imp.path, imp.name].join("/")
    : imp.name;
  if (imp.kind === "func" && imp.type !== undefined) {
    return {
      kind: "func",
      name,
      func: canonFuncType(plan, plan.types[imp.type], resourceNames),
    };
  }
  return { kind: imp.kind, name };
}

function canonExportItem(
  plan: WirePlan,
  exp: WireExport,
  resourceNames: Map<number, string>,
): Canon | null {
  if (exp.kind === "lifted-func") {
    return {
      kind: "func",
      name: exp.name,
      func: canonFuncType(plan, plan.types[exp.type], resourceNames),
    };
  }
  if (exp.kind === "instance") {
    return {
      kind: "instance",
      name: exp.name,
      items: sortByName(
        exp.exports
          .map((e) => canonExportItem(plan, e, resourceNames))
          .filter((c): c is Canon => c !== null),
      ),
    };
  }
  if (exp.kind === "module") {
    // digest.md's item rule: only functions and resources contribute as
    // export items. A module export is not WIT-expressible (bindgen can
    // never emit a digest containing one) and does not affect
    // positional-calling ABI shape, so it is excluded — the `module` export
    // kind (contracts/plan-format.md schema notes).
    return null;
  }
  // exp.kind === "type"
  if (exp.type.kind === "resource") {
    return { kind: "resource", name: exp.name };
  }
  // Non-resource type exports contribute through function signatures, not
  // as standalone digest items, matching bindgen's canon_interface/canon_items.
  return null;
}

function canonFuncType(
  _plan: WirePlan,
  decl: WireTypeDecl,
  resourceNames: Map<number, string>,
): Canon {
  if (decl.kind !== "func") {
    throw new DigestError(
      `digest: expected a func type declaration, got kind ${decl.kind}`,
    );
  }
  return {
    // Parameter LABELS excluded deliberately (see module docs); only
    // positional types survive into the digest.
    params: decl.params.map((p) => canonValType(p.type, resourceNames)),
    results: decl.results.map((r) => canonValType(r, resourceNames)),
    async: decl.async,
  };
}

function canonValType(
  t: WireValType,
  resourceNames: Map<number, string>,
): Canon {
  switch (t.kind) {
    case "bool":
    case "s8":
    case "u8":
    case "s16":
    case "u16":
    case "s32":
    case "u32":
    case "s64":
    case "u64":
    case "f32":
    case "f64":
    case "char":
    case "string":
    case "error-context":
      return { kind: t.kind };
    case "list":
      return {
        kind: "list",
        element: canonValType(t.element, resourceNames),
        ...(t.length !== undefined ? { length: t.length } : {}),
      };
    case "record":
      return {
        kind: "record",
        fields: t.fields.map((f) => ({
          label: f.label,
          type: canonValType(f.type, resourceNames),
        })),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: t.elements.map((e) => canonValType(e, resourceNames)),
      };
    case "variant":
      return {
        kind: "variant",
        cases: t.cases.map((c) => ({
          label: c.label,
          type: c.type === null ? null : canonValType(c.type, resourceNames),
        })),
      };
    case "enum":
      return { kind: "enum", labels: [...t.labels] };
    case "option":
      return { kind: "option", type: canonValType(t.type, resourceNames) };
    case "result":
      return {
        kind: "result",
        ok: t.ok === null ? null : canonValType(t.ok, resourceNames),
        err: t.err === null ? null : canonValType(t.err, resourceNames),
      };
    case "map":
      // Match bindgen's TypeDefKind::Map normalization to list<tuple<K,V>>.
      return {
        kind: "list",
        element: {
          kind: "tuple",
          elements: [
            canonValType(t.key, resourceNames),
            canonValType(t.value, resourceNames),
          ],
        },
      };
    case "flags":
      return { kind: "flags", labels: [...t.labels] };
    case "own":
    case "borrow": {
      const name = resourceNames.get(t.resource);
      if (name === undefined) {
        throw new DigestError(
          `digest: ${t.kind}<T> references resourceTables[${t.resource}], ` +
            `which has no resolvable qualified name`,
        );
      }
      return { kind: t.kind, resource: name };
    }
    case "stream":
      return {
        kind: "stream",
        element: t.element === null
          ? null
          : canonValType(t.element, resourceNames),
      };
    case "future":
      return {
        kind: "future",
        element: t.element === null
          ? null
          : canonValType(t.element, resourceNames),
      };
    default: {
      const exhaustive: never = t;
      throw new DigestError(
        `digest: unknown ValType kind ${(exhaustive as WireValType).kind}`,
      );
    }
  }
}

function sortByName(items: Canon[]): Canon[] {
  // `<`/`>` here is UTF-16 code-unit ordering (no `localeCompare`); the Rust
  // side (`crates/bindgen/src/digest.rs::sort_by_name`) uses `str::cmp`
  // (byte-wise/UTF-8). These orderings diverge in general, but WIT
  // identifiers are ASCII-only (kebab-case `[a-z0-9-]`), where byte-wise and
  // UTF-16-code-unit ordering coincide — so this is not a latent bug; don't
  // "fix" one side alone if that assumption changes.
  return [...items].sort((a, b) => {
    const an = typeof a?.name === "string" ? a.name : "";
    const bn = typeof b?.name === "string" ? b.name : "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/**
 * Recursively sort object keys (alphabetically) and serialize with no extra
 * whitespace. Array order is preserved verbatim — this must match
 * `crates/bindgen/src/digest.rs::canonical_string` byte-for-byte.
 * @internal
 */
export function canonicalStringify(v: unknown): string {
  return JSON.stringify(sortKeysDeep(v));
}

// deno-lint-ignore no-explicit-any
function sortKeysDeep(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}
