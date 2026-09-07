// Unit tests for the runner + CoreOnlyExecutor over in-memory fixtures.
//
// The official component-model suite contains zero top-level core modules,
// so these fixtures keep the core-module execution path (the only path that
// can execute today) covered. They also pin the environment facts the
// harness design relies on.

import type { WastJson } from "../src/schema.ts";
import { CoreOnlyExecutor } from "../src/executor.ts";
import { runWastJson, trapMatches } from "../src/runner.ts";

// (module) - the empty core module, hand-encoded.
const EMPTY_CORE_MODULE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
// A core module with a valid preamble (sniffs as kind "module") but an
// invalid trailing section byte (0xff is not a valid section id), so
// WebAssembly.validate rejects it on content, not preamble.
const INVALID_SECTION_MODULE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff]);
// (component) - the empty component: core preamble with version 0x0d,
// layer 0x0001.
const EMPTY_COMPONENT = new Uint8Array([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]);

const artifacts = new Map<string, Uint8Array<ArrayBuffer>>([
  ["ok.0.wasm", EMPTY_CORE_MODULE],
  ["bad.0.wasm", INVALID_SECTION_MODULE],
  ["comp.0.wasm", EMPTY_COMPONENT],
]);

function load(filename: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = artifacts.get(filename);
  if (bytes === undefined) throw new Error(`no fixture ${filename}`);
  return Promise.resolve(bytes);
}

function doc(commands: WastJson["commands"]): WastJson {
  return { source_filename: "fixture.wast", commands };
}

function assertEq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

Deno.test("environment: V8 validates core modules but no component binaries", () => {
  assertEq(WebAssembly.validate(EMPTY_CORE_MODULE), true, "core valid");
  assertEq(WebAssembly.validate(INVALID_SECTION_MODULE), false, "invalid section");
  // The load-bearing fact behind skip("pending-runtime"): the JS API rejects
  // the component layer preamble outright, so `validate === false` carries
  // no information about a component's actual validity.
  assertEq(WebAssembly.validate(EMPTY_COMPONENT), false, "component rejected");
});

Deno.test("core module command executes via the JS WebAssembly API", async () => {
  const result = await runWastJson(
    doc([
      {
        type: "module",
        line: 1,
        filename: "ok.0.wasm",
        module_type: "binary",
      },
      {
        type: "assert_invalid",
        line: 2,
        filename: "bad.0.wasm",
        module_type: "binary",
        text: "whatever",
      },
    ]),
    load,
    new CoreOnlyExecutor(),
  );
  assertEq(
    result.results.map((r) => r.status),
    ["passed", "passed"],
    "statuses",
  );
});

Deno.test("core invoke and definition instantiation are pending-runtime", async () => {
  const result = await runWastJson(
    doc([
      {
        type: "module",
        line: 1,
        filename: "ok.0.wasm",
        module_type: "binary",
      },
      {
        type: "assert_return",
        line: 2,
        action: { type: "invoke", field: "f", args: [] },
        expected: [],
      },
      { type: "module_instance", line: 3, instance: "i", module: "M" },
    ]),
    load,
    new CoreOnlyExecutor(),
  );
  assertEq(
    result.results.map((r) => [r.status, r.reason ?? null]),
    [["passed", null], ["skipped", "pending-runtime"], [
      "skipped",
      "pending-runtime",
    ]],
    "statuses",
  );
});

Deno.test("component-layer commands are pending-runtime", async () => {
  const result = await runWastJson(
    doc([
      {
        type: "module",
        line: 1,
        filename: "comp.0.wasm",
        module_type: "binary",
      },
      {
        type: "assert_invalid",
        line: 2,
        filename: "comp.0.wasm",
        module_type: "binary",
        text: "whatever",
      },
    ]),
    load,
    new CoreOnlyExecutor(),
  );
  assertEq(
    result.results.map((r) => [r.status, r.reason ?? null]),
    [["skipped", "pending-runtime"], ["skipped", "pending-runtime"]],
    "statuses",
  );
});

Deno.test("text artifacts are unsupported-directive", async () => {
  const result = await runWastJson(
    doc([
      {
        type: "assert_malformed",
        line: 1,
        filename: "x.0.wat",
        module_type: "text",
        text: "whatever",
      },
    ]),
    load,
    new CoreOnlyExecutor(),
  );
  assertEq(
    result.results.map((r) => [r.status, r.reason ?? null]),
    [["skipped", "unsupported-directive"]],
    "statuses",
  );
});

Deno.test("a genuinely invalid core module fails assert-free module command", async () => {
  const result = await runWastJson(
    doc([
      {
        type: "module",
        line: 1,
        filename: "bad.0.wasm",
        module_type: "binary",
      },
    ]),
    load,
    new CoreOnlyExecutor(),
  );
  assertEq(result.results[0].status, "failed", "status");
});

// TRAP_MESSAGE_EQUIVALENTS: the core `unreachable` trap row. The runtime
// (runtime/src/exec/boundary.ts mapCoreException) passes each JS engine's raw
// trap text through untouched; this table is where the suite's
// (wasmtime-worded) expected text is reconciled against each engine's own
// spelling. Pin all three known engine spellings against both expected forms
// the corpus actually asserts for this trap.
Deno.test("trapMatches: core `unreachable` trap — all three engine spellings match the wasmtime-worded expectation", () => {
  const expected = "wasm trap: wasm `unreachable` instruction executed";
  // V8 (Deno/Chromium)
  assertEq(trapMatches(expected, "guest trapped: unreachable"), true, "V8");
  // SpiderMonkey (Firefox)
  assertEq(
    trapMatches(expected, "guest trapped: unreachable executed"),
    true,
    "SpiderMonkey",
  );
  // JSC (WebKit) — capitalized "Unreachable", which is exactly why plain
  // substring matching against the lowercase expected text is insufficient.
  assertEq(
    trapMatches(
      expected,
      "guest trapped: Unreachable code should not be executed",
    ),
    true,
    "JSC",
  );
});

Deno.test("trapMatches: core `unreachable` trap — all three engine spellings match the short expected form too", () => {
  // async/big-interleaving-test.wast:836 asserts plain "unreachable"; this
  // already matches via the substring fast path (actual.includes(expected)),
  // not the equivalents table, but pin it here so a future refactor of
  // either path can't silently break this corpus command.
  const expected = "unreachable";
  assertEq(trapMatches(expected, "guest trapped: unreachable"), true, "V8");
  assertEq(
    trapMatches(expected, "guest trapped: unreachable executed"),
    true,
    "SpiderMonkey",
  );
  assertEq(
    trapMatches(
      expected,
      "guest trapped: Unreachable code should not be executed",
    ),
    true,
    "JSC (capitalized, so the substring fast path misses; covered by the short-form equivalents row — the wording residual observed on webkit-2342, polyengine#11)",
  );
});

Deno.test("trapMatches: an unrelated engine trap message does not falsely match the unreachable row", () => {
  const expected = "wasm trap: wasm `unreachable` instruction executed";
  assertEq(
    trapMatches(expected, "guest trapped: memory access out of bounds"),
    false,
    "unrelated trap",
  );
});
