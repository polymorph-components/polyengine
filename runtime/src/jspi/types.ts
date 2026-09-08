// Module-scoped types + accessor for the JS Promise Integration (JSPI) API.
//
// Module-scoped declarations avoid global augmentation in published packages.
// JSPI is optional: jspiApi returns this surface only after probing both APIs.
// Proposal: https://github.com/WebAssembly/js-promise-integration.

/**
 * The engine's JSPI surface, as probed.
 *
 * `Suspending` wraps a JS function that returns a Promise (or any value —
 * the fast path pinned in `suspending_import_test.ts`) so it can be called
 * as a wasm import that may suspend the calling wasm activation. It must
 * only actually suspend while every frame between the nearest enclosing
 * `promising`-wrapped entry and the call is a wasm frame — the "frame
 * rule" (docs/architecture.md §5; `frame_rule_test.ts` pins the observed
 * error shape).
 *
 * `promising` wraps a wasm-exported function so that calling it returns a
 * Promise instead of (potentially) suspending the JS caller: the wasm
 * activation becomes suspendable, and any `Suspending` import it calls
 * transfers control back to the event loop instead of trapping.
 */
export interface JspiApi {
  // deno-lint-ignore no-explicit-any
  Suspending: new (fn: (...args: any[]) => any) => object;
  promising: (
    // deno-lint-ignore no-explicit-any
    fn: (...args: any[]) => any,
    // deno-lint-ignore no-explicit-any
  ) => (...args: any[]) => Promise<any>;
}

/**
 * The engine's JSPI API, or `null` where the proposal is not implemented.
 * The one sanctioned way to reach `WebAssembly.Suspending`/`promising`
 * from this codebase's published modules.
 */
export function jspiApi(): JspiApi | null {
  const wa = WebAssembly as unknown as Partial<JspiApi>;
  return typeof wa.promising === "function" &&
      typeof wa.Suspending === "function"
    ? (wa as JspiApi)
    : null;
}
