import { instantiate } from "../../src/embedder/mod.ts";
import type { EmbedderInstance } from "../../src/embedder/instantiate.ts";
import { Translator } from "../../src/shim/mod.ts";
import { isTrap, suspending } from "@polyengine/protocol";
import { assert, assertEquals, assertRejects } from "./asserts.ts";

const root = new URL("../../../", import.meta.url);
const shim = await Deno.readFile(
  new URL("target/wasm32-unknown-unknown/release/translator_shim.wasm", root),
);
const fixture = await Deno.readFile(
  new URL("../fixtures/thread-switch-matrix.wasm", import.meta.url),
);
const translator = await Translator.create(shim);

type Component = EmbedderInstance & { order: number[] };
type GateOptions = {
  childGate?: () => Promise<void>;
  holderGate?: () => Promise<void>;
};

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 1000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function fresh(
  onMark?: (value: number, component: Component) => void,
  gates: GateOptions = {},
) {
  const order: number[] = [];
  const holder: { current: Component | null } = { current: null };
  const instance = await instantiate(
    { componentBytes: fixture, ...translator.translate(fixture) },
    {
      mark(value: number) {
        order.push(value);
        assert(holder.current !== null, "component must be bound before mark");
        onMark?.(value, holder.current);
      },
      childGate: suspending(gates.childGate ?? (() => Promise.resolve())),
      holderGate: suspending(gates.holderGate ?? (() => Promise.resolve())),
    },
    { jspi: true },
  );
  const component = Object.assign(instance, { order });
  holder.current = component;
  return component;
}
async function run(
  name: string,
  expectedValue: number,
  expectedOrder: number[],
): Promise<void> {
  const component = await fresh();
  const value = await bounded(
    component.exports[name]() as Promise<number>,
    name,
  );
  assertEquals(value, expectedValue);
  assertEquals(JSON.stringify(component.order), JSON.stringify(expectedOrder));
}

Deno.test("real guest: suspend-then-resume target immediately resume-laters caller", async () => {
  await run("resumeLater", 101, [1, 10, 11]);
});

Deno.test("real guest: suspend-then-resume target immediately switches back", async () => {
  const component = await fresh();
  assertEquals(
    await bounded(
      component.exports.switchBack() as Promise<number>,
      "switch-back",
    ),
    102,
  );
  assertEquals(JSON.stringify(component.order), JSON.stringify([2, 20, 21]));
  assert(
    component.handle.componentInstances.some((inst) =>
      inst !== undefined &&
      [...inst.threads].some((thread) => thread.explicitlySuspended())
    ),
    "switch-back must leave the target child suspended",
  );
});

Deno.test("real guest: yield-then-resume promotes the ready caller", async () => {
  await run("yieldBack", 103, [3, 30, 31, 32]);
});

Deno.test("real guest: promote ignores suspended target and runs ready target first", async () => {
  await run("promote", 104, [4, 41, 40, 42]);
});

Deno.test("real guest: explicit child trap remains the original cause", async () => {
  const component = await fresh();
  const failure = await assertRejects(() =>
    bounded(component.exports.childTrap() as Promise<unknown>, "child-trap")
  );
  assert(
    isTrap(failure) && String(failure).includes("unreachable"),
    `expected original unreachable trap, got ${failure}`,
  );
});

Deno.test("real guest: normal last explicit child reports no async result", async () => {
  const component = await fresh();
  const failure = await assertRejects(() =>
    bounded(component.exports.childNormal() as Promise<unknown>, "child-normal")
  );
  assert(
    isTrap(failure) && String(failure).includes("without resolving"),
    `expected last-thread no-result trap, got ${failure}`,
  );
});

Deno.test("real guest: post-result ready child continues and suspended child is retained", async () => {
  const component = await fresh();
  assertEquals(
    await bounded(
      component.exports.postResult() as Promise<number>,
      "post-result",
    ),
    108,
  );
  await bounded(
    (async () => {
      while (!component.order.includes(80)) {
        await new Promise((r) => setTimeout(r, 0));
      }
    })(),
    "post-result child continuation",
  );
  assertEquals(JSON.stringify(component.order), JSON.stringify([80]));
  assert(
    component.handle.componentInstances.some((inst) =>
      inst !== undefined &&
      [...inst.threads].some((thread) => thread.explicitlySuspended())
    ),
    "post-result suspended child must remain registered",
  );
});
