// The conventions facade: `instantiate(artifacts, imports, opts)`.
//
// DESIGN: the facade is **runtime-driven**. Every
// camelCase name, every resource class and every import wrapper is built here,
// at instantiate time, from the loaded plan's type tables — the plan already
// carries names, kinds and function types. Bindgen emits types and a wrapper
// that verifies the world digest before delegating here; untyped callers can
// instantiate directly.
//
// Governing contract: contracts/embedder-api.md (all sections). Secondary:
// contracts/plan-format.md for the wire shapes read here.

import type { WireExport, WirePlan } from "../plan/format.ts";
import type { LoadedPlan } from "../plan/loader.ts";
import { loadEnvelope, loadPlan, PlanError } from "../plan/loader.ts";
import type { FuncType, ResourceTypeInfo, ValType } from "../cabi/types.ts";
import type { ComponentValue, VariantValue } from "../cabi/types.ts";
import { despecialize } from "../cabi/types.ts";
import { hostFutureFor, hostStreamFor } from "../exec/host_streams.ts";
import { Trap } from "../cabi/trap.ts";
import {
  type ComponentHandle,
  type HostImports,
  hostResourceType,
  instantiateComponent,
  SYNC_ENTRY,
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
import { copyCensus, isComponentException, isTrap } from "@polyengine/protocol";
import { ComponentException, NameCollisionError } from "./errors.ts";
import { type ImportLeaf, requiredImports } from "./imports.ts";
import { hostDtorCall } from "../exec/boundary.ts";
import {
  buildGuestResourceClass,
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
import { markSyncCallable } from "./sync.ts";

/**
 * Preserve declaration-level suspension/cancellation marks through every
 * facade wrapper; the executor sees only the outermost function.
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
 * §"Module wiring and instantiation"): hand `instantiate` the raw component plus the translator
 * and it runs the translation internally — the pipeline collapses to
 * bytes-in, instance-out.
 *
 * `translator` accepts the translator-shim wasm bytes (simplest; compiles
 * the shim per call) or an already-created `Translator` (preferred when
 * instantiating more than one component, or the same component more than
 * once, to share the compiled shim and its instance). `requiredImports`
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
 * the runtime: no translator ships (contracts/embedder-api.md §"Module wiring and instantiation").
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
 * plan before instantiating (§"Module wiring and instantiation").
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
  /** Override automatic JSPI selection (see `InstantiateInput.jspi`). */
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
    // Share the facade's resource tokens with imports called by core start
    // functions, before instantiateComponent returns a handle.
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
 * Alias matching bindgen's generated import spelling.
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
  /** ResourceTypeInfo identity -> ResourceIndex (many table aliases). */
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
   * Releases collected during synchronous argument lowering. #lowerParams
   * saves/restores this slot for reentrant lowering; each call retains its
   * own release list after the collection window ends.
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
    // Resolve identity before core start functions can call imports. Concrete
    // tables naming one ResourceIndex share an origin, not local handle identity
    // (plan-format.md "Type exports index into `resourceTables`").
    artifacts.plan.resourceTables.forEach((table, i) => {
      if (table.kind !== "concrete") return;
      const token = this.loaded.resourceTokens[i]?.resource;
      if (token !== undefined) this.#tokenIndex.set(token, table.resource);
    });
    this.leaves = requiredImports(this.loaded);
    // A component that imports a resource TYPE cannot be wired without
    // `plan.importedResources`: that table is the only thing mapping the
    // import back to a `ResourceIndex` (the `importedResources` field,
    // contracts/plan-format.md schema). Without it every own/borrow of that type would fail late, deep
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
   * Confirm the executor used the facade's loaded plan, not fresh resource
   * tokens that would disagree with the import wrappers.
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
      () => ({ lowered: [], release: () => {} }),
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
   * order (the `importedResources` field, contracts/plan-format.md schema).
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
    return {
      liftOwn: (rep, t) => {
        const b = this.#binding(t.rt.resource);
        // Host-implemented R: "the host's own instance back; the guest's
        // handle is gone; no dispose call" (contract 2x4 table).
        if (b.kind === "host") return b.registry.release(rep);
        return makeWrapper(this.#guestClass(b), rep, t.rt.resource, true);
      },
      liftBorrow: (rep, t, scope) => {
        const b = this.#binding(t.rt.resource);
        // Host-implemented R: "the host's own instance; borrow scoping is
        // guest-side bookkeeping" — the mapping is kept.
        if (b.kind === "host") return b.registry.lookup(rep);
        const w = makeWrapper(this.#guestClass(b), rep, t.rt.resource, false);
        scope.add(() => invalidateWrapper(w));
        return w;
      },
      lowerOwn: (v, t) => {
        const b = this.#binding(t.rt.resource);
        if (b.kind === "host") return b.registry.repFor(v);
        return takeRep(v, t.rt.resource, true, `own<${b.name}>`);
      },
      lowerBorrow: (v, t) => {
        const b = this.#binding(t.rt.resource);
        if (b.kind === "host") {
          // Each overlapping call retains the rep; the final borrow release
          // removes only temporary mappings, never a guest-owned registration.
          const { rep, release } = b.registry.borrowFor(v);
          if (this.#lowerScope === null) release();
          else this.#lowerScope.push(release);
          return rep;
        }
        // Retain the rep until this call ends; explicit/GC drop must not
        // destroy it while borrowed (lift_borrow -> Subtask.add_lender).
        const rep = takeRep(v, t.rt.resource, false, `borrow<${b.name}>`);
        const release = lendWrapper(v as object);
        if (this.#lowerScope === null) {
          // No enclosing lowering scope (a raw/one-off lowering): the lend
          // has no observable window, so it must not be left dangling.
          release();
        } else {
          this.#lowerScope.push(release);
        }
        return rep;
      },
      dropOwn: (rep, t) => {
        // resource stream: a lowered `own` the guest will never take (an un-taken
        // stream element). Destroy it exactly as a guest-side drop would:
        // host-implemented R runs the instance's [Symbol.dispose] through
        // the registry; guest-implemented R runs the guest dtor via the
        // gated path (a host-initiated drop, `caller = None`).
        const b = this.#binding(t.rt.resource);
        if (b.kind === "host") {
          b.registry.dtor(rep);
          return;
        }
        hostDtorCall(t.rt.resource, rep);
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
    // Build the value adapter lazily from the facade's already-loaded types.
    // The executor receives this same LoadedPlan, including for start calls.
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
    // The executor reads declaration marks from this outermost wrapper.
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
      // Interface members keep their provider as receiver; world-level
      // functions stay unbound. Relay marks through the dispatch closure.
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
        // synchronous (contracts/embedder-api.md §"Functions and async"), and stage-3 reserves no
        // constructor-decorator position.
        // deno-lint-ignore no-explicit-any
        return (args) => new (cls as any)(...args);
      case "method": {
        // Declaration marks come from prototype data methods at instantiation;
        // per-instance overrides change the body, not the declaration. Do not
        // invoke accessors while probing a bare prototype. Actual method
        // lookup remains a call-time operation on the receiver.
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
        // suspending mark: a static's brand sits on the function itself (a stage-3
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
   * Error model (contract §"Error model"):
   *   * a returned value is the ok side;
   *   * `throw new ComponentException(payload)` is the err side of a `result<T, E>`;
   *   * a `Trap` passes through unchanged;
   *   * **any other throw is a host bug and becomes a trap naming the import**
   *     — never a guest-visible err.
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
        return {
          kind: "ok",
          value: rt.ok === null ? null : fromHost(v, rt.ok, o),
        };
      }
      return fromHost(v, resultType, o);
    };
    const fail = (e: unknown, args: unknown[]): ComponentValue => {
      // Brand, not class (§"Module identity and @polyengine/protocol"): a `ComponentException` thrown by a host module
      // that resolved a DIFFERENT runtime copy — or hand-rolled with the
      // registry symbol — is the same value here (issue #83).
      if (isComponentException(e) && isResult) {
        const rt = resultType as ValType & { kind: "result" };
        return {
          kind: "error",
          value: rt.error === null ? null : fromHost(e.payload, rt.error, o),
        };
      }
      // Trap paths abandon top-level async arguments transferred to the host.
      // A normal result error does not: its implementation may retain them.
      releaseAsyncArgs(args);
      if (isTrap(e)) throw e;
      if (isComponentException(e)) {
        throw new Trap(
          `${where} threw a ComponentException, but its WIT type has no err side; ` +
            `only a fallible import may signal an error value`,
        );
      }
      // Include copy diagnostics for unbranded host failures.
      const census = copyCensus();
      throw new Trap(
        `${where} threw ${describeThrow(e)}. An unbranded throw from a host ` +
          `import is a host bug and becomes a trap: signal a WIT error with ` +
          `\`throw new ComponentException(payload)\`.` +
          (census === ""
            ? ""
            : ` (${census} — an error carrying no polyengine brand in a ` +
              `multi-copy graph usually means a pre-module identity runtime copy threw ` +
              `it, issue #83.)`),
      );
    };

    return (...raw: unknown[]) => {
      const scope = new BorrowScope();
      const args = ft.params.map((p, i) =>
        toHost(raw[i] as ComponentValue, p, o, scope)
      );
      // Extras beyond WIT params are runtime values, notably abortable()'s
      // AbortSignal. Forward without component-value conversion.
      for (let i = ft.params.length; i < raw.length; i++) args.push(raw[i]);
      let out: unknown;
      try {
        out = dispatch(args);
      } catch (e) {
        scope.end();
        return fail(e, args);
      }
      if (isThenable(out)) {
        // A future-typed result is the source, not async call completion.
        // Lower it immediately: settlement may depend on guest work after
        // this import returns. This also preserves returned Future handles.
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
          const token = this.loaded.resourceTokens[exp.type.resource]?.resource;
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
        // Not WIT-expressible, digest-excluded (the `module` export kind,
        // contracts/plan-format.md schema notes): the WIT-shaped facade skips it, the type-export precedent. The
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
          this.#lowerParams(params, args, this.#opts(where)),
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
   * Save/restore the collection slot for reentrant lowering. Release every
   * borrow once, even if another release throws, then report the first error.
   */
  #lowerParams(
    params: ValType[],
    args: unknown[],
    o: AdapterOptions,
  ): { lowered: ComponentValue[]; release: () => void } {
    const scope: (() => void)[] = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      let failed = false;
      let error: unknown;
      for (const r of scope) {
        try {
          r();
        } catch (e) {
          if (!failed) error = e;
          failed = true;
        }
      }
      if (failed) throw error;
    };
    const outer = this.#lowerScope;
    this.#lowerScope = scope;
    let lowered: ComponentValue[];
    try {
      lowered = params.map((p, i) => fromHost(args[i], p, o));
    } catch (e) {
      try {
        release();
      } catch {
        // The original error wins; a secondary failure of the unwind is
        // not the story.
      }
      throw e;
    } finally {
      this.#lowerScope = outer;
    }
    return { lowered, release };
  }

  /** Cleanup cannot abandon a result already transferred out of the guest. */
  #finishCall(
    release: () => void,
    succeeded: boolean,
    raw: unknown,
    type: ValType | null,
  ): void {
    try {
      release();
    } catch (e) {
      if (!succeeded) return; // Preserve the original call failure.
      if (type !== null) this.#dropResult(raw as ComponentValue, type);
      throw e;
    }
  }

  #dropResult(raw: ComponentValue, type: ValType): void {
    // Already failing cleanup: retire every owned leaf, preserving that error
    // even when a result destructor also throws.
    try {
      const t = despecialize(type);
      switch (t.kind) {
        case "own":
          this.#bridge.dropOwn(raw as number, t);
          break;
        case "future":
          hostFutureFor(raw).drop();
          break;
        case "stream":
          hostStreamFor(raw).readable.drop();
          break;
        case "list":
          for (const v of raw as ComponentValue[]) {
            this.#dropResult(v, t.element);
          }
          break;
        case "record":
          for (const f of t.fields) {
            this.#dropResult(
              (raw as Record<string, ComponentValue>)[f.label],
              f.type,
            );
          }
          break;
        case "variant": {
          const v = raw as VariantValue;
          const payload = t.cases.find((c) => c.label === v.kind)?.type;
          if (payload != null) this.#dropResult(v.value, payload);
          break;
        }
      }
    } catch {
      // The argument cleanup error remains primary.
    }
  }

  /**
   * Wrap one lifted export.
   *
   * Promise-shaped except for an eager Future handle in future-result
   * position (contract §"Functions and async").
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
          this.#finishCall(release, false, undefined, resultType);
          throw e;
        }
        return Future.deferred(
          pending,
          elementCodec(element, o),
          (succeeded, raw) =>
            this.#finishCall(release, succeeded, raw, resultType),
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
        } catch (e) {
          this.#finishCall(release, false, undefined, resultType);
          throw e;
        }
        this.#finishCall(release, true, raw, resultType);
        if (resultType === null) return undefined;
        if (resultType.kind === "result") {
          // Internal result: `{kind: "ok"|"error", value}` (cabi/types.ts
          // `VariantValue`) — the error case is spelled "error" here, not
          // the host layer's "err".
          const v = raw as VariantValue;
          if (v.kind === "error") {
            throw new ComponentException(
              resultType.error === null
                ? undefined
                : toHost(v.value, resultType.error, o),
            );
          }
          return resultType.ok === null
            ? undefined
            : toHost(v.value, resultType.ok, o);
        }
        return toHost(raw as ComponentValue, resultType, o);
      };
    }
    // sync() selects the synchronous form without changing the default wrapper.
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
   * The synchronous form of a sync-typed export (sync()'s `sync()` adapter),
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
      // A plain entry must refuse suspension, not return a thenable that
      // would be mistaken for a component value.
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
        } catch (e) {
          this.#finishCall(release, false, undefined, resultType);
          throw e;
        }
        this.#finishCall(release, true, raw, resultType);
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
      } catch (e) {
        this.#finishCall(release, false, undefined, resultType);
        throw e;
      }
      this.#finishCall(release, true, raw, resultType);
      if (isThenable(raw)) unreachableThenable(raw);
      if (resultType === null) return undefined;
      if (resultType.kind === "result") {
        // See the note on the async wrapper above: internal spelling is
        // "error", the host layer's is "err".
        const v = raw as VariantValue;
        if (v.kind === "error") {
          throw new ComponentException(
            resultType.error === null
              ? undefined
              : toHost(v.value, resultType.error, o),
          );
        }
        return resultType.ok === null
          ? undefined
          : toHost(v.value, resultType.ok, o);
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
  if (t.kind === "own" || t.kind === "borrow") into.set(name, t.rt.resource);
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
 * absent members both yield `undefined`. Used by the wrap-time suspending-mark
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
 * Drop top-level stream/future arguments abandoned by a trapping import.
 * Nested handles are not traversed. Teardown suppresses notifications only
 * for peers already marked poisoned/retired; it does not anticipate the
 * caller's later poisoning (task/streams.ts dropSharedForTeardown).
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
