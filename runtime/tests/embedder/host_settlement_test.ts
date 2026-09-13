// Real canonical lowers through the facade. Counters distinguish no conversion
// from converting and subsequently disposing a discarded result (#328/#329).
import { assertEq } from "../support/asserts.ts";
import { caught, guest, haveFixture, instantiateFixture } from "./support.ts";
import {
  ComponentException,
  deferCancel,
  suspending,
  Trap,
} from "@polyengine/protocol";
import { INTERNAL_HOST_REGISTRIES } from "../../src/embedder/instantiate.ts";
import type { HostResourceRegistry } from "../../src/embedder/resources.ts";
import {
  type ComponentInstanceState,
  currentTask,
  isInstancePoisoned,
  NeedsJspi,
} from "../../src/task/mod.ts";
import { isSupported } from "../../src/jspi/mod.ts";
import { Future, Stream } from "../../src/embedder/streams.ts";
import { hostFuture } from "../../src/exec/host_streams.ts";
import { sync } from "../../src/embedder/sync.ts";

const fixture = "runtime/tests/embedder/host-settlement.wasm";
const factFixture = "runtime/tests/embedder/fact-settlement.wasm";
const turn = () => new Promise<void>((r) => setTimeout(r, 0));
class R {
  disposed = 0;
  [Symbol.dispose]() {
    this.disposed++;
  }
}

for (const rejection of [false, true]) {
  Deno.test({
    name: `settlement: poisoned FACT sync recipient discards ${
      rejection ? "err" : "ok"
    } own before produce`,
    ignore: !isSupported(),
    fn: async () => {
      const p = deferred();
      const started = Promise.withResolvers<void>();
      let caller!: ComponentInstanceState;
      const c = await instantiateFixture(factFixture, {
        r: R,
        makeSync: suspending(() => {
          caller = currentTask().inst;
          started.resolve();
          return p.promise;
        }),
      }, { jspi: true });
      const call = caught(() => c.exports.runFact(new R()));
      await started.promise;
      await turn();
      const cause = await caught(() => sync(c.exports.trap)());
      assertEq(cause instanceof Trap, true);
      assertEq(
        isInstancePoisoned(c.handle.componentInstances[1]),
        true,
        "FACT callee poisoned",
      );
      assertEq(
        isInstancePoisoned(caller),
        false,
        "owning caller task still healthy",
      );
      const value = new R();
      if (rejection) p.reject(new ComponentException(value));
      else p.resolve(value);
      assertEq(await call instanceof Trap, true);
      const registries = (c as unknown as {
        [INTERNAL_HOST_REGISTRIES]: Map<number, HostResourceRegistry>;
      })[INTERNAL_HOST_REGISTRIES];
      assertEq(registries.get(0)!.liveCount, 0);
      assertEq(value.disposed, 0);
    },
  });
}

function deferred() {
  return Promise.withResolvers<unknown>();
}
async function setup(imports: Record<string, unknown> = {}, jspi = false) {
  const c = await instantiateFixture(fixture, {
    r: R,
    make: () => new R(),
    makeSync: () => new R(),
    producers: {
      sources: () => {
        throw new Error("unused sources");
      },
    },
    consume: () => 0,
    ...imports,
  }, { jspi });
  const registries = (c as unknown as {
    [INTERNAL_HOST_REGISTRIES]: Map<number, HostResourceRegistry>;
  })[INTERNAL_HOST_REGISTRIES];
  return { c, registry: registries.get(0)! };
}

for (const marked of [false, true]) {
  Deno.test(`settlement: refused ${marked ? "marked" : "unmarked"} immediate rejection is observed`, async () => {
    const fn = () => Promise.reject(new Error("immediate refused failure"));
    const { c } = await setup({ makeSync: marked ? suspending(fn) : fn });
    const unhandled: unknown[] = [];
    const listener = (e: PromiseRejectionEvent) => {
      e.preventDefault();
      unhandled.push(e.reason);
    };
    globalThis.addEventListener("unhandledrejection", listener);
    try {
      assertEq(
        await caught(() => c.exports.runSync(new R())) instanceof NeedsJspi,
        true,
      );
      await turn();
      assertEq(unhandled.length, 0);
      assertEq(await c.exports.ping(), 42);
    } finally {
      globalThis.removeEventListener("unhandledrejection", listener);
    }
  });
  for (const rejection of [false, true]) {
    Deno.test(`settlement: refused ${marked ? "marked" : "unmarked"} sync ${rejection ? "Error" : "own"} is observed without conversion`, async () => {
      const p = deferred();
      const fn = () => p.promise;
      const { c, registry } = await setup({
        makeSync: marked ? suspending(fn) : fn,
      });
      const arg = new R();
      const value = new R();
      const unhandled: unknown[] = [];
      const listener = (e: PromiseRejectionEvent) => {
        e.preventDefault();
        unhandled.push(e.reason);
      };
      globalThis.addEventListener("unhandledrejection", listener);
      try {
        assertEq(
          await caught(() => c.exports.runSync(arg)) instanceof NeedsJspi,
          true,
        );
        assertEq(
          registry.liveCount,
          0,
          "borrow registration unwound on refusal",
        );
        if (rejection) p.reject(new Error("late refused failure"));
        else p.resolve(value);
        await turn();
        assertEq(unhandled.length, 0, "refused rejection must be observed");
        assertEq(registry.liveCount, 0, "refused own must never be registered");
        assertEq(value.disposed, 0);
        assertEq(arg.disposed, 0);
        assertEq(
          await c.exports.ping(),
          42,
          "capability refusal does not poison",
        );
      } finally {
        globalThis.removeEventListener("unhandledrejection", listener);
      }
    });
  }
}

Deno.test("settlement: throwing then getter is a host failure and releases arguments (#343)", async () => {
  let thenReads = 0;
  const { c } = await setup({
    consume: () => ({
      get then() {
        thenReads++;
        throw new Error("then lookup failed");
      },
    }),
  });
  const { stream, writer } = Stream.create<number>();
  const fw = hostFuture<number>({ kind: "u32" });
  const future = Future.fromHostFuture(fw, {
    element: { kind: "u32" },
    toHost: (v) => v as number,
    fromHost: (v: number) => v,
  });
  const written = writer.writeAll(new Uint8Array([1, 2]));

  const error = await caught(() => c.exports.consume(stream, future, 0));
  assertEq(error instanceof Trap, true, String(error));
  assertEq(String(error).includes("then lookup failed"), true, String(error));
  assertEq(thenReads, 1, "completion classification reads then once");
  assertEq(await written, 0, "abandoned stream argument was released");
  await fw.write(7);
});

Deno.test("#347: facade result getter poisoning starts no later producer", async () => {
  const p = deferred();
  const setupResult = await setup({ producers: { sources: () => p.promise } });
  const c = setupResult.c;
  let futureGets = 0;
  let starts = 0;
  const call = caught(() => c.exports.sources(0));
  p.resolve({
    get stream() {
      sync(c.exports.trap)();
      return [1];
    },
    get future() {
      futureGets++;
      return {
        then() {
          starts++;
        },
      };
    },
  });
  await call;
  await turn();
  assertEq(isInstancePoisoned(c.handle.componentInstances[0]), true);
  assertEq(starts, 0, "producer does not start after getter poisoning");
  assertEq(futureGets, 0, "preparation stops at the poisoning throw");
});

for (const mode of [1, 2]) {
  for (const rejection of [false, true]) {
    Deno.test(`settlement: ${mode === 1 ? "cancelled" : "poisoned"} ${rejection ? "ComponentException own" : "own"} never registers`, async () => {
      const p = deferred();
      const { c, registry } = await setup({ make: () => p.promise });
      if (mode === 1) assertEq(await c.exports.start(mode), 4);
      else {assertEq(
          await caught(() => c.exports.start(mode)) instanceof Trap,
          true,
        );}
      const value = new R();
      if (rejection) p.reject(new ComponentException(value));
      else p.resolve(value);
      await turn();
      assertEq(
        registry.liveCount,
        0,
        "discard before facade ownership conversion",
      );
      assertEq(value.disposed, 0, "discard does not take ownership");
      assertEq(c.handle.componentInstances[0].store.hostFailure, undefined);
      if (mode === 1) assertEq(await c.exports.ping(), 42);
    });
  }
  Deno.test(`settlement: ${mode === 1 ? "cancelled" : "poisoned"} stream and nested future producers never start`, async () => {
    const p = deferred();
    const { c } = await setup({ producers: { sources: () => p.promise } });
    if (mode === 1) assertEq(await c.exports.sources(mode), 4);
    else {assertEq(
        await caught(() => c.exports.sources(mode)) instanceof Trap,
        true,
      );}
    let pulls = 0;
    let starts = 0;
    p.resolve({
      stream: {
        async *[Symbol.asyncIterator]() {
          pulls++;
          yield 1;
        },
      },
      future: {
        then(resolve: (v: number) => void) {
          starts++;
          resolve(7);
        },
      },
    });
    await turn();
    assertEq([pulls, starts], [0, 0]);
    assertEq(c.handle.componentInstances[0].store.hostFailure, undefined);
  });

  Deno.test(`settlement: late trapping rejection tears down ${mode === 1 ? "cancelled" : "poisoned"} async arguments`, async () => {
    const p = deferred();
    const { c } = await setup({ consume: () => p.promise });
    const { stream, writer } = Stream.create<number>();
    const fw = hostFuture<number>({ kind: "u32" });
    const future = Future.fromHostFuture(fw, {
      element: { kind: "u32" },
      toHost: (v) => v as number,
      fromHost: (v: number) => v,
    });
    const written = writer.writeAll(new Uint8Array([1, 2]));
    // The host has taken both readable ends before cancellation/poisoning.
    if (mode === 1) assertEq(await c.exports.consume(stream, future, mode), 4);
    else {assertEq(
        await caught(() => c.exports.consume(stream, future, mode)) instanceof
          Trap,
        true,
      );}
    p.reject(new Error("abandoned arguments"));
    await turn();
    assertEq(await written, 0);
    await fw.write(7);
    assertEq(c.handle.componentInstances[0].store.hostFailure, undefined);
  });
}

for (const foreign of ["stream", "future"] as const) {
  Deno.test({
    name:
      `settlement: deferred nested foreign ${foreign} refusal is non-poisoning`,
    ignore: !(await haveFixture(guest("future-user"))) ||
      !(await haveFixture("runtime/tests/embedder/busy-read.wasm")),
    async fn() {
      const futureSource = await instantiateFixture(guest("future-user"));
      const streamSource = await instantiateFixture(
        "runtime/tests/embedder/busy-read.wasm",
      );
      const created = Stream.create<number>();
      const stream = await streamSource.exports.passStream(
        created.stream,
      ) as Stream<number>;
      const future = futureSource.exports.makeFuture(20) as Future<number>;
      await turn();
      const settlement = deferred();
      let sources: () => unknown = () => settlement.promise;
      const { c } = await setup({
        producers: { sources: () => sources() },
      });

      await c.exports.sources(0);
      settlement.resolve({
        stream: foreign === "stream" ? stream : [1, 2],
        future: foreign === "future" ? future : Promise.resolve(7),
      });
      await turn();
      const error = await caught(() => c.exports.ping());
      assertEq(error instanceof TypeError, true, String(error));
      assertEq(String(error).includes("cross-store"), true, String(error));
      assertEq(
        isInstancePoisoned(c.handle.componentInstances[0]),
        false,
        "deferred settlement conversion retains its existing host-failure path",
      );

      if (foreign === "stream") {
        const reader = stream.readable().getReader();
        const write = created.writer.write(new Uint8Array([6, 8]));
        const read = await reader.read();
        assertEq([...(read.value ?? [])], [6, 8]);
        assertEq(await write, 2);
        reader.releaseLock();
      } else {
        assertEq(await future, 21, "refused future remains awaitable");
      }
      sources = () => ({
        stream: new Uint8Array([8]),
        future: Promise.resolve(9),
      });
      assertEq(
        await c.exports.sources(0),
        2,
        "valid proxy retry is accepted for lowering",
      );
      assertEq(await c.exports.ping(), 42, "destination remains live on retry");
    },
  });
}

for (const rejection of [false, true]) {
  Deno.test(`settlement: deferCancel delivers ${rejection ? "err" : "ok"} own exactly once`, async () => {
    const p = deferred();
    const { c, registry } = await setup({ make: deferCancel(() => p.promise) });
    assertEq(await c.exports.start(1), 0xffffffff);
    const value = new R();
    if (rejection) p.reject(new ComponentException(value));
    else p.resolve(value);
    await turn();
    assertEq(registry.liveCount, 1);
    assertEq(await c.exports.finish(), rejection ? 1 : 0);
    assertEq(registry.liveCount, 0);
    assertEq(value.disposed, 1);
  });

  Deno.test({
    name: `settlement: JSPI normal delivery of ${rejection ? "err" : "ok"} own`,
    ignore: !isSupported(),
    fn: async () => {
      const p = deferred();
      const { c, registry } = await setup({
        makeSync: suspending(() => p.promise),
      }, true);
      const call = c.exports.runSync(new R());
      const value = new R();
      if (rejection) p.reject(new ComponentException(value));
      else p.resolve(value);
      assertEq(await call, rejection ? 1 : 0);
      assertEq(registry.liveCount, 0);
      assertEq(value.disposed, 1);
    },
  });
}
