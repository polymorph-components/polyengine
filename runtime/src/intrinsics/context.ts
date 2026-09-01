// `CoreDef::UnsafeIntrinsic` (plan v1 / contracts/plan-format.md v0.3):
// wasmtime compile-time builtins that a component's core modules import
// directly, bypassing the trampoline table.
//
// Of wasmtime-environ 47.0.3's 21 unsafe intrinsics
// (`component/intrinsic.rs`, `for_each_unsafe_intrinsic!`) only four have
// Component Model meaning: `context-{get,set}-i32-{0,1}`, the canonical
// `context.get` / `context.set` built-ins. The other seventeen
// (`*-native-load` / `*-native-store` / `store-data-address`) are raw host
// memory access for wasmtime's own internals; they have no portable meaning
// in a JS host and are refused at instantiate time.

import { assert_, trapIf } from "../cabi/trap.ts";
import { currentThreadForInstance } from "../task/mod.ts";
import { ambientDebug, dbgId } from "../task/scheduler.ts";
import type { CurrentThreadLike } from "../task/mod.ts";
import type { CoreFn } from "../exec/boundary.ts";
import { UnsupportedFeatureError } from "./errors.ts";

/**
 * Number of `i32` context slots per thread. definitions.py `Thread.storage`
 * is initialised `[0,0]` (line 347) and `canon_context_{get,set}` assert
 * `i < len(thread.storage)` — so exactly two, matching the intrinsic names
 * `context-*-i32-0` and `context-*-i32-1`.
 */
export const NUM_CONTEXT_SLOTS = 2;

/**
 * definitions.py `canon_context_get` (line 2348).
 *
 * The storage is **per thread**, not per task: two threads of one task have
 * independent context. wit-bindgen 0.60 keeps its async-executor task pointer
 * in slot 0, which is why this intrinsic is the entry blocker for async
 * guests.
 */
export function canonContextGet(i: number, inst?: unknown): number {
  const thread = currentThreadForInstance<CurrentThreadLike>(inst);
  assert_(i < NUM_CONTEXT_SLOTS, `context.get slot ${i} out of range`);
  const result = thread.storage[i];
  assert_(result < 2 ** 32, "context.get value out of i32 range");
  if (CTX_TRACE) trace(`get[${i}] -> ${result}`, thread);
  return result >>> 0;
}

// Standing probe (CE_CTX_TRACE=1): per-call context-slot traffic with the
// full ambient state — the instrument that isolated issue #24. Cheap and
// env-gated; keep.
const CTX_TRACE = (() => {
  try {
    return Deno.env.get("CE_CTX_TRACE") === "1";
  } catch {
    return false;
  }
})();
export function ctxThreadId(t: unknown): string {
  return dbgId(t);
}
function trace(msg: string, thread: unknown): void {
  const a = ambientDebug();
  console.error(`[ctx] ${ctxThreadId(thread)} ${msg} storage=${
    JSON.stringify((thread as CurrentThreadLike).storage)
  } | stack=[${a.stack.map(ctxThreadId).join(",")}] claims=[${
    a.claims.map(ctxThreadId).join(",")
  }]`);
}

/** definitions.py `canon_context_set` (line 2358). */
export function canonContextSet(i: number, v: number, inst?: unknown): void {
  const thread = currentThreadForInstance<CurrentThreadLike>(inst);
  assert_(i < NUM_CONTEXT_SLOTS, `context.set slot ${i} out of range`);
  if (CTX_TRACE) trace(`set[${i}] = ${v >>> 0}`, thread);
  thread.storage[i] = v >>> 0;
}

/**
 * Materialize one `unsafe-intrinsic` CoreDef as a core function.
 *
 * Called during initializer resolution — i.e. at instantiate time — so an
 * unimplementable symbol fails instantiation rather than the first call
 * (contracts/plan-format.md "Executor obligations").
 */
export function createUnsafeIntrinsic(
  symbol: string,
  /**
   * The component instance whose core module declares this import — the
   * instance whose frame is, by construction, the one executing when it is
   * called. `undefined`/`null` (a FACT adapter module, which the plan records
   * with `instance: null`) falls back to the unscoped ambient. See
   * `currentThreadForInstance` (task/scheduler.ts) for why this discriminator
   * is what makes a JSPI continuation chunk's `context.set` land in its own
   * thread's slots.
   */
  inst?: unknown,
): CoreFn {
  const match = /^context-(get|set)-i32-(\d+)$/.exec(symbol);
  if (match === null) {
    throw new UnsupportedFeatureError(
      "task-core",
      `component imports the unsafe intrinsic '${symbol}', which has no ` +
        `portable meaning in a JS host (only context.{get,set} do)`,
    );
  }
  const slot = Number(match[2]);
  // A slot outside the canonical range would be a wasmtime/plan inconsistency
  // rather than a missing capability, but refusing it here is still the right
  // shape: instantiate-time, never call-time.
  trapIf(
    slot >= NUM_CONTEXT_SLOTS,
    `unsafe intrinsic '${symbol}' addresses context slot ${slot}, but a ` +
      `thread has ${NUM_CONTEXT_SLOTS}`,
  );
  if (match[1] === "get") return () => canonContextGet(slot, inst);
  return (v?: number) => {
    canonContextSet(slot, (v ?? 0) >>> 0, inst);
  };
}
