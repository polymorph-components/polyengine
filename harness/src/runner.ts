// JSON command runner: executes one testgen-generated command file against a
// CommandExecutor, classifying every command as passed / failed / skipped.

import type {
  Action,
  ArtifactRef,
  Command,
  Kind,
  WastJson,
} from "./schema.ts";
import {
  type Artifact,
  type CommandExecutor,
  type InstanceRef,
  type InvokeOutcome,
  LinkError,
  PendingRuntimeError,
  TrapError,
} from "./executor.ts";
import { compareValues as compareComponentValues } from "./value-mapping.ts";

/**
 * Sniffs the binary preamble to classify an artifact — upstream's JSON
 * carries no `kind` field, only `filename`/`module_type`/`binary_filename`
 * (json-from-wast's `WasmFile`). Only the unambiguous core-module preamble
 * (`\0asm` + version `01 00 00 00`) returns "module"; everything else,
 * including bytes that are not a valid preamble at all, is handed to the
 * component pipeline — the strict one, which rejects garbage, and also
 * where the suite's assert_malformed `(component binary ...)` cases belong.
 * Residual: a `(component binary ...)` whose bytes happen to be a valid core
 * preamble would be misclassified as a module and fail visibly (the
 * component pipeline never even sees it) — the suite has no such case.
 */
export function artifactKind(bytes: Uint8Array): Kind {
  const isModule = bytes.length >= 8 &&
    bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 &&
    bytes[3] === 0x6d &&
    bytes[4] === 0x01 && bytes[5] === 0x00 && bytes[6] === 0x00 && bytes[7] === 0x00;
  return isModule ? "module" : "component";
}

/**
 * `pending-capability` is a precise, named-in-report subset of
 * `pending-runtime`: the executor understood the command but a specific
 * runtime feature it needs (e.g. async/streams) does not exist yet.
 * `PendingRuntimeError` messages prefixed `pending-capability: ` are
 * classified this way (see `RuntimeExecutor`).
 */
export type SkipReason =
  | "pending-runtime"
  | "pending-capability"
  | "unsupported-directive";

export interface CommandResult {
  line: number;
  type: string;
  status: "passed" | "failed" | "skipped";
  /** Set when status === "skipped". */
  reason?: SkipReason;
  detail?: string;
}

export interface FileResult {
  source: string;
  results: CommandResult[];
}

/** Reads an artifact file referenced by a command file. */
export type ArtifactLoader = (
  filename: string,
) => Promise<Uint8Array<ArrayBuffer>>;

export async function runWastJson(
  doc: WastJson,
  loadArtifact: ArtifactLoader,
  executor: CommandExecutor,
): Promise<FileResult> {
  const runner = new FileRunner(loadArtifact, executor);
  const results: CommandResult[] = [];
  try {
    for (const command of doc.commands) {
      results.push(await runner.run(command));
    }
  } finally {
    executor.reset();
  }
  return { source: doc.source_filename, results };
}

class FileRunner {
  /** Named instances created so far in this file. */
  instances = new Map<string, InstanceRef>();
  /** Default target for actions: the most recent instantiation. */
  current: InstanceRef | undefined;

  constructor(
    readonly loadArtifact: ArtifactLoader,
    readonly executor: CommandExecutor,
  ) {}

  async run(command: Command): Promise<CommandResult> {
    const base = { line: command.line, type: command.type };
    try {
      const detail = await this.dispatch(command);
      return { ...base, status: "passed", ...(detail ? { detail } : {}) };
    } catch (e) {
      if (e instanceof PendingRuntimeError) {
        const capabilityPrefix = "pending-capability: ";
        const reason: SkipReason = e.message.startsWith(capabilityPrefix)
          ? "pending-capability"
          : "pending-runtime";
        return {
          ...base,
          status: "skipped",
          reason,
          detail: e.message,
        };
      }
      if (e instanceof UnsupportedDirective) {
        return {
          ...base,
          status: "skipped",
          reason: "unsupported-directive",
          detail: e.message,
        };
      }
      return { ...base, status: "failed", detail: String(e) };
    }
  }

  /** Returns an optional pass detail; throws on failure/skip. */
  async dispatch(command: Command): Promise<string | undefined> {
    switch (command.type) {
      case "module": {
        const artifact = await this.artifact(command);
        // A failed/skipped instantiation must not leave a stale "current
        // instance" (or stale name binding) for follow-up asserts to
        // silently target — observed producing a fake wrong-value symptom
        // at values/post-return.wast:358, where an assert read the
        // *previous* component's export. Invalidate first, bind on success.
        this.current = undefined;
        if (command.name !== undefined) this.instances.delete(command.name);
        const ref = await this.executor.instantiate(artifact, "success");
        this.current = ref;
        if (command.name !== undefined) this.instances.set(command.name, ref);
        return undefined;
      }
      case "module_definition": {
        const artifact = await this.artifact(command);
        await this.executor.define(command.name, artifact);
        return undefined;
      }
      case "module_instance": {
        // Same stale-current hazard as "module" above.
        this.current = undefined;
        if (command.instance !== undefined) {
          this.instances.delete(command.instance);
        }
        const ref = await this.executor.instantiateDefinition(
          command.module,
          command.instance,
        );
        this.current = ref;
        if (command.instance !== undefined) {
          this.instances.set(command.instance, ref);
        }
        return undefined;
      }
      case "register": {
        const target = command.name === undefined
          ? this.current
          : this.instances.get(command.name);
        await this.executor.register(command.as, target);
        return undefined;
      }
      case "action": {
        const outcome = await this.action(command.action);
        if (outcome.kind === "trapped") {
          throw new Error(`action trapped: ${outcome.message}`);
        }
        return undefined;
      }
      case "assert_return": {
        const outcome = await this.action(command.action);
        if (outcome.kind === "trapped") {
          throw new Error(`expected return, got trap: ${outcome.message}`);
        }
        const mismatch = compareComponentValues(
          command.expected,
          outcome.values.length === 0
            ? undefined
            : (outcome.values.length === 1 ? outcome.values[0] : outcome.values),
        );
        if (mismatch !== undefined) throw new Error(mismatch);
        return undefined;
      }
      case "assert_trap": {
        const outcome = await this.action(command.action);
        if (outcome.kind !== "trapped") {
          throw new Error(`expected trap "${command.text}", got return`);
        }
        if (!trapMatches(command.text, outcome.message)) {
          throw new Error(
            `expected trap "${command.text}", got "${outcome.message}"`,
          );
        }
        return undefined;
      }
      case "assert_exhaustion":
      case "assert_exception":
      case "assert_suspension":
        // Not used by the component-model suite; revisit when a suite needs
        // them rather than guessing semantics now.
        throw new UnsupportedDirective(command.type);
      case "assert_invalid":
      case "assert_malformed": {
        // The JS API cannot distinguish malformed from invalid, and neither
        // can a black-box runtime verdict; both accept "not valid".
        const artifact = await this.artifact(command);
        const { valid } = await this.executor.validate(artifact);
        if (valid) {
          throw new Error(
            `expected ${command.type} ("${command.text}"), but it validated`,
          );
        }
        return undefined;
      }
      case "assert_uninstantiable": {
        const artifact = await this.artifact(command);
        try {
          await this.executor.instantiate(artifact, "trap");
        } catch (e) {
          if (e instanceof TrapError) return undefined;
          throw e;
        }
        throw new Error(
          `expected instantiation trap "${command.text}", but it instantiated`,
        );
      }
      case "assert_unlinkable": {
        const artifact = await this.artifact(command);
        try {
          await this.executor.instantiate(artifact, "link-error");
        } catch (e) {
          if (e instanceof LinkError) return undefined;
          throw e;
        }
        throw new Error(
          `expected link error "${command.text}", but it instantiated`,
        );
      }
      default:
        // Future/unknown command types (e.g. assert_invalid_custom).
        throw new UnsupportedDirective(
          `unknown command type: ${(command as { type: string }).type}`,
        );
    }
  }

  async artifact(ref: ArtifactRef): Promise<Artifact> {
    if (ref.module_type === "text") {
      // Only `(... quote ...)` forms whose malformedness lives at the text
      // level; executable only by a host with a text parser.
      throw new UnsupportedDirective(`text artifact ${ref.filename}`);
    }
    const bytes = await this.loadArtifact(ref.filename);
    return {
      filename: ref.filename,
      kind: artifactKind(bytes),
      moduleType: ref.module_type,
      bytes,
    };
  }

  action(action: Action): Promise<InvokeOutcome> {
    const target = action.module === undefined
      ? this.current
      : this.instances.get(action.module);
    if (action.type === "invoke") {
      return this.executor.invoke(target, action.field, action.args);
    }
    return this.executor.get(target, action.field);
  }
}

class UnsupportedDirective extends Error {}

/**
 * Trap-message matching: official interpreters compare expected wast text by
 * prefix/substring against the actual message. Our runtime's trap wording
 * (runtime/src/cabi, runtime/src/exec) was ported/written independently of
 * the suite's expected strings and is semantically correct but differently
 * worded in several spots (confirmed against `trapIf(...)` call sites) —
 * these pairs are normalized here rather than left as false failures. A
 * message pair not in this table falls back to plain substring matching, so
 * new/incidental wording matches keep working without a table entry.
 *
 * Rows also cover engine-worded *core*-wasm traps: `mapCoreException` in
 * runtime/src/exec/boundary.ts passes a `WebAssembly.RuntimeError`'s message
 * through untouched (`guest trapped: <engine text>`) rather than translating
 * it to wasmtime's wording, so each JS engine's own spelling of a given trap
 * (V8/SpiderMonkey/JSC differ, e.g. for `unreachable`) is normalized here
 * against the suite's expected (typically wasmtime-worded) text instead.
 */
const TRAP_MESSAGE_EQUIVALENTS: Array<[expectedPrefix: string, actualSubstrings: string[]]> = [
  // resources/handle-table.wast: runtime/src/cabi/handles.ts Table.get/free.
  ["unknown handle index", ["table index out of range", "table entry empty"]],
  // resources/handle-table.wast: runtime/src/cabi/handles.ts lift/lowerOwn
  // /Borrow resource-type checks (4 call sites, identical message).
  [
    "handle index",
    ["resource type mismatch"], // "... used with the wrong type, expected ..."
  ],
  // async/builtin-trap-poisons-instance.wast:9 assert_trap "wasm trap: wasm
  // `unreachable` instruction executed" — core `unreachable` trap, raw engine
  // text via mapCoreException. V8 (Deno/Chromium): "unreachable"; SpiderMonkey
  // (Firefox): "unreachable executed"; JSC (WebKit): "Unreachable code should
  // not be executed" (capitalized — substring matching alone would miss it
  // against the lowercase expected text).
  [
    "wasm trap: wasm `unreachable` instruction executed",
    ["unreachable", "unreachable executed", "Unreachable code should not be executed"],
  ],
  // async/big-interleaving-test.wast:836 asserts the SHORT form, plain
  // "unreachable". V8's and SpiderMonkey's spellings contain it as a
  // lowercase substring (fast path), but JSC capitalizes — verified against
  // a webkit-2342 (multi-memory-enabled) lane run, where this command is the
  // one wording residual the row above does not reach (its prefix is the
  // long form). Without this row the WebKit overlay cannot collapse to
  // empty at the playwright pin bump (polyengine#11).
  [
    "unreachable",
    ["Unreachable code should not be executed"],
  ],
];

// Exported for the unit-test suite (tests/runner_unit_test.ts) to pin the
// engine-spelling rows directly, rather than only indirectly via a full
// assert_trap command.
export function trapMatches(expected: string, actual: string): boolean {
  if (actual.includes(expected)) return true;
  for (const [prefix, actuals] of TRAP_MESSAGE_EQUIVALENTS) {
    if (expected.startsWith(prefix) && actuals.some((a) => actual.includes(a))) {
      return true;
    }
  }
  return false;
}
