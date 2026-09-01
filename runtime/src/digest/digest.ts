// Canonical world digest — TypeScript side, computed from a *wire* plan
// (runtime/src/plan/format.ts's `WirePlan`, i.e. the shim's plan.json
// schema — contracts/plan-format.md). Counterpart:
// crates/bindgen/src/digest.rs, computed from `wit_parser::Resolve`. Both
// must produce byte-identical canonical JSON (and therefore identical
// sha256) for a structurally-equivalent world — this equality IS the
// design validation (see runtime/tests/digest_test.ts's cross-language
// fixture test). The wire plan's own `worldDigest` field is legacy
// (contracts/plan-format.md), retained for wire compatibility only; this
// module computes the normative digest independently.
//
// THE NORMALIZATION SPEC IS DOCUMENTED ONCE, in crates/bindgen/src/digest.rs's
// module doc comment (kept in sync with this file) — read it first. Short
// version: sort import/export lists by name; keep everything else
// (record fields, variant cases, enum/flags label order, function
// parameter order) positional because it's ABI-relevant; drop parameter
// *labels* (not ABI-relevant, this runtime has no named-argument calling
// convention) and all docs/stability metadata (not present in the plan at
// all); identify resources by qualified name, not by table index.
//
// ## Known limitation (plan side only): resourceTables aliasing
//
// The plan's `own`/`borrow` `resource: N` indexes into `resourceTables`,
// and empirically (the `resources` fixture) an `own`/`borrow` occurrence in
// an exported function's type and the `{kind:"type"}` export that *names*
// that same nominal resource can reference two *different* resourceTables
// indices (one per component-linking instance boundary — the type export
// sits at the sub-instance that defines the resource, `own`/`borrow` sites
// reference the root instance's re-export of it). Resolving this in
// general requires walking wasmtime's resource-alias chain, which the plan
// format does not expose directly — this is exactly the "impedance between
// wit-parser's view and the plan's types" flagged for the §9 degraded-mode
// question in the track report. This implementation takes an honest
// shortcut: when a world has exactly one nominal resource type, every
// `own`/`borrow` occurrence (regardless of table index) is identified with
// that resource — correct for every world in the current fixture corpus
// (each has 0 or 1 resource types), but a world with 2+ resources throws a
// clearly-labeled `DigestError` rather than silently guessing.

import type {
  WireExport,
  WireImport,
  WirePlan,
  WireTypeDecl,
  WireValType,
} from "../plan/format.ts";

// cewd = component-engine world digest, the project's pre-rebrand name; kept as an opaque wire constant.
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
  const imports = plan.imports.map((imp) => canonImport(plan, imp, resourceNames));
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
  // CONTRACT: the `importedResources` field (contracts/plan-format.md
  // schema; format.ts:23-33). An imported resource occupies
  // `ResourceIndex` slots *before* every defined (own/exported) resource
  // (`ResourceIndex = importedResources.length + DefinedResourceIndex`), and
  // this implementation has no alias map from those imported-resource
  // indices to a qualified name (no plan-format extension exists yet for
  // that — see the module-level "Known limitation" comment). Silently
  // aliasing an own/borrow reference to an imported resource with the lone
  // exported resource's name (the pre-fix single-resource-world shortcut
  // below) would produce a digest that matches a WIT world it is NOT
  // ABI-compatible with — worse than an unresolved-index throw. Refuse
  // conservatively whenever the plan declares any imported resources, full
  // stop, regardless of how many named (exported) resources exist.
  if (plan.importedResources !== undefined && plan.importedResources.length > 0) {
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
    // Single-resource (or zero-resource) world: identify EVERY resourceTables
    // index with the one named resource, sidestepping the aliasing gap
    // documented in the module comment above.
    const theOne = named.size === 1 ? [...named.values()][0] : undefined;
    const all = new Map<number, string>();
    if (theOne !== undefined) {
      for (let i = 0; i < plan.resourceTables.length; i++) all.set(i, theOne);
    }
    return all;
  }
  // Multi-resource world: table-index aliasing across instance boundaries
  // is not resolved by this implementation. Fail loudly.
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
  // CONTRACT: the plan's `imports` list is flat (`{name, path, kind, type}`)
  // even for interface-qualified imports (`imports[].path`,
  // contracts/plan-format.md schema — "Untested: current corpus has no
  // imports"); no fixture in this repo's
  // sync corpus (hello/values/resources) has any imports, so this path is
  // exercised by no test. Best-effort flattened-name treatment, chosen to
  // be structurally analogous to the export side's nested naming without
  // requiring the executor to reconstruct nested WorldItem::Interface shape
  // from a flat list. Revisit when a corpus component actually imports
  // something (flagged in the track report for §9's degraded-mode
  // question).
  const name = imp.path.length > 0 ? [...imp.path, imp.name].join("/") : imp.name;
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
  // Non-resource named types (records/variants/etc. declared at
  // interface/world scope) do not themselves appear as component exports —
  // only functions and resources do — so they are intentionally NOT
  // emitted as a top-level item here; they still affect the digest via
  // whichever function signatures reference them. Mirrors
  // crates/bindgen/src/digest.rs's `canon_interface`/`canon_items` (both
  // skip non-resource `TypeDefKind` entries with the identical rationale).
  // Caller must filter these out of the containing list (see canonExportItem's
  // caller / the `null`-sentinel handling below), since this returns a
  // JSON value, not `undefined`, when called directly.
  return null;
}

function canonFuncType(
  plan: WirePlan,
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

function canonValType(t: WireValType, resourceNames: Map<number, string>): Canon {
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
      // Despecialized to list<tuple<K,V>> — matches crates/bindgen/src/
      // digest.rs's treatment of wit_parser's `TypeDefKind::Map`. Fixture-
      // only path (descriptor-ir.md "Open items": not emitted by current
      // translators), unexercised by the sync corpus.
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
        element: t.element === null ? null : canonValType(t.element, resourceNames),
      };
    case "future":
      return {
        kind: "future",
        element: t.element === null ? null : canonValType(t.element, resourceNames),
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
