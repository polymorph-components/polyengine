// Build the two upstream Wasmtime guests used by runtime/tests/wasmtime.
// The dependency checkout is discovered from this repository's locked cargo
// graph; it is never written. The guest sources are read directly from
// crates/test-programs/src/bin/{async_round_trip_stackless,async_short_reads}.rs
// and crates/misc/component-async-tests/wit at that revision. A detached local
// clone and all cargo output live under the ignored build directory.

import { resolveWasmtimeSource } from "../wasmtime/source.ts";

const root = new URL("../../", import.meta.url);
const here = new URL("./", import.meta.url);
const buildDir = new URL("build/", here);
const checkout = new URL("build/source/", here);
const target = new URL("build/target/", here);
const sources = [
  "crates/test-programs/src/bin/async_round_trip_stackless.rs",
  "crates/test-programs/src/bin/async_short_reads.rs",
  "crates/misc/component-async-tests/wit/test.wit",
  "crates/wasi-preview1-component-adapter",
];

async function run(
  command: string,
  args: string[],
  options: Deno.CommandOptions = {},
): Promise<string> {
  const output = await new Deno.Command(command, {
    ...options,
    args,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!output.success) {
    throw new Error(`${command} ${args.join(" ")} exited ${output.code}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

const wasmToolsVersion = await run("wasm-tools", ["--version"]);

const { path: source, rev: revision } = await resolveWasmtimeSource();
if ((await run("git", ["rev-parse", "HEAD"], { cwd: source })) !== revision) {
  throw new Error(`cargo cache checkout is not locked revision ${revision}`);
}
// Cargo git checkouts may contain unrelated uninitialized submodule entries.
// Only committed objects are cloned, but reject changes to every direct source
// selected for this build rather than silently stamping them as the clean rev.
const sourceDirty = await run(
  "git",
  ["status", "--porcelain", "--", ...sources],
  { cwd: source },
);
if (sourceDirty !== "") {
  throw new Error(`refusing dirty cargo cache checkout at ${source}`);
}

await Deno.mkdir(buildDir, { recursive: true });
try {
  const actual = await run("git", ["rev-parse", "HEAD"], { cwd: checkout });
  const dirty = await run("git", ["status", "--porcelain"], {
    cwd: checkout,
  });
  if (dirty !== "") {
    throw new Error(
      `refusing dirty guest checkout at ${checkout.pathname}`,
    );
  }
  if (actual !== revision) {
    await Deno.remove(checkout, { recursive: true });
  }
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
try {
  await Deno.stat(new URL(".git", checkout));
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
  await run("git", ["clone", "--no-checkout", source, checkout.pathname]);
  await run("git", ["checkout", "--detach", revision], { cwd: checkout });
}
if ((await run("git", ["rev-parse", "HEAD"], { cwd: checkout })) !== revision) {
  throw new Error(`guest checkout is not locked revision ${revision}`);
}
if ((await run("git", ["status", "--porcelain"], { cwd: checkout })) !== "") {
  throw new Error(`refusing dirty guest checkout at ${checkout.pathname}`);
}

const env = {
  CARGO_TARGET_DIR: target.pathname,
};
await run(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--target=wasm32-wasip1",
    "--package=test-programs",
    "--bin=async_round_trip_stackless",
    "--bin=async_short_reads",
  ],
  { cwd: checkout, env },
);
await run(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--target=wasm32-unknown-unknown",
    "--package=wasi-preview1-component-adapter",
    "--no-default-features",
    "--features=command",
  ],
  { cwd: checkout, env },
);

const adapter = new URL(
  "wasm32-unknown-unknown/release/wasi_snapshot_preview1.wasm",
  target,
).pathname;
const artifacts: Record<string, string> = {};
for (const name of ["async_round_trip_stackless", "async_short_reads"]) {
  const core = new URL(`wasm32-wasip1/release/${name}.wasm`, target).pathname;
  const component = new URL(`${name}.component.wasm`, buildDir).pathname;
  await run("wasm-tools", [
    "component",
    "new",
    core,
    "--adapt",
    `wasi_snapshot_preview1=${adapter}`,
    "-o",
    component,
  ]);
  await run("wasm-tools", [
    "validate",
    "--features=component-model,cm-async",
    component,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(component),
  );
  artifacts[name] = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  console.log(`built ${component} from wasmtime ${revision}`);
}
await Deno.writeTextFile(
  new URL("provenance.json", buildDir),
  JSON.stringify({ revision, wasmToolsVersion, sources, artifacts }, null, 2) +
    "\n",
);
