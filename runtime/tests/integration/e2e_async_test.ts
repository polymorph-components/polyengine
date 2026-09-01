// End-to-end async pipeline — translator shim
// (plan v1, `unsafe-intrinsic`) -> executor -> task core -> callback ABI ->
// correct result — against the real wit-bindgen `async-probe` guest.
//
// `wait-then-double` is the flagship: wit-bindgen 0.60 compiles it to an
// async lift with a callback, and `wit_bindgen::yield_async().await` makes it
// return the YIELD callback code at least once. Getting 42 out of it means
// the whole stackless path works — context slots (the guest's task pointer),
// `task.return`, the packed-code loop, and scheduler resumption — with no
// JSPI anywhere.
//
// Requires build artifacts (both produced from source in this repo):
//   - target/wasm32-unknown-unknown/release/translator_shim.wasm
//       cargo build -p translator-shim --release --target wasm32-unknown-unknown
//   - examples/guests/build/async-probe.component.wasm
//       ./examples/build.sh

import { assertEq } from "../support/asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";
import { PendingCapability } from "../../src/task/mod.ts";
import { AssertionError, NotImplemented, Trap } from "../../src/cabi/mod.ts";

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
const probeWasm = await readArtifact(
  "examples/guests/build/async-probe.component.wasm",
  "./examples/build.sh",
);

const translator = await Translator.create(shimWasm);
const { plan, adapters } = translator.translate(probeWasm);

async function instantiate() {
  return await instantiateComponent({
    plan,
    componentBytes: probeWasm,
    adapters,
  });
}

Deno.test("async-probe: plan v1 carries the context unsafe-intrinsics", () => {
  const symbols = new Set<string>();
  for (const init of plan.initializers) {
    if (init.op !== "instantiate-module") continue;
    for (const arg of init.args) {
      if (arg.kind === "unsafe-intrinsic") symbols.add(arg.intrinsic);
    }
  }
  // wit-bindgen 0.60 keeps its async task pointer in context slot 0; that is
  // the whole reason `CoreDef::UnsafeIntrinsic` had to become representable.
  assertEq(symbols.has("context-get-i32-0"), true);
  assertEq(symbols.has("context-set-i32-0"), true);
});

Deno.test("async-probe: wait-then-double runs the callback ABI to EXIT", async () => {
  const component = await instantiate();
  const f = component.exports["wait-then-double"] as (x: number) => unknown;
  assertEq(await f(21), 42);
  assertEq(component.stats.liftedCalls, 1);
  assertEq(component.stats.tasksResolved, 1);
  // The guest yields once, so the host invokes the callback export at least
  // once before it returns EXIT. (Exactly once for wit-bindgen 0.60; asserted
  // as ">= 1" so a bindgen change that adds an internal poll is a test
  // update, not a false failure.)
  assert(
    component.stats.callbackInvocations >= 1,
    `expected at least one callback invocation, got ` +
      `${component.stats.callbackInvocations}`,
  );
  // An async lift has no post-return (definitions.py `canon_lift`: post_return
  // is only called on the sync path).
  assertEq(component.stats.postReturnsRun, 0);
});

Deno.test("async-probe: the task model is left clean after the call", async () => {
  const component = await instantiate();
  const f = component.exports["wait-then-double"] as (x: number) => unknown;
  assertEq(await f(1), 2);
  const inst = component.componentInstances[0];
  assertEq(inst.mayLeave, true);
  // definitions.py `Task.exit_implicit_thread`: the exclusive thread is
  // released and the instance's thread table is empty again.
  assertEq(inst.exclusiveThread, null);
  assertEq([...inst.threads].length, 0);
  assertEq(inst.backpressure, 0);
  assertEq(inst.numWaitingToEnter, 0);
});

Deno.test("async-probe: repeated calls are independent tasks", async () => {
  const component = await instantiate();
  const f = component.exports["wait-then-double"] as (x: number) => unknown;
  for (let i = 0; i < 5; i++) assertEq(await f(i), i * 2);
  assertEq(component.stats.liftedCalls, 5);
  assertEq(component.stats.tasksResolved, 5);
});

Deno.test("async-probe: sum-stream lifts a real stream handle", async () => {
  // With streams implemented, the stream parameter is no longer a capability
  // refusal — it is a genuine value. Passing a non-stream must therefore fail
  // as a *type* error from `lower_stream` (definitions.py line 1828 asserts
  // its argument is a shared stream), not as a missing capability.
  const component = await instantiate();
  const sum = component.exports["sum-stream"] as (v: unknown) => unknown;
  let raised: unknown;
  try {
    await sum(0);
  } catch (e) {
    raised = e;
  }
  assert(
    raised instanceof AssertionError,
    `expected a host-value type error, got ${raised}`,
  );
  assert(
    String(raised).includes("shared stream"),
    `message should name the expected host shape, got: ${raised}`,
  );
});

Deno.test("async-probe: a terminating activation leaves nothing behind", async () => {
  // The regression pin for the background-activation design.
  //
  // Two shapes must both be right. A *terminating* activation (this one) has
  // to run all the way out — past `task.return`, through the callback loop's
  // EXIT, to `exit_implicit_thread` — before the lifted call reports done;
  // returning at `task.return` abandoned it mid-loop and leaked the exclusive
  // thread. A *producer* activation (stream-echo / future-user, pinned in
  // e2e_streams_test.ts) must NOT be waited for, or it deadlocks.
  const component = await instantiate();
  const f = component.exports["wait-then-double"] as (x: number) => unknown;
  assertEq(await f(21), 42);

  const inst = component.componentInstances.find((i) => i)!;
  // definitions.py `Task.exit_implicit_thread`: the exclusive thread is
  // released and the instance's thread table is empty again.
  assertEq(inst.exclusiveThread, null);
  assertEq([...inst.threads].length, 0);
  // Nothing parked: neither on a scheduler condition nor mid-wasm-call.
  const store = (inst as unknown as {
    store: { waiting: unknown[]; awaiting: Set<unknown> };
  }).store;
  assertEq(store.waiting.length, 0);
  assertEq(store.awaiting.size, 0);
});
