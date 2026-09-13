// Regression coverage for host-value preparation and custody. These cases use
// the real CABI/embedder seams because the bugs were ordering bugs: a mock that
// only checks object identity cannot show whether a callback ran after poison,
// cancellation, table insertion, or producer abandonment.

import { assertEq } from "./support/asserts.ts";
import {
  LiftLowerContext,
  liftOwn,
  lowerOwn,
  mkCanonicalOptions,
  ResourceHandle,
  ResourceTableInfo,
  ResourceTypeInfo,
  type Table,
} from "../src/cabi/mod.ts";
import type { ComponentValue, FuncType, ValType } from "../src/cabi/types.ts";
import {
  lowerFlatValues,
  PreparedValues,
  prepareRawValues,
} from "../src/cabi/values.ts";
import {
  createLiftedFunction,
  createLoweredImport,
  newStats,
  type ResolvedOptions,
} from "../src/exec/boundary.ts";
import {
  ComponentInstanceState,
  currentThread,
  notifyInstancePoisoned,
  popCurrentThread,
  pushCurrentThread,
  SharedStreamImpl,
  Store,
  type Subtask,
  SubtaskState,
  SyncEntryBusy,
  Task,
  Thread,
  unpackSubtaskResult,
} from "../src/task/mod.ts";
import {
  GuestResource,
  makeWrapper,
  takeBorrowRep,
  wrapperLends,
  wrapperState,
} from "../src/embedder/resources.ts";
import {
  BorrowScope,
  elemCodec,
  prepareHostValues,
  toHost,
  type ValueBridge,
} from "../src/embedder/values.ts";
import {
  Future,
  lowerFutureSource,
  lowerStreamSource,
  Stream,
} from "../src/embedder/streams.ts";
import { hostStreamFor } from "../src/exec/host_streams.ts";
import {
  adaptHostFunction,
  type HostCallAdapter,
  invokeHostCall,
  invokeHostCallWith,
  markHostCallAdapter,
  reusableImmediateHostCall,
} from "../src/exec/host_settlement.ts";
import { createSubtaskCancel } from "../src/intrinsics/async_builtins.ts";
import { guest, haveFixture, instantiateFixture } from "./embedder/support.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected an exception");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function rejected(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function liveEntries(table: Table<unknown>): unknown[] {
  return table.array.filter((entry) => entry !== null);
}

function memoryHarness(reallocEffect?: () => void) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let bump = 1024;
  let reallocs = 0;
  const view = {
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
  return {
    memory,
    view,
    reallocs: () => reallocs,
    realloc: (_old: number, _oldSize: number, align: number, size: number) => {
      reallocs++;
      reallocEffect?.();
      bump = (bump + align - 1) & ~(align - 1);
      const ptr = bump;
      bump += size;
      return ptr;
    },
  };
}

function bridge(overrides: Partial<ValueBridge> = {}): ValueBridge {
  return {
    liftOwn: (rep) => rep,
    liftBorrow: (rep) => rep,
    lowerOwn: () => 1,
    lowerBorrow: () => 1,
    dropOwn: () => {},
    ...overrides,
  };
}

function lowerFixture(
  ft: FuncType,
  hostFn: HostCallAdapter,
  reallocEffect?: () => void,
) {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const h = memoryHarness(reallocEffect);
  const resultLanes = ft.results.length === 0 ? [] : ["i32" as const];
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    memory: h.view as never,
    realloc: () => (...args: unknown[]) => [
      h.realloc(...args as [number, number, number, number]),
    ],
    postReturn: null,
    callback: null,
    async: true,
    cancellable: false,
    coreType: {
      params: resultLanes.length === 0 ? [] : ["i32"],
      results: ["i32"],
    },
    instance: inst,
  };
  const task = new Task(
    ft,
    {
      async_: true,
      callback: true,
      stringEncoding: "utf8",
      memory: h.view,
    },
    inst,
    () => [],
    () => {},
  );
  const thread = new Thread(task, (function* () {})());
  const call = createLoweredImport({
    name: "prepared-result",
    ft,
    opts,
    hostFn,
    stats: newStats(),
    mode: "plain",
    suspendable: false,
    deferCancel: false,
    abortable: false,
  }) as (...args: number[]) => number;
  return {
    store,
    inst,
    h,
    call: () => {
      pushCurrentThread(thread);
      try {
        return call(...(resultLanes.length === 0 ? [] : [64]));
      } finally {
        popCurrentThread(thread);
      }
    },
    asGuest<T>(fn: () => T): T {
      pushCurrentThread(thread);
      try {
        return fn();
      } finally {
        popCurrentThread(thread);
      }
    },
  };
}

for (const timing of ["before-listener", "after-listener"] as const) {
  Deno.test(`prepared export waiting behind backpressure retires on ${timing} poison`, async () => {
    // docs/architecture.md:343-353 requires acquired-but-undelivered custody to
    // be retired. The admission wait itself must also disappear: otherwise a
    // poisoned instance leaves a permanent scheduler/waiting-entry corpse.
    const store = new Store();
    const inst = new ComponentInstanceState(0, store);
    inst.backpressure = 1;
    const rt = new ResourceTypeInfo(null, null);
    const own = { kind: "own", rt: new ResourceTableInfo(rt) } as const;
    let acquired = 0;
    let cleaned = 0;
    let entered = 0;
    const prepared = new PreparedValues([71], [own], (_v, _t, custody) => {
      acquired++;
      custody.acquire(() => cleaned++);
    });
    const ft: FuncType = { params: [own], results: [], async: true };
    const opts: ResolvedOptions = {
      stringEncoding: "utf8",
      memory: null,
      realloc: null,
      postReturn: null,
      callback: () => () => [0],
      async: true,
      cancellable: false,
      coreType: { params: ["i32"], results: ["i32"] },
      instance: inst,
    };
    const call = createLiftedFunction({
      name: "backpressured-own",
      ft,
      opts,
      core: () => {
        entered++;
        return [0];
      },
      stats: newStats(),
    });

    const poison = new Error(`poison ${timing}`);
    if (timing === "before-listener") {
      const poisonTask = new Task(
        { params: [], results: [], async: false },
        {
          async_: false,
          callback: false,
          stringEncoding: "utf8",
          memory: null,
        },
        inst,
        () => [],
        () => {},
      );
      const poisonThread = new Thread(
        poisonTask,
        // deno-lint-ignore require-yield
        (function* () {
          notifyInstancePoisoned(inst, poison);
          return;
        })(),
      );
      poisonThread.resumeLater();
    }
    const pending = call(prepared as unknown as ComponentValue) as Promise<
      unknown
    >;
    assertEq(acquired, 1);
    assertEq(entered, 0);
    assertEq(inst.numWaitingToEnter, 1);
    if (timing === "after-listener") notifyInstancePoisoned(inst, poison);
    assertEq(await rejected(pending), poison);
    assertEq(cleaned, 1);
    assertEq(liveEntries(inst.handles).length, 0);
    assertEq(inst.numWaitingToEnter, 0, "waiting admission is retired");
    assertEq(store.waiting.length, 0, "scheduler has no poisoned waiter");
  });
}

Deno.test("hop refusal releases prepared custody before entry", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const hop = { task: { inst }, awaiting: Promise.resolve() };
  store.awaiting.add(hop);
  let cleaned = 0;
  const prepared = new PreparedValues([], []);
  prepared.custody.acquire(() => cleaned++);
  const call = createLiftedFunction({
    name: "hop-refusal",
    ft: { params: [], results: [], async: false },
    opts: {
      stringEncoding: "utf8",
      memory: null,
      realloc: null,
      postReturn: null,
      callback: null,
      async: false,
      cancellable: false,
      coreType: { params: [], results: [] },
      instance: inst,
    },
    core: () => [],
    stats: newStats(),
    refuseOnEntryHops: true,
  });
  assertEq(
    caught(() => call(prepared as unknown as ComponentValue)) instanceof
      SyncEntryBusy,
    true,
  );
  assertEq(cleaned, 1);
  store.awaiting.delete(hop);
});

Deno.test("realloc Error or undefined stays primary through throwing own cleanup", () => {
  // Drive the actual lifted boundary: own is inserted first, then string
  // realloc fails. definitions.py's destructive unwind leaves no table entry,
  // and JavaScript's valid `throw undefined` must not be mistaken for absence.
  for (const primary of [new Error("realloc failed"), undefined]) {
    const store = new Store();
    const inst = new ComponentInstanceState(0, store);
    let dtors = 0;
    let entered = 0;
    let absentInsideDtor = false;
    let ownEntry: ResourceHandle | null = null;
    const rt = new ResourceTypeInfo(null, () => {
      dtors++;
      absentInsideDtor = !inst.handles.array.includes(ownEntry);
      throw new Error("throwing destructor");
    });
    const own = { kind: "own", rt: new ResourceTableInfo(rt) } as const;
    const lender = new ResourceHandle(own.rt, 99, true);
    lender.numLends = 1;
    const ft: FuncType = {
      params: [own, { kind: "string" }],
      results: [],
      async: false,
    };
    const h = memoryHarness();
    const call = createLiftedFunction({
      name: "realloc-primary",
      ft,
      opts: {
        stringEncoding: "utf8",
        memory: h.view as never,
        realloc: () => {
          const thread = currentThread<Thread>();
          thread.syncCallStack.push({
            releaseLenders() {
              lender.numLends--;
            },
          });
          ownEntry = inst.handles.array.find((e) =>
            e instanceof ResourceHandle
          ) as
            | ResourceHandle
            | null;
          throw primary;
        },
        postReturn: null,
        callback: null,
        async: false,
        cancellable: false,
        coreType: { params: ["i32", "i32", "i32"], results: [] },
        instance: inst,
      },
      core: () => {
        entered++;
        return [];
      },
      stats: newStats(),
    });
    const prepared = prepareRawValues([17, "allocate me"], ft.params);
    let caughtPrimary: unknown = Symbol("not thrown");
    try {
      call(prepared as unknown as ComponentValue);
    } catch (e) {
      caughtPrimary = e;
    }
    assertEq(caughtPrimary, primary);
    assertEq(dtors, 1);
    assertEq(absentInsideDtor, true, "table entry removed before destructor");
    assertEq(lender.numLends, 0, "actual lender scope unwound");
    assertEq(entered, 0);
    assertEq(liveEntries(inst.handles).length, 0);
  }
});

Deno.test("raw flat and spilled scalar preparation has no late coercion effects", () => {
  for (const spilled of [false, true]) {
    let coercions = 0;
    let reallocs = 0;
    const hostile = {
      valueOf() {
        coercions++;
        return 7;
      },
    };
    const types: ValType[] = Array.from(
      { length: spilled ? 17 : 1 },
      () => ({ kind: "u32" }),
    );
    const values: unknown[] = types.map(() => 1);
    values[values.length - 1] = hostile;
    const error = caught(() => {
      const prepared = prepareRawValues(values, types);
      const h = memoryHarness(() => reallocs++);
      lowerFlatValues(
        new LiftLowerContext(mkCanonicalOptions({
          memory: h.view as never,
          realloc: h.realloc,
        })),
        16,
        prepared.transfer(() => {}),
        types,
      );
    });
    assert(String(error).includes("not a number"), String(error));
    assertEq(coercions, 0, `spilled=${spilled}: valueOf must not run`);
    assertEq(reallocs, 0, `spilled=${spilled}: no allocation after bad scalar`);
  }
});

Deno.test("raw Uint8Array bounds are captured without hostile length access", () => {
  for (const ordinary of [true, false]) {
    for (const spilled of [false, true]) {
      let metadataReads = 0;
      class HostileBytes extends Uint8Array {}
      const bytes = ordinary
        ? new Uint8Array([3, 4, 5])
        : new HostileBytes([3, 4, 5]);
      for (const key of ["length", "byteLength", "byteOffset", "buffer"]) {
        Object.defineProperty(bytes, key, {
          get() {
            metadataReads++;
            throw new Error(`hostile ${key} getter`);
          },
        });
      }
      Object.defineProperty(bytes, Symbol.iterator, {
        get() {
          metadataReads++;
          throw new Error("hostile iterator getter");
        },
      });
      const prefix: ValType[] = Array.from(
        { length: spilled ? 15 : 0 },
        () => ({ kind: "u32" }),
      );
      const type: ValType = { kind: "list", element: { kind: "u8" } };
      const types = [...prefix, type];
      const prepared = prepareRawValues(
        [...prefix.map(() => 0), bytes],
        types,
      );
      const h = memoryHarness();
      const flat = lowerFlatValues(
        new LiftLowerContext(mkCanonicalOptions({
          memory: h.view as never,
          realloc: h.realloc,
        })),
        16,
        prepared.transfer(() => {}),
        types,
      ) as number[];
      assertEq(metadataReads, 0, `ordinary=${ordinary}, spilled=${spilled}`);
      assertEq(h.reallocs(), spilled ? 2 : 1);
      const tuple = new DataView(h.memory.buffer);
      const ptr = spilled ? tuple.getUint32(flat[0] + 60, true) : flat[0];
      const length = spilled ? tuple.getUint32(flat[0] + 64, true) : flat[1];
      assertEq(length, 3);
      assertEq(
        new Uint8Array(h.memory.buffer, ptr, length),
        new Uint8Array([3, 4, 5]),
      );
    }
  }
});

Deno.test("facade Uint8Array bounds are captured without hostile length access", () => {
  for (const ordinary of [true, false]) {
    let metadataReads = 0;
    class HostileBytes extends Uint8Array {}
    const bytes = ordinary ? new Uint8Array([6, 7]) : new HostileBytes([6, 7]);
    for (const key of ["length", "byteLength", "byteOffset", "buffer"]) {
      Object.defineProperty(bytes, key, {
        get() {
          metadataReads++;
          throw new Error(`hostile facade ${key} getter`);
        },
      });
    }
    Object.defineProperty(bytes, Symbol.iterator, {
      get() {
        metadataReads++;
        throw new Error("hostile facade iterator getter");
      },
    });
    const type: ValType = { kind: "list", element: { kind: "u8" } };
    const prepared = prepareHostValues([bytes], [type], {
      where: "facade bytes",
      bridge: bridge(),
    });
    const h = memoryHarness();
    const flat = lowerFlatValues(
      new LiftLowerContext(mkCanonicalOptions({
        memory: h.view as never,
        realloc: h.realloc,
      })),
      16,
      prepared.transfer(() => {}),
      [type],
    ) as number[];
    assertEq(metadataReads, 0, `ordinary=${ordinary}`);
    assertEq(
      new Uint8Array(h.memory.buffer, flat[0], flat[1]),
      new Uint8Array([6, 7]),
    );
  }
});

Deno.test("an immediately prepoisoned result is discarded before getters run", () => {
  let getters = 0;
  let acquisitions = 0;
  const result: ValType = {
    kind: "record",
    fields: [{ label: "value", type: { kind: "u32" } }],
  };
  const adapter = markHostCallAdapter(() => ({
    kind: "immediate" as const,
    settlement: { value: undefined },
    finish() {
      return prepareHostValues(
        [{
          get value() {
            getters++;
            return 1;
          },
        }],
        [result],
        {
          where: "prepoisoned result",
          bridge: bridge({ lowerOwn: () => acquisitions++ }),
        },
      );
    },
  }));
  const f = lowerFixture(
    { params: [], results: [result], async: true },
    adapter,
  );
  const poison = new Error("already poisoned");
  notifyInstancePoisoned(f.inst, poison);
  const error = caught(() => f.call());
  assertEq(error, poison);
  assertEq(getters, 0);
  assertEq(acquisitions, 0);
  assertEq(liveEntries(f.inst.handles).length, 0);
});

for (const resultKind of ["string", "list"] as const) {
  for (const pending of [false, true]) {
    Deno.test(`allocator poison after ${pending ? "pending" : "immediate"} ${resultKind} result prevents RETURNED`, async () => {
      // The realloc callback closes over the fixture assigned immediately below.
      // deno-lint-ignore prefer-const
      let fixture!: ReturnType<typeof lowerFixture>;
      const value = resultKind === "string" ? "hello" : new Uint8Array([1, 2]);
      const settled = deferred<typeof value>();
      const adapter = adaptHostFunction(() =>
        pending ? settled.promise : value
      );
      const poison = new Error("realloc poisoned recipient");
      fixture = lowerFixture(
        {
          params: [],
          results: [
            resultKind === "string"
              ? { kind: "string" }
              : { kind: "list", element: { kind: "u8" } },
          ],
          async: true,
        },
        adapter,
        () => notifyInstancePoisoned(fixture.inst, poison),
      );

      let packed: number | undefined;
      let immediateFailure: unknown;
      try {
        packed = fixture.call();
      } catch (e) {
        immediateFailure = e;
      }
      if (pending) {
        const [, subtaski] = unpackSubtaskResult(packed!);
        const subtask = fixture.inst.handles.get(subtaski) as Subtask;
        settled.resolve(value);
        await turn();
        assertEq(
          subtask.state,
          SubtaskState.STARTED,
          "must not publish RETURNED",
        );
      } else {
        assertEq(immediateFailure, poison);
      }
      const memory = new Uint8Array(fixture.h.memory.buffer);
      assertEq(
        new DataView(memory.buffer).getUint32(64, true),
        0,
        "retptr untouched",
      );
      assertEq(memory[1024], 0, "no string bytes after realloc poison");
    });
  }
}

Deno.test("prepoisoned immediate call releases and scrubs its reusable carrier", () => {
  const hooks = {
    result: "prepared" as const,
    invoke: (context: object) => context,
    finish: () => [],
  };
  const reusable = reusableImmediateHostCall(hooks);
  const retained = { marker: 1 };
  const adapter = markHostCallAdapter(() =>
    invokeHostCallWith(retained, hooks, reusable)
  );
  const fixture = lowerFixture(
    { params: [], results: [], async: true },
    adapter,
  );
  notifyInstancePoisoned(fixture.inst, new Error("prepoisoned"));
  caught(() => fixture.call());
  const internal = reusable as unknown as {
    busy: boolean;
    context: unknown;
    settlement: unknown;
  };
  assertEq(internal.busy, false);
  assertEq(internal.context, undefined);
  assertEq(internal.settlement, { value: undefined });
  assertEq(adapter() === reusable, true, "carrier is reusable");
});

Deno.test("cancellation during result preparation stops later ownership and RETURNED", async () => {
  const resource = new ResourceTypeInfo(null, null);
  const own = { kind: "own", rt: new ResourceTableInfo(resource) } as const;
  const result: ValType = {
    kind: "record",
    fields: [{ label: "trigger", type: { kind: "u32" } }, {
      label: "owned",
      type: own,
    }],
  };
  const pending = deferred<unknown>();
  let subtaski = 0;
  let acquisitions = 0;
  const adapter = markHostCallAdapter(() =>
    invokeHostCall(() => pending.promise, {
      finish() {
        return prepareHostValues(
          [{
            get trigger() {
              f.asGuest(() =>
                createSubtaskCancel({ async: true }, f.inst)(subtaski)
              );
              return 1;
            },
            owned: {},
          }],
          [result],
          {
            where: "cancel during preparation",
            bridge: bridge({ lowerOwn: () => ++acquisitions }),
          },
        );
      },
    })
  );
  const f = lowerFixture(
    { params: [], results: [result], async: true },
    adapter,
  );
  const packed = f.call();
  [, subtaski] = unpackSubtaskResult(packed);
  const subtask = f.inst.handles.get(subtaski) as Subtask;
  const lender = new ResourceHandle(own.rt, 33, true);
  subtask.addLender(lender);
  pending.resolve(undefined);
  await turn();
  assertEq(subtask.state, SubtaskState.CANCELLED_BEFORE_RETURNED);
  assertEq(subtask.resolveDelivered(), true);
  assertEq(subtask.hasPendingEvent(), false);
  assertEq(lender.numLends, 0);
  assertEq(acquisitions, 0);
  assertEq(
    liveEntries(f.inst.handles).filter((e) => e instanceof ResourceHandle)
      .length,
    0,
  );
});

Deno.test("cancellation during preparation does not start a later producer", async () => {
  const streamType = { kind: "stream", element: { kind: "u32" } } as const;
  const result: ValType = {
    kind: "record",
    fields: [{ label: "trigger", type: { kind: "u32" } }, {
      label: "stream",
      type: streamType,
    }],
  };
  const pending = deferred<unknown>();
  let subtaski = 0;
  let starts = 0;
  const producer = {
    [Symbol.iterator]() {
      starts++;
      return [1][Symbol.iterator]();
    },
  };
  const adapter = markHostCallAdapter(() =>
    invokeHostCall(() => pending.promise, {
      finish() {
        return prepareHostValues(
          [{
            get trigger() {
              f.asGuest(() =>
                createSubtaskCancel({ async: true }, f.inst)(subtaski)
              );
              return 1;
            },
            stream: producer,
          }],
          [result],
          {
            where: "cancel before producer",
            destinationStore: f.store,
            bridge: bridge(),
          },
        );
      },
    })
  );
  const f = lowerFixture(
    { params: [], results: [result], async: true },
    adapter,
  );
  const packed = f.call();
  [, subtaski] = unpackSubtaskResult(packed);
  const subtask = f.inst.handles.get(subtaski) as Subtask;
  pending.resolve(undefined);
  await turn();
  assertEq(subtask.state, SubtaskState.CANCELLED_BEFORE_RETURNED);
  assertEq(subtask.resolveDelivered(), true);
  assertEq(starts, 0);
  assertEq(liveEntries(f.inst.handles).filter((e) => e !== subtask).length, 0);
});

for (const onward of [false, true]) {
  Deno.test(`onLowered canonical cancellation ${onward ? "keeps onward own" : "destroys own once"}`, async () => {
    let dtors = 0;
    let absentInsideDtor = false;
    // Assigned after onLowered closes over it.
    // deno-lint-ignore prefer-const
    let source!: ReturnType<typeof lowerFixture>;
    const resource = new ResourceTypeInfo(null, () => {
      dtors++;
      absentInsideDtor = !source.inst.handles.array.includes(ownEntry);
    });
    const rt = new ResourceTableInfo(resource);
    const own = { kind: "own", rt } as const;
    const asyncType = { kind: "stream", element: { kind: "u32" } } as const;
    const result: ValType = {
      kind: "record",
      fields: [{ label: "own", type: own }, {
        label: "stream",
        type: asyncType,
      }],
    };
    const pending = deferred<unknown>();
    let subtaski = 0;
    let ownEntry: ResourceHandle | null = null;
    const onwardInst = new ComponentInstanceState(1, new Store());
    const shared = new SharedStreamImpl({ kind: "u32" });
    let cancelResult: unknown;
    shared.onLowered = () => {
      ownEntry = source.inst.handles.array.find((e) =>
        e instanceof ResourceHandle
      ) as
        | ResourceHandle
        | null;
      assert(ownEntry !== null, "own was inserted before onLowered");
      if (onward) {
        const index = source.inst.handles.array.indexOf(ownEntry);
        const rep = liftOwn(
          new LiftLowerContext(mkCanonicalOptions(), source.inst),
          index,
          own,
        );
        lowerOwn(
          new LiftLowerContext(mkCanonicalOptions(), onwardInst),
          rep,
          own,
        );
      }
      cancelResult = source.asGuest(() =>
        createSubtaskCancel({ async: true }, source.inst)(subtaski)
      );
    };
    const adapter = markHostCallAdapter(() =>
      invokeHostCall(() => pending.promise, {
        finish(settlement) {
          if ("error" in settlement) throw settlement.error;
          return prepareRawValues([{ own: 91, stream: shared }], [result]);
        },
      })
    );
    source = lowerFixture(
      { params: [], results: [result], async: true },
      adapter,
    );
    const packed = source.call();
    [, subtaski] = unpackSubtaskResult(packed);
    const subtask = source.inst.handles.get(subtaski) as Subtask;
    const lender = new ResourceHandle(rt, 123, true);
    subtask.addLender(lender);
    pending.resolve(undefined);
    await turn();

    assertEq(cancelResult, SubtaskState.CANCELLED_BEFORE_RETURNED);
    assertEq(subtask.state, SubtaskState.CANCELLED_BEFORE_RETURNED);
    assertEq(subtask.resolveDelivered(), true);
    assertEq(
      subtask.hasPendingEvent(),
      false,
      "cancel consumed the terminal event",
    );
    assertEq(lender.numLends, 0, "real Subtask lender was delivered once");
    assertEq(dtors, onward ? 0 : 1);
    assertEq(absentInsideDtor, !onward);
    assertEq(
      liveEntries(source.inst.handles).filter((e) =>
        e instanceof ResourceHandle
      ).length,
      0,
    );
    assertEq(
      liveEntries(onwardInst.handles).filter((e) => e instanceof ResourceHandle)
        .length,
      onward ? 1 : 0,
    );
  });
}

Deno.test("real stream elemCodec abandons nested producer after outer drop", async () => {
  // Assigned after the getter closure is created; one assignment is deliberate.
  // deno-lint-ignore prefer-const
  let raw!: ComponentValue;
  let nestedStarts = 0;
  const nested = {
    [Symbol.iterator]() {
      nestedStarts++;
      return [1][Symbol.iterator]();
    },
  };
  const element: ValType = {
    kind: "record",
    fields: [{
      label: "nested",
      type: { kind: "stream", element: { kind: "u32" } },
    }],
  };
  const codec = elemCodec(element, {
    where: "outer stream",
    bridge: bridge(),
  });
  const payload = {
    get nested() {
      hostStreamFor(raw).readable.drop();
      return nested;
    },
  };
  raw = lowerStreamSource([payload], codec);
  await turn();
  await turn();
  assertEq(nestedStarts, 0, "cleanly abandoned nested producer never starts");
});

Deno.test("real future elemCodec abandons nested producer after outer drop", async () => {
  // Assigned after the getter closure is created; one assignment is deliberate.
  // deno-lint-ignore prefer-const
  let outer!: Future<unknown>;
  let nestedStarts = 0;
  const nested = {
    [Symbol.iterator]() {
      nestedStarts++;
      return [1][Symbol.iterator]();
    },
  };
  const element: ValType = {
    kind: "record",
    fields: [{
      label: "nested",
      type: { kind: "stream", element: { kind: "u32" } },
    }],
  };
  const codec = elemCodec(element, {
    where: "outer future",
    bridge: bridge(),
  });
  const payload = {
    get nested() {
      outer.drop();
      return nested;
    },
  };
  const raw = lowerFutureSource(Promise.resolve(payload), codec);
  outer = Future.fromLifted(raw, codec);
  await turn();
  await turn();
  assertEq(nestedStarts, 0, "cleanly abandoned nested producer never starts");
});

Deno.test("real future elemCodec cleans acquired own prefix on invalid second own", async () => {
  const resource = new ResourceTypeInfo(null, null);
  const own = { kind: "own", rt: new ResourceTableInfo(resource) } as const;
  const element: ValType = {
    kind: "record",
    fields: [{ label: "first", type: own }, { label: "second", type: own }],
  };
  let acquisitions = 0;
  const dropped: number[] = [];
  const codec = elemCodec(element, {
    where: "future payload",
    bridge: bridge({
      lowerOwn: () => {
        acquisitions++;
        if (acquisitions === 2) throw new TypeError("invalid second own");
        return 81;
      },
      dropOwn: (rep) => dropped.push(rep),
    }),
  });
  const raw = lowerFutureSource(
    Promise.resolve({ first: {}, second: {} }),
    codec,
  );
  const future = Future.fromLifted(raw, codec);
  const failure = await rejected(Promise.resolve(future));
  assert(String(failure).includes("future payload"), String(failure));
  assert(
    String((failure as Error).cause).includes("invalid second own"),
    String(failure),
  );
  assertEq(acquisitions, 2);
  assertEq(dropped, [81]);
});

Deno.test("lazy stream binding can cancel a queued writer before reading its chunk", async () => {
  const pair = Stream.create<number>();
  let reads = 0;
  let invalid = false;
  const chunk = [0];
  Object.defineProperty(chunk, 0, {
    get() {
      reads++;
      invalid = true;
      return 7;
    },
  });
  const pending = pair.writer.write(chunk);
  const codec = elemCodec({ kind: "u32" }, {
    where: "lazy writer",
    bridge: bridge(),
  });
  const error = caught(() =>
    lowerStreamSource(pair.stream, codec, undefined, undefined, () => {
      if (invalid) throw new Error("writer getter invalidated transfer");
    })
  );
  assert(String(error).includes("invalidated transfer"), String(error));
  assertEq(reads, 1, "queued writer getter ran during lazy binding");
  // The binding itself is destructive, but failed enclosing transfer must not
  // consume the readable source. A later destination can still take it.
  lowerStreamSource(pair.stream, codec);
  pair.writer.cancelWrite();
  await pending.catch(() => {});
});

Deno.test("already-bound takeValue getter poison leaves the source usable", () => {
  const codec = elemCodec({ kind: "u32" }, {
    where: "already-bound stream",
    bridge: bridge(),
  }) as import("../src/embedder/streams.ts").ElemCodec<number>;
  const source = Stream.fromLifted<number>(
    lowerStreamSource<number>([], codec),
    codec,
  );
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const poison = new Error("poison in takeValue lookup");
  let entered = 0;
  let lookups = 0;
  const proxy = new Proxy(source, {
    get(target, key) {
      if (key === "takeValue") {
        lookups++;
        notifyInstancePoisoned(inst, poison);
        return target.takeValue.bind(target);
      }
      return Reflect.get(target, key, target);
    },
  });
  const streamType = { kind: "stream", element: { kind: "u32" } } as const;
  const prepared = prepareHostValues([proxy], [streamType], {
    where: "already-bound stream",
    destinationStore: store,
    bridge: bridge(),
  });
  const call = createLiftedFunction({
    name: "already-bound-stream-export",
    ft: { params: [streamType], results: [], async: false },
    opts: {
      stringEncoding: "utf8",
      memory: null,
      realloc: null,
      postReturn: null,
      callback: null,
      async: false,
      cancellable: false,
      coreType: { params: ["i32"], results: [] },
      instance: inst,
    },
    core: () => {
      entered++;
      return [];
    },
    stats: newStats(),
  });
  const error = caught(() => call(prepared as unknown as ComponentValue));
  assert(String(error).includes(poison.message), String(error));
  assertEq(lookups, 1);
  assertEq(entered, 0);
  assertEq(liveEntries(inst.handles).length, 0);
  // A failed lookup/checkpoint must not flip Stream.#consumed.
  lowerStreamSource(source, codec);
});

Deno.test("partial toHost conversion invalidates an earlier borrow before dispatch", () => {
  const resource = new ResourceTypeInfo(null, null);
  const rt = new ResourceTableInfo(resource);
  let borrowed!: GuestResource;
  let invoked = 0;
  const scope = new BorrowScope();
  const options = {
    where: "partial import arguments",
    bridge: bridge({
      liftBorrow(rep, _type, borrowScope) {
        borrowed = makeWrapper(GuestResource, rep, resource, false);
        borrowScope.add(() => borrowed.drop());
        return borrowed;
      },
    }),
  };
  const adapter = markHostCallAdapter((...raw) => {
    try {
      const params: ValType[] = [{ kind: "borrow", rt }, {
        kind: "enum",
        labels: ["ok"],
      }];
      // This is the same ordered toHost loop used by Facade.#wrapImportFn:
      // first conversion creates a real call-scoped guest-resource wrapper.
      for (let i = 0; i < params.length; i++) {
        toHost(raw[i] as ComponentValue, params[i], options, scope);
      }
      // The later malformed argument fails before host dispatch.
      invoked++;
    } catch (e) {
      scope.end();
      throw e;
    }
    return adaptHostFunction(() => undefined)();
  });
  const failure = caught(() => adapter(41, "malformed internal enum"));
  assert(
    String(failure).includes("expected a { kind, value }"),
    String(failure),
  );
  assertEq(invoked, 0);
  assertEq(wrapperState(borrowed)?.valid, false);
  assertEq(
    caught(() =>
      takeBorrowRep(borrowed, resource, "expired", () => {})
    ) instanceof
      Error,
    true,
  );
});

const resourcesReady = await haveFixture(guest("resources"));

Deno.test({
  name:
    "resource export borrows one Proxy state snapshot and releases its lend",
  ignore: !resourcesReady,
  async fn() {
    const instance = await instantiateFixture(guest("resources"));
    const counters = instance.exports["polyengine:resources/counters"] as {
      Counter: new (initial: bigint) => GuestResource;
      bump(resource: GuestResource, by: bigint): Promise<bigint>;
    };
    using a = new counters.Counter(10n);
    using b = new counters.Counter(20n);
    let lookups = 0;
    const proxy = new Proxy(a, {
      get(_target, key) {
        lookups++;
        return Reflect.get(lookups === 1 ? a : b, key);
      },
    });
    assertEq(await counters.bump(proxy, 3n), 13n);
    assertEq(lookups, 1, "production borrow path reads wrapper state once");
    assertEq(wrapperLends(a), 0);
    assertEq(wrapperLends(b), 0);
    assertEq(
      await counters.bump(a, 1n),
      14n,
      "the selected wrapper remains live",
    );
    assertEq(
      await counters.bump(b, 1n),
      21n,
      "the alternate wrapper was untouched",
    );
  },
});
