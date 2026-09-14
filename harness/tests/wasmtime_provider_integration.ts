import type { WastJson } from "../src/schema.ts";
import { runWastJson } from "../src/runner.ts";
import { RuntimeExecutor } from "../src/runtime-executor.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("context-in-resource-drop crosses the scoped gc host boundary", async () => {
  const { wasmtimeSpectest } = await import("../src/wasmtime-spectest.ts");
  const root = new URL("../../", import.meta.url);
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
