// Import-analysis: translate-only enumeration (gate 3) — a suite's import
// surface can be inspected without ever instantiating it.

import { assertEq } from "../../runtime/tests/support/asserts.ts";
import { Translator } from "../../runtime/src/shim/mod.ts";
import { NameCollisionError } from "../../runtime/src/embedder/mod.ts";
import {
  analyzeImports,
  MissingImportsError,
  requireImportsResolved,
} from "../src/import-analysis.ts";
import { TEST_CONTEXT_INTERFACE, testContextImportRecord } from "../src/context.ts";
import { artifactsOf, haveFixture, TEST_SUITE_WASM } from "./support.ts";

const ready = await haveFixture(TEST_SUITE_WASM);

Deno.test({
  name: "import-analysis: the suite fixture imports test-context, nothing else",
  ignore: !ready,
  fn: async () => {
    const artifacts = await artifactsOf(TEST_SUITE_WASM);
    const a = analyzeImports(artifacts.plan, {});
    assertEq(a.requiresTestContext, true);
    assertEq(a.missing, []);
    assertEq(
      a.leaves.some((l) => l.interfaceId === TEST_CONTEXT_INTERFACE),
      true,
    );
  },
});

Deno.test({
  name: "import-analysis: explicitly providing test-context is a collision",
  ignore: !ready,
  fn: async () => {
    const artifacts = await artifactsOf(TEST_SUITE_WASM);
    let threw: unknown;
    try {
      requireImportsResolved(artifacts.plan, {
        ...testContextImportRecord(),
      });
    } catch (e) {
      threw = e;
    }
    assertEq(threw instanceof NameCollisionError, true, `${threw}`);
  },
});

// ---------------------------------------------------------------------------
// Gate 3: prebuilt polymorph-websocket conformance suite, translate-only.
// Its SUT imports need the websocket host port; DO NOT execute it. Just verify
// the runner's import-analysis correctly names what's missing.
// ---------------------------------------------------------------------------

const WS_SUITE =
  "/home/lmartin/p/polymorph/polymorph-websocket/target/wasm32-wasip2/release/conformance_guest_ct.wasm";

async function haveWebsocketSuite(): Promise<boolean> {
  try {
    await Deno.stat(WS_SUITE);
    return true;
  } catch {
    return false;
  }
}
const wsReady = await haveWebsocketSuite();

Deno.test({
  name:
    "import-analysis (gate 3): the websocket conformance suite, translate-only",
  ignore: !wsReady,
  fn: async () => {
    const shimWasm = await Deno.readFile(
      new URL(
        "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
        import.meta.url,
      ),
    );
    const translator = await Translator.create(shimWasm);
    const bytes = await Deno.readFile(WS_SUITE);
    const { plan } = translator.translate(bytes);

    const analysis = analyzeImports(plan, {});
    // The suite's SUT surface (polymorph:websocket) needs a host port, which
    // this dispatch explicitly does not build; requiredImports() must name
    // it (and anything else unresolved) rather than silently accepting or
    // crashing.
    assertEq(analysis.missing.length > 0, true, "expected unresolved leaves");
    assertEq(
      analysis.missing.some((m) => m.includes("polymorph:websocket")),
      true,
      `expected a polymorph:websocket leaf among: ${analysis.missing.join(", ")}`,
    );

    let threw: unknown;
    try {
      requireImportsResolved(plan, {});
    } catch (e) {
      threw = e;
    }
    assertEq(threw instanceof MissingImportsError, true, `${threw}`);
    const err = threw as MissingImportsError;
    assertEq(err.missing.length > 0, true);
    // Names the leaves, not just a count.
    for (const m of err.missing) {
      assertEq(typeof m, "string");
      assertEq(m.length > 0, true);
    }
  },
});
