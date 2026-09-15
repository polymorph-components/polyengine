import type { WastJson } from "../src/schema.ts";
import { runWastJson } from "../src/runner.ts";
import { RuntimeExecutor } from "../src/runtime-executor.ts";

const root = new URL("../../", import.meta.url);
const generated = new URL("harness/generated-wasmtime/", root);

async function runtimeExecutor(): Promise<RuntimeExecutor> {
  return await RuntimeExecutor.create(
    await Deno.readFile(
      new URL(
        "target/wasm32-unknown-unknown/release/translator_shim.wasm",
        root,
      ),
    ),
  );
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("context-in-resource-drop crosses the scoped gc host boundary", async () => {
  const { wasmtimeSpectest } = await import("../src/wasmtime-spectest.ts");
  const generated = new URL(
    "harness/generated-wasmtime/async/",
    root,
  );
  const doc = JSON.parse(
    await Deno.readTextFile(
      new URL("context-in-resource-drop.json", generated),
    ),
  ) as WastJson;
  const probe = wasmtimeSpectest("async/context-in-resource-drop.json");
  const executor = await RuntimeExecutor.create(
    await Deno.readFile(
      new URL(
        "target/wasm32-unknown-unknown/release/translator_shim.wasm",
        root,
      ),
    ),
    probe.imports,
  );
  const result = await runWastJson(
    doc,
    (name) => Deno.readFile(new URL(name, generated)),
    executor,
  );

  assert(
    result.results.every((row) => row.status === "passed"),
    `fixture did not pass: ${JSON.stringify(result.results)}`,
  );
  assert(
    probe.counters.forcedHostBoundaries === 4,
    `expected four destructor host-boundary calls, got ${probe.counters.forcedHostBoundaries}`,
  );
});

Deno.test("types fixture receives the precise variant diagnostic", async () => {
  const fixture = new URL("types.json", generated);
  const original = JSON.parse(await Deno.readTextFile(fixture)) as WastJson;
  const doc: WastJson = {
    ...original,
    commands: original.commands.filter((command) => command.line >= 357),
  };
  const result = await runWastJson(
    doc,
    (name) => Deno.readFile(new URL(name, generated)),
    await runtimeExecutor(),
  );
  assert(
    result.results.length === 5 &&
      result.results.every((row) => row.status === "passed"),
    `types fixture slice did not pass: ${JSON.stringify(result.results)}`,
  );
});

Deno.test("native start trap does not satisfy assert_unlinkable", async () => {
  const fixture = new URL("instance.json", generated);
  const original = JSON.parse(await Deno.readTextFile(fixture)) as WastJson;
  const source = original.commands.find((command) => command.line === 79);
  if (source === undefined || source.type !== "assert_uninstantiable") {
    throw new Error("generated native start-trap fixture is absent");
  }
  const doc: WastJson = {
    ...original,
    commands: [{ ...source, type: "assert_unlinkable" }],
  };
  const result = await runWastJson(
    doc,
    (name) => Deno.readFile(new URL(name, generated)),
    await runtimeExecutor(),
  );
  assert(
    result.results[0]?.status === "failed" &&
      result.results[0].detail === "RuntimeError: unreachable",
    `native start trap satisfied unlinkable: ${JSON.stringify(result.results)}`,
  );
});

Deno.test("unsupported translation does not satisfy assert_unlinkable", async () => {
  const fixture = new URL(
    "tests/fixtures/validation-imported-module.wasm",
    new URL("harness/", root),
  );
  const doc: WastJson = {
    source_filename: "unsupported.wast",
    commands: [{
      type: "assert_unlinkable",
      line: 1,
      filename: "validation-imported-module.wasm",
      module_type: "binary",
      text: "anything",
    }],
  };
  const result = await runWastJson(
    doc,
    () => Deno.readFile(fixture),
    await runtimeExecutor(),
  );
  assert(
    result.results[0]?.status === "failed" &&
      result.results[0].detail?.startsWith(
          "TranslateError: translator error [unsupported]",
        ) === true,
    `unsupported translation satisfied unlinkable: ${
      JSON.stringify(result.results)
    }`,
  );
});
