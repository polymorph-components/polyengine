// definitions.py canon_resource_drop: a fresh synchronous lift/task/thread,
// even when the dropper is async. Host completion policy does not apply.
import {
  canonResourceDrop,
  canonResourceNew,
  ResourceTypeInfo,
  Trap,
} from "../src/cabi/mod.ts";
import {
  ComponentInstanceState,
  currentTask,
  currentThread,
  Store,
  type Thread,
} from "../src/task/mod.ts";
import {
  isInstancePoisoned,
  maybeCurrentThread,
  NeedsJspi,
} from "../src/task/scheduler.ts";
import {
  createDtorEntry,
  createLiftedFunction,
  newStats,
  type ResolvedOptions,
} from "../src/exec/boundary.ts";
import { instantiateComponent } from "../src/exec/mod.ts";
import { Translator } from "../src/shim/mod.ts";
import { assertEq } from "./support/asserts.ts";

function options(instance: ComponentInstanceState): ResolvedOptions {
  return {
    instance,
    stringEncoding: "utf8",
    memory: null,
    realloc: null,
    postReturn: null,
    callback: null,
    async: false,
    cancellable: false,
    coreType: { params: [], results: [] },
  };
}

Deno.test("guest dtor isolates task, both context slots, and post-return attribution", () => {
  const store = new Store();
  const caller = new ComponentInstanceState(0, store);
  const impl = new ComponentInstanceState(1, store);
  let outer: Thread;
  const rt = new ResourceTypeInfo(impl, (rep) => {
    assertEq(rep, 7);
    assertEq(currentTask().inst === impl, true);
    assertEq(currentTask().ft.async, false);
    assertEq(currentTask().opts.async_, false);
    const thread = currentThread<Thread>();
    assertEq(thread === outer, false);
    assertEq(thread.storage, [0, 0]);
    thread.storage[0] = 99;
    thread.storage[1] = 100;
  });
  const failure = new Trap("post-return trap");
  const opts = options(caller);
  opts.postReturn = () => () => {
    assertEq(currentThread() === outer, true);
    assertEq(currentTask().inst === caller, true);
    assertEq(outer.storage, [42, 43]);
    throw failure;
  };
  const call = createLiftedFunction({
    name: "drop",
    ft: { params: [], results: [] },
    opts,
    stats: newStats(),
    core: () => {
      outer = currentThread<Thread>();
      outer.storage[0] = 42;
      outer.storage[1] = 43;
      canonResourceDrop(caller, rt, canonResourceNew(caller, rt, 7));
      assertEq(currentThread() === outer, true);
      assertEq([...impl.threads].length, 0);
    },
  });
  let caught: unknown;
  try {
    call();
  } catch (e) {
    caught = e;
  }
  assertEq(caught === failure, true);
  assertEq(isInstancePoisoned(caller), true);
  assertEq(isInstancePoisoned(impl), false);
  assertEq(maybeCurrentThread(), undefined);
});

for (const capability of [false, true]) {
  Deno.test(`guest dtor unwind preserves outer state (capability=${capability})`, () => {
    const store = new Store();
    const caller = new ComponentInstanceState(0, store);
    const impl = new ComponentInstanceState(1, store);
    const failure = capability
      ? new NeedsJspi("dtor probe")
      : new Trap("dtor trap");
    const trapState = { pending: failure as unknown };
    const entry = createDtorEntry({
      instance: impl,
      guestCaller: caller,
      trapState,
      allInstances: () => [caller, impl],
      dtor: () => {
        assertEq(trapState.pending === failure, true);
        assertEq(currentTask().inst === impl, true);
        throw failure;
      },
    });
    const call = createLiftedFunction({
      name: "outer",
      ft: { params: [], results: [] },
      opts: options(caller),
      stats: newStats(),
      core: () => {
        const outer = currentThread();
        caller.mayLeave = false;
        let caught: unknown;
        try {
          entry(0);
        } catch (e) {
          caught = e;
        }
        assertEq(caught === failure, true);
        assertEq(currentThread() === outer, true);
        assertEq(caller.mayLeave, false);
        assertEq(trapState.pending === failure, true);
        caller.mayLeave = true;
      },
    });
    call();
    assertEq(isInstancePoisoned(impl), !capability);
    assertEq(isInstancePoisoned(caller), false);
  });
}

for (const jspi of [false, true]) {
  Deno.test(`translated guest dtor context, sync and async caller (jspi=${jspi})`, async () => {
    const translator = await Translator.create(
      await Deno.readFile(
        new URL(
          "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
          import.meta.url,
        ),
      ),
    );
    const componentBytes = await Deno.readFile(
      new URL("dtor_guest_context.wasm", import.meta.url),
    );
    const { plan, adapters } = translator.translate(componentBytes);
    const component = await instantiateComponent({
      plan,
      adapters,
      componentBytes,
      jspi,
    });
    const exports = component.exports as Record<string, () => unknown>;
    assertEq(await exports.probe(), 42);
    assertEq(await exports.seen(), 0);
    await exports["async-probe"]();
    assertEq(await exports.seen(), 0);
  });
}

Deno.test("async caller cannot give guest dtor async completion or a host-wide drive", () => {
  const store = new Store();
  const caller = new ComponentInstanceState(0, store);
  const impl = new ComponentInstanceState(1, store);
  const opts = options(caller);
  opts.async = true;
  opts.callback = () => () => {
    throw new Error("unexpected callback");
  };
  opts.coreType.results = ["i32"];
  let ranSibling = false;
  // Ready store work is the host driver's responsibility, not resource.drop's.
  const sibling = {
    ready: () => true,
    resume: () => {
      ranSibling = true;
    },
  };
  const call = createLiftedFunction({
    name: "async dropper",
    ft: { params: [], results: [], async: true },
    opts,
    stats: newStats(),
    core: () => {
      const outer = currentThread<Thread>();
      store.waiting.push(sibling as never);
      const quick = new ResourceTypeInfo(impl, () => {
        assertEq(currentTask().ft.async, false);
        assertEq(currentTask().opts.async_, false);
      });
      canonResourceDrop(caller, quick, canonResourceNew(caller, quick, 0));
      assertEq(ranSibling, false);
      store.waiting.pop();
      const slow = new ResourceTypeInfo(impl, () => Promise.resolve());
      let caught: unknown;
      try {
        canonResourceDrop(caller, slow, canonResourceNew(caller, slow, 0));
      } catch (e) {
        caught = e;
      }
      assertEq(caught instanceof Trap, true);
      assertEq(
        (caught as Error).message.includes("did not complete synchronously"),
        true,
      );
      assertEq(currentThread() === outer, true);
      assertEq(currentTask().state, "started");
      currentTask().return_([]);
      return 0;
    },
  });
  call();
  assertEq(isInstancePoisoned(impl), true);
  assertEq(isInstancePoisoned(caller), false);
});
