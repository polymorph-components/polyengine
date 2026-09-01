// Cross-copy identity: the fast unit half of §"Module identity and @polyengine/protocol"'s pin
// (contracts/embedder-api.md §"Module identity and @polyengine/protocol"; issue
// #83). The end-to-end half — two REAL runtime copies, source + bundle — is
// tools/release-bundle/dual_copy_test.ts, which needs a bundle build; this
// file keeps the semantics covered inside `just test-runtime`.
//
// Technique: a "foreign copy" value is hand-rolled — the process-global brand
// on a prototype this copy has never seen. That is exactly what another
// copy's class provides, and it is a legal value shape by contract ("a
// hand-rolled object carrying the right brand is a legal value").

import { assertEq } from "../support/asserts.ts";

function assertTrue(cond: boolean, msg = ""): void {
  if (!cond) throw new Error(`expected true: ${msg}`);
}
import {
  copyCensus,
  registerRuntimeCopy,
  runtimeCopies,
} from "@polyengine/protocol";
import { COPY_URL, RUNTIME_VERSION } from "../../src/embedder/mod.ts";
import { lowerFutureSource, lowerStreamSource } from "../../src/embedder/streams.ts";
import { initWrapper, takeRep, wrapperState } from "../../src/embedder/resources.ts";
import { GuestResource } from "../../src/embedder/mod.ts";
import { fromHost } from "../../src/embedder/values.ts";

const CODEC = {
  element: { kind: "u32" } as const,
  toHost: (v: unknown) => v as number,
  fromHost: (v: number) => v as unknown as never,
};

/** A value carrying a brand but minted by nobody this copy knows. */
function foreign(brandKey: string, props: Record<string, unknown> = {}): object {
  class Foreign {}
  Object.defineProperty(Foreign.prototype, Symbol.for(brandKey), {
    value: true,
  });
  return Object.assign(new Foreign(), props);
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

Deno.test("module identity: importing the embedder registers this copy on the census", () => {
  const urls = runtimeCopies().map((c) => c.url);
  assertTrue(urls.includes(COPY_URL), "this copy registered itself");
  const me = runtimeCopies().find((c) => c.url === COPY_URL)!;
  assertEq(me.runtimeVersion, RUNTIME_VERSION);
  assertEq(me.protocolGeneration, 1);
});

Deno.test("module identity: RUNTIME_VERSION matches runtime/deno.json (no fs read at runtime)", async () => {
  const cfg = JSON.parse(
    await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
  );
  assertEq(RUNTIME_VERSION, cfg.version);
});

Deno.test("module identity: a foreign Stream is refused at lowering, not pumped as an iterable", () => {
  // The silent path module identity bans: without the brand check this object would fall
  // through to producer adaptation.
  const src = foreign("polyengine.stream/1", {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }),
  });
  const e = caught(() => lowerStreamSource(src as never, CODEC as never));
  assertTrue(e instanceof TypeError, `TypeError, got ${e}`);
  const m = String((e as Error).message);
  assertTrue(m.includes("DIFFERENT polyengine runtime copy"), m);
  assertTrue(m.includes(COPY_URL), "names this copy");
  assertTrue(m.includes("src.readable()"), "names the by-value remediation");
});

Deno.test("module identity: a foreign Future is refused, not silently adopted as a thenable", () => {
  const src = foreign("polyengine.future/1", {
    then: (ok: (v: number) => void) => ok(1),
  });
  const e = caught(() => lowerFutureSource(src as never, CODEC as never));
  assertTrue(e instanceof TypeError, `TypeError, got ${e}`);
  const m = String((e as Error).message);
  assertTrue(m.includes("DIFFERENT polyengine runtime copy"), m);
  assertTrue(m.includes("Promise.resolve(f)"), "names the by-value remediation");
});

Deno.test("module identity: a foreign error-context is named cross-copy, not 'expected an ErrorContext' (realm boundary: only without a string message)", () => {
  // realm boundary (contracts/embedder-api.md §"Error-context is message-valued";
  // issue #131): a branded carrier of a STRING message is now message-valued
  // and accepted (mints a fresh local context) — the loud cross-copy
  // refusal survives only for a branded carrier WITHOUT a string message,
  // which is a genuinely foreign stateful handle, not a message carrier.
  const v = foreign("polyengine.errorContext/1", { message: 42 });
  const e = caught(() =>
    fromHost(v, { kind: "error-context" } as never, { where: "export 'f'" } as never)
  );
  const m = String((e as Error).message);
  assertTrue(m.includes("DIFFERENT polyengine runtime copy"), m);
  assertTrue(!m.includes("expected an ErrorContext"), m);
});

Deno.test("module identity: an unbranded value at a handle site keeps its original diagnosis", () => {
  const e = caught(() =>
    fromHost({}, { kind: "error-context" } as never, { where: "export 'f'" } as never)
  );
  assertTrue(String((e as Error).message).includes("expected an ErrorContext"));
});

Deno.test("module identity: a foreign resource wrapper is named cross-copy, not 'not a resource handle'", () => {
  // Same brand KEY, a foreign copy's state object (whose SHAPE we must never
  // read — the module identity table pins only the key).
  const w = new GuestResource();
  (w as unknown as Record<symbol, unknown>)[Symbol.for("polyengine.resourceState/1")] = {
    copyUrl: "file:///some/other/copy/mod.ts",
    rep: 7,
    valid: true,
    owns: true,
  };
  assertEq(wrapperState(w), undefined, "a foreign wrapper has no state HERE");
  const e = caught(() => takeRep(w, false, "export 'f'"));
  const m = String((e as Error).message);
  assertEq((e as Error).name, "InvalidHandleError");
  assertTrue(m.includes("DIFFERENT polyengine runtime copy"), m);
  assertTrue(!m.includes("not a resource handle"), m);
  assertTrue(!m.includes("no longer valid"), m);
});

Deno.test("module identity: this copy's own wrappers are unaffected", () => {
  const w = new GuestResource();
  initWrapper(w, {
    rep: 3,
    valid: true,
    owns: false,
    lends: 0,
    pendingDrop: false,
    rt: {} as never,
    className: "R",
  });
  assertEq(wrapperState(w)?.rep, 3);
  assertEq(wrapperState(w)?.copyUrl, COPY_URL);
  assertEq(takeRep(w, false, "export 'f'"), 3);
});

Deno.test("module identity: a non-handle object still gets the plain diagnosis", () => {
  const e = caught(() => takeRep({}, false, "export 'f'"));
  assertTrue(String((e as Error).message).includes("not a resource handle"));
});

Deno.test("module identity: the census is empty for a single-copy graph and names both when not", () => {
  assertEq(copyCensus(), "", "the healthy graph adds nothing to any message");
  registerRuntimeCopy({
    url: "file:///fake/second/copy.mjs",
    runtimeVersion: "0.1.0",
    protocolGeneration: 1,
  });
  try {
    const c = copyCensus();
    assertTrue(c.startsWith("2 polyengine copies loaded: "), c);
    assertTrue(c.includes(COPY_URL) && c.includes("file:///fake/second/copy.mjs"), c);
    // And the cross-copy messages pick it up.
    const e = caught(() =>
      lowerStreamSource(foreign("polyengine.stream/1") as never, CODEC as never)
    );
    assertTrue(String((e as Error).message).includes("file:///fake/second/copy.mjs"));
  } finally {
    // Leave the census clean for the rest of the suite.
    const copies = (globalThis as unknown as Record<symbol, unknown[]>)[
      Symbol.for("polyengine.runtimeCopies/1")
    ];
    copies.length = copies.findIndex((c) =>
      (c as { url: string }).url === "file:///fake/second/copy.mjs"
    );
  }
});
