// JSON command runner: executes one testgen-generated command file against a
// CommandExecutor, classifying every command as passed / failed / skipped.

import type { Action, ArtifactRef, Command, Kind, WastJson } from "./schema.ts";
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
    bytes[4] === 0x01 && bytes[5] === 0x00 && bytes[6] === 0x00 &&
    bytes[7] === 0x00;
  return isModule ? "module" : "component";
}

/**
 * `pending-capability` is a precise, named-in-report subset of
 * `pending-runtime`: the executor understood the command but a specific
 * runtime feature it needs (e.g. shared-everything threads) is unsupported.
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
            : (outcome.values.length === 1
              ? outcome.values[0]
              : outcome.values),
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
          if (e instanceof TrapError) {
            if (!trapMatches(command.text, e.message)) {
              throw new Error(
                `expected instantiation trap "${command.text}", got "${e.message}"`,
              );
            }
            return undefined;
          }
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
          if (e instanceof LinkError) {
            if (!trapMatches(command.text, e.message)) {
              throw new Error(
                `expected link error "${command.text}", got "${e.message}"`,
              );
            }
            return undefined;
          }
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
 * substring against the actual message. Our runtime's trap wording
 * (runtime/src/cabi, runtime/src/exec) was ported/written independently of
 * the suite's expected strings and is semantically correct but differently
 * worded in several spots (confirmed against `trapIf(...)` call sites) —
 * these exact pairs are recognized here rather than left as false failures.
 * A message pair not in this table falls back to plain substring matching, as
 * ordinary WAST assertions require. Exact equality prevents an equivalence
 * for one operation from accepting a diagnostic which merely contains it,
 * notably a later refusal carrying the original trap as its poison cause.
 *
 * Rows also cover engine-worded *core*-wasm traps: `mapCoreException` in
 * runtime/src/exec/boundary.ts passes a `WebAssembly.RuntimeError`'s message
 * through untouched (`guest trapped: <engine text>`) rather than translating
 * it to wasmtime's wording, so each JS engine's own spelling of a given trap
 * (V8/SpiderMonkey/JSC differ, e.g. for `unreachable`) is normalized here
 * against the suite's expected (typically wasmtime-worded) text instead.
 */
const TRAP_MESSAGE_EQUIVALENTS: Array<
  [exactExpected: string, exactActuals: string[]]
> = [
  // Official resources/handle-table.wast:201-213,261,293. Table.get emits
  // one of these two exact diagnostics (runtime/src/cabi/handles.ts:33-38).
  ["unknown handle index 5", ["table index out of range"]],
  [
    "unknown handle index 1",
    ["table index out of range", "table entry empty"],
  ],
  ["unknown handle index 0", ["table entry empty"]],
  ["unknown handle index 4294967295", ["table index out of range"]],
  // async/passing-resources.wast:176 reaches an allocated-then-empty slot 3.
  [
    "unknown handle index 3",
    ["table index out of range", "table entry empty"],
  ],
  // Pinned Wasmtime resources.wast:296,338,379,435,531,597,665 uses the
  // exact generic category for both never-allocated and vacated entries.
  ["unknown handle index", ["table index out of range", "table entry empty"]],
  // Pinned Wasmtime resources.wast:459-481 passes literal slot 2 to the
  // outer component's empty table; Table.get rejects it as out of range.
  ["unknown handle index 2", ["table index out of range"]],
  // Pinned Wasmtime resources.wast:927 and definitions.py lift_own
  // (third_party/component-model/design/mvp/canonical-abi/definitions.py:1482).
  ["cannot remove owned resource while borrowed", ["handle still lent out"]],
  // Pinned Wasmtime strings.wast:21,23 and definitions.py
  // load_string_from_range (definitions.py:1395).
  ["string pointer not aligned to 2", ["misaligned string pointer"]],
  // Pinned Wasmtime resources.wast:167,174. The executor emits these only
  // from its dedicated host-resource import type verdict.
  [
    "was not found",
    [
      "host import 'host/missing' must be a HostResourceType (the component imports a resource type); got undefined",
    ],
  ],
  [
    "expected resource found func",
    [
      "host import 'host/return-three' must be a HostResourceType (the component imports a resource type); got a function",
    ],
  ],
  // Official resources/handle-table.wast:322,324 and the corresponding
  // resource-type checks in runtime/src/cabi/handles.ts:239-263.
  [
    "handle index 1 used with the wrong type, expected guest-defined resource but found a different guest-defined resource",
    ["resource type mismatch"],
  ],
  // async/builtin-trap-poisons-instance.wast:9 assert_trap "wasm trap: wasm
  // `unreachable` instruction executed" — core `unreachable` trap, raw engine
  // text via mapCoreException. V8 (Deno/Chromium): "unreachable"; SpiderMonkey
  // (Firefox): "unreachable executed"; JSC (WebKit): "Unreachable code should
  // not be executed" (capitalized — substring matching alone would miss it
  // against the lowercase expected text).
  [
    "wasm trap: wasm `unreachable` instruction executed",
    [
      "guest trapped: unreachable",
      "guest trapped: unreachable executed",
      "guest trapped: Unreachable code should not be executed",
      "guest trapped: Unreachable code should not be executed (evaluating 'fn()')",
      "guest trapped: Unreachable code should not be executed (evaluating 'fn(...args)')",
    ],
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
    [
      "guest trapped: Unreachable code should not be executed",
      "guest trapped: Unreachable code should not be executed (evaluating 'fn()')",
      "guest trapped: Unreachable code should not be executed (evaluating 'fn(...args)')",
    ],
  ],
  // Wasmtime's supplementary corpus uses the bare canonical core-trap name
  // (crates/environ/src/trap_encoding.rs:138), unlike the official corpus's
  // longer form above. The runtime still exposes raw engine text through
  // mapCoreException, so this is the same core `unreachable` operation.
  [
    "wasm `unreachable` instruction executed",
    [
      "guest trapped: unreachable",
      "guest trapped: unreachable executed",
      "guest trapped: Unreachable code should not be executed",
      "guest trapped: Unreachable code should not be executed (evaluating 'fn()')",
      "guest trapped: Unreachable code should not be executed (evaluating 'fn(...args)')",
    ],
  ],
  // definitions.py:2344-2355 gives inc-at-2^16 and dec-below-zero the same
  // trap operation. Pinned Wasmtime deliberately names that shared category
  // BackpressureOverflow (crates/environ/src/trap_encoding.rs:254-256).
  ["backpressure counter overflow", ["backpressure counter underflow"]],
  // definitions.py:2445-2452 rejects exactly resolve_delivered(); these are
  // the pinned Wasmtime category and runtime call-site spellings for it.
  [
    "`subtask.cancel` called after terminal status delivered",
    ["subtask.cancel on a subtask whose resolution was already delivered"],
  ],
  // definitions.py:2512,2566,2618 has one condition for a synchronous
  // read/write/cancel on an end in a waitable set. Keep the runtime spellings
  // explicit so unrelated synchronous-operation diagnostics cannot match.
  [
    "waitable cannot be used synchronously while added to a waitable set",
    [
      "future.cancel-write: synchronous cancel on an end that is in a waitable set",
      "future.cancel-read: synchronous cancel on an end that is in a waitable set",
      "stream.cancel-write: synchronous cancel on an end that is in a waitable set",
      "stream.cancel-read: synchronous cancel on an end that is in a waitable set",
      "synchronous future copy on an end that is in a waitable set",
      "synchronous stream copy on an end that is in a waitable set",
    ],
  ],
  // Pinned Wasmtime's guest_read/guest_write terminal-state checks
  // (futures_and_streams.rs:3512-3514,3757-3759) and the runtime's CopyState.DONE
  // checks (runtime/src/intrinsics/stream_builtins.ts:156-161) are identical;
  // only the preposition differs. Do not include the future-write OR-category,
  // whose message combines a successful prior write with peer drop.
  [
    "cannot read after being notified that the writable end dropped",
    ["cannot read from stream after being notified that the writable end dropped"],
  ],
  [
    "cannot write after being notified that the readable end dropped",
    ["cannot write to stream after being notified that the readable end dropped"],
  ],
  // Pinned Wasmtime task-return-traps.wast uses these umbrella diagnostics.
  // The runtime reports the precise reference-state check which fired. Each
  // pair is exact so unrelated task lifecycle failures remain mismatches.
  [
    "async-lifted export failed to produce a result",
    ["task finished all threads without resolving"],
  ],
  [
    "invalid `task.return` signature and/or options for current task",
    [
      "task.return with a result type that is not the task's result type",
      "task.return with canonical options differing from the task's",
    ],
  ],
  // The same-instance non-numeric guard is the exact check on both sides:
  // runtime/src/task/streams.ts:587-591,708-711,725-728 and pinned Wasmtime
  // futures_and_streams.rs:3330-3335. Future/stream names are diagnostic only.
  [
    "cannot read from and write to intra-component future/stream with non-numeric payload",
    [
      "cannot read from and write to intra-component future",
      "cannot read from and write to intra-component stream",
    ],
  ],
];

// Exported for the unit-test suite (tests/runner_unit_test.ts) to pin the
// engine-spelling rows directly, rather than only indirectly via a full
// assert_trap command.
export function trapMatches(expected: string, actual: string): boolean {
  if (actual.includes(expected)) return true;
  for (const [exactExpected, exactActuals] of TRAP_MESSAGE_EQUIVALENTS) {
    if (expected === exactExpected && exactActuals.includes(actual)) {
      return true;
    }
  }
  return false;
}
