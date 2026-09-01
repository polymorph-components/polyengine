// The real executor: components run through the plan executor
// (translator shim -> plan v0 -> runtime/src/exec), core modules through the
// JS WebAssembly API (delegated to CoreOnlyExecutor's module path, which is
// exact and needs no reimplementation).
//
// Scope note: the runtime is a *sync* executor (docs/architecture.md §6
// degenerate path); async canonical options / stream|future types raise
// PlanError("... task scheduler ...") from
// runtime/src/exec/boundary.ts createLiftedFunction, or NotImplemented from
// runtime/src/cabi lift/lower for stream/future values. Both are mapped here
// to PendingRuntimeError with a `pending-capability: ` prefix (see
// runner.ts) rather than left to surface as a failure, since the command is
// understood but the capability plainly doesn't exist yet — precise
// hand-off to whichever track builds it.

import { loadPlan, PlanError } from "@polyengine/runtime/plan";
import type { LoadedPlan } from "@polyengine/runtime/plan";
import type { WireExport } from "@polyengine/runtime/plan";
import { Translator } from "@polyengine/runtime/shim";
import {
  type ComponentHandle,
  instantiateComponent,
} from "../../runtime/src/exec/mod.ts";
import { AssertionError, NotImplemented, Trap } from "../../runtime/src/cabi/mod.ts";
import {
  type Artifact,
  CoreOnlyExecutor,
  type CommandExecutor,
  type InstanceRef,
  type InstantiateExpectation,
  type InvokeOutcome,
  LinkError,
  PendingRuntimeError,
  TrapError,
} from "./executor.ts";
import type { Value } from "./schema.ts";
import { collapseResultsByArity, toComponentValue } from "./value-mapping.ts";

/** Substrings that indicate the command needs a not-yet-built runtime
 * capability (async/streams/etc) rather than a genuine bug. Checked
 * against thrown error messages from the shim/plan/executor. Keep narrow —
 * anything else surfaces as a real failure. */
const CAPABILITY_MARKERS = [
  "stream/future",
  "needs task machinery",
  "needs copy machinery",
  "error-context",
  // UnsupportedFeatureError from runtime/src/intrinsics for capability-gated
  // trampolines ("… — needs the "…" capability, not yet implemented …", the
  // runtime's own literal text): a declared capability gap, not a wrong
  // answer — classify as pending-capability.
  "capability, not yet implemented",
];

function asCapabilityOrRethrow(e: unknown, what: string): never {
  maybeCapability(e, what);
  throw e;
}

/** Throws PendingRuntimeError iff the error message carries a
 * CAPABILITY_MARKERS phrase; otherwise returns. */
function maybeCapability(e: unknown, what: string): void {
  const message = e instanceof Error ? e.message : String(e);
  if (CAPABILITY_MARKERS.some((m) => message.includes(m))) {
    throw new PendingRuntimeError(`pending-capability: ${what}: ${message}`);
  }
}

interface ComponentInstanceRef extends InstanceRef {
  readonly kind: "component";
  handle: ComponentHandle;
  arities: Map<string, number>;
}

interface ModuleInstanceRef extends InstanceRef {
  readonly kind: "module";
  instance: WebAssembly.Instance;
}

type AnyInstanceRef = ComponentInstanceRef | ModuleInstanceRef;

/** Walks a plan's export tree, mapping export *name* (leaf, not path — this
 * suite invokes by plain field name, wast2json convention) to its arity
 * (`FuncType.results.length`) so `resultsToHost`'s arity-collapsed return
 * (undefined/bare-value/array) can be reconstructed into a `Value[]`-shaped
 * result list without ambiguity when the single result itself is an array
 * (e.g. `list<T>`). */
function computeExportArities(loaded: LoadedPlan): Map<string, number> {
  const arities = new Map<string, number>();
  const visit = (exports: WireExport[]) => {
    for (const exp of exports) {
      if (exp.kind === "lifted-func") {
        const t = loaded.types[exp.type];
        if (t !== undefined && t.kind === "func") {
          arities.set(exp.name, t.funcType.results.length);
        }
      } else if (exp.kind === "instance") {
        visit(exp.exports);
      }
    }
  };
  visit(loaded.wire.exports);
  return arities;
}

/** Named-definition slot (`module_definition`): what an artifact resolved to
 * before instantiation (`module_instance`). */
type Definition =
  | { kind: "component"; bytes: Uint8Array }
  | { kind: "module"; module: WebAssembly.Module };

export class RuntimeExecutor implements CommandExecutor {
  readonly #translator: Translator;
  readonly #core = new CoreOnlyExecutor();
  #definitions: Definition[] = [];
  #namedDefinitions = new Map<string, Definition>();
  #registered = new Map<string, AnyInstanceRef>();

  private constructor(translator: Translator) {
    this.#translator = translator;
  }

  static async create(shimWasm: Uint8Array): Promise<RuntimeExecutor> {
    return new RuntimeExecutor(await Translator.create(shimWasm));
  }

  validate(
    artifact: Artifact,
  ): Promise<{ valid: boolean; error?: string }> {
    if (artifact.kind === "module") return this.#core.validate(artifact);
    try {
      this.#translator.translate(artifact.bytes);
      return Promise.resolve({ valid: true });
    } catch (e) {
      return Promise.resolve(
        { valid: false, error: e instanceof Error ? e.message : String(e) },
      );
    }
  }

  async instantiate(
    artifact: Artifact,
    expect: InstantiateExpectation,
  ): Promise<InstanceRef> {
    if (artifact.kind === "module") return this.#core.instantiate(artifact, expect);
    return await this.#instantiateComponent(artifact.bytes, expect);
  }

  async #instantiateComponent(
    bytes: Uint8Array,
    expect: InstantiateExpectation,
  ): Promise<ComponentInstanceRef> {
    let plan, adapters;
    try {
      ({ plan, adapters } = this.#translator.translate(bytes));
    } catch (e) {
      // A structured translator error is component-invalid, not a runtime
      // instantiation trap/link-error — this suite's assert_uninstantiable
      // / assert_unlinkable fixtures are valid components by construction,
      // so translate failure here is a genuine problem regardless of
      // `expect`, never the expected outcome.
      throw e;
    }
    let handle: ComponentHandle;
    try {
      handle = await instantiateComponent({ plan, componentBytes: bytes, adapters });
    } catch (e) {
      if (e instanceof Trap) {
        if (expect === "trap") throw new TrapError(e.message);
        asCapabilityOrRethrow(e, "instantiate");
      }
      if (e instanceof PlanError) asCapabilityOrRethrow(e, "instantiate");
      // Capability-gated trampolines (UnsupportedFeatureError et al.) match
      // via CAPABILITY_MARKERS regardless of error class:
      maybeCapability(e, "instantiate");
      if (expect === "link-error") throw new LinkError(String(e));
      throw e;
    }
    if (expect !== "success") {
      throw new Error(
        `expected instantiation ${expect}, but component instantiated successfully`,
      );
    }
    const loaded = loadPlan(plan);
    return {
      kind: "component",
      handle,
      arities: computeExportArities(loaded),
    };
  }

  async define(name: string | undefined, artifact: Artifact): Promise<void> {
    if (artifact.kind === "module") {
      const { valid, error } = await this.#core.validate(artifact);
      if (!valid) throw new TrapError(`definition failed validation: ${error}`);
      const def: Definition = {
        kind: "module",
        module: await WebAssembly.compile(new Uint8Array(artifact.bytes)),
      };
      this.#definitions.push(def);
      if (name !== undefined) this.#namedDefinitions.set(name, def);
      return;
    }
    try {
      this.#translator.translate(artifact.bytes);
    } catch (e) {
      throw new TrapError(
        `component definition failed translation: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    const def: Definition = { kind: "component", bytes: artifact.bytes };
    this.#definitions.push(def);
    if (name !== undefined) this.#namedDefinitions.set(name, def);
  }

  async instantiateDefinition(
    defName: string | undefined,
    _instanceName: string | undefined,
  ): Promise<InstanceRef> {
    const def = defName !== undefined
      ? this.#namedDefinitions.get(defName)
      : this.#definitions[this.#definitions.length - 1];
    if (def === undefined) {
      throw new Error(`no definition named '${defName}'`);
    }
    if (def.kind === "module") {
      const instance = await WebAssembly.instantiate(def.module, {});
      return { kind: "module", instance } as ModuleInstanceRef;
    }
    return await this.#instantiateComponent(def.bytes, "success");
  }

  register(as: string, instance: InstanceRef | undefined): Promise<void> {
    if (instance === undefined) {
      throw new Error(`register '${as}': no current instance`);
    }
    // Component imports-by-register are not exercised by this suite today
    // (harness/README: "unused by this suite"); recorded, not wired into
    // host import resolution.
    this.#registered.set(as, instance as AnyInstanceRef);
    return Promise.resolve();
  }

  async invoke(
    target: InstanceRef | undefined,
    field: string,
    args: Value[],
  ): Promise<InvokeOutcome> {
    const ref = this.#requireInstance(target);
    if (ref.kind === "module") return this.#core.invoke();
    const fn = ref.handle.exports[field];
    if (typeof fn !== "function") {
      throw new Error(`no export function '${field}'`);
    }
    const hostArgs = args.map(toComponentValue);
    let raw: unknown;
    try {
      raw = (fn as (...a: unknown[]) => unknown)(...hostArgs);
      // JSPI-mode instantiations promising-wrap suspension-capable entries,
      // so exports return Promises (WebAssembly.promising always does —
      // runtime/tests/jspi pin (e)). Await inside the try: post-resume traps
      // arrive as REJECTIONS carrying the same Trap/error classes the sync
      // path throws, and must map to the same outcomes.
      if (raw instanceof Promise) raw = await raw;
    } catch (e) {
      if (e instanceof Trap) {
        return { kind: "trapped", message: e.message };
      }
      if (e instanceof AssertionError || e instanceof NotImplemented) {
        asCapabilityOrRethrow(e, `invoke '${field}'`);
      }
      throw e;
    }
    // Validates the observed shape against the declared arity and throws
    // loudly on mismatch instead of discarding/coercing (issue #188).
    const values = collapseResultsByArity(raw, ref.arities.get(field), field);
    return { kind: "returned", values };
  }

  get(target: InstanceRef | undefined, field: string): Promise<InvokeOutcome> {
    const ref = this.#requireInstance(target);
    if (ref.kind === "module") return this.#core.get();
    // Components have no `get` action in this suite (globals are a core
    // wast concept); decline honestly rather than guess a shape.
    throw new PendingRuntimeError(`get '${field}' on a component instance`);
  }

  reset(): void {
    this.#definitions = [];
    this.#namedDefinitions.clear();
    this.#registered.clear();
    this.#core.reset();
  }

  #requireInstance(target: InstanceRef | undefined): AnyInstanceRef {
    if (target === undefined) throw new Error("no current instance");
    return target as AnyInstanceRef;
  }
}
