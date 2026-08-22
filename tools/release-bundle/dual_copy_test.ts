// THE dual-copy pin (contracts/embedder-api.md §"Module identity and
// @polyengine/protocol", amendment A9; issue #83).
//
// Two GENUINELY distinct runtime copies in one process:
//
//   copy A — the source tree (`runtime/src/embedder/mod.ts`);
//   copy B — the release bundle built by ./build.ts.
//
// The bundle is the second copy on purpose, and it is the *production* shape
// of the bug: two separately-built bundles on one page each embed a copy, and
// no resolution discipline can reach that case. Note that the obvious cheap
// trick — importing the same entry twice with different query strings — does
// NOT produce a second copy: the entry module is duplicated, but every
// relative import below it resolves to the same already-cached module, so the
// classes and symbols underneath are shared and every assertion here would
// pass vacuously.
//
// What is pinned: the census sees both copies; the STATELESS contract values
// (`ComponentException`, the `suspending` mark, hand-rolled brands) are honored across
// the boundary; the STATEFUL ones (`Stream`) are refused with a named
// cross-copy error rather than silently adapted; and an unbranded throw in a
// multi-copy graph says so.

import { buildBundle } from "./build.ts";
import {
  copyCensus,
  COPY_URL,
  instantiate,
  isSuspending,
  runtimeCopies,
  Stream,
  ComponentException,
} from "../../runtime/src/embedder/mod.ts";
import { lowerStreamSource } from "../../runtime/src/embedder/streams.ts";
import { Translator } from "../../runtime/src/shim/mod.ts";

const root = new URL("../../", import.meta.url);
const TRANSLATOR = new URL(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  root,
);
// `host:api/fallible.try-it: func() -> result<u32, string>`; the guest's
// `run()` returns the ok value, or `1000 + err.length` on the err side — so
// one number pins BOTH the case and the payload.
const FIXTURE = new URL("runtime/tests/embedder/host-result-payload.wasm", root);

async function present(url: URL): Promise<boolean> {
  try {
    await Deno.stat(url);
    return true;
  } catch {
    return false;
  }
}
const ready = (await present(TRANSLATOR)) && (await present(FIXTURE));

function assertEq<T>(got: T, want: T, msg?: string): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg ?? "mismatch"}: got ${g}, want ${w}`);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const CODEC = {
  element: { kind: "u32" } as const,
  toHost: (v: unknown) => v as number,
  fromHost: (v: number) => v as unknown as never,
};

Deno.test({
  name: "A9 dual-copy pin: source + bundle copies honor the brands and refuse foreign handles",
  ignore: !ready,
  fn: async () => {
    const out = await buildBundle();
    // deno-lint-ignore no-explicit-any
    const B: any = await import(new URL(`file://${out}`).href);

    // ---- 1. the census sees both copies -------------------------------
    const copies = runtimeCopies();
    assert(copies.length >= 2, `expected >= 2 copies, got ${copies.length}`);
    const urls = new Set(copies.map((c) => c.url));
    assertEq(urls.size, copies.length, "copy URLs are distinct");
    assert(urls.has(COPY_URL), "copy A (source) is registered");
    assert(
      [...urls].some((u) => u.endsWith(".mjs")),
      `copy B (bundle) is registered: ${[...urls].join(", ")}`,
    );
    // The bundle's own view of the registry is the SAME array (globalThis +
    // registry symbol), which is the mechanism the whole amendment rests on.
    assertEq(B.runtimeCopies().length, copies.length, "one shared registry");
    const census = copyCensus();
    assert(census.startsWith(`${copies.length} polyengine copies loaded: `), census);

    // ---- 2. copy B's ComponentException is a ComponentException to copy A ------------------
    const translator = await Translator.create(await Deno.readFile(TRANSLATOR));
    const componentBytes = await Deno.readFile(FIXTURE);
    const { plan, adapters } = translator.translate(componentBytes);
    const artifacts = { plan, componentBytes, adapters };
    const withImport = (tryIt: () => number) =>
      instantiate(artifacts, { "host:api/fallible": { tryIt } });

    assert(
      !(new B.ComponentException("boom") instanceof ComponentException),
      "premise: the two copies' classes are distinct",
    );
    const viaForeignClass = await withImport(() => {
      throw new B.ComponentException("boom");
    });
    assertEq(
      await viaForeignClass.exports.run(),
      1004,
      "copy B's ComponentException became the guest's err case with its payload intact",
    );

    // ---- 3. the suspending mark crosses ------------------------------
    const marked = B.suspending(() => 1);
    assertEq(isSuspending(marked), true, "copy A honors copy B's mark");
    assertEq(
      B.isSuspending(((f: () => number) => f)(Object.assign(() => 1, {}))),
      false,
      "…and does not see marks that are not there",
    );

    // ---- 4. a foreign STREAM handle is refused, loudly -----------------
    // Stateful: its machinery lives in copy B. Without the brand check it
    // would fall through to producer adaptation and be pumped by value.
    const { stream: foreignStream } = B.Stream.create();
    assert(
      !(foreignStream instanceof Stream),
      "premise: copy B's Stream is not copy A's Stream",
    );
    let refusal: unknown;
    try {
      lowerStreamSource(foreignStream, CODEC as never);
    } catch (e) {
      refusal = e;
    }
    assert(refusal instanceof TypeError, `expected a TypeError, got ${refusal}`);
    const m = String((refusal as Error).message);
    assert(m.includes("DIFFERENT polyengine runtime copy"), m);
    assert(m.includes("src.readable()"), `names the by-value remedy: ${m}`);
    for (const u of urls) assert(m.includes(u), `census names ${u}: ${m}`);

    // ---- 5. a hand-rolled brand is a ComponentException to copy A ----------------
    // The zero-import host-module path: no polyengine import anywhere.
    const viaHandRolled = await withImport(() => {
      throw Object.assign(new Error("x"), {
        [Symbol.for("polyengine.componentException/1")]: true,
        payload: "hand-rolled",
      });
    });
    assertEq(
      await viaHandRolled.exports.run(),
      1000 + "hand-rolled".length,
      "a hand-rolled brand IS a ComponentException (brands are markers, not gatekeepers)",
    );

    // ---- 6. an unbranded throw names the multi-copy hypothesis ---------
    const unbranded = await withImport(() => {
      throw new RangeError("nope");
    });
    let trapped: unknown;
    try {
      await unbranded.exports.run();
    } catch (e) {
      trapped = e;
    }
    const tm = String((trapped as Error)?.message);
    assert(tm.includes("unbranded throw"), tm);
    assert(tm.includes("polyengine copies loaded"), `census hint present: ${tm}`);
    assert(tm.includes("issue #83"), tm);
  },
});
