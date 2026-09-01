// The deadlock trap across a sync-lowered call.
//
// `testdata/deadlock-sync-call.wasm`: a sync-lowered caller parks on an
// async-lifted callee (FACT `sync-start-call`) which itself parks on a
// freshly created, empty waitable set. Nothing can ever signal that set, so
// neither side can proceed and no promise, thread or host call is outstanding.
//
// The Component Model's answer to that state is a TRAP -- definitions.py's
// `canon_lift` driving loop treats an empty candidate set as `trap_if`, not as
// something to wait out. This test exists because the jspi driver's failure
// mode for "nothing can progress" is otherwise a silent stall: an await that
// nothing will ever settle, which produces no trap, no rejection and no
// output. It guards every scheduler change in this area.
import { assert } from "./asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";

const root = new URL("../../../", import.meta.url);

async function readIfPresent(rel: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    return null;
  }
}

const shimWasm = await readIfPresent(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
);
const componentWasm = await readIfPresent(
  "crates/translator-shim/testdata/deadlock-sync-call.wasm",
);
const ready = shimWasm !== null && componentWasm !== null;
if (!ready) {
  console.warn(
    "SKIP deadlock trap: missing " +
      (shimWasm === null
        ? "translator_shim.wasm (cargo build -p translator-shim --release " +
          "--target wasm32-unknown-unknown)"
        : "testdata/deadlock-sync-call.wasm (cargo run -p translator-shim " +
          "--example emit-testdata -- deadlock-sync-call)"),
  );
}

async function run(jspi: boolean): Promise<unknown> {
  const translator = await Translator.create(shimWasm!);
  const { plan, adapters } = translator.translate(componentWasm!);
  const handle = await instantiateComponent({
    plan,
    componentBytes: componentWasm!,
    adapters,
    jspi,
  });
  return await (handle.exports.run as () => unknown)();
}

Deno.test({
  name: "deadlock: an unprogressable sync-lowered call traps, and does not hang",
  ignore: !ready,
  fn: async () => {
    // A stall would fail this test by timing out / "promise never resolved"
    // rather than by assertion, which is exactly the distinction being pinned:
    // reaching the catch AT ALL is most of the assertion.
    let message: string | null = null;
    try {
      const r = await run(true);
      throw new Error(`expected a deadlock trap, got ${JSON.stringify(r)}`);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    // Site 2 (`waitable-set.wait`) is now lit, so the callee genuinely parks
    // on the unsignalable set and the driver must reach the deadlock trap.
    // Tightened from the earlier "trap OR capability signal" form, which was
    // only ever a placeholder for this.
    assert(
      message!.includes("deadlock"),
      `expected a deadlock trap, got: ${message}`,
    );
  },
});

Deno.test({
  name: "deadlock: the trap surfaces as a rejection, leaving no unhandled one",
  ignore: !ready,
  fn: async () => {
    // The jspi path abandons the suspension by REJECTING the import's promise.
    // If any abandoned suspension's rejection escapes unobserved it lands here
    // as an unhandledrejection -- a silent correctness hole in normal runs,
    // since nothing else reports it.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: Event) => {
      unhandled.push((e as PromiseRejectionEvent).reason);
      e.preventDefault();
    };
    addEventListener("unhandledrejection", onUnhandled);
    try {
      await run(true).catch(() => {});
      // Give any stray rejection a turn to surface before we judge silence.
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      removeEventListener("unhandledrejection", onUnhandled);
    }
    assert(
      unhandled.length === 0,
      `expected no unhandled rejections, got ${unhandled.length}: ` +
        unhandled.map((u) => String(u)).join("; "),
    );
  },
});

Deno.test({
  name: "deadlock: plain mode reports the same deadlock, not a stall",
  ignore: !ready,
  fn: async () => {
    // The zero-cost path must agree about the verdict: jspi changes HOW we
    // wait, never WHETHER this component can progress.
    let message: string | null = null;
    try {
      await run(false);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert(message !== null, "expected plain mode to fail, not return");
  },
});
