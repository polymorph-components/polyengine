import { instantiate } from "../../src/embedder/mod.ts";
import { Translator } from "../../src/shim/mod.ts";
import { isTrap, suspending } from "@polyengine/protocol";
import { assert, assertEquals, assertRejects } from "./asserts.ts";

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
if (shimWasm === null) {
  console.warn(
    "SKIP task.return settlement: missing translator_shim.wasm " +
      "(cargo build -p translator-shim --release --target wasm32-unknown-unknown)",
  );
}
const componentBytes = await Deno.readFile(
  new URL("./fixtures/task-return-settlement.wasm", import.meta.url),
);

Deno.test({
  name:
    "#323: task.return settles before a producer's genuine JSPI suspension ends",
  ignore: shimWasm === null,
  fn: async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const continued = Promise.withResolvers<void>();
    const translator = await Translator.create(shimWasm!);
    const translated = translator.translate(componentBytes);
    let probeEntered = false;
    const component = await instantiate({
      componentBytes,
      ...translated,
    }, {
      "before-gate": () => Promise.resolve(),
      hop: suspending(() => undefined),
      gate: () => {
        entered.resolve();
        return gate.promise;
      },
      continued: () => continued.resolve(),
      "probe-entered": () => void (probeEntered = true),
    });

    const result = component.exports.run() as Promise<number>;
    try {
      await entered.promise;
      const early = await Promise.race([
        result.then((value) => ({ state: "resolved", value })),
        new Promise<{ state: "pending" }>((resolve) =>
          setTimeout(() => resolve({ state: "pending" }), 50)
        ),
      ]);
      assertEquals(
        JSON.stringify(early),
        JSON.stringify({ state: "resolved", value: 42 }),
        "task.return result was withheld behind the producer gate",
      );
    } finally {
      // Never strand the real JSPI activation when an assertion fails.
      gate.resolve();
    }

    // Observe work after the suspension independently of the settled export.
    await continued.promise;
    assertEquals(await result, 42);

    // The producer traps after continuation. The export result stays delivered,
    // while the failure is retained and surfaced by subsequent entry.
    const later = await assertRejects(
      () => component.exports.probe() as Promise<unknown>,
      "post-delivery producer failure must reach a later entry",
    );
    assertEquals(
      probeEntered,
      false,
      "retained poison must precede probe entry",
    );
    assert(
      isTrap(later) && String(later).includes("unreachable"),
      `expected the original branded producer trap, got ${later}`,
    );
  },
});

Deno.test({
  name: "#323: a late host rejection remains observable after result delivery",
  ignore: shimWasm === null,
  fn: async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const boom = new Error("late gate rejection");
    let probeEntered = false;
    const translator = await Translator.create(shimWasm!);
    const component = await instantiate({
      componentBytes,
      ...translator.translate(componentBytes),
    }, {
      "before-gate": () => Promise.resolve(),
      hop: suspending(() => undefined),
      gate: () => {
        entered.resolve();
        return gate.promise;
      },
      continued: () => {
        throw new Error("continued after rejected gate");
      },
      "probe-entered": () => void (probeEntered = true),
    });

    const result = component.exports.run() as Promise<number>;
    try {
      await entered.promise;
      const early = await Promise.race([
        result.then((value) => ({ state: "resolved", value })),
        new Promise<{ state: "pending" }>((resolve) =>
          setTimeout(() => resolve({ state: "pending" }), 50)
        ),
      ]);
      assertEquals(
        JSON.stringify(early),
        JSON.stringify({ state: "resolved", value: 42 }),
      );
    } finally {
      gate.reject(boom);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    const later = await assertRejects(
      () => component.exports.probe() as Promise<unknown>,
      "late host rejection must reach a later entry",
    );
    assert(
      isTrap(later) && String(later).includes(boom.message),
      `expected the branded host rejection with its original cause, got ${later}`,
    );
    assertEquals(
      probeEntered,
      true,
      "the probe entered before the resumed producer's rejection surfaced",
    );
  },
});

Deno.test({
  name: "#323: task.return after one suspension settles at the next suspension",
  ignore: shimWasm === null,
  fn: async () => {
    const before = Promise.withResolvers<void>();
    const after = Promise.withResolvers<void>();
    const enteredBefore = Promise.withResolvers<void>();
    const enteredAfter = Promise.withResolvers<void>();
    const continued = Promise.withResolvers<void>();
    const translator = await Translator.create(shimWasm!);
    const component = await instantiate({
      componentBytes,
      ...translator.translate(componentBytes),
    }, {
      "before-gate": () => {
        enteredBefore.resolve();
        return before.promise;
      },
      hop: suspending(() => undefined),
      gate: () => {
        enteredAfter.resolve();
        return after.promise;
      },
      continued: () => continued.resolve(),
      "probe-entered": () => {},
    });

    const result = component.exports.run() as Promise<number>;
    try {
      await enteredBefore.promise;
      before.resolve();
      await enteredAfter.promise;
      const early = await Promise.race([
        result.then((value) => ({ state: "resolved", value })),
        new Promise<{ state: "pending" }>((resolve) =>
          setTimeout(() => resolve({ state: "pending" }), 50)
        ),
      ]);
      assertEquals(
        JSON.stringify(early),
        JSON.stringify({ state: "resolved", value: 42 }),
      );
    } finally {
      before.resolve();
      after.resolve();
    }
    await continued.promise;
  },
});
