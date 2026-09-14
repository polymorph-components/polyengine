import type { WastJson } from "../../harness/src/schema.ts";
import { runWastJson } from "../../harness/src/runner.ts";
import { RuntimeExecutor } from "../../harness/src/runtime-executor.ts";
import { wasmtimeSpectest } from "../../harness/src/wasmtime-spectest.ts";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const file = Deno.args[0];
if (file === undefined) throw new Error("worker needs a generated file path");
const repo = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
const generated = join(repo, "harness", "generated-wasmtime");
const doc = JSON.parse(
  await Deno.readTextFile(join(generated, file)),
) as WastJson;
const shim = await Deno.readFile(
  join(repo, "target/wasm32-unknown-unknown/release/translator_shim.wasm"),
);
const dir = dirname(file) === "." ? "" : dirname(file);
const result = await runWastJson(
  doc,
  (name) => Deno.readFile(join(generated, dir, name)),
  await RuntimeExecutor.create(shim, wasmtimeSpectest(file).imports),
);
const output = new TextEncoder().encode(`${JSON.stringify(result)}\n`);
let written = 0;
while (written < output.length) {
  written += Deno.stdout.writeSync(output.subarray(written));
}
// This worker is a bounded test scope, not the runtime's process-lifetime
// owner. Some valid upstream cases intentionally leave background guest work
// runnable after their final assertion. Exit only after the complete validated
// result has been written; pre-result failures still reject and exit nonzero.
Deno.exit(0);
