// Plan executor (docs/architecture.md §4.3 item 1): compile sliced core modules and FACT
// adapters, run the plan's `initializers` strictly in order, wire the
// component's typed export surface through the task model.
//
// Executor obligations implemented per contracts/plan-format.md:
//   - formatVersion validation (via plan loader), fail fast
//   - strict initializer order; semantics per wasmtime GlobalInitializer
//   - instantiate-time (not call-time) failure for unsupported trampolines /
//     ops (milestone-aware, contracts/intrinsics.md)
//   - component hash verification against plan.component

import type { ComponentValue, FuncType, ValType } from "../cabi/types.ts";
import { Trap } from "../cabi/trap.ts";
import { ComponentInstanceState, Store } from "../task/mod.ts";
import {
  anySuspendingImport,
  assertModeConsistent,
  type SuspendingImport,
  chooseMode,
  isAbortable,
  isDeferCancel,
  isSuspending,
  planNeedsSuspension,
  suspendingImport,
  trampolineCanBlock,
  trampolineNeedsSuspension,
  type SuspensionMode,
} from "../jspi/mod.ts";
import {
  loadPlan,
  PlanError,
  resourceIndexOfDefined,
} from "../plan/loader.ts";
import { PendingCapability } from "../task/mod.ts";
import type {
  WireCanonicalOptions,
  WireCoreDef,
  WireCoreExport,
  WireExport,
  WirePlan,
  WireTrampoline,
} from "../plan/format.ts";
import type { LoadedPlan, LoadedType } from "../plan/loader.ts";
import {
  SYNC_ENTRY,
  type CoreFn,
  createDtorEntry,
  createLiftedFunction,
  createLoweredImport,
  type ExecutionStats,
  LiveMemory,
  newStats,
  type ResolvedOptions,
} from "./boundary.ts";
import {
  createTrampoline,
  createUnsafeIntrinsic,
  type PreparedCall,
  type HostTrapState,
  type FactStartScope,
  type SyncCallScope,
  TranscodeMemory,
} from "../intrinsics/mod.ts";

/**
 * Standing probe (CE_COPY_TRACE): log which import made a core instance
 * suspendable — the first question to ask whenever a FACT callee is
 * promising-wrapped that should not be. Read once, permission-safe.
 */
const SUSPENDABLE_TRACE = (() => {
  try {
    return Deno.env.get("CE_COPY_TRACE") === "1";
  } catch {
    return false;
  }
})();

/**
 * Host-provided imports: a nested record keyed by the component's *exact*
 * import strings. A plan import with a non-empty `path` (an item extracted
 * from an imported instance — `imports[].path`, contracts/plan-format.md
 * schema) is looked up
 * by walking `imports[name]` then each path segment in order. So an import
 * of `"ns:pkg/iface"` exposing `f` is supplied as
 * `{ "ns:pkg/iface": { f: (…) => … } }`.
 *
 * Leaf values by import kind:
 *   - `func`     — a JS function; arguments/results are host-shaped
 *                  component values (contracts/descriptor-ir.md).
 *   - `resource` — a `HostResourceType` (see `hostResourceType`).
 *   - `instance` — a plain object; only its leaves are ever read.
 *   - `module`   — not supported (see `InstantiateModule::Import` below).
 */
export type HostImports = Record<string, unknown>;

/**
 * Identity token for a resource type **defined by the host** and imported by
 * a component (plan `importedResources`). One object per resource type;
 * object identity is the type identity, exactly as for guest-defined
 * resources whose identity is the per-instantiation `ResourceTypeInfo`.
 */
export class HostResourceType {
  constructor(
    readonly options: {
      /** Debug name, used in error messages only. */
      readonly name?: string;
      /**
       * Destructor for handles owned by a component and dropped there.
       * Per docs/architecture.md §7 / CanonicalABI.md `canon resource.drop`, it runs
       * synchronously and may not block.
       */
      readonly dtor?: (rep: number) => void;
    } = {},
  ) {}
}

/** Convenience constructor for {@link HostResourceType}. */
export function hostResourceType(
  options?: HostResourceType["options"],
): HostResourceType {
  return new HostResourceType(options ?? {});
}

export interface InstantiateInput {
  plan: WirePlan;
  /** The original component binary (embedded modules are sliced from it). */
  componentBytes: Uint8Array;
  /** FACT adapter artifacts keyed by `plan.modules[].file`. */
  adapters?: Map<string, Uint8Array>;
  imports?: HostImports;
  /** Verify plan.component.sha256 against componentBytes (default true). */
  verifyHash?: boolean;
  /**
   * Opt in to JSPI-backed suspension (docs/architecture.md §6 role 1-3).
   *
   * Off by default, and deliberately so: in this mode every lifted export
   * returns a Promise (empirical fact (e) — `WebAssembly.promising` always
   * does), which is an API-shape change. Ignored on an engine without JSPI,
   * where every blocking site keeps raising the precise `NeedsJspi` it raises
   * today (the browser-matrix degradation path; see `just browsers`).
   */
  jspi?: boolean;
  /**
   * A plan already converted by `loadPlan`, used instead of re-loading.
   *
   * Why this exists: the conventions layer (`src/embedder/`) must have the
   * per-instantiation `ResourceTypeInfo` identity tokens and the converted
   * types table *before* instantiation begins, because host imports genuinely
   * fire DURING it — a core module's `start` function runs inside
   * `runInitializers`, and real guests do call imports from it (Go's runtime
   * calls `monotonic-clock.now()` from `schedinit`). Reading them off the
   * returned `ComponentHandle.loadedPlan` is therefore too late. Handing the
   * same `LoadedPlan` in keeps the tokens identical on both sides.
   *
   * Contract: one `LoadedPlan` per instantiation (tokens must be fresh per
   * component instance), and `loadedPlan.wire` must be `plan`. Both are
   * checked.
   */
  loadedPlan?: LoadedPlan;
}

/** An instantiated component: its export surface plus introspection state. */
export interface ComponentHandle {
  /** Lifted functions / nested instance objects, by export name. */
  exports: Record<string, unknown>;
  stats: ExecutionStats;
  componentInstances: ComponentInstanceState[];
  coreInstances: WebAssembly.Instance[];
  /** See `Executor.suspendableFuncs`. */
  suspendableFuncs: WeakSet<object>;
  taskMayBlock: WebAssembly.Global;
  /** `ResourceIndex` -> the `HostResourceType` bound to it, if any. */
  hostResourceTypes: Map<number, HostResourceType>;
  /**
   * Plan exports deliberately absent from `exports`, by export path, with the
   * reason. Only `type` exports appear here; a missing *function* export is
   * always an error, never an omission (see `Executor.buildExport`).
   */
  omittedExports: Map<string, string>;
  /**
   * The plan as loaded for THIS instantiation.
   *
   * Exposed for the conventions layer (`src/embedder/`), which needs the two
   * things only the executor's own `loadPlan` call can supply: the per-instance
   * `ResourceTypeInfo` identity tokens (`resourceTokens`) — the same objects
   * the `own`/`borrow` types in every signature point at, and the only route to
   * a resource's destructor for a *host-initiated* drop of a guest handle
   * (definitions.py `canon_resource_drop` runs `rt.dtor(rep)`; the host holds
   * reps, never table indices, so there is no handle to drop through) — and the
   * converted `types` table it reads function signatures from.
   *
   * Introspection only: mutating it is undefined behaviour.
   */
  loadedPlan: LoadedPlan;
}

/**
 * Compiled core modules per plan identity — see `compileModules`. Keyed by
 * the `WirePlan` object (the embedder passes the same plan for every
 * instantiation of one `ComponentArtifacts`), with the byte buffers that fed
 * the compile re-checked by identity on every hit. WeakMap: entries die with
 * the plan.
 */
interface ModuleCacheEntry {
  componentBytes: Uint8Array;
  /** Per wire-module slot: the adapter bytes compiled, `undefined` for embedded. */
  adapterRefs: (Uint8Array | undefined)[];
  modules: Promise<WebAssembly.Module[]>;
}
const moduleCache = new WeakMap<WirePlan, ModuleCacheEntry>();

export async function instantiateComponent(
  input: InstantiateInput,
): Promise<ComponentHandle> {
  // Re-load per instantiation: resource identity tokens must be fresh per
  // component instance (descriptor-ir.md open item on ResourceTypeInfo).
  // Re-load unless the caller already did (see `InstantiateInput.loadedPlan`).
  const loaded = input.loadedPlan ?? loadPlan(input.plan);
  if (loaded.wire !== input.plan) {
    throw new PlanError(
      "instantiateComponent: `loadedPlan` was converted from a different " +
        "plan document than `plan`",
    );
  }
  const executor = new Executor(loaded, input);
  await executor.verifyComponent();
  await executor.compileModules();
  executor.bindImportedResources();
  await executor.runInitializers();
  return executor.finish();
}

type Importable =
  | SuspendingImport
  | CoreFn
  | WebAssembly.Global
  | WebAssembly.Memory
  | WebAssembly.Table;

class Executor {
  readonly wire: WirePlan;
  readonly loaded: LoadedPlan;
  readonly componentBytes: Uint8Array;
  readonly adapterBytes: Map<string, Uint8Array>;
  readonly hostImports: HostImports;
  readonly verifyHash: boolean;
  /** See `InstantiateInput.jspi` and jspi/bridge.ts's invariant. */
  readonly suspensionMode: SuspensionMode;

  readonly stats: ExecutionStats = newStats();
  readonly modules: WebAssembly.Module[] = [];
  readonly instances: WebAssembly.Instance[] = [];
  readonly componentInstances = new Map<number, ComponentInstanceState>();
  /**
   * One scheduler `Store` for the whole component, shared by every component
   * instance in it — matching definitions.py, where a linked graph of
   * `ComponentInstance`s shares the `Store` that owns the waiting-thread list
   * (`ComponentInstance.__init__` takes `store`). A per-instance store would
   * make a thread blocked in one instance invisible to a driving loop in
   * another.
   */
  readonly store = new Store();
  /**
   * Memoized `unsafe-intrinsic` core functions, by DECLARING COMPONENT
   * INSTANCE and symbol.
   *
   * The instance is part of the key because `context.{get,set}` resolve their
   * thread against it (`currentThreadForInstance`, task/scheduler.ts): the
   * declaring instance is the one whose core frame is executing when the
   * intrinsic is called, which is what keeps a JSPI continuation chunk's
   * `context.set` out of a sibling task's slots. `null` keys the shared
   * adapter/instance-less flavour (the plan records `instance: null` for FACT
   * adapter modules).
   */
  readonly unsafeIntrinsics = new Map<string, CoreFn>();

  /**
   * The component instance of the core module currently being instantiated
   * (`instantiate-module`'s `instance` field; null for a FACT adapter). Read
   * by `unsafeIntrinsic` while its import list is being resolved — the one
   * place a core instance's owning component instance is stated by the plan.
   */
  #declaringInstance: ComponentInstanceState | null = null;
  /** The single in-flight FACT `prepare-call` state (intrinsics/fact_calls.ts). */
  readonly preparedCall: { current: PreparedCall | null } = { current: null };
  /**
   * One `LiveMemory` per `RuntimeMemoryIndex`, memoized.
   *
   * definitions.py's `LiftOptions.equal` (line 643) compares memories by
   * *identity* (`lhs.memory is rhs.memory`), and `canon_task_return` requires
   * the options at the `task.return` site to equal the lifted export's. A
   * fresh wrapper per `resolveOptions` call would make that comparison fail
   * for every component that actually uses a memory — it only ever passed
   * before because the async fixtures in play had `memory: null` on both
   * sides. Memoizing restores wasmtime's semantics, where the comparison is
   * on `RuntimeMemoryIndex`.
   */
  readonly liveMemories = new Map<number, LiveMemory>();
  /** Set by the entry/import wrapping sites; checked in `finish`. */
  wrappedEntries = false;
  wrappedImports = false;

  /** Record that an entry / import wrapping site ran under the current mode. */
  noteEntry(): SuspensionMode {
    if (this.suspensionMode === "jspi") this.wrappedEntries = true;
    return this.suspensionMode;
  }

  noteImport(): SuspensionMode {
    if (this.suspensionMode === "jspi") this.wrappedImports = true;
    return this.suspensionMode;
  }
  readonly taskMayBlock = new WebAssembly.Global(
    { value: "i32", mutable: true },
    1,
  );

  // extract-* landing zones (index spaces per plan-format.md).
  readonly memories: WebAssembly.Memory[] = [];
  readonly reallocs: CoreFn[] = [];
  readonly postReturns: CoreFn[] = [];
  readonly callbacks: CoreFn[] = [];
  readonly tables: WebAssembly.Table[] = [];

  /** LoweredIndex -> RuntimeImportIndex (from lower-import initializers). */
  readonly lowerings = new Map<number, number>();
  readonly trampolineCache = new Map<number, CoreFn>();
  /**
   * ResourceIndex -> the host token bound to it (imported resource types).
   * Surfaced on the component handle for embedder introspection.
   */
  readonly hostResourceTypes = new Map<number, HostResourceType>();
  /** In-flight sync cross-component calls (see intrinsics `SyncCallScope`). */
  readonly syncCallStack: SyncCallScope[] = [];
  /** In-flight FACT `[async-start]` borrow windows (intrinsics `FactStartScope`). */
  readonly factStartScopes: FactStartScope[] = [];

  /**
   * Core functions exported by a core instance that imports at least one
   * genuinely-blocking trampoline (`trampolineNeedsSuspension`, per
   * DECLARATION — the async form of a copy/cancel built-in never blocks and
   * does not mark) or a function from an already-marked instance. FACT
   * consults this to decide whether a callee needs its own `promising`
   * entry; wrapping one that cannot block forces asynchrony the ABI forbids
   * (an eagerly-completing callee must report RETURNED, not STARTED).
   *
   * Instance granularity is still an over-approximation — a module exporting
   * both a blocking and a non-blocking function marks both — but with two
   * mitigations it no longer produces wrong answers on the official corpus:
   *
   *   * per-declaration classification keeps async-form-only importers (and
   *     the FACT `[adapter-callee]*` pass-through wrappers reached through
   *     them) out of the set entirely;
   *   * a needlessly-wrapped callee no longer changes observable state:
   *     `async-start-call` parks the caller until the callee is determinate
   *     (fact_calls.ts), reconstructing the reference's synchronous
   *     run-to-first-block across the engine's microtask hops (jspi pin (j)).
   *
   * Per-FUNCTION reachability (a call-graph pass in the translator, where
   * wasmparser already is) would still shrink the set — as a wrapping-cost
   * optimization now, not a correctness need.
   */
  readonly suspendableFuncs = new WeakSet<object>();

  /** Scratch: set by `importValue` while one module's imports are resolved. */
  private sawBlockingImport = false;
  /** LoweredIndex-es whose host functions carry the `suspending()` brand —
   * populated by `buildLoweredImport`, read by `importValue`. */
  private readonly suspendableLowerings = new Set<number>();
  /** Host trap held across a FACT exception barrier (see `HostTrapState`). */
  readonly trapState: HostTrapState = { pending: undefined };
  /** Export path -> why it has no runtime surface (see `buildExport`). */
  readonly omittedExports = new Map<string, string>();

  constructor(loaded: LoadedPlan, input: InstantiateInput) {
    this.loaded = loaded;
    this.wire = loaded.wire;
    this.componentBytes = input.componentBytes;
    this.adapterBytes = input.adapters ?? new Map();
    this.hostImports = input.imports ?? {};
    this.verifyHash = input.verifyHash ?? true;
    // AUTO-DETECTION IS ON by default. `chooseMode` picks jspi when the
    // embedder opts in OR when the plan needs suspension: a stackful async
    // lift, or a genuinely blocking built-in — classified per DECLARATION
    // (`trampolineNeedsSuspension`; the async form of a copy/cancel built-in
    // never blocks and is not evidence). An explicit `jspi: false` still
    // forces plain, and a sync-only component never detects as needing
    // suspension, so the synchronous API is untouched (pinned by
    // bridge_test "plain mode: lifted exports still return values" and the
    // planNeedsSuspension(hello) === false pin beside it).
    //
    // The detection-on failure inventory that kept this off is CLOSED — all
    // suspension sites lit, zero failures over the full corpus. What
    // protects each closed class:
    //   * STARTED-vs-RETURNED / eager-callee wrapping (big-interleaving's
    //     expect-codes, cross-abi's six): per-declaration classification +
    //     `async-start-call`'s determinacy park — pinned by
    //     tests/jspi/cross_abi_differential_test.ts (KNOWN_DIVERGENT is
    //     EMPTY and asserted empty) and fastpath_hop_test.ts (pin (j): the
    //     Suspending fast path still defers the continuation);
    //   * park/resume of a sync-lowered caller: handshake_test.ts pins;
    //   * stall-vs-trap verdicts (incl. the YIELD-spin starvation and the
    //     stale-race guard in exec/boundary.ts): deadlock_test.ts pins;
    //   * trap poisoning through rejections (`Thread.resumeWith` bracket)
    //     and start-function suspension mapping: the conformance suite's
    //     builtin-trap-poisons-instance / dont-block-start files, green
    //     under detection.
    this.suspensionMode = chooseMode(
      input.jspi,
      // Auto-detection evidence, two independent sources: the PLAN (a
      // stackful async lift or a blocking built-in — per-declaration), and
      // the IMPORTS RECORD (a `suspending()`-marked host function: the
      // embedder's declared intent to park a sync-lowered frame, which no
      // plan field can express — contracts/embedder-api.md §"Functions and async").
      planNeedsSuspension(loaded.wire) || anySuspendingImport(this.hostImports),
    );
  }

  async verifyComponent(): Promise<void> {
    const { sha256, len } = this.wire.component;
    if (this.componentBytes.length !== len) {
      throw new PlanError(
        `component byte length ${this.componentBytes.length} != plan's ${len}`,
      );
    }
    if (!this.verifyHash) return;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      // Pass an ArrayBuffer copy: subtle.digest rejects SharedArrayBuffer
      // views and non-aligned oddities.
      this.componentBytes.slice().buffer,
    );
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hex !== sha256) {
      throw new PlanError(
        `component sha256 mismatch: plan has ${sha256}, bytes are ${hex}`,
      );
    }
  }

  async compileModules(): Promise<void> {
    // Reuse compiled modules across instantiations of the same plan.
    // Fresh-instance-per-case suite runs re-instantiate one component
    // thousands of times, and recompiling costs real time per instantiation
    // even when V8's byte-keyed module dedup hits (it still re-hashes every
    // byte — ~7 ms for a 14 MB component). `WebAssembly.Module` is immutable
    // and freely instantiable many times, so reuse cannot change semantics
    // PROVIDED the compile inputs are the same objects: a hit requires the
    // plan (WeakMap key), the component bytes, and every adapter buffer to
    // be identical by reference. In-place *content* mutation of a reused
    // buffer is caught before this runs by `verifyComponent`'s sha256 check
    // whenever `verifyHash` is on (the default); a caller who disables that
    // and mutates reused buffers gets stale modules — the same caller error
    // as mutating them mid-compile today.
    const cached = moduleCache.get(this.wire);
    if (
      cached !== undefined &&
      cached.componentBytes === this.componentBytes &&
      this.wire.modules.every((m, i) =>
        m.kind === "embedded" ||
        cached.adapterRefs[i] === this.adapterBytes.get(m.file)
      )
    ) {
      this.modules.push(...await cached.modules);
      return;
    }
    const compiled = Promise.all(this.wire.modules.map((m, i) => {
      if (m.kind === "embedded") {
        // Defense-in-depth (polyengine#187): the loader now refuses
        // negative/non-integer `offset`/`len` at load time (loader.ts
        // `validateModule`), but a negative offset silently slices the
        // *wrong* bytes from the tail of `componentBytes`
        // (`Uint8Array.slice` treats negative indices as relative to the
        // end) rather than tripping the old upper-bound-only check —
        // belt-and-braces here in case a `LoadedPlan` ever reaches this
        // path without going through `loadPlan`.
        if (
          !Number.isInteger(m.offset) || m.offset < 0 ||
          !Number.isInteger(m.len) || m.len < 0
        ) {
          throw new PlanError(
            `module ${i}: offset/len must be non-negative integers, got ` +
              `offset=${m.offset}, len=${m.len}`,
          );
        }
        const end = m.offset + m.len;
        if (end > this.componentBytes.length) {
          throw new PlanError(
            `module ${i}: byte range ${m.offset}..${end} exceeds component ` +
              `size ${this.componentBytes.length}`,
          );
        }
        return WebAssembly.compile(
          this.componentBytes.slice(m.offset, end).buffer as ArrayBuffer,
        );
      }
      const bytes = this.adapterBytes.get(m.file);
      if (!bytes) {
        throw new PlanError(`adapter artifact ${m.file} not provided`);
      }
      if (bytes.length !== m.len) {
        throw new PlanError(
          `adapter ${m.file}: expected ${m.len} bytes, got ${bytes.length}`,
        );
      }
      return WebAssembly.compile(bytes.slice().buffer as ArrayBuffer);
    }));
    const entry: ModuleCacheEntry = {
      componentBytes: this.componentBytes,
      adapterRefs: this.wire.modules.map((m) =>
        m.kind === "embedded" ? undefined : this.adapterBytes.get(m.file)
      ),
      modules: compiled,
    };
    moduleCache.set(this.wire, entry);
    // A failed compile must not poison the plan's cache slot.
    void compiled.catch(() => {
      if (moduleCache.get(this.wire) === entry) moduleCache.delete(this.wire);
    });
    this.modules.push(...await compiled);
  }

  /**
   * Bind every imported resource type to the `HostResourceType` the embedder
   * supplied at the corresponding import path, before any initializer runs.
   *
   * Identity: all resource *tables* whose `resource` is this imported
   * ResourceIndex share the host token's dtor. `impl` stays null — an
   * imported resource is implemented by the host, not by any component
   * instance in this component, which is what the reference's
   * `ResourceType.impl` means (definitions.py `class ResourceType`).
   */
  bindImportedResources(): void {
    const imported = this.wire.importedResources ?? [];
    imported.forEach((ir, resourceIndex) => {
      const imp = this.wire.imports[ir.import];
      const label = importLabel(imp.name, imp.path);
      const value = this.lookupHostImport(imp.name, imp.path, label);
      if (!(value instanceof HostResourceType)) {
        throw new PlanError(
          `host import '${label}' must be a HostResourceType (the component ` +
            `imports a resource type); got ${describe(value)}`,
        );
      }
      const dtor = value.options.dtor;
      this.wire.resourceTables.forEach((table, tableIndex) => {
        if (table.kind !== "concrete" || table.resource !== resourceIndex) {
          return;
        }
        // A type-only import may have no concrete table at all; that is fine,
        // there is simply no runtime state to bind.
        const token = this.loaded.resourceTokens[tableIndex];
        token.impl = null;
        token.dtor = dtor === undefined ? null : (rep: number) => dtor(rep);
      });
      this.hostResourceTypes.set(resourceIndex, value);
    });
  }

  async runInitializers(): Promise<void> {
    for (const init of this.wire.initializers) {
      switch (init.op) {
        case "instantiate-module": {
          const module = this.modules[init.module];
          if (module === undefined) {
            throw new PlanError(`instantiate-module: no module ${init.module}`);
          }
          const declared = WebAssembly.Module.imports(module);
          if (declared.length !== init.args.length) {
            throw new PlanError(
              `module ${init.module}: ${declared.length} imports but ` +
                `${init.args.length} args in plan`,
            );
          }
          const importObject: WebAssembly.Imports = {};
          // Per-CORE-INSTANCE suspendability. `planNeedsSuspension` answers
          // the question for a whole component; FACT needs it for the specific
          // callee it is about to invoke, because that is what decides whether
          // the callee must be `promising`-wrapped (see `mkCalleeTask`).
          //
          // The trampoline declarations cannot answer it: `sync-start-call`
          // and `async-start-call` carry no `instance` field (verified against
          // real plans). What CAN answer it is right here -- the import list
          // of the module being instantiated. A core instance whose imports
          // include a blocking trampoline is one whose code can reach a
          // suspension point; every function it exports is therefore
          // potentially-blocking, and everything else is not.
          this.sawBlockingImport = false;
          // Which component instance this core module belongs to — the plan
          // states it here and nowhere else (`instance: null` = FACT adapter,
          // contracts/plan-format.md). `unsafeIntrinsic` reads it while the
          // import list below is resolved.
          this.#declaringInstance = init.instance === null
            ? null
            : this.componentInstance(init.instance);
          // ISSUE #88: core wasm permits two imports with the same
          // (module, field) pair (trusted wasmtime-environ 47.0.3 info.rs
          // :438-445 gives one flat positional CoreDef per import slot, but
          // WebAssembly.Module.imports(module) and the JS import object are
          // both keyed by (module, field) name, not by slot). If two slots
          // share a name and resolve to different values, the second object
          // write silently wins and BOTH slots receive the last value — the
          // JS API cannot express per-slot values for duplicate names. Detect
          // this here and fail loudly rather than wire the wrong function in
          // silently; identical values are safe (the API cannot distinguish
          // the slots in that case, so nothing is actually lost).
          const seenAt = new Map<string, { index: number; value: unknown }>();
          declared.forEach((imp, i) => {
            const before = this.sawBlockingImport;
            const value = this.importValue(init.args[i]);
            // Standing probe (CE_COPY_TRACE): which import made this core
            // instance suspendable — the first question to ask whenever a
            // FACT callee is promising-wrapped that should not be.
            if (!before && this.sawBlockingImport && SUSPENDABLE_TRACE) {
              console.error(
                `[suspendable] module ${init.module}: import ` +
                  `${imp.module}.${imp.name} (${JSON.stringify(init.args[i])})`,
              );
            }
            const key = `${imp.module}\0${imp.name}`;
            const prior = seenAt.get(key);
            if (prior !== undefined && prior.value !== value) {
              throw new PlanError(
                `module ${init.module}: duplicate import ` +
                  `${JSON.stringify(imp.module)}.${JSON.stringify(imp.name)} ` +
                  `at arg indices ${prior.index} and ${i} resolve to ` +
                  `different values (plan args[${prior.index}]=` +
                  `${JSON.stringify(init.args[prior.index])}, args[${i}]=` +
                  `${JSON.stringify(init.args[i])})`,
              );
            }
            seenAt.set(key, { index: i, value });
            (importObject[imp.module] ??=
              {} as WebAssembly.ModuleImports)[imp.name] =
                value as WebAssembly.ImportValue;
          });
          // Scoped strictly to the import list above: a CoreDef resolved by
          // any other initializer (extract-*, resource dtors) names no core
          // module, so it must not inherit this one's instance.
          this.#declaringInstance = null;
          let instance: WebAssembly.Instance;
          try {
            instance = await WebAssembly.instantiate(module, importObject);
          } catch (e) {
            // A SuspendError out of instantiation is a START FUNCTION trying
            // to suspend: instantiation is never a `promising` activation, so
            // ANY suspension-capable call from a start function trips jspi
            // pin (c) ("a Suspending import called outside a promising
            // activation traps unconditionally"). That is precisely the
            // condition the Component Model traps on — a start function is an
            // implicitly synchronous context that may not block — and
            // wasmtime words it as below (`test/async/dont-block-start.wast`
            // asserts the text twice). Deliberately conservative in the same
            // direction as the engine: a wait whose event is already pending
            // still suspends under jspi (pin (j)) and so still traps here,
            // where wasmtime might have completed it; the reference has no
            // model for instantiation-time built-ins at all
            // (`current_thread()` presumes a running task).
            if (
              (e as { constructor?: { name?: string } })?.constructor?.name ===
                "SuspendError"
            ) {
              throw new Trap(
                "cannot block a synchronous task before returning",
              );
            }
            throw e;
          }
          if (this.sawBlockingImport) {
            for (const exported of Object.values(instance.exports)) {
              if (typeof exported === "function") {
                this.suspendableFuncs.add(exported as unknown as object);
              }
            }
          }
          this.instances.push(instance);
          break;
        }
        case "lower-import": {
          // Associates LoweredIndex -> RuntimeImportIndex; the callable side
          // materializes when a lower-import trampoline referencing it is
          // resolved.
          this.lowerings.set(init.index, init.import);
          break;
        }
        case "extract-memory": {
          const value = this.resolveCoreExport(init.export);
          if (!(value instanceof WebAssembly.Memory)) {
            throw new PlanError(
              `extract-memory ${init.index}: resolved to non-memory`,
            );
          }
          this.memories[init.index] = value;
          break;
        }
        case "extract-realloc": {
          this.reallocs[init.index] = this.resolveFunction(
            init.def,
            `extract-realloc ${init.index}`,
          );
          break;
        }
        case "extract-callback": {
          this.callbacks[init.index] = this.resolveFunction(
            init.def,
            `extract-callback ${init.index}`,
          );
          break;
        }
        case "extract-post-return": {
          this.postReturns[init.index] = this.resolveFunction(
            init.def,
            `extract-post-return ${init.index}`,
          );
          break;
        }
        case "extract-table": {
          const value = this.resolveCoreExport(init.export);
          if (!(value instanceof WebAssembly.Table)) {
            throw new PlanError(
              `extract-table ${init.index}: resolved to non-table`,
            );
          }
          this.tables[init.index] = value;
          break;
        }
        case "resource": {
          // Wire the dtor + implementing instance into every concrete
          // resource-table token for this defined resource
          // (tolerate-if-unreferenced; plan-format.md open item).
          const dtor = init.dtor === null
            ? null
            : this.resolveFunction(init.dtor, `resource ${init.index} dtor`);
          const inst = this.componentInstance(init.instance);
          // `init.index` is a DefinedResourceIndex; resource *tables* key off
          // the component-wide ResourceIndex, which counts imported resources
          // first (the `importedResources` field, contracts/plan-format.md
          // schema; wasmtime `Component::resource_index`).
          const resourceIndex = resourceIndexOfDefined(this.loaded, init.index);
          this.wire.resourceTables.forEach((table, tableIndex) => {
            if (table.kind === "concrete" && table.resource === resourceIndex) {
              const token = this.loaded.resourceTokens[tableIndex];
              token.impl = inst;
              token.dtor = dtor === null ? null : (rep: number) => {
                dtor(rep);
              };
              // #85/#160: the host-initiated-drop entry. A host-initiated
              // drop is a full canonical LIFT of the dtor (definitions.py
              // `canon_resource_drop`, line 2319), so it is built here with
              // the same harness every lifted export uses — that is what
              // gives the dtor's activation a real Task/Thread, and what
              // releases the impl instance's entry bracket at the first park
              // instead of holding it across the whole activation (#160).
              //
              // The `promising` entry wrapping (docs §7: in jspi mode a dtor
              // may legally reach a `Suspending` import) is applied INSIDE
              // `createLiftedFunction` per `suspensionMode`, and only when
              // the dtor is suspension-capable (`suspendableFuncs`: its core
              // instance imports a blocking trampoline). A non-suspendable
              // dtor cannot legally suspend, so the plain entry is exact for
              // it and avoids `promising`'s unconditional microtask hop
              // (jspi pin (j)). The hop no longer risks a drop-then-call
              // trap either way — the bracket is released before the drive,
              // and the hop-quiescence entry gate covers the sequence — but
              // the plain path stays the cheaper and more deterministic one.
              //
              // `WebAssembly.promising` rejects non-wasm callables (a dtor
              // CoreDef can resolve to a JS trampoline) with a TypeError;
              // fall back to the plain entry, where `awaitCore` still parks
              // on a returned Promise. Deliberately does NOT set
              // `wrappedEntries`: `finish()`'s invariant inventories the two
              // primary wrapping sites; this is an auxiliary entry.
              const suspendable = dtor !== null &&
                this.suspensionMode === "jspi" &&
                this.suspendableFuncs.has(dtor as unknown as object);
              const mkEntry = (mode: SuspensionMode) =>
                createDtorEntry({
                  name: `[dtor] resource ${init.index}`,
                  dtor,
                  instance: inst,
                  suspensionMode: mode,
                  stats: this.stats,
                  trapState: this.trapState,
                  syncCallStack: this.syncCallStack,
                  allInstances: () => this.componentInstances.values(),
                });
              try {
                token.dtorHost = mkEntry(suspendable ? "jspi" : "plain");
              } catch {
                token.dtorHost = mkEntry("plain");
              }
            }
          });
          break;
        }
        default: {
          const exhaustive: never = init;
          throw new PlanError(
            `unsupported initializer op ${(exhaustive as { op: string }).op}`,
          );
        }
      }
    }
  }

  finish(): ComponentHandle {
    const exports: Record<string, unknown> = {};
    for (const exp of this.wire.exports) {
      const built = this.buildExport(exp, exp.name);
      if (built.kind === "value") exports[exp.name] = built.value;
    }
    // Structural check of jspi/bridge.ts's invariant, run once both wrapping
    // sites have had their chance: entries are wrapped while building exports
    // (just above) and imports while running `instantiate-module`. Neither
    // flag can be set by accident — only the wrapping helpers set them.
    assertModeConsistent(
      this.suspensionMode,
      this.wrappedEntries,
      this.wrappedImports,
    );
    const componentInstances: ComponentInstanceState[] = [];
    for (const [i, state] of this.componentInstances) {
      componentInstances[i] = state;
    }
    return {
      exports,
      stats: this.stats,
      componentInstances,
      coreInstances: this.instances,
      suspendableFuncs: this.suspendableFuncs,
      taskMayBlock: this.taskMayBlock,
      hostResourceTypes: this.hostResourceTypes,
      omittedExports: this.omittedExports,
      loadedPlan: this.loaded,
    };
  }

  // -- export surface -------------------------------------------------------

  /**
   * Materialize one plan export.
   *
   * The result is an explicit discriminated union rather than
   * `unknown | undefined`: an earlier `if (built !== undefined)` filter meant
   * *any* path that happened to yield `undefined` removed the export from the
   * component's surface with no diagnostic anywhere. Only `type` exports are
   * legitimately absent from the runtime surface, and they say so with a
   * reason that is recorded on the handle (`omittedExports`); everything else
   * either produces a value or throws.
   */
  buildExport(
    exp: WireExport,
    path: string,
  ): { kind: "value"; value: unknown } | { kind: "omitted"; reason: string } {
    switch (exp.kind) {
      case "lifted-func": {
        const ft = this.funcType(exp.type, `export '${path}'`);
        const core = this.resolveFunction(exp.coreDef, `export '${path}'`);
        const opts = this.resolveOptions(exp.options);
        const value = createLiftedFunction({
          name: path,
          ft,
          opts,
          core,
          stats: this.stats,
          suspensionMode: this.noteEntry(),
          trapState: this.trapState,
          syncCallStack: this.syncCallStack,
          allInstances: () => this.componentInstances.values(),
        });
        // Every SYNC-TYPED export additionally carries a plain-entered
        // variant (see SYNC_ENTRY, contracts/embedder-api.md §"Functions and async"):
        // in jspi mode the promising-wrapped entry above necessarily returns
        // a Promise, which some host contexts cannot use however promptly it
        // resolves — a JS class constructor cannot await it at all, and the
        // embedder's `sync()` adapter exists to ask for the synchronous form
        // of any sync-typed export. Async-typed exports have no synchronous
        // form by definition and get none.
        //
        // Deliberately NOT noteEntry()-recorded — this is the documented
        // exception to the bridge invariant (entries wrapped iff imports
        // wrapped), safe because a synchronously-completing activation never
        // reaches the Suspending seam. sync() extends the exception from
        // constructors to all sync entries.
        if (this.suspensionMode === "jspi" && !ft.async) {
          (value as unknown as Record<PropertyKey, unknown>)[
            SYNC_ENTRY
          ] = createLiftedFunction({
              name: `${path} (sync entry)`,
              ft,
              opts,
              core,
              stats: this.stats,
              suspensionMode: "plain",
              trapState: this.trapState,
              syncCallStack: this.syncCallStack,
              allInstances: () => this.componentInstances.values(),
              // sync() arm 2: a synchronous caller cannot be deferred by the
              // hop-quiescence gate, so it refuses (SyncEntryBusy) instead.
              // This deliberately changes constructor behaviour: the
              // constructor sync entry previously bypassed the gate
              // entirely, a latent lift-corruption window.
              refuseOnEntryHops: true,
            });
        }
        return { kind: "value", value };
      }
      case "instance": {
        const nested: Record<string, unknown> = {};
        for (const sub of exp.exports) {
          const built = this.buildExport(sub, `${path}/${sub.name}`);
          if (built.kind === "value") nested[sub.name] = built.value;
        }
        return { kind: "value", value: nested };
      }
      case "type":
        // Informational (plan-format.md): an exported *type* has no callable
        // runtime surface. Recorded, not silently dropped.
        this.omittedExports.set(
          path,
          "type export: no runtime surface (plan-format.md)",
        );
        return {
          kind: "omitted",
          reason: "type export: no runtime surface",
        };
      case "module": {
        // The `module` export kind (contracts/plan-format.md schema notes):
        // an exported embedded core module surfaces as the already-compiled
        // `WebAssembly.Module` — the same
        // compilation `instantiate-module` initializers use.
        const module = this.modules[exp.module];
        if (module === undefined) {
          throw new PlanError(
            `export '${path}': no module ${exp.module} in the static ` +
              `module space (${this.modules.length} modules)`,
          );
        }
        return { kind: "value", value: module };
      }
      default: {
        const exhaustive: never = exp;
        throw new PlanError(
          `unsupported export kind ${(exhaustive as { kind: string }).kind}`,
        );
      }
    }
  }

  // -- resolution -----------------------------------------------------------

  componentInstance(index: number): ComponentInstanceState {
    let state = this.componentInstances.get(index);
    if (state === undefined) {
      state = new ComponentInstanceState(index, this.store);
      this.componentInstances.set(index, state);
    }
    return state;
  }

  /** Memoized `LiveMemory` for a `RuntimeMemoryIndex` (see `liveMemories`). */
  liveMemory(index: number): LiveMemory {
    let m = this.liveMemories.get(index);
    if (m === undefined) {
      m = new LiveMemory(() => this.memories[index], `memory ${index}`);
      this.liveMemories.set(index, m);
    }
    return m;
  }

  unsafeIntrinsic(symbol: string): CoreFn {
    const inst = this.#declaringInstance;
    const key = `${inst === null ? "-" : inst.index}\0${symbol}`;
    let fn = this.unsafeIntrinsics.get(key);
    if (fn === undefined) {
      fn = createUnsafeIntrinsic(symbol, inst);
      this.unsafeIntrinsics.set(key, fn);
    }
    return fn;
  }

  /**
   * Resolve a core-instantiation argument.
   *
   * Identical to `resolveCoreDef` except that in jspi mode a *blocking-capable*
   * trampoline is handed to wasm as a `WebAssembly.Suspending`, so that
   * returning a Promise from it suspends the calling activation instead of
   * trapping. Only this path wraps: the same trampoline resolved anywhere the
   * host will *call* it from JS (extract-callback, post-return, realloc) must
   * stay an ordinary function.
   */
  importValue(def: WireCoreDef): Importable {
    const value = this.resolveCoreDef(def);
    // Suspendability is TRANSITIVE. FACT does not put blocking trampolines in
    // the guest's own module: it generates an adapter module that imports
    // them, and the guest imports the adapter's exported function. So a core
    // instance is suspendable if it imports a blocking trampoline OR imports a
    // function from an already-suspendable instance. Missing this closure is
    // what made `async-calls-sync`'s sync-lifted middle look non-blocking and
    // broke the handshake pins.
    if (
      typeof value === "function" &&
      this.suspendableFuncs.has(value as unknown as object)
    ) {
      this.sawBlockingImport = true;
    }
    if (
      this.suspensionMode !== "jspi" || def.kind !== "trampoline" ||
      typeof value !== "function"
    ) {
      return value;
    }
    const decl = this.wire.trampolines[def.index];
    // Per-DECLARATION blocking classification (jspi/bridge.ts): the async
    // form of a copy/cancel built-in never blocks, so importing one neither
    // needs a `Suspending` wrap nor marks the importer suspendable. The
    // kind-only version of this test pulled every async-form consumer into
    // `suspendableFuncs`, promising-wrapping FACT callees that complete
    // eagerly — the STARTED-vs-RETURNED and missed-synchronous-cancellation
    // divergences big-interleaving-test.wast asserts against.
    if (decl === undefined) return value;
    const optionsAsync = (i: number) =>
      this.wire.canonicalOptions[i]?.async === true;
    const d = decl as { kind: string; async?: unknown; options?: unknown };
    // Host lowers: `trampolineCanBlock` classifies DECLARATIONS and a
    // `lower-import` declaration says nothing about the host's intent — the
    // evidence is the `suspending()` brand on the host function, recorded by
    // `buildLoweredImport` into `suspendableLowerings` (which resolving this
    // very def just populated, one frame down). A marked lower is a genuine
    // blocker: it marks the importer (transitive suspendability →
    // promising-wrapped entries, satisfying jspi pin (c)) and gets the
    // Suspending wrap so a returned Promise parks the frame instead of
    // tripping the boundary's guard.
    if (d.kind === "lower-import") {
      const lowered = (d as unknown as { lowered: number }).lowered;
      if (!this.suspendableLowerings.has(lowered)) return value;
      this.sawBlockingImport = true;
      this.noteImport();
      return suspendingImport(
        value as (...a: never[]) => unknown,
        "jspi",
      ) as unknown as Importable;
    }
    if (!trampolineCanBlock(d, optionsAsync)) return value;
    // `async-start-call` is wrapped (its jspi-only determinacy park must be
    // able to suspend the caller) but does NOT mark the importer: see
    // `trampolineCanBlock` in jspi/bridge.ts for why marking on it is wrong.
    if (trampolineNeedsSuspension(d, optionsAsync)) {
      this.sawBlockingImport = true;
    }
    this.noteImport();
    return suspendingImport(
      value as (...a: never[]) => unknown,
      "jspi",
    ) as unknown as Importable;
  }

  resolveCoreDef(def: WireCoreDef): Importable {
    switch (def.kind) {
      case "export": {
        return this.resolveCoreExport({
          instance: def.instance,
          item: def.item,
        });
      }
      case "instance-flags":
        return this.componentInstance(def.instance).flags;
      case "trampoline":
        return this.trampoline(def.index);
      case "unsafe-intrinsic":
        // plan v1: wasmtime compile-time builtins imported directly by a core
        // module. `context.{get,set}` become host functions over the *current
        // thread's* context slots (definitions.py `Thread.storage`); every
        // other symbol fails here, at instantiate time.
        return this.unsafeIntrinsic(def.intrinsic);
      case "task-may-block":
        return this.taskMayBlock;
      default: {
        const exhaustive: never = def;
        throw new PlanError(
          `unsupported CoreDef kind ${(exhaustive as { kind: string }).kind}`,
        );
      }
    }
  }

  resolveCoreExport(ref: WireCoreExport): Importable {
    const instance = this.instances[ref.instance];
    if (instance === undefined) {
      throw new PlanError(
        `core export ref: runtime instance ${ref.instance} not created yet`,
      );
    }
    const value = instance.exports[ref.item.name];
    if (value === undefined) {
      throw new PlanError(
        `core instance ${ref.instance} has no export '${ref.item.name}'`,
      );
    }
    return value as Importable;
  }

  resolveFunction(def: WireCoreDef, what: string): CoreFn {
    const value = this.resolveCoreDef(def);
    if (typeof value !== "function") {
      throw new PlanError(`${what}: resolved to non-function`);
    }
    return value as CoreFn;
  }

  trampoline(index: number): CoreFn {
    const cached = this.trampolineCache.get(index);
    if (cached !== undefined) return cached;
    const decl = this.wire.trampolines[index];
    if (decl === undefined) {
      throw new PlanError(`no trampoline ${index} in plan`);
    }
    const fn = createTrampoline(decl, {
      componentInstance: (i) => this.componentInstance(i),
      resourceToken: (i) => {
        const token = this.loaded.resourceTokens[i];
        if (token === undefined) {
          throw new PlanError(`no resource table ${i} in plan`);
        }
        return token;
      },
      runtimeMemory: (i) =>
        new TranscodeMemory(
          () => this.memories[i],
          `runtime memory ${i}`,
        ),
      resourceTableInstance: (i) => {
        const table = this.wire.resourceTables[i];
        if (table === undefined) {
          throw new PlanError(`no resource table ${i} in plan`);
        }
        if (table.kind !== "concrete") {
          throw new PlanError(
            `resource table ${i} is abstract (type-only) and has no runtime ` +
              `handle table`,
          );
        }
        return this.componentInstance(table.instance);
      },
      options: (i) => this.resolveOptions(i),
      resultTypes: (i) => this.resultTypes(i),
      callback: (i) => {
        const fn = this.callbacks[i];
        if (fn === undefined) {
          throw new PlanError(
            `callback ${i} accessed before its extract-callback initializer ran`,
          );
        }
        return fn;
      },
      memoryToken: (i) => this.liveMemory(i),
      streamElem: (i) => {
        if (i >= this.loaded.streamElems.length) {
          throw new PlanError(
            `stream table ${i} is not in the plan's streamTables (plan v2)`,
          );
        }
        return this.loaded.streamElems[i];
      },
      streamTableInstance: (i) => {
        const instance = this.loaded.streamTableInstances[i];
        if (instance === undefined) {
          throw new PlanError(
            `stream table ${i} is not in the plan's streamTables (plan v2)`,
          );
        }
        return this.componentInstance(instance);
      },
      futureTableInstance: (i) => {
        const instance = this.loaded.futureTableInstances[i];
        if (instance === undefined) {
          throw new PlanError(
            `future table ${i} is not in the plan's futureTables (plan v2)`,
          );
        }
        return this.componentInstance(instance);
      },
      errorContextTableInstance: (i) => {
        // plan v3: the error-context tables' own index space
        // (`TypeComponentLocalErrorContextTableIndex`). Loud on absence — the
        // predecessor of this accessor borrowed the *resource*-table mapping
        // and could answer with a different instance's table (polyengine#89).
        const instance = this.loaded.errorContextTableInstances[i];
        if (instance === undefined) {
          throw new PlanError(
            `error-context table ${i} is not in the plan's ` +
              `errorContextTables (plan v3)`,
          );
        }
        return this.componentInstance(instance);
      },
      resultTypesForTuple: (i) => {
        const t = this.loaded.resultTupleTypes.get(i);
        return t === undefined ? null : this.resultTypes(t);
      },
      futureElem: (i) => {
        if (i >= this.loaded.futureElems.length) {
          throw new PlanError(
            `future table ${i} is not in the plan's futureTables (plan v2)`,
          );
        }
        return this.loaded.futureElems[i];
      },
      prepared: this.preparedCall,
      suspensionMode: this.suspensionMode,
      calleeCanBlock: (fn: unknown) => this.suspendableFuncs.has(fn as object),
      syncCallStack: this.syncCallStack,
      factStartScopes: this.factStartScopes,
      trapState: this.trapState,
      loweredImport: (d) => this.buildLoweredImport(d),
      stats: this.stats,
    });
    this.trampolineCache.set(index, fn);
    return fn;
  }

  buildLoweredImport(
    decl: Pick<
      Extract<WireTrampoline, { kind: "lower-import" }>,
      "lowered" | "options" | "type"
    >,
  ): CoreFn {
    const importIndex = this.lowerings.get(decl.lowered);
    if (importIndex === undefined) {
      throw new PlanError(
        `lower-import trampoline: lowering ${decl.lowered} was never ` +
          `initialized (initializer order violation)`,
      );
    }
    const imp = this.wire.imports[importIndex];
    if (imp === undefined) {
      throw new PlanError(`no import ${importIndex} in plan`);
    }
    const label = importLabel(imp.name, imp.path);
    const value = this.lookupHostImport(imp.name, imp.path, label);
    if (typeof value !== "function") {
      throw new PlanError(
        `host import '${label}' missing or not a function (got ` +
          `${describe(value)})`,
      );
    }
    const ft = this.funcType(decl.type, `import '${label}'`);
    const opts = this.resolveOptions(decl.options);
    const suspendable = isSuspending(value);
    // cancellation discard (contracts/embedder-api.md §"Functions and async"): does this import
    // opt out of cancel-discard? Unlike `suspendable` above, this needs no
    // executor-state detour — the brand is consumed by `createLoweredImport`
    // itself (it only decides which `onCancel` the lowered import installs, not
    // whether the CoreFn gets wrapped), so nothing downstream has to read a
    // brand off a replaced function identity.
    const deferCancel = isDeferCancel(value);
    // abortable() (same section): does this import want a per-call `AbortSignal`?
    // Read exactly like `deferCancel` above and for the same reason — the
    // brand is consumed inside `createLoweredImport`, which mints the
    // controller and appends the signal itself, so no function identity is
    // replaced downstream of the read.
    const abortable_ = isAbortable(value);
    // The Suspending-wrap decision is taken in `importValue`, which sees the
    // trampoline only AFTER `createTrampoline`'s trap-recording wrapper has
    // replaced this function's identity — a brand on the CoreFn would die
    // there (measured: the returned Promise coerced to 0 through the
    // unwrapped import). Record the decision as executor state instead,
    // keyed by LoweredIndex; `importValue` runs later on the same call
    // stack, so the set is populated by construction when it reads.
    if (suspendable) this.suspendableLowerings.add(decl.lowered);
    return createLoweredImport({
      name: label,
      ft,
      opts,
      hostFn: value as (...args: unknown[]) => unknown,
      stats: this.stats,
      mode: this.suspensionMode,
      suspendable,
      deferCancel,
      abortable: abortable_,
    });
  }

  /**
   * Resolve one plan import against the host-provided import record: index by
   * the component's exact import string, then walk `path` (instance imports —
   * `imports[].path`, contracts/plan-format.md schema).
   */
  lookupHostImport(name: string, path: string[], label: string): unknown {
    if (!(name in this.hostImports)) {
      throw new PlanError(
        `host import '${label}' not provided (no key '${name}' in imports)`,
      );
    }
    let value: unknown = this.hostImports[name];
    const walked: string[] = [];
    for (const segment of path) {
      if (value === null || typeof value !== "object") {
        throw new PlanError(
          `host import '${label}': '${
            [name, ...walked].join("/")
          }' is ${describe(value)}, expected an object to read ` +
            `'${segment}' from`,
        );
      }
      value = (value as Record<string, unknown>)[segment];
      walked.push(segment);
    }
    return value;
  }

  /**
   * Element types of an interned *results tuple* — the `results` field of a
   * `task-return` trampoline (the shim interns a lifted function's result
   * list as a single tuple type, `intern_results_tuple`).
   */
  resultTypes(index: number): ValType[] {
    const entry: LoadedType | undefined = this.loaded.types[index];
    if (entry === undefined) {
      throw new PlanError(`task-return results: no type ${index}`);
    }
    if (entry.kind !== "value" || entry.type.kind !== "tuple") {
      throw new PlanError(
        `task-return results: type ${index} is not a tuple type`,
      );
    }
    return entry.type.elements;
  }

  funcType(index: number, what: string): FuncType {
    const entry: LoadedType | undefined = this.loaded.types[index];
    if (entry === undefined) throw new PlanError(`${what}: no type ${index}`);
    if (entry.kind !== "func") {
      throw new PlanError(`${what}: type ${index} is not a function type`);
    }
    return entry.funcType;
  }

  resolveOptions(index: number): ResolvedOptions {
    const wire: WireCanonicalOptions | undefined =
      this.wire.canonicalOptions[index];
    if (wire === undefined) {
      throw new PlanError(`no canonicalOptions ${index} in plan`);
    }
    const memoryIndex = wire.memory;
    return {
      stringEncoding: wire.stringEncoding,
      memory: memoryIndex === null ? null : this.liveMemory(memoryIndex),
      realloc: wire.realloc === null
        ? null
        : () => this.reallocs[wire.realloc!],
      postReturn: wire.postReturn === null
        ? null
        : () => this.postReturns[wire.postReturn!],
      callback: wire.callback === null
        ? null
        : () => this.callbacks[wire.callback!],
      async: wire.async,
      cancellable: wire.cancellable,
      coreType: wire.coreType,
      instance: this.componentInstance(wire.instance),
    };
  }
}

/** `name` plus instance path, for diagnostics: `"ns:pkg/iface"."f"`. */
function importLabel(name: string, path: string[]): string {
  return path.length === 0 ? name : `${name}/${path.join("/")}`;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "object") return `a ${v.constructor?.name ?? "object"}`;
  return `a ${typeof v}`;
}
