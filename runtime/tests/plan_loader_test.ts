// Plan loader unit tests: formatVersion gating, envelope handling, and the
// wire -> in-memory descriptor-IR conversions (including the deliberate
// deltas recorded in src/plan/loader.ts).

import { assertEq } from "./support/asserts.ts";
import {
  loadEnvelope,
  resourceIndexOfDefined,
  TranslateError,
  loadPlan,
  loadValType,
  PlanError,
  SUPPORTED_FORMAT_VERSION,
} from "../src/plan/mod.ts";
import type { WirePlan, WireValType } from "../src/plan/mod.ts";
import { ResourceTypeInfo } from "../src/cabi/mod.ts";

function assertPlanError(fn: () => unknown, includes: string) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    assertEq(String(e).includes(includes), true, `message: ${e}`);
    return;
  }
  throw new Error(`expected PlanError containing '${includes}'`);
}

function minimalPlan(overrides: Partial<WirePlan> = {}): WirePlan {
  return {
    formatVersion: SUPPORTED_FORMAT_VERSION,
    producer: { shimVersion: "0", wasmtimeEnviron: "49.0.0-dev+4675ee1", features: [] },
    component: { sha256: "0".repeat(64), len: 0 },
    modules: [],
    initializers: [],
    trampolines: [],
    canonicalOptions: [],
    types: [],
    resourceTables: [],
    streamTables: [],
    futureTables: [],
    errorContextTables: [],
    imports: [],
    exports: [],
    worldDigest: "sha256:0",
    ...overrides,
  };
}

Deno.test("loader: formatVersion is validated and fails fast", () => {
  loadPlan(minimalPlan()); // the supported version loads
  // Both directions are rejected: an older producer (v0) and a newer one.
  assertPlanError(
    () => loadPlan(minimalPlan({ formatVersion: 0 })),
    "formatVersion 0",
  );
  assertPlanError(
    () => loadPlan(minimalPlan({ formatVersion: SUPPORTED_FORMAT_VERSION + 1 })),
    `formatVersion ${SUPPORTED_FORMAT_VERSION + 1}`,
  );
});

Deno.test("loader: envelope error and shape handling", () => {
  assertPlanError(() => loadEnvelope("not json"), "not valid JSON");
  assertPlanError(() => loadEnvelope(`{}`), "missing `plan`");
  const { wire, adapters } = loadEnvelope(JSON.stringify({
    plan: minimalPlan(),
    adapters: [{ file: "adapters/1.wasm", wasm: btoa("\x00asm") }],
  }));
  assertEq(wire.formatVersion, SUPPORTED_FORMAT_VERSION);
  assertEq(adapters.get("adapters/1.wasm"), new Uint8Array([0, 97, 115, 109]));
});

Deno.test("loader: func type conversion drops labels, keeps order", () => {
  const loaded = loadPlan(minimalPlan({
    types: [{
      kind: "func",
      params: [
        { label: "a", type: { kind: "u32" } },
        { label: "b", type: { kind: "string" } },
      ],
      results: [{ kind: "bool" }],
      async: false,
    }],
  }));
  const entry = loaded.types[0];
  assertEq(entry.kind, "func");
  if (entry.kind !== "func") throw new Error("unreachable");
  assertEq(entry.paramNames, ["a", "b"]);
  assertEq(entry.funcType.params, [{ kind: "u32" }, { kind: "string" }]);
  assertEq(entry.funcType.results, [{ kind: "bool" }]);
  assertEq(entry.funcType.async, false);
});

Deno.test("loader: result `err` (wire) becomes `error` (in-memory)", () => {
  const t = loadValType(
    { kind: "result", ok: { kind: "u32" }, err: { kind: "string" } },
    [],
    "test",
  );
  assertEq(t, {
    kind: "result",
    ok: { kind: "u32" },
    error: { kind: "string" },
  });
});

Deno.test("loader: own/borrow resolve resource-table tokens by identity", () => {
  const loaded = loadPlan(minimalPlan({
    resourceTables: [{ kind: "concrete", resource: 0, instance: 0 }],
    types: [
      { kind: "own", resource: 0 },
      { kind: "borrow", resource: 0 },
    ],
  }));
  const own = loaded.types[0];
  const borrow = loaded.types[1];
  if (own.kind !== "value" || borrow.kind !== "value") {
    throw new Error("expected value entries");
  }
  const ownRt = (own.type as { rt: ResourceTypeInfo }).rt;
  const borrowRt = (borrow.type as { rt: ResourceTypeInfo }).rt;
  assertEq(ownRt instanceof ResourceTypeInfo, true);
  assertEq(ownRt === borrowRt, true, "same table -> same identity token");
  assertEq(ownRt === loaded.resourceTokens[0], true);

  // Out-of-range table reference is a load-time error.
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        types: [{ kind: "own", resource: 3 } as WireValType],
      })),
    "resource table 3",
  );
});

Deno.test("loader: nested structural types convert recursively", () => {
  const wire: WireValType = {
    kind: "variant",
    cases: [
      { label: "none", type: null },
      {
        label: "some",
        type: {
          kind: "list",
          element: {
            kind: "record",
            fields: [{ label: "x", type: { kind: "option", type: { kind: "f64" } } }],
          },
        },
      },
    ],
  };
  const t = loadValType(wire, [], "test");
  assertEq(t, {
    kind: "variant",
    cases: [
      { label: "none", type: null },
      {
        label: "some",
        type: {
          kind: "list",
          element: {
            kind: "record",
            fields: [
              { label: "x", type: { kind: "option", type: { kind: "f64" } } },
            ],
          },
        },
      },
    ],
  });
});


// --- structured translation verdicts (contracts v0.2 proposal) -------------

Deno.test("loader: envelope errorDetail becomes a TranslateError with phase", () => {
  // A `validation` phase is the shim's judgment about the *component* — the
  // only verdict that satisfies assert_invalid / assert_malformed.
  try {
    loadEnvelope(JSON.stringify({
      error: "type mismatch",
      errorDetail: {
        phase: "validation",
        message: "type mismatch",
        detail: "type mismatch (at offset 0x1)",
      },
    }));
    throw new Error("expected TranslateError");
  } catch (e) {
    if (!(e instanceof TranslateError)) throw e;
    assertEq(e.phase, "validation");
    assertEq(e.isValidationVerdict, true);
    assertEq(e.detail.includes("offset"), true);
    // Deliberately *not* a PlanError: a plan-document fault and a verdict
    // about the input component must not be conflated.
    assertEq(e instanceof PlanError, false);
  }
});

Deno.test("loader: unsupported/internal phases are not validation verdicts", () => {
  for (const phase of ["unsupported", "internal"] as const) {
    try {
      loadEnvelope(JSON.stringify({
        error: "nope",
        errorDetail: { phase, message: "nope" },
      }));
      throw new Error("expected TranslateError");
    } catch (e) {
      if (!(e instanceof TranslateError)) throw e;
      assertEq(e.phase, phase);
      assertEq(e.isValidationVerdict, false);
    }
  }
});

Deno.test("loader: v0.1 envelope without errorDetail is not a validation verdict", () => {
  try {
    loadEnvelope(`{"error":"boom"}`);
    throw new Error("expected TranslateError");
  } catch (e) {
    if (!(e instanceof TranslateError)) throw e;
    assertEq(e.phase, "internal");
    assertEq(e.isValidationVerdict, false);
    assertEq(String(e).includes("boom"), true);
  }
});

// --- imported resources (contracts v0.2 proposal) --------------------------

Deno.test("loader: ResourceIndex = imported + defined", () => {
  const withImports = loadPlan(minimalPlan({
    imports: [
      { name: "r", path: [], kind: "resource" },
      { name: "s", path: [], kind: "resource" },
    ],
    importedResources: [{ import: 0 }, { import: 1 }],
  }));
  assertEq(withImports.numImportedResources, 2);
  assertEq(resourceIndexOfDefined(withImports, 0), 2);
  assertEq(resourceIndexOfDefined(withImports, 1), 3);

  // Absent field (a v0.1 plan) reads as "no imported resources", which is
  // exactly what v0.1 asserted.
  const v01 = loadPlan(minimalPlan());
  assertEq(v01.numImportedResources, 0);
  assertEq(resourceIndexOfDefined(v01, 0), 0);
});

Deno.test("loader: importedResources back-references are range-checked", () => {
  assertPlanError(
    () => loadPlan(minimalPlan({ importedResources: [{ import: 3 }] })),
    "not a valid index into plan.imports",
  );
});

// ISSUE #94(2): streamTables/futureTables are required-array in a v2+ plan
// (the shim never omits them; see plan/format.ts's field doc). A plan that
// omits them entirely (a stale v0.1-shaped document masquerading as v2, or
// a truncated envelope) must fail loudly at load time, not be silently
// read as "no stream/future tables". (v3's `errorContextTables` gets the
// same treatment; pinned in plan_v3_test.ts.)
Deno.test("loader: streamTables/futureTables are required at the supported formatVersion", () => {
  const wire = minimalPlan() as unknown as Record<string, unknown>;
  delete wire.streamTables;
  assertPlanError(
    () => loadPlan(wire as unknown as WirePlan),
    "plan.streamTables missing or not an array",
  );
  const wire2 = minimalPlan() as unknown as Record<string, unknown>;
  delete wire2.futureTables;
  assertPlanError(
    () => loadPlan(wire2 as unknown as WirePlan),
    "plan.futureTables missing or not an array",
  );
});

// ISSUE #94(3): deep-schema strictness for initializers/trampolines/
// canonicalOptions — malformed ops must surface as typed PlanErrors at
// load time, not as raw TypeErrors deep in the executor.
Deno.test("loader: malformed instantiate-module initializer (missing args) is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        initializers: [
          { op: "instantiate-module", module: 0, instance: null } as never,
        ],
      })),
    "args must be an array",
  );
});

Deno.test("loader: malformed CoreDef (unknown kind) inside instantiate-module args is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        initializers: [
          {
            op: "instantiate-module",
            module: 0,
            instance: null,
            args: [{ kind: "not-a-real-kind" } as never],
          },
        ],
      })),
    "unknown CoreDef kind",
  );
});

Deno.test("loader: unknown initializer op is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        initializers: [{ op: "not-a-real-op" } as never],
      })),
    "unknown initializer op",
  );
});

Deno.test("loader: malformed trampoline (wrong-typed field) is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        trampolines: [
          { kind: "task-return", index: 0, instance: "not-a-number" } as never,
        ],
      })),
    ".instance must be a number",
  );
});

Deno.test("loader: unrecognized trampoline kind still requires kind/index (milestone-gated catch-all)", () => {
  // Not every trampoline kind has a precise wire shape (format.ts's
  // catch-all `{ kind: string; index: number; ... }` for milestone-gated
  // kinds rejected at instantiate time). The loader only enforces the two
  // invariants that are always true.
  loadPlan(minimalPlan({
    trampolines: [{ kind: "some-future-milestone-kind", index: 0 } as never],
  }));
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        trampolines: [{ kind: "some-future-milestone-kind" } as never],
      })),
    ".index must be a number",
  );
});

Deno.test("loader: malformed canonicalOptions (bad stringEncoding) is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        canonicalOptions: [
          {
            instance: 0,
            stringEncoding: "utf-9000",
            memory: null,
            realloc: null,
            postReturn: null,
            callback: null,
            async: false,
            cancellable: false,
            coreType: { params: [], results: [] },
          } as never,
        ],
      })),
    ".stringEncoding must be one of",
  );
});

Deno.test("loader: valid plans with well-formed initializers/trampolines/canonicalOptions load unaffected", () => {
  const wire = minimalPlan({
    initializers: [
      {
        op: "instantiate-module",
        module: 0,
        instance: null,
        args: [
          { kind: "unsafe-intrinsic", intrinsic: "context.get-0" },
        ],
      },
    ],
    trampolines: [
      { kind: "trap", index: 0, code: 0 },
      { kind: "resource-drop", index: 1, instance: 0, resource: 0 },
    ],
    canonicalOptions: [
      {
        instance: 0,
        stringEncoding: "utf8",
        memory: null,
        realloc: null,
        postReturn: null,
        callback: null,
        async: false,
        cancellable: false,
        coreType: { params: ["i32"], results: [] },
      },
    ],
  });
  loadPlan(wire); // must not throw
});

// ISSUE #187: `modules[]` / `exports[]` / `imports[]` deep-schema strictness
// — mirrors the #94(3) discipline above. The negative-offset walk in the
// issue body is the load-bearing case: an unchecked `offset` slices the
// wrong component bytes rather than tripping the executor's (upper-bound
// only) guard.

Deno.test("loader: embedded module with negative offset is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        modules: [{ kind: "embedded", offset: -100, len: 92 } as never],
      })),
    ".offset must be a non-negative safe integer",
  );
});

Deno.test("loader: embedded module with NaN offset is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        modules: [{ kind: "embedded", offset: NaN, len: 92 } as never],
      })),
    ".offset must be a non-negative safe integer",
  );
});

Deno.test("loader: embedded module with non-integer offset is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        modules: [{ kind: "embedded", offset: 1.5, len: 92 } as never],
      })),
    ".offset must be a non-negative safe integer",
  );
});

Deno.test("loader: embedded module missing len is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        modules: [{ kind: "embedded", offset: 0 } as never],
      })),
    ".len must be a non-negative safe integer",
  );
});

Deno.test("loader: adapter module with wrong-typed file is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        modules: [
          { kind: "adapter", file: 42, len: 0, intrinsics: [] } as never,
        ],
      })),
    ".file must be a string",
  );
});

Deno.test("loader: unknown module kind is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        modules: [{ kind: "not-a-real-kind" } as never],
      })),
    "unknown module kind",
  );
});

Deno.test("loader: malformed export entry (missing required field per kind) is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        exports: [{ kind: "lifted-func", name: "f" } as never],
      })),
    ".coreDef must be an object",
  );
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        exports: [{ kind: "module", name: "m" } as never],
      })),
    ".module must be a number",
  );
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        exports: [{ kind: "type", name: "t", type: { kind: "resource" } } as never],
      })),
    ".resource must be a number",
  );
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        exports: [{ kind: "not-a-real-kind" } as never],
      })),
    "unknown export kind",
  );
});

Deno.test("loader: malformed nested instance export is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        exports: [
          {
            kind: "instance",
            name: "i",
            exports: [{ kind: "lifted-func", name: "f" } as never],
          } as never,
        ],
      })),
    ".coreDef must be an object",
  );
});

Deno.test("loader: malformed import entry is a typed PlanError", () => {
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        imports: [{ name: "x", kind: "func" } as never],
      })),
    ".path must be an array",
  );
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        imports: [{ name: "x", path: [], kind: "func", type: "nope" } as never],
      })),
    ".type must be a number",
  );
});

// The tampered-cache scenario from polyengine#187: a valid-looking plan with a
// negative embedded-module offset (as a corrupted-on-disk cache entry might
// carry) must be refused at `loadPlan`, never allowed through to slice the
// wrong component bytes.
Deno.test("loader: tampered cache scenario — negative modules[0].offset is refused at load", () => {
  const wire = minimalPlan({
    modules: [{ kind: "embedded", offset: -100, len: 92 }],
  });
  assertPlanError(() => loadPlan(wire), ".offset must be a non-negative safe integer");
});

Deno.test("loader: well-formed modules/exports/imports load unaffected", () => {
  const wire = minimalPlan({
    modules: [
      { kind: "embedded", offset: 0, len: 4 },
      { kind: "adapter", file: "adapters/a.wasm", len: 8, intrinsics: [] },
    ],
    imports: [{ name: "x", path: ["a", "b"], kind: "func", type: 0 }],
    exports: [
      {
        kind: "instance",
        name: "i",
        exports: [{ kind: "module", name: "m", module: 0 }],
      },
      { kind: "type", name: "t", type: { kind: "value", type: 0 } },
    ],
  });
  loadPlan(wire); // must not throw
});
