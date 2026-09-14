import {
  expectedWasmtimeFailure,
  WASMTIME_EXPECTATIONS,
  WASMTIME_FAILURE_CLASSES,
  WASMTIME_SKIP_EXPECTATIONS,
} from "../src/wasmtime-expectations.ts";
import { classify } from "../src/wasmtime-classifier.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("Wasmtime expectation requires exact file, line, and failure cause", () => {
  const entry = WASMTIME_EXPECTATIONS[0];
  assert(entry !== undefined, "fixture expectation missing");
  assert(
    expectedWasmtimeFailure(
      entry.file,
      entry.line,
      entry.cause,
    ) === entry,
    "matching cause was rejected",
  );
  assert(
    expectedWasmtimeFailure(
      entry.file,
      entry.line,
      `prefix ${entry.cause} suffix`,
    ) === undefined,
    "non-exact cause was accepted",
  );
  assert(
    expectedWasmtimeFailure(entry.file, entry.line + 1_000_000, entry.cause) ===
      undefined,
    "wrong line was accepted",
  );
  assert(
    expectedWasmtimeFailure(entry.file, entry.line, "different failure") ===
      undefined,
    "wrong cause was accepted",
  );
});

Deno.test("every expectation names a declared failure class", () => {
  assert(
    WASMTIME_EXPECTATIONS.every((e) =>
      WASMTIME_FAILURE_CLASSES[e.class] !== undefined
    ),
    "expectation has an undeclared failure class",
  );
});

Deno.test("classifier rejects stale passes and unexpected skips", () => {
  const entry = WASMTIME_EXPECTATIONS[0];
  assert(
    classify(entry.file, {
      line: entry.line,
      type: "assert_return",
      status: "passed",
    }).status ===
      "unexpected",
    "stale pass accepted",
  );
  assert(
    classify("x.json", {
      line: 1,
      type: "future-directive",
      status: "skipped",
      detail: "new reason",
    }).status === "unexpected",
    "unknown skip accepted",
  );
});

Deno.test("skip expectations require exact line and full cause", () => {
  const entry = WASMTIME_SKIP_EXPECTATIONS[0];
  if (entry === undefined) {
    assert(WASMTIME_SKIP_EXPECTATIONS.length === 0, "unexpected skip entry");
    return;
  }
  const base = {
    type: "module",
    status: "skipped" as const,
    reason: "pending-runtime" as const,
  };
  assert(
    classify(entry.file, { ...base, line: entry.line, detail: entry.cause })
      .status === "skip",
    "exact skip rejected",
  );
  assert(
    classify(entry.file, {
      ...base,
      line: entry.line + 1_000_000,
      detail: entry.cause,
    }).status === "unexpected",
    "wrong skip line accepted",
  );
  assert(
    classify(entry.file, {
      ...base,
      line: entry.line,
      detail: entry.cause + " changed",
    }).status === "unexpected",
    "changed skip cause accepted",
  );
  assert(
    classify(entry.file, {
      ...base,
      line: entry.line,
      reason: "pending-capability",
      detail: entry.cause,
    }).status === "unexpected",
    "changed skip reason accepted",
  );
  assert(
    classify(entry.file, { line: entry.line, type: "module", status: "passed" })
      .status === "unexpected",
    "skip-to-pass accepted",
  );
});

Deno.test("expectation inventory has no duplicates and every class is declared", () => {
  const all = [...WASMTIME_EXPECTATIONS, ...WASMTIME_SKIP_EXPECTATIONS];
  const keys = all.map((e) => `${e.status}:${e.file}:${e.line}`);
  assert(new Set(keys).size === keys.length, "duplicate expectation row");
  assert(
    all.every((e) => WASMTIME_FAILURE_CLASSES[e.class] !== undefined),
    "missing expectation class",
  );
});

Deno.test("spectest resource probe preserves rep and destructor counters", async () => {
  const { wasmtimeSpectest } = await import("../src/wasmtime-spectest.ts");
  const probe = wasmtimeSpectest();
  const host = probe.imports.host as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  host["[static]resource1.assert"](7, 7);
  const resource = host.resource1 as unknown as {
    options: { dtor: (rep: number) => void };
  };
  resource.options.dtor(7);
  assert(
    probe.counters.drops === 1 && probe.counters.lastDrop === 7,
    "resource counters lost",
  );
});

Deno.test("spectest exposes gc only for the deferred-frame boundary fixture", async () => {
  const { wasmtimeSpectest } = await import("../src/wasmtime-spectest.ts");
  const ordinary = wasmtimeSpectest("async/futures.json");
  assert(
    !("wasmtime" in ordinary.imports),
    "wasmtime provider leaked into an unrelated fixture",
  );

  const probe = wasmtimeSpectest("async/context-in-resource-drop.json");
  const wasmtime = probe.imports.wasmtime as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  assert(typeof wasmtime.gc === "function", "gc provider is absent");
  assert(
    probe.counters.forcedHostBoundaries === 0,
    "counter did not start at zero",
  );
  wasmtime.gc();
  assert(
    probe.counters.forcedHostBoundaries === 1,
    "gc provider invocation was not observed",
  );
  assert(
    !("set-max-table-capacity" in wasmtime),
    "native table-capacity control must not be emulated",
  );
});
