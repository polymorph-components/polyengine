// The parking kernel through a REAL guest frame (testdata/blocking-guest.wat):
// a sync export parks its own wasm stack on a timer pollable — via
// `pollable.block` (a suspending-marked host-resource method) and via `poll` (a
// suspending-marked plain import whose list result exercises guest realloc at
// resume time).
//
// FAIL-ON-PRE-FIX: under the retired always-ready stubs this guest
// returned instantly without sleeping (the livelock shape) — the
// elapsed-time assertions are the pin. Under `jspi: false` the park is
// refused cleanly at the park site (NeedsJspi), never livelocked.

import { assertEq, assertTrue } from "./asserts.ts";
import { Translator } from "@polyengine/runtime/shim";
import { instantiate } from "@polyengine/runtime/embedder";
import { wasi } from "../src/mod.ts";

const SHIM_WASM = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
  import.meta.url,
);
const FIXTURE = new URL("testdata/blocking-guest.wasm", import.meta.url);

async function readIfPresent(url: URL): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(url);
  } catch {
    return null;
  }
}

const shimBytes = await readIfPresent(SHIM_WASM);
const componentBytes = await readIfPresent(FIXTURE);
const ready = shimBytes !== null && componentBytes !== null;

async function boot(opts: { jspi?: boolean } = {}) {
  const translator = await Translator.create(shimBytes!);
  return await instantiate(
    { componentBytes: componentBytes!, translator },
    { ...wasi() },
    opts,
  );
}

const NAP_NS = 80_000_000n; // 80ms
const MIN_ELAPSED_MS = 60; // generous CI slack; pre-fix behavior was ~0ms

Deno.test({
  name: "blocking guest: pollable.block parks the frame for the full duration",
  ignore: !ready,
  fn: async () => {
    const c = await boot();
    const t0 = performance.now();
    assertEq(await c.exports.nap(NAP_NS), 1);
    const elapsed = performance.now() - t0;
    assertTrue(
      elapsed >= MIN_ELAPSED_MS,
      `nap returned after ${elapsed}ms — the livelock shape (pre-fix: ~0ms)`,
    );
  },
});

Deno.test({
  name: "blocking guest: poll parks, wakes, and lowers its ready list through guest realloc",
  ignore: !ready,
  fn: async () => {
    const c = await boot();
    const t0 = performance.now();
    assertEq(await c.exports.napPoll(NAP_NS), 1, "one ready index");
    const elapsed = performance.now() - t0;
    assertTrue(
      elapsed >= MIN_ELAPSED_MS,
      `nap-poll returned after ${elapsed}ms — the livelock shape (pre-fix: ~0ms)`,
    );
  },
});

Deno.test({
  name: "blocking guest: jspi:false refuses the park cleanly instead of livelocking",
  ignore: !ready,
  fn: async () => {
    const c = await boot({ jspi: false });
    let raised: unknown;
    try {
      await c.exports.nap(NAP_NS);
    } catch (e) {
      raised = e;
    }
    assertTrue(raised !== undefined, "expected the park to be refused");
    assertTrue(
      String(raised).includes("must block"),
      `refusal names the blocked frame, got: ${raised}`,
    );
  },
});
