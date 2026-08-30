// M0 end-to-end integration (docs/milestones.md M0 exit criterion): the full-JS
// pipeline — translator shim (wasm32, running under Deno) -> plan v0 ->
// TS plan executor -> typed call -> correct result — against the real
// wit-bindgen `hello` guest (strings, realloc, post-return).
//
// Requires build artifacts (both produced from source in this repo):
//   - target/wasm32-unknown-unknown/release/translator_shim.wasm
//       cargo build -p translator-shim --release --target wasm32-unknown-unknown
//   - examples/guests/build/hello.component.wasm
//       ./examples/build.sh

import { assertEq, assertTrap } from "../support/asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";
import { SUPPORTED_FORMAT_VERSION } from "../../src/plan/mod.ts";
import { isInstancePoisoned } from "../../src/task/scheduler.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const root = new URL("../../../", import.meta.url);

async function readArtifact(rel: string, hint: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    throw new Error(`missing build artifact ${rel} — run: ${hint}`);
  }
}

const shimWasm = await readArtifact(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  "cargo build -p translator-shim --release --target wasm32-unknown-unknown",
);
const helloWasm = await readArtifact(
  "examples/guests/build/hello.component.wasm",
  "./examples/build.sh",
);

Deno.test("hello: full pipeline shim -> plan -> executor -> greet()", async () => {
  const translator = await Translator.create(shimWasm);
  const { plan, adapters } = translator.translate(helloWasm);

  assertEq(plan.formatVersion, SUPPORTED_FORMAT_VERSION);
  assertEq(plan.producer.wasmtimeEnviron, "47.0.3");
  assertEq(adapters.size, 0); // no cross-component links in hello

  const component = await instantiateComponent({
    plan,
    componentBytes: helloWasm,
    adapters,
  });

  const greet = component.exports.greet as (name: string) => string;
  assertEq(typeof greet, "function");

  // The exact fixture output (examples/guests/hello/src/lib.rs).
  assertEq(greet("component model"), "Hello, component model!");

  // post-return (cabi_post_greet) ran after result copy-out.
  assertEq(component.stats.postReturnsRun, 1);
  assertEq(component.stats.liftedCalls, 1);
  assertEq(component.stats.tasksResolved, 1);

  // Reentrance gates released after the sync call resolved.
  const inst = component.componentInstances[0];
  assert(inst.mayEnter, "may_enter must be restored after call");
  assert(inst.mayLeave, "may_leave must be restored after call");
  assertEq(inst.flags.value, 1);

  // The instance stays healthy across further calls (post-return freed the
  // previous return area; realloc/memory views survive growth).
  assertEq(greet(""), "Hello, !");
  assertEq(
    greet("a".repeat(200_000)), // forces realloc traffic + memory.grow
    `Hello, ${"a".repeat(200_000)}!`,
  );
  assertEq(component.stats.postReturnsRun, 3);
});

Deno.test("hello: plan determinism (translate twice, byte-identical)", async () => {
  const translator = await Translator.create(shimWasm);
  const first = translator.translateRaw(helloWasm);
  const second = translator.translateRaw(helloWasm);
  assertEq(first === second, true);

  // Also across translator instances (fresh wasm heap layout).
  const translator2 = await Translator.create(shimWasm);
  assertEq(translator2.translateRaw(helloWasm) === first, true);
});

Deno.test("hello: executor validates formatVersion and hash", async () => {
  const translator = await Translator.create(shimWasm);
  const { plan, adapters } = translator.translate(helloWasm);

  // formatVersion mismatch fails fast.
  const bumped = { ...plan, formatVersion: SUPPORTED_FORMAT_VERSION + 1 };
  let failed = "";
  try {
    await instantiateComponent({
      plan: bumped,
      componentBytes: helloWasm,
      adapters,
    });
  } catch (e) {
    failed = String(e);
  }
  assert(failed.includes("formatVersion"), `got: ${failed}`);

  // Component-bytes mismatch (hash check) fails fast.
  const tampered = helloWasm.slice();
  tampered[tampered.length - 1] ^= 0xff;
  failed = "";
  try {
    await instantiateComponent({
      plan,
      componentBytes: tampered,
      adapters,
    });
  } catch (e) {
    failed = String(e);
  }
  assert(failed.includes("sha256"), `got: ${failed}`);
});

Deno.test("task model: reentrance is permitted; a failed call poisons", async () => {
  const translator = await Translator.create(shimWasm);
  const { plan, adapters } = translator.translate(helloWasm);
  const component = await instantiateComponent({
    plan,
    componentBytes: helloWasm,
    adapters,
  });
  const greet = component.exports.greet as (name: string) => string;
  greet("warm-up");

  // INVERTED by polyengine#173 (CM#705). This used to simulate an
  // in-progress activation of the same instance and require the next host
  // entry to trap. The merged reference (definitions.py @ 2f13265) has no
  // `may_enter`, no `entering_set` and no bracket in `Store.lift`, so entry
  // into a live instance is valid. The live host-mediated shape is pinned
  // end-to-end in e2e_imports_test.ts ("a host import may synchronously
  // re-enter its own instance"); here we only pin that nothing refuses.
  const inst = component.componentInstances[0];
  assertEq(greet("reentrant"), "Hello, reentrant!");
  assertEq(greet("after"), "Hello, after!");

  // Host input of the wrong JS type fails as a host-side error, not a CM trap
  // (cabi asserts host-value validity per the open question in
  // runtime/README.md). It still poisons: the failure happens *inside* the
  // task, after `task.start()`, so the guest may already have run realloc and
  // half-written its argument buffer — the instance is in exactly the
  // indeterminate state poisoning exists for. (Poisoning is polyengine's
  // named divergence — a per-instance corpse where wasmtime kills the whole
  // store — and since CM#705 it is the ONLY reason an entry is refused.)
  let threw = false;
  try {
    greet(123 as unknown as string);
  } catch {
    threw = true;
  }
  assert(threw, "number lowered as string must fail");
  assert(isInstancePoisoned(inst), "a failed call must poison the instance");
  assertTrap(() => greet("after-poison"), "cannot enter component instance");
  // polyengine#145 ask 1: the poisoned refusal names the original cause, so the
  // embedder is not sent chasing transient caller-side call overlap. The
  // cause here is the host-side lowering error above — non-Trap causes must
  // surface too.
  let refusal = "";
  try {
    greet("after-poison-again");
  } catch (e) {
    refusal = String((e as Error).message ?? e);
  }
  assert(
    refusal.includes("cannot enter component instance"),
    `refusal must keep the base wording, got: ${refusal}`,
  );
  assert(
    refusal.includes("instance poisoned by:"),
    `refusal must name the poison cause, got: ${refusal}`,
  );
});
