//! TypeScript codegen implementing the embedder-facing conventions
//! (`contracts/embedder-api.md`, normative). Emits **types
//! only**: `Imports`/`Exports` interfaces, value types per the mapping
//! table, resource classes, `ComponentException`-typed fallible signatures,
//! `Stream<T>`/`Future<T>` references, plus the existing WORLD_DIGEST +
//! `verify()` digest handshake and a thin `bind()` cast. No runtime
//! behavior is emitted or assumed to exist yet (the runtime's own facade is
//! a separate crate) — every generated file must `deno check` standalone.
//!
//! Built on `wit_bindgen_core::Source`/`Files` for text accumulation, still
//! a hand-written generator, not a `WorldGenerator` trait implementation,
//! not a `WorldGenerator` trait implementation (CONTRACT: docs/architecture.md §9 doesn't
//! mandate the trait specifically, only "built on wit-bindgen-core").

use std::collections::BTreeSet;
use std::fmt::Write as _;

use anyhow::{bail, Context, Result};
use wit_bindgen_core::Source;
use wit_parser::{
    Function, FunctionKind, Handle, Resolve, Type, TypeDefKind, TypeId, WorldId, WorldItem,
    WorldKey,
};

use crate::digest;

/// Default import base for generated bindings: the versioned JSR specifier
/// for `@polyengine/runtime`, with the version derived at build time from
/// `runtime/deno.json` (see `build.rs`) rather than hand-written, so a
/// release bump can never leave bindgen pinning a stale line silently.
///
/// Caveat (AGENTS.md §Versioning): the manifests always carry the NEXT
/// release, so on a development checkout between releases this default pins
/// a version that is not published yet — semver ranges never resolve to the
/// `-pre.g<hash>` prereleases. That is deliberate: bindings generated from a
/// dev checkout belong to that unreleased line. It is also why the in-repo
/// fixtures under `runtime/tests/bindgen/generated/` are regenerated with a
/// relative base (`--import-base ../../../src`) instead.
pub const DEFAULT_IMPORT_BASE: &str = concat!(
    "jsr:@polyengine/runtime@^",
    env!("POLYENGINE_RUNTIME_VERSION")
);

/// Default specifier for `@polyengine/protocol` imports in generated
/// bindings (contracts/embedder-api.md §"The host-ABI
/// surface and its version": the handle vocabulary — `Stream`/`Future`/
/// `ErrorContext`/`ComponentException`/`Trap`/the source-union types — now
/// lives in protocol, not the runtime's embedder module). Protocol's
/// version moves independently of the runtime's lockstep version
/// (§"Consequence: protocol's version is the host-ABI version"), so this is
/// its own JSR pin derived from `protocol/deno.json` (see `build.rs`), not
/// a specifier built off `DEFAULT_IMPORT_BASE`/`--import-base`.
pub const DEFAULT_PROTOCOL_BASE: &str = concat!(
    "jsr:@polyengine/protocol@^",
    env!("POLYENGINE_PROTOCOL_VERSION")
);

/// Resolve the `@polyengine/protocol` import specifier for generated
/// bindings. When `import_base` is file-addressed (the in-repo regeneration
/// path, `--import-base <path-to>/runtime/src`), protocol is a *sibling*
/// package directory, not a module under the runtime's `src/` — so this
/// mirrors the path up one level and across, rather than reusing
/// `module_specifier`'s "module under this base" logic (that logic is
/// right for `plan`/`digest`/`embedder`, which really do live under
/// `{base}/{module}`; protocol does not).
///
/// CONTRACT: the file-addressed rewrite assumes the conventional repo
/// layout (`.../runtime/src` -> `.../protocol/src`); it is exercised only by
/// the two call sites that pass an actual `runtime/src` path (the default
/// relative base and the #201 regression test's canonicalized absolute
/// path). An operator passing an unrelated file-addressed base gets the
/// bare `@polyengine/protocol` specifier instead, which still typechecks
/// for any consumer whose import map declares it (and for every in-repo
/// `deno check`, via the workspace).
fn protocol_specifier(import_base: &str) -> String {
    let base = import_base.trim_end_matches('/');
    let file_addressed = base.starts_with('.')
        || base.starts_with('/')
        || base.starts_with("file:")
        || base.starts_with("http://")
        || base.starts_with("https://");
    if file_addressed {
        if let Some(prefix) = base.strip_suffix("runtime/src") {
            return format!("{prefix}protocol/src/mod.ts");
        }
        return "@polyengine/protocol".to_string();
    }
    DEFAULT_PROTOCOL_BASE.to_string()
}

/// Resolve the import specifier for one runtime module (`plan`, `digest`,
/// `embedder`) against an import base (issue #201).
///
/// The distinction is what the base *addresses*. A path or URL specifier
/// addresses a **file**, so it needs that file's real name:
/// `{base}/{module}/mod.ts`. A bare or registry specifier addresses an
/// **entry in a package's `exports` map** — `runtime/deno.json` declares
/// `./plan`, `./digest` and `./embedder` — so the module name alone is the
/// whole specifier: `{base}/{module}`.
///
/// Concretely, the file-addressed arm is taken when the base starts with
/// `.`, `/`, `file:`, `http://` or `https://` (Deno resolves remote modules
/// by URL, so an `http(s)` base names a file just as a path does);
/// everything else — a bare specifier like `@polyengine/runtime`, or a
/// registry specifier like `jsr:` / `npm:` — is export-addressed.
///
/// An unrecognized scheme falls back to export-addressed, so a hypothetical
/// future registry scheme works by default, while anything file-like must be
/// spelled as a path, a `file:` URL, or an `http(s)` URL.
pub fn module_specifier(import_base: &str, module: &str) -> String {
    let base = import_base.trim_end_matches('/');
    let file_addressed = base.starts_with('.')
        || base.starts_with('/')
        || base.starts_with("file:")
        || base.starts_with("http://")
        || base.starts_with("https://");
    if file_addressed {
        format!("{base}/{module}/mod.ts")
    } else {
        format!("{base}/{module}")
    }
}

/// Which side of the world an item belongs to — determines whether a
/// resource is guest-implemented (export: host holds handles, bindgen
/// emits a concrete class) or host-implemented (import: guest holds
/// handles, bindgen emits the class *shape* the embedder must provide).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Import,
    Export,
}

/// Per-resource function bundle, gathered by a pre-pass over every
/// interface's functions (`FunctionKind::{Constructor,Method,AsyncMethod,
/// Static,AsyncStatic}` all carry the owning resource's `TypeId`).
#[derive(Default)]
struct ResourceFns<'a> {
    side: Option<Side>,
    ctor: Option<&'a Function>,
    methods: Vec<&'a Function>,
    statics: Vec<&'a Function>,
}

pub fn generate(
    resolve: &Resolve,
    world: WorldId,
    expected_digest: &str,
    import_base: &str,
) -> Result<String> {
    let w = &resolve.worlds[world];
    let mut src = Source::default();

    let plan_mod = module_specifier(import_base, "plan");
    let digest_mod = module_specifier(import_base, "digest");
    let embedder_mod = module_specifier(import_base, "embedder");
    let protocol_mod = protocol_specifier(import_base);

    writeln!(src, "// GENERATED by crates/bindgen — do not edit by hand.")?;
    writeln!(src, "// Source world: {}", w.name)?;
    // The printed command must reproduce this file byte for byte, so the
    // import base is always echoed — including when it is the default.
    writeln!(
        src,
        "// Regenerate: cargo run -p bindgen -- <wit-path> --world {} --out <file> --import-base {}",
        w.name, import_base
    )?;
    writeln!(src)?;
    writeln!(src, "import type {{ WirePlan }} from {plan_mod:?};")?;
    writeln!(
        src,
        "import {{\n\
         \x20 verifyWorldDigest,\n\
         \x20 WorldDigestMismatchError,\n\
         \x20 type DigestMismatch,\n\
         }} from {digest_mod:?};"
    )?;
    // The verified default path (issue #184): the generated `instantiate`
    // wrapper resolves the plan first (`resolveArtifacts`), runs the
    // world-digest handshake, and only then delegates to the runtime
    // facade — so verification completes before any guest code runs.
    writeln!(
        src,
        "import {{\n\
         \x20 instantiateEmbedder,\n\
         \x20 resolveArtifacts,\n\
         }} from {embedder_mod:?};"
    )?;
    // Stream<T>/Future<T>/ErrorContext/ComponentException/Trap plus the source-union
    // types used at parameter positions (StreamSource<T>/FutureSource<T>,
    // contracts/embedder-api.md §"Streams and futures": "lowering accepts
    // the natural JS producers") come from `@polyengine/protocol` (per
    // §"The host-ABI surface and its version": the handle vocabulary moved
    // out of the runtime's embedder module). `EmbedderInstance`/
    // `EmbedderOptions`/`InstantiateSource` (the
    // `bind()` input shape) stay application surface, from the embedder
    // facade module.
    writeln!(
        src,
        "import type {{\n\
         \x20 Stream,\n\
         \x20 Future,\n\
         \x20 StreamSource,\n\
         \x20 FutureSource,\n\
         \x20 ErrorContext,\n\
         \x20 ComponentException,\n\
         \x20 Trap,\n\
         }} from {protocol_mod:?};"
    )?;
    writeln!(
        src,
        "import type {{\n\
         \x20 EmbedderInstance,\n\
         \x20 EmbedderOptions,\n\
         \x20 InstantiateSource,\n\
         }} from {embedder_mod:?};\n"
    )?;

    // Silence unused-import checks for worlds that don't happen to
    // reference every embedder type (`Trap`/`ErrorContext` in particular —
    // no fixture world raises a bare Trap type or uses error-context yet).
    writeln!(
        src,
        "// deno-lint-ignore no-unused-vars\ntype _EnsureEmbedderTypesUsed = [Stream<unknown>, Future<unknown>, StreamSource<unknown>, FutureSource<unknown>, ErrorContext, ComponentException, Trap];\n"
    )?;


    writeln!(src, "/** Canonical structural digest (docs/architecture.md §9). */")?;
    writeln!(src, "export const WORLD_DIGEST = {expected_digest:?};\n")?;

    writeln!(
        src,
        "/** Verify a loaded plan against this world's expected digest before\n\
         * trusting the typed facade below. Call at instantiate time, before\n\
         * (or instead of) `instantiateComponent` if the plan is untrusted. */\n\
         export function verify(plan: WirePlan): Promise<DigestMismatch | null> {{\n\
         \x20 return verifyWorldDigest(plan, WORLD_DIGEST);\n\
         }}\n"
    )?;

    // ---- Pre-pass: gather every resource's constructor/methods/statics,
    // keyed by TypeId, and which side (import/export) it lives on. A
    // resource's functions live in `iface.functions`, addressed by the
    // resource TypeId carried in `FunctionKind`; the resource *type itself*
    // is declared in `iface.types`.
    let mut resource_fns: std::collections::BTreeMap<TypeId, ResourceFns> =
        std::collections::BTreeMap::new();
    let mut resource_order: Vec<TypeId> = Vec::new();
    collect_resource_fns(
        resolve,
        &w.imports,
        Side::Import,
        &mut resource_fns,
        &mut resource_order,
    )?;
    collect_resource_fns(
        resolve,
        &w.exports,
        Side::Export,
        &mut resource_fns,
        &mut resource_order,
    )?;

    // ---- Value type declarations (records/variants/enums/flags), in
    // first-encountered order, walking every function signature reachable
    // from imports/exports. Resource *value* references (own/borrow) are
    // handled by name (`resource_ts_name`); the resource class bodies
    // themselves are emitted afterward from `resource_fns`.
    let mut emitted = BTreeSet::new();
    let mut type_decls = Source::default();
    for (key, item) in w.imports.iter().chain(w.exports.iter()) {
        collect_and_emit_types(resolve, key, item, &mut emitted, &mut type_decls)?;
    }
    src.push_str(&type_decls);

    // ---- Resource class declarations, in first-encountered order.
    for rid in &resource_order {
        let rf = &resource_fns[rid];
        emit_resource_class(resolve, *rid, rf, &mut src)?;
    }

    // ---- Imports / Exports interfaces.
    let mut import_decls = Source::default();
    let mut export_decls = Source::default();
    for (key, item) in &w.imports {
        emit_world_item(resolve, key, item, Side::Import, &mut import_decls)?;
    }
    for (key, item) in &w.exports {
        emit_world_item(resolve, key, item, Side::Export, &mut export_decls)?;
    }

    let world_ident = ts_ident(&w.name);
    if !import_decls.as_str().is_empty() {
        writeln!(src, "export interface {world_ident}Imports {{")?;
        src.push_str(import_decls.as_str());
        writeln!(src, "}}\n")?;
    }
    writeln!(src, "export interface {world_ident}Exports {{")?;
    src.push_str(export_decls.as_str());
    writeln!(src, "}}\n")?;

    // ---- The verified default entry point (issue #184).
    //
    // contracts/embedder-api.md §"Module wiring and instantiation" +
    // contracts/digest.md: the digest is the skew-protection handshake —
    // bindings embed the expected digest, the runtime recomputes it from
    // the loaded plan at instantiate time and fails fast with a structural
    // diff on mismatch. `resolveArtifacts` normalizes either accepted
    // input form (pre-translated artifacts, or component-plus-translator)
    // to a plan WITHOUT instantiating, so the check completes before any
    // guest initializer runs.
    let has_imports = !import_decls.as_str().is_empty();
    let imports_param = if has_imports {
        format!("imports: {world_ident}Imports")
    } else {
        "imports: Record<string, unknown> = {}".to_string()
    };
    writeln!(
        src,
        "/** An instantiated `{world_name}` component: the embedder-conventions\n\
         * instance (`{{ exports, handle, imports }}`) with `exports` typed as\n\
         * `{world_ident}Exports`. */\n\
         export interface {world_ident}Instance extends Omit<EmbedderInstance, \"exports\"> {{\n\
         \x20 exports: {world_ident}Exports;\n\
         }}\n",
        world_name = w.name,
    )?;
    writeln!(
        src,
        "/** Instantiate a `{world_name}` component behind these typed bindings —\n\
         * the default path for typed consumers.\n\
         *\n\
         * Verifies the loaded plan's world digest against `WORLD_DIGEST`\n\
         * BEFORE instantiating (contracts/digest.md; contracts/embedder-api.md\n\
         * §\"Module wiring and instantiation\"), throwing\n\
         * `WorldDigestMismatchError` with the structural diff on skew — no\n\
         * guest code has run when that throws. Accepts the same sources as\n\
         * the runtime `instantiate` (pre-translated artifacts, an envelope\n\
         * via `artifactsFromEnvelope`, or component bytes plus a translator).\n\
         *\n\
         * Use `bind` instead only when the plan was verified already. */\n\
         export async function instantiate(\n\
         \x20 source: InstantiateSource,\n\
         \x20 {imports_param},\n\
         \x20 opts: EmbedderOptions = {{}},\n\
         ): Promise<{world_ident}Instance> {{\n\
         \x20 const artifacts = await resolveArtifacts(source);\n\
         \x20 const mismatch = await verify(artifacts.plan);\n\
         \x20 if (mismatch) throw new WorldDigestMismatchError({world_name:?}, mismatch);\n\
         \x20 const instance = await instantiateEmbedder(artifacts, imports, opts);\n\
         \x20 return instance as unknown as {world_ident}Instance;\n\
         }}\n",
        world_name = w.name,
    )?;

    writeln!(
        src,
        "/** Typed cast over an embedder-conventions instance's `exports`\n\
         * (`{{ exports, handle, imports }}`, keyed per\n\
         * contracts/embedder-api.md §\"Module wiring and instantiation\") —\n\
         * an UNCHECKED cast: it performs no digest verification. Prefer the\n\
         * `instantiate` above, which runs the world-digest handshake before\n\
         * instantiating; `bind` is for already-verified plans and advanced\n\
         * callers driving `instantiateEmbedder` themselves (verify this\n\
         * world's digest against the plan first — see `verify`). */\n\
         export function bind(instance: EmbedderInstance): {world_ident}Exports {{\n\
         \x20 return instance.exports as unknown as {world_ident}Exports;\n\
         }}",
    )?;

    Ok(src.as_str().to_string())
}

// ---------------------------------------------------------------------
// Casing (contracts/embedder-api.md §"Naming and casing")
// ---------------------------------------------------------------------

/// PascalCase: split on `-`/`_`, every fragment first-char-uppercased,
/// remainder preserved (acronyms preserved). Used for resource/type names.
fn ts_ident(name: &str) -> String {
    name.split(['-', '_'])
        .map(|part| {
            let mut c = part.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

/// camelCase: split on `-`; first fragment unchanged, later fragments
/// first-char-uppercased, remainder preserved. Used for
/// functions/methods/statics/record fields/flags/params/world-level bare
/// imports-exports (contracts/embedder-api.md casing table).
fn camel_case(name: &str) -> String {
    let mut out = String::new();
    let mut first_fragment = true;
    for part in name.split('-') {
        if first_fragment {
            out.push_str(part);
            first_fragment = false;
            continue;
        }
        let mut c = part.chars();
        if let Some(f) = c.next() {
            out.extend(f.to_uppercase());
            out.push_str(c.as_str());
        }
    }
    if out.is_empty() || out.chars().next().unwrap().is_ascii_digit() {
        out = format!("_{out}");
    }
    out
}

/// kebab-case verbatim, as a quoted TS string literal — used for enum
/// values and variant/result tags (data, not identifiers; casing table).
fn kebab_literal(name: &str) -> String {
    format!("{name:?}")
}

fn resource_ts_name(resolve: &Resolve, id: TypeId) -> Result<String> {
    let name = resolve.types[id]
        .name
        .as_deref()
        .context("resource type has no name")?;
    Ok(ts_ident(name))
}

// ---------------------------------------------------------------------
// Resource function collection
// ---------------------------------------------------------------------

fn method_resource(f: &Function) -> Option<TypeId> {
    match f.kind {
        FunctionKind::Method(id)
        | FunctionKind::AsyncMethod(id)
        | FunctionKind::Static(id)
        | FunctionKind::AsyncStatic(id)
        | FunctionKind::Constructor(id) => Some(id),
        FunctionKind::Freestanding | FunctionKind::AsyncFreestanding => None,
    }
}

fn collect_resource_fns<'a>(
    resolve: &'a Resolve,
    items: &'a wit_parser::IndexMap<WorldKey, WorldItem>,
    side: Side,
    out: &mut std::collections::BTreeMap<TypeId, ResourceFns<'a>>,
    order: &mut Vec<TypeId>,
) -> Result<()> {
    for item in items.values() {
        if let WorldItem::Interface { id, .. } = item {
            let iface = &resolve.interfaces[*id];
            for f in iface.functions.values() {
                let Some(rid) = method_resource(f) else {
                    continue;
                };
                let entry = out.entry(rid).or_insert_with(|| {
                    order.push(rid);
                    ResourceFns::default()
                });
                entry.side = Some(side);
                match f.kind {
                    FunctionKind::Constructor(_) => entry.ctor = Some(f),
                    FunctionKind::Method(_) | FunctionKind::AsyncMethod(_) => {
                        entry.methods.push(f)
                    }
                    FunctionKind::Static(_) | FunctionKind::AsyncStatic(_) => {
                        entry.statics.push(f)
                    }
                    _ => unreachable!(),
                }
            }
            // A resource with no functions at all (degenerate, untested by
            // the current fixture corpus) would never be visited above;
            // register it anyway so the class still gets emitted.
            for tid in iface.types.values() {
                if matches!(resolve.types[*tid].kind, TypeDefKind::Resource)
                    && !out.contains_key(tid)
                {
                    out.entry(*tid).or_insert_with(|| {
                        order.push(*tid);
                        ResourceFns {
                            side: Some(side),
                            ..Default::default()
                        }
                    });
                }
            }
        }
    }
    Ok(())
}

fn is_async_kind(kind: &FunctionKind) -> bool {
    matches!(
        kind,
        FunctionKind::AsyncFreestanding | FunctionKind::AsyncMethod(_) | FunctionKind::AsyncStatic(_)
    )
}

/// Emit a resource class declaration.
///
/// Guest-implemented (export side): a concrete `declare class` — methods
/// and statics are Promise-shaped (exports are uniformly Promise-shaped,
/// contracts/embedder-api.md §"Functions and async"), constructor is typed
/// as an ordinary synchronous JS constructor.
///
/// **Constructors are synchronous** (contracts/embedder-api.md
/// §"Resources"): a JS class constructor cannot await, so `new R(...)` is
/// the one exception (alongside future-typed results) to the
/// uniformly-Promise-shaped rule. A guest constructor that does not
/// complete synchronously is a runtime error (named), not bindgen's
/// concern — the type is simply an ordinary sync constructor.
///
/// Host-implemented (import side): the *shape* the embedder must provide —
/// same member layout, but typed per the import sync/async rule (`T` or
/// `T | Promise<T>`), since the host supplies the implementation directly
/// (contracts/embedder-api.md §"Resources", host-implemented paragraph).
fn emit_resource_class(
    resolve: &Resolve,
    id: TypeId,
    rf: &ResourceFns,
    out: &mut Source,
) -> Result<()> {
    let name = resource_ts_name(resolve, id)?;
    let side = rf.side.unwrap_or(Side::Export);
    let is_export = side == Side::Export;

    writeln!(out, "/**")?;
    if is_export {
        writeln!(
            out,
            " * Guest-implemented resource (host holds handles). `{name}` instances\n\
             * are transferred/invalidated per own/borrow semantics — see\n\
             * contracts/embedder-api.md §\"Resources\".\n\
             * @remarks the constructor is synchronous (contracts/embedder-api.md §\"Resources\"):\n\
             * a guest constructor that fails to complete\n\
             * synchronously raises a named runtime error rather than\n\
             * half-constructing."
        )?;
    } else {
        writeln!(
            out,
            " * Host-implemented resource (guest holds handles): the embedder\n\
             * supplies a class matching this shape — contracts/embedder-api.md\n\
             * §\"Resources\", host-implemented paragraph."
        )?;
    }
    writeln!(out, " */")?;
    writeln!(out, "export declare class {name} {{")?;

    if let Some(ctor) = rf.ctor {
        let params = param_list(resolve, ctor)?;
        writeln!(out, "  constructor({params});")?;
    }
    for f in &rf.methods {
        write_class_member(resolve, f, is_export, false, out)?;
    }
    for f in &rf.statics {
        write_class_member(resolve, f, is_export, true, out)?;
    }
    if is_export {
        writeln!(out, "  [Symbol.dispose](): void;")?;
        writeln!(out, "  drop(): void;")?;
    } else {
        writeln!(out, "  [Symbol.dispose]?(): void;")?;
    }
    writeln!(out, "}}\n")?;
    Ok(())
}

fn write_class_member(
    resolve: &Resolve,
    f: &Function,
    is_export: bool,
    is_static: bool,
    out: &mut Source,
) -> Result<()> {
    let name = camel_case(&f.name_after_last_dot_or_bracket());
    let params = param_list_skip_self(resolve, f)?;
    let (ret, doc) = func_return(resolve, f, is_export)?;
    if let Some(d) = doc {
        writeln!(out, "  /** {d} */")?;
    }
    let prefix = if is_static { "static " } else { "" };
    writeln!(out, "  {prefix}{name}({params}): {ret};")?;
    Ok(())
}

/// Resource method/static names come through as `[method]counter.increment`
/// / `[static]counter.merge` in `Function.name` (the ABI export name);
/// bindgen's obligation is exactly this mangled-name-to-class-member
/// assembly (contracts/embedder-api.md §"Bindgen obligations"). The bare
/// member name is the text after the last `.`.
trait LastSegment {
    fn name_after_last_dot_or_bracket(&self) -> String;
}
impl LastSegment for Function {
    fn name_after_last_dot_or_bracket(&self) -> String {
        self.name
            .rsplit('.')
            .next()
            .unwrap_or(&self.name)
            .to_string()
    }
}

// ---------------------------------------------------------------------
// World item (function/interface) emission
// ---------------------------------------------------------------------

fn emit_world_item(
    resolve: &Resolve,
    key: &WorldKey,
    item: &WorldItem,
    side: Side,
    out: &mut Source,
) -> Result<()> {
    let is_export = side == Side::Export;
    match item {
        WorldItem::Function(f) => {
            let name = match key {
                WorldKey::Name(n) => n.clone(),
                WorldKey::Interface(_) => bail!("function with interface key"),
            };
            let params = param_list(resolve, f)?;
            let (ret, doc) = func_return(resolve, f, is_export)?;
            if let Some(d) = doc {
                writeln!(out, "  /** {d} */")?;
            }
            writeln!(out, "  {}({params}): {ret};", camel_case(&name))?;
        }
        WorldItem::Interface { id, .. } => {
            let iface = &resolve.interfaces[*id];
            // The runtime keys nested export objects by the *component
            // export name* (`WireExport.name`), which for an interface
            // export is its full qualified name — verified against
            // `runtime/src/exec/executor.ts` (see prior version of this
            // file); must match `digest::qualified_interface_name` exactly,
            // and also the casing table's "interface key ... verbatim,
            // version included" rule.
            let name = digest::qualified_interface_name(resolve, *id)?;
            writeln!(out, "  {}: {{", kebab_literal(&name))?;
            // Resources declared in this interface: expose the class
            // (guest-implemented: the class itself, constructible via
            // `new`; host-implemented: same shape, the embedder's class).
            for tid in iface.types.values() {
                if matches!(resolve.types[*tid].kind, TypeDefKind::Resource) {
                    let rname = resource_ts_name(resolve, *tid)?;
                    writeln!(out, "    {rname}: typeof {rname};")?;
                }
            }
            for (fname, f) in &iface.functions {
                if method_resource(f).is_some() {
                    // Resource methods/statics/constructors are exposed via
                    // the class above, not as flat interface members.
                    continue;
                }
                let params = param_list(resolve, f)?;
                let (ret, doc) = func_return(resolve, f, is_export)?;
                if let Some(d) = doc {
                    writeln!(out, "    /** {d} */")?;
                }
                writeln!(out, "    {}({params}): {ret};", camel_case(fname))?;
            }
            writeln!(out, "  }};")?;
        }
        WorldItem::Type { .. } => {
            // Named world-level type export; not itself a callable/instance
            // member, already emitted as a type declaration.
        }
    }
    Ok(())
}

fn param_list(resolve: &Resolve, f: &Function) -> Result<String> {
    let mut params = Vec::new();
    for p in &f.params {
        params.push(format!(
            "{}: {}",
            camel_case(&p.name),
            ts_param_type(resolve, p.ty)?
        ));
    }
    Ok(params.join(", "))
}

/// Same as `param_list` but drops the leading `self` parameter that
/// wit_parser includes explicitly for `Method`/`AsyncMethod` functions
/// (digest.rs `canon_func`'s note) — a JS class method's receiver is
/// implicit `this`, not a positional argument.
fn param_list_skip_self(resolve: &Resolve, f: &Function) -> Result<String> {
    let skip_first = matches!(f.kind, FunctionKind::Method(_) | FunctionKind::AsyncMethod(_));
    let mut params = Vec::new();
    for (i, p) in f.params.iter().enumerate() {
        if i == 0 && skip_first {
            continue;
        }
        params.push(format!(
            "{}: {}",
            camel_case(&p.name),
            ts_param_type(resolve, p.ty)?
        ));
    }
    Ok(params.join(", "))
}

/// Compute a function's TS return type plus an optional JSDoc line.
///
/// - **Exports** are uniformly `Promise<T>` (contracts/embedder-api.md
///   §"Functions and async"). If the WIT result type is a top-level
///   `result<T, E>`, `T` is unwrapped (the `ok` payload; `void` if empty)
///   and a `@throws {ComponentException<E>}` doc line is attached — the err channel
///   is a throw, never part of the resolved value (§"Error model").
/// - **Imports**: sync WIT funcs return `T` directly; async funcs return
///   `T | Promise<T>` (dispatch normative bullet #3). Fallible imports are
///   documented the same way (`@throws`), signaling via `throw new
///   ComponentException(payload)` per the host-import error-model paragraph.
///
/// Constructors have no explicit return type in TS (the class instance is
/// implicit); callers of this function skip constructors entirely.
fn func_return(resolve: &Resolve, f: &Function, is_export: bool) -> Result<(String, Option<String>)> {
    let is_async = is_async_kind(&f.kind);
    if let Some(t) = f.result {
        // Future results are eager handles (contracts/embedder-api.md
        // §"Streams and futures"): JS promise
        // resolution unconditionally adopts thenables, so a Promise can
        // never resolve *to* a `Future<T>` (itself `PromiseLike<T>`) —
        // wrapping would make `drop`/`cancel` unreachable. The function
        // returns `Future<T>` directly, bypassing the uniform-Promise rule
        // exactly like the synchronous-constructor exception. `Stream<T>`
        // is unaffected (not thenable) and stays Promise-wrapped as usual.
        if let Some(elem) = as_top_level_future(resolve, t) {
            let elem_ts = match elem {
                Some(t) => ts_value_type(resolve, t)?,
                None => "void".to_string(),
            };
            return Ok((format!("Future<{elem_ts}>"), None));
        }
        if let Some((ok, err)) = as_top_level_result(resolve, t) {
            // Empty sides resolve `undefined` (`ComponentException.payload ===
            // undefined` on the err side) — contracts/embedder-api.md
            // value mapping table's function-result row.
            let ok_ts = match ok {
                Some(t) => ts_value_type(resolve, t)?,
                None => "undefined".to_string(),
            };
            let err_ts = match err {
                Some(t) => ts_value_type(resolve, t)?,
                None => "undefined".to_string(),
            };
            let doc = format!("@throws {{ComponentException<{err_ts}>}}");
            let ret = if is_export {
                format!("Promise<{ok_ts}>")
            } else if is_async {
                format!("{ok_ts} | Promise<{ok_ts}>")
            } else {
                ok_ts
            };
            return Ok((ret, Some(doc)));
        }
        let t_ts = ts_value_type(resolve, t)?;
        let ret = if is_export {
            format!("Promise<{t_ts}>")
        } else if is_async {
            format!("{t_ts} | Promise<{t_ts}>")
        } else {
            t_ts
        };
        return Ok((ret, None));
    }
    // No declared result. Constructor functions implicitly return the
    // resource (handled by the caller, which never routes constructors
    // through this function for their *declared* type — but `Function`
    // objects for Constructor kind may still flow through generic
    // interface-function loops for interfaces with freestanding-looking
    // entries; guard defensively).
    if let FunctionKind::Constructor(rid) = f.kind {
        let rname = resource_ts_name(resolve, rid)?;
        let ret = if is_export {
            format!("Promise<{rname}>")
        } else {
            rname
        };
        return Ok((ret, None));
    }
    let ret = if is_export {
        "Promise<void>".to_string()
    } else if is_async {
        "void | Promise<void>".to_string()
    } else {
        "void".to_string()
    };
    Ok((ret, None))
}

/// If `ty` is (possibly through a chain of named-type aliases) a
/// `result<T, E>` used directly as a function's declared result type — the
/// "as a function result" row of the value mapping table, as opposed to a
/// `result` nested inside some other structural type (record/list/tuple/
/// variant payload), which stays the ordinary `{kind,value}` value shape.
fn as_top_level_result(resolve: &Resolve, ty: Type) -> Option<(Option<Type>, Option<Type>)> {
    let Type::Id(id) = ty else { return None };
    match &resolve.types[id].kind {
        TypeDefKind::Type(inner) => as_top_level_result(resolve, *inner),
        TypeDefKind::Result(r) => Some((r.ok, r.err)),
        _ => None,
    }
}

/// Same shape of peel as `as_top_level_result`, for `future<T>` — used by
/// `func_return`'s eager-handle special case. Returns `Some(element_type)`
/// (itself optional: `future<_>` may be untyped) iff `ty` is a `future`.
fn as_top_level_future(resolve: &Resolve, ty: Type) -> Option<Option<Type>> {
    let Type::Id(id) = ty else { return None };
    match &resolve.types[id].kind {
        TypeDefKind::Type(inner) => as_top_level_future(resolve, *inner),
        TypeDefKind::Future(t) => Some(*t),
        _ => None,
    }
}

// ---------------------------------------------------------------------
// Value type mapping (contracts/embedder-api.md value mapping table)
// ---------------------------------------------------------------------

/// Parameter-position type: same as `ts_value_type` except a *top-level*
/// `stream<T>`/`future<T>` parameter widens to the accepted-producers union
/// (contracts/embedder-api.md §"Streams and futures": "lowering accepts
/// the natural JS producers") — `StreamSource<T>`/`FutureSource<T>` rather
/// than the handle types `Stream<T>`/`Future<T>`. Nested occurrences (e.g.
/// a record field of type `stream<T>`) are NOT widened — the contract's
/// producer-acceptance language is about what a guest-facing *call site*
/// hands over, not general value shapes — so those still go through
/// `ts_value_type`, which keeps `Stream<T>`/`Future<T>`.
fn ts_param_type(resolve: &Resolve, ty: Type) -> Result<String> {
    if let Type::Id(id) = ty {
        match &resolve.types[id].kind {
            TypeDefKind::Type(inner) => return ts_param_type(resolve, *inner),
            TypeDefKind::Stream(t) => {
                let inner = match t {
                    Some(t) => ts_value_type(resolve, *t)?,
                    None => "void".to_string(),
                };
                return Ok(format!("StreamSource<{inner}>"));
            }
            TypeDefKind::Future(t) => {
                let inner = match t {
                    Some(t) => ts_value_type(resolve, *t)?,
                    None => "void".to_string(),
                };
                return Ok(format!("FutureSource<{inner}>"));
            }
            _ => {}
        }
    }
    ts_value_type(resolve, ty)
}

fn ts_value_type(resolve: &Resolve, ty: Type) -> Result<String> {
    Ok(match ty {
        Type::Bool => "boolean".to_string(),
        Type::U8 | Type::U16 | Type::U32 | Type::S8 | Type::S16 | Type::S32 | Type::F32
        | Type::F64 => "number".to_string(),
        Type::U64 | Type::S64 => "bigint".to_string(),
        Type::Char => "string".to_string(),
        Type::String => "string".to_string(),
        Type::ErrorContext => "ErrorContext".to_string(),
        Type::Id(id) => ts_typedef_value_type(resolve, id)?,
    })
}

fn ts_typedef_value_type(resolve: &Resolve, id: TypeId) -> Result<String> {
    let def = &resolve.types[id];
    Ok(match &def.kind {
        TypeDefKind::Type(t) => ts_value_type(resolve, *t)?,
        TypeDefKind::Record(_) | TypeDefKind::Variant(_) | TypeDefKind::Enum(_)
        | TypeDefKind::Flags(_) => def
            .name
            .as_ref()
            .map(|n| ts_ident(n))
            .context("anonymous record/variant/enum/flags type")?,
        TypeDefKind::Tuple(t) => {
            let elements: Result<Vec<String>> =
                t.types.iter().map(|e| ts_value_type(resolve, *e)).collect();
            format!("[{}]", elements?.join(", "))
        }
        TypeDefKind::List(el) => {
            if matches!(el, Type::U8) {
                "Uint8Array".to_string()
            } else {
                format!("({})[]", ts_value_type(resolve, *el)?)
            }
        }
        TypeDefKind::FixedLengthList(el, _) => format!("({})[]", ts_value_type(resolve, *el)?),
        // map<K,V> -> its despecialization list<tuple<K,V>> -> `[K, V][]`
        // (contracts/embedder-api.md value mapping table).
        TypeDefKind::Map(k, v) => format!(
            "[{}, {}][]",
            ts_value_type(resolve, *k)?,
            ts_value_type(resolve, *v)?
        ),
        // Option rule (contracts/embedder-api.md §"Option rule"): outermost
        // maps to `T | undefined`; an option nested directly inside another
        // option uses the variant family instead. `ts_option_inner` renders
        // the "some" payload, applying that boxing recursively.
        TypeDefKind::Option(t) => format!("({} | undefined)", ts_option_inner(resolve, *t)?),
        // result<T,E> nested as a value: `{kind,value}` family, `value` absent
        // for empty sides (same row as `variant`).
        TypeDefKind::Result(r) => {
            let ok_arm = match r.ok {
                Some(t) => format!("{{ kind: \"ok\"; value: {} }}", ts_value_type(resolve, t)?),
                None => "{ kind: \"ok\" }".to_string(),
            };
            let err_arm = match r.err {
                Some(t) => format!("{{ kind: \"err\"; value: {} }}", ts_value_type(resolve, t)?),
                None => "{ kind: \"err\" }".to_string(),
            };
            format!("({ok_arm} | {err_arm})")
        }
        TypeDefKind::Handle(Handle::Own(rid)) | TypeDefKind::Handle(Handle::Borrow(rid)) => {
            resource_ts_name(resolve, *rid)?
        }
        TypeDefKind::Future(t) => {
            let inner = match t {
                Some(t) => ts_value_type(resolve, *t)?,
                None => "void".to_string(),
            };
            format!("Future<{inner}>")
        }
        TypeDefKind::Stream(t) => {
            let inner = match t {
                Some(t) => ts_value_type(resolve, *t)?,
                None => "void".to_string(),
            };
            format!("Stream<{inner}>")
        }
        TypeDefKind::Resource => bail!("bare resource used as a value type"),
        TypeDefKind::Unknown => bail!("unresolved type in a resolved Resolve"),
    })
}

/// Render the "some" payload for an option, applying the nested-option
/// boxing rule recursively: if `t` is itself an `option<...>`, box it as
/// `{ kind: "some", value: <recurse> } | { kind: "none" }`; otherwise render it
/// as a plain value type.
fn ts_option_inner(resolve: &Resolve, t: Type) -> Result<String> {
    if let Type::Id(id) = t {
        if let TypeDefKind::Option(inner) = &resolve.types[id].kind {
            let boxed = ts_option_inner(resolve, *inner)?;
            return Ok(format!(
                "({{ kind: \"some\"; value: {boxed} }} | {{ kind: \"none\" }})"
            ));
        }
    }
    ts_value_type(resolve, t)
}

/// Record-field rendering: option-typed fields are optional properties
/// (`field?: T`) rather than `field: T | undefined` (value mapping table,
/// `record` row's note) — `T` still applies the nested-option boxing rule
/// via `ts_option_inner` (the outer `| undefined` is subsumed by `?`).
fn record_field_type(resolve: &Resolve, ty: Type) -> Result<(String, bool)> {
    if let Type::Id(id) = ty {
        if let TypeDefKind::Option(inner) = &resolve.types[id].kind {
            return Ok((ts_option_inner(resolve, *inner)?, true));
        }
    }
    Ok((ts_value_type(resolve, ty)?, false))
}

// ---------------------------------------------------------------------
// Named type declarations (records/variants/enums/flags)
// ---------------------------------------------------------------------

fn collect_and_emit_types(
    resolve: &Resolve,
    _key: &WorldKey,
    item: &WorldItem,
    emitted: &mut BTreeSet<TypeId>,
    out: &mut Source,
) -> Result<()> {
    match item {
        WorldItem::Function(f) => walk_func_types(resolve, f, emitted, out)?,
        WorldItem::Interface { id, .. } => {
            let iface = &resolve.interfaces[*id];
            for tid in iface.types.values() {
                emit_named_type(resolve, *tid, emitted, out)?;
            }
            for f in iface.functions.values() {
                walk_func_types(resolve, f, emitted, out)?;
            }
        }
        WorldItem::Type { id: tid, .. } => emit_named_type(resolve, *tid, emitted, out)?,
    }
    Ok(())
}

fn walk_func_types(
    resolve: &Resolve,
    f: &Function,
    emitted: &mut BTreeSet<TypeId>,
    out: &mut Source,
) -> Result<()> {
    for p in &f.params {
        walk_type(resolve, p.ty, emitted, out)?;
    }
    if let Some(t) = f.result {
        walk_type(resolve, t, emitted, out)?;
    }
    Ok(())
}

fn walk_type(
    resolve: &Resolve,
    ty: Type,
    emitted: &mut BTreeSet<TypeId>,
    out: &mut Source,
) -> Result<()> {
    if let Type::Id(id) = ty {
        match &resolve.types[id].kind {
            TypeDefKind::Type(t) => walk_type(resolve, *t, emitted, out)?,
            TypeDefKind::Record(r) => {
                for f in &r.fields {
                    walk_type(resolve, f.ty, emitted, out)?;
                }
            }
            TypeDefKind::Tuple(t) => {
                for t in &t.types {
                    walk_type(resolve, *t, emitted, out)?;
                }
            }
            TypeDefKind::Variant(v) => {
                for c in &v.cases {
                    if let Some(t) = c.ty {
                        walk_type(resolve, t, emitted, out)?;
                    }
                }
            }
            TypeDefKind::Option(t) => walk_type(resolve, *t, emitted, out)?,
            TypeDefKind::Result(r) => {
                if let Some(t) = r.ok {
                    walk_type(resolve, t, emitted, out)?;
                }
                if let Some(t) = r.err {
                    walk_type(resolve, t, emitted, out)?;
                }
            }
            TypeDefKind::List(t) | TypeDefKind::FixedLengthList(t, _) => {
                walk_type(resolve, *t, emitted, out)?
            }
            TypeDefKind::Map(k, v) => {
                walk_type(resolve, *k, emitted, out)?;
                walk_type(resolve, *v, emitted, out)?;
            }
            _ => {}
        }
        emit_named_type(resolve, id, emitted, out)?;
    }
    Ok(())
}

fn emit_named_type(
    resolve: &Resolve,
    id: TypeId,
    emitted: &mut BTreeSet<TypeId>,
    out: &mut Source,
) -> Result<()> {
    if emitted.contains(&id) {
        return Ok(());
    }
    let def = &resolve.types[id];
    match &def.kind {
        TypeDefKind::Record(r) => {
            let Some(name) = &def.name else { return Ok(()) };
            emitted.insert(id);
            writeln!(out, "export interface {} {{", ts_ident(name))?;
            for f in &r.fields {
                let (ty, optional) = record_field_type(resolve, f.ty)?;
                let q = if optional { "?" } else { "" };
                writeln!(out, "  {}{q}: {ty};", camel_case(&f.name))?;
            }
            writeln!(out, "}}\n")?;
        }
        TypeDefKind::Variant(v) => {
            let Some(name) = &def.name else { return Ok(()) };
            emitted.insert(id);
            // `{ kind: "case" } | { kind: "case", value: T }` — `value` absent
            // (not `undefined`) for payloadless cases (value mapping table
            // + the "why a discriminant property" rationale).
            let arms: Result<Vec<String>> = v
                .cases
                .iter()
                .map(|c| {
                    Ok(match c.ty {
                        Some(t) => format!(
                            "{{ kind: {}; value: {} }}",
                            kebab_literal(&c.name),
                            ts_value_type(resolve, t)?
                        ),
                        None => format!("{{ kind: {} }}", kebab_literal(&c.name)),
                    })
                })
                .collect();
            writeln!(
                out,
                "export type {} =\n  | {};\n",
                ts_ident(name),
                arms?.join("\n  | ")
            )?;
        }
        TypeDefKind::Enum(e) => {
            let Some(name) = &def.name else { return Ok(()) };
            emitted.insert(id);
            // enum = string literal union of kebab-case case names (value
            // mapping table) — data, not `{kind}` objects (unlike variant).
            let arms: Vec<String> = e.cases.iter().map(|c| kebab_literal(&c.name)).collect();
            writeln!(out, "export type {} =\n  | {};\n", ts_ident(name), arms.join("\n  | "))?;
        }
        TypeDefKind::Flags(fl) => {
            let Some(name) = &def.name else { return Ok(()) };
            emitted.insert(id);
            writeln!(out, "export interface {} {{", ts_ident(name))?;
            for f in &fl.flags {
                writeln!(out, "  {}: boolean;", camel_case(&f.name))?;
            }
            writeln!(out, "}}\n")?;
        }
        TypeDefKind::Resource => {
            // Handled separately by `emit_resource_class` (needs the
            // gathered constructor/methods/statics bundle, not available
            // here); just mark it emitted so nothing else tries to print a
            // named-type declaration for it.
            emitted.insert(id);
        }
        _ => {}
    }
    Ok(())
}

/// Convenience used by the CLI: compute the digest and generate in one
/// step, returning `(canonical_json, digest, generated_ts)`. `import_base`
/// is resolved per [`module_specifier`].
pub fn generate_with_digest(
    resolve: &Resolve,
    world: WorldId,
    import_base: &str,
) -> Result<(String, String, String)> {
    let d = digest::compute(resolve, world)?;
    let ts = generate(resolve, world, &d.digest, import_base)?;
    Ok((d.canonical_json, d.digest, ts))
}
