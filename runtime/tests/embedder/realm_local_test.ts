// realm boundary realm-local pill (contracts/embedder-api.md §"Realm boundaries and
// structured-clone-safe forms"; issue #131): every stateful handle class
// installs an own, enumerable, string-keyed, function-valued property
// (`polyengine.realmLocal/1`) at construction, so a raw structuredClone or
// postMessage throws DataCloneError in the sender realm instead of
// delivering a husk. This file pins that backstop across every realm-local
// class this track owns, plus the realm boundary message-valued error-context
// lowering relaxation in values.ts.

import { assertEq } from "../support/asserts.ts";
import { caught, guest, haveFixture, instantiateFixture } from "./support.ts";
import {
  ErrorContext,
  Future,
  Stream,
  StreamWriter,
} from "../../src/embedder/streams.ts";
import { fromHost } from "../../src/embedder/values.ts";
import { hostFuture } from "../../src/exec/mod.ts";
import type { ComponentValue, ValType } from "../../src/cabi/types.ts";
import { ErrorContext as InternalErrorContext } from "../../src/task/mod.ts";

const ready = await haveFixture(guest("resources"));

async function assertDataCloneError(
  fn: () => unknown,
  label: string,
): Promise<void> {
  const e = await caught(fn);
  if (!(e instanceof DOMException) || e.name !== "DataCloneError") {
    throw new Error(
      `${label}: expected DataCloneError, got ${
        e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)
      }`,
    );
  }
}

Deno.test("realm boundary: a raw structuredClone of a Stream throws DataCloneError", async () => {
  const { stream } = Stream.create<number>();
  await assertDataCloneError(() => structuredClone(stream), "Stream");
});

Deno.test("realm boundary: a raw structuredClone of a StreamWriter throws DataCloneError", async () => {
  const { writer } = Stream.create<number>();
  assertEq(writer instanceof StreamWriter, true);
  await assertDataCloneError(() => structuredClone(writer), "StreamWriter");
});

Deno.test("realm boundary: a raw structuredClone of a Future throws DataCloneError", async () => {
  const codec = {
    element: { kind: "u32" } as ValType,
    toHost: (v: ComponentValue) => v as number,
    fromHost: (v: number) => v as ComponentValue,
  };
  const f = Future.fromHostFuture<number>(
    hostFuture<number>(codec.element),
    codec,
  );
  await assertDataCloneError(() => structuredClone(f), "Future");
});

Deno.test("realm boundary: a raw structuredClone of an embedder ErrorContext throws DataCloneError", async () => {
  const ctx = new ErrorContext(new InternalErrorContext("boom"));
  await assertDataCloneError(() => structuredClone(ctx), "ErrorContext");
});

Deno.test({
  name:
    "realm boundary: a raw structuredClone of a guest-resource wrapper throws DataCloneError",
  ignore: !ready,
  fn: async () => {
    const inst = await instantiateFixture(guest("resources"));
    const c = inst.exports["polyengine:resources/counters"];
    // deno-lint-ignore no-explicit-any
    const counter = new (c as any).Counter(5n);
    await assertDataCloneError(
      () => structuredClone(counter),
      "guest-resource wrapper",
    );
  },
});

Deno.test("realm boundary: the pill is buried — structuredClone descends into records/arrays", async () => {
  const { stream } = Stream.create<number>();
  await assertDataCloneError(
    () => structuredClone({ a: [{ b: stream }] }),
    "buried Stream",
  );
});

Deno.test("realm boundary: JSON.stringify and spread of a pilled ErrorContext still work (function values omitted, not thrown)", () => {
  const ctx = new ErrorContext(new InternalErrorContext("boom"));
  // The pill is a function-valued property; JSON.stringify silently omits
  // function values (no throw) and object spread copies an inert reference.
  const json = JSON.stringify(ctx);
  assertEq(JSON.parse(json).message, "boom");
  const spread = { ...ctx };
  assertEq(spread.message, "boom");
});

Deno.test("realm boundary: error-context lowering accepts a hand-rolled branded carrier with a string message", () => {
  const brandKey = Symbol.for("polyengine.errorContext/1");
  const carrier = { [brandKey]: true, message: "why" };
  const lowered = fromHost(
    carrier,
    { kind: "error-context" } as ValType,
    { where: "test" } as never,
  ) as unknown as InternalErrorContext;
  assertEq(lowered instanceof InternalErrorContext, true);
  assertEq(lowered.debugMessage, "why");
  // realm boundary: a NEW local context is minted, never "the same" one — there is
  // nothing to alias for a hand-rolled carrier that owns no host state.
  assertEq(lowered === (carrier as unknown as InternalErrorContext), false);
});

Deno.test("realm boundary: error-context lowering still refuses a branded carrier WITHOUT a string message", async () => {
  const brandKey = Symbol.for("polyengine.errorContext/1");
  const carrier = { [brandKey]: true, message: 42 };
  const e = await caught(() =>
    fromHost(
      carrier,
      { kind: "error-context" } as ValType,
      { where: "test" } as never,
    )
  );
  if (!(e instanceof TypeError)) {
    throw new Error(`expected TypeError, got ${e}`);
  }
  const m = String((e as Error).message);
  if (!m.includes("DIFFERENT polyengine runtime copy")) {
    throw new Error(`expected the loud cross-copy refusal, got: ${m}`);
  }
});
