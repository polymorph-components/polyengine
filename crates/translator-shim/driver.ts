// Shim smoke driver: wasmtime's component frontend (wasmtime-environ + FACT),
// compiled to wasm32-unknown-unknown, running under a JS engine and
// translating Component Model binaries into plan v0 envelopes
// (contracts/plan-format.md; envelope wire format: README.md).
//
// Usage:
//   deno run --allow-read driver.ts [--wasm <path>] [component.wasm ...]
//
// With no component args, runs the four testdata components and asserts the
// go/no-go expectations (trivial: no adapters; linked/async-linked: FACT
// adapters present) against the plan schema.

type CoreDef =
  | { kind: "export"; instance: number; item: { name: string; space: string } }
  | { kind: "instance-flags"; instance: number }
  | { kind: "trampoline"; index: number };

type Envelope = {
  plan?: {
    formatVersion: number;
    modules: (
      | { kind: "embedded"; offset: number; len: number }
      | {
        kind: "adapter";
        file: string;
        len: number;
        intrinsics: { module: string; name: string; category: string; def: CoreDef }[];
      }
    )[];
    initializers: { op: string; [k: string]: unknown }[];
    trampolines: { kind: string; index: number }[];
    exports: { kind: string; name: string }[];
  };
  adapters?: { file: string; wasm: string }[];
  error?: string;
};

const here = new URL(".", import.meta.url);
const args = [...Deno.args];
let wasmPath = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
  import.meta.url,
);
const wasmFlag = args.indexOf("--wasm");
if (wasmFlag !== -1) {
  wasmPath = new URL(args[wasmFlag + 1], here);
  args.splice(wasmFlag, 2);
}

// --- load the translator ---
const t0 = performance.now();
const wasmBytes = await Deno.readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const tLoad = performance.now() - t0;

const exports = instance.exports as {
  memory: WebAssembly.Memory;
  ts_alloc: (len: number) => number;
  ts_dealloc: (ptr: number, len: number) => void;
  ts_translate: (ptr: number, len: number, outLenPtr: number) => number;
};

function translate(component: Uint8Array): Envelope {
  const inPtr = exports.ts_alloc(component.length);
  new Uint8Array(exports.memory.buffer, inPtr, component.length).set(component);
  // 4 bytes for the out-length (usize on wasm32).
  const outLenPtr = exports.ts_alloc(4);
  const outPtr = exports.ts_translate(inPtr, component.length, outLenPtr);
  // Re-acquire views: translation may have grown (detached) the memory.
  const outLen = new DataView(exports.memory.buffer).getUint32(outLenPtr, true);
  const json = new TextDecoder().decode(
    new Uint8Array(exports.memory.buffer, outPtr, outLen),
  );
  exports.ts_dealloc(outPtr, outLen);
  exports.ts_dealloc(outLenPtr, 4);
  exports.ts_dealloc(inPtr, component.length);
  return JSON.parse(json);
}

function report(name: string, bytes: Uint8Array): NonNullable<Envelope["plan"]> {
  const start = performance.now();
  const e = translate(bytes);
  const ms = performance.now() - start;
  if (e.error || !e.plan) {
    console.error(`${name}: translation FAILED: ${e.error}`);
    Deno.exit(1);
  }
  const plan = e.plan;
  const adapters = plan.modules.filter((m) => m.kind === "adapter");
  console.log(
    `=== ${name} (${bytes.length} bytes, translated in ${ms.toFixed(1)} ms) ===`,
  );
  console.log(
    `  modules: ${plan.modules.length} (${adapters.length} FACT adapters), ` +
      `initializers: ${plan.initializers.length}, trampolines: ${plan.trampolines.length}`,
  );
  for (const m of plan.modules) {
    if (m.kind === "embedded") {
      console.log(`  embedded module: bytes ${m.offset}..${m.offset + m.len}`);
    } else {
      console.log(`  adapter ${m.file} (${m.len} bytes)`);
      for (const i of m.intrinsics) {
        console.log(`      import ${i.module}.${i.name}: ${i.category}`);
      }
    }
  }
  for (const i of plan.initializers) console.log(`    op ${i.op}`);
  for (const x of plan.exports) console.log(`  export ${x.name} (${x.kind})`);
  return plan;
}

if (args.includes("--bench")) {
  // Steady-state translation timing: translate each testdata component N
  // times inside the same instance.
  const N = 200;
  for (const name of ["trivial", "linked", "async-lift", "async-linked"]) {
    const bytes = await Deno.readFile(new URL(`testdata/${name}.wasm`, here));
    translate(bytes); // warm-up
    const start = performance.now();
    for (let i = 0; i < N; i++) translate(bytes);
    const ms = (performance.now() - start) / N;
    console.log(
      `${name}: ${ms.toFixed(3)} ms/translation (${bytes.length} bytes, N=${N})`,
    );
  }
  Deno.exit(0);
}

if (args.length > 0) {
  for (const path of args) {
    report(path, await Deno.readFile(path));
  }
} else {
  const testdata = (name: string) =>
    Deno.readFile(new URL(`testdata/${name}.wasm`, here));
  const countAdapters = (p: NonNullable<Envelope["plan"]>) =>
    p.modules.filter((m) => m.kind === "adapter").length;

  const trivial = report("trivial", await testdata("trivial"));
  if (trivial.modules.length !== 1 || countAdapters(trivial) !== 0) {
    console.error("FAIL: trivial expectations");
    Deno.exit(1);
  }

  const linked = report("linked", await testdata("linked"));
  if (countAdapters(linked) < 1) {
    console.error("FAIL: linked expectations (need >=1 FACT adapter)");
    Deno.exit(1);
  }

  const asyncLift = report("async-lift", await testdata("async-lift"));
  if (!asyncLift.trampolines.some((t) => t.kind === "task-return")) {
    console.error("FAIL: async-lift should require a task-return trampoline");
    Deno.exit(1);
  }

  const asyncLinked = report("async-linked", await testdata("async-linked"));
  if (
    countAdapters(asyncLinked) < 1 ||
    !asyncLinked.trampolines.some((t) => t.kind === "prepare-call")
  ) {
    console.error("FAIL: async-linked expectations (async FACT adapters)");
    Deno.exit(1);
  }

  console.log(
    `\nall checks passed (translator load+compile: ${tLoad.toFixed(1)} ms)`,
  );
}
