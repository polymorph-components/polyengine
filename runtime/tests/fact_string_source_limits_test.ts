import { Translator } from "../src/shim/translator.ts";
import { instantiateComponent } from "../src/exec/mod.ts";
import { Trap } from "../src/cabi/mod.ts";
import { assertEq } from "./support/asserts.ts";

const translator = await Translator.create(
  await Deno.readFile(
    new URL("../../translator/translator_shim.wasm", import.meta.url),
  ),
);
const componentBytes = await Deno.readFile(
  new URL("./fixtures/fact-string-source-limits.wasm", import.meta.url),
);
const translated = translator.translate(componentBytes);
const MAX = 2 ** 28 - 1;
const TAG = 2 ** 31;

async function probe(name: string, ptr: number, len: number, trapped: boolean) {
  const instance = await instantiateComponent({
    ...translated,
    componentBytes,
  });
  const sink = instance.coreInstances.find((i) =>
    i.exports["allocation-count"]
  );
  if (!sink) throw new Error("missing production realloc counter");
  let result: unknown;
  let didTrap = false;
  try {
    result = await (instance.exports[name] as (...args: number[]) => unknown)(
      ptr,
      len,
    );
  } catch (e) {
    if (!(e instanceof Trap)) throw e;
    didTrap = true;
  }
  assertEq(didTrap, trapped, `${name}(${ptr},${len}) trap`);
  return {
    result,
    calls: (sink.exports["allocation-count"] as WebAssembly.Global).value,
    bytes: (sink.exports["allocation-size"] as WebAssembly.Global).value,
  };
}

// Every destination for UTF-8, UTF-16, and both compact source tag paths.
for (
  const [names, width, tag] of [
    ["abc", 1, 0],
    ["def", 2, 0],
    ["ghi", 1, 0],
    ["ghi", 2, TAG],
  ] as const
) {
  for (const name of names) {
    Deno.test(`FACT source limit: ${name}, width=${width}, tag=${tag}`, async () => {
      const maxUnits = Math.floor(MAX / width);
      assertEq(
        (await probe(name, 0, tag + maxUnits + 1, true)).calls,
        0,
        "oversized source rejected BEFORE guest realloc",
      );
      const atLimit = await probe(name, 0, tag + maxUnits, true);
      assertEq(
        atLimit.calls,
        1,
        "valid source reaches realloc, then destination bounds trap",
      );
      if (name === "b" || name === "h") {
        assertEq(
          atLimit.bytes,
          2 * maxUnits,
          "destination expansion is not source byte length",
        );
      }
      assertEq((await probe(name, 64, tag, false)).result, 0, "empty string");
      assertEq(
        (await probe(name, 64, tag + 1, false)).result,
        1,
        "one zero code unit",
      );
    });
  }
}

Deno.test("FACT source limit: transcode retry paths remain valid", async () => {
  for (
    const [name, ptr, len, result, calls] of [
      ["b", 0, 2, 1, 2], // UTF-8 -> UTF-16, shrink pessimistic allocation
      ["c", 0, 2, TAG + 1, 3], // UTF-8 -> compact, inflate then shrink
      ["d", 16, 1, 2, 3], // UTF-16 -> UTF-8, grow then shrink
      ["f", 16, 1, TAG + 1, 2], // UTF-16 -> compact, inflate
      ["g", 32, 1, 2, 2], // Latin-1 -> UTF-8, grow
      ["g", 16, TAG + 1, 2, 3], // compact UTF-16 -> UTF-8
      ["i", 16, TAG + 1, TAG + 1, 1], // compact UTF-16 stays wide
    ] as const
  ) {
    const got = await probe(name, ptr, len, false);
    assertEq([got.result, got.calls], [result, calls]);
  }
});
