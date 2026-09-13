import { assert, assertEquals } from "./jspi/asserts.ts";
import { isTrap } from "@polyengine/protocol";
import { Translator } from "../src/shim/mod.ts";
import { instantiate } from "../src/embedder/mod.ts";

const root = new URL("../../", import.meta.url);
const shim = await Deno.readFile(
  new URL("target/wasm32-unknown-unknown/release/translator_shim.wasm", root),
);
const fixture = await Deno.readFile(
  new URL("./fixtures/two-instance-scheduler.wasm", import.meta.url),
);
const translator = await Translator.create(shim);

function deferred<T>() {
  return Promise.withResolvers<T>();
}

async function component(jspi: boolean, hostX: () => unknown) {
  const translated = translator.translate(fixture);
  return await instantiate({ componentBytes: fixture, ...translated }, {
    hostX,
    hostY: () => 1,
  }, { jspi }) as {
    exports: Record<string, (...args: unknown[]) => Promise<unknown>>;
  };
}

for (const jspi of [false, true]) {
  Deno.test(`#350 call completion ignores unrelated pending host work (jspi=${jspi})`, async () => {
    const gate = deferred<number>();
    const c = await component(jspi, () => gate.promise);
    const unrelated = c.exports.xCallHost();
    const next = c.exports.yNext();
    await Promise.resolve();
    assertEquals(await c.exports.yPush(9), undefined);
    assertEquals(await next, 9);
    gate.resolve(4);
    assertEquals(await unrelated, 4);
  });

  Deno.test(`#357 sibling trap is routed to its origin (jspi=${jspi})`, async () => {
    const gate = deferred<number>();
    const c = await component(jspi, () => gate.promise);
    await c.exports.xArmBad();
    const origin = c.exports.xCallHost();
    const healthy = c.exports.yNext();
    await Promise.resolve();
    gate.resolve(5);
    let failure: unknown;
    try {
      await origin;
    } catch (e) {
      failure = e;
    }
    assert(
      isTrap(failure),
      `originating call must reject with Trap: ${failure}`,
    );
    const beforePush = await Promise.race([
      healthy.then(() => "settled", () => "settled"),
      Promise.resolve("pending"),
    ]);
    assertEquals(beforePush, "pending", "healthy sibling remains pending");
    assertEquals(await c.exports.yPush(9), undefined);
    assertEquals(await healthy, 9);
    assertEquals(await c.exports.yPing(), 42);
  });

  Deno.test(`#357 FACT root survives another poisoned callee call (jspi=${jspi})`, async () => {
    const gate = deferred<number>();
    const c = await component(jspi, () => gate.promise);
    await c.exports.xArmBad();
    const unrelated = c.exports.xNext();
    const origin = c.exports.aCallX();
    await Promise.resolve();
    gate.resolve(5);

    let originFailure: unknown;
    let unrelatedFailure: unknown;
    try {
      await origin;
    } catch (e) {
      originFailure = e;
    }
    try {
      await unrelated;
    } catch (e) {
      unrelatedFailure = e;
    }
    assert(
      isTrap(originFailure),
      `FACT root must reject with Trap: ${originFailure}`,
    );
    assert(
      isTrap(unrelatedFailure),
      `callee sibling must reject: ${unrelatedFailure}`,
    );
  });
}
