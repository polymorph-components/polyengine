// The per-declaration cancel-discard opt-out (contracts/embedder-api.md
// §"Functions and async"; polyengine#241).
//
// A guest may cancel an in-flight async-typed import (`subtask.cancel`;
// wit-bindgen reaches it by dropping the import's future). The reference
// leaves the answer to the embedding — `Store.invoke` takes the callee's
// `OnCancel` back from the callee itself (definitions.py line 572) — and a
// wasmtime host gets a real one for free, because dropping a Rust future IS
// cancellation. A JS Promise has no such channel, so polyengine answers on
// the host's behalf, and the DEFAULT answer is the reference's prompt-cancel
// host: `on_cancel = () => on_resolve(None)` (definitions.py canon_lower line
// ~2267). The subtask resolves CANCELLED_BEFORE_RETURNED at once, both cancel
// forms return without blocking, and the host call's eventual settlement is
// discarded — never lowered, a rejection reported nowhere (the guest
// renounced the call; there is no addressee), and no longer counted as
// guest-wakeable for deadlock detection.
//
// Discard is a statement about DELIVERY, not about EXECUTION: a Promise
// cannot be aborted from outside, so the host operation still runs to
// completion and its side effects still land. That is exactly the hazard this
// brand exists for. Mark an import whose body has a COMMIT POINT — a flush, a
// database write, a payment — where "cancelled" would let the guest believe
// nothing happened while the write is landing anyway. A marked import keeps
// deferCancel()'s behavior, now per-declaration: the request is accepted and
// ignored, the async cancel form answers BLOCKED, the sync form parks, and the
// guest observes RETURNED with the real result.
//
// The mark is tolerated and INERT on sync-typed imports. That is vacuous
// truth, not a wart: a sync-typed import's suspending() park never mints a subtask
// handle, so `subtask.cancel` cannot name it at all, and the no-discard
// guarantee holds because nothing can request the discard.
//
// Independent of `suspending()` — different questions, different brands, and
// both may sit on one function. There is deliberately no
// `anyDeferCancelImport` analogue: unlike suspending()'s mark, this brand is not
// evidence for mode selection, so nothing needs to walk an imports record
// looking for it. It is read per-declaration at lowering time
// (exec/executor.ts `buildLoweredImport`).
//
// Layering: dependency-free apart from ./brands.ts (the protocol package as a
// whole imports nothing).

import { DEFER_CANCEL, defineBrand, hasBrand } from "./brands.ts";

/**
 * Declare that this host import must run to completion: a guest cancellation
 * of an in-flight call is accepted and IGNORED rather than answered with the
 * default cancel-discard.
 *
 * Use it for imports with a commit point — anything whose side effects land
 * regardless, where reporting CANCELLED_BEFORE_RETURNED to the guest would be
 * an outright lie about what happened. A marked import's async cancel form
 * answers BLOCKED, its sync form parks, and the guest sees RETURNED carrying
 * the real result once the promise settles.
 *
 * Two forms, one brand (`polyengine.deferCancel/1`), exactly as
 * `suspending()`:
 *
 *   * **direct call** — `flush: deferCancel(() => …)` — the canonical form,
 *     and the only one available inside record literals;
 *   * **stage-3 method decorator** — `@deferCancel flush() { … }` on a
 *     provider class or a host-implemented resource class (methods and
 *     statics).
 *
 * The decorator form REFUSES anything it cannot mark, loudly: decorating a
 * class, getter, setter, accessor or field throws at class-definition time (a
 * silent no-op would surface as a discarded commit, arbitrarily far from the
 * mistake), and the TypeScript-legacy `experimentalDecorators` calling
 * convention throws with a pointer here — under that convention the decorator
 * receives the PROTOTYPE, not the method, and marking it would both brand the
 * wrong object and corrupt the property descriptor. Constructors are never
 * markable (synchronous per §"Resources"; the language reserves no
 * constructor-decorator position anyway).
 *
 * Tolerated and inert on sync-typed imports (they can never be cancelled);
 * independent of `suspending()`, and both marks may ride one function.
 *
 * The value is marked in place (functions are objects); the return is the
 * same function, typed for insertion into an imports record or for method
 * replacement.
 */
export function deferCancel<F extends CallableFunction>(
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
      "deferCancel: legacy (experimentalDecorators) method decoration is not " +
        "supported — the decorator would receive the prototype, not the " +
        "method. Compile with stage-3 decorators (the default), or use the " +
        "call form: `f: deferCancel(fn)`.",
    );
  }
  if (context !== undefined) {
    const kind = (context as { kind?: unknown }).kind;
    if (kind !== "method") {
      throw new TypeError(
        `deferCancel: cannot decorate a ${String(kind)} — only methods ` +
          `(instance or static) can be marked cancel-deferring. Constructors ` +
          `are synchronous by contract; for record-literal imports use the ` +
          `call form: \`f: deferCancel(fn)\`.`,
      );
    }
  }
  if (typeof fn !== "function") {
    throw new TypeError(
      `deferCancel: expected a function, got ${typeof fn}`,
    );
  }
  // Non-enumerable (`defineBrand`): the mark must not show up in value
  // walks of an imports record, and re-marking the same function is a no-op.
  defineBrand(fn as unknown as object, DEFER_CANCEL);
  return fn;
}

/** Brand check (executor-side, read per-declaration at lowering time). */
export function isDeferCancel(value: unknown): boolean {
  return typeof value === "function" && hasBrand(value, DEFER_CANCEL);
}
