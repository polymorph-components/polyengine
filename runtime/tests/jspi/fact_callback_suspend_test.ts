// Regression pin: a FACT callee's CALLBACK re-entry must be
// `promising`-wrapped in jspi mode.
//
// `runtime/src/jspi/bridge.ts`'s invariant names exactly three wasm entries
// that can reach a blocking built-in and therefore must carry their own
// `promising` entry: a lifted export's core function, a **callback export**,
// and a FACT adapter callee invoked by `{sync,async}-start-call`. The host
// boundary honoured all of this (`exec/boundary.ts` wraps both the initial
// entry and the callback), but `intrinsics/fact_calls.ts`'s `mkCalleeTask`
// wrapped only the INITIAL callee entry and handed `runCallbackLoop` the raw
// callback.
//
// That is invisible to `async/cross-abi-calls.wast`, whose callees only ever
// block by returning WAIT codes from a callback — a WAIT return unwinds the
// wasm frame before anything suspends. It becomes visible the moment a
// callback activation blocks SYNCHRONOUSLY mid-frame, which is exactly the
// shape wit-bindgen's `block_on` emits: start a subtask, then
// `waitable-set.wait` on it without returning to the callback loop. The first
// composed consumer workload to do that (the wosh client's fused iroh
// endpoint, signing a TLS CertificateVerify via `block_on(webcrypto sign)`
// inside packet processing) died with
//
//     SuspendError: trying to suspend without WebAssembly.promising
//
// `fixtures/fact-callback-suspend.wat` reproduces that shape in ~200 lines of
// hand-written wat: see its header for the layout and the definitions.py line
// references for every encoding it uses.
import { assert, assertEquals } from "./asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";
import { planNeedsSuspension } from "../../src/jspi/bridge.ts";
import { isSupported } from "../../src/jspi/mechanics.ts";

const root = new URL("../../../", import.meta.url);

async function readIfPresent(rel: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    return null;
  }
}

// Same skip-when-absent discipline as the neighbours: the shim is a build
// artifact, not a checked-in one.
const shimWasm = await readIfPresent(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
);
if (shimWasm === null) {
  console.warn(
    "SKIP fact callback suspend: missing translator_shim.wasm " +
      "(cargo build -p translator-shim --release --target wasm32-unknown-unknown)",
  );
}
const componentWasm = await Deno.readFile(
  new URL("./fixtures/fact-callback-suspend.wasm", import.meta.url),
);

Deno.test({
  name: "fact callee: a callback re-entry that blocks synchronously suspends " +
    "(promising-wrapped), it does not raise SuspendError",
  ignore: shimWasm === null,
  fn: async () => {
    const translator = await Translator.create(shimWasm!);
    const { plan, adapters } = translator.translate(componentWasm);

    // Self-documenting: this component reaches the defect only because the
    // instantiation runs in "jspi" mode, and it does so on its own — $Callee
    // imports `waitable-set.wait`, which `trampolineNeedsSuspension`
    // classifies as unconditionally block-capable. No `jspi: true` override
    // is passed, so a regression that stopped classifying this plan as
    // suspension-needing would fail here rather than silently downgrade the
    // test to the plain path.
    assert(
      planNeedsSuspension(plan),
      "fixture must need suspension: it imports waitable-set.wait",
    );
    assert(
      isSupported(),
      "this pin requires an engine with JSPI (the plain path cannot reach it)",
    );

    // The gate resolves on a MACROTASK, not a microtask: a microtask-resolved
    // promise can still be observed as pending, but a macrotask guarantees
    // the runtime really has to park the guest and hand control back to the
    // event loop — both when $Callee returns WAIT and when it blocks
    // synchronously inside its callback.
    let gateCalls = 0;
    const gate = () => {
      gateCalls++;
      return new Promise<void>((resolve) => setTimeout(resolve, 5));
    };

    const handle = await instantiateComponent({
      plan,
      componentBytes: componentWasm,
      adapters,
      imports: { gate },
    });

    // Belt and braces: the mode is per-instantiation and the FACT wrap is
    // per-callee (`Executor.suspendableFuncs`), so an empty set would mean
    // nothing got wrapped and the pin would be vacuous.
    assert(
      handle.coreInstances.some((i) =>
        Object.values(i.exports).some((e) =>
          typeof e === "function" &&
          handle.suspendableFuncs.has(e as unknown as object)
        )
      ),
      "expected $Callee's core exports to be classified suspendable",
    );

    const go = handle.exports.go as () => Promise<unknown> | unknown;
    // Before the fix this rejects with
    // `SuspendError: trying to suspend without WebAssembly.promising`,
    // thrown out of the second (synchronous) `waitable-set.wait`.
    const result = await go();

    // 2 = $Callee's gate counter: one gate awaited via the WAIT callback code
    // on the initial activation, one awaited SYNCHRONOUSLY inside the
    // callback re-entry. Round-tripping it through `task.return` and the
    // FACT `[async-return]` adapter makes "both legs ran" observable rather
    // than merely "nothing threw".
    assertEquals(result, 2);
    assertEquals(gateCalls, 2);
  },
});
