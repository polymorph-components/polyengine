// polyengine#147: the guest's `cabi_realloc` must run with `may_leave`
// cleared, so a realloc that lowers an import traps.
//
// Authority: definitions.py `LiftLowerContext.reallocate` (assert may_leave /
// clear / call / restore) and `canon_lower`'s `trap_if(not ...may_leave)`.
// These tests drive the real `createLiftedFunction` / `createLoweredImport`
// from exec/boundary.ts; the "core" functions are plain JS standing in for
// core wasm exports (the established pattern in these unit tests).

import { assertEq, assertTrap } from "./support/asserts.ts";
import { isInstancePoisoned } from "../src/task/scheduler.ts";
import {
  createLiftedFunction,
  createLoweredImport,
  newStats,
  type ResolvedOptions,
} from "../src/exec/boundary.ts";
import { ComponentInstanceState, Store } from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";
import { LiftLowerContext, mkCanonicalOptions } from "../src/cabi/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function mkView(memory: WebAssembly.Memory) {
  return {
    addrType: "i32" as const,
    get bytes() {
      return new Uint8Array(memory.buffer);
    },
    get view() {
      return new DataView(memory.buffer);
    },
    get length() {
      return memory.buffer.byteLength;
    },
    ptrType: () => "i32" as const,
    ptrSize: () => 4 as const,
  };
}

interface Harness {
  store: Store;
  inst: ComponentInstanceState;
  memory: WebAssembly.Memory;
  /** `may_leave` as observed at each realloc invocation. */
  seen: boolean[];
  /** Core-level realloc (a `CoreFn`, as the plan's resolved options hold). */
  realloc: (...args: unknown[]) => number[];
  /** Extra work the realloc performs while inside the window. */
  duringRealloc: (() => void) | null;
  mkOpts: (partial: Partial<ResolvedOptions>) => ResolvedOptions;
}

function mkHarness(): Harness {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = mkView(memory);
  const h: Harness = {
    store,
    inst,
    memory,
    seen: [],
    duringRealloc: null,
    realloc: (...args: unknown[]) => {
      const alignment = args[2] as number;
      const newSize = args[3] as number;
      h.seen.push(inst.mayLeave);
      h.duringRealloc?.();
      // Bump allocator starting at 2048, past the tests' retptr scratch area.
      bump = (bump + alignment - 1) & ~(alignment - 1);
      const p = bump;
      bump += newSize;
      assert(bump < memory.buffer.byteLength, "test heap exhausted");
      return [p];
    },
    mkOpts: (partial) => ({
      stringEncoding: "utf8",
      // deno-lint-ignore no-explicit-any
      memory: view as any,
      realloc: () => h.realloc,
      postReturn: null,
      callback: null,
      async: false,
      cancellable: false,
      coreType: { params: [], results: [] },
      instance: inst,
      ...partial,
    }),
  };
  let bump = 2048;
  return h;
}

/** `func(s: string)`, sync-typed. */
const TAKES_STRING: FuncType = {
  params: [{ kind: "string" }],
  results: [],
  async: false,
};

/** `func() -> string`, sync-typed. */
const RETURNS_STRING: FuncType = {
  params: [],
  results: [{ kind: "string" }],
  async: false,
};

/** `func()`, sync-typed. */
const NULLARY: FuncType = { params: [], results: [], async: false };

Deno.test("#147: host-entry param lowering runs realloc inside the may_leave window", () => {
  const h = mkHarness();
  let got: number[] | null = null;
  const lifted = createLiftedFunction({
    name: "takes-string",
    ft: TAKES_STRING,
    opts: h.mkOpts({ coreType: { params: ["i32", "i32"], results: [] } }),
    core: (...args: unknown[]) => {
      got = [args[0] as number, args[1] as number];
      return [];
    },
    stats: newStats(),
  });

  lifted("hello #147");

  assert(h.seen.length > 0, "lowering a string must have called realloc");
  assertEq(h.seen, h.seen.map(() => false), "may_leave during every realloc");
  // The bracket restored the flag on the way out.
  assertEq(h.inst.mayLeave, true);
  const received = got as number[] | null;
  assert(received !== null, "the core function ran");
  const [ptr, len] = received;
  assertEq(
    new TextDecoder().decode(new Uint8Array(h.memory.buffer, ptr, len)),
    "hello #147",
  );
});

Deno.test("#147: a host-entry realloc that lowers an import traps", () => {
  const h = mkHarness();
  const importCall = createLoweredImport({
    name: "trivial-import",
    ft: NULLARY,
    opts: h.mkOpts({ coreType: { params: [], results: [] } }),
    hostFn: () => undefined,
    stats: newStats(),
    mode: "plain",
    suspendable: false,
    deferCancel: false,
    abortable: false,
  }) as () => unknown;
  // The guest's realloc reaches out of the component while lowering.
  h.duringRealloc = () => void importCall();

  const lifted = createLiftedFunction({
    name: "takes-string",
    ft: TAKES_STRING,
    opts: h.mkOpts({ coreType: { params: ["i32", "i32"], results: [] } }),
    core: () => [],
    stats: newStats(),
  });

  let message = "";
  assertTrap(() => {
    try {
      return lifted("hello #147");
    } catch (e) {
      message = String(e);
      throw e;
    }
  });
  assert(
    message.includes("may_leave violation"),
    `expected a may_leave violation, got: ${message}`,
  );
  // #91 precedent: the trap left `may_leave` false and nothing tidied it up
  // — the instance is poisoned instead.
  assertEq(h.inst.mayLeave, false);
  assertEq(isInstancePoisoned(h.inst), true);
});

Deno.test("#147: import-result lowering runs realloc inside the may_leave window", () => {
  const h = mkHarness();
  const importCall = createLoweredImport({
    name: "returns-string",
    ft: RETURNS_STRING,
    opts: h.mkOpts({ coreType: { params: ["i32"], results: [] } }),
    hostFn: () => "from the host",
    stats: newStats(),
    mode: "plain",
    suspendable: false,
    deferCancel: false,
    abortable: false,
  }) as (retptr: number) => unknown;

  // Driven from inside a lifted export's core function: that is the guest,
  // running with a real task/thread context.
  const lifted = createLiftedFunction({
    name: "entry",
    ft: NULLARY,
    opts: h.mkOpts({ coreType: { params: [], results: [] } }),
    core: () => {
      importCall(64);
      return [];
    },
    stats: newStats(),
  });
  lifted();

  assert(h.seen.length > 0, "lowering the string result must call realloc");
  assertEq(h.seen, h.seen.map(() => false), "may_leave during every realloc");
  assertEq(h.inst.mayLeave, true);
  const dv = new DataView(h.memory.buffer);
  const ptr = dv.getUint32(64, true);
  const len = dv.getUint32(68, true);
  assertEq(
    new TextDecoder().decode(new Uint8Array(h.memory.buffer, ptr, len)),
    "from the host",
  );
});

Deno.test("#147: an import-result realloc that lowers an import traps", () => {
  const h = mkHarness();
  const inner = createLoweredImport({
    name: "trivial-import",
    ft: NULLARY,
    opts: h.mkOpts({ coreType: { params: [], results: [] } }),
    hostFn: () => undefined,
    stats: newStats(),
    mode: "plain",
    suspendable: false,
    deferCancel: false,
    abortable: false,
  }) as () => unknown;
  const importCall = createLoweredImport({
    name: "returns-string",
    ft: RETURNS_STRING,
    opts: h.mkOpts({ coreType: { params: ["i32"], results: [] } }),
    hostFn: () => "from the host",
    stats: newStats(),
    mode: "plain",
    suspendable: false,
    deferCancel: false,
    abortable: false,
  }) as (retptr: number) => unknown;
  h.duringRealloc = () => void inner();

  const lifted = createLiftedFunction({
    name: "entry",
    ft: NULLARY,
    opts: h.mkOpts({ coreType: { params: [], results: [] } }),
    core: () => {
      importCall(64);
      return [];
    },
    stats: newStats(),
  });

  let message = "";
  assertTrap(() => {
    try {
      return lifted();
    } catch (e) {
      message = String(e);
      throw e;
    }
  });
  assert(
    message.includes("may_leave violation"),
    `expected a may_leave violation, got: ${message}`,
  );
});

Deno.test("#147: a context with no instance reallocates without touching a flag", () => {
  // The value-interpreter harness state (tests/support/driver.ts `mkCx`).
  let calls = 0;
  const cx = new LiftLowerContext(
    mkCanonicalOptions({
      realloc: (_o, _os, _a, n) => {
        calls++;
        return 100 + n;
      },
    }),
  );
  assertEq(cx.inst, null);
  assertEq(cx.reallocate(0, 0, 4, 8), 108);
  assertEq(cx.allocate(4, 12), 112);
  assertEq(calls, 2);
});
