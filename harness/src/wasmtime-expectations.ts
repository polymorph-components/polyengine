export interface WasmtimeExpectation {
  file: string;
  line: number;
  cause: string;
  class: string;
  status: "failed" | "skipped";
}

export interface WasmtimeExpectationGroup {
  class: string;
  files: Array<{
    file: string;
    rows: Array<{
      lines: number[];
      cause: string;
      status: "failed" | "skipped";
    }>;
  }>;
}

export interface WasmtimeFailureClass {
  reason: string;
  issue: string;
}

export const WASMTIME_FAILURE_CLASSES: Readonly<
  Record<string, WasmtimeFailureClass>
> = {
  "runtime-semantics": {
    reason: "runtime result or state differs from the WAST assertion",
    issue: "https://github.com/polymorph-components/polyengine/issues/372",
  },
  "diagnostic-mismatch": {
    reason: "trap diagnostics have not been proved equivalent",
    issue: "https://github.com/polymorph-components/polyengine/issues/372",
  },
  "imported-module": {
    reason: "plan v0 cannot instantiate an imported core module",
    issue: "https://github.com/polymorph-components/polyengine/issues/372",
  },
  "provider-control": {
    reason: "Wasmtime-native test control is unavailable and is not emulated",
    issue: "https://github.com/polymorph-components/polyengine/issues/372",
  },
  "exception-handling": {
    reason:
      "WebAssembly exception behavior is not represented by the harness verdict",
    issue: "https://github.com/polymorph-components/polyengine/issues/372",
  },
  "cascade": {
    reason: "command has no current instance after its owning setup failure",
    issue: "https://github.com/polymorph-components/polyengine/issues/372",
  },
};

export const WASMTIME_EXPECTATION_GROUPS: readonly WasmtimeExpectationGroup[] =
  [
    {
      class: "cascade",
      files: [
        {
          file: "alias-region-reexported-entities-to-imported-module.json",
          rows: [{
            lines: [101, 102, 103],
            cause: "Error: no current instance",
            status: "failed",
          }],
        },
        {
          file: "async/cancel-starting-subtask-does-not-leak.json",
          rows: [{
            lines: [103],
            cause: "Error: no current instance",
            status: "failed",
          }],
        },
      ],
    },
    {
      class: "diagnostic-mismatch",
      files: [
        {
          file: "async/stream-cancel-finished-op.json",
          rows: [{
            lines: [247, 249, 251],
            cause:
              'Error: expected trap "cannot write after being notified that the readable end dropped", got "cannot write to future after previous write succeeded or readable end dropped"',
            status: "failed",
          }],
        },
        {
          file: "async/trap-if-done.json",
          rows: [{
            lines: [599, 601, 603, 605, 608, 610, 612, 614],
            cause:
              'Error: expected trap "cannot write after being notified that the readable end dropped", got "cannot write to future after previous write succeeded or readable end dropped"',
            status: "failed",
          }],
        },
        {
          file: "resources.json",
          rows: [{
            lines: [927],
            cause:
              'Error: expected trap "cannot remove owned resource while borrowed", got "handle still lent out"',
            status: "failed",
          }],
        },
        {
          file: "strings.json",
          rows: [{
            lines: [21, 23],
            cause:
              'Error: expected trap "string pointer not aligned to 2", got "misaligned string pointer"',
            status: "failed",
          }],
        },
        {
          file: "types.json",
          rows: [{
            lines: [378],
            cause:
              'Error: expected trap "discriminant 2 out of range [0..2)", got "invalid variant discriminant"',
            status: "failed",
          }],
        },
      ],
    },
    {
      class: "imported-module",
      files: [
        {
          file: "alias-region-reexported-entities-to-imported-module.json",
          rows: [{
            lines: [14],
            cause:
              "TranslateError: translator error [unsupported]: imported-module instantiation (InstantiateModule::Import) is not supported in plan v0 (contracts/plan-format.md open items)",
            status: "failed",
          }],
        },
        {
          file: "instance.json",
          rows: [{
            lines: [216, 224],
            cause:
              "TranslateError: translator error [unsupported]: imported-module instantiation (InstantiateModule::Import) is not supported in plan v0 (contracts/plan-format.md open items)",
            status: "failed",
          }],
        },
        {
          file: "modules.json",
          rows: [{
            lines: [316, 417],
            cause:
              "TranslateError: translator error [unsupported]: imported-module instantiation (InstantiateModule::Import) is not supported in plan v0 (contracts/plan-format.md open items)",
            status: "failed",
          }],
        },
        {
          file: "nested.json",
          rows: [{
            lines: [149, 219],
            cause:
              "TranslateError: translator error [unsupported]: imported-module instantiation (InstantiateModule::Import) is not supported in plan v0 (contracts/plan-format.md open items)",
            status: "failed",
          }],
        },
      ],
    },
    {
      class: "provider-control",
      files: [
        {
          file: "async/cancel-starting-subtask-does-not-leak.json",
          rows: [{
            lines: [9],
            cause:
              "PlanError: host import 'wasmtime/set-max-table-capacity' not provided (no key 'wasmtime' in imports)",
            status: "failed",
          }],
        },
        {
          file: "instance.json",
          rows: [{
            lines: [287, 294, 301],
            cause:
              "PlanError: host import 'I1/r' not provided (no key 'I1' in imports)",
            status: "failed",
          }, {
            lines: [308, 315],
            cause:
              "PlanError: host import 'I2/r' not provided (no key 'I2' in imports)",
            status: "failed",
          }, {
            lines: [322],
            cause:
              "PlanError: host import 'I3/r' not provided (no key 'I3' in imports)",
            status: "failed",
          }],
        },
      ],
    },
    {
      class: "runtime-semantics",
      files: [
        {
          file: "import.json",
          rows: [{
            lines: [8],
            cause:
              "Error: expected instantiation link-error, but component instantiated successfully",
            status: "failed",
          }],
        },
        {
          file: "instance.json",
          rows: [{
            lines: [79],
            cause: "RuntimeError: unreachable",
            status: "failed",
          }],
        },
        {
          file: "linking.json",
          rows: [{
            lines: [2, 11, 14, 17],
            cause:
              "Error: expected instantiation link-error, but component instantiated successfully",
            status: "failed",
          }],
        },
        {
          file: "modules.json",
          rows: [{
            lines: [
              26,
              43,
              90,
              100,
              120,
              127,
              134,
              141,
              150,
              157,
              164,
              171,
              178,
              185,
              211,
              218,
              225,
              232,
              241,
              248,
              255,
              262,
              269,
              276,
            ],
            cause:
              "Error: expected instantiation link-error, but component instantiated successfully",
            status: "failed",
          }, {
            lines: [299],
            cause:
              "TranslateError: translator error [unsupported]: re-exporting an imported module is not supported (export 'm2'); module imports have no instantiation story yet (the Export::ModuleImport rejection, contracts/plan-format.md schema notes)",
            status: "failed",
          }],
        },
        {
          file: "resources.json",
          rows: [{
            lines: [167],
            cause:
              "PlanError: host import 'host/missing' must be a HostResourceType (the component imports a resource type); got undefined",
            status: "failed",
          }, {
            lines: [174],
            cause:
              "PlanError: host import 'host/return-three' must be a HostResourceType (the component imports a resource type); got a function",
            status: "failed",
          }, {
            lines: [201],
            cause:
              "Error: expected instantiation link-error, but component instantiated successfully",
            status: "failed",
          }],
        },
        {
          file: "types.json",
          rows: [{
            lines: [339],
            cause:
              "TranslateError: translator error [unsupported]: unsupported type export: component",
            status: "failed",
          }, {
            lines: [348],
            cause:
              "TranslateError: translator error [unsupported]: unsupported type export: instance",
            status: "failed",
          }],
        },
      ],
    },
  ] as const;

export const WASMTIME_EXPECTATIONS: readonly WasmtimeExpectation[] =
  WASMTIME_EXPECTATION_GROUPS.flatMap((group) =>
    group.files.flatMap((file) =>
      file.rows.flatMap((row) =>
        row.lines.map((line) => ({
          line,
          cause: row.cause,
          status: row.status,
          file: file.file,
          class: group.class,
        }))
      )
    )
  );

export const WASMTIME_SKIP_EXPECTATIONS: readonly WasmtimeExpectation[] = [];

export const WASMTIME_EXCLUSIONS: Readonly<Record<string, string>> = {
  "big-strings.json":
    "upstream ;;! hogs_memory=true; bounded gate excludes memory stress",
  "memory64.json":
    "upstream ;;! hogs_memory=true; bounded gate excludes memory stress",
  "async/streams-massive-send.json":
    "upstream memory stress cannot start reliably under a bounded V8 heap; not executed",
  "gc/empty.json":
    "upstream ;;! component_model_gc/gc=true; GC is feature-disabled",
  "implements-disabled.json":
    "upstream ;;! component_model_implements=false requests disabled validation, but translator configuration enables it",
};

export function expectedWasmtimeFailure(
  file: string,
  line: number,
  detail: string,
): WasmtimeExpectation | undefined {
  return WASMTIME_EXPECTATIONS.find((e) =>
    e.status === "failed" && e.file === file && e.line === line &&
    detail === e.cause
  );
}

export function expectedWasmtimeSkip(
  file: string,
  line: number,
  reason: string | undefined,
  detail: string,
): WasmtimeExpectation | undefined {
  return WASMTIME_SKIP_EXPECTATIONS.find((e) =>
    e.file === file && e.line === line && reason === "pending-runtime" &&
    detail === e.cause
  );
}
