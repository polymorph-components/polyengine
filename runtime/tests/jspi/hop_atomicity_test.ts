// Regression pin: a host call must not run a guest turn INSIDE another
// export's jspi entry hop, between that export's core return and its result
// LIFT.
//
// In jspi mode a SYNC-lifted export's core entry is `promising`-wrapped, so
// the engine returns a Promise that settles a microtask later even when the
// guest completed synchronously (jspi "pin (j)"). That opens a HOP between
// two steps the reference performs atomically inside ONE enter/leave bracket
// (definitions.py `canon_lift`, line 2213: the sync path lowers the args,
// calls the core function and lifts the results with the callee instance
// entered throughout):
//
//   1. the guest core function returns its i32 result pointer, and
//   2. the host lifts the result through that pointer — outer (ptr,len),
//      each inner (ptr,len), then the bytes.
//
// `exec/boundary.ts` releases the reentrance bracket at the FIRST park
// (`leave()` runs before `drive`, and the lift happens later still, in
// `finishHostEntry`). A hop-park is a park, so pre-fix a SECOND host call
// could enter and run a full guest turn in that window — and if that turn
// mutates the memory the pending lift is about to read, the lift reads
// whatever the intruder left.
//
// In the wild: the wosh mosh engine's `tick`, returning `list<list<u8>>`,
// died under real traffic with `Trap: list too long` — a clobbered outer
// length word of 0xFFFFFFFF against `MAX_LIST_BYTE_LENGTH` = 2^28-1
// (runtime/src/cabi/load.ts:31) — and the instance was poisoned behind it.
//
// The pin is DETERMINISTIC and timing-free: `clobber()` is issued
// unconditionally while `tick()`'s promise is still pending, and the pre-fix
// outcome is a hard trap rather than a value that might accidentally compare
// equal. Genuine JSPI suspensions (SuspensionPoint-owned parks) keep their
// documented interleaving; only hop-parks are covered here.
//
// See `fixtures/hop-atomicity.wat` for the memory layout and the
// definitions.py line references for every encoding it relies on.
import { assert, assertEquals } from "./asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiate } from "../../src/embedder/mod.ts";
import { suspending } from "@polyengine/protocol";
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
    "SKIP hop atomicity: missing translator_shim.wasm " +
      "(cargo build -p translator-shim --release --target wasm32-unknown-unknown)",
  );
}
const componentWasm = await Deno.readFile(
  new URL("./fixtures/hop-atomicity.wasm", import.meta.url),
);

/** The value `tick` builds on every call (fixture layout: two inner lists). */
function assertTickValue(actual: unknown, where: string): void {
  assert(Array.isArray(actual), `${where}: expected an array, got ${Deno.inspect(actual)}`);
  const outer = actual as unknown[];
  assertEquals(outer.length, 2, `${where}: outer list length`);
  // contracts/embedder-api.md / docs/architecture.md §7: `list<u8>` lifts as a
  // Uint8Array, the outer `list<...>` as a plain array.
  const expected = [[1, 2, 3], [4, 5]];
  for (let i = 0; i < 2; i++) {
    const inner = outer[i];
    assert(
      inner instanceof Uint8Array,
      `${where}: inner[${i}] should lift as Uint8Array, got ${Deno.inspect(inner)}`,
    );
    assertEquals(
      Array.from(inner).join(","),
      expected[i].join(","),
      `${where}: inner[${i}] bytes`,
    );
  }
}

type Settled =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

/** Observe BOTH promises' outcomes before asserting anything: a pre-fix run
 * rejects one of them, and an unobserved rejection would abort the whole test
 * process as an uncaught rejection instead of failing this test with a
 * readable message. */
function settle(p: unknown): Promise<Settled> {
  return Promise.resolve(p).then(
    (value): Settled => ({ ok: true, value }),
    (error): Settled => ({ ok: false, error }),
  );
}

function valueOf(s: Settled, where: string): unknown {
  if (!s.ok) {
    throw new Error(
      `${where}: expected fulfilment, got rejection: ${
        s.error instanceof Error ? s.error.message : Deno.inspect(s.error)
      }`,
    );
  }
  return s.value;
}

Deno.test({
  name:
    "hop atomicity: a second host call must not run a guest turn inside a " +
    "pending export's jspi entry hop (result lift stays atomic)",
  ignore: shimWasm === null,
  fn: async () => {
    const translator = await Translator.create(shimWasm!);
    const { plan, adapters } = translator.translate(componentWasm);

    // Self-documenting, and the reason the fixture carries an import it never
    // calls: this component has NO blocking declaration of its own — no async
    // lift, no blocking built-in — so the plan alone would run it in plain
    // mode, where the entry is a direct call and no hop exists at all. The
    // mode is flipped by the OTHER `chooseMode` input (executor.ts:385-392):
    // a `suspending()`-marked host import in the imports record. That mirrors
    // how the wosh engine got flipped (marked wasi imports it never called).
    assert(
      !planNeedsSuspension(plan),
      "fixture's plan must NOT need suspension on its own — the jspi mode " +
        "here comes from the suspending()-marked import, and a plan that " +
        "needed suspension would make that provenance untestable",
    );
    assert(
      isSupported(),
      "this pin requires an engine with JSPI (the plain path has no hop)",
    );

    const instance = await instantiate(
      { plan, componentBytes: componentWasm, adapters },
      // Never called by the guest; the brand is the whole point. `instantiate`
      // preserves it through the facade's import wrappers (embedder/
      // instantiate.ts:520,589), which is what `anySuspendingImport` sees.
      { "test:hop/gate": { wait: suspending(() => 7) } },
    );
    const handle = instance.handle;

    // Belt and braces: if nothing got promising-wrapped there is no hop and
    // the pin would be vacuous. Both core exports (`tick`, `clobber`) are
    // classified suspendable because the core instance imports a
    // suspendable lowering.
    assert(
      handle.coreInstances.some((i) =>
        Object.values(i.exports).some((e) =>
          typeof e === "function" &&
          handle.suspendableFuncs.has(e as unknown as object)
        )
      ),
      "expected the core exports to be classified suspendable (no wrap => no hop)",
    );

    const exports = instance.exports as {
      tick: () => Promise<unknown>;
      clobber: () => Promise<unknown>;
    };

    // ---- round 1: the race, issued with zero timing dependence -----------
    const a = exports.tick(); // pending: hop open, result NOT yet lifted
    assert(
      a instanceof Promise,
      "tick must return a Promise in jspi mode (that promise IS the hop)",
    );
    const b = exports.clobber(); // the second host call, inside that window

    const aSettled = await settle(a);
    const bSettled = await settle(b);

    // Pre-fix this rejects with `Trap: list too long`: `clobber` ran a full
    // guest turn in the hop and overwrote the outer (ptr,len) with
    // 0xFFFFFFFF/0xFFFFFFFF, so `loadListFromRange` trapped on the length
    // before it could even reject the bogus pointer (load.ts:120).
    // Post-fix `clobber` is deferred until `tick`'s lift has completed.
    assertTickValue(valueOf(aSettled, "round 1 tick()"), "round 1 tick()");
    assertEquals(valueOf(bSettled, "round 1 clobber()"), 1, "clobber() result");

    // ---- round 2: the instance survived ----------------------------------
    // `tick` rewrites its whole layout on every call, so the component
    // self-heals after a clobber. A second round-trip therefore proves the
    // instance is still healthy — in particular that no trap poisoned it and
    // left it un-enterable (the wild failure's second act).
    assertTickValue(await exports.tick(), "round 2 tick()");
  },
});
