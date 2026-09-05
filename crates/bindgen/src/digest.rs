//! Canonical world digest — Rust side (from `wit_parser::Resolve`).
//!
//! See `runtime/src/digest/digest.ts` for the TypeScript counterpart, which
//! must compute byte-identical canonical JSON (and therefore identical
//! sha256) from a *loaded plan* for the same WIT world. The full
//! normalization spec is documented in both files' module comments and is
//! the primary deliverable of this track (resolves the legacy shim
//! `worldDigest`, contracts/plan-format.md schema; the normative digest is
//! contracts/digest.md).
//!
//! ## Normalization spec (authoritative copy; keep in sync with digest.ts)
//!
//! Goal: two structurally-equivalent worlds — one parsed from WIT source,
//! one recovered from a translated component's plan — must hash identically,
//! *independent of*:
//!   - the order types happen to appear in either side's flat type table
//!     (WIT declaration order / wasmtime interning order) — NOT reflected in
//!     the digest at all, since the digest is built from a fresh recursive
//!     walk of only the *reachable* structural shape;
//!   - which numeric resource-table index a `own`/`borrow` happens to use —
//!     resources are identified by their declared qualified name instead;
//!   - import/export declaration order — both lists are sorted by name
//!     before hashing.
//!
//! What DOES affect the digest (i.e. is part of the "intersection" of
//! WIT-level and plan-level fidelity, since the plan is the lossier side):
//!   - import/export **names** (world-level function names, interface
//!     qualified names `ns:pkg/iface`, nested function/type names inside an
//!     interface);
//!   - **positional** structure that is ABI-relevant: record field order,
//!     tuple element order, variant/enum case order (discriminant
//!     assignment depends on it), flags label order (bit position depends
//!     on it), function parameter *order* (but not names — see below);
//!   - labels/case-names/field-names as strings (renaming a field is a
//!     structural, breaking change; despecialized forms are *not* used —
//!     tuple/enum/option/result keep their WIT-level kind, they are not
//!     folded into `record`/`variant` the way the interpreter's runtime
//!     despecializes them for lift/lower — see cabi/types.ts `despecialize`,
//!     which is a *runtime execution* detail, not a world-shape identity
//!     detail);
//!   - resource identity, keyed by qualified name (`iface/type-name`, or
//!     `world-name/type-name` for a resource declared directly in a world
//!     — untested by the current fixture corpus, all of which declare
//!     resources inside a named interface);
//!   - function `async` flag.
//!
//! What is explicitly EXCLUDED (documented "intersection" decisions):
//!   - **Function parameter labels.** WIT carries them; the plan's wire
//!     `FuncType.params` also carries them (`{label, type}[]`, the pinned
//!     wire↔memory divergences, contracts/descriptor-ir.md §"Value type
//!     model") — so they *do* survive to the
//!     plan. They are excluded anyway: renaming a parameter is not an ABI
//!     change (JS calls positionally; this runtime has no named-argument
//!     calling convention), so a digest that reacted to it would force a
//!     rebuild of generated bindings for a change with no behavioral
//!     consequence. Flagged as a deliberate normalization choice, not an
//!     "intersection" forced by data loss.
//!   - **Docs, `@since`/`@unstable` stability attributes, source spans.**
//!     Present in WIT, entirely absent from the plan (contracts/plan-format
//!     carries no docs — docs/architecture.md §9 says so explicitly: "docs are lost in
//!     binaries"). Bindgen embeds docs in generated output from WIT
//!     directly; they play no role in the skew-protection handshake since
//!     the handshake's job is ABI-shape equality, not doc-freshness.
//!   - **Package version** on the interface's own qualified name. WIT
//!     interfaces may carry `@1.2.3`; the component's export/import name
//!     string *does* include the version when present (component-model
//!     naming includes `@version` in the exported name), so in principle it
//!     is NOT lost — this implementation includes the version suffix
//!     verbatim as part of the `name` field precisely because it round-trips
//!     through both sides. (Listed here because it was considered for
//!     exclusion and rejected — the two sides already carry it identically,
//!     so excluding it would be gratuitous information-throwing-away.)
//!   - **Component `value` imports/exports.** Out of parity scope entirely
//!     (docs/architecture.md §7); never appear in either side's model.
//!   - **`map` types.** Not emitted by current translators (descriptor-ir.md
//!     "Open items"); WIT's `TypeDefKind::Map` is despecialized to
//!     `list<tuple<K,V>>` structurally by this digest to stay on the plan
//!     side's supported subset (fixture-only path, untested by the sync
//!     corpus — none of hello/values/resources use `map`).
//!   - **`stream`/`future`/`error-context`.** Task-scheduler concerns; represented
//!     structurally (so a digest CAN be computed if a future world uses
//!     them) but untested by the sync fixture corpus.
//!
//! ## Known limitation: resource-table aliasing (plan side only)
//!
//! The plan's `own`/`borrow` `resource: N` indexes into `resourceTables`,
//! whose entries can alias each other across component-linking boundaries
//! (observed empirically in the `resources` fixture: the type-export
//! declaration for `counter` sits at `resourceTables[1]` — `{instance: 1}`,
//! the sub-instance that defines it — while every `own`/`borrow` occurrence
//! in the exported function types references `resourceTables[0]` —
//! `{instance: 0}`, the root instance's re-export of the same nominal type).
//! Resolving this in general requires walking wasmtime's resource-alias
//! chain, which the plan format does not expose directly (this is exactly
//! the kind of "impedance between wit-parser's view and the plan's types"
//! flagged for the §9 degraded-mode question). The TS-side implementation
//! (`digest.ts`) uses a documented, honest shortcut: when a world has
//! exactly one nominal resource type, every `own`/`borrow` reference
//! (regardless of table index) is identified with that resource — correct
//! for the entire current fixture corpus (each world has 0 or 1 resource
//! types), but the general multi-resource case raises a loud, clearly-named
//! error rather than silently guessing. Fixing this for real needs either a
//! plan-format extension (an explicit alias map) or shim-side resolution;
//! tracked as follow-up, not solved by this kickoff track.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use wit_parser::{
    Function, FunctionKind, Handle, Resolve, Type, TypeDefKind, TypeId, WorldId, WorldItem,
    WorldKey,
};

/// Version tag folded into the canonical JSON so a future incompatible
/// renormalization can't silently collide with v1 digests.
///
/// cewd = component-engine world digest, the project's pre-rebrand name; kept as an opaque wire constant.
pub const CEWD_VERSION: u32 = 1;

pub struct WorldDigest {
    /// Canonical JSON text that was hashed (useful for debugging/tests).
    pub canonical_json: String,
    /// `sha256:<hex>`.
    pub digest: String,
}

/// Compute the canonical world digest for `world` in `resolve`.
pub fn compute(resolve: &Resolve, world: WorldId) -> Result<WorldDigest> {
    let w = resolve
        .worlds
        .get(world)
        .context("world id not present in resolve")?;

    // Pre-pass: every named resource type reachable from this world's
    // imports/exports, keyed by TypeId, value = canonical qualified name.
    let mut resource_names: BTreeMap<TypeId, String> = BTreeMap::new();
    collect_resource_names(resolve, &w.imports, &mut resource_names)?;
    collect_resource_names(resolve, &w.exports, &mut resource_names)?;

    let imports = canon_items(resolve, &w.imports, &resource_names)?;
    let exports = canon_items(resolve, &w.exports, &resource_names)?;

    let doc = json!({
        "cewd": CEWD_VERSION,
        "imports": sort_by_name(imports),
        "exports": sort_by_name(exports),
    });
    let canonical_json = canonical_string(&doc);
    let mut hasher = Sha256::new();
    hasher.update(canonical_json.as_bytes());
    let digest = format!("sha256:{:x}", hasher.finalize());
    Ok(WorldDigest {
        canonical_json,
        digest,
    })
}

pub(crate) fn qualified_interface_name(resolve: &Resolve, id: wit_parser::InterfaceId) -> Result<String> {
    let iface = &resolve.interfaces[id];
    let name = iface
        .name
        .as_ref()
        .context("anonymous interface cannot appear as a world import/export key")?;
    let pkg_id = iface
        .package
        .context("interface has no owning package")?;
    let pkg = &resolve.packages[pkg_id].name;
    let mut s = format!("{}:{}/{}", pkg.namespace, pkg.name, name);
    if let Some(v) = &pkg.version {
        s.push('@');
        s.push_str(&v.to_string());
    }
    Ok(s)
}

fn collect_resource_names(
    resolve: &Resolve,
    items: &wit_parser::IndexMap<WorldKey, WorldItem>,
    out: &mut BTreeMap<TypeId, String>,
) -> Result<()> {
    for (key, item) in items {
        if let &WorldItem::Interface { id, .. } = item {
            let iface_name = qualified_interface_name(resolve, id)?;
            let iface = &resolve.interfaces[id];
            for (type_name, type_id) in &iface.types {
                if matches!(resolve.types[*type_id].kind, TypeDefKind::Resource) {
                    out.insert(*type_id, format!("{iface_name}/{type_name}"));
                }
            }
        } else if let WorldItem::Type { id: type_id, .. } = item {
            // A resource declared directly at world scope (untested by the
            // current fixture corpus: hello/values/resources all put their
            // resource inside a named interface).
            if let WorldKey::Name(name) = key {
                if matches!(resolve.types[*type_id].kind, TypeDefKind::Resource) {
                    out.insert(*type_id, format!("$world/{name}"));
                }
            }
        }
    }
    Ok(())
}

fn canon_items(
    resolve: &Resolve,
    items: &wit_parser::IndexMap<WorldKey, WorldItem>,
    resource_names: &BTreeMap<TypeId, String>,
) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for (key, item) in items {
        match item {
            WorldItem::Function(f) => {
                let name = match key {
                    WorldKey::Name(n) => n.clone(),
                    WorldKey::Interface(_) => bail!("function item with an interface key"),
                };
                out.push(json!({
                    "kind": "func",
                    "name": name,
                    "func": canon_func(resolve, f, None, resource_names)?,
                }));
            }
            &WorldItem::Interface { id, .. } => {
                let name = qualified_interface_name(resolve, id)?;
                out.push(json!({
                    "kind": "instance",
                    "name": name,
                    "items": sort_by_name(canon_interface(resolve, id, resource_names)?),
                }));
            }
            WorldItem::Type { id: type_id, .. } => {
                // wit_parser models types declared directly inside a
                // `world { ... }` block (records/variants/enums/flags used
                // only for internal reuse across that world's function
                // signatures) as `WorldItem::Type` entries in the world's
                // `imports` map — empirically confirmed against the
                // `values` fixture, whose world declares 5 such types
                // (`mixed`, `size`, `shape`, `color`, `perms`) and whose
                // *component* has zero imports (matching the plan: `values`
                // fixture's plan.json has `imports: []`). These are not
                // real component-level imports and must not appear in the
                // digest's import list (they affect the digest only via
                // whichever function signatures reference them, exactly
                // like an interface's non-resource named types — see
                // `canon_interface`'s comment on the same point). Resources
                // are the one exception: a resource declared directly at
                // world scope (untested by the current fixture corpus) IS
                // a real nominal type that other signatures reference by
                // handle, so it's still emitted.
                if !matches!(resolve.types[*type_id].kind, TypeDefKind::Resource) {
                    continue;
                }
                let name = match key {
                    WorldKey::Name(n) => n.clone(),
                    WorldKey::Interface(_) => bail!("type item with an interface key"),
                };
                out.push(json!({ "kind": "resource", "name": name }));
            }
        }
    }
    Ok(out)
}

fn canon_interface(
    resolve: &Resolve,
    id: wit_parser::InterfaceId,
    resource_names: &BTreeMap<TypeId, String>,
) -> Result<Vec<Value>> {
    let iface = &resolve.interfaces[id];
    let mut out = Vec::new();
    for (type_name, type_id) in &iface.types {
        if matches!(resolve.types[*type_id].kind, TypeDefKind::Resource) {
            out.push(json!({ "kind": "resource", "name": type_name.clone() }));
        }
        // Non-resource named types (records/variants/etc. declared at
        // interface scope) do not themselves appear as component exports —
        // only functions and resources do — so they are intentionally not
        // emitted as top-level items here; they still affect the digest via
        // whichever function signatures reference them.
    }
    for (_func_name, f) in &iface.functions {
        let resource_id = match f.kind {
            FunctionKind::Method(id)
            | FunctionKind::AsyncMethod(id)
            | FunctionKind::Static(id)
            | FunctionKind::AsyncStatic(id)
            | FunctionKind::Constructor(id) => Some(id),
            FunctionKind::Freestanding | FunctionKind::AsyncFreestanding => None,
        };
        // `Function.name` (== the interface's function-map key) is already
        // the full component-model ABI export name for
        // method/static/constructor functions (verified empirically: see
        // module docs and the `resources` fixture's dumped plan.json —
        // `[method]counter.increment`, `[constructor]counter`, etc. come
        // straight out of wit_parser, not synthesized here).
        out.push(json!({
            "kind": "func",
            "name": f.name,
            "func": canon_func(resolve, f, resource_id, resource_names)?,
        }));
    }
    Ok(out)
}

fn canon_func(
    resolve: &Resolve,
    f: &Function,
    method_resource: Option<TypeId>,
    resource_names: &BTreeMap<TypeId, String>,
) -> Result<Value> {
    let mut params = Vec::new();
    // NOTE (corrected from an earlier draft of this comment): wit_parser's
    // `Function.params` already includes the explicit `self` parameter for
    // `Method`/`AsyncMethod` functions (empirically verified: `[method]
    // counter.increment`'s `f.params` is `[Param { name: "self", ty:
    // Id(<counter>), .. }]`) — despite `FunctionKind::Method`'s doc comment
    // saying the parameter is "implicit". No synthesis needed here; the
    // plain params loop below already carries it through `canon_type`,
    // which resolves the resource `Type::Id` via `resource_names` like any
    // other `own`/`borrow` occurrence. `method_resource` is therefore only
    // needed for the *result* case (`Constructor`, below).
    let _ = method_resource;
    for p in &f.params {
        params.push(canon_type(resolve, p.ty, resource_names)?);
    }
    let mut results = Vec::new();
    match (f.result, &f.kind) {
        (Some(t), _) => results.push(canon_type(resolve, t, resource_names)?),
        (None, FunctionKind::Constructor(rid)) => {
            let name = resource_names
                .get(rid)
                .cloned()
                .context("constructor result resource has no canonical name")?;
            results.push(json!({ "kind": "own", "resource": name }));
        }
        (None, _) => {}
    }
    let is_async = matches!(
        f.kind,
        FunctionKind::AsyncFreestanding
            | FunctionKind::AsyncMethod(_)
            | FunctionKind::AsyncStatic(_)
    );
    Ok(json!({ "params": params, "results": results, "async": is_async }))
}

fn canon_type(
    resolve: &Resolve,
    ty: Type,
    resource_names: &BTreeMap<TypeId, String>,
) -> Result<Value> {
    Ok(match ty {
        Type::Bool => json!({ "kind": "bool" }),
        Type::U8 => json!({ "kind": "u8" }),
        Type::U16 => json!({ "kind": "u16" }),
        Type::U32 => json!({ "kind": "u32" }),
        Type::U64 => json!({ "kind": "u64" }),
        Type::S8 => json!({ "kind": "s8" }),
        Type::S16 => json!({ "kind": "s16" }),
        Type::S32 => json!({ "kind": "s32" }),
        Type::S64 => json!({ "kind": "s64" }),
        Type::F32 => json!({ "kind": "f32" }),
        Type::F64 => json!({ "kind": "f64" }),
        Type::Char => json!({ "kind": "char" }),
        Type::String => json!({ "kind": "string" }),
        Type::ErrorContext => json!({ "kind": "error-context" }),
        Type::Id(id) => canon_typedef(resolve, id, resource_names)?,
    })
}

fn canon_typedef(
    resolve: &Resolve,
    id: TypeId,
    resource_names: &BTreeMap<TypeId, String>,
) -> Result<Value> {
    let def = &resolve.types[id];
    Ok(match &def.kind {
        TypeDefKind::Type(t) => canon_type(resolve, *t, resource_names)?,
        TypeDefKind::Record(r) => {
            let fields: Result<Vec<Value>> = r
                .fields
                .iter()
                .map(|f| {
                    Ok(json!({
                        "label": f.name,
                        "type": canon_type(resolve, f.ty, resource_names)?,
                    }))
                })
                .collect();
            json!({ "kind": "record", "fields": fields? })
        }
        TypeDefKind::Tuple(t) => {
            let elements: Result<Vec<Value>> = t
                .types
                .iter()
                .map(|ty| canon_type(resolve, *ty, resource_names))
                .collect();
            json!({ "kind": "tuple", "elements": elements? })
        }
        TypeDefKind::Variant(v) => {
            let cases: Result<Vec<Value>> = v
                .cases
                .iter()
                .map(|c| {
                    let ty = match c.ty {
                        Some(t) => Some(canon_type(resolve, t, resource_names)?),
                        None => None,
                    };
                    Ok(json!({ "label": c.name, "type": ty }))
                })
                .collect();
            json!({ "kind": "variant", "cases": cases? })
        }
        TypeDefKind::Enum(e) => {
            let labels: Vec<Value> = e.cases.iter().map(|c| json!(c.name)).collect();
            json!({ "kind": "enum", "labels": labels })
        }
        TypeDefKind::Option(t) => {
            json!({ "kind": "option", "type": canon_type(resolve, *t, resource_names)? })
        }
        TypeDefKind::Result(r) => {
            let ok = match r.ok {
                Some(t) => Some(canon_type(resolve, t, resource_names)?),
                None => None,
            };
            let err = match r.err {
                Some(t) => Some(canon_type(resolve, t, resource_names)?),
                None => None,
            };
            json!({ "kind": "result", "ok": ok, "err": err })
        }
        TypeDefKind::List(t) => {
            json!({ "kind": "list", "element": canon_type(resolve, *t, resource_names)? })
        }
        TypeDefKind::FixedLengthList(t, n) => {
            json!({ "kind": "list", "element": canon_type(resolve, *t, resource_names)?, "length": n })
        }
        TypeDefKind::Map(k, v) => {
            // Despecialized to list<tuple<K,V>> — see module docs "map
            // types" note. Fixture-only path, unexercised by the sync
            // corpus.
            json!({
                "kind": "list",
                "element": {
                    "kind": "tuple",
                    "elements": [
                        canon_type(resolve, *k, resource_names)?,
                        canon_type(resolve, *v, resource_names)?,
                    ]
                }
            })
        }
        TypeDefKind::Flags(f) => {
            let labels: Vec<Value> = f.flags.iter().map(|fl| json!(fl.name)).collect();
            json!({ "kind": "flags", "labels": labels })
        }
        TypeDefKind::Handle(Handle::Own(rid)) => {
            let name = resource_names
                .get(rid)
                .cloned()
                .with_context(|| format!("own<T> references an unnamed resource {rid:?}"))?;
            json!({ "kind": "own", "resource": name })
        }
        TypeDefKind::Handle(Handle::Borrow(rid)) => {
            let name = resource_names
                .get(rid)
                .cloned()
                .with_context(|| format!("borrow<T> references an unnamed resource {rid:?}"))?;
            json!({ "kind": "borrow", "resource": name })
        }
        TypeDefKind::Future(t) => {
            let element = match t {
                Some(t) => Some(canon_type(resolve, *t, resource_names)?),
                None => None,
            };
            json!({ "kind": "future", "element": element })
        }
        TypeDefKind::Stream(t) => {
            let element = match t {
                Some(t) => Some(canon_type(resolve, *t, resource_names)?),
                None => None,
            };
            json!({ "kind": "stream", "element": element })
        }
        TypeDefKind::Resource => {
            bail!("a bare resource type cannot appear as a value type")
        }
        TypeDefKind::Unknown => bail!("unresolved type made it into a resolved Resolve"),
    })
}

fn sort_by_name(mut items: Vec<Value>) -> Vec<Value> {
    // Byte-wise (`str::cmp`) ordering here vs. `digest.ts`'s `<`/`>` (UTF-16
    // code-unit) ordering on the TS side: these are NOT the same collation
    // in general, but WIT identifiers are ASCII-only (kebab-case
    // `[a-z0-9-]`, component-model naming grammar), where byte-wise and
    // UTF-16-code-unit ordering coincide — so this does not need to be
    // "fixed" to match one true order; do not change one side without the
    // other if this identifier-charset assumption ever changes.
    items.sort_by(|a, b| {
        let an = a.get("name").and_then(Value::as_str).unwrap_or("");
        let bn = b.get("name").and_then(Value::as_str).unwrap_or("");
        an.cmp(bn)
    });
    items
}

/// Recursively sort object keys (alphabetically) and re-serialize with no
/// extra whitespace. Array element order is preserved verbatim — arrays are
/// exactly where this normalization's ABI-relevant positional information
/// lives (record fields, variant cases, params, ...). This is the "sort
/// keys, don't touch arrays" canonicalization that both language
/// implementations must match byte-for-byte.
pub fn canonical_string(v: &Value) -> String {
    let sorted = sort_keys(v);
    serde_json::to_string(&sorted).expect("canonical value must serialize")
}

fn sort_keys(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut out = Map::new();
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            for k in keys {
                out.insert(k.clone(), sort_keys(&m[k]));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(sort_keys).collect()),
        other => other.clone(),
    }
}

/// Parse a WIT directory/file and resolve the world by name (bare name or
/// `pkg:ns/world` qualified form, whichever `Resolve::select_world` accepts).
pub fn resolve_world(
    wit_path: &std::path::Path,
    world: Option<&str>,
) -> Result<(Resolve, WorldId)> {
    let mut resolve = Resolve::new();
    let pkg_id = if wit_path.is_dir() {
        resolve.push_dir(wit_path)?.0
    } else {
        let contents = std::fs::read_to_string(wit_path)
            .with_context(|| format!("reading {}", wit_path.display()))?;
        let group = wit_parser::UnresolvedPackageGroup::parse(wit_path, &contents)
            .map_err(|(source_map, err)| anyhow::anyhow!("{}", err.render(&source_map)))?;
        resolve.push_group(group)?
    };
    let world_id = resolve
        .select_world(&[pkg_id], world)
        .context("selecting world")?;
    Ok((resolve, world_id))
}
