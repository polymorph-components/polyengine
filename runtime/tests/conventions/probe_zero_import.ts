// The ZERO-IMPORT probe host module (contracts/embedder-api.md §"Module
// identity and @polyengine/protocol": "Brands are contract
// markers, not a security boundary. A hand-rolled object carrying the right
// brand is a legal value … This is what makes zero-import host modules
// possible").
//
// This file MUST NOT import anything. Its whole content is the demonstration:
// the brand keys are `Symbol.for` registry symbols, so a host module that
// spells them out by hand agrees with every copy of the engine and of
// `@polyengine/protocol` without sharing a module with either.
//
// The keys are the spellings from the brand table in §"Module
// identity"; the generation suffix `/1` is part of the key.

/** `polyengine.componentException/1` — carried by err-result values. */
export const COMPONENT_EXCEPTION_KEY = "polyengine.componentException/1";
/** `polyengine.suspending/1` — carried by the marked function (suspending mark). */
export const SUSPENDING_KEY = "polyengine.suspending/1";
/** `polyengine.errorContext/1` — message-valued at lowering (§"Realm boundaries and structured-clone-safe forms"). */
export const ERROR_CONTEXT_KEY = "polyengine.errorContext/1";

/**
 * An err value with no protocol import anywhere in its provenance. `payload`
 * is the WIT err value; `message` is diagnostic.
 */
export function handRolledException(payload: unknown, message: string): Error {
  const e = new Error(message) as Error & { payload: unknown };
  (e as unknown as Record<symbol, unknown>)[
    Symbol.for(COMPONENT_EXCEPTION_KEY)
  ] = true;
  e.payload = payload;
  return e;
}

/** A suspending-marked function with no protocol import. */
export function handRolledSuspending<F extends (...a: never[]) => unknown>(
  fn: F,
): F {
  (fn as unknown as Record<symbol, unknown>)[Symbol.for(SUSPENDING_KEY)] = true;
  return fn;
}

/**
 * A branded string-`message` carrier: what realm boundary makes lowerable where the guest
 * expects an `error-context`, by minting a FRESH local context — never "the
 * same" one, since an error-context's state is exactly its message.
 */
export function handRolledErrorContext(message: string): { message: string } {
  const c = { message };
  (c as unknown as Record<symbol, unknown>)[Symbol.for(ERROR_CONTEXT_KEY)] =
    true;
  return c;
}
