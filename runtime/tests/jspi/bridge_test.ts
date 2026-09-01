// The JSPI ↔ scheduler bridge (runtime/src/jspi/bridge.ts).
//
// These tests exercise the bridge *without* an engine JSPI dependency: a
// `SuspensionPoint` is an ordinary `SchedulableThread` from the scheduler's
// point of view, which is the whole design claim — the phase-1 seam means the
// scheduler cannot tell a suspended wasm activation from a parked generator.
// The engine-level facts themselves are pinned by the sibling files in this
// directory.

import { assertEq } from "../support/asserts.ts";
import {
  assertModeConsistent,
  chooseMode,
  enterWasm,
  planNeedsSuspension,
  SuspensionPoint,
  suspendingImport,
} from "../../src/jspi/mod.ts";
import { isSupported } from "../../src/jspi/mechanics.ts";
import { entryRefusal } from "../../src/task/scheduler.ts";
import {
  ComponentInstanceState,
  maybeCurrentThread,
  popCurrentThread,
  pushCurrentThread,
  Store,
  Task,
  Thread,
} from "../../src/task/mod.ts";
import type { FuncType } from "../../src/cabi/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const FT: FuncType = { params: [], results: [], async: true };
function mkTask(inst: ComponentInstanceState): Task {
  return new Task(
    FT,
    { async_: true, callback: true, stringEncoding: "utf8", memory: null },
    inst,
    () => [],
    () => {},
  );
}

Deno.test("bridge: a suspension point is just a parked thread to the scheduler", async () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const task = mkTask(inst);
  let flag = false;
  const point = new SuspensionPoint<number>(
    store,
    task,
    () => flag,
    false,
    () => 42,
  );
  // Registered in the store's waiting list exactly like a generator thread.
  assertEq(store.waiting.length, 1);
  assertEq(point.ready(), false);
  assertEq(store.tick(), false); // not ready: no progress
  flag = true;
  assertEq(point.ready(), true);
  assertEq(store.tick(), true); // the scheduler resumed it
  assertEq(await point.promise, 42);
  assertEq(store.waiting.length, 0);
});

Deno.test("bridge: resume delivers the cancelled flag to the value producer", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const point = new SuspensionPoint<string>(
    store,
    mkTask(inst),
    () => true,
    true,
    (cancelled) => (cancelled ? "cancelled" : "normal"),
  );
  point.resume(true);
  return point.promise.then((v) => assertEq(v, "cancelled"));
});

Deno.test("bridge: a trap computed at resume time becomes a rejection", async () => {
  // Empirical fact (e): a post-resume trap arrives as an ordinary rejection of
  // the import's Promise, which the engine turns back into a wasm trap. So the
  // producer throwing must reject, not throw synchronously into the scheduler.
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const boom = new Error("trap at resume");
  const point = new SuspensionPoint<number>(
    store,
    mkTask(inst),
    () => true,
    false,
    () => {
      throw boom;
    },
  );
  point.resume(); // must not throw here
  let caught: unknown;
  await point.promise.catch((e) => (caught = e));
  assertEq(caught, boom);
  assertEq(store.waiting.length, 0);
});

Deno.test("bridge: a suspension does not make the instance unusable", async () => {
  // Was: "reentrance gates are ours and hold across a suspension". Empirical
  // fact (d) is unchanged — the ENGINE freely permits reentering an instance
  // while one of its activations is suspended — but the Component Model no
  // longer forbids it either: CM#705 (definitions.py @ 2f13265) deleted
  // `may_enter`/`enter_from`/`leave_to`, so there is no gate to hold
  // (polyengine#173). What this pins now is that a suspended-and-resumed
  // activation leaves the instance entirely usable: nothing is refused before,
  // during or after.
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  let flag = false;
  const point = new SuspensionPoint<number>(
    store,
    mkTask(inst),
    () => flag,
    false,
    () => 1,
  );
  assertEq(entryRefusal(inst, null, "base"), null, "entry is admitted");
  flag = true;
  point.resume();
  await point.promise;
  assertEq(entryRefusal(inst, null, "base"), null, "still admitted");
});

Deno.test("bridge: abandon rejects without resuming the guest", async () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const point = new SuspensionPoint<number>(
    store,
    mkTask(inst),
    () => false,
    false,
    () => 0,
  );
  const reason = new Error("torn down");
  point.abandon(reason);
  let caught: unknown;
  await point.promise.catch((e) => (caught = e));
  assertEq(caught, reason);
  assertEq(store.waiting.length, 0);
});

// ---------------------------------------------------------------------------
// The invariant, and degradation
// ---------------------------------------------------------------------------

Deno.test("bridge: mode is plain unless BOTH requested and supported", () => {
  assertEq(chooseMode(undefined), "plain");
  assertEq(chooseMode(false), "plain");
  // On this engine the answer depends on JSPI availability; either way it is
  // never "jspi" without an explicit opt-in.
  assertEq(chooseMode(true), isSupported() ? "jspi" : "plain");
});

Deno.test("bridge: JSPI-less degradation — plain mode wraps nothing", () => {
  // The browser-matrix degradation path. On an engine without JSPI every
  // blocking site keeps raising its precise NeedsJspi, which requires that
  // plain mode leave both wrapping sites untouched — a `Suspending` import
  // reached from a non-promising activation traps unconditionally (fact (c)).
  const fn = (x: number) => x + 1;
  // Identity, not a wrapper — compared by reference on purpose.
  assert(enterWasm(fn, "plain") === fn, "plain mode must not wrap entries");
  assert(
    suspendingImport(fn, "plain") === fn,
    "plain mode must not wrap imports",
  );
  assertEq((enterWasm(fn, "plain") as (x: number) => number)(1), 2);
});

Deno.test("bridge: the invariant is checked, not hoped for", () => {
  // plain mode: neither site wrapped.
  assertModeConsistent("plain", false, false);
  // jspi mode: both sites wrapped.
  assertModeConsistent("jspi", true, true);
  // jspi mode with NO wrapped imports is legal: per-declaration
  // classification (trampolineNeedsSuspension) wraps nothing in a component
  // whose built-ins are all async forms, while the mode can still be jspi
  // via planNeedsSuspension's lift-shape over-approximation.
  assertModeConsistent("jspi", true, false);
  // The dangerous mixtures are rejected — fact (c) makes these fatal:
  // a Suspending import with no promising entry, and any wrapping at all
  // in plain mode.
  for (
    const [mode, e, i] of [
      ["jspi", false, true],
      ["plain", true, false],
      ["plain", false, true],
    ] as const
  ) {
    let threw = false;
    try {
      assertModeConsistent(mode, e, i);
    } catch {
      threw = true;
    }
    assert(threw, `mixture (${mode}, entries=${e}, imports=${i}) must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// Plain mode must stay exactly the original synchronous API
// ---------------------------------------------------------------------------

Deno.test("bridge: planNeedsSuspension recognises both sources of blocking", () => {
  const none = { canonicalOptions: [], trampolines: [] };
  assertEq(planNeedsSuspension(none), false);
  // A callback-ABI async lift is stackless — it never blocks a wasm frame.
  assertEq(
    planNeedsSuspension({
      canonicalOptions: [{ async: true, callback: 0 }],
      trampolines: [],
    }),
    false,
  );
  // A stackful async lift (async options, no callback) does.
  assertEq(
    planNeedsSuspension({
      canonicalOptions: [{ async: true, callback: null }],
      trampolines: [],
    }),
    true,
  );
  // ... as does any synchronously-blocking built-in.
  for (
    const kind of [
      "sync-start-call",
      "waitable-set-wait",
      "thread-yield",
      "subtask-cancel",
      "stream-read",
      "future-write",
    ]
  ) {
    assertEq(
      planNeedsSuspension({ canonicalOptions: [], trampolines: [{ kind }] }),
      true,
      kind,
    );
  }
  // Non-blocking built-ins must NOT flip a component to jspi mode.
  for (const kind of ["stream-new", "waitable-set-poll", "task-return"]) {
    assertEq(
      planNeedsSuspension({ canonicalOptions: [], trampolines: [{ kind }] }),
      false,
      kind,
    );
  }
  // Per-DECLARATION sharpening: the async FORM of a copy/cancel built-in
  // never blocks (definitions.py returns BLOCKED instead), so it must not
  // flip the mode either — kind alone is not enough.
  for (
    const kind of [
      "subtask-cancel",
      "stream-cancel-read",
      "stream-cancel-write",
      "future-cancel-read",
      "future-cancel-write",
    ]
  ) {
    assertEq(
      planNeedsSuspension({
        canonicalOptions: [],
        trampolines: [{ kind, async: true }],
      }),
      false,
      `${kind} (async form)`,
    );
  }
  for (const kind of ["stream-read", "stream-write", "future-read", "future-write"]) {
    assertEq(
      planNeedsSuspension({
        canonicalOptions: [{ async: true, callback: 0 }],
        trampolines: [{ kind, options: 0 }],
      }),
      false,
      `${kind} (async options)`,
    );
    assertEq(
      planNeedsSuspension({
        canonicalOptions: [{ async: false, callback: null }],
        trampolines: [{ kind, options: 0 }],
      }),
      true,
      `${kind} (sync options)`,
    );
  }
  // `async-start-call` is Suspending-WRAPPED in jspi mode (the determinacy
  // park) but is never a reason to choose jspi mode.
  assertEq(
    planNeedsSuspension({
      canonicalOptions: [],
      trampolines: [{ kind: "async-start-call" }],
    }),
    false,
    "async-start-call",
  );
});

Deno.test("plain mode: lifted exports still return values, not Promises", async () => {
  // The stop-the-line property, RESTATED FOR AUTO-DETECTION: a
  // sync-only component must never be wrapped. Instantiation below passes no
  // `jspi` flag at all, so it exercises exactly the auto-detection path the
  // executor now runs; the value-not-Promise assertion holds only if
  // `planNeedsSuspension(hello) === false`, which is also pinned explicitly.
  const root = new URL("../../../", import.meta.url);
  let shim: Uint8Array, guest: Uint8Array;
  try {
    shim = await Deno.readFile(
      new URL("target/wasm32-unknown-unknown/release/translator_shim.wasm", root),
    );
    guest = await Deno.readFile(
      new URL("examples/guests/build/hello.component.wasm", root),
    );
  } catch {
    return; // artifacts absent; the conformance run covers this too
  }
  const { Translator } = await import("../../src/shim/mod.ts");
  const { instantiateComponent } = await import("../../src/exec/mod.ts");
  const t = await Translator.create(shim);
  const { plan, adapters } = t.translate(guest);
  // The detection predicate itself, pinned on a real sync-only plan.
  assertEq(
    planNeedsSuspension(
      plan as unknown as {
        canonicalOptions: { async: boolean; callback: number | null }[];
        trampolines: { kind: string }[];
      },
    ),
    false,
    "a sync-only component must not detect as needing suspension",
  );
  const c = await instantiateComponent({
    plan,
    componentBytes: guest,
    adapters,
  });
  const greet = c.exports.greet as (n: string) => unknown;
  const out = greet("plain");
  assert(
    !(out instanceof Promise),
    "a plain-mode export must return its value synchronously",
  );
  assertEq(out, "Hello, plain!");
});

// ---------------------------------------------------------------------------
// The blocker that actually gates the light-up
// ---------------------------------------------------------------------------

Deno.test({
  name: "jspi: the ambient current-thread does not survive a suspension",
  ignore: !isSupported(),
  fn: async () => {
    // This is the fact that made naive auto-detection impossible until the
    // activation-attached ambient existed (pins (h)/(i)); it stays pinned so
    // nobody re-diagnoses it.
    //
    // `currentThread()` is ambient: `pushCurrentThread` brackets a synchronous
    // generator step. Under JSPI the engine resumes a suspended wasm
    // activation in a microtask of its own, outside any JS frame we control,
    // so a built-in called after the resume finds an empty stack. Every
    // built-in that reads current_thread/task/instance is affected —
    // `context.{get,set}`, `task.{return,cancel}`, `subtask.*`,
    // `thread.yield`, and the stream/future built-ins.
    //
    // The test models exactly that shape without needing a guest: run a step
    // under the ambient, suspend, and observe the ambient from a later
    // microtask.
    const store = new Store();
    const inst = new ComponentInstanceState(0, store);
    const task = mkTask(inst);
    const thread = new Thread(task, (function* () {})());

    pushCurrentThread(thread);
    const insideStep = maybeCurrentThread() !== undefined;
    popCurrentThread(thread);

    // A resumption delivered through a Promise — the JSPI shape.
    const point = new SuspensionPoint<number>(
      store,
      task,
      () => true,
      false,
      () => 1,
    );
    point.resume();
    await point.promise;
    const afterResume = maybeCurrentThread() !== undefined;

    assertEq(insideStep, true); // ambient is set while a step runs
    assertEq(afterResume, false); // ... and gone once we are in a microtask
    assert(
      insideStep && !afterResume,
      "the ambient current-thread is frame-scoped; JSPI resumption is not",
    );
  },
});
