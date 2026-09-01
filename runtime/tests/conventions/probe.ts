// The PROBE HOST MODULE — written exactly the way a consumer writes one
// (contracts/embedder-api.md §"The host-ABI surface and its version", host-ABI version:
// "Host modules MUST NOT import `@polyengine/runtime`").
//
// Everything below reaches the engine through the boundary only. The single
// import is `@polyengine/protocol`, for VOCABULARY: the recognition predicates,
// `suspending()`, `ComponentException`. No runtime import, no class-identity
// check, no `instanceof` against an engine class — recognition is by brand
// everywhere.
//
// `probe_zero_import.ts` is the same story with the import removed entirely:
// hand-rolled `Symbol.for` brands, which module identity declares legal values ("a
// hand-rolled object carrying the right brand IS a ComponentException to every
// copy"). If that file ever grows an import, the property it demonstrates is
// gone.

import {
  ComponentException,
  type ErrorContext,
  type Future,
  isComponentException,
  isDroppedError,
  isErrorContext,
  isFuture,
  isInvalidHandleError,
  isPeerTrappedError,
  isStream,
  isStreamProducerError,
  isStreamWriter,
  isTrap,
  type Stream,
  suspending,
} from "@polyengine/protocol";

export { ComponentException, isErrorContext, isFuture, isStream, suspending };
export type { ErrorContext, Future, Stream };

/**
 * What the protocol vocabulary says a value IS. Ordered most-specific first;
 * the answer is a brand verdict, never a constructor name.
 */
export function classify(v: unknown): string {
  if (isStream(v)) return "stream";
  if (isStreamWriter(v)) return "streamWriter";
  if (isFuture(v)) return "future";
  if (isErrorContext(v)) return "errorContext";
  if (isComponentException(v)) return "componentException";
  if (isPeerTrappedError(v)) return "peerTrapped";
  if (isDroppedError(v)) return "dropped";
  if (isInvalidHandleError(v)) return "invalidHandle";
  if (isStreamProducerError(v)) return "streamProducer";
  if (isTrap(v)) return "trap";
  if (v instanceof Error) return "unbranded-error";
  if (typeof v === "object" && v !== null && "then" in v) return "thenable";
  return typeof v;
}

/**
 * `PromiseLike` but deliberately NOT a Promise and NOT a `Future` handle — the
 * "plain thenable" lowering source of §"Streams and futures".
 */
export function thenable<T>(value: T): PromiseLike<T> {
  return {
    then<R>(onOk?: ((v: T) => R | PromiseLike<R>) | null): PromiseLike<R> {
      return Promise.resolve().then(() => onOk!(value));
    },
  };
}

/** An `AsyncIterable` lowering source. */
export async function* asyncIterable<T>(
  values: readonly T[],
): AsyncIterableIterator<T> {
  for (const v of values) yield v;
}

/** A `ReadableStream` lowering source. */
export function readable<T>(values: readonly T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(c) {
      for (const v of values) c.enqueue(v);
      c.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Host-implemented resources (§"Resources": "a plain class implementing the
// bindgen-emitted interface", the runtime owns the instance<->rep mapping)
// ---------------------------------------------------------------------------

/** `host:api/res`'s `R`: the plainest host resource there is. */
export class Cell {
  static disposed: number[] = [];
  static made: number[] = [];
  constructor(readonly v: number) {
    Cell.made.push(v);
  }
  [Symbol.dispose]() {
    Cell.disposed.push(this.v);
  }
  static reset() {
    Cell.disposed = [];
    Cell.made = [];
  }
}

/**
 * `host:api/dev`'s `gauge`: constructor + method + static, the full member
 * surface. `calibrate` is a real `static`, so it exercises the static arm of
 * the mangled-name assembly (`[static]gauge.calibrate`).
 */
export class Gauge {
  static calibrations = 0;
  static disposed: number[] = [];
  constructor(readonly v: number) {}
  read(): number {
    // `this` is the instance — no reps, no side tables (§"Resources").
    return this.v;
  }
  static calibrate(): number {
    return ++Gauge.calibrations;
  }
  [Symbol.dispose]() {
    Gauge.disposed.push(this.v);
  }
  static reset() {
    Gauge.calibrations = 0;
    Gauge.disposed = [];
  }
}

/**
 * The suspending mark on a class PROTOTYPE method: the prototype is the
 * per-declaration brand authority, read at wrap time, so every instance
 * dispatched through it parks.
 */
export class SuspendingGauge {
  static disposed: number[] = [];
  constructor(readonly v: number) {}
  read(): Promise<number> {
    return Promise.resolve(this.v);
  }
  static calibrate(): number {
    return 7;
  }
  [Symbol.dispose]() {
    SuspendingGauge.disposed.push(this.v);
  }
  static reset() {
    SuspendingGauge.disposed = [];
  }
}
// The direct-call spelling (`suspending(fn)`) applied to the prototype slot —
// the canonical form, and the only one available without decorators.
SuspendingGauge.prototype.read = suspending(
  SuspendingGauge.prototype.read,
) as typeof SuspendingGauge.prototype.read;

/**
 * An interface provider that is a CLASS INSTANCE (suspending mark: "interface members are
 * invoked with their containing object as receiver"). `add` reads instance
 * state, so a wrong receiver is a wrong answer rather than a silent pass.
 */
export class MathProvider {
  constructor(readonly bias: number) {}
  add(a: number, b: number): number {
    return a + b + this.bias;
  }
  greet(who: string): string {
    return `hello ${who}`;
  }
}
