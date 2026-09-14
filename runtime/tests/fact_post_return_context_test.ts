import { assertEq, assertTrap } from "./support/asserts.ts";
import { Trap } from "../src/cabi/trap.ts";
import { instantiateComponent } from "../src/exec/mod.ts";
import { Translator } from "../src/shim/mod.ts";

const root = new URL("../../", import.meta.url);
const shim = await Deno.readFile(
  new URL("target/wasm32-unknown-unknown/release/translator_shim.wasm", root),
);
const fixture = await Deno.readFile(
  new URL("fact_post_return_context.wasm", import.meta.url),
);

for (const jspi of [false, true]) {
  Deno.test(`FACT sync post-return retains callee restrictions (jspi=${jspi})`, async () => {
    const translator = await Translator.create(shim);
    const { plan, adapters } = translator.translate(fixture);
    const postReturnImports = plan.initializers.flatMap((init) => {
      if (init.op !== "instantiate-module" || init.instance !== null) return [];
      const module = plan.modules[init.module];
      if (module.kind !== "adapter") return [];
      return module.intrinsics.filter((entry) =>
        entry.module === "post_return"
      );
    });
    assertEq(postReturnImports.length, 1, "pinned FACT post_return imports");
    for (const entry of postReturnImports) assertEq(entry.def.kind, "export");
    const component = await instantiateComponent({
      plan,
      adapters,
      componentBytes: fixture,
      jspi,
    });
    const exports = component.exports as Record<
      string,
      (...a: unknown[]) => unknown
    >;

    // FACT restores the callee's saved context around post-return and then the
    // caller's context afterward; the wrapper changes neither task identity.
    assertEq(await exports.context(), 7);
    assertEq(await exports.seen(), 42);
    // The same core function is legal through its ordinary lifted export. The
    // post-return restriction belongs only to FACT's post_return import edge.
    assertEq(await exports.post(1), undefined);

    const run = () => exports.run();
    if (jspi) {
      let caught: unknown;
      try {
        await run();
      } catch (e) {
        caught = e;
      }
      assertEq(caught instanceof Trap, true, "expected rejected Trap");
      assertEq(
        String((caught as Error).message).includes(
          "cannot leave component instance",
        ),
        true,
      );
    } else {
      assertTrap(run, "cannot leave component instance");
    }
  });
}
