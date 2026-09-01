// The per-declaration suspendability marker (contracts/embedder-api.md
// §"Functions and async"; docs/architecture.md §5).
//
// Returning a Promise from a sync-typed host import blocks the calling wasm
// FRAME — a capability with per-call cost (jspi pin (j): a Suspending
// import's continuation is deferred even on the fast path) and legality
// consequences (pin (c): a Suspending import called outside a promising
// activation traps, so a start function must never reach one). Neither cost
// may be imposed silently on every host import, and the plan cannot know
// which imports intend to park (`planNeedsSuspension` sees declarations,
// not host implementations). The embedder therefore declares intent
// per-function: only imports wrapped in `suspending()` are handed to wasm
// as `WebAssembly.Suspending`, everything else keeps the plain calling
// convention and its zero-cost pin.
//
// This module used to be
// `runtime/src/jspi/suspending.ts` (which now re-exports it). The brand moved
// from a module-local `Symbol(...)` to the process-global registry symbol
// `polyengine.suspending/1` — the old "local symbol by repo convention (bundle
// and source runtimes are never mixed in one process)" rule is REPEALED,
// because consumer graphs demonstrably do mix copies (issue #83) and a
// module-local symbol made a copy-B `suspending()` mark invisible to copy A's
// `anySuspendingImport` — a silent downgrade to the non-parking calling
// convention, surfacing far away as `NeedsJspi`.
//
// Layering: dependency-free apart from ./brands.ts (the protocol package as a
// whole imports nothing).

import { defineBrand, hasBrand, SUSPENDING } from "./brands.ts";

interface Suspendable {
  [SUSPENDING]?: true;
}

/**
 * Declare that this sync-typed host import may return a Promise, parking
 * the calling wasm frame until it settles (JSPI engines only — the
 * engine-floor caveat of contracts/embedder-api.md §"Functions and async").
 *
 * The declaration is evidence for jspi auto-detection, forces the importing
 * component's entries onto the promising convention (pin (c)), and adds a
 * continuation hop to EVERY call through this import even when it returns
 * synchronously (pin (j)) — mark only imports that genuinely park. Async-
 * typed imports never need this: a Promise from an async import rides the
 * task core with no JSPI involved.
 *
 * Two forms, one brand:
 *
 *   * **direct call** — `poll: suspending((list) => …)` — the canonical
 *     form, and the only one available inside record literals;
 *   * **stage-3 method decorator** — `@suspending read() { … }` on a
 *     provider class or a host-implemented resource class (methods and
 *     statics; the brand authority for instance methods is the CLASS
 *     PROTOTYPE — see instantiate.ts `#dispatcher`).
 *
 * The decorator form REFUSES anything it cannot mark, loudly: decorating a
 * class, getter, setter, accessor or field throws at class-definition time
 * (a silent no-op would surface as a runtime `NeedsJspi` far from the
 * mistake), and the TypeScript-legacy `experimentalDecorators` calling
 * convention throws with a pointer here — under that convention the
 * decorator receives the PROTOTYPE, not the method, and marking it would
 * both brand the wrong object and corrupt the property descriptor.
 * Constructors are never markable (synchronous per §"Resources"; the
 * language reserves no constructor-decorator position anyway).
 *
 * The value is marked in place (functions are objects); the return is the
 * same function, typed for insertion into an imports record or for method
 * replacement.
 */
export function suspending<F extends CallableFunction>(
  fn: F,
  context?: unknown,
  legacyDescriptor?: unknown,
): F {
  // TypeScript-legacy method decorator convention: (prototype, key,
  // descriptor). Detectable because stage-3 contexts are objects with a
  // string `kind`, never string/symbol property keys.
  if (
    typeof context === "string" || typeof context === "symbol" ||
    legacyDescriptor !== undefined
  ) {
    throw new TypeError(
      "suspending: legacy (experimentalDecorators) method decoration is not " +
        "supported — the decorator would receive the prototype, not the " +
        "method. Compile with stage-3 decorators (the default), or use the " +
        "call form: `f: suspending(fn)`.",
    );
  }
  if (context !== undefined) {
    const kind = (context as { kind?: unknown }).kind;
    if (kind !== "method") {
      throw new TypeError(
        `suspending: cannot decorate a ${String(kind)} — only methods ` +
          `(instance or static) can be marked suspendable. Constructors are ` +
          `synchronous by contract; for record-literal imports use the call ` +
          `form: \`f: suspending(fn)\`.`,
      );
    }
  }
  if (typeof fn !== "function") {
    throw new TypeError(
      `suspending: expected a function, got ${typeof fn}`,
    );
  }
  // Non-enumerable (`defineBrand`): the mark must not show up in value
  // walks of an imports record, and re-marking the same function is a no-op.
  defineBrand(fn as unknown as object, SUSPENDING);
  return fn;
}

/** Brand check (executor-side). */
export function isSuspending(value: unknown): boolean {
  return typeof value === "function" && hasBrand(value, SUSPENDING);
}

/**
 * Does this imports record declare any suspending leaf? Evidence for
 * `chooseMode`: a marked import is an embedder statement that a park is
 * expected, so auto-detection selects jspi even when the plan itself shows
 * no blocking declarations (the p2 sync-world case: a component whose only
 * blocking site is a host pollable). Walks exactly the shapes
 * `lookupHostImport` can reach: top-level values and one level of
 * interface-record members.
 */
export function anySuspendingImport(
  imports: Record<string, unknown> | undefined,
): boolean {
  if (imports === undefined) return false;
  for (const value of Object.values(imports)) {
    if (isSuspending(value)) return true;
    if (value !== null && typeof value === "object") {
      for (const member of Object.values(value)) {
        if (isSuspending(member)) return true;
      }
    }
  }
  return false;
}
