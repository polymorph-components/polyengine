// Command executor: the contract between the conformance runner and a
// (current or future) Component Model runtime.
//
// ============================ PROVISIONAL ============================
// This interface is a sketch of what the polyengine runtime must
// eventually implement. It exists so the runner can be written today and so
// the runtime work has a concrete target. Expect it to grow (async task
// options, deterministic scheduler knobs, resource-table introspection) and
// change shape as the runtime lands. Nothing outside harness/ implements it
// yet.
// =====================================================================

import type { Kind, ModuleType, Value } from "./schema.ts";

/** An artifact extracted by testgen, loaded into memory (`kind` is derived
 * by the runner at load time via `artifactKind`, not carried in the JSON). */
export interface Artifact {
  filename: string;
  kind: Kind;
  moduleType: ModuleType;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Opaque handle to an instantiated module/component. */
export interface InstanceRef {
  readonly kind: Kind;
}

/**
 * Result of invoking an exported function. `values` holds the *runtime's*
 * host-side value representation (e.g. `ComponentValue` for a component,
 * definitions.py shapes — see runtime/src/cabi/types.ts), one entry per
 * result, by arity — NOT the wast-JSON `Value` schema. `src/value-mapping.ts`
 * converts against an `assert_return`'s expected `Value[]` for comparison.
 */
export type InvokeOutcome =
  // deno-lint-ignore no-explicit-any
  | { kind: "returned"; values: any[] }
  | { kind: "trapped"; message: string };

/** What an instantiation is expected to do — lets a partial executor decline
 * verdicts it cannot honestly deliver (e.g. the core-only stub can validate
 * a module but cannot judge link/instantiation failure). */
export type InstantiateExpectation = "success" | "trap" | "link-error";

/** Thrown by executor methods for operations that need the not-yet-written
 * component runtime; the runner records skip("pending-runtime"). */
export class PendingRuntimeError extends Error {
  constructor(operation: string) {
    super(`pending component runtime: ${operation}`);
    this.name = "PendingRuntimeError";
  }
}

/** Instantiation failed by trapping (start function, etc.). */
export class TrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrapError";
  }
}

/** Instantiation failed at link time. */
export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

/**
 * The command executor a runtime must provide.
 *
 * State model (mirrors wast semantics): the executor owns all definitions,
 * instances, and registrations for ONE .wast file; the runner calls
 * `reset()` between files. The runner tracks which `InstanceRef` is the
 * "current" action target and passes it explicitly.
 */
export interface CommandExecutor {
  /**
   * Decode + validate a binary. Must return a verdict rather than throw for
   * invalid/malformed input. (Distinguishing malformed from invalid is not
   * required — the JS WebAssembly API cannot — so both assert_malformed and
   * assert_invalid accept `valid === false`.)
   */
  validate(artifact: Artifact): Promise<{ valid: boolean; error?: string }>;

  /**
   * Define, validate, and instantiate a top-level module/component
   * (`module` command, or the assert_uninstantiable/assert_unlinkable
   * checks when `expect` != "success").
   * Throws TrapError / LinkError for expected-failure cases, or
   * PendingRuntimeError if the executor cannot deliver the verdict.
   */
  instantiate(
    artifact: Artifact,
    expect: InstantiateExpectation,
  ): Promise<InstanceRef>;

  /** Define + validate a `module_definition` (no instantiation). */
  define(name: string | undefined, artifact: Artifact): Promise<void>;

  /**
   * Instantiate a previously defined module/component (`module_instance`).
   * `defName` absent = most recent definition.
   */
  instantiateDefinition(
    defName: string | undefined,
    instanceName: string | undefined,
  ): Promise<InstanceRef>;

  /** Make an instance's exports importable under `as` (core `register`). */
  register(as: string, instance: InstanceRef | undefined): Promise<void>;

  /** Invoke an exported function. Traps are reported as an outcome, not an
   * exception. */
  invoke(
    target: InstanceRef | undefined,
    field: string,
    args: Value[],
  ): Promise<InvokeOutcome>;

  /** Read an exported global (core `get` action). */
  get(target: InstanceRef | undefined, field: string): Promise<InvokeOutcome>;

  /** Drop all per-file state. */
  reset(): void;
}

/**
 * The executor available today: core modules are validated/compiled with the
 * JS WebAssembly API; every component-layer operation and every operation
 * requiring instantiation/linking throws PendingRuntimeError.
 *
 * Note V8 cannot validate component binaries at all — a component's version/
 * layer preamble (`0d 00 01 00`) is a CompileError for the core API, so
 * `WebAssembly.validate` returns false for VALID components too. That layer
 * is exactly what polyengine will implement; until then no component
 * verdict can come from the JS API.
 */
export class CoreOnlyExecutor implements CommandExecutor {
  validate(artifact: Artifact): Promise<{ valid: boolean; error?: string }> {
    if (artifact.kind !== "module") {
      throw new PendingRuntimeError(`validate ${artifact.kind}`);
    }
    // WebAssembly.validate gives no error message; try a sync compile to
    // recover one (test artifacts are small).
    if (WebAssembly.validate(artifact.bytes)) {
      return Promise.resolve({ valid: true });
    }
    let error = "invalid module";
    try {
      new WebAssembly.Module(artifact.bytes);
    } catch (e) {
      error = String(e);
    }
    return Promise.resolve({ valid: false, error });
  }

  async instantiate(
    artifact: Artifact,
    expect: InstantiateExpectation,
  ): Promise<InstanceRef> {
    if (artifact.kind !== "module") {
      throw new PendingRuntimeError(`instantiate ${artifact.kind}`);
    }
    if (expect !== "success") {
      // Judging instantiation *failure* needs import resolution and start
      // semantics; declining is more honest than guessing.
      throw new PendingRuntimeError("judge instantiation failure of module");
    }
    // Executable subset of the `module` command: decode, validate, compile.
    // Actual instantiation (imports, start) is deferred to the runtime, so
    // any later invoke on this instance is declined.
    const { valid, error } = await this.validate(artifact);
    if (!valid) {
      throw new TrapError(`module failed validation: ${error}`);
    }
    await WebAssembly.compile(
      // Copy: WebAssembly.compile requires a non-shared plain buffer.
      new Uint8Array(artifact.bytes),
    );
    return { kind: "module" };
  }

  define(_name: string | undefined, artifact: Artifact): Promise<void> {
    if (artifact.kind !== "module") {
      throw new PendingRuntimeError(`define ${artifact.kind}`);
    }
    return this.validate(artifact).then(({ valid, error }) => {
      if (!valid) throw new TrapError(`definition failed validation: ${error}`);
    });
  }

  instantiateDefinition(): Promise<InstanceRef> {
    throw new PendingRuntimeError("instantiate definition");
  }

  register(): Promise<void> {
    throw new PendingRuntimeError("register");
  }

  invoke(): Promise<InvokeOutcome> {
    throw new PendingRuntimeError("invoke export");
  }

  get(): Promise<InvokeOutcome> {
    throw new PendingRuntimeError("get global");
  }

  reset(): void {}
}
