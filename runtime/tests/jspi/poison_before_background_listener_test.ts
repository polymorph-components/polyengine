import { instantiate } from "../../src/embedder/mod.ts";
import { Translator } from "../../src/shim/mod.ts";
import { isTrap, suspending } from "@polyengine/protocol";
import { assert, assertEquals } from "./asserts.ts";

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
    "SKIP poison-before-listener: missing translator_shim.wasm " +
      "(cargo build -p translator-shim --release --target wasm32-unknown-unknown)",
  );
}
const componentBytes = await Deno.readFile(
  new URL("./fixtures/poison-before-background-listener.wasm", import.meta.url),
);

type Outcome =
  | { state: "rejected"; error: unknown }
  | { state: "timed-out" };

async function rejectionWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value): never => {
          throw new Error(`expected rejection, got ${Deno.inspect(value)}`);
        },
        (error): Outcome => ({ state: "rejected", error }),
      ),
      new Promise<Outcome>((resolve) => {
        timer = setTimeout(
          () => resolve({ state: "timed-out" }),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

Deno.test({
  name:
    "#294: poison recorded before background listener rejects the idle export",
  ignore: shimWasm === null,
  fn: async () => {
    const gate = Promise.withResolvers<void>();
    let callbackEntered = false;
    let fEntered = false;
    type Exports = {
      e: () => Promise<number>;
      f: () => Promise<number>;
    };
    const exportsRef: { current?: Exports } = {};
    const translator = await Translator.create(shimWasm!);
    const component = await instantiate({
      componentBytes,
      ...translator.translate(componentBytes),
    }, {
      gate: () => gate.promise,
      hop: suspending(() => {
        queueMicrotask(() => void exportsRef.current!.f().catch(() => {}));
      }),
      "callback-entered": () => void (callbackEntered = true),
      "f-entered": () => void (fEntered = true),
    });
    const exports = component.exports as Exports;
    exportsRef.current = exports;

    const e = exports.e();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gate.resolve();

      const outcome = await rejectionWithin(e, 100);
      assert(
        outcome.state === "rejected",
        "E remained pending after its instance was poisoned",
      );
      assert(
        isTrap(outcome.error) && String(outcome.error).includes("unreachable"),
        `expected E's original branded unreachable trap, got ${outcome.error}`,
      );
      assertEquals(callbackEntered, true, "E callback did not reach its trap");
      assertEquals(fEntered, false, "F entered the poisoned guest");
    } finally {
      gate.resolve();
    }
  },
});
