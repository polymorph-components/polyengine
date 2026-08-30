// The conventions facade: `instantiate(artifacts, imports, opts)`.
//
// DESIGN (orchestrator ruling, C2): the facade is **runtime-driven**. Every
// camelCase name, every resource class and every import wrapper is built here,
// at instantiate time, from the loaded plan's type tables — the plan already
// carries names, kinds and function types. Bindgen emits compile-time *types*
// that cast this facade; no generated code participates, so everything works
// fully untyped.
//
// Governing contract: contracts/embedder-api.md (all sections). Secondary:
// contracts/plan-format.md for the wire shapes read here.

import type { WireExport, WirePlan } from "../plan/format.ts";
import type { LoadedPlan } from "../plan/loader.ts";
import { loadEnvelope, loadPlan, PlanError } from "../plan/loader.ts";
import type { FuncType, ResourceTypeInfo, ValType } from "../cabi/types.ts";
import type { ComponentValue } from "../cabi/types.ts";
import { Trap } from "../cabi/trap.ts";
import {
  type ComponentHandle,
  SYNC_ENTRY,
  type HostImports,
  hostResourceType,
  instantiateComponent,
} from "../exec/mod.ts";
import { camelCase, parseLeafName, pascalCase } from "./casing.ts";
import {
  abortable,
  deferCancel,
  isAbortable,
  isDeferCancel,
  isSuspending,
  suspending,
} from "../jspi/suspending.ts";
import { Translator } from "../shim/mod.ts";
import { copyCensus, isTrap, isComponentException } from "@polyengine/protocol";
import { NameCollisionError, ComponentException } from "./errors.ts";
import { type ImportLeaf, requiredImports } from "./imports.ts";
import { hostDtorCall } from "../exec/boundary.ts";
import {
  buildGuestResourceClass,
  type ExportWrapper,
  type GuestResourceSpec,
  HostResourceRegistry,
  invalidateWrapper,
  lendWrapper,
  makeWrapper,
  takeRep,
} from "./resources.ts";
import {
  type AdapterOptions,
  BorrowScope,
  describe,
  fromHost,
  toHost,
  type ValueBridge,
} from "./values.ts";
import { ImportResolver } from "./version.ts";
import { type ElemCodec, Future, Stream } from "./streams.ts";
import { markSyncCallable, syncPayloadOf } from "./sync.ts";

/**
 * Relay the per-declaration host-import marks from the embedder's function
 * onto the wrapper the executor will actually receive, and return the
 * wrapper.
 *
 * Every `#dispatcher` arm re-wraps the embedder's function in a closure, so a
 * brand left on the original is INVISIBLE to `buildLoweredImport` — for A1
 * that surfaced as a `NeedsJspi`, for A23 (`deferCancel()`) it would be a
 * silently discarded commit, which is precisely the failure the brand exists
 * to prevent. Both marks are relayed by the same helper so a third one cannot
 * be added to one arm and forgotten in the other three.
 */
function relayMarks<F extends CallableFunction>(from: unknown, to: F): F {
  if (isSuspending(from)) suspending(to);
  if (isDeferCancel(from)) deferCancel(to);
  if (isAbortable(from)) abortable(to);
  return to;
}

/** Per-element codec for a `future<T>` returned in function-result position. */
function elementCodec(
  element: ValType | null,
  o: AdapterOptions,
): ElemCodec<unknown> {
  return {
    element,
    where: o.where,
    toHost: (v) => element === null ? undefined : toHost(v, element, o),
    fromHost: (v) => element === null ? null : fromHost(v, element, o),
  };
}

/** The shim's output plus the component bytes it describes. */
export interface ComponentArtifacts {
  plan: WirePlan;
  componentBytes: Uint8Array;
  adapters?: Map<string, Uint8Array>;
}

/**
 * Untranslated alternative to `ComponentArtifacts` (embedder-api.md
 * amendment A3): hand `instantiate` the raw component plus the translator
 * and it runs the translation internally — the pipeline collapses to
 * bytes-in, instance-out.
 *
 * `translator` accepts the translator-shim wasm bytes (simplest; compiles
 * the shim per call) or an already-created `Translator` (preferred when
 * instantiating more than one component, or the same component more than
 * once — create it once and reuse; translation itself is sub-millisecond
 * warm, the wasm compile is the cost being shared). `requiredImports`
 * still needs a plan: translate explicitly when you want to inspect the
 * import surface before instantiating.
 */
export interface UntranslatedArtifacts {
  componentBytes: Uint8Array;
  translator: Uint8Array | Translator;
}

/** Either artifacts shape accepted by `instantiate`. */
export type InstantiateSource = ComponentArtifacts | UntranslatedArtifacts;

/**
 * Reconstitute `ComponentArtifacts` from a translation ENVELOPE — the
 * single-file JSON emitted by build-time translation (`tools/translate`,
 * or `Translator.translateRaw`), carrying the plan and the FACT adapter
 * modules. The production deploy set is `component.wasm` + its envelope +
 * the runtime: no translator ships (embedder-api.md amendment A4).
 *
 * Pure and fetch-agnostic: acquire the two blobs however the platform
 * likes (HTTP, fs, bundler asset) and hand them over. The envelope embeds
 * the component's sha-256, which `instantiate` verifies — a mismatched
 * pair fails loudly at instantiation, never subtly at runtime.
 */
export function artifactsFromEnvelope(
  envelopeJson: string,
  componentBytes: Uint8Array,
): ComponentArtifacts {
  const { wire, adapters } = loadEnvelope(envelopeJson);
  return { plan: wire, componentBytes, adapters };
}

/**
 * Normalize either accepted input form to `ComponentArtifacts` — i.e. make
 * the PLAN available without instantiating anything. Exported because the
 * world-digest handshake (contracts/digest.md) must complete before any
 * guest code runs: generated `instantiate` wrappers call this, verify the
 * plan, and only then delegate to `instantiate` below.
 * @internal — bindgen-generated code only — the digest handshake needs the
 * plan before instantiating (amendment A17).
 */
export async function resolveArtifacts(
  src: InstantiateSource,
): Promise<ComponentArtifacts> {
  if ("plan" in src) return src;
  const translator = src.translator instanceof Translator
    ? src.translator
    : await Translator.create(src.translator);
  const { plan, adapters } = translator.translate(src.componentBytes);
  return { plan, componentBytes: src.componentBytes, adapters };
}

export interface EmbedderOptions {
  /** Opt in to JSPI-backed suspension (see `InstantiateInput.jspi`). */
  jspi?: boolean;
  /** Verify `plan.component.sha256` against the bytes (default true). */
  verifyHash?: boolean;
}

/** An instantiated component, conventions-shaped. */
export interface EmbedderInstance {
  /**
   * Nested record keyed by verbatim WIT interface id; world-level exports at
   * the top level under camelCase names.
   */
  // deno-lint-ignore no-explicit-any
  exports: Record<string, any>;
  /** The raw runtime handle. Internal surface, no stability promise. */
  handle: ComponentHandle;
  /** The leaves this component required (the same list `requiredImports` gives). */
  imports: ImportLeaf[];
}

type RawFn = (...a: unknown[]) => unknown;

/** How a resource type is implemented, keyed by `ResourceIndex`. */
type Binding =
  | { kind: "guest"; name: string; cls?: unknown }
  | {
    kind: "host";
    name: string;
    registry: HostResourceRegistry;
    cls: unknown;
  };

/**
 * Instantiate a component behind the embedder conventions.
 *
 * `imports` is the canonical nested record of
 * contracts/embedder-api.md §"Module wiring and instantiation": keys are
 * verbatim WIT interface ids (version included) or world-level camelCase
 * names; interface-id keys additionally participate in compatibility-track
 * resolution (see `version.ts`).
 */
export async function instantiate(
  source: InstantiateSource,
  imports: Record<string, unknown> = {},
  opts: EmbedderOptions = {},
): Promise<EmbedderInstance> {
  const artifacts = await resolveArtifacts(source);
  const facade = new Facade(artifacts, imports);
  const handle = await instantiateComponent({
    plan: artifacts.plan,
    componentBytes: artifacts.componentBytes,
    adapters: artifacts.adapters,
    imports: facade.rawImports,
    jspi: opts.jspi,
    verifyHash: opts.verifyHash,
    // THE ordering fix: the facade converted this plan in its constructor and
    // wired its import wrappers against those very `ResourceTypeInfo` tokens.
    // Host imports fire DURING instantiation (a core module's `start`
    // function runs inside `runInitializers`), so the facade cannot wait for
    // the handle to learn its own types.
    loadedPlan: facade.loaded,
  });
  facade.bind(handle);
  const instance: EmbedderInstance = {
    exports: facade.buildExports(handle),
    handle,
    imports: facade.leaves,
  };
  Object.defineProperty(instance, INTERNAL_HOST_REGISTRIES, {
    value: facade.hostRegistries,
    enumerable: false,
  });
  return instance;
}

/**
 * Alias matching the C2 dispatch's spelling.
 * @internal — alias kept for bindgen-generated code only; hosts call
 * `instantiate`.
 */
export const instantiateEmbedder = instantiate;

/**
 * Symbol-keyed, deliberately NOT re-exported from `mod.ts`: the
 * host-resource registries of an instance, by `ResourceIndex`. Diagnostics and
 * white-box tests only — it is not part of the embedder API surface and no
 * generated code may depend on it.
 */
export const INTERNAL_HOST_REGISTRIES = Symbol(
  "polyengine.embedder.hostRegistries",
);

class Facade {
  readonly leaves: ImportLeaf[];
  readonly rawImports: HostImports = {};
  readonly #resolver: ImportResolver;
  readonly #bindings = new Map<number, Binding>();
  /** ResourceTypeInfo identity -> ResourceIndex (one index, many tokens). */
  readonly #tokenIndex = new Map<ResourceTypeInfo, number>();
  /**
   * The converted plan — owned by the facade and handed to the executor, so
   * both sides share one set of per-instantiation resource identity tokens.
   * Available from construction, which is what makes import wrappers usable
   * for the whole of instantiation.
   */
  readonly loaded: LoadedPlan;
  readonly #bridge: ValueBridge;
  /**
   * Releases for reps minted while lowering the CURRENT call's arguments.
   * Argument lowering is synchronous and uninterrupted (no `await` between
   * `#lowerScope = […]` and the reset), so a single slot is race-free even
   * with concurrent export calls in flight.
   */
  #lowerScope: (() => void)[] | null = null;
  /** ResourceIndex -> registry, for diagnostics (see INTERNAL_HOST_REGISTRIES). */
  readonly hostRegistries = new Map<number, HostResourceRegistry>();
  /** True once `buildExports` has run: guest resource classes then exist. */
  #exportsBuilt = false;

  constructor(
    readonly artifacts: ComponentArtifacts,
    providers: Record<string, unknown>,
  ) {
    this.#resolver = new ImportResolver(providers);
    this.loaded = loadPlan(artifacts.plan);
    // `ResourceTypeInfo` identity -> `ResourceIndex`. Both halves are static
    // (the tokens are ours; `resourceTables` is wire data), so this map is
    // complete before instantiation starts — a host import that fires from a
    // guest `start` function can resolve resource types normally.
    //
    // One resource TYPE can be reached through several resource TABLES
    // (plan-format.md C2 amendment #1: a type export's index is a table
    // index, and the executor sets impl/dtor on every table whose `resource`
    // matches), hence index-keyed bindings with tokens as aliases.
    artifacts.plan.resourceTables.forEach((table, i) => {
      if (table.kind !== "concrete") return;
      const token = this.loaded.resourceTokens[i];
      if (token !== undefined) this.#tokenIndex.set(token, table.resource);
    });
    this.leaves = requiredImports(this.loaded);
    // A component that imports a resource TYPE cannot be wired without
    // `plan.importedResources`: that table is the only thing mapping the
    // import back to a `ResourceIndex` (plan-format.md v0.1 amendment #2 /
    // v0.2). Without it every own/borrow of that type would fail late, deep
    // inside a call, as an unattributable `InvalidHandleError`.
    const resourceLeaves = this.leaves.filter((l) => l.kind === "resource");
    if (
      resourceLeaves.length > 0 &&
      (artifacts.plan.importedResources ?? []).length === 0
    ) {
      throw new PlanError(
        `this component imports the resource type(s) ` +
          `${resourceLeaves.map((l) => `'${l.leaf}'`).join(", ")}, but the ` +
          `plan carries no \`importedResources\` table, so they cannot be ` +
          `bound to a ResourceIndex (contracts/plan-format.md v0.2). ` +
          `Re-translate with a shim that emits it.`,
      );
    }
    this.#bridge = this.#makeBridge();
    this.#buildRawImports();
    this.#bindHostResources();
  }

  // -- resource-type identity ------------------------------------------------

  /**
   * Consistency check after instantiation.
   *
   * The facade no longer *learns* anything here — it handed its own
   * `LoadedPlan` to the executor precisely so that nothing about types or
   * resource identity depends on instantiation having finished. All this does
   * is assert the executor did not silently re-load (which would give it a
   * second, disjoint set of `ResourceTypeInfo` tokens and make every
   * `own`/`borrow` unresolvable).
   */
  bind(handle: ComponentHandle): void {
    if (handle.loadedPlan !== this.loaded) {
      throw new PlanError(
        "the executor instantiated from a different LoadedPlan than the " +
          "facade built its import wrappers from; resource identity tokens " +
          "would not match",
      );
    }
  }

  #indexOf(rt: ResourceTypeInfo): number {
    const i = this.#tokenIndex.get(rt);
    if (i === undefined) {
      throw new PlanError(
        "resource type is not bound to any resource table in this plan",
      );
    }
    return i;
  }

  #binding(rt: ResourceTypeInfo): Binding {
    const index = this.#indexOf(rt);
    let b = this.#bindings.get(index);
    if (b === undefined) {
      // A GUEST-implemented resource. Unlike host-implemented ones (bound at
      // construction from static plan data), a guest resource's class is
      // assembled from the component's own lifted `[constructor]`/`[method]`
      // exports, which do not exist until instantiation has finished. If a
      // guest `start` function hands one to a host import, say so precisely
      // rather than surfacing a half-built wrapper.
      if (!this.#exportsBuilt) {
        throw new PlanError(
          `a guest-implemented resource (ResourceIndex ${index}) crossed the ` +
            `boundary before instantiation finished — a guest \`start\` ` +
            `function passed an own/borrow handle to a host import. Its class ` +
            `is assembled from the component's own lifted exports, which do ` +
            `not exist yet. Host-implemented resources are unaffected. If a ` +
            `real component needs this, the class must be built lazily from ` +
            `the plan's export table instead of the runtime's export surface.`,
        );
      }
      // Post-instantiation: a guest resource with no exported type and no
      // exported leaves. Still a valid handle, just anonymous.
      b = { kind: "guest", name: `resource-${index}` };
      this.#bindings.set(index, b);
    }
    return b;
  }

  // deno-lint-ignore no-explicit-any
  #guestClass(b: Binding & { kind: "guest" }): any {
    b.cls ??= buildGuestResourceClass(
      { name: b.name, ctor: null, ctorParams: null, methods: [], statics: [] },
      // The rt is supplied per wrapper, so an anonymous class needs none here.
      { impl: null, dtor: null } as unknown as ResourceTypeInfo,
      () => () => Promise.reject(new TypeError("no methods")),
      () => [],
    );
    return b.cls;
  }

  /**
   * Bind host-implemented resource types to their `ResourceIndex`.
   *
   * Everything this needs is static wire data (`plan.importedResources`, whose
   * entries are back-references into `plan.imports`), so it runs at
   * construction — before instantiation, and therefore before a guest `start`
   * function can call an import that carries an `own`/`borrow` of one.
   * Imported resources occupy `ResourceIndex` 0..n-1 in `importedResources`
   * order (plan-format.md v0.1 amendment #2 / v0.2).
   */
  #bindHostResources(): void {
    const importedResources = this.artifacts.plan.importedResources ?? [];
    for (const p of this.#pendingHostResources) {
      const at = importedResources.findIndex((ir) =>
        ir.import === p.importIndex
      );
      if (at < 0) continue;
      this.#bindings.set(at, {
        kind: "host",
        name: this.leaves[p.importIndex].leaf,
        registry: p.registry,
        cls: p.cls,
      });
      this.hostRegistries.set(at, p.registry);
    }
  }

  // -- the value bridge ------------------------------------------------------

  #makeBridge(): ValueBridge {
    const self = this;
    return {
      liftOwn(rep, t) {
        const b = self.#binding(t.rt);
        // Host-implemented R: "the host's own instance back; the guest's
        // handle is gone; no dispose call" (contract 2x4 table).
        if (b.kind === "host") return b.registry.release(rep);
        return makeWrapper(self.#guestClass(b), rep, t.rt, true);
      },
      liftBorrow(rep, t, scope) {
        const b = self.#binding(t.rt);
        // Host-implemented R: "the host's own instance; borrow scoping is
        // guest-side bookkeeping" — the mapping is kept.
        if (b.kind === "host") return b.registry.lookup(rep);
        const w = makeWrapper(self.#guestClass(b), rep, t.rt, false);
        scope.add(() => invalidateWrapper(w));
        return w;
      },
      lowerOwn(v, t) {
        const b = self.#binding(t.rt);
        if (b.kind === "host") return b.registry.repFor(v);
        return takeRep(v, true, `own<${b.name}>`);
      },
      lowerBorrow(v, t) {
        const b = self.#binding(t.rt);
        if (b.kind === "host") {
          // Contract 2x4 table, bottom-right: "a never-registered instance
          // gets a rep allocated **for the call's duration**". A rep minted
          // here is call-scoped, so it is released when the call returns —
          // otherwise it would sit in the registry's STRONG rep->instance map
          // forever, since a guest dropping a borrow handle runs no dtor.
          const known = b.registry.hasInstance(v);
          const rep = b.registry.repFor(v);
          if (!known) {
            self.#lowerScope?.push(() => b.registry.releaseIfPresent(rep));
          }
          return rep;
        }
        // Host `own` wrapper lowered as `borrow<R>` (#86): record the lend
        // for the duration of this call, so a `drop()` or a GC finalization
        // in the window cannot destroy a rep the guest still borrows.
        // definitions.py `lift_borrow` -> `Subtask.add_lender` (line 890);
        // `#lowerScope` is released where that subtask delivers its
        // resolution, i.e. when the call ends.
        const rep = takeRep(v, false, `borrow<${b.name}>`);
        const release = lendWrapper(v as object);
        if (self.#lowerScope === null) {
          // No enclosing lowering scope (a raw/one-off lowering): the lend
          // has no observable window, so it must not be left dangling.
          release();
        } else {
          self.#lowerScope.push(release);
        }
        return rep;
      },
      dropOwn(rep, t) {
        // A13: a lowered `own` the guest will never take (an un-taken
        // stream element). Destroy it exactly as a guest-side drop would:
        // host-implemented R runs the instance's [Symbol.dispose] through
        // the registry; guest-implemented R runs the guest dtor via the
        // gated path (a host-initiated drop, `caller = None`).
        const b = self.#binding(t.rt);
        if (b.kind === "host") {
          b.registry.dtor(rep);
          return;
        }
        hostDtorCall(t.rt, rep);
      },
    };
  }

  #opts(where: string): AdapterOptions {
    return { bridge: this.#bridge, where };
  }

  #funcType(index: number | undefined, what: string): FuncType {
    const loaded = this.loaded;
    if (index === undefined) throw new PlanError(`${what}: no type index`);
    const t = loaded.types[index];
    if (t === undefined || t.kind !== "func") {
      throw new PlanError(`${what}: type ${index} is not a function type`);
    }
    return t.funcType;
  }

  // -- imports ---------------------------------------------------------------

  #buildRawImports(): void {
    // Group by the record key so an instance import lands as one nested object.
    this.leaves.forEach((leaf, importIndex) => {
      const provider = this.#provider(leaf);
      const target = leaf.path.length === 0
        ? null
        : nest(this.rawImports, leaf.interfaceId, leaf.path.slice(0, -1));
      const value = this.#wrapLeaf(leaf, importIndex, provider);
      if (target === null) this.rawImports[leaf.interfaceId] = value;
      else target[leaf.path[leaf.path.length - 1]] = value;
    });
  }

  /** Resolve the container object a leaf's implementation is read from. */
  #provider(leaf: ImportLeaf): unknown {
    // A world-level MEMBER leaf (`[method]ticket.value` with no containing
    // interface) dispatches on the resource's class, which is registered
    // under the resource's own name — the mangled leaf name is never a
    // record key. Interface-level members find their class inside the
    // interface record via the normal path walk below.
    if (leaf.path.length === 0 && leaf.member.form !== "plain") {
      const r = leaf.member.resource;
      const hit = this.#resolver.resolve(r) ??
        this.#resolver.resolve(camelCase(r));
      if (hit === undefined) {
        throw new PlanError(
          `host import '${label(leaf)}' not provided: the component ` +
            `imports the world-level resource '${r}'; provide its class ` +
            `under the key '${camelCase(r)}' (registered: ` +
            `${this.#resolver.keys().join(", ") || "<none>"})`,
        );
      }
      return hit.value;
    }
    const hit = this.#resolver.resolve(leaf.interfaceId) ??
      (leaf.path.length === 0
        ? this.#resolver.resolve(camelCase(leaf.interfaceId))
        : undefined);
    if (hit === undefined) {
      throw new PlanError(
        `host import '${label(leaf)}' not provided (no key ` +
          `'${leaf.interfaceId}' in imports; registered: ` +
          `${this.#resolver.keys().join(", ") || "<none>"})`,
      );
    }
    let value = hit.value;
    // Walk everything but the final segment; the leaf itself is read by
    // `#wrapLeaf`, which knows how to decode a mangled name.
    for (const seg of leaf.path.slice(0, -1)) {
      if (value === null || typeof value !== "object") {
        throw new PlanError(
          `host import '${label(leaf)}': '${seg}' is not reachable ` +
            `(${describe(value)})`,
        );
      }
      value = (value as Record<string, unknown>)[seg];
    }
    return value;
  }

  #wrapLeaf(
    leaf: ImportLeaf,
    importIndex: number,
    provider: unknown,
  ): unknown {
    if (leaf.kind === "resource") {
      return this.#wrapResourceType(leaf, importIndex, provider);
    }
    if (leaf.kind !== "func") {
      // `instance` leaves never appear as plan imports in their own right
      // (the plan flattens them into paths); anything else is out of scope.
      throw new PlanError(
        `host import '${label(leaf)}': unsupported import kind '${leaf.kind}'`,
      );
    }
    const dispatch = this.#dispatcher(leaf, provider);
    // The function type is resolved LAZILY, on first call. It must come from
    // the *executor's* loaded plan: the `own`/`borrow` types in it carry the
    // per-instantiation `ResourceTypeInfo` identity tokens the bridge keys on,
    // and those objects do not exist until `instantiateComponent` has run —
    // which is after this wrapper has to be handed to it.
    let impl: RawFn | null = null;
    const wrapper = (...raw: unknown[]) => {
      if (impl === null) {
        const ft = this.#funcType(
          this.artifacts.plan.imports[importIndex].type,
          `import '${label(leaf)}'`,
        );
        impl = this.#wrapImportFn(leaf, ft, dispatch);
      }
      return impl(...raw);
    };
    // A1/A23 brand relay, layer 2 of 2 (see #dispatcher): the executor reads
    // the brands off this wrapper, which is what lands in its hostImports
    // record.
    return relayMarks(dispatch, wrapper);
  }

  /** A host-implemented resource type: register the class, own the mapping. */
  #wrapResourceType(
    leaf: ImportLeaf,
    importIndex: number,
    provider: unknown,
  ): unknown {
    // `#provider` already walked every path segment but the last, so a
    // path-bearing resource import reads its class off `provider`; a
    // world-level one IS `provider`.
    const cls = leaf.path.length === 0
      ? provider
      : pick(provider, [], [pascalCase(leaf.leaf), leaf.leaf]);
    if (cls === undefined) {
      throw new PlanError(
        `host import '${label(leaf)}': the component imports the resource ` +
          `type '${leaf.leaf}'; provide the implementing class as ` +
          `'${pascalCase(leaf.leaf)}'`,
      );
    }
    const registry = new HostResourceRegistry(pascalCase(leaf.leaf));
    this.#pendingHostResources.push({ importIndex, registry, cls });
    return hostResourceType({
      name: leaf.leaf,
      // The guest dropped its last own handle: run the destructor, which for
      // a host-implemented resource is `instance[Symbol.dispose]?.()`.
      dtor: (rep) => registry.dtor(rep),
    });
  }

  readonly #pendingHostResources: {
    importIndex: number;
    registry: HostResourceRegistry;
    cls: unknown;
  }[] = [];

  /** The JS call a lifted import leaf dispatches to. */
  #dispatcher(
    leaf: ImportLeaf,
    provider: unknown,
  ): (args: unknown[]) => unknown {
    const m = leaf.member;
    if (m.form === "plain") {
      const fn = leaf.path.length === 0
        ? provider
        : pick(provider, [], [camelCase(m.name), m.name]);
      if (typeof fn !== "function") {
        throw new PlanError(
          `host import '${label(leaf)}' missing or not a function (got ` +
            `${describe(fn)}); expected '${camelCase(m.name)}'`,
        );
      }
      // A1/A23: the `suspending()` and `deferCancel()` brands ride the
      // dispatch closure so #wrapLeaf can relay them onto the value the
      // executor actually receives.
      //
      // A2 receiver rule: an interface member is invoked with its containing
      // object as receiver (matching the static arm's `apply(cls)`), so a
      // class INSTANCE is a fully supported spelling of an interface
      // provider — methods reading instance state work. A world-level bare
      // import has no containing object and stays unbound. (Previously the
      // plain arm called extracted functions unbound: a class-instance
      // provider type-checked, worked while stateless, and broke with
      // `this === undefined` the moment a method touched state — the silent
      // liberal-acceptance failure the contract forbids.)
      const receiver = leaf.path.length === 0 ? undefined : provider;
      const dispatch: (args: unknown[]) => unknown = (args) =>
        (fn as RawFn).apply(receiver, args);
      return relayMarks(fn, dispatch);
    }
    const clsName = pascalCase(m.resource);
    // World-level member leaves resolved the class itself (`#provider`);
    // interface members read it out of the interface record.
    const cls = leaf.path.length === 0
      ? provider
      : pick(provider, [], [clsName, m.resource]);
    if (cls === undefined) {
      throw new PlanError(
        `host import '${label(leaf)}': no class '${clsName}' provided`,
      );
    }
    switch (m.form) {
      case "constructor":
        // Never markable: guest-driven construction of a host resource is
        // synchronous by the C2 amendment, and stage-3 reserves no
        // constructor-decorator position.
        // deno-lint-ignore no-explicit-any
        return (args) => new (cls as any)(...args);
      case "method": {
        // A2: the brand authority for an instance method is the CLASS
        // PROTOTYPE, read at wrap time — the Suspending-wrap decision is
        // per-declaration and taken at instantiation, before any instance
        // exists. Instance-level method overrides do not change
        // suspendability (marking follows the WIT declaration, not the
        // object); the per-call lookup below still dispatches to the
        // override's BODY as before.
        //
        // The probe must not INVOKE accessors: a platform getter (e.g.
        // `URLSearchParams.prototype.size`) brand-checks its receiver, and a
        // raw `prototype[member]` read runs it with `this` = the prototype —
        // an engine TypeError at instantiation, even for guests that never
        // call the member. Only a data-property function can carry the A2
        // mark (stage-3 method decorators install data properties), so an
        // accessor-backed member yields no wrap-time function here and stays
        // a call-time concern for the per-call lookup below.
        const protoFn = dataMember(
          (cls as { prototype?: unknown })?.prototype,
          camelCase(m.member),
        );
        const dispatch: (args: unknown[]) => unknown = (args) => {
          const [self, ...rest] = args;
          const fn = (self as Record<string, unknown>)?.[camelCase(m.member)];
          if (typeof fn !== "function") {
            throw new Trap(
              `host import '${label(leaf)}': the ${clsName} instance has no ` +
                `method '${camelCase(m.member)}'`,
            );
          }
          return (fn as RawFn).apply(self, rest);
        };
        return relayMarks(protoFn, dispatch);
      }
      case "static": {
        const fn = (cls as Record<string, unknown>)[camelCase(m.member)];
        if (typeof fn !== "function") {
          throw new PlanError(
            `host import '${label(leaf)}': ${clsName} has no static ` +
              `'${camelCase(m.member)}'`,
          );
        }
        // A2: a static's brand sits on the function itself (a stage-3
        // static-method decorator marks the function value), readable here
        // at wrap time.
        const dispatch: (args: unknown[]) => unknown = (args) =>
          (fn as RawFn).apply(cls, args);
        return relayMarks(fn, dispatch);
      }
    }
  }

  /**
   * The raw (definitions.py-shaped) function the executor lowers, wrapping a
   * conventions-shaped host implementation.
   *
   * Error model (contract §"Error model"), the inversion of jco's convention:
   *   * a returned value is the ok side;
   *   * `throw new ComponentException(payload)` is the err side of a `result<T, E>`;
   *   * a `Trap` passes through unchanged;
   *   * **any other throw is a host bug and becomes a trap naming the import**
   *     — never a guest-visible err. This is what makes the consumers'
   *     defensive `platformCall`-style wrappers unnecessary by construction.
   */
  #wrapImportFn(
    leaf: ImportLeaf,
    ft: FuncType,
    dispatch: (args: unknown[]) => unknown,
  ): RawFn {
    const where = `import '${label(leaf)}'`;
    const o = this.#opts(where);
    const resultType = ft.results.length === 0 ? null : ft.results[0];
    const isResult = resultType !== null && resultType.kind === "result";

    const ok = (v: unknown): ComponentValue | undefined => {
      if (resultType === null) return undefined;
      if (isResult) {
        const rt = resultType as ValType & { kind: "result" };
        return { ok: rt.ok === null ? null : fromHost(v, rt.ok, o) };
      }
      return fromHost(v, resultType, o);
    };
    const fail = (e: unknown, args: unknown[]): ComponentValue => {
      // Brand, not class (amendment A9): a `ComponentException` thrown by a host module
      // that resolved a DIFFERENT runtime copy — or hand-rolled with the
      // registry symbol — is the same value here (issue #83).
      if (isComponentException(e) && isResult) {
        const rt = resultType as ValType & { kind: "result" };
        return {
          error: rt.error === null ? null : fromHost(e.payload, rt.error, o),
        };
      }
      // Every remaining branch traps the component. The import's lifted
      // stream/future arguments were transferred to the host when the params
      // were converted (the guest's ends are gone), and a trapping import is
      // a declared host bug — nothing owns them anymore, so drop them here:
      // a peer parked on one (a host writer feeding the stream this import
      // just received, the #66 E2 shape) settles with the truthful "reader
      // went away" instead of hanging forever. The err-VALUE branch above
      // deliberately does NOT do this: a fallible import returning err is a
      // normal outcome whose implementation may retain the handles.
      releaseAsyncArgs(args);
      if (isTrap(e)) throw e;
      if (isComponentException(e)) {
        throw new Trap(
          `${where} threw a ComponentException, but its WIT type has no err side; ` +
            `only a fallible import may signal an error value`,
        );
      }
      // The #83 signature: in a graph with several copies, an UNBRANDED throw
      // is usually a pre-A9 copy's `ComponentException` (its brand rode class identity,
      // which does not survive the copy boundary). Say so rather than leaving
      // the latent puzzle that motivated amendment A9.
      const census = copyCensus();
      throw new Trap(
        `${where} threw ${describeThrow(e)}. An unbranded throw from a host ` +
          `import is a host bug and becomes a trap: signal a WIT error with ` +
          `\`throw new ComponentException(payload)\`.` +
          (census === ""
            ? ""
            : ` (${census} — an error carrying no polyengine brand in a ` +
              `multi-copy graph usually means a pre-A9 runtime copy threw ` +
              `it, issue #83.)`),
      );
    };

    return (...raw: unknown[]) => {
      const scope = new BorrowScope();
      const args = ft.params.map((p, i) =>
        toHost(raw[i] as ComponentValue, p, o, scope)
      );
      // CONTRACT (A24): anything the executor appended PAST the WIT-declared
      // params is a runtime-minted extra, not a component value — today
      // exactly the `abortable()` signal `createLoweredImport` adds for a
      // marked import. It is forwarded verbatim (no `toHost` conversion: it
      // has no `ValType` and must reach the host as the platform object it
      // is). Without this the facade would silently drop the signal and a
      // marked import's `signal` parameter would be forever `undefined` —
      // the failure the mark exists to prevent. The slice is empty for every
      // unmarked import, so no existing path changes shape.
      for (let i = ft.params.length; i < raw.length; i++) args.push(raw[i]);
      let out: unknown;
      try {
        out = dispatch(args);
      } catch (e) {
        scope.end();
        return fail(e, args);
      }
      if (isThenable(out)) {
        // Amendment A12: when the WIT result type is `future<T>`, a thenable
        // return IS the future source ("for `future<T>`, a `Promise<T>` or
        // `Future<T>`" — §"Streams and futures"), not the call's async
        // completion. The import completes immediately with the lowered
        // future; the producer settles it on its own schedule. Without this,
        // the natural spelling of the wasi:sockets 0.3 TCP `send` shape —
        // `func(data: stream<u8>) -> future<result>`, an async method whose
        // promise resolves when transmission completes — would park the
        // call, and a future whose settlement depends on post-return guest
        // action (the guest writes `data` AFTER `send` returns) livelocks.
        // This branch also covers a returned `Future` handle, which is a
        // PromiseLike and would otherwise be adopted and mis-lowered.
        if (resultType !== null && resultType.kind === "future") {
          scope.end();
          return ok(out);
        }
        return (out as PromiseLike<unknown>).then(
          (v) => {
            scope.end();
            return ok(v);
          },
          (e) => {
            scope.end();
            return fail(e, args);
          },
        );
      }
      scope.end();
      return ok(out);
    };
  }

  // -- exports ---------------------------------------------------------------

  // deno-lint-ignore no-explicit-any
  buildExports(handle: ComponentHandle): Record<string, any> {
    this.#exportsBuilt = true;
    // deno-lint-ignore no-explicit-any
    const out: Record<string, any> = {};
    const worldLeaves: WireExport[] = [];
    for (const exp of this.artifacts.plan.exports) {
      if (exp.kind === "instance") {
        out[exp.name] = this.#buildInterface(
          exp.name,
          exp.exports,
          handle.exports[exp.name] as Record<string, unknown>,
        );
      } else {
        worldLeaves.push(exp);
      }
    }
    if (worldLeaves.length > 0) {
      Object.assign(
        out,
        this.#buildInterface("", worldLeaves, handle.exports),
      );
    }
    return out;
  }

  // deno-lint-ignore no-explicit-any
  #buildInterface(
    id: string,
    exps: WireExport[],
    raw: Record<string, unknown>,
    // deno-lint-ignore no-explicit-any
  ): Record<string, any> {
    // deno-lint-ignore no-explicit-any
    const obj: Record<string, any> = {};
    /** jsName -> the WIT leaf that claimed it (camelCase collision guard). */
    const claimed = new Map<string, string>();
    const claim = (js: string, leaf: string): string => {
      const held = claimed.get(js);
      if (held !== undefined) {
        throw new NameCollisionError(
          `export '${id || "<world>"}': the leaves '${held}' and '${leaf}' ` +
            `both map to the JS name '${js}'. Rename one in the WIT; the ` +
            `conventions layer will not guess which one wins.`,
        );
      }
      claimed.set(js, leaf);
      return js;
    };
    const specs = new Map<string, GuestResourceSpec>();
    const specRt = new Map<string, ResourceTypeInfo>();
    const spec = (name: string): GuestResourceSpec => {
      let s = specs.get(name);
      if (s === undefined) {
        s = { name, ctor: null, ctorParams: null, methods: [], statics: [] };
        specs.set(name, s);
      }
      return s;
    };

    for (const exp of exps) {
      if (exp.kind === "type") {
        // A `resource` type export names the class; the ResourceIndex comes
        // from the resource TABLE it points at (the wire field is a table
        // index, like `own`/`borrow`).
        if (exp.type.kind === "resource") {
          const token = this.loaded.resourceTokens[exp.type.resource];
          if (token !== undefined && this.#tokenIndex.has(token)) {
            const index = this.#tokenIndex.get(token)!;
            const held = this.#bindings.get(index);
            if (held === undefined) {
              this.#bindings.set(index, { kind: "guest", name: exp.name });
            } else if (held.kind === "guest") {
              held.name = exp.name;
            }
          }
        }
        continue;
      }
      if (exp.kind === "module") {
        // Not WIT-expressible, digest-excluded (plan-format.md v4 amendment
        // 2): the WIT-shaped facade skips it, the type-export precedent. The
        // raw executor export surface still carries the compiled module.
        continue;
      }
      if (exp.kind === "instance") {
        // The plan flattens the world's instance exports at the top level; a
        // nested one would need a nested facade, which nothing produces today.
        // Refuse rather than silently drop the whole sub-interface.
        throw new PlanError(
          `export '${id || "<world>"}/${exp.name}': nested instance exports ` +
            `are not surfaced by the conventions layer (only one level of ` +
            `interface nesting exists in plan v2)`,
        );
      }
      if (exp.kind !== "lifted-func") {
        throw new PlanError(
          `export '${id || "<world>"}/${(exp as { name?: string }).name}': ` +
            `unsupported export kind ` +
            `'${(exp as { kind: string }).kind}'`,
        );
      }
      const fn = raw[exp.name] as RawFn | undefined;
      if (typeof fn !== "function") {
        throw new PlanError(
          `export '${id || "<world>"}/${exp.name}': the runtime produced no ` +
            `callable for this lifted function`,
        );
      }
      const ft = this.#funcType(exp.type, `export '${id}/${exp.name}'`);
      const member = parseLeafName(exp.name);
      const where = id === "" ? exp.name : `${id}#${exp.name}`;
      switch (member.form) {
        case "plain":
          obj[claim(camelCase(member.name), member.name)] = this
            .#wrapExportFn(fn, ft, where);
          break;
        case "constructor": {
          const s = spec(member.resource);
          // Prefer the plain-entered variant in jspi mode: the JS `new`
          // cannot await the Promise a promising-wrapped entry returns
          // (exec/boundary.ts SYNC_ENTRY).
          s.ctor = ((fn as unknown as Record<PropertyKey, unknown>)[
            SYNC_ENTRY
          ] ?? fn) as RawFn;
          s.ctorParams = ft.params;
          rtOf(ft.results[0], specRt, member.resource);
          break;
        }
        case "method": {
          spec(member.resource).methods.push({
            member: member.member,
            raw: fn,
            params: ft.params,
            results: ft.results,
            async: ft.async === true,
          });
          rtOf(ft.params[0], specRt, member.resource);
          break;
        }
        case "static": {
          spec(member.resource).statics.push({
            member: member.member,
            raw: fn,
            params: ft.params,
            results: ft.results,
            async: ft.async === true,
          });
          break;
        }
      }
    }

    for (const [name, s] of specs) {
      const rt = specRt.get(name);
      if (rt === undefined) {
        throw new PlanError(
          `export '${id}': resource '${name}' has leaves but no own/borrow ` +
            `type to identify it by`,
        );
      }
      const cls = buildGuestResourceClass(
        s,
        rt,
        (raw, params, results, async, where) =>
          this.#wrapExportFn(raw, { params, results, async }, where),
        (args, params, where) =>
          args.map((a, i) => fromHost(a, params[i], this.#opts(where))),
      );
      obj[claim(pascalCase(name), name)] = cls;
      const index = this.#tokenIndex.get(rt);
      if (index !== undefined) {
        this.#bindings.set(index, { kind: "guest", name, cls });
      }
    }
    return obj;
  }

  /**
   * Lower a call's arguments, collecting the releases for anything that was
   * allocated *for the duration of this call* (see `lowerBorrow`).
   *
   * The collection window is the synchronous argument-lowering phase only —
   * `#lowerScope` is set and cleared with no `await` in between — so a single
   * slot is correct even with concurrent export calls in flight.
   */
  #lowerParams(
    params: ValType[],
    args: unknown[],
    o: AdapterOptions,
  ): { lowered: ComponentValue[]; release: () => void } {
    const scope: (() => void)[] = [];
    const outer = this.#lowerScope;
    this.#lowerScope = scope;
    let lowered: ComponentValue[];
    try {
      lowered = params.map((p, i) => fromHost(args[i], p, o));
    } catch (e) {
      for (const r of scope) r();
      throw e;
    } finally {
      this.#lowerScope = outer;
    }
    let released = false;
    return {
      lowered,
      release: () => {
        if (released) return;
        released = true;
        for (const r of scope) r();
      },
    };
  }

  /**
   * Wrap one lifted export.
   *
   * Uniformly Promise-shaped (contract §"Functions and async"): a sync
   * completion resolves immediately, so there is one calling convention.
   * A `result<T, E>` in *function-result* position resolves `T` or rejects
   * `ComponentException<E>`; a result nested inside a value is plain `{kind, value}` data
   * and never throws.
   */
  #wrapExportFn(
    fn: RawFn,
    ft: { params: ValType[]; results: ValType[]; async?: boolean },
    where: string,
  ): (...args: unknown[]) => Promise<unknown> {
    const o = this.#opts(where);
    const resultType = ft.results.length === 0 ? null : ft.results[0];
    let wrapper: (...args: unknown[]) => Promise<unknown>;
    if (resultType !== null && resultType.kind === "future") {
      // See `Future.deferred`: a `future<T>` result cannot be delivered
      // *through* a Promise, because promise resolution adopts thenables and
      // `Future<T>` is one. The handle is returned eagerly instead; it is
      // PromiseLike, so `await` still yields `T`.
      const element = resultType.element;
      wrapper = (...args: unknown[]): Promise<unknown> => {
        // Advisory 9: the generic branch checks arity; so must this one.
        if (args.length !== ft.params.length) {
          throw new TypeError(
            `${where}: expected ${ft.params.length} argument(s), got ` +
              `${args.length}`,
          );
        }
        const { lowered, release } = this.#lowerParams(ft.params, args, o);
        let pending: Promise<ComponentValue>;
        try {
          pending = Promise.resolve(fn(...lowered)) as Promise<ComponentValue>;
        } catch (e) {
          release();
          throw e;
        }
        void pending.then(release, release);
        return Future.deferred(
          pending,
          elementCodec(element, o),
        ) as unknown as Promise<unknown>;
      };
    } else {
      wrapper = async (...args: unknown[]): Promise<unknown> => {
        if (args.length !== ft.params.length) {
          throw new TypeError(
            `${where}: expected ${ft.params.length} argument(s), got ${args.length}`,
          );
        }
        const { lowered, release } = this.#lowerParams(ft.params, args, o);
        let raw: unknown;
        try {
          raw = await fn(...lowered);
        } finally {
          // Call-scoped reps minted for `borrow<R>` arguments of a
          // host-implemented resource live exactly as long as the call.
          release();
        }
        if (resultType === null) return undefined;
        if (resultType.kind === "result") {
          const v = raw as Record<string, ComponentValue>;
          if ("error" in v) {
            throw new ComponentException(
              resultType.error === null
                ? undefined
                : toHost(v["error"], resultType.error, o),
            );
          }
          return resultType.ok === null
            ? undefined
            : toHost(v["ok"], resultType.ok, o);
        }
        return toHost(raw as ComponentValue, resultType, o);
      };
    }
    // A25 brand (contracts/embedder-api.md §"Functions and async"): every
    // returned wrapper is branded, additively — the default Promise-shaped
    // surface above is unchanged either way.
    if (ft.async === true) {
      markSyncCallable(wrapper, { kind: "async" });
    } else {
      markSyncCallable(wrapper, {
        kind: "free",
        fn: this.#buildSyncForm(fn, ft, where, o),
      });
    }
    return wrapper;
  }

  /**
   * The synchronous form of a sync-typed export (A25's `sync()` adapter),
   * mirroring `#wrapExportFn`'s async form exactly minus the `await`:
   * arity check, `#lowerParams`, the plain (`SYNC_ENTRY`) entry, result
   * mapping.
   *
   * `SYNC_ENTRY` is the plain-entered variant `executor.ts` attaches to every
   * sync-typed lifted export in jspi mode (exec/boundary.ts; in plain mode
   * the lifted function itself already returns synchronously, so `fn` is
   * used as-is — `fn[SYNC_ENTRY] ?? fn`).
   */
  #buildSyncForm(
    fn: RawFn,
    ft: { params: ValType[]; results: ValType[] },
    where: string,
    o: AdapterOptions,
  ): (...args: unknown[]) => unknown {
    const resultType = ft.results.length === 0 ? null : ft.results[0];
    const entry = ((fn as unknown as Record<PropertyKey, unknown>)[
      SYNC_ENTRY
    ] as RawFn | undefined) ?? fn;
    const unreachableThenable = (raw: unknown): never => {
      // Defensive (see the dispatch prompt / A25 failure ladder): a genuine
      // park through a plain entry surfaces as a trap, `NeedsJspi`, or
      // `SyncEntryBusy` — never a settled thenable VALUE. A silent
      // Promise-as-value here would corrupt lifting rather than fail loudly,
      // so this is a diagnostic backstop, not a documented outcome.
      void raw;
      throw new Error(
        `${where}: the sync entry returned a thenable, which should be ` +
          `unreachable for a sync-typed WIT export (a genuine park surfaces ` +
          `as a trap, NeedsJspi, or SyncEntryBusy instead) — this indicates ` +
          `a runtime defect`,
      );
    };
    if (resultType !== null && resultType.kind === "future") {
      const element = resultType.element;
      return (...args: unknown[]): unknown => {
        if (args.length !== ft.params.length) {
          throw new TypeError(
            `${where}: expected ${ft.params.length} argument(s), got ` +
              `${args.length}`,
          );
        }
        const { lowered, release } = this.#lowerParams(ft.params, args, o);
        let raw: unknown;
        try {
          raw = entry(...lowered);
        } finally {
          release();
        }
        if (isThenable(raw)) unreachableThenable(raw);
        return Future.fromLifted(
          raw as ComponentValue,
          elementCodec(element, o),
        );
      };
    }
    return (...args: unknown[]): unknown => {
      if (args.length !== ft.params.length) {
        throw new TypeError(
          `${where}: expected ${ft.params.length} argument(s), got ${args.length}`,
        );
      }
      const { lowered, release } = this.#lowerParams(ft.params, args, o);
      let raw: unknown;
      try {
        raw = entry(...lowered);
      } finally {
        release();
      }
      if (isThenable(raw)) unreachableThenable(raw);
      if (resultType === null) return undefined;
      if (resultType.kind === "result") {
        const v = raw as Record<string, ComponentValue>;
        if ("error" in v) {
          throw new ComponentException(
            resultType.error === null
              ? undefined
              : toHost(v["error"], resultType.error, o),
          );
        }
        return resultType.ok === null
          ? undefined
          : toHost(v["ok"], resultType.ok, o);
      }
      return toHost(raw as ComponentValue, resultType, o);
    };
  }
}

// ---------------------------------------------------------------------------

function rtOf(
  t: ValType | undefined,
  into: Map<string, ResourceTypeInfo>,
  name: string,
): void {
  if (t === undefined) return;
  if (t.kind === "own" || t.kind === "borrow") into.set(name, t.rt);
}

function label(leaf: ImportLeaf): string {
  return leaf.path.length === 0
    ? leaf.interfaceId
    : `${leaf.interfaceId}/${leaf.path.join("/")}`;
}

function nest(
  root: Record<string, unknown>,
  key: string,
  path: string[],
): Record<string, unknown> {
  let cur = (root[key] ??= {}) as Record<string, unknown>;
  for (const seg of path) {
    cur = (cur[seg] ??= {}) as Record<string, unknown>;
  }
  return cur;
}

/** Read `names` in order from `container` after walking `path`. */
function pick(
  container: unknown,
  path: string[],
  names: string[],
): unknown {
  let v = container;
  for (const seg of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[seg];
  }
  if (v === null || typeof v !== "object") {
    return names.length === 0 ? v : undefined;
  }
  for (const n of names) {
    const hit = (v as Record<string, unknown>)[n];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Read a DATA property from `obj` (walking its prototype chain, nearest own
 * descriptor wins) without ever invoking accessors. Accessor-backed and
 * absent members both yield `undefined`. Used by the A2 wrap-time suspending
 * probe, which must not run platform getters against a bare prototype.
 */
function dataMember(obj: unknown, key: string): unknown {
  for (
    let o = obj;
    o !== null && (typeof o === "object" || typeof o === "function");
    o = Object.getPrototypeOf(o)
  ) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d !== undefined) return "value" in d ? d.value : undefined;
  }
  return undefined;
}

function isThenable(v: unknown): boolean {
  return v !== null && typeof v === "object" && "then" in v &&
    typeof (v as { then: unknown }).then === "function";
}

/**
 * Drop the lifted stream/future arguments a trapping import abandoned (#66).
 * Top-level parameters only: those are the shapes whose peers park host
 * operations; a stream nested inside a record is exotic enough to leave to
 * the negligence rules. Uses the teardown drop, not the plain one — the
 * calling instance is about to be poisoned by this very trap, and a DROPPED
 * notification must not queue a phantom event into its waitables (review
 * B2; see task/streams.ts `dropSharedForTeardown`).
 */
function releaseAsyncArgs(args: unknown[]): void {
  for (const a of args) {
    if (a instanceof Stream || a instanceof Future) {
      try {
        a.dropForTeardown();
      } catch {
        // Best-effort teardown: the component is already trapping, and that
        // trap — not a secondary drop failure — is the error to surface.
      }
    }
  }
}

function describeThrow(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return describe(e);
}
