// JSON schema for testgen-generated command files (see harness/README.md).
// Mirrors the subset of upstream `json-from-wast`'s schema (the
// `wasm-tools json-from-wast` subcommand) this suite exercises — no local
// extensions. Authority: `json-from-wast-0.258.0/src/lib.rs`
// (Command/WasmFile/Action/CoreConst/ComponentConst serde derives).

/** Layer of an extracted artifact, sniffed from the binary preamble at load
 * time (upstream's JSON carries no `kind` field — see `runner.ts`
 * `artifactKind`). */
export type Kind = "module" | "component";

/** Artifact file flavor: `.wasm` binary or raw `.wat` text. */
export type ModuleType = "binary" | "text";

export interface WastJson {
  source_filename: string;
  commands: Command[];
}

/** `WasmFile` (lib.rs): `#[serde(flatten)]`ed into artifact-bearing
 * commands. `binary_filename` is only present for quote forms that also
 * encode (never for `assert_malformed` quote forms). */
export interface ArtifactRef {
  filename: string;
  module_type: ModuleType;
  binary_filename?: string;
}

export interface ModuleCommand extends ArtifactRef {
  type: "module";
  line: number;
  name?: string;
}

export interface ModuleDefinitionCommand extends ArtifactRef {
  type: "module_definition";
  line: number;
  name?: string;
}

export interface ModuleInstanceCommand {
  type: "module_instance";
  line: number;
  instance?: string;
  /** Definition to instantiate; absent = most recent definition. */
  module?: string;
}

export interface RegisterCommand {
  type: "register";
  line: number;
  as: string;
  name?: string;
}

export interface ActionCommand {
  type: "action";
  line: number;
  action: Action;
}

export interface AssertReturnCommand {
  type: "assert_return";
  line: number;
  action: Action;
  expected: Value[];
}

export interface AssertTrapCommand {
  type: "assert_trap";
  line: number;
  action: Action;
  text: string;
}

export interface AssertExhaustionCommand {
  type: "assert_exhaustion";
  line: number;
  action: Action;
  text: string;
}

export interface AssertExceptionCommand {
  type: "assert_exception";
  line: number;
  action: Action;
}

export interface AssertSuspensionCommand {
  type: "assert_suspension";
  line: number;
  action: Action;
  text: string;
}

export interface AssertInvalidCommand extends ArtifactRef {
  type: "assert_invalid";
  line: number;
  text: string;
}

export interface AssertMalformedCommand extends ArtifactRef {
  type: "assert_malformed";
  line: number;
  text: string;
}

export interface AssertUninstantiableCommand extends ArtifactRef {
  type: "assert_uninstantiable";
  line: number;
  text: string;
}

export interface AssertUnlinkableCommand extends ArtifactRef {
  type: "assert_unlinkable";
  line: number;
  text: string;
}

export type Command =
  | ModuleCommand
  | ModuleDefinitionCommand
  | ModuleInstanceCommand
  | RegisterCommand
  | ActionCommand
  | AssertReturnCommand
  | AssertTrapCommand
  | AssertExhaustionCommand
  | AssertExceptionCommand
  | AssertSuspensionCommand
  | AssertInvalidCommand
  | AssertMalformedCommand
  | AssertUninstantiableCommand
  | AssertUnlinkableCommand;

export interface InvokeAction {
  type: "invoke";
  /** Named instance to invoke on; absent = current default instance. */
  module?: string;
  field: string;
  args: Value[];
}

export interface GetAction {
  type: "get";
  module?: string;
  field: string;
}

export type Action = InvokeAction | GetAction;

/**
 * A component-model value (`ComponentConst`, `#[serde(tag="type",
 * content="value")]`, lib.rs). This is the only `Const` variant this harness
 * executes today (see `CoreValue` below for the executed subset of the
 * core-wasm side of the untagged `Const` union).
 */
export type ComponentValue =
  | { type: "bool"; value: boolean }
  | { type: "u8" | "s8" | "u16" | "s16" | "u32" | "s32" | "u64" | "s64"; value: string }
  | { type: "f32" | "f64"; value: string }
  | { type: "char" | "string" | "enum"; value: string }
  | { type: "list" | "tuple"; value: Value[] }
  | { type: "record"; value: [name: string, value: Value][] }
  | { type: "variant"; value: { case: string; payload?: Value } }
  | { type: "option"; value: Value | null }
  | { type: "result"; value: { Ok: Value | null } | { Err: Value | null } }
  | { type: "flags"; value: string[] };

/**
 * The executed subset of `CoreConst` (`#[serde(tag="type",
 * rename_all="lowercase")]`, lib.rs): plain numeric/float scalars. The
 * harness does not execute core-wasm actions with ref-typed
 * (funcref/externref/anyref/v128/...) arguments or results — keep parity
 * with today's supported set, do not expand without a corpus need.
 */
export type CoreValue =
  | { type: "i32" | "i64"; value: string }
  | { type: "f32" | "f64"; value: string };

/** Untagged `Const` union (lib.rs): `Core(CoreConst) | Component(ComponentConst)`. */
export type Value = CoreValue | ComponentValue;
