import { instantiate } from "../../src/embedder/mod.ts";
import { Translator } from "../../src/shim/mod.ts";
import { isTrap } from "@polyengine/protocol";
import { assert, assertEquals, assertRejects } from "./asserts.ts";

const root = new URL("../../../", import.meta.url);
const shim = await Deno.readFile(
  new URL("target/wasm32-unknown-unknown/release/translator_shim.wasm", root),
);
const fixture = await Deno.readFile(
  new URL("../fixtures/nested-sync-yield.wasm", import.meta.url),
);
const translator = await Translator.create(shim);

async function fresh() {
  return await instantiate(
    {
      componentBytes: fixture,
      ...translator.translate(fixture),
    },
    {},
    { jspi: true },
  );
}

Deno.test("physical caller owns a nested sync callee's successful yield resumption", async () => {
  const component = await fresh();
  assertEquals(await component.exports.run(0), 42);
  for (const inst of component.handle.componentInstances) {
    if (inst === undefined) continue;
    assertEquals(
      [...inst.threads].length,
      0,
      "successful call leaked instance threads",
    );
  }
});

Deno.test("physical caller owns a nested sync callee's trapping yield resumption", async () => {
  const component = await fresh();
  const failure = await assertRejects(
    () => component.exports.run(1) as Promise<unknown>,
  );
  assert(
    isTrap(failure) && String(failure).includes("unreachable"),
    `expected unreachable Trap, got ${failure}`,
  );
  assertEquals(
    component.handle.componentInstances.some((inst) =>
      inst !== undefined &&
      [...inst.threads].some((thread) => thread.physicalOwner !== thread)
    ),
    false,
    "trapping call leaked synthetic instance threads",
  );
});
