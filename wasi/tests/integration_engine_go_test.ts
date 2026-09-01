// Integration gate 3: `engine-go/main.wasm` (componentize-go, ~8MB, carries
// the full p2 baseline) instantiates cleanly with `wasi()` alone, and
// its `version()` export (no params, no polymorph imports) succeeds.
//
// This component is also the regression guard for the embedder facade's
// during-instantiation import ordering: Go's runtime calls
// `monotonic-clock.now()` from `schedinit`, which runs inside
// `instantiateComponent`. See the note at the assertion below.
//
// Every OTHER export on this component needs session/connection setup
// first (`[static]session.connect`, `[static]ssh-session.connect`, …), so
// per the mission dispatch: "if every export needs setup, instantiation-only
// is the gate — state which." `version()` is the one exception: zero
// params, `-> string`, no setup — verified against `plan.exports` below.
//
// Skip-if-absent: the artifact is a real polymorph build product.

import { assertEq, assertTrue } from "./asserts.ts";
import { Translator } from "@polyengine/runtime/shim";
import { instantiate } from "@polyengine/runtime/embedder";
import { wasi } from "../src/mod.ts";

const ARTIFACT = "/home/lmartin/p/polymorph/experiment-mosh/engine-go/main.wasm";
const SHIM_WASM = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
  import.meta.url,
);

async function readIfPresent(path: string | URL): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

Deno.test({
  name: "integration: engine-go instantiates with wasi() and version() works",
  ignore: (await readIfPresent(ARTIFACT)) === null ||
    (await readIfPresent(SHIM_WASM)) === null,
  fn: async () => {
    const bytes = (await readIfPresent(ARTIFACT))!;
    const shimBytes = (await readIfPresent(SHIM_WASM))!;
    const translator = await Translator.create(shimBytes);
    const { plan, adapters } = translator.translate(bytes);

    // Confirm the "every other export needs setup" claim against the plan
    // itself, so this gate does not silently go stale if the artifact
    // changes: every lifted-func in every exported instance except
    // `version` is either a constructor/method/static on a resource
    // (session-shaped setup) — `version` is the only bare, zero-arg,
    // no-resource export.
    const bareZeroArgExports: string[] = [];
    for (const exp of plan.exports) {
      if (exp.kind !== "instance") continue;
      for (const e of exp.exports) {
        if (e.kind !== "lifted-func") continue;
        const ft = plan.types[e.type as number];
        if (ft?.kind === "func" && ft.params.length === 0) {
          bareZeroArgExports.push(`${exp.name}#${e.name}`);
        }
      }
    }
    assertEq(
      JSON.stringify(bareZeroArgExports),
      JSON.stringify(["experiment:mosh/engine#version"]),
      "version() is the only zero-arg export needing no session setup " +
        "(re-verify this gate's scope if this fails)",
    );

    // FIXED (was a known blocker). `engine-go`'s Go runtime calls
    // `wasi:clocks/monotonic-clock now()` synchronously from its own
    // `schedinit`, which the executor runs as part of `instantiateComponent`'s
    // module-start step — i.e. while `instantiate()` is still awaiting, before
    // `facade.bind(handle)`. The facade used to gate `#funcType` on `bind()`
    // having run, so ANY guest performing host calls during its own eager
    // initialization (Go's runtime does; it is not WASI-specific) could not be
    // instantiated through the embedder facade at all. The facade now converts
    // the plan itself and hands that same `LoadedPlan` to the executor, so its
    // import wrappers are fully functional from the first initializer onward.
    // This test is the regression guard.
    const instance = await instantiate(
      { plan, componentBytes: bytes, adapters },
      wasi(),
    );

    const engine = instance.exports["experiment:mosh/engine"] as {
      version(): Promise<string>;
    };
    assertTrue(
      typeof engine?.version === "function",
      "the engine interface must expose a camelCase `version`",
    );
    const version = await engine.version();
    assertTrue(
      typeof version === "string" && version.length > 0,
      `version() should return a non-empty string, got: ${JSON.stringify(version)}`,
    );
    assertTrue(
      version.includes("engine"),
      `version() should name the engine, got: ${JSON.stringify(version)}`,
    );
  },
});
