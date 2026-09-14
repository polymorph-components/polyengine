// mapCoreException's layering rule (runtime/src/exec/boundary.ts): a real
// core-wasm trap surfaces as our `Trap` type carrying the engine's raw
// message, with the `guest trapped: ` provenance prefix intact — no
// translation to another host's wording (e.g. wasmtime's). Suite-wording
// normalization lives in the harness (`TRAP_MESSAGE_EQUIVALENTS`,
// harness/src/runner.ts), not here.

import { assertEq } from "./support/asserts.ts";
import { Trap } from "../src/cabi/mod.ts";
import {
  callCore,
  createLiftedFunction,
  createLoweredImport,
  newStats,
  type ResolvedOptions,
} from "../src/exec/boundary.ts";
import { adaptHostFunction } from "../src/exec/host_settlement.ts";
import {
  createTrampoline,
  type TrampolineContext,
} from "../src/intrinsics/mod.ts";
import {
  componentBoundaryTrapCarrier,
  ComponentInstanceState,
  raiseComponentBoundaryTrap,
  Store,
  takeComponentBoundaryTrap,
  withActivation,
} from "../src/task/mod.ts";
import { suspendingImport } from "../src/jspi/bridge.ts";

const WASM_JSPI = WebAssembly as unknown as {
  promising?: (fn: () => number) => () => Promise<number>;
  Suspending?: abstract new (fn: () => unknown) => unknown;
};

/** A real `WebAssembly.Module` whose sole export unconditionally traps. */
function unreachableCoreFn(): (...args: unknown[]) => unknown {
  const wat = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d, // \0asm
    0x01,
    0x00,
    0x00,
    0x00, // version 1
    // type section: () -> ()
    0x01,
    0x04,
    0x01,
    0x60,
    0x00,
    0x00,
    // function section: 1 function of type 0
    0x03,
    0x02,
    0x01,
    0x00,
    // export section: export "f" as function 0
    0x07,
    0x05,
    0x01,
    0x01,
    0x66,
    0x00,
    0x00,
    // code section: body = unreachable; end
    0x0a,
    0x05,
    0x01,
    0x03,
    0x00,
    0x00,
    0x0b,
  ]);
  const mod = new WebAssembly.Module(wat);
  const inst = new WebAssembly.Instance(mod, {});
  return inst.exports.f as (...args: unknown[]) => unknown;
}

Deno.test("callCore: a real core `unreachable` trap surfaces as a Trap with the raw engine message, provenance-prefixed", () => {
  const fn = unreachableCoreFn();
  let caught: unknown;
  try {
    callCore(fn as never, []);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Trap)) {
    throw new Error(`expected a Trap, got ${String(caught)}`);
  }
  // V8's own wording for this trap is exactly "unreachable" (see
  // harness/src/runner.ts TRAP_MESSAGE_EQUIVALENTS for the cross-engine
  // spellings); the runtime does not translate it to wasmtime's
  // "wasm trap: wasm `unreachable` instruction executed" — that
  // normalization is the harness's job now, not the runtime's.
  assertEq((caught as Trap).message, "guest trapped: unreachable");
});

/** A guest catch_all around an imported function. Returns 1 only if the
 * imported failure was incorrectly exposed as a catchable Wasm exception. */
function guestCatcher(imported: () => void): () => number {
  const bytes = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01,
    0x08,
    0x02,
    0x60,
    0x00,
    0x00,
    0x60,
    0x00,
    0x01,
    0x7f,
    0x02,
    0x06,
    0x01,
    0x00,
    0x01,
    0x66,
    0x00,
    0x00,
    0x03,
    0x02,
    0x01,
    0x01,
    0x07,
    0x07,
    0x01,
    0x03,
    0x72,
    0x75,
    0x6e,
    0x00,
    0x01,
    0x0a,
    0x14,
    0x01,
    0x12,
    0x00,
    0x02,
    0x40,
    0x1f,
    0x40,
    0x01,
    0x02,
    0x00,
    0x10,
    0x00,
    0x41,
    0x00,
    0x0f,
    0x0b,
    0x0b,
    0x41,
    0x01,
    0x0b,
  ]);
  const mod = new WebAssembly.Module(bytes);
  return new WebAssembly.Instance(mod, { "": { f: imported } }).exports
    .run as () => number;
}

Deno.test("component trap carrier bypasses guest catch_all and restores the activation-local cause", () => {
  const owner: {
    storage: number[];
    task: object;
  } = { storage: [], task: {} };
  const expected = new Trap("specific component trap");
  const run = guestCatcher(() => raiseComponentBoundaryTrap(expected));
  let caught: unknown;
  try {
    withActivation(owner, () => callCore(run as never, []));
  } catch (e) {
    caught = e;
  }
  assertEq(caught, expected);
});

Deno.test("component trap causes are isolated by physical activation", () => {
  const a = { storage: [], task: {} };
  const b = { storage: [], task: {} };
  const causeA = new Trap("A");
  const causeB = new Trap("B");
  const runA = guestCatcher(() => raiseComponentBoundaryTrap(causeA));
  const runB = guestCatcher(() => raiseComponentBoundaryTrap(causeB));
  let caughtA: unknown;
  let caughtB: unknown;
  try {
    withActivation(a, () => callCore(runA as never, []));
  } catch (e) {
    caughtA = e;
  }
  try {
    withActivation(b, () => callCore(runB as never, []));
  } catch (e) {
    caughtB = e;
  }
  assertEq(caughtA, causeA);
  assertEq(caughtB, causeB);
});

Deno.test("logical activations record the physical owner without losing their identity", () => {
  const physical = { storage: [], task: {} };
  const logical = { storage: [], task: {}, physicalOwner: physical };
  const cause = new Trap("logical");
  const carrier = componentBoundaryTrapCarrier(cause, logical);
  const recovered = takeComponentBoundaryTrap(carrier);
  assertEq(recovered?.cause, cause);
  assertEq(recovered?.owner, physical);
  assertEq(recovered?.logicalOwner, logical);
});

Deno.test("actual trampoline rethrows A's carrier under ambient B without reattribution", () => {
  const physicalA = { storage: [], task: {} };
  const logicalA = { storage: [], task: {}, physicalOwner: physicalA };
  const physicalB = { storage: [], task: {} };
  const logicalB = { storage: [], task: {}, physicalOwner: physicalB };
  const cause = new Trap("A cause");
  const carrierA = componentBoundaryTrapCarrier(cause, logicalA);
  const trampoline = createTrampoline(
    { kind: "lower-import", lowered: 0, options: 0, type: 0 } as never,
    {
      trapScope: {},
      loweredImport: () => () => {
        throw carrierA;
      },
    } as unknown as TrampolineContext,
  );

  let carrierB: unknown;
  try {
    withActivation(logicalB, () => trampoline());
  } catch (e) {
    carrierB = e;
  }
  const recovered = takeComponentBoundaryTrap(carrierB);
  assertEq(recovered?.cause, cause);
  assertEq(recovered?.owner, physicalA);
  assertEq(recovered?.logicalOwner, logicalA);
  assertEq(takeComponentBoundaryTrap(carrierA), undefined);
});

Deno.test("carrier recovery is exact, order-independent, and supports undefined causes", () => {
  const a = { storage: [], task: {} };
  const b = { storage: [], task: {} };
  const carrierA = componentBoundaryTrapCarrier(undefined, a);
  const causeB = new Trap("B");
  const carrierB = componentBoundaryTrapCarrier(causeB, b);

  assertEq(
    takeComponentBoundaryTrap(new WebAssembly.RuntimeError("unrelated")),
    undefined,
  );
  const recoveredB = takeComponentBoundaryTrap(carrierB);
  const recoveredA = takeComponentBoundaryTrap(carrierA);
  assertEq(recoveredB?.cause, causeB);
  assertEq(recoveredB?.owner, b);
  assertEq(recoveredB?.logicalOwner, b);
  assertEq(recoveredA !== undefined, true);
  assertEq(recoveredA?.cause, undefined);
  assertEq(recoveredA?.owner, a);
  assertEq(recoveredA?.logicalOwner, a);
  assertEq(takeComponentBoundaryTrap(carrierA), undefined);
});

Deno.test("same-owner carriers remain independently attributable", () => {
  const owner = { storage: [], task: {} };
  const causeA = new Trap("first");
  const causeB = new Trap("second");
  const carrierA = componentBoundaryTrapCarrier(causeA, owner);
  const carrierB = componentBoundaryTrapCarrier(causeB, owner);
  assertEq(takeComponentBoundaryTrap(carrierB)?.cause, causeB);
  assertEq(takeComponentBoundaryTrap(carrierA)?.cause, causeA);
});

Deno.test("a suppressed carrier cannot contaminate a later unrelated RuntimeError", () => {
  const owner = { storage: [], task: {} };
  componentBoundaryTrapCarrier(new Trap("suppressed"), owner);
  let caught: unknown;
  try {
    withActivation(owner, () => callCore(unreachableCoreFn() as never, []));
  } catch (e) {
    caught = e;
  }
  assertEq(caught instanceof Trap, true);
  assertEq((caught as Trap).message, "guest trapped: unreachable");
});

Deno.test("nested barriers transfer an undefined cause instead of replacing it", () => {
  const owner = { storage: [], task: {} };
  const first = componentBoundaryTrapCarrier(undefined, owner);
  const firstRecord = takeComponentBoundaryTrap(first);
  assertEq(firstRecord !== undefined, true);
  const second = componentBoundaryTrapCarrier(firstRecord!.cause, owner);
  const recovered = takeComponentBoundaryTrap(second);
  assertEq(recovered !== undefined, true);
  assertEq(recovered?.cause, undefined);
});

Deno.test({
  name: "rejected Suspending import resumes as an uncatchable native trap",
  ignore: typeof WASM_JSPI.promising !== "function" ||
    typeof WASM_JSPI.Suspending !== "function",
  fn: async () => {
    const owner = { storage: [], task: {} };
    const cause = new Trap("rejected import");
    const imported = suspendingImport(() => Promise.reject(cause), "jspi");
    const run = guestCatcher(imported as unknown as () => void);
    let rejection: unknown;
    try {
      await withActivation(owner, () => WASM_JSPI.promising!(run)());
    } catch (e) {
      rejection = e;
    }
    // A catchable rejection makes the guest return 1 instead.
    const recovered = takeComponentBoundaryTrap(rejection);
    assertEq(recovered?.cause, cause);
    assertEq(recovered?.owner, owner);
  },
});

Deno.test({
  name:
    "rejected sync lower crosses its real trampoline as an uncatchable trap",
  ignore: typeof WASM_JSPI.promising !== "function" ||
    typeof WASM_JSPI.Suspending !== "function",
  fn: async () => {
    const inst = new ComponentInstanceState(0, new Store());
    const lowerOpts: ResolvedOptions = {
      stringEncoding: "utf8",
      memory: null,
      realloc: null,
      postReturn: null,
      callback: null,
      async: false,
      cancellable: false,
      coreType: { params: [], results: [] },
      instance: inst,
    };
    const cause = new Error("host rejection");
    const lower = createLoweredImport({
      name: "rejecting",
      ft: { params: [], results: [] },
      opts: lowerOpts,
      hostFn: adaptHostFunction(() => Promise.reject(cause)),
      stats: newStats(),
      mode: "jspi",
      suspendable: true,
      deferCancel: false,
      abortable: false,
    });
    const trampoline = createTrampoline(
      { kind: "lower-import", lowered: 0, options: 0, type: 0 } as never,
      {
        trapScope: {},
        loweredImport: () => lower,
      } as unknown as TrampolineContext,
    );
    const guest = guestCatcher(
      suspendingImport(trampoline as never, "jspi") as unknown as () => void,
    );
    const lifted = createLiftedFunction({
      name: "run",
      ft: { params: [], results: [{ kind: "u32" }] },
      opts: {
        ...lowerOpts,
        coreType: { params: [], results: ["i32"] },
      },
      core: guest as never,
      stats: newStats(),
      suspensionMode: "jspi",
    });

    let rejection: unknown;
    try {
      await lifted();
    } catch (e) {
      rejection = e;
    }
    // If the rejected host Promise crossed as a catchable JS exception, the
    // guest returns 1 and this call fulfills instead.
    assertEq(rejection, cause);
  },
});

Deno.test({
  name:
    "abandoned sync lower crosses its real trampoline as an uncatchable trap",
  ignore: typeof WASM_JSPI.promising !== "function" ||
    typeof WASM_JSPI.Suspending !== "function",
  fn: async () => {
    const store = new Store();
    const inst = new ComponentInstanceState(0, store);
    const lowerOpts: ResolvedOptions = {
      stringEncoding: "utf8",
      memory: null,
      realloc: null,
      postReturn: null,
      callback: null,
      async: false,
      cancellable: false,
      coreType: { params: [], results: [] },
      instance: inst,
    };
    const cause = new Error("abandoned import");
    const lower = createLoweredImport({
      name: "abandoned",
      ft: { params: [], results: [] },
      opts: lowerOpts,
      hostFn: adaptHostFunction(() => new Promise(() => {})),
      stats: newStats(),
      mode: "jspi",
      suspendable: true,
      deferCancel: false,
      abortable: false,
    });
    const trampoline = createTrampoline(
      { kind: "lower-import", lowered: 0, options: 0, type: 0 } as never,
      {
        trapScope: {},
        loweredImport: () => lower,
      } as unknown as TrampolineContext,
    );
    const guest = guestCatcher(
      suspendingImport(trampoline as never, "jspi") as unknown as () => void,
    );
    const lifted = createLiftedFunction({
      name: "run",
      ft: { params: [], results: [{ kind: "u32" }] },
      opts: {
        ...lowerOpts,
        coreType: { params: [], results: ["i32"] },
      },
      core: guest as never,
      stats: newStats(),
      suspensionMode: "jspi",
    });

    const result = lifted() as Promise<unknown>;
    await Promise.resolve();
    const point = store.waiting[0] as unknown as {
      abandon(reason: unknown): void;
    };
    point.abandon(cause);
    let rejection: unknown;
    try {
      await result;
    } catch (e) {
      rejection = e;
    }
    assertEq(rejection, cause);
  },
});
