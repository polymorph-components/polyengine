import { resolveWasmtimeSource } from "./source.ts";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const root = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
const source = await resolveWasmtimeSource();
const testDir = `${source.path}/tests/misc_testsuite/component-model`;
const outDir = join(root, "harness", "generated-wasmtime");
const command = new Deno.Command("cargo", {
  cwd: root,
  args: [
    "run",
    "-q",
    "-p",
    "testgen",
    "--",
    "--test-dir",
    testDir,
    "--out-dir",
    outDir,
    "--source-prefix",
    `wasmtime@${source.rev}/tests/misc_testsuite/component-model`,
    "--source-revision",
    source.rev,
  ],
});
const status = await command.spawn().status;
if (!status.success) Deno.exit(status.code);
