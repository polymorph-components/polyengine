//! translator-shim: `wasmtime-environ`'s component frontend (validation,
//! linking resolution, FACT fused-adapter synthesis) behind a stable output
//! format — the **plan v0** of `contracts/plan-format.md`.
//!
//! Promoted from translator-spike (`crates/translator-spike`). The spike's debug
//! `Summary` is replaced by the contract artifact set:
//!
//! - `plan.json` — the plan (schema: `src/plan.rs`)
//! - `adapters/<static-module-index>.wasm` — FACT-generated core modules
//!
//! Over the wasm C-ABI both are returned in one JSON **envelope**
//! (shim-internal wire format, see README.md):
//!
//! ```json
//! { "plan": { ... }, "adapters": [ { "file": "adapters/2.wasm", "wasm": "<base64>" } ] }
//! ```
//!
//! Exact wasmtime-environ 47.0.3 entry points used:
//!
//! - `Translator::new(&Tunables, &mut wasmparser::Validator,
//!   &mut ComponentTypesBuilder, &ScopeVec<u8>)`
//! - `Translator::translate(self, &[u8]) -> Result<(ComponentTranslation,
//!   PrimaryMap<StaticModuleIndex, ModuleTranslation>)>`
//! - `ComponentTypesBuilder::finish(&Component) -> (ComponentTypes, _)` for
//!   the post-translation type tables (component types + interned core types).
//!
//! FACT-generated adapter modules come back as *extra entries* in the returned
//! `PrimaryMap<StaticModuleIndex, ModuleTranslation>`, after the component's
//! embedded core modules. They are distinguished by checking whether a
//! module's `wasm` slice points into the input component buffer (embedded) or
//! into the `ScopeVec` arena (FACT-generated).

use std::collections::HashMap;

use anyhow::{bail, Result};
use base64::Engine as _;
use serde::Serialize;
use wasmtime_environ::component::{ComponentTypesBuilder, Translator};
use wasmtime_environ::{ScopeVec, Tunables, wasmparser};

pub mod error;
pub mod plan;

pub use error::{Phase, TranslateError};
pub use plan::Plan;

/// One FACT adapter artifact: file name (as referenced from
/// `plan.modules[].file`) plus raw core-wasm bytes.
#[derive(Debug)]
pub struct AdapterArtifact {
    pub file: String,
    pub wasm: Vec<u8>,
}

/// Full translation output: the contract's artifact set.
#[derive(Debug)]
pub struct Translation {
    pub plan: Plan,
    pub adapters: Vec<AdapterArtifact>,
}

/// Wasm feature set used for validation during translation.
///
/// `wasmparser` 0.252 defaults already include `component_model` and
/// `cm_async` (component-model-async). We additionally enable the async
/// trailing features (mirroring wasmtime's
/// `-W component-model-async=y,component-model-error-context=y`) and the
/// gated component-model extensions the official suite exercises:
/// fixed-length lists, maps, `implements`, and threading. Rationale: those
/// suite files contain components the suite expects to *decode* (`module` /
/// `module_definition` commands); with the gates off the shim rejects them
/// with a feature-gate error, which is not a conformance verdict we want to
/// claim. Enabling them was checked against the whole corpus: it does not
/// turn any `assert_invalid`/`assert_malformed` case into an acceptance
/// (`cargo run -p translator-shim --example suite-inventory`).
fn features() -> wasmparser::WasmFeatures {
    let mut f = wasmparser::WasmFeatures::default();
    f.insert(wasmparser::WasmFeatures::CM_ASYNC);
    f.insert(wasmparser::WasmFeatures::CM_ASYNC_STACKFUL);
    f.insert(wasmparser::WasmFeatures::CM_MORE_ASYNC_BUILTINS);
    f.insert(wasmparser::WasmFeatures::CM_ERROR_CONTEXT);
    f.insert(wasmparser::WasmFeatures::CM_FIXED_LENGTH_LISTS);
    f.insert(wasmparser::WasmFeatures::CM_MAP);
    f.insert(wasmparser::WasmFeatures::CM_IMPLEMENTS);
    f.insert(wasmparser::WasmFeatures::CM_THREADING);
    // ISSUE #95 TRIPWIRE — do not enable `CM_VALUES`.
    //
    // Trusted wasmtime-environ 47.0.3's component frontend has two
    // `unimplemented!()` panics that a `CM_VALUES`-accepted component can
    // reach: a component `start` section (translate.rs:1338) and a
    // component-level value import/export (translate.rs:1499). With the
    // feature off (the wasmparser 0.252 default excludes it, and nothing
    // above turns it on), `wasmparser::Validator` rejects both shapes during
    // validation — a `TranslateError { phase: Validation, .. }` envelope,
    // never reaching the translator body that panics. That is exercised and
    // pinned by `tests/cm_values_tripwire.rs`.
    //
    // Turning `CM_VALUES` on would convert that validation-phase rejection
    // into a genuine panic. On the native (test) build that unwinds and is
    // merely an ugly failure; on the wasm32-unknown-unknown C-ABI build this
    // crate ships (`just shim`; `Cargo.toml`'s release profile pins
    // `panic = "abort"` for that target — see the note on `catch_unwind`
    // below) it is a hard trap with **no JSON envelope at all**, violating
    // this crate's "never panics on invalid input" claim (see the doc
    // comment on the C-ABI entry point). If `CM_VALUES` is ever enabled here,
    // the translate.rs call sites above need a real plan-format mapping (or
    // an explicit `phase: Unsupported` pre-check) before the flag flips.
    f
}


/// Feature names recorded in `plan.producer.features`. Must describe
/// `features()` — part of the artifact-cache key.
fn feature_names() -> Vec<String> {
    [
        "cm-async",
        "cm-async-stackful",
        "cm-more-async-builtins",
        "cm-error-context",
        "cm-fixed-length-lists",
        "cm-map",
        "cm-implements",
        "cm-threading",
    ]
        .map(String::from)
        .to_vec()
}

/// Translate a component binary into plan v0 + adapter artifacts.
///
/// Runs wasmtime's full component frontend: parse + validate + type-check the
/// component, resolve its linking structure to a flat initializer list, run
/// FACT to synthesize fused adapters, then map everything to the plan schema.
pub fn translate(component_bytes: &[u8]) -> std::result::Result<Translation, TranslateError> {
    translate_inner(component_bytes)
}

fn translate_inner(
    component_bytes: &[u8],
) -> std::result::Result<Translation, TranslateError> {
    // `default_u32()` rather than `default_host()`: keeps native tests and the
    // wasm32 build byte-identical. FACT consults only `concurrency_support`
    // (true) and `debug_adapter_modules` (false) from tunables.
    let tunables = Tunables::default_u32();
    let mut validator = wasmparser::Validator::new_with_features(features());
    let mut types = ComponentTypesBuilder::new(&validator);
    let scope = ScopeVec::new();

    // Everything up to and including this call is wasmtime's frontend:
    // a failure here means the input is invalid/malformed (Phase::Validation).
    let (translation, modules) = Translator::new(&tunables, &mut validator, &mut types, &scope)
        .translate(component_bytes)
        .map_err(|e| TranslateError::from_frontend(e.into()))?;

    // Core function *bodies* are not validated by `Translator::translate`:
    // wasmtime defers that to its compiler backend, which consumes the
    // `FuncToValidate` handed out in `FunctionBodyData`. We have no compiler
    // backend, so we run those validators here — otherwise components with
    // an invalid nested core module (official suite
    // `test/validation/core-modules.wast:24`) would translate successfully
    // and only be rejected later by the JS engine's `WebAssembly.compile`.
    // Verdict phase is `validation`: this is still "the input is invalid".
    validate_function_bodies(component_bytes, &modules)?;

    // From here on we are mapping wasmtime's (already accepted) output into
    // the plan schema: failures are `unsupported` or `internal`, never
    // `validation` (see `error.rs`).
    map_translation(component_bytes, translation, modules, types)
        .map_err(TranslateError::from_plan_error)
}

fn map_translation(
    component_bytes: &[u8],
    translation: wasmtime_environ::component::ComponentTranslation,
    modules: wasmtime_environ::PrimaryMap<
        wasmtime_environ::component::StaticModuleIndex,
        wasmtime_environ::ModuleTranslation<'_>,
    >,
    types: ComponentTypesBuilder,
) -> Result<Translation> {
    // Capture counts only available on the builder, then finish the type
    // tables (moves core module types in as well).
    let num_resource_tables = types.num_resource_tables();
    let num_stream_tables = types.num_stream_tables();
    let num_future_tables = types.num_future_tables();
    let num_error_context_tables = types.num_error_context_tables();
    let (component_types, _world_ty) = types.finish(&translation.component);

    // Distinguish embedded modules (slices of the input) from FACT adapters
    // (owned by the ScopeVec arena) by pointer containment.
    let base = component_bytes.as_ptr() as usize;
    let end = base + component_bytes.len();

    let mut module_entries = Vec::new();
    let mut adapters = Vec::new();
    let mut adapter_import_names: HashMap<u32, Vec<(String, String)>> = HashMap::new();
    let mut module_export_names = Vec::new();

    for (idx, mt) in modules.iter() {
        let ptr = mt.wasm.as_ptr() as usize;
        let embedded = ptr >= base && ptr + mt.wasm.len() <= end;

        // Export-name table (EntityIndex -> name), for ExportItem::Index
        // resolution in the plan builder.
        let export_names: Vec<(String, wasmtime_environ::EntityIndex)> = mt
            .module
            .exports
            .iter()
            .map(|(atom, entity)| (mt.module.strings[*atom].to_string(), *entity))
            .collect();
        module_export_names.push(export_names);

        if embedded {
            let offset = mt.wasm_module_offset;
            // Sanity: the recorded offset must locate exactly this slice.
            if offset as usize != ptr - base {
                bail!(
                    "module {}: wasm_module_offset {} disagrees with slice position {}",
                    idx.as_u32(),
                    offset,
                    ptr - base
                );
            }
            module_entries.push(plan::ModuleEntry::Embedded {
                offset,
                len: mt.wasm.len(),
            });
        } else {
            let file = format!("adapters/{}.wasm", idx.as_u32());
            module_entries.push(plan::ModuleEntry::Adapter {
                file: file.clone(),
                len: mt.wasm.len(),
                intrinsics: Vec::new(), // filled by PlanBuilder::build
            });
            adapter_import_names.insert(
                idx.as_u32(),
                mt.module
                    .imports()
                    .map(|(module, field, _)| (module.to_string(), field.to_string()))
                    .collect(),
            );
            adapters.push(AdapterArtifact {
                file,
                wasm: mt.wasm.to_vec(),
            });
        }
    }

    let producer = plan::Producer {
        shim_version: env!("CARGO_PKG_VERSION").to_string(),
        wasmtime_environ: "47.0.3".to_string(),
        features: feature_names(),
    };
    let component_id = plan::ComponentId {
        sha256: plan::sha256_hex(component_bytes),
        len: component_bytes.len(),
    };

    let plan = plan::PlanBuilder::new(
        &translation.component,
        &translation.trampolines,
        &component_types,
        module_export_names,
        num_resource_tables,
        num_stream_tables,
        num_future_tables,
        num_error_context_tables,
    )
    .build(producer, component_id, module_entries, &adapter_import_names)?;

    Ok(Translation { plan, adapters })
}

/// Run wasmparser's deferred per-function validators over every core module in
/// the translation.
///
/// The verdict phase depends on *whose* module failed, which is the same
/// embedded-vs-FACT distinction `map_translation` makes by pointer
/// containment: an **embedded** module belongs to the input, so a bad body
/// means the component is invalid (`validation`); a **FACT-generated** adapter
/// is code we asked wasmtime to synthesize, so a bad body is a defect in our
/// pipeline (`internal`) and must never be reported as a judgment about the
/// input component.
fn validate_function_bodies(
    component_bytes: &[u8],
    modules: &wasmtime_environ::PrimaryMap<
        wasmtime_environ::component::StaticModuleIndex,
        wasmtime_environ::ModuleTranslation<'_>,
    >,
) -> std::result::Result<(), TranslateError> {
    let base = component_bytes.as_ptr() as usize;
    let end = base + component_bytes.len();
    let mut allocs = wasmparser::FuncValidatorAllocations::default();
    for (idx, mt) in modules.iter() {
        let ptr = mt.wasm.as_ptr() as usize;
        let embedded = ptr >= base && ptr + mt.wasm.len() <= end;
        for (_, body) in mt.function_body_inputs.iter() {
            let to_validate = wasmparser::FuncToValidate {
                resources: body.validator.resources.clone(),
                index: body.validator.index,
                ty: body.validator.ty,
                features: body.validator.features,
            };
            let mut validator = to_validate.into_validator(allocs);
            if let Err(e) = validator.validate(&body.body) {
                return Err(if embedded {
                    TranslateError::new(Phase::Validation, format!("{e}"))
                } else {
                    TranslateError::new(
                        Phase::Internal,
                        format!(
                            "FACT-generated adapter module {} failed core \
                             validation: {e}",
                            idx.as_u32()
                        ),
                    )
                });
            }
            allocs = validator.into_allocations();
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Envelope (C-ABI wire format)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct EnvelopeAdapter<'a> {
    file: &'a str,
    wasm: String, // base64 (standard alphabet, padded)
}

#[derive(Serialize)]
struct Envelope<'a> {
    plan: &'a Plan,
    adapters: Vec<EnvelopeAdapter<'a>>,
}

/// Serialize a translation to the single-JSON envelope returned over the
/// C-ABI. Deterministic: struct field order is fixed, maps are not used,
/// and adapter bytes are deterministic FACT output.
pub fn to_envelope_json(t: &Translation) -> Result<String> {
    let envelope = Envelope {
        plan: &t.plan,
        adapters: t
            .adapters
            .iter()
            .map(|a| EnvelopeAdapter {
                file: &a.file,
                wasm: base64::engine::general_purpose::STANDARD.encode(&a.wasm),
            })
            .collect(),
    };
    Ok(serde_json::to_string(&envelope)?)
}

/// Convenience: translate and produce the envelope (or an error envelope).
/// This is the function behind `ts_translate`; it never panics on invalid
/// input, returning `{"error": "..."}` instead.
pub fn translate_to_envelope(component_bytes: &[u8]) -> String {
    let err = match translate(component_bytes) {
        Ok(t) => match to_envelope_json(&t) {
            Ok(json) => return json,
            // Serializing our own plan cannot fail on valid data; if it does,
            // that is a shim bug, not a verdict about the component.
            Err(e) => TranslateError::new(Phase::Internal, format!("{e:?}")),
        },
        Err(e) => e,
    };
    error_envelope_json(&err)
}

/// The C-ABI error envelope.
///
// CONTRACT: contracts/plan-format.md / translator-shim README pin the error
// envelope as `{"error": "<message>"}` and "no other field present". The
// `error` string keeps exactly that meaning; `errorDetail` is an additive
// sibling carrying the structured verdict (phase + message). v0.2 proposal.
pub fn error_envelope_json(e: &TranslateError) -> String {
    serde_json::to_string(&serde_json::json!({
        "error": e.message,
        "errorDetail": e,
    }))
    .unwrap_or_else(|_| r#"{"error":"unknown","errorDetail":{"phase":"internal","message":"unknown","detail":""}}"#.to_string())
}

/// C-ABI surface for the wasm32 build (used by the Deno driver).
///
/// Contract (unchanged from the spike):
/// - `ts_alloc(len) -> ptr`: allocate `len` bytes (caller writes input here).
/// - `ts_translate(ptr, len, out_len: *mut usize) -> out_ptr`: translate the
///   component at `ptr..ptr+len`. Writes the output length to `*out_len` and
///   returns the output pointer; the output is UTF-8 JSON — either the
///   envelope (`{"plan":…, "adapters":…}`) or `{"error": "..."}`.
/// - `ts_dealloc(ptr, len)`: free a buffer from `ts_alloc`/`ts_translate`.
pub mod cabi {
    use super::translate_to_envelope;

    #[no_mangle]
    pub extern "C" fn ts_alloc(len: usize) -> *mut u8 {
        let mut buf = Vec::<u8>::with_capacity(len);
        let ptr = buf.as_mut_ptr();
        core::mem::forget(buf);
        ptr
    }

    /// # Safety
    /// `ptr` must come from `ts_alloc`/`ts_translate` with the same `len`.
    #[no_mangle]
    pub unsafe extern "C" fn ts_dealloc(ptr: *mut u8, len: usize) {
        if !ptr.is_null() && len != 0 {
            drop(Vec::from_raw_parts(ptr, 0, len));
        }
    }

    /// # Safety
    /// `ptr..ptr+len` must be valid initialized memory (from `ts_alloc`);
    /// `out_len` must be valid for a `usize` write.
    #[no_mangle]
    pub unsafe extern "C" fn ts_translate(
        ptr: *const u8,
        len: usize,
        out_len: *mut usize,
    ) -> *mut u8 {
        let bytes = core::slice::from_raw_parts(ptr, len);
        let json = translate_to_envelope(bytes);
        // Copy into a fresh exact-size allocation (same layout contract as
        // `ts_alloc`) rather than leaking the String's own buffer: capacity
        // == len is then guaranteed for `ts_dealloc`.
        let src = json.as_bytes();
        let out = ts_alloc(src.len());
        core::ptr::copy_nonoverlapping(src.as_ptr(), out, src.len());
        *out_len = src.len();
        out
    }
}
