// Plain-vs-jspi equivalence across every lower/lift ABI combination.
//
// `async/cross-abi-calls.wast` exercises all four combinations (sync/async
// lower x sync/async lift) at 4, 5 and 17 params and 1, 16 and 17 results --
// i.e. both the flat and the spilled-through-retptr shapes. Running each
// export in BOTH suspension modes and requiring identical outcomes is a much
// sharper instrument than a pass/fail suite run: plain mode is the reference
// (49/49 green), so any divergence localizes a jspi-path defect to a single
// export name.
//
// It earned its place. It is what caught a real regression: the callee's `promising`
// wrap made an async-lowered call into a SYNC-lifted callee report its subtask
// as STARTED when an unwrapped run reported RETURNED, and the six
// `async-calls-sync-*` exports diverged while all others matched exactly.
// A suite run showed only "6 RuntimeError: unreachable" with no hint of shape.
//
// TARGET: zero divergences — REACHED. The six
// `async-calls-sync-*` divergences (async-lowered call into a sync-lifted
// callee reporting STARTED where an unwrapped run reports RETURNED) were
// resolved by two changes working together:
//
//   * per-DECLARATION blocking classification (`trampolineNeedsSuspension`,
//     jspi/bridge.ts) keeps eagerly-completing callees out of
//     `Executor.suspendableFuncs`, so they are not `promising`-wrapped at
//     all; and
//   * for callees that ARE legitimately wrapped, `async-start-call` parks the
//     caller until the callee's state is DETERMINATE (resolved / finished /
//     genuinely scheduler-parked) — the reference's atomic
//     run-to-first-block, reconstructed across the engine's microtask hops
//     (jspi pin (j): even a plain-value Suspending return defers the
//     continuation to a microtask).
//
// The set below stays as the mechanism-of-record: if any export starts
// diverging again, it fails loudly with the per-export outcome diff.
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
  "harness/generated/async/cross-abi-calls.0.wasm",
);
let fields: string[] = [];
try {
  const spec = JSON.parse(
    await Deno.readTextFile(
      new URL("harness/generated/async/cross-abi-calls.json", root),
    ),
  );
  fields = [
    ...new Set(
      (spec.commands as { action?: { field?: string } }[])
        .filter((c) => c.action?.field)
        .map((c) => c.action!.field!),
    ),
  ];
} catch { /* corpus absent; handled by `ready` below */ }

const ready = shimWasm !== null && componentWasm !== null && fields.length > 0;
if (!ready) {
  console.warn(
    "SKIP cross-abi differential: missing " +
      (shimWasm === null
        ? "translator_shim.wasm (cargo build -p translator-shim --release " +
          "--target wasm32-unknown-unknown)"
        : "harness/generated (cargo run -p testgen)"),
  );
}

Deno.test({
  name: "cross-abi: plain and jspi agree on every export (0 divergences)",
  ignore: !ready,
  fn: async () => {
    const translator = await Translator.create(shimWasm!);

    // A fresh instance per call: the .wast re-instantiates for each command,
    // and sharing one instance across exports would let an earlier call's
    // state decide a later one's outcome.
    const call = async (field: string, jspi: boolean): Promise<string> => {
      const { plan, adapters } = translator.translate(componentWasm!);
      const handle = await instantiateComponent({
        plan,
        componentBytes: componentWasm!,
        adapters,
        jspi,
      });
      try {
        return `ok ${JSON.stringify(await (handle.exports[field] as () => unknown)())}`;
      } catch (e) {
        // Compare the failure TEXT too: "both threw" is not agreement if they
        // threw for different reasons.
        return `threw ${e instanceof Error ? e.message : String(e)}`;
      }
    };

    // Known-divergent set: EMPTY, and it must stay that way. (History: the
    // six `async-calls-sync-*` exports lived here until the determinacy park
    // landed — see the module header.)
    const KNOWN_DIVERGENT = new Set<string>([]);
    const divergences: string[] = [];
    const unexpectedlyAgreeing: string[] = [];
    for (const field of fields) {
      const plain = await call(field, false);
      const jspi = await call(field, true);
      if (plain !== jspi) {
        if (!KNOWN_DIVERGENT.has(field)) {
          divergences.push(`${field}\n    plain: ${plain}\n    jspi : ${jspi}`);
        }
      } else if (KNOWN_DIVERGENT.has(field)) {
        unexpectedlyAgreeing.push(field);
      }
    }
    assert(
      divergences.length === 0,
      `plain and jspi disagree on ${divergences.length} export(s) outside the ` +
        `known set:\n  ${divergences.join("\n  ")}`,
    );
    assert(
      unexpectedlyAgreeing.length === 0,
      `these no longer diverge -- remove them from KNOWN_DIVERGENT: ` +
        unexpectedlyAgreeing.join(", "),
    );
  },
});
