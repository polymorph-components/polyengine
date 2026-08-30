// The generalized SYNC_ENTRY mechanism (contracts/embedder-api.md
// §"Functions and async", amendment A25).
//
// In jspi mode every lifted export's core entry is `promising`-wrapped, so
// the entry returns a Promise even when the guest completed without
// suspending (jspi pin (e)/(j)). A25 generalizes the constructor-only
// plain-entered variant to EVERY sync-typed export: each carries a second
// lifted function, under the `SYNC_ENTRY` symbol, whose entry is plain, so a
// synchronously-completing activation delivers its results synchronously.
// (The embedder-facing `sync()` adapter that consumes it is a separate
// track; these pins are on the kernel half.)
//
// Two properties are pinned here:
//
//   1. **attachment** — sync-typed exports carry it, async-typed exports do
//      not (an async WIT function has no synchronous form by definition);
//   2. **hop-window refusal** (A25 failure-ladder arm 2) — a plain entry
//      taken while the instance has HOP-parked activations would race the
//      pending result LIFT of that activation, the corruption window
//      `hop_atomicity_test.ts` documents. The Promise surface *defers* there
//      (the hop-quiescence gate); a synchronous caller cannot be deferred, so
//      it REFUSES with `SyncEntryBusy` — thrown before the instance is
//      entered, hence non-poisoning, so the instance stays enterable and the
//      call succeeds on retry once the hop settles.
//
// Property 2 also changes constructor behaviour deliberately: the constructor
// sync entry previously bypassed the hop gate entirely. Constructing a hop
// window around a `new R(...)` needs a guest that both parks an activation
// and exposes a resource constructor, which no existing fixture does; the
// refusal lives in `createLiftedFunction` and is reached identically by both
// consumers, so it is pinned here through the generic sync entry.
import { assert, assertEquals } from "./asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";
import { SYNC_ENTRY } from "../../src/exec/boundary.ts";
import { SyncEntryBusy } from "../../src/task/scheduler.ts";
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
    "SKIP sync entry: missing translator_shim.wasm " +
      "(cargo build -p translator-shim --release --target wasm32-unknown-unknown)",
  );
}

const hopWasm = await Deno.readFile(
  new URL("./fixtures/hop-atomicity.wasm", import.meta.url),
);
const asyncWasm = await Deno.readFile(
  new URL("./fixtures/fact-callback-suspend.wasm", import.meta.url),
);

type Fn = (...args: unknown[]) => unknown;

function syncEntryOf(fn: unknown, where: string): Fn {
  const entry = (fn as Record<PropertyKey, unknown>)[SYNC_ENTRY];
  assert(
    typeof entry === "function",
    `${where}: expected a SYNC_ENTRY variant, got ${Deno.inspect(entry)}`,
  );
  return entry as Fn;
}

/** The value `tick` builds on every call (fixture layout: two inner lists). */
function assertTickValue(actual: unknown, where: string): void {
  assert(
    Array.isArray(actual),
    `${where}: expected an array, got ${Deno.inspect(actual)}`,
  );
  const outer = actual as unknown[];
  assertEquals(outer.length, 2, `${where}: outer list length`);
  const expected = [[1, 2, 3], [4, 5]];
  for (let i = 0; i < 2; i++) {
    const inner = outer[i] as ArrayLike<number>;
    assertEquals(
      Array.from(inner).join(","),
      expected[i].join(","),
      `${where}: inner[${i}] bytes`,
    );
  }
}

/** The hop-atomicity fixture, instantiated in jspi mode (raw exec surface:
 * the SYNC_ENTRY symbol rides the lifted function itself). */
async function hopInstance() {
  const translator = await Translator.create(shimWasm!);
  const { plan, adapters } = translator.translate(hopWasm);
  // The fixture's plan has no blocking declaration of its own (see its
  // header); jspi is requested explicitly here rather than through a
  // `suspending()`-marked import, since this suite drives the raw exec
  // surface rather than the embedder facade.
  assert(
    !planNeedsSuspension(plan),
    "fixture's plan must NOT need suspension on its own",
  );
  return await instantiateComponent({
    plan,
    componentBytes: hopWasm,
    adapters,
    imports: { "test:hop/gate": { wait: () => 7 } },
    jspi: true,
  });
}

Deno.test({
  name:
    "A25: a sync-typed non-constructor export carries SYNC_ENTRY in jspi " +
    "mode, and it answers synchronously",
  ignore: shimWasm === null || !isSupported(),
  fn: async () => {
    const handle = await hopInstance();
    const tick = handle.exports.tick as Fn;
    const clobber = handle.exports.clobber as Fn;

    // The promising-wrapped default surface is still Promise-shaped: A25 adds
    // a view, it does not change the default.
    const promised = tick();
    assert(
      promised instanceof Promise,
      "the default entry must stay Promise-shaped in jspi mode",
    );
    assertTickValue(await promised, "default entry");

    // Every sync-typed export, not just `[constructor]` ones.
    const tickSync = syncEntryOf(tick, "tick");
    const clobberSync = syncEntryOf(clobber, "clobber");

    const value = tickSync();
    assert(
      !(value instanceof Promise) &&
        typeof (value as { then?: unknown })?.then !== "function",
      `sync entry must not return a thenable, got ${Deno.inspect(value)}`,
    );
    assertTickValue(value, "sync entry");

    // `clobber` overwrites the results area, and `tick` rewrites it, so the
    // instance self-heals: a synchronous round trip through both proves the
    // plain entry completes fully inside its bracket rather than leaving the
    // instance mid-call.
    assertEquals(clobberSync(), 1, "clobber sync entry result");
    assertTickValue(tickSync(), "sync entry after clobber");
  },
});

Deno.test({
  name:
    "A25 arm 2: a SYNC_ENTRY call during a hop window refuses with " +
    "SyncEntryBusy, non-poisoningly",
  ignore: shimWasm === null || !isSupported(),
  fn: async () => {
    const handle = await hopInstance();
    const tick = handle.exports.tick as Fn;
    const tickSync = syncEntryOf(tick, "tick");
    const clobberSync = syncEntryOf(handle.exports.clobber, "clobber");

    // Open the hop: the core call has returned but the result LIFT has not
    // run yet, and the reentrance bracket is already released. This is the
    // exact window in which `clobber` used to corrupt `tick`'s pending lift
    // (hop_atomicity_test.ts); the Promise surface now defers into it, and a
    // synchronous entry must refuse rather than defer.
    const pending = tick();
    assert(pending instanceof Promise, "the pending promise IS the hop");

    let refused: unknown = null;
    try {
      clobberSync();
    } catch (e) {
      refused = e;
    }
    assert(
      refused instanceof SyncEntryBusy,
      `expected SyncEntryBusy, got ${Deno.inspect(refused)}`,
    );
    // Branded by name, per A25 ("e.name === 'SyncEntryBusy'").
    assertEquals((refused as Error).name, "SyncEntryBusy");
    assert(
      (refused as Error).message.includes("clobber"),
      `the refusal must name the export: ${(refused as Error).message}`,
    );
    // The refusal happens BEFORE entering, so the in-flight lift is
    // untouched: the pending call still yields the correct value.
    assertTickValue(await pending, "tick across a refused sync entry");

    // Non-poisoning, both surfaces: the instance is enterable again once the
    // hop has settled.
    assertTickValue(await (tick() as Promise<unknown>), "default entry after refusal");
    assertEquals(clobberSync(), 1, "sync entry after refusal");
    assertTickValue(tickSync(), "sync entry after refusal (tick)");
  },
});

Deno.test({
  name: "A25: an async-typed export carries no SYNC_ENTRY",
  ignore: shimWasm === null || !isSupported(),
  fn: async () => {
    const translator = await Translator.create(shimWasm!);
    const { plan, adapters } = translator.translate(asyncWasm);
    // This fixture needs suspension on its own (it imports
    // `waitable-set.wait`), so the instantiation is genuinely jspi-mode —
    // the only mode in which SYNC_ENTRY is attached at all.
    assert(
      planNeedsSuspension(plan),
      "fixture must need suspension: it imports waitable-set.wait",
    );
    const handle = await instantiateComponent({
      plan,
      componentBytes: asyncWasm,
      adapters,
      imports: { gate: () => Promise.resolve() },
    });
    const go = handle.exports.go as Fn;
    assertEquals(
      (go as unknown as Record<PropertyKey, unknown>)[SYNC_ENTRY],
      undefined,
      "an async-lifted export has no synchronous form and must carry none",
    );
  },
});
