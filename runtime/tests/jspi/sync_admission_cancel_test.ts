import { instantiate } from "../../src/embedder/mod.ts";
import { Translator } from "../../src/shim/mod.ts";
import { isTrap } from "@polyengine/protocol";
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import { ambientResidue } from "../../src/task/scheduler.ts";

const root = new URL("../../../", import.meta.url);
const shim = await Deno.readFile(
  new URL("target/wasm32-unknown-unknown/release/translator_shim.wasm", root),
);
const fixture = await Deno.readFile(
  new URL("../fixtures/sync-admission-cancel.wasm", import.meta.url),
);
const translator = await Translator.create(shim);

async function fresh() {
  return await instantiate(
    { componentBytes: fixture, ...translator.translate(fixture) },
    {},
    { jspi: true },
  );
}

function clearPressureLater(
  component: Awaited<ReturnType<typeof fresh>>,
): void {
  setTimeout(() => component.exports.clearPressure(), 0);
}

function assertNoSyntheticThreads(
  component: Awaited<ReturnType<typeof fresh>>,
): void {
  assertEquals(
    component.handle.componentInstances.some((inst) =>
      inst !== undefined &&
      [...inst.threads].some((thread) => thread.physicalOwner !== thread)
    ),
    false,
    "call leaked synthetic instance threads",
  );
  const stores = new Set(
    component.handle.componentInstances.filter((inst) => inst !== undefined)
      .map((inst) => inst.store),
  );
  for (const store of stores) {
    assertEquals(
      store.pendingResumptions.size,
      0,
      "call leaked a pending claim",
    );
  }
  assertEquals(
    JSON.stringify(ambientResidue()),
    JSON.stringify({ stack: 0, claim: false }),
    "call leaked ambient attribution",
  );
}

Deno.test("deferred sync admission preserves caller through callee yield", async () => {
  const component = await fresh();
  component.exports.setPressure();
  const result = component.exports.run(0) as Promise<number>;
  clearPressureLater(component);
  assertEquals(await result, 7);
  assertNoSyntheticThreads(component);
});

Deno.test("deferred sync admission cleans a callee trapping after yield", async () => {
  const component = await fresh();
  component.exports.setPressure();
  const result = component.exports.run(1) as Promise<number>;
  clearPressureLater(component);
  const failure = await assertRejects(() => result);
  assert(
    isTrap(failure) && String(failure).includes("unreachable"),
    `expected unreachable Trap, got ${failure}`,
  );
  assertNoSyntheticThreads(component);
});

Deno.test("sync admission leaves outer cancellation pending", async () => {
  const component = await fresh();
  component.exports.setPressure();
  const result = component.exports.runCancel() as Promise<number>;
  clearPressureLater(component);
  assertEquals(await result, 7);
  assertNoSyntheticThreads(component);
});
