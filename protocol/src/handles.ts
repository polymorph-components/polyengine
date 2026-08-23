// The stream/future handle vocabulary (contracts/embedder-api.md §"Streams
// and futures"; amendment A22, §"The host-ABI surface and its version").
//
// A22 moves the paper interfaces of §"Streams and futures" here as
// EXECUTABLE TypeScript: `Stream<T>`, `StreamWriter<T>`, `Future<T>`,
// `ErrorContext`, plus the aux types `Chunk<T>`, `DirectSource`,
// `DirectDestination`, `DirectVerdict`, `StreamSource<T>`, `FutureSource<T>`.
// The runtime's concrete classes (`runtime/src/embedder/streams.ts`)
// `implements` these — conformance is a compile-time assertion — and this
// package's brand predicates (below) recognize the STATEFUL values by brand,
// never by `instanceof` against those concrete classes (A9).
//
// This module stays dependency-free, like the rest of `@polyengine/protocol`
// (§"Module identity"): the interfaces are structural, referencing only
// lib.dom/lib.esnext ambient types (`ReadableStream`, `Uint8Array`,
// `PromiseLike`, `AsyncIterable`, `Iterable`).

import { ERROR_CONTEXT, FUTURE, hasBrand, STREAM, STREAM_WRITER } from "./brands.ts";

/** `Chunk<u8>` is a `Uint8Array`; every other element type chunks as `T[]`. */
export type Chunk<T> = T extends number ? Uint8Array | T[] : T[];

/**
 * The scoped landing zone handed to a `writeDirect` producer (amendment A21,
 * polyengine#128). DEAD once the callback returns; every later method call
 * throws.
 */
export interface DirectDestination {
  /**
   * The reader's still-unfilled bytes. Re-derived on every call (a
   * `memory.grow` between two rendezvous of one session never yields a stale
   * view) and shrinking by whatever has been marked so far in THIS
   * invocation.
   */
  remaining(): Uint8Array;
  /**
   * Acknowledge bytes written into the view. Cumulative within the
   * invocation; acknowledged only if the callback then returns cleanly.
   */
  markWritten(n: number): void;
}

/**
 * The scoped view handed to a `readDirect` consumer (amendment A21,
 * polyengine#128). DEAD once the callback returns; every later method call
 * throws.
 */
export interface DirectSource {
  /**
   * The writer's unread bytes; read-only by contract. Same scoping and
   * re-derivation rules as `DirectDestination.remaining`.
   */
  remaining(): Uint8Array;
  /** Acknowledge bytes consumed from the view. See `markWritten`. */
  markRead(n: number): void;
}

/** The direct-session callback's poll cadence, spelled event-style (A21). */
export type DirectVerdict = "more" | "done";

/**
 * A stream handle (contracts/embedder-api.md §"Streams and futures").
 *
 * `read` returning an empty chunk is end-of-stream; `readable()` and the
 * async iterator are built on it. `readDirect` is the A21 direct-access byte
 * edge, `stream<u8>` only.
 */
export interface Stream<T> {
  /** Web-native view: `ReadableStream<Chunk<T>>`. */
  readable(): ReadableStream<Chunk<T>>;
  [Symbol.asyncIterator](): AsyncIterator<Chunk<T>>;
  /** Low-level read: up to `max` elements; an empty chunk means end-of-stream. */
  read(max: number): Promise<Chunk<T>>;
  /** `stream<u8>` only — amendment A21, polyengine#128. */
  readDirect(consume: (src: DirectSource) => DirectVerdict): Promise<number>;
  /** Cancel an in-flight `read`. */
  cancelRead(): void;
  /** `[Symbol.dispose]` alias. */
  drop(): void;
  [Symbol.dispose](): void;
}

/** Writer half of `Stream.create()` (amendment A22 brand: `streamWriter/1`). */
export interface StreamWriter<T> {
  /** Offer values; resolves with how many the reader took. */
  write(values: Chunk<T>): Promise<number>;
  /** `stream<u8>` only — amendment A21, polyengine#128. */
  writeDirect(
    produce: (dest: DirectDestination) => DirectVerdict,
  ): Promise<number>;
  /** Offer values until all are taken or the reader goes away. */
  writeAll(values: Chunk<T>): Promise<number>;
  cancelWrite(): void;
  /** End-of-stream. */
  close(): Promise<void>;
}

/**
 * A future handle. `await`able directly (`PromiseLike`), and droppable.
 *
 * A future whose write end dropped without ever writing rejects with
 * `DroppedError` — not `undefined`, which `future<void>` legitimately yields.
 */
export interface Future<T> extends PromiseLike<T> {
  drop(): void;
  cancel(): void;
  [Symbol.dispose](): void;
}

/**
 * `error-context` as the contract spells it: message-valued at lowering
 * since amendment A20.
 */
export interface ErrorContext {
  readonly message: string;
}

/** Anything the layer accepts where a guest expects `stream<T>`. */
export type StreamSource<T> =
  | Stream<T>
  | ReadableStream<T[] | Uint8Array | T>
  | AsyncIterable<T[] | Uint8Array | T>
  | Iterable<T>;

/** Anything the layer accepts where a guest expects `future<T>`. */
export type FutureSource<T> = Future<T> | PromiseLike<T> | T;

/** Brand check: an embedder stream handle (A9; any copy, or hand-rolled). */
export function isStream(v: unknown): v is Stream<unknown> {
  return hasBrand(v, STREAM);
}

/**
 * Brand check: an embedder stream writer handle (amendment A22:
 * `polyengine.streamWriter/1`; any copy, or hand-rolled).
 */
export function isStreamWriter(v: unknown): v is StreamWriter<unknown> {
  return hasBrand(v, STREAM_WRITER);
}

/** Brand check: an embedder future handle (A9; any copy, or hand-rolled). */
export function isFuture(v: unknown): v is Future<unknown> {
  return hasBrand(v, FUTURE);
}

/**
 * Brand check: an error-context. Message-valued at lowering since amendment
 * A20 — accepts any branded carrier of a string `message`, not only the
 * canonical class, matching the acceptance rule §"Realm boundaries and
 * structured-clone-safe forms" documents for lowering a foreign one.
 */
export function isErrorContext(v: unknown): v is ErrorContext {
  return hasBrand(v, ERROR_CONTEXT) &&
    typeof (v as { message?: unknown }).message === "string";
}
