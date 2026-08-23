// The per-declaration abort-on-discard mark (contracts/embedder-api.md
// §"Functions and async", amendment A24; polyengine#241).
//
// A23 answered "what does a guest cancellation of an in-flight host import
// DO?" with the reference's prompt-cancel host: the subtask resolves
// CANCELLED_BEFORE_RETURNED and the promise's eventual settlement is
// discarded. That is a statement about DELIVERY only — the host operation
// itself keeps running. A discarded socket connect keeps connecting, a
// discarded timer keeps its callback armed, a discarded fetch keeps streaming
// bytes nobody will ever read.
//
// A24 is the third mark in the family (`suspending()` A1, `deferCancel()`
// A23), and it closes exactly that gap by handing the host the platform's own
// cancellation vocabulary. Every call of a marked import receives a fresh
// `AbortSignal` appended AFTER the WIT-declared parameters:
//
//     dial: abortable((addr, signal) => fetch(url, { signal }))
//
// and the runtime aborts that signal when — and only when — the call's subtask
// is discarded by a guest cancellation.
//
// Two properties are worth stating separately because they are easy to
// conflate:
//
//   * the mark controls the SIGNATURE unconditionally. A marked function
//     always receives a signal, on every call, including calls that can never
//     be discarded. Arity is a property of the declaration, not of the run.
//   * the ABORT is discard-only. The signal fires for a guest-initiated
//     cancellation that took the A23 discard, and for nothing else. Instance
//     teardown does not abort in-flight calls (future amendment material).
//
// Ordering: the abort is scheduled on a microtask AFTER the cancel built-in
// returns, never synchronously inside it — host abort listeners must not run
// inside a live guest activation. So the guest observes
// CANCELLED_BEFORE_RETURNED first, and the host observes the abort a tick
// later. Any settlement the abort provokes (an `AbortError` rejection, a
// partial value) lands on A23's resolved-subtask guards and is discarded like
// any other late settlement — it is not a host failure.
//
// INERT wherever a discard cannot happen, and this is vacuous truth rather
// than a wart: a sync-typed import's A1 park never mints a subtask handle, so
// `subtask.cancel` cannot name it; a `deferCancel()`-marked import's
// cancellation is accepted and ignored, so it never discards; a call that
// resolves eagerly is over before a handle exists. In all three the signal is
// minted and simply never fires. Mark GENUINELY-ASYNC operations — the ones
// with something to stop.
//
// Independent of the other two brands: different questions (calling
// convention / what a cancellation answers / whether the host is told), and
// all three may sit on one function. Like A23 and unlike A1 this brand is not
// mode evidence, so there is no `anyAbortableImport` analogue — it is read
// per-declaration at lowering time (exec/executor.ts `buildLoweredImport`).
//
// Layering: dependency-free apart from ./brands.ts (the protocol package as a
// whole imports nothing).

import { ABORTABLE, defineBrand, hasBrand } from "./brands.ts";

/**
 * Declare that this host import takes a per-call `AbortSignal`, appended after
 * its WIT-declared parameters, which the runtime aborts when a guest
 * cancellation discards the call.
 *
 * Use it for genuinely-async operations that CAN be stopped — a fetch, a dial,
 * a timer, a long poll — so that a guest's cancellation stops the work instead
 * of merely stopping its delivery (A23 discards the result; the operation runs
 * on).
 *
 * The mark controls the SIGNATURE unconditionally: a marked function receives
 * a signal on every call, so its arity is stable even on paths where the
 * signal can never fire. The ABORT is discard-only, and deferred one microtask
 * past the guest's cancel built-in, so a host listener never runs inside a
 * live guest activation. Whatever the abort provokes — typically an
 * `AbortError` rejection — is discarded as a late settlement, not reported as
 * a host failure.
 *
 * Two forms, one brand (`polyengine.abortable/1`), exactly as `suspending()`
 * and `deferCancel()`:
 *
 *   * **direct call** — `dial: abortable((addr, signal) => …)` — the canonical
 *     form, and the only one available inside record literals;
 *   * **stage-3 method decorator** — `@abortable dial(addr, signal) { … }` on
 *     a provider class or a host-implemented resource class (methods and
 *     statics).
 *
 * The decorator form REFUSES anything it cannot mark, loudly: decorating a
 * class, getter, setter, accessor or field throws at class-definition time (a
 * silent no-op would surface as a `signal` parameter that is forever
 * `undefined`, arbitrarily far from the mistake), and the TypeScript-legacy
 * `experimentalDecorators` calling convention throws with a pointer here —
 * under that convention the decorator receives the PROTOTYPE, not the method,
 * and marking it would both brand the wrong object and corrupt the property
 * descriptor. Constructors are never markable (synchronous by the C2
 * amendment; the language reserves no constructor-decorator position anyway).
 *
 * Tolerated and inert on sync-typed imports, on `deferCancel()` imports, and
 * on calls that resolve eagerly — the signal is minted and never fires.
 * Independent of the other marks; all three may ride one function.
 *
 * The value is marked in place (functions are objects); the return is the same
 * function, typed for insertion into an imports record or for method
 * replacement. The signal parameter is deliberately NOT reflected in this
 * type: the conventions facade is untyped at runtime, and bindgen owns the
 * compile-time shape of a marked import.
 */
export function abortable<F extends CallableFunction>(
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
      "abortable: legacy (experimentalDecorators) method decoration is not " +
        "supported — the decorator would receive the prototype, not the " +
        "method. Compile with stage-3 decorators (the default), or use the " +
        "call form: `f: abortable(fn)`.",
    );
  }
  if (context !== undefined) {
    const kind = (context as { kind?: unknown }).kind;
    if (kind !== "method") {
      throw new TypeError(
        `abortable: cannot decorate a ${String(kind)} — only methods ` +
          `(instance or static) can be marked abortable. Constructors are ` +
          `synchronous by contract; for record-literal imports use the call ` +
          `form: \`f: abortable(fn)\`.`,
      );
    }
  }
  if (typeof fn !== "function") {
    throw new TypeError(
      `abortable: expected a function, got ${typeof fn}`,
    );
  }
  // Non-enumerable (A9 `defineBrand`): the mark must not show up in value
  // walks of an imports record, and re-marking the same function is a no-op.
  defineBrand(fn as unknown as object, ABORTABLE);
  return fn;
}

/** Brand check (executor-side, read per-declaration at lowering time). */
export function isAbortable(value: unknown): boolean {
  return typeof value === "function" && hasBrand(value, ABORTABLE);
}
