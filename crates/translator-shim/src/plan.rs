//! Mapping from `wasmtime_environ::component` translation output to the
//! plan v0 schema of `contracts/plan-format.md`.
//!
//! This module is the only code that sees both shapes (wasmtime's unstable
//! internals and our stable plan format); everything wasmtime-specific is
//! confined here per docs/architecture.md §4.1.
//!
//! wasmtime-environ API reality this maps from (pinned rev, see root
//! Cargo.toml; recorded for the
//! contract-v0.1 review; see crate README):
//!
//! - `Component::exports: NameMap<TryString, (ExportIndex, ComponentExternData)>`
//!   + `export_items: PrimaryMap<ExportIndex, Export>`; `Export` variants are
//!   `LiftedFunction { ty, func, options }`, `ModuleStatic { ty, index }`,
//!   `ModuleImport { ty, import }`, `Instance { ty, exports }`, `Type(TypeDef)`.
//! - `Component::options: PrimaryMap<OptionsIndex, CanonicalOptions>` where
//!   `CanonicalOptions { instance, string_encoding, callback, post_return,
//!   async_, cancellable, core_type, data_model }` and memory/realloc live
//!   inside `data_model: CanonicalOptionsDataModel::LinearMemory(..)`.
//! - Types come from `ComponentTypesBuilder::finish(&component)`, which yields
//!   a `ComponentTypes` indexable by every `Type*Index`, including
//!   `ModuleInternedTypeIndex -> WasmSubType` for core signatures.
//! - `ExportItem::Index(EntityIndex)` is resolved here to the *name* of the
//!   core export (the JS runtime can only address exports by name), by
//!   inverting `Module::exports`.

use std::collections::HashMap;
use std::fmt::Write as _;

use anyhow::{anyhow, bail, Context, Result};

use crate::unsupported;
use serde::Serialize;
use wasmtime_environ::component::{
    CanonicalOptions, CanonicalOptionsDataModel, Component, ComponentTypes, CoreDef, CoreExport,
    Export, ExportItem, GlobalInitializer, InstantiateModule, InterfaceType, StringEncoding,
    Trampoline, TrampolineIndex, TypeDef, TypeFuncIndex, TypeResourceTable,
    TypeComponentLocalErrorContextTableIndex, TypeResourceTableIndex, TypeStreamTableIndex,
    TypeFutureTableIndex, TypeTupleIndex,
};
use wasmtime_environ::{EntityIndex, ModuleInternedTypeIndex, PrimaryMap, WasmValType};

/// `formatVersion` this producer emits (contracts/plan-format.md).
///
/// v1 (contracts/plan-format.md v0.3): additive — `CoreDef` gained the
/// `"unsafe-intrinsic"` variant (previously a hard `unsupported` rejection).
///
/// v2: additive — `streamTables` / `futureTables`, mapping the
/// `streamTable` / `futureTable` indices the stream and future trampolines
/// already carried to their *element types*. Without them a consumer knows a
/// `stream.read` targets table 3 but not what a table-3 element is, so it
/// cannot size or lift the copy buffer at all. The same gap in the other
/// direction (`task_return_type`, a `TypeTupleIndex` with no mapping into
/// `plan.types`) was still open at v2 — see below.
///
/// v3 (contracts/plan-format.md schema: the errorContextTables section and
/// the task-return raw `results` + interned `resultType` keys): closes both
/// v2 gaps.
///   * `errorContextTables` — the `error-context-transfer` trampoline's table
///     arguments live in the `TypeComponentLocalErrorContextTableIndex` space
///     and had no section, so the runtime resolved them through the
///     *resource*-table mapping (a different index space: silent mis-route in
///     a composition with an ErrorContext at a colliding slot).
///   * `task-return`'s `resultType` / raw `results` — see
///     `TrampolineDecl::TaskReturn`.
///
/// Per the contract's compat rule ("changes require updating both producer
/// and consumer in the same commit and bumping `formatVersion`") the bump is
/// unconditional even though the change is additive.
///
/// v4 (2026-08-17, polyengine#13): additive — `exports[]` gained the `"module"`
/// kind (`Export::ModuleStatic`, a component exporting one of its own
/// embedded core modules; previously a hard `unsupported` rejection).
/// `Export::ModuleImport` remains rejected, now with a precise message.
///
/// v5: tracks the wasmtime-environ rev bump (see root Cargo.toml). Breaking,
/// not additive: `CoreDef::TaskMayBlock` was removed upstream (the
/// `"task-may-block"` core-def kind is gone); `Trampoline::Trap` gained a
/// `Trap` payload (`"trap"` trampolines now carry a `code` byte); the thread
/// trampoline set was renamed/expanded (`thread-suspend-to-suspended`,
/// `thread-suspend-to`, `thread-unsuspend`, `thread-yield-to-suspended` are
/// gone; `thread-resume-later`, `thread-suspend-then-resume`,
/// `thread-yield-then-resume`, `thread-suspend-then-promote`,
/// `thread-yield-then-promote` are new; `thread-index` gained an `instance`
/// field).
pub const FORMAT_VERSION: u32 = 5;

// ---------------------------------------------------------------------------
// Plan schema (serde structs; field order == emission order == contract order)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub format_version: u32,
    pub producer: Producer,
    pub component: ComponentId,
    pub modules: Vec<ModuleEntry>,
    pub initializers: Vec<Initializer>,
    pub trampolines: Vec<TrampolineDecl>,
    pub canonical_options: Vec<OptionsDecl>,
    pub types: Vec<TypeDecl>,
    /// Resource-table metadata referenced by `own`/`borrow` `resource` fields
    /// and by resource trampolines. Index space == wasmtime's
    /// `TypeResourceTableIndex`. (Extension over the letter of plan-format.md,
    /// which references "the plan's resource table" without defining it.)
    pub resource_tables: Vec<ResourceTableDecl>,
    /// Stream-table metadata, index space == wasmtime's
    /// `TypeStreamTableIndex`; referenced by the `streamTable` field of every
    /// `stream.*` trampoline. `element` is the `T` of `stream<T>`, absent for
    /// the zero-width payload (`stream`). Plan v2.
    pub stream_tables: Vec<AsyncTableDecl>,
    /// Future-table metadata, index space == wasmtime's
    /// `TypeFutureTableIndex`; referenced by the `futureTable` field of every
    /// `future.*` trampoline. Plan v2.
    pub future_tables: Vec<AsyncTableDecl>,
    /// Error-context-table metadata, index space == wasmtime's
    /// `TypeComponentLocalErrorContextTableIndex`; the space the
    /// `error-context-transfer` trampoline's `srcTable`/`dstTable` runtime
    /// arguments live in (fact/trampoline.rs:3526-3539). Emitted from
    /// `ComponentTypes::error_context_tables` (`TypeErrorContextTable`,
    /// types.rs:1144-1151), which carries nothing but the owning instance —
    /// hence no `element` here. Plan v3 — the errorContextTables section
    /// (contracts/plan-format.md schema).
    pub error_context_tables: Vec<ErrorContextTableDecl>,
    /// Resource types this component *imports*, in `ResourceIndex` order
    /// (entry `i` is `ResourceIndex(i)`). Defined resources follow:
    /// `ResourceIndex = importedResources.len() + DefinedResourceIndex`,
    /// exactly wasmtime's `Component::resource_index`
    /// (the pinned wasmtime-environ rev, see root Cargo.toml; `component/info.rs`).
    ///
    /// The `importedResources` field (contracts/plan-format.md schema)
    /// closes this gap; the field
    /// is a **v0.2 proposal**. Emitting it is
    /// purely additive — v0.1 consumers ignore it, and it is empty for every
    /// component that imports no resource type, which is every current fixture.
    pub imported_resources: Vec<ImportedResourceDecl>,
    pub imports: Vec<ImportDecl>,
    pub exports: Vec<ExportDecl>,
    pub world_digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedResourceDecl {
    /// Index into `plan.imports` (`RuntimeImportIndex`) naming the host
    /// value that supplies this resource type.
    pub import: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Producer {
    pub shim_version: String,
    pub wasmtime_environ: String,
    pub features: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ComponentId {
    pub sha256: String,
    pub len: usize,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ModuleEntry {
    Embedded {
        offset: u64,
        len: usize,
    },
    Adapter {
        file: String,
        len: usize,
        intrinsics: Vec<IntrinsicEntry>,
    },
}

/// One import of a FACT adapter module, categorized per intrinsics.md §A.
#[derive(Debug, Serialize)]
pub struct IntrinsicEntry {
    pub module: String,
    pub name: String,
    pub category: String,
    pub def: CoreDefJson,
}

#[derive(Debug, Serialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Initializer {
    InstantiateModule {
        module: u32,
        instance: Option<u32>,
        args: Vec<CoreDefJson>,
    },
    LowerImport {
        index: u32,
        import: u32,
    },
    ExtractMemory {
        index: u32,
        export: CoreExportJson,
    },
    ExtractRealloc {
        index: u32,
        def: CoreDefJson,
    },
    ExtractCallback {
        index: u32,
        def: CoreDefJson,
    },
    ExtractPostReturn {
        index: u32,
        def: CoreDefJson,
    },
    ExtractTable {
        index: u32,
        export: CoreExportJson,
    },
    Resource {
        index: u32,
        rep: String,
        dtor: Option<CoreDefJson>,
        instance: u32,
    },
}

/// One stream or future table: the element type of the `stream<T>`/`future<T>`
/// it tracks, plus the component instance that owns it (mirrors
/// `ResourceTableDecl::Concrete`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncTableDecl {
    /// `T`, or `null` for the zero-width payload.
    pub element: Option<ValTypeJson>,
    pub instance: u32,
}

/// One entry of the `errorContextTables` section (plan v3). An error-context
/// table has no element type — wasmtime's `TypeErrorContextTable`
/// (types.rs:1144-1151) is exactly `{ instance }`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorContextTableDecl {
    pub instance: u32,
}

/// `CoreDef`, tag-for-tag per plan-format.md.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CoreDefJson {
    Export {
        instance: u32,
        item: ExportItemJson,
    },
    InstanceFlags {
        instance: u32,
    },
    Trampoline {
        index: u32,
    },
    /// `CoreDef::UnsafeIntrinsic` (plan v1). Carried by *symbol name*, not by
    /// the enum's discriminant: `UnsafeIntrinsic` is `#[repr(u32)]` over a
    /// macro-generated variant list (the pinned wasmtime-environ rev, see root
    /// Cargo.toml; `component/intrinsic.rs` `for_each_unsafe_intrinsic!`) whose ordinals
    /// are an unstable internal detail, while `name()` yields the stable
    /// spec-facing symbol (`"context-get-i32-0"`, `"u32-native-load"`, …).
    ///
    /// All 21 variants are representable on the wire; the executor implements
    /// only the four `context-{get,set}-i32-{0,1}` intrinsics (the canonical
    /// `context.{get,set}` built-ins — definitions.py:2348/2358) and fails at
    /// instantiate time on the rest. Emitting them all keeps the shim's job
    /// "faithful transcription" and moves the capability boundary into the
    /// runtime, where contracts/intrinsics.md already puts it.
    UnsafeIntrinsic {
        intrinsic: &'static str,
    },
}

/// A core-instance export reference. `ExportItem::Index` is resolved to the
/// exported *name* at translation time (a JS embedder cannot address core
/// exports by index); `space` is informational.
#[derive(Debug, Clone, Serialize)]
pub struct CoreExportJson {
    pub instance: u32,
    pub item: ExportItemJson,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportItemJson {
    pub name: String,
    pub space: &'static str,
}

/// One `wasmtime_environ::component::Trampoline`, tag-for-tag. `index` is the
/// trampoline's own index (redundant with array position, kept for
/// greppability). Type-table references: `type`/`results` point into the plan
/// `types` table; `resource` into `resourceTables`; `streamTable`/
/// `futureTable`/`errorContextTable` are raw wasmtime table indices (task-
/// scheduler machinery, no plan-level table yet); `options` into `canonicalOptions`;
/// `memory`/`callback`/`postReturn` are runtime extraction indices.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum TrampolineDecl {
    LowerImport { index: u32, lowered: u32, options: u32, r#type: u32 },
    Transcoder { index: u32, op: String, from: u32, from64: bool, to: u32, to64: bool },
    ResourceNew { index: u32, instance: u32, resource: u32 },
    ResourceRep { index: u32, instance: u32, resource: u32 },
    ResourceDrop { index: u32, instance: u32, resource: u32 },
    BackpressureInc { index: u32, instance: u32 },
    BackpressureDec { index: u32, instance: u32 },
    /// `task.return`. Plan v3 splits what v2 conflated into one `results`
    /// field:
    ///
    ///   * `results` is now the **raw** wasmtime `TypeTupleIndex` (u32), i.e.
    ///     verbatim the value FACT's `prepare-call` passes as its
    ///     `task_return_type` argument at runtime (fact.rs:47,584). Without
    ///     it a consumer cannot relate the callee's declared result type to
    ///     anything in the plan, which is exactly why
    ///     `canon_task_return`'s result-type check was skipped for FACT
    ///     tasks.
    ///   * `result_type` is that tuple interned into `plan.types` — the
    ///     task-return raw `results` + interned `resultType` keys
    ///     (contracts/plan-format.md schema). `Option` for wire
    ///     symmetry with the other nullable decl fields only: wasmtime's
    ///     `Trampoline::TaskReturn.results` is a plain `TypeTupleIndex`
    ///     (info.rs:789-796, no `Option`), so this producer always emits a
    ///     number — a no-result task carries the *empty tuple*, not `null`.
    TaskReturn { index: u32, instance: u32, results: u32, result_type: Option<u32>, options: u32 },

    TaskCancel { index: u32, instance: u32 },
    WaitableSetNew { index: u32, instance: u32 },
    WaitableSetWait { index: u32, instance: u32, options: u32 },
    WaitableSetPoll { index: u32, instance: u32, options: u32 },
    WaitableSetDrop { index: u32, instance: u32 },
    WaitableJoin { index: u32, instance: u32 },
    ThreadYield { index: u32, instance: u32, cancellable: bool },
    SubtaskDrop { index: u32, instance: u32 },
    SubtaskCancel { index: u32, instance: u32, r#async: bool },
    StreamNew { index: u32, instance: u32, stream_table: u32 },
    StreamRead { index: u32, instance: u32, stream_table: u32, options: u32 },
    StreamWrite { index: u32, instance: u32, stream_table: u32, options: u32 },
    StreamCancelRead { index: u32, instance: u32, stream_table: u32, r#async: bool },
    StreamCancelWrite { index: u32, instance: u32, stream_table: u32, r#async: bool },
    StreamDropReadable { index: u32, instance: u32, stream_table: u32 },
    StreamDropWritable { index: u32, instance: u32, stream_table: u32 },
    FutureNew { index: u32, instance: u32, future_table: u32 },
    FutureRead { index: u32, instance: u32, future_table: u32, options: u32 },
    FutureWrite { index: u32, instance: u32, future_table: u32, options: u32 },
    FutureCancelRead { index: u32, instance: u32, future_table: u32, r#async: bool },
    FutureCancelWrite { index: u32, instance: u32, future_table: u32, r#async: bool },
    FutureDropReadable { index: u32, instance: u32, future_table: u32 },
    FutureDropWritable { index: u32, instance: u32, future_table: u32 },
    ErrorContextNew { index: u32, instance: u32, error_context_table: u32, options: u32 },
    ErrorContextDebugMessage { index: u32, instance: u32, error_context_table: u32, options: u32 },
    ErrorContextDrop { index: u32, instance: u32, error_context_table: u32 },
    ResourceTransferOwn { index: u32 },
    ResourceTransferBorrow { index: u32 },
    PrepareCall { index: u32, memory: Option<u32> },
    SyncStartCall { index: u32, callback: Option<u32> },
    AsyncStartCall { index: u32, callback: Option<u32>, post_return: Option<u32> },
    FutureTransfer { index: u32 },
    StreamTransfer { index: u32 },
    ErrorContextTransfer { index: u32 },
    Trap { index: u32, code: u8 },
    EnterSyncCall { index: u32 },
    ExitSyncCall { index: u32 },
    ThreadIndex { index: u32, instance: u32 },
    ThreadNewIndirect { index: u32, instance: u32, start_func_type: u32, start_func_table: u32 },
    ThreadResumeLater { index: u32, instance: u32 },
    ThreadSuspend { index: u32, instance: u32, cancellable: bool },
    ThreadSuspendThenResume { index: u32, instance: u32, cancellable: bool },
    ThreadYieldThenResume { index: u32, instance: u32, cancellable: bool },
    ThreadSuspendThenPromote { index: u32, instance: u32, cancellable: bool },
    ThreadYieldThenPromote { index: u32, instance: u32, cancellable: bool },
}

/// Stable kind string for a wasmtime `Trampoline` (matches the serde tags of
/// `TrampolineDecl`). Exhaustive: a new wasmtime variant fails compilation.
pub fn trampoline_kind(t: &Trampoline) -> &'static str {
    use Trampoline as T;
    match t {
        T::LowerImport { .. } => "lower-import",
        T::Transcoder { .. } => "transcoder",
        T::ResourceNew { .. } => "resource-new",
        T::ResourceRep { .. } => "resource-rep",
        T::ResourceDrop { .. } => "resource-drop",
        T::BackpressureInc { .. } => "backpressure-inc",
        T::BackpressureDec { .. } => "backpressure-dec",
        T::TaskReturn { .. } => "task-return",
        T::TaskCancel { .. } => "task-cancel",
        T::WaitableSetNew { .. } => "waitable-set-new",
        T::WaitableSetWait { .. } => "waitable-set-wait",
        T::WaitableSetPoll { .. } => "waitable-set-poll",
        T::WaitableSetDrop { .. } => "waitable-set-drop",
        T::WaitableJoin { .. } => "waitable-join",
        T::ThreadYield { .. } => "thread-yield",
        T::SubtaskDrop { .. } => "subtask-drop",
        T::SubtaskCancel { .. } => "subtask-cancel",
        T::StreamNew { .. } => "stream-new",
        T::StreamRead { .. } => "stream-read",
        T::StreamWrite { .. } => "stream-write",
        T::StreamCancelRead { .. } => "stream-cancel-read",
        T::StreamCancelWrite { .. } => "stream-cancel-write",
        T::StreamDropReadable { .. } => "stream-drop-readable",
        T::StreamDropWritable { .. } => "stream-drop-writable",
        T::FutureNew { .. } => "future-new",
        T::FutureRead { .. } => "future-read",
        T::FutureWrite { .. } => "future-write",
        T::FutureCancelRead { .. } => "future-cancel-read",
        T::FutureCancelWrite { .. } => "future-cancel-write",
        T::FutureDropReadable { .. } => "future-drop-readable",
        T::FutureDropWritable { .. } => "future-drop-writable",
        T::ErrorContextNew { .. } => "error-context-new",
        T::ErrorContextDebugMessage { .. } => "error-context-debug-message",
        T::ErrorContextDrop { .. } => "error-context-drop",
        T::ResourceTransferOwn => "resource-transfer-own",
        T::ResourceTransferBorrow => "resource-transfer-borrow",
        T::PrepareCall { .. } => "prepare-call",
        T::SyncStartCall { .. } => "sync-start-call",
        T::AsyncStartCall { .. } => "async-start-call",
        T::FutureTransfer => "future-transfer",
        T::StreamTransfer => "stream-transfer",
        T::ErrorContextTransfer => "error-context-transfer",
        T::Trap(_) => "trap",
        T::EnterSyncCall => "enter-sync-call",
        T::ExitSyncCall => "exit-sync-call",
        T::ThreadIndex { .. } => "thread-index",
        T::ThreadNewIndirect { .. } => "thread-new-indirect",
        T::ThreadResumeLater { .. } => "thread-resume-later",
        T::ThreadSuspend { .. } => "thread-suspend",
        T::ThreadSuspendThenResume { .. } => "thread-suspend-then-resume",
        T::ThreadYieldThenResume { .. } => "thread-yield-then-resume",
        T::ThreadSuspendThenPromote { .. } => "thread-suspend-then-promote",
        T::ThreadYieldThenPromote { .. } => "thread-yield-then-promote",
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionsDecl {
    pub instance: u32,
    pub string_encoding: &'static str,
    pub memory: Option<u32>,
    pub realloc: Option<u32>,
    pub post_return: Option<u32>,
    pub callback: Option<u32>,
    pub r#async: bool,
    pub cancellable: bool,
    pub core_type: CoreFuncTypeJson,
}

#[derive(Debug, Serialize)]
pub struct CoreFuncTypeJson {
    pub params: Vec<&'static str>,
    pub results: Vec<&'static str>,
}

/// One entry in the plan `types` table. Entries are either component function
/// types or plain value types (descriptor-ir.md ValType JSON); the `kind`
/// discriminator distinguishes them ("func" is not a ValType kind).
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum TypeDecl {
    Func {
        kind: &'static str, // always "func"
        params: Vec<NamedValType>,
        results: Vec<ValTypeJson>,
        r#async: bool,
    },
    Value(ValTypeJson),
}

#[derive(Debug, Serialize)]
pub struct NamedValType {
    pub label: String,
    pub r#type: ValTypeJson,
}

/// descriptor-ir.md ValType wire form (nested structurally).
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ValTypeJson {
    Bool,
    S8,
    U8,
    S16,
    U16,
    S32,
    U32,
    S64,
    U64,
    F32,
    F64,
    Char,
    String,
    List {
        element: Box<ValTypeJson>,
        #[serde(skip_serializing_if = "Option::is_none")]
        length: Option<u32>,
    },
    Record {
        fields: Vec<NamedValType>,
    },
    Tuple {
        elements: Vec<ValTypeJson>,
    },
    Variant {
        cases: Vec<CaseJson>,
    },
    Enum {
        labels: Vec<String>,
    },
    Option {
        r#type: Box<ValTypeJson>,
    },
    Result {
        ok: Option<Box<ValTypeJson>>,
        err: Option<Box<ValTypeJson>>,
    },
    Map {
        key: Box<ValTypeJson>,
        value: Box<ValTypeJson>,
    },
    Flags {
        labels: Vec<String>,
    },
    Own {
        resource: u32,
    },
    Borrow {
        resource: u32,
    },
    Stream {
        element: Option<Box<ValTypeJson>>,
    },
    Future {
        element: Option<Box<ValTypeJson>>,
    },
    ErrorContext,
}

#[derive(Debug, Serialize)]
pub struct CaseJson {
    pub label: String,
    pub r#type: Option<ValTypeJson>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ResourceTableDecl {
    /// Concrete resource table: `resource` is the component-wide
    /// `ResourceIndex`, `instance` the owning component instance.
    Concrete { resource: u32, instance: u32 },
    /// Abstract (type-only) resource table; carries no runtime state.
    Abstract { id: u32 },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDecl {
    pub name: String,
    /// Names walked *into* an imported instance to reach the leaf item
    /// (empty for direct imports). Mirrors wasmtime's
    /// `imports: PrimaryMap<RuntimeImportIndex, (ImportIndex, Vec<String>)>`.
    pub path: Vec<String>,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ExportDecl {
    LiftedFunc {
        name: String,
        core_def: CoreDefJson,
        options: u32,
        r#type: u32,
    },
    Instance {
        name: String,
        exports: Vec<ExportDecl>,
    },
    /// Informational type export (e.g. an exported resource type).
    Type {
        name: String,
        r#type: TypeExportJson,
    },
    /// An exported embedded core module; `module` indexes the static module
    /// space (`plan.modules`) — the `module` export kind
    /// (contracts/plan-format.md schema notes).
    Module {
        name: String,
        module: u32,
    },
}

impl ExportDecl {
    fn name(&self) -> &str {
        match self {
            ExportDecl::LiftedFunc { name, .. }
            | ExportDecl::Instance { name, .. }
            | ExportDecl::Type { name, .. }
            | ExportDecl::Module { name, .. } => name,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TypeExportJson {
    /// An exported resource type; `resource` indexes `resourceTables`.
    Resource { resource: u32 },
    /// Any other exported (value) type, by `types` table index.
    Value { r#type: u32 },
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/// Type-table interning key: wasmtime type indices are only comparable within
/// one translation, which is all we need.
#[derive(Hash, PartialEq, Eq, Clone, Copy)]
enum TypeKey {
    Func(TypeFuncIndex),
    ResultsTuple(TypeTupleIndex),
    Val(InterfaceType),
}

pub struct PlanBuilder<'a> {
    component: &'a Component,
    trampolines: &'a PrimaryMap<TrampolineIndex, Trampoline>,
    types: &'a ComponentTypes,
    /// Static module index -> export name table for ExportItem::Index
    /// resolution.
    module_export_names: Vec<Vec<(String, EntityIndex)>>,
    /// Total number of resource tables (`ComponentTypesBuilder::
    /// num_resource_tables()`, captured before `finish()` — `ComponentTypes`
    /// itself does not expose the count).
    num_resource_tables: usize,
    /// Same for stream/future tables (plan v2).
    num_stream_tables: usize,
    num_future_tables: usize,
    /// Same for error-context tables (plan v3).
    num_error_context_tables: usize,
    /// RuntimeInstanceIndex -> StaticModuleIndex, built while walking
    /// initializers in order.
    instance_to_module: Vec<u32>,
    type_table: Vec<TypeDecl>,
    type_index: HashMap<TypeKey, u32>,
}

impl<'a> PlanBuilder<'a> {
    pub fn new(
        component: &'a Component,
        trampolines: &'a PrimaryMap<TrampolineIndex, Trampoline>,
        types: &'a ComponentTypes,
        module_export_names: Vec<Vec<(String, EntityIndex)>>,
        num_resource_tables: usize,
        num_stream_tables: usize,
        num_future_tables: usize,
        num_error_context_tables: usize,
    ) -> Self {
        PlanBuilder {
            component,
            trampolines,
            types,
            module_export_names,
            num_resource_tables,
            num_stream_tables,
            num_future_tables,
            num_error_context_tables,
            instance_to_module: Vec::new(),
            type_table: Vec::new(),
            type_index: HashMap::new(),
        }
    }

    /// Build the full plan. `module_entries` must already describe the static
    /// module index space (embedded/adapter, offsets/lengths); the intrinsics
    /// manifests of adapter entries are filled in here.
    pub fn build(
        mut self,
        producer: Producer,
        component_id: ComponentId,
        mut module_entries: Vec<ModuleEntry>,
        adapter_import_names: &HashMap<u32, Vec<(String, String)>>,
    ) -> Result<Plan> {
        let component = self.component;

        // 1. Initializers (also builds instance_to_module, needed by CoreDef
        //    resolution everywhere else).
        let mut initializers = Vec::new();
        for init in &component.initializers {
            initializers.push(self.initializer(init)?);
        }

        // 2. Adapter intrinsics manifests: zip each adapter's import names
        //    with its instantiation args (adapt.rs guarantees 1:1 order).
        for init in &initializers {
            if let Initializer::InstantiateModule {
                module,
                instance: None,
                args,
            } = init
            {
                let names = adapter_import_names.get(module).ok_or_else(|| {
                    anyhow!("no import names recorded for adapter module {module}")
                })?;
                if names.len() != args.len() {
                    bail!(
                        "adapter module {module}: {} imports but {} instantiation args",
                        names.len(),
                        args.len()
                    );
                }
                let manifest: Vec<IntrinsicEntry> = names
                    .iter()
                    .zip(args.iter())
                    .map(|((module_name, field), def)| IntrinsicEntry {
                        module: module_name.clone(),
                        name: field.clone(),
                        category: self.intrinsic_category(def),
                        def: def.clone(),
                    })
                    .collect();
                match &mut module_entries[*module as usize] {
                    ModuleEntry::Adapter { intrinsics, .. } => *intrinsics = manifest,
                    ModuleEntry::Embedded { .. } => bail!(
                        "initializer instantiates module {module} as adapter (instance=null) \
                         but the module is embedded"
                    ),
                }
            }
        }

        // 3. Trampolines.
        let mut trampolines = Vec::new();
        for (idx, t) in self.trampolines.iter() {
            trampolines.push(self.trampoline(idx.as_u32(), t)?);
        }

        // 4. Canonical options.
        let mut canonical_options = Vec::new();
        for (_, opts) in component.options.iter() {
            canonical_options.push(self.options(opts)?);
        }

        // 5. Resource tables.
        let mut resource_tables = Vec::new();
        for i in 0..self.num_resource_tables {
            let idx = TypeResourceTableIndex::from_u32(i as u32);
            resource_tables.push(match &self.types[idx] {
                TypeResourceTable::Concrete { ty, instance } => ResourceTableDecl::Concrete {
                    resource: ty.as_u32(),
                    instance: instance.as_u32(),
                },
                TypeResourceTable::Abstract(id) => ResourceTableDecl::Abstract { id: id.as_u32() },
            });
        }

        // 5b. Stream / future tables (plan v2). Element types are resolved the
        // same way `val_type` resolves an `InterfaceType::Stream`/`Future`:
        // table -> stream/future type -> payload.
        let mut stream_tables = Vec::new();
        for i in 0..self.num_stream_tables {
            let idx = TypeStreamTableIndex::from_u32(i as u32);
            let table = self.types[idx].clone();
            let payload = self.types[table.ty].payload;
            stream_tables.push(AsyncTableDecl {
                element: payload.map(|t| self.val_type(&t)).transpose()?,
                instance: table.instance.as_u32(),
            });
        }
        let mut future_tables = Vec::new();
        for i in 0..self.num_future_tables {
            let idx = TypeFutureTableIndex::from_u32(i as u32);
            let table = self.types[idx].clone();
            let payload = self.types[table.ty].payload;
            future_tables.push(AsyncTableDecl {
                element: payload.map(|t| self.val_type(&t)).transpose()?,
                instance: table.instance.as_u32(),
            });
        }

        // 5c. Error-context tables (plan v3). `PrimaryMap` order, i.e. the
        // `TypeComponentLocalErrorContextTableIndex` space; walked by index so
        // nothing hash-ordered can reach the output.
        let mut error_context_tables = Vec::new();
        for i in 0..self.num_error_context_tables {
            let idx = TypeComponentLocalErrorContextTableIndex::from_u32(i as u32);
            error_context_tables.push(ErrorContextTableDecl {
                instance: self.types[idx].instance.as_u32(),
            });
        }

        // 6. Imports (RuntimeImportIndex order).
        let mut imports = Vec::new();
        for (_, (import_idx, path)) in component.imports.iter() {
            let (name, ext) = &component.import_types[*import_idx];
            let leaf = self.resolve_import_leaf(&ext.ty, path)?;
            let (kind, ty) = self.extern_kind_and_type(&leaf)?;
            imports.push(ImportDecl {
                name: name.clone(),
                path: path.to_vec(),
                kind,
                r#type: ty,
            });
        }

        // 6b. Imported resources, in ResourceIndex order (v0.2 proposal; see
        //     the `Plan::imported_resources` docs). Emitted *after* imports so
        //     the `import` back-references can be range-checked here.
        let mut imported_resources = Vec::new();
        for (_, runtime_import) in component.imported_resources.iter() {
            let idx = runtime_import.as_u32();
            if idx as usize >= imports.len() {
                bail!(
                    "imported resource references runtime import {idx}, but the \
                     component has {} runtime imports",
                    imports.len()
                );
            }
            imported_resources.push(ImportedResourceDecl { import: idx });
        }

        // 7. Exports (component export-name insertion order).
        let mut exports = Vec::new();
        for (name, (export_idx, _)) in component.exports.raw_iter() {
            exports.push(self.export(name.as_str(), &component.export_items[*export_idx])?);
        }

        // 8. World digest over the typed surface.
        let world_digest = world_digest(&imports, &exports, &self.type_table)?;

        Ok(Plan {
            format_version: FORMAT_VERSION,
            producer,
            component: component_id,
            modules: module_entries,
            initializers,
            trampolines,
            canonical_options,
            types: self.type_table,
            resource_tables,
            stream_tables,
            future_tables,
            error_context_tables,
            imported_resources,
            imports,
            exports,
            world_digest,
        })
    }

    // -- initializers -------------------------------------------------------

    fn initializer(&mut self, init: &GlobalInitializer) -> Result<Initializer> {
        Ok(match init {
            GlobalInitializer::InstantiateModule(instantiate, component_instance) => {
                match instantiate {
                    InstantiateModule::Static(idx, args) => {
                        let args = args
                            .iter()
                            .map(|def| self.core_def(def))
                            .collect::<Result<Vec<_>>>()?;
                        // This instantiation creates the next RuntimeInstanceIndex.
                        self.instance_to_module.push(idx.as_u32());
                        Initializer::InstantiateModule {
                            module: idx.as_u32(),
                            instance: component_instance.map(|i| i.as_u32()),
                            args,
                        }
                    }
                    InstantiateModule::Import(..) => unsupported!(
                        "imported-module instantiation (InstantiateModule::Import) is not \
                         supported in plan v0 (contracts/plan-format.md open items)"
                    ),
                }
            }
            GlobalInitializer::LowerImport { index, import } => Initializer::LowerImport {
                index: index.as_u32(),
                import: import.as_u32(),
            },
            GlobalInitializer::ExtractMemory(e) => Initializer::ExtractMemory {
                index: e.index.as_u32(),
                export: self.core_export(&e.export.clone().map_index(EntityIndex::from))?,
            },
            GlobalInitializer::ExtractRealloc(e) => Initializer::ExtractRealloc {
                index: e.index.as_u32(),
                def: self.core_def(&e.def)?,
            },
            GlobalInitializer::ExtractCallback(e) => Initializer::ExtractCallback {
                index: e.index.as_u32(),
                def: self.core_def(&e.def)?,
            },
            GlobalInitializer::ExtractPostReturn(e) => Initializer::ExtractPostReturn {
                index: e.index.as_u32(),
                def: self.core_def(&e.def)?,
            },
            GlobalInitializer::ExtractTable(e) => Initializer::ExtractTable {
                index: e.index.as_u32(),
                export: self.core_export(&e.export.clone().map_index(EntityIndex::from))?,
            },
            GlobalInitializer::Resource(r) => Initializer::Resource {
                index: r.index.as_u32(),
                rep: wasm_val_type(&r.rep)?.to_string(),
                dtor: r.dtor.as_ref().map(|d| self.core_def(d)).transpose()?,
                instance: r.instance.as_u32(),
            },
        })
    }

    // -- core defs ----------------------------------------------------------

    fn core_def(&self, def: &CoreDef) -> Result<CoreDefJson> {
        Ok(match def {
            CoreDef::Export(e) => {
                let e = self.core_export(e)?;
                CoreDefJson::Export {
                    instance: e.instance,
                    item: e.item,
                }
            }
            CoreDef::InstanceFlags(i) => CoreDefJson::InstanceFlags {
                instance: i.as_u32(),
            },
            CoreDef::Trampoline(i) => CoreDefJson::Trampoline { index: i.as_u32() },
            CoreDef::UnsafeIntrinsic(i) => CoreDefJson::UnsafeIntrinsic { intrinsic: i.name() },
        })
    }

    fn core_export(&self, e: &CoreExport<EntityIndex>) -> Result<CoreExportJson> {
        let instance = e.instance.as_u32();
        let item = match &e.item {
            ExportItem::Name(name) => ExportItemJson {
                name: name.clone(),
                space: "unknown",
            },
            ExportItem::Index(entity) => {
                let module =
                    *self
                        .instance_to_module
                        .get(instance as usize)
                        .ok_or_else(|| {
                            anyhow!(
                                "CoreExport references runtime instance {instance} before creation"
                            )
                        })?;
                let names = &self.module_export_names[module as usize];
                let name = names
                    .iter()
                    .find(|(_, idx)| idx == entity)
                    .map(|(name, _)| name.clone())
                    .ok_or_else(|| {
                        anyhow!(
                            "core module {module} has no export for entity {entity:?} \
                             (required by ExportItem::Index resolution)"
                        )
                    })?;
                ExportItemJson {
                    name,
                    space: entity_space(entity),
                }
            }
        };
        Ok(CoreExportJson { instance, item })
    }

    fn intrinsic_category(&self, def: &CoreDefJson) -> String {
        match def {
            CoreDefJson::Export { .. } => "core-def".to_string(),
            CoreDefJson::InstanceFlags { .. } => "instance-flags".to_string(),
            CoreDefJson::UnsafeIntrinsic { intrinsic } => {
                format!("unsafe-intrinsic:{intrinsic}")
            }
            CoreDefJson::Trampoline { index } => {
                let idx = TrampolineIndex::from_u32(*index);
                format!("trampoline:{}", trampoline_kind(&self.trampolines[idx]))
            }
        }
    }

    // -- trampolines ----------------------------------------------------------

    fn trampoline(&mut self, index: u32, t: &Trampoline) -> Result<TrampolineDecl> {
        use Trampoline as T;
        Ok(match t {
            T::LowerImport {
                index: lowered,
                lower_ty,
                options,
            } => TrampolineDecl::LowerImport {
                index,
                lowered: lowered.as_u32(),
                options: options.as_u32(),
                r#type: self.intern_func_type(*lower_ty)?,
            },
            T::Transcoder {
                op,
                from,
                from64,
                to,
                to64,
            } => TrampolineDecl::Transcoder {
                index,
                op: op.desc().to_string(),
                from: from.as_u32(),
                from64: *from64,
                to: to.as_u32(),
                to64: *to64,
            },
            T::ResourceNew { instance, ty } => TrampolineDecl::ResourceNew {
                index,
                instance: instance.as_u32(),
                resource: ty.as_u32(),
            },
            T::ResourceRep { instance, ty } => TrampolineDecl::ResourceRep {
                index,
                instance: instance.as_u32(),
                resource: ty.as_u32(),
            },
            T::ResourceDrop { instance, ty } => TrampolineDecl::ResourceDrop {
                index,
                instance: instance.as_u32(),
                resource: ty.as_u32(),
            },
            T::BackpressureInc { instance } => TrampolineDecl::BackpressureInc {
                index,
                instance: instance.as_u32(),
            },
            T::BackpressureDec { instance } => TrampolineDecl::BackpressureDec {
                index,
                instance: instance.as_u32(),
            },
            T::TaskReturn {
                instance,
                results,
                options,
            } => TrampolineDecl::TaskReturn {
                index,
                instance: instance.as_u32(),
                // Raw `TypeTupleIndex` (the runtime `task_return_type` key)
                // *and* its interned `plan.types` entry — see the decl docs.
                results: results.as_u32(),
                result_type: Some(self.intern_results_tuple(*results)?),
                options: options.as_u32(),
            },
            T::TaskCancel { instance } => TrampolineDecl::TaskCancel {
                index,
                instance: instance.as_u32(),
            },
            T::WaitableSetNew { instance } => TrampolineDecl::WaitableSetNew {
                index,
                instance: instance.as_u32(),
            },
            T::WaitableSetWait { instance, options } => TrampolineDecl::WaitableSetWait {
                index,
                instance: instance.as_u32(),
                options: options.as_u32(),
            },
            T::WaitableSetPoll { instance, options } => TrampolineDecl::WaitableSetPoll {
                index,
                instance: instance.as_u32(),
                options: options.as_u32(),
            },
            T::WaitableSetDrop { instance } => TrampolineDecl::WaitableSetDrop {
                index,
                instance: instance.as_u32(),
            },
            T::WaitableJoin { instance } => TrampolineDecl::WaitableJoin {
                index,
                instance: instance.as_u32(),
            },
            T::ThreadYield {
                instance,
                cancellable,
            } => TrampolineDecl::ThreadYield {
                index,
                instance: instance.as_u32(),
                cancellable: *cancellable,
            },
            T::SubtaskDrop { instance } => TrampolineDecl::SubtaskDrop {
                index,
                instance: instance.as_u32(),
            },
            T::SubtaskCancel { instance, async_ } => TrampolineDecl::SubtaskCancel {
                index,
                instance: instance.as_u32(),
                r#async: *async_,
            },
            T::StreamNew { instance, ty } => TrampolineDecl::StreamNew {
                index,
                instance: instance.as_u32(),
                stream_table: ty.as_u32(),
            },
            T::StreamRead {
                instance,
                ty,
                options,
            } => TrampolineDecl::StreamRead {
                index,
                instance: instance.as_u32(),
                stream_table: ty.as_u32(),
                options: options.as_u32(),
            },
            T::StreamWrite {
                instance,
                ty,
                options,
            } => TrampolineDecl::StreamWrite {
                index,
                instance: instance.as_u32(),
                stream_table: ty.as_u32(),
                options: options.as_u32(),
            },
            T::StreamCancelRead {
                instance,
                ty,
                async_,
            } => TrampolineDecl::StreamCancelRead {
                index,
                instance: instance.as_u32(),
                stream_table: ty.as_u32(),
                r#async: *async_,
            },
            T::StreamCancelWrite {
                instance,
                ty,
                async_,
            } => TrampolineDecl::StreamCancelWrite {
                index,
                instance: instance.as_u32(),
                stream_table: ty.as_u32(),
                r#async: *async_,
            },
            T::StreamDropReadable { instance, ty } => TrampolineDecl::StreamDropReadable {
                index,
                instance: instance.as_u32(),
                stream_table: ty.as_u32(),
            },
            T::StreamDropWritable { instance, ty } => TrampolineDecl::StreamDropWritable {
                index,
                instance: instance.as_u32(),
                stream_table: ty.as_u32(),
            },
            T::FutureNew { instance, ty } => TrampolineDecl::FutureNew {
                index,
                instance: instance.as_u32(),
                future_table: ty.as_u32(),
            },
            T::FutureRead {
                instance,
                ty,
                options,
            } => TrampolineDecl::FutureRead {
                index,
                instance: instance.as_u32(),
                future_table: ty.as_u32(),
                options: options.as_u32(),
            },
            T::FutureWrite {
                instance,
                ty,
                options,
            } => TrampolineDecl::FutureWrite {
                index,
                instance: instance.as_u32(),
                future_table: ty.as_u32(),
                options: options.as_u32(),
            },
            T::FutureCancelRead {
                instance,
                ty,
                async_,
            } => TrampolineDecl::FutureCancelRead {
                index,
                instance: instance.as_u32(),
                future_table: ty.as_u32(),
                r#async: *async_,
            },
            T::FutureCancelWrite {
                instance,
                ty,
                async_,
            } => TrampolineDecl::FutureCancelWrite {
                index,
                instance: instance.as_u32(),
                future_table: ty.as_u32(),
                r#async: *async_,
            },
            T::FutureDropReadable { instance, ty } => TrampolineDecl::FutureDropReadable {
                index,
                instance: instance.as_u32(),
                future_table: ty.as_u32(),
            },
            T::FutureDropWritable { instance, ty } => TrampolineDecl::FutureDropWritable {
                index,
                instance: instance.as_u32(),
                future_table: ty.as_u32(),
            },
            T::ErrorContextNew {
                instance,
                ty,
                options,
            } => TrampolineDecl::ErrorContextNew {
                index,
                instance: instance.as_u32(),
                error_context_table: ty.as_u32(),
                options: options.as_u32(),
            },
            T::ErrorContextDebugMessage {
                instance,
                ty,
                options,
            } => TrampolineDecl::ErrorContextDebugMessage {
                index,
                instance: instance.as_u32(),
                error_context_table: ty.as_u32(),
                options: options.as_u32(),
            },
            T::ErrorContextDrop { instance, ty } => TrampolineDecl::ErrorContextDrop {
                index,
                instance: instance.as_u32(),
                error_context_table: ty.as_u32(),
            },
            T::ResourceTransferOwn => TrampolineDecl::ResourceTransferOwn { index },
            T::ResourceTransferBorrow => TrampolineDecl::ResourceTransferBorrow { index },
            T::PrepareCall { memory } => TrampolineDecl::PrepareCall {
                index,
                memory: memory.map(|m| m.as_u32()),
            },
            T::SyncStartCall { callback } => TrampolineDecl::SyncStartCall {
                index,
                callback: callback.map(|c| c.as_u32()),
            },
            T::AsyncStartCall {
                callback,
                post_return,
            } => TrampolineDecl::AsyncStartCall {
                index,
                callback: callback.map(|c| c.as_u32()),
                post_return: post_return.map(|p| p.as_u32()),
            },
            T::FutureTransfer => TrampolineDecl::FutureTransfer { index },
            T::StreamTransfer => TrampolineDecl::StreamTransfer { index },
            T::ErrorContextTransfer => TrampolineDecl::ErrorContextTransfer { index },
            T::Trap(trap) => TrampolineDecl::Trap { index, code: *trap as u8 },
            T::EnterSyncCall => TrampolineDecl::EnterSyncCall { index },
            T::ExitSyncCall => TrampolineDecl::ExitSyncCall { index },
            T::ThreadIndex { instance } => TrampolineDecl::ThreadIndex {
                index,
                instance: instance.as_u32(),
            },
            T::ThreadNewIndirect {
                instance,
                start_func_ty_idx,
                start_func_table_idx,
            } => TrampolineDecl::ThreadNewIndirect {
                index,
                instance: instance.as_u32(),
                start_func_type: start_func_ty_idx.as_u32(),
                start_func_table: start_func_table_idx.as_u32(),
            },
            T::ThreadResumeLater { instance } => TrampolineDecl::ThreadResumeLater {
                index,
                instance: instance.as_u32(),
            },
            T::ThreadSuspend {
                instance,
                cancellable,
            } => TrampolineDecl::ThreadSuspend {
                index,
                instance: instance.as_u32(),
                cancellable: *cancellable,
            },
            T::ThreadSuspendThenResume {
                instance,
                cancellable,
            } => TrampolineDecl::ThreadSuspendThenResume {
                index,
                instance: instance.as_u32(),
                cancellable: *cancellable,
            },
            T::ThreadYieldThenResume {
                instance,
                cancellable,
            } => TrampolineDecl::ThreadYieldThenResume {
                index,
                instance: instance.as_u32(),
                cancellable: *cancellable,
            },
            T::ThreadSuspendThenPromote {
                instance,
                cancellable,
            } => TrampolineDecl::ThreadSuspendThenPromote {
                index,
                instance: instance.as_u32(),
                cancellable: *cancellable,
            },
            T::ThreadYieldThenPromote {
                instance,
                cancellable,
            } => TrampolineDecl::ThreadYieldThenPromote {
                index,
                instance: instance.as_u32(),
                cancellable: *cancellable,
            },
        })
    }

    // -- imports/exports ------------------------------------------------------

    fn resolve_import_leaf(&self, root: &TypeDef, path: &[String]) -> Result<TypeDef> {
        let mut current = *root;
        for name in path {
            match current {
                TypeDef::ComponentInstance(idx) => {
                    let instance = &self.types[idx];
                    let ext = instance.exports.get(name.as_str()).ok_or_else(|| {
                        anyhow!("import path segment '{name}' not found in instance type")
                    })?;
                    current = ext.ty;
                }
                other => unsupported!(
                    "import path walks through non-instance type {}: unsupported",
                    other.desc()
                ),
            }
        }
        Ok(current)
    }

    fn extern_kind_and_type(&mut self, ty: &TypeDef) -> Result<(&'static str, Option<u32>)> {
        Ok(match ty {
            TypeDef::ComponentFunc(idx) => ("func", Some(self.intern_func_type(*idx)?)),
            TypeDef::Module(_) => ("module", None),
            TypeDef::ComponentInstance(_) => ("instance", None),
            TypeDef::Resource(_) => ("resource", None),
            TypeDef::Interface(it) => ("type", Some(self.intern_val_type_entry(*it)?)),
            other => unsupported!("unsupported import kind: {}", other.desc()),
        })
    }

    fn export(&mut self, name: &str, export: &Export) -> Result<ExportDecl> {
        Ok(match export {
            Export::LiftedFunction { ty, func, options } => ExportDecl::LiftedFunc {
                name: name.to_string(),
                core_def: self.core_def(func)?,
                options: options.as_u32(),
                r#type: self.intern_func_type(*ty)?,
            },
            Export::Instance { exports, .. } => {
                let component = self.component;
                let mut decls = Vec::new();
                for (sub_name, (export_idx, _)) in exports.raw_iter() {
                    decls.push(
                        self.export(sub_name.as_str(), &component.export_items[*export_idx])?,
                    );
                }
                ExportDecl::Instance {
                    name: name.to_string(),
                    exports: decls,
                }
            }
            Export::Type(def) => {
                let ty = match def {
                    TypeDef::Resource(idx) => TypeExportJson::Resource {
                        resource: idx.as_u32(),
                    },
                    TypeDef::Interface(it) => TypeExportJson::Value {
                        r#type: self.intern_val_type_entry(*it)?,
                    },
                    other => unsupported!("unsupported type export: {}", other.desc()),
                };
                ExportDecl::Type {
                    name: name.to_string(),
                    r#type: ty,
                }
            }
            // A component exporting one of its own embedded core modules:
            // the StaticModuleIndex is the plan's static module space
            // directly (the `module` export kind, contracts/plan-format.md
            // schema notes; conformance pin binary.wast:1421).
            Export::ModuleStatic { index, .. } => ExportDecl::Module {
                name: name.to_string(),
                module: index.as_u32(),
            },
            Export::ModuleImport { .. } => unsupported!(
                "re-exporting an imported module is not supported (export \
                 '{name}'); module imports have no instantiation story yet \
                 (the Export::ModuleImport rejection, contracts/plan-format.md \
                 schema notes)"
            ),
        })
    }

    // -- type interning -------------------------------------------------------

    fn intern_func_type(&mut self, idx: TypeFuncIndex) -> Result<u32> {
        if let Some(&i) = self.type_index.get(&TypeKey::Func(idx)) {
            return Ok(i);
        }
        let func = &self.types[idx];
        let param_tuple = &self.types[func.params];
        if func.param_names.len() != param_tuple.types.len() {
            bail!(
                "TypeFunc param_names/params arity mismatch: {} names vs {} types",
                func.param_names.len(),
                param_tuple.types.len()
            );
        }
        let params = func
            .param_names
            .iter()
            .zip(param_tuple.types.iter())
            .map(|(name, ty)| {
                Ok(NamedValType {
                    label: name.clone(),
                    r#type: self.val_type(ty)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let result_tuple = &self.types[func.results];
        let results = result_tuple
            .types
            .iter()
            .map(|ty| self.val_type(ty))
            .collect::<Result<Vec<_>>>()?;
        let decl = TypeDecl::Func {
            kind: "func",
            params,
            results,
            r#async: func.async_,
        };
        let i = self.type_table.len() as u32;
        self.type_table.push(decl);
        self.type_index.insert(TypeKey::Func(idx), i);
        Ok(i)
    }

    /// Intern a `task.return` results tuple as a plain tuple ValType entry.
    fn intern_results_tuple(&mut self, idx: TypeTupleIndex) -> Result<u32> {
        if let Some(&i) = self.type_index.get(&TypeKey::ResultsTuple(idx)) {
            return Ok(i);
        }
        let tuple = &self.types[idx];
        let elements = tuple
            .types
            .iter()
            .map(|ty| self.val_type(ty))
            .collect::<Result<Vec<_>>>()?;
        let decl = TypeDecl::Value(ValTypeJson::Tuple { elements });
        let i = self.type_table.len() as u32;
        self.type_table.push(decl);
        self.type_index.insert(TypeKey::ResultsTuple(idx), i);
        Ok(i)
    }

    fn intern_val_type_entry(&mut self, it: InterfaceType) -> Result<u32> {
        if let Some(&i) = self.type_index.get(&TypeKey::Val(it)) {
            return Ok(i);
        }
        let json = self.val_type(&it)?;
        let i = self.type_table.len() as u32;
        self.type_table.push(TypeDecl::Value(json));
        self.type_index.insert(TypeKey::Val(it), i);
        Ok(i)
    }

    /// Structural (nested) descriptor-IR JSON for an interface type.
    fn val_type(&self, it: &InterfaceType) -> Result<ValTypeJson> {
        use InterfaceType as IT;
        Ok(match it {
            IT::Bool => ValTypeJson::Bool,
            IT::S8 => ValTypeJson::S8,
            IT::U8 => ValTypeJson::U8,
            IT::S16 => ValTypeJson::S16,
            IT::U16 => ValTypeJson::U16,
            IT::S32 => ValTypeJson::S32,
            IT::U32 => ValTypeJson::U32,
            IT::S64 => ValTypeJson::S64,
            IT::U64 => ValTypeJson::U64,
            IT::Float32 => ValTypeJson::F32,
            IT::Float64 => ValTypeJson::F64,
            IT::Char => ValTypeJson::Char,
            IT::String => ValTypeJson::String,
            IT::Record(idx) => {
                let record = &self.types[*idx];
                let fields = record
                    .fields
                    .iter()
                    .map(|f| {
                        Ok(NamedValType {
                            label: f.name.clone(),
                            r#type: self.val_type(&f.ty)?,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                ValTypeJson::Record { fields }
            }
            IT::Variant(idx) => {
                let variant = &self.types[*idx];
                let cases = variant
                    .cases
                    .iter()
                    .map(|(label, ty)| {
                        Ok(CaseJson {
                            label: label.clone(),
                            r#type: ty.as_ref().map(|t| self.val_type(t)).transpose()?,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                ValTypeJson::Variant { cases }
            }
            IT::List(idx) => ValTypeJson::List {
                element: Box::new(self.val_type(&self.types[*idx].element)?),
                length: None,
            },
            IT::FixedLengthList(idx) => {
                let fll = &self.types[*idx];
                ValTypeJson::List {
                    element: Box::new(self.val_type(&fll.element)?),
                    length: Some(fll.size),
                }
            }
            IT::Tuple(idx) => {
                let tuple = &self.types[*idx];
                let elements = tuple
                    .types
                    .iter()
                    .map(|t| self.val_type(t))
                    .collect::<Result<Vec<_>>>()?;
                ValTypeJson::Tuple { elements }
            }
            IT::Map(idx) => {
                let map = &self.types[*idx];
                ValTypeJson::Map {
                    key: Box::new(self.val_type(&map.key)?),
                    value: Box::new(self.val_type(&map.value)?),
                }
            }
            IT::Flags(idx) => ValTypeJson::Flags {
                labels: self.types[*idx].names.iter().cloned().collect(),
            },
            IT::Enum(idx) => ValTypeJson::Enum {
                labels: self.types[*idx].names.iter().cloned().collect(),
            },
            IT::Option(idx) => ValTypeJson::Option {
                r#type: Box::new(self.val_type(&self.types[*idx].ty)?),
            },
            IT::Result(idx) => {
                let result = &self.types[*idx];
                ValTypeJson::Result {
                    ok: result
                        .ok
                        .as_ref()
                        .map(|t| Ok::<_, anyhow::Error>(Box::new(self.val_type(t)?)))
                        .transpose()?,
                    err: result
                        .err
                        .as_ref()
                        .map(|t| Ok::<_, anyhow::Error>(Box::new(self.val_type(t)?)))
                        .transpose()?,
                }
            }
            IT::Own(idx) => ValTypeJson::Own {
                resource: idx.as_u32(),
            },
            IT::Borrow(idx) => ValTypeJson::Borrow {
                resource: idx.as_u32(),
            },
            IT::Future(idx) => {
                let table = &self.types[*idx];
                let payload = self.types[table.ty].payload;
                ValTypeJson::Future {
                    element: payload
                        .map(|t| Ok::<_, anyhow::Error>(Box::new(self.val_type(&t)?)))
                        .transpose()?,
                }
            }
            IT::Stream(idx) => {
                let table = &self.types[*idx];
                let payload = self.types[table.ty].payload;
                ValTypeJson::Stream {
                    element: payload
                        .map(|t| Ok::<_, anyhow::Error>(Box::new(self.val_type(&t)?)))
                        .transpose()?,
                }
            }
            IT::ErrorContext(_) => ValTypeJson::ErrorContext,
        })
    }

    // -- canonical options ----------------------------------------------------

    fn options(&self, opts: &CanonicalOptions) -> Result<OptionsDecl> {
        let (memory, realloc) = match &opts.data_model {
            CanonicalOptionsDataModel::LinearMemory(lm) => (
                lm.memory.map(|m| m.as_u32()),
                lm.realloc.map(|r| r.as_u32()),
            ),
            CanonicalOptionsDataModel::Gc {} => unsupported!(
                "GC data model in canonical options is rejected in plan v0 \
                 (contracts/descriptor-ir.md)"
            ),
        };
        Ok(OptionsDecl {
            instance: opts.instance.as_u32(),
            string_encoding: match opts.string_encoding {
                StringEncoding::Utf8 => "utf8",
                StringEncoding::Utf16 => "utf16",
                StringEncoding::CompactUtf16 => "latin1+utf16",
            },
            memory,
            realloc,
            post_return: opts.post_return.map(|p| p.as_u32()),
            callback: opts.callback.map(|c| c.as_u32()),
            r#async: opts.async_,
            cancellable: opts.cancellable,
            core_type: self.core_func_type(opts.core_type)?,
        })
    }

    fn core_func_type(&self, idx: ModuleInternedTypeIndex) -> Result<CoreFuncTypeJson> {
        let sub = &self.types[idx];
        let func = sub
            .as_func()
            .ok_or_else(|| anyhow!("canonical-options core type {idx:?} is not a function"))?;
        Ok(CoreFuncTypeJson {
            params: func
                .params()
                .iter()
                .map(wasm_val_type)
                .collect::<Result<Vec<_>>>()?,
            results: func
                .results()
                .iter()
                .map(wasm_val_type)
                .collect::<Result<Vec<_>>>()?,
        })
    }
}

fn wasm_val_type(t: &WasmValType) -> Result<&'static str> {
    Ok(match t {
        WasmValType::I32 => "i32",
        WasmValType::I64 => "i64",
        WasmValType::F32 => "f32",
        WasmValType::F64 => "f64",
        other => unsupported!("unsupported core value type in plan v0: {other:?}"),
    })
}

fn entity_space(e: &EntityIndex) -> &'static str {
    match e {
        EntityIndex::Function(_) => "func",
        EntityIndex::Table(_) => "table",
        EntityIndex::Memory(_) => "memory",
        EntityIndex::Global(_) => "global",
        EntityIndex::Tag(_) => "tag",
    }
}

/// v0 world digest: sha256 over a canonical JSON serialization of
/// `{imports, exports, types}` with import/export names sorted (recursively
/// for instance exports). See contracts/plan-format.md.
fn world_digest(
    imports: &[ImportDecl],
    exports: &[ExportDecl],
    types: &[TypeDecl],
) -> Result<String> {
    #[derive(Serialize)]
    struct Digest<'a> {
        imports: Vec<&'a ImportDecl>,
        exports: Vec<serde_json::Value>,
        types: &'a [TypeDecl],
    }

    fn sorted_export(e: &ExportDecl) -> Result<serde_json::Value> {
        let mut v = serde_json::to_value(e)?;
        sort_instance_exports(&mut v);
        Ok(v)
    }

    fn sort_instance_exports(v: &mut serde_json::Value) {
        if let Some(exports) = v.get_mut("exports").and_then(|x| x.as_array_mut()) {
            let mut items = std::mem::take(exports);
            for item in &mut items {
                sort_instance_exports(item);
            }
            items.sort_by(|a, b| {
                a["name"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["name"].as_str().unwrap_or(""))
            });
            *exports = items;
        }
    }

    let mut imports_sorted: Vec<&ImportDecl> = imports.iter().collect();
    imports_sorted.sort_by(|a, b| (&a.name, &a.path).cmp(&(&b.name, &b.path)));
    let mut exports_sorted: Vec<&ExportDecl> = exports.iter().collect();
    exports_sorted.sort_by(|a, b| a.name().cmp(b.name()));
    let exports_json = exports_sorted
        .into_iter()
        .map(sorted_export)
        .collect::<Result<Vec<_>>>()?;

    let doc = Digest {
        imports: imports_sorted,
        exports: exports_json,
        types,
    };
    let json = serde_json::to_string(&doc).context("serializing world digest input")?;
    Ok(format!("sha256:{}", sha256_hex(json.as_bytes())))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        write!(&mut out, "{b:02x}").unwrap();
    }
    out
}
