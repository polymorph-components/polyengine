// `parseLeafName` unit tests: the mangled export/import name grammar
// (contracts/embedder-api.md §"Naming and casing") plus the unknown-bracket
// refusal mandated by the getters/setters pre-ruling (§"Getters and setters
// (pre-ruling, 2026-08-30 — not yet implementable)", final paragraph):
// "the runtime refuses unknown bracket forms in mangled names loudly at
// instantiation (rather than misbinding them as plain names…)".
//
// The known forms are already pinned end-to-end against real fixtures in
// `version_test.ts`; this file is the focused unit suite for the parser
// itself, in particular the negative space `version_test.ts` doesn't cover.

import { assertEq } from "../support/asserts.ts";
import { parseLeafName } from "../../src/embedder/casing.ts";

function throws(f: () => unknown): unknown {
  try {
    f();
    return undefined;
  } catch (e) {
    return e;
  }
}

Deno.test("parseLeafName: known forms still parse", () => {
  assertEq(parseLeafName("make-counter"), {
    form: "plain",
    name: "make-counter",
  });
  assertEq(parseLeafName("[constructor]counter"), {
    form: "constructor",
    resource: "counter",
  });
  assertEq(parseLeafName("[method]counter.increment"), {
    form: "method",
    resource: "counter",
    member: "increment",
  });
  assertEq(parseLeafName("[static]counter.merge"), {
    form: "static",
    resource: "counter",
    member: "merge",
  });
});

Deno.test("parseLeafName: unknown bracket forms are refused, not misbound", () => {
  for (
    const raw of [
      "[get]foo",
      "[set]foo",
      "[method][get]r.p",
      "[static][set]r.p",
      "[weird]x",
      "[async]f",
    ]
  ) {
    const e = throws(() => parseLeafName(raw));
    assertEq(e instanceof Error, true, `${raw}: expected a throw, got ${e}`);
    assertEq(
      String((e as Error).message).includes(raw),
      true,
      `${raw}: the raw name must appear in the message, got: ${
        (e as Error).message
      }`,
    );
  }
});

Deno.test("parseLeafName: malformed method/static (no dot) is also refused", () => {
  // `[method]counter` (no `.member`) matches MANGLED but not the dot-split;
  // it falls through to the same refusal as an unknown bracket tag.
  const e = throws(() => parseLeafName("[method]counter"));
  assertEq(e instanceof Error, true, `expected a throw, got ${e}`);
});
