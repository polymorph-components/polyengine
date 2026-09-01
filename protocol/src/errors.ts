// The embedder-facing error model (contracts/embedder-api.md §"Error model").
//
// These classes used to live in
// `runtime/src/embedder/errors.ts` and `runtime/src/cabi/trap.ts`, which now
// re-export them. Every class carries a process-global brand on its
// prototype, and the runtime recognizes values by BRAND, not by class
// identity — a multi-copy graph (issue #83) otherwise fails `instanceof`
// latently, on the first error path only.
//
// Three classes, three meanings, no overlap:
//
//   * `ComponentException` — a WIT `result<T, E>` err **value**. The only thing that
//     crosses the boundary as an err. Branding is the point: under jco any
//     stray `TypeError` from a host import was fed to the lift, so every
//     consumer wrapped every platform call defensively (webcrypto.js's
//     `platformCall`). Here an unbranded throw is a host bug and becomes a
//     trap, so the defensive wrapper is unnecessary by construction.
//   * `Trap`   — component-fatal, never a value.
//   * `DroppedError` — awaiting a future whose write end dropped without a
//     value (R-fix review note 4). Its uncomely sibling `PeerTrappedError`
//     (below) is a drop that happened because the peer's instance trapped —
//     branded separately so a fault is never mistaken for a clean end.
//
// The predicates below are brand-based and NOT `instanceof`. They are also
// deliberately NOT installed as `Symbol.hasInstance` on the classes: a
// consumer subclass would inherit that `hasInstance` and then match ANY
// branded value (`x instanceof MyComponentException` true for a plain `ComponentException`),
// which is a worse footgun than brand-based recognition would create.

import {
  defineBrand,
  DROPPED,
  hasBrand,
  INVALID_HANDLE,
  PEER_TRAPPED,
  STREAM_PRODUCER,
  TRAP,
  COMPONENT_EXCEPTION,
} from "./brands.ts";

/** A WIT `result<T, E>` err value, branded. `payload` is shaped per the value table. */
export class ComponentException<E = unknown> extends Error {
  readonly payload: E;

  constructor(payload: E, message?: string) {
    super(message ?? `component error: ${describePayload(payload)}`);
    this.name = "ComponentException";
    this.payload = payload;
  }
}
defineBrand(ComponentException.prototype, COMPONENT_EXCEPTION);

/**
 * A Component Model trap — a deterministic guest-visible fault
 * (definitions.py `Trap`). Never a value: it is component-fatal.
 */
export class Trap extends Error {
  constructor(message = "canonical ABI trap") {
    super(message);
    this.name = "Trap";
  }
}
defineBrand(Trap.prototype, TRAP);

/**
 * Awaiting a `Future<T>` whose write end dropped without ever writing.
 *
 * Discriminated on purpose: "no value, ever" is a different outcome from
 * "the value was `undefined`" (`future<void>`), and a consumer that must tell
 * them apart should not have to guess from a sentinel.
 */
export class DroppedError extends Error {
  constructor(message = "the write end was dropped without a value") {
    super(message);
    this.name = "DroppedError";
  }
}
defineBrand(DroppedError.prototype, DROPPED);

/** Use of a resource wrapper whose handle was transferred away or dropped. */
export class InvalidHandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHandleError";
  }
}
defineBrand(InvalidHandleError.prototype, INVALID_HANDLE);

/**
 * A stream/future operation whose peer end died in a trap-poisoned component
 * instance (#66; contracts/embedder-api.md §"Streams and futures").
 *
 * Discriminated from `DroppedError` on purpose: a clean drop is a normal
 * outcome (end-of-stream, "no value"), while a poisoned peer means the
 * component faulted — resolving the operation as if the stream simply ended
 * would be wrong data reported as success, the same shape
 * `StreamProducerError` exists to prevent in the other direction. `cause` is
 * the recorded poisoning failure (its own `cause` is the underlying `Trap`);
 * `progress` is how many elements a write had delivered before the peer died.
 */
export class PeerTrappedError extends Error {
  override readonly cause: unknown;
  readonly progress?: number;

  constructor(where: string, cause: unknown, progress?: number) {
    super(
      `${where}: the peer component instance trapped, so this ` +
        `stream/future operation can never complete — ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "PeerTrappedError";
    this.cause = cause;
    if (progress !== undefined) this.progress = progress;
  }
}
defineBrand(PeerTrappedError.prototype, PEER_TRAPPED);

/**
 * A producer feeding a lowered `stream<T>` failed — the element did not lower,
 * or the producer itself threw.
 *
 * This is a *host bug at a named site*, exactly like an unbranded throw from a
 * host import, and it is surfaced the same way: never as a silent truncation
 * of the guest's stream, never as a floating rejection.
 */
export class StreamProducerError extends Error {
  override readonly cause: unknown;

  constructor(where: string, cause: unknown) {
    super(
      `${where}: the stream producer failed — ` +
        `${describeCause(cause)}. The guest's stream is NOT closed cleanly: ` +
        `the in-flight call fails instead, because a short stream presented ` +
        `as end-of-stream would be wrong data reported as success.`,
    );
    this.name = "StreamProducerError";
    this.cause = cause;
  }
}
defineBrand(StreamProducerError.prototype, STREAM_PRODUCER);

/** Brand check: is this a WIT `result` err value? (any copy, or hand-rolled.) */
export function isComponentException(v: unknown): v is ComponentException {
  return hasBrand(v, COMPONENT_EXCEPTION);
}

/** Brand check: is this a component-fatal trap? */
export function isTrap(v: unknown): v is Trap {
  return hasBrand(v, TRAP);
}

/** Brand check: a dropped-future rejection? */
export function isDroppedError(v: unknown): v is DroppedError {
  return hasBrand(v, DROPPED);
}

/** Brand check: a peer-fault rejection (§"Streams and futures")? */
export function isPeerTrappedError(v: unknown): v is PeerTrappedError {
  return hasBrand(v, PEER_TRAPPED);
}

/** Brand check: resource-wrapper misuse? */
export function isInvalidHandleError(v: unknown): v is InvalidHandleError {
  return hasBrand(v, INVALID_HANDLE);
}

/** Brand check: a producer-side stream failure? */
export function isStreamProducerError(v: unknown): v is StreamProducerError {
  return hasBrand(v, STREAM_PRODUCER);
}

function describePayload(p: unknown): string {
  if (p === null || p === undefined) return String(p);
  if (typeof p === "object" && "kind" in (p as Record<string, unknown>)) {
    return String((p as { kind: unknown }).kind);
  }
  if (typeof p === "object") return JSON.stringify(p);
  return String(p);
}

function describeCause(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
