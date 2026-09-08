// JSPI mechanics — a small typed wrapper over `WebAssembly.promising` and
// `WebAssembly.Suspending`. This module is intentionally standalone: it has
// no knowledge of the task/scheduler model (runtime/src/task,exec,intrinsics,
// plan) and must not import from those directories. It is the mechanics
// layer consumed by bridge.ts, not the scheduler itself.
//
// # The frame rule (docs/architecture.md §5)
//
// From the js-promise-integration proposal Overview: only WebAssembly
// computations may be suspended — only wasm frames may be active between the
// call to a `promising`-wrapped export and any call to a `Suspending`-wrapped
// import. A JS frame anywhere in between traps.
//
// `runtime/tests/jspi/frame_rule_test.ts` checks the error and timing.
// Consequences:
//
//   - Host-boundary JS glue is safe: a `Suspending`-wrapped import's JS body
//     runs to completion and returns a Promise; the actual suspension
//     happens only after control returns to wasm, so glue code itself never
//     sits on the suspended stack (pinned in
//     `suspending_import_test.ts::pure_wasm_stack_suspends_and_resumes`).
//   - Cross-component JS glue between two wasm activations traps the moment
//     anything below it suspends — cross-component adapters must be wasm
//     (FACT), not JS (docs/architecture.md §4.1, §5).
//
// # Reentrancy and concurrency (empirical, not mechanics-layer policy)
//
// JSPI does not enforce task backpressure, callback exclusivity or poison
// refusal. Live-instance reentry is allowed; the scheduler owns the narrower
// admission and ordering rules. See `reentry_test.ts` and
// `concurrent_activations_test.ts` for engine behavior.

import { jspiApi } from "./types.ts";

/**
 * Opaque public alias for `WebAssembly.Suspending` instances.
 *
 * JSPI is not in the standard TS libs and JSR forbids global-type
 * augmentation, so the engine surface is module-scoped (`jspiApi()` in
 * ./types.ts) and the public API names this opaque brand; the value is
 * exactly a `WebAssembly.Suspending`, usable anywhere an import value is
 * expected.
 */
export type SuspendingImport = {
  readonly __polyengineSuspending: unique symbol;
};

/** True if the current engine implements `WebAssembly.promising` and
 * `WebAssembly.Suspending`. Both are phase-4 API surface (docs/architecture.md §3): no
 * fallback path exists or is planned for engines without them. */
export function isSupported(): boolean {
  return (
    typeof (globalThis as { WebAssembly?: unknown }).WebAssembly ===
      "object" && jspiApi() !== null
  );
}

/** Throws if JSPI is not available in the current engine. Call this before
 * using anything else in this module if you want a clear error instead of a
 * `TypeError: WebAssembly.promising is not a function`. */
export function assertSupported(): void {
  if (!isSupported()) {
    throw new Error(
      "JSPI (WebAssembly.promising / WebAssembly.Suspending) is not " +
        "available in this engine; see docs/architecture.md §3 for the compatibility " +
        "floor (no fallback path exists).",
    );
  }
}

/**
 * Wrap a wasm-exported function (as retrieved from
 * `instance.exports.someExport`) so that calling it:
 *   - always returns a Promise,
 *   - suspends the underlying wasm activation (rather than trapping) the
 *     first time it calls a `Suspending`-wrapped import that itself returns
 *     a genuine Promise,
 *   - resolves that Promise with the export's return value once the wasm
 *     activation runs to completion (after zero or more suspend/resume
 *     cycles).
 *
 * This is a direct type-safe pass-through of `WebAssembly.promising`; it
 * does no extra bookkeeping. `TArgs`/`TReturn` are the caller's own
 * annotation of the underlying export's signature (not reflected — see
 * docs/architecture.md §3's note on js-types being flagged/phase-3).
 */
export function makePromising<
  TArgs extends unknown[] = unknown[],
  TReturn = unknown,
>(
  wasmExport: (...args: TArgs) => TReturn,
): (...args: TArgs) => Promise<TReturn> {
  assertSupported();
  return jspiApi()!.promising(
    wasmExport as (...args: unknown[]) => unknown,
  ) as (...args: TArgs) => Promise<TReturn>;
}

/**
 * Wrap a JS function as a `Suspending` import: when a `promising`-suspendable
 * wasm activation calls it (per the frame rule above) and it returns a
 * genuine Promise, the wasm activation suspends until that Promise settles.
 * Non-Promise results avoid that wait but still cross the engine's return
 * hop. A non-eligible call is not a fallback path: it can trap even when the
 * import returns a plain value (`suspending_import_test.ts`).
 *
 * The returned value is an opaque `WebAssembly.Suspending` instance; hand it
 * directly to the instantiation `imports` object in the slot the wasm module
 * expects a function import.
 */
export function makeSuspending<
  TArgs extends unknown[] = unknown[],
  TReturn = unknown,
>(
  fn: (...args: TArgs) => TReturn | Promise<TReturn>,
): SuspendingImport {
  assertSupported();
  return new (jspiApi()!.Suspending)(
    fn as (...args: unknown[]) => unknown,
  ) as unknown as SuspendingImport;
}
