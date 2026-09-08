// Stream / future conventions (contracts/embedder-api.md §"Streams and
// futures").
//
// The low-level seam is `exec/host_streams.ts` — `HostStream`/`HostFuture`
// over the shared rendezvous object. This file is the *handle* layer named by
// the contract: `SharedStreamImpl` identity stays internal, embedders see
// `Stream<T>` / `Future<T>` / `ErrorContext`, and lowering accepts the natural
// JS producers (`ReadableStream`, `AsyncIterable`, arrays, `Promise`) with the
// layer owning the pumping.

import type { ValType } from "../cabi/types.ts";
import { despecialize } from "../cabi/types.ts";
import type { ComponentValue } from "../cabi/types.ts";
import {
  type DirectSessionInfo,
  type HostFuture,
  hostFuture,
  hostFutureFor,
  type HostStream,
  hostStream,
  hostStreamFor,
} from "../exec/host_streams.ts";
import {
  CopyResult,
  dropSharedForTeardown,
  ErrorContext as InternalErrorContext,
  poisonFailureOf,
} from "../task/mod.ts";
import {
  type Chunk,
  defineBrand,
  defineRealmLocal,
  type DirectDestination,
  type DirectSource,
  type DirectVerdict,
  ERROR_CONTEXT,
  type ErrorContext as ProtocolErrorContext,
  FUTURE,
  type Future as ProtocolFuture,
  hasBrand,
  isStreamProducerError,
  STREAM,
  type Stream as ProtocolStream,
  STREAM_WRITER,
  StreamProducerError,
  type StreamWriter as ProtocolStreamWriter,
} from "@polyengine/protocol";
import { describeCrossCopy } from "./copy.ts";
import { DroppedError, PeerTrappedError } from "./errors.ts";

export type { Chunk } from "@polyengine/protocol";

/**
 * Per-element adaptation, supplied by the value adapter.
 * @internal — supplied by the value adapter, never by a host.
 */
export interface ElemCodec<T> {
  readonly element: ValType | null;
  /** internal component value -> conventions value */
  toHost(v: ComponentValue): T;
  /** conventions value -> internal component value */
  fromHost(v: T): ComponentValue;
  /**
   * Destroy a LOWERED element the reader will never take (§"Streams and futures");
   * present only for element types that hold resources (`own<R>`), where
   * abandonment without destruction is a leak.
   */
  readonly release?: (lowered: ComponentValue) => void;
  /** Optional site name (`import 'x'.f`, `export 'i#f'`) for diagnostics. */
  readonly where?: string;
}

export { StreamProducerError } from "@polyengine/protocol";

/**
 * Producer failures retained per shared object for subsequent handle checks,
 * independently of whether a store also received the failure.
 */
const producerFailures = new WeakMap<object, StreamProducerError>();

/**
 * Record on the handle and, if bound, the store's first-failure slot. Return
 * whether a store exists. Report before dropping the writer: driveAsync
 * checks hostFailure before completion, so truncation cannot hide the cause.
 * The slot is store-wide, not an attribution to a particular consuming call.
 */
function reportProducerFailure(
  host: HostStream<unknown>,
  where: string,
  cause: unknown,
): boolean {
  // Brand, not class: a producer failure raised by another runtime copy
  // must not be re-wrapped into a second layer of the same error.
  const err = isStreamProducerError(cause)
    ? cause
    : new StreamProducerError(where, cause);
  const shared = host.value as unknown as {
    boundStore?: { hostFailure?: unknown } | null;
  };
  producerFailures.set(host.value as object, err);
  const store = shared.boundStore;
  if (store != null && typeof store === "object") {
    if (store.hostFailure === undefined) store.hostFailure = err;
    return true;
  }
  return false;
}

/** @internal — raise a recorded producer failure, if any. */
function throwIfFailed(value: unknown, where = "stream"): void {
  const e = producerFailures.get(value as object);
  if (e !== undefined) throw e;
  throwIfPeerTrapped(value, where);
}

/**
 * @internal — raise the recorded poisoning failure, if any (#66,
 * contracts/embedder-api.md §"Streams and futures"). Pre-op: an operation started after the peer's instance trapped must
 * reject rather than park forever. Post-await (with the op's outcome in
 * hand): an operation the retirement walk settled DROPPED-shaped must reject
 * rather than fake a clean end — but an op that genuinely COMPLETED before
 * the trap keeps its result (the fault still surfaces on the export call,
 * and on this handle's next operation).
 */
function throwIfPeerTrapped(
  value: unknown,
  where: string,
  progress?: number,
): void {
  const p = poisonFailureOf(value);
  if (p !== undefined) throw new PeerTrappedError(where, p, progress);
}

/** True for `stream<u8>` / `future<u8>`, whose chunks are `Uint8Array`. */
export function isU8Element(element: ValType | null): boolean {
  return element !== null && despecialize(element).kind === "u8";
}

// Protocol callback shapes also match the low-level exec seam structurally.
export type {
  DirectDestination,
  DirectSource,
  DirectVerdict,
} from "@polyengine/protocol";

/**
 * direct-access byte edge (#128): the direct-access byte edges are `stream<u8>` only. A
 * zero-width element type (`t === null`) is not u8 either.
 */
function requireU8Direct<T>(codec: ElemCodec<T> | null, who: string): void {
  if (codec === null || !isU8Element(codec.element)) {
    throw new TypeError(
      `${who} is available on stream<u8> only (embedder-api.md §"Streams and futures" ("Direct-access byte edges"), ` +
        `polyengine#128); use write()/read() for other element types`,
    );
  }
}

/**
 * A stream handle.
 *
 * `read` returning an empty chunk is end-of-stream, exactly as the contract
 * spells it; `readable()` and the async iterator are built on it.
 */
export class Stream<T> implements ProtocolStream<T> {
  #host: HostStream<T> | null;
  #codec: ElemCodec<T> | null;
  /** Set once the handle's shared object has been handed to a guest. */
  #consumed = false;
  #dropped = false;
  /** Waiters parked in `Stream.create()` until an element type is known. */
  #binders: (() => void)[] = [];

  private constructor(host: HostStream<T> | null, codec: ElemCodec<T> | null) {
    this.#host = host;
    this.#codec = codec;
    // Raw structured cloning must fail rather than lose private handle state.
    defineRealmLocal(this);
  }

  /** Wrap a stream value that was lifted out of a guest. */
  static fromLifted<T>(value: ComponentValue, codec: ElemCodec<T>): Stream<T> {
    return new Stream<T>(hostStreamFor<T>(value), codec);
  }

  /** Wrap a freshly created host-owned stream of a known element type. */
  static fromHostStream<T>(
    host: HostStream<T>,
    codec: ElemCodec<T>,
  ): Stream<T> {
    return new Stream<T>(host, codec);
  }

  /**
   * Create a stream/writer pair. The lowering site supplies its runtime
   * element type when the stream is passed to a guest. Writer operations
   * issued earlier wait for that binding, indefinitely if it never happens.
   */
  static create<T>(): { stream: Stream<T>; writer: StreamWriter<T> } {
    const stream = new Stream<T>(null, null);
    return { stream, writer: new StreamWriter<T>(stream) };
  }

  /** @internal — bind a lazily created stream to the lowering site's type. */
  bindElement(codec: ElemCodec<T>): void {
    if (this.#host !== null) return;
    this.#codec = codec;
    this.#host = hostStream<T>(codec.element);
    publishHostStream(this, this.#host);
    const waiters = this.#binders;
    this.#binders = [];
    for (const w of waiters) w();
  }

  /** @internal — resolve once this handle has a shared object. */
  whenBound(): Promise<void> {
    if (this.#host !== null) return Promise.resolve();
    return new Promise<void>((r) => this.#binders.push(r));
  }

  /** @internal */
  get bound(): boolean {
    return this.#host !== null;
  }

  /** @internal — the shared value to hand to a lowering site. */
  takeValue(codec: ElemCodec<T>): ComponentValue {
    this.bindElement(codec);
    if (this.#consumed) {
      throw new TypeError(
        "this Stream handle has already been passed to a guest; a stream " +
          "value may only be transferred once",
      );
    }
    this.#consumed = true;
    return this.#host!.value;
  }

  /** @internal */
  get codec(): ElemCodec<T> | null {
    return this.#codec;
  }

  #require(): HostStream<T> {
    if (this.#host === null) {
      throw new TypeError(
        "this Stream was created with Stream.create() and has not been " +
          "passed to a guest yet, so it has no element type; pass it first, " +
          "or use the writer, which parks until then",
      );
    }
    // Transfer relinquishes this handle's readable end, not StreamWriter's
    // writable end. drop/cancelRead remain available for cleanup.
    if (this.#consumed) {
      throw new TypeError(
        "this Stream handle has already been passed to a guest; the guest " +
          "owns its readable end, so it can no longer be read from the host " +
          "(issue #162)",
      );
    }
    return this.#host;
  }

  /** Low-level read: up to `max` elements; an empty chunk means end-of-stream. */
  async read(max: number): Promise<Chunk<T>> {
    const host = this.#require();
    const where = this.#codec?.where ?? "stream read";
    throwIfFailed(host.value, where);
    const raw = await host.readable.read(max) as unknown as
      | ComponentValue[]
      | Uint8Array;
    // An empty chunk normally means clean end-of-stream; when the peer's
    // instance trapped it means the retirement walk settled us — reject
    // instead of faking EOS (§"Streams and futures"). A non-empty chunk was really
    // copied before the trap and is delivered; the next read rejects.
    if (raw.length === 0) throwIfPeerTrapped(host.value, where);
    return this.#chunk(raw);
  }

  /**
   * Consume the writer's bytes in place, without an intermediate chunk
   * (`stream<u8>` only — contracts/embedder-api.md §"Streams and futures" ("Direct-access byte edges"),
   * polyengine#128).
   *
   * At every rendezvous with a writer of nonzero capacity, `consume` runs
   * exactly once, synchronously, with a `DirectSource` over the writer's
   * unread bytes — guest linear memory when the peer is a guest, so the
   * consumer's own `set()`/`subarray` copy IS the canonical-ABI copy.
   * `"more"` keeps the session parked for the next rendezvous; `"done"` ends
   * it. Resolves with the session's total byte count. Marking a prefix is
   * normal: the writer re-offers the rest on its own schedule.
   *
   * `"done"` with zero bytes marked *retracts*: the session ends and the
   * writer's operation stays parked, with no event delivered. `"more"` with
   * zero marked, and a throwing callback, reject — and in both cases the
   * writer's parked operation survives and the stream stays alive.
   *
   * Refusals mirror `read`: an unbound `Stream.create()` handle and a handle
   * already passed to a guest both throw, as does a
   * non-`u8` element type.
   */
  async readDirect(
    consume: (src: DirectSource) => DirectVerdict,
  ): Promise<number> {
    const host = this.#require();
    const where = this.#codec?.where ?? "stream read";
    throwIfFailed(host.value, where);
    requireU8Direct(this.#codec, "readDirect");
    const info: DirectSessionInfo = { endedByVerdict: false };
    const n = await host.readable.readDirect(consume, info);
    // Preserve a callback-completed result. Otherwise report peer poisoning
    // with the acknowledged byte count, not a clean session end.
    if (!info.endedByVerdict) throwIfPeerTrapped(host.value, where, n);
    return n;
  }

  #chunk(raw: ComponentValue[] | Uint8Array): Chunk<T> {
    const codec = this.#codec!;
    if (isU8Element(codec.element)) {
      // The exec layer already resolves u8 reads as a Uint8Array (the
      // rendezvous copy itself — issue #54); pass it through untouched so a
      // host read costs exactly that one copy. Uint8Array.from covers
      // raw-layer writers that fed plain arrays.
      return (raw instanceof Uint8Array
        ? raw
        : Uint8Array.from(raw as number[])) as Chunk<T>;
    }
    const vs = raw instanceof Uint8Array ? Array.from(raw) : raw;
    return vs.map((v) => codec.toHost(v as ComponentValue)) as Chunk<T>;
  }

  /**
   * Cancel an in-flight read, resolving with progress so far. An empty
   * cancelled chunk is indistinguishable from EOS, so readable() and the
   * async iterator close on it. A direct session resolves its byte count.
   */
  cancelRead(): void {
    this.#host?.readable.cancelRead();
  }

  drop(): void {
    if (this.#dropped) return;
    this.#dropped = true;
    // Both ends of a host wrapper name the same shared object; dropping once
    // is enough (`SharedStreamImpl.drop` is idempotent).
    this.#host?.readable.drop();
  }

  /**
   * @internal — teardown of an abandoned import argument. Silently retract
   * parked ends already marked poisoned/retired; notify healthy peers.
   * Shared drop observers close host activity even with nothing parked.
   */
  dropForTeardown(): void {
    if (this.#dropped) return;
    this.#dropped = true;
    if (this.#host !== null) {
      dropSharedForTeardown(this.#host.value as never);
    }
  }

  [Symbol.dispose](): void {
    this.drop();
  }

  /** Web-native view: `ReadableStream<Chunk<T>>`. */
  readable(): ReadableStream<Chunk<T>> {
    const self = this;
    return new ReadableStream<Chunk<T>>({
      async pull(controller) {
        const chunk = await self.read(READ_CHUNK);
        if ((chunk as { length: number }).length === 0) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        self.drop();
      },
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Chunk<T>> {
    for (;;) {
      const chunk = await this.read(READ_CHUNK);
      if ((chunk as { length: number }).length === 0) return;
      yield chunk;
    }
  }
}

/** How many elements a convenience read asks for at a time. */
const READ_CHUNK = 4096;

/** Writer half of `Stream.create()`. */
export class StreamWriter<T> implements ProtocolStreamWriter<T> {
  #stream: Stream<T>;

  constructor(stream: Stream<T>) {
    this.#stream = stream;
    // realm boundary realm-local pill (see Stream's constructor above for rationale).
    defineRealmLocal(this);
  }

  /**
   * Offer values; resolves with how many the reader took.
   *
   * `Chunk<T>` mirrors the read side: a u8 stream accepts a `Uint8Array`
   * (taken as already-lowered bytes), and a plain array of any element type
   * is lowered per element. u8 chunks travel as `Uint8Array` all the way to
   * the CABI store's bulk path (issue #54) — which makes a `Uint8Array`
   * chunk a borrow until the returned promise settles; mutating it in that
   * window is misuse. Plain-array chunks are lowered (copied) up front.
   */
  write(values: Chunk<T>): Promise<number> {
    return this.#write(values, false);
  }

  async #write(values: Chunk<T>, all: boolean): Promise<number> {
    await this.#stream.whenBound();
    const host = hostOf(this.#stream);
    const where = this.#stream.codec?.where ?? "stream write";
    throwIfFailed(host.value, where);
    const codec = this.#stream.codec!;
    const lowered = packChunk(values, codec);
    const info = codec.release === undefined ? undefined : { progress: 0 };
    let n: number;
    try {
      n = await host.writable[all ? "writeAll" : "write"](
        lowered as unknown as T[],
        info,
      );
      // Full takes completed before a later peer fault and keep their result.
      if (n < values.length) throwIfPeerTrapped(host.value, where, n);
    } catch (e) {
      try {
        releaseUntaken(lowered, info?.progress ?? 0, codec);
      } catch {
        // Cleanup attempted every tail element; preserve the write failure.
      }
      throw e;
    }
    releaseUntaken(lowered, n, codec);
    return n;
  }

  /**
   * Fill the reader's landing zone in place, without an intermediate chunk
   * (`stream<u8>` only — contracts/embedder-api.md §"Streams and futures" ("Direct-access byte edges"),
   * polyengine#128).
   *
   * At every rendezvous with a reader of nonzero capacity, `produce` runs
   * exactly once, synchronously, with a `DirectDestination` over the reader's
   * unfilled landing zone — guest linear memory when the peer is a guest, so
   * the producer's own `set()` IS the canonical-ABI copy and an external byte
   * mover (a websocket frame, a SAB ring segment, a transferred
   * `ArrayBuffer`) never pays a second copy inside the runtime. `"more"`
   * keeps the session parked for the next rendezvous; `"done"` ends it.
   * Resolves with the session's total byte count.
   *
   * `"done"` with zero bytes marked *retracts* (the session ends, the
   * reader's operation stays parked, no event); `"more"` with zero marked,
   * and a throwing callback, reject. Marks commit only on clean return;
   * writes already made through the view are not rolled back on failure.
   *
   * Parks until the element type is known, exactly as `write` does — a
   * `Stream.create()` writer has no element type until the lowering site
   * binds one — and then requires `u8`.
   */
  async writeDirect(
    produce: (dest: DirectDestination) => DirectVerdict,
  ): Promise<number> {
    await this.#stream.whenBound();
    const host = hostOf(this.#stream);
    const where = this.#stream.codec?.where ?? "stream write";
    throwIfFailed(host.value, where);
    requireU8Direct(this.#stream.codec, "writeDirect");
    const info: DirectSessionInfo = { endedByVerdict: false };
    const n = await host.writable.writeDirect(produce, info);
    // Callback completion survives a later peer trap; other endings report
    // poisoning with the acknowledged byte count.
    if (!info.endedByVerdict) throwIfPeerTrapped(host.value, where, n);
    return n;
  }

  /** Offer values until all are taken or the reader goes away. */
  writeAll(values: Chunk<T>): Promise<number> {
    return this.#write(values, true);
  }

  cancelWrite(): void {
    if (!this.#stream.bound) return;
    hostOf(this.#stream).writable.cancelWrite();
  }

  /** End-of-stream. */
  async close(): Promise<void> {
    await this.#stream.whenBound();
    hostOf(this.#stream).writable.drop();
  }
}

const hostOfStream = new WeakMap<Stream<unknown>, HostStream<unknown>>();

function hostOf<T>(s: Stream<T>): HostStream<T> {
  // The host end lives behind `Stream`'s private field; `takeValue`/`read`
  // are the public routes. The writer needs the writable half, so the handle
  // publishes it here at bind time.
  const h = hostOfStream.get(s as Stream<unknown>);
  if (h === undefined) {
    throw new TypeError("stream writer used before the stream was bound");
  }
  return h as HostStream<T>;
}

/** @internal — publish the host end for `StreamWriter` (see `hostOf`). */
export function publishHostStream<T>(s: Stream<T>, h: HostStream<T>): void {
  hostOfStream.set(s as Stream<unknown>, h as HostStream<unknown>);
}

/**
 * A future handle. `await`able directly (`PromiseLike`), and droppable.
 *
 * A future whose write end dropped without ever writing rejects with
 * `DroppedError` — not `undefined`, which `future<void>` legitimately yields.
 */
export class Future<T> implements ProtocolFuture<T> {
  /** Present once the underlying host end exists. */
  #host: HostFuture<T> | null;
  /** Always present; resolves to the host end (immediately, when not deferred). */
  #hostP: Promise<HostFuture<T>>;
  #codec: ElemCodec<T>;
  #consumed = false;
  #dropped = false;
  #settled: Promise<T> | null = null;

  private constructor(
    host: HostFuture<T> | null,
    hostP: Promise<HostFuture<T>>,
    codec: ElemCodec<T>,
  ) {
    this.#host = host;
    this.#hostP = hostP;
    this.#codec = codec;
    // realm boundary realm-local pill (see Stream's constructor above for rationale).
    defineRealmLocal(this);
  }

  static fromLifted<T>(value: ComponentValue, codec: ElemCodec<T>): Future<T> {
    const h = hostFutureFor<T>(value);
    return new Future<T>(h, Promise.resolve(h), codec);
  }

  static fromHostFuture<T>(
    host: HostFuture<T>,
    codec: ElemCodec<T>,
  ): Future<T> {
    return new Future<T>(host, Promise.resolve(host), codec);
  }

  /**
   * Return a handle before its producing guest call resolves. A Promise
   * cannot resolve to Future without adopting its thenable value, so exports
   * return this handle eagerly. Callers can drop/cancel it without awaiting;
   * awaiting yields T, not the handle.
   */
  static deferred<T>(
    pending: Promise<ComponentValue>,
    codec: ElemCodec<T>,
    finish?: (succeeded: boolean, raw: unknown) => void,
  ): Future<T> {
    const hostP = pending.then((v) => {
      finish?.(true, v);
      const h = hostFutureFor<T>(v);
      (f as unknown as { adopt(h: HostFuture<T>): void }).adopt(h);
      return h;
    }, (e) => {
      finish?.(false, e);
      throw e;
    });
    // Observe an unused handle's producing-call rejection without replacing
    // hostP: a later await must still receive the original failure.
    hostP.catch(() => {});
    const f: Future<T> = new Future<T>(null, hostP, codec);
    return f;
  }

  /** @internal */
  adopt(h: HostFuture<T>): void {
    this.#host = h;
  }

  /** @internal */
  takeValue(): ComponentValue {
    if (this.#host === null) {
      throw new TypeError(
        "this Future is still in flight and cannot be passed to a guest yet",
      );
    }
    if (this.#consumed) {
      throw new TypeError(
        "this Future handle has already been passed to a guest",
      );
    }
    this.#consumed = true;
    return this.#host.value;
  }

  #read(): Promise<T> {
    // No new reads after transfer; a read memoized before transfer keeps its
    // result. Return a rejection to preserve then()'s Promise-shaped failure.
    if (this.#consumed && this.#settled === null) {
      return Promise.reject(
        new TypeError(
          "this Future handle has already been passed to a guest; the guest " +
            "owns its readable end, so it can no longer be read from the " +
            "host (issue #162)",
        ),
      );
    }
    this.#settled ??= (async () => {
      const host = await this.#hostP;
      const { value, result } = await host.readResult();
      if (result !== CopyResult.COMPLETED) {
        // A drop caused by the writer's instance trapping is a fault, not a
        // "no value" outcome — brand it (#66, §"Streams and futures").
        throwIfPeerTrapped(host.value, this.#codec.where ?? "future read");
        throw new DroppedError(
          result === CopyResult.CANCELLED
            ? "the future read was cancelled"
            : "the future's write end was dropped without a value",
        );
      }
      return this.#codec.toHost(value as ComponentValue);
    })();
    return this.#settled;
  }

  then<R1 = T, R2 = never>(
    onfulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.#read().then(onfulfilled, onrejected);
  }

  cancel(): void {
    if (this.#host !== null) {
      try {
        this.#host.cancel();
      } catch {
        // Pump failures remain recorded; public disposal is silent.
      }
    } else void this.#hostP.then((h) => h.cancel()).catch(() => {});
  }

  /**
   * Release this future handle. The embedder contract requires nonthrowing,
   * idempotent disposal; repeated calls are no-ops.
   *
   * Dropping a future the host never wrote to, once the guest already holds
   * its readable end, is **abandonment**: the guest's reader can never be
   * satisfied, so it is armed with a trap at its rendezvous point rather than
   * being handed a value-less completion (exec/host_streams.ts
   * `HostFuture.drop`, task/streams.ts `abandonSharedFuture`; the spec keeps
   * that state unreachable by trapping the early writable drop,
   * definitions.py `WritableFutureEnd.drop`). Write-then-drop is the normal path and is
   * unaffected; a future no guest ever saw is plain cleanup.
   */
  drop(): void {
    if (this.#dropped) return;
    this.#dropped = true;
    if (this.#host !== null) {
      try {
        this.#host.drop();
      } catch {
        // Pump failures remain recorded; public disposal is silent.
      }
    } else void this.#hostP.then((h) => h.drop()).catch(() => {});
  }

  /** @internal — see `Stream.dropForTeardown` (#66). */
  dropForTeardown(): void {
    if (this.#dropped) return;
    if (this.#host !== null) {
      this.#dropped = true;
      dropSharedForTeardown(this.#host.value as never);
    } else {
      // A deferred future (still in flight) cannot be an import argument;
      // fall back to the plain drop for completeness.
      this.drop();
    }
  }

  [Symbol.dispose](): void {
    this.drop();
  }
}

/**
 * `error-context` as the contract spells it: `{ readonly message: string }`.
 * The internal value is `task/streams.ts`'s `ErrorContext` (debug message
 * only, per definitions.py).
 */
export class ErrorContext implements ProtocolErrorContext {
  readonly message: string;
  /** @internal — the internal value, preserved so it can be lowered back. */
  readonly internal: InternalErrorContext;

  constructor(internal: InternalErrorContext) {
    this.internal = internal;
    this.message = internal.debugMessage;
    // realm boundary realm-local pill (see Stream's constructor above for rationale).
    // Note: envelope-encodable brands take precedence over the pill at
    // toCloneable time (ErrorContext carries both ERROR_CONTEXT and the
    // pill; it encodes) — the pill here is only the backstop for raw
    // structuredClone/postMessage that skips toCloneable.
    defineRealmLocal(this);
  }
}

// Brands recognize handles across copies, not share their machinery.
// ErrorContext is the exception: its public message can be copied by value.
defineBrand(Stream.prototype, STREAM);
defineBrand(StreamWriter.prototype, STREAM_WRITER);
defineBrand(Future.prototype, FUTURE);
defineBrand(ErrorContext.prototype, ERROR_CONTEXT);

/** Anything the layer accepts where a guest expects `stream<T>`. */
export type StreamSource<T> =
  | Stream<T>
  | ReadableStream<T[] | Uint8Array | T>
  | AsyncIterable<T[] | Uint8Array | T>
  | Iterable<T>;

/** Anything the layer accepts where a guest expects `future<T>`. */
export type FutureSource<T> = Future<T> | PromiseLike<T> | T;

/**
 * Adapt a producer to a lowered `stream<T>` value, and own the pumping.
 *
 * End or drop closes the activity arm; a finished producer cannot keep
 * suppressing the store's deadlock verdicts.
 */
export function lowerStreamSource<T>(
  src: StreamSource<T>,
  codec: ElemCodec<T>,
): ComponentValue {
  // Preserve handle identity before considering producer adaptation.
  if (src instanceof Stream) {
    return src.takeValue(codec);
  }
  // A foreign handle must not silently become an async-iterator copy.
  if (hasBrand(src, STREAM)) {
    throw new TypeError(describeCrossCopy(
      "this stream handle",
      "To pipe it by value, pass `src.readable()` instead.",
    ));
  }
  const host = hostStream<T>(codec.element);
  const stream = Stream.fromHostStream<T>(host, codec);
  publishHostStream(stream, host);
  void pump(src, host, codec);
  return host.value;
}

/**
 * Lower one chunk of stream elements.
 *
 * Borrow u8 typed chunks unchanged; validate and pack plain u8 arrays.
 * Other element types pass through the per-element codec, including when
 * supplied as a Uint8Array. A failed lowering releases the lowered prefix.
 */
function packChunk<T>(
  values: readonly T[] | Uint8Array,
  codec: ElemCodec<T>,
): ComponentValue[] | Uint8Array {
  const u8 = isU8Element(codec.element);
  if (values instanceof Uint8Array && u8) return values;
  const lowered: ComponentValue[] = [];
  try {
    for (const v of values) lowered.push(codec.fromHost(v as T));
  } catch (e) {
    try {
      releaseUntaken(lowered, 0, codec);
    } catch {
      // Preserve the invalid element's error after releasing the prefix.
    }
    throw e;
  }
  return u8
    ? Uint8Array.from(lowered as number[])
    : (lowered as ComponentValue[]);
}

/** Race sentinel: the reader's end dropped while the producer was parked. */
const READER_GONE: unique symbol = Symbol("polyengine reader gone");

async function pump<T>(
  src: Exclude<StreamSource<T>, Stream<T>>,
  host: HostStream<T>,
  codec: ElemCodec<T>,
): Promise<void> {
  const where = codec.where ?? "stream producer";
  let failure: unknown;
  let failed = false;
  let produced = 0;
  // A producer awaiting an external event has no write to shorten. Drop
  // notification lets batches cancel its pending pull and release resources.
  const gone = new Promise<typeof READER_GONE>((resolve) =>
    host.writable.onDropped(() => resolve(READER_GONE))
  );
  try {
    for await (const batch of batches<T>(src, gone)) {
      // Lowering is the likeliest failure (a value of the wrong shape) and it
      // must be attributed to the site, not swallowed into a short stream.
      const lowered = packChunk(batch, codec) as unknown as T[];
      const info = codec.release === undefined ? undefined : { progress: 0 };
      let n: number;
      try {
        n = await host.writable.writeAll(lowered, info);
        if (n < lowered.length) throwIfPeerTrapped(host.value, where, n);
      } catch (e) {
        try {
          releaseUntaken(
            lowered as unknown as ComponentValue[],
            info?.progress ?? 0,
            codec,
          );
        } catch {
          // Preserve the producer/peer failure after attempting every release.
        }
        throw e;
      }
      releaseUntaken(lowered as unknown as ComponentValue[], n, codec);
      produced += n;
      if (n < lowered.length) {
        // The reader went away: a clean end — but the un-taken tail of this
        // chunk was already lowered and must be destroyed, not leaked.
        break;
      }
    }
  } catch (e) {
    failure = e;
    failed = true;
  }
  if (failed) {
    void produced;
    // Report BEFORE dropping: the drop is what lets the guest see
    // end-of-stream and resolve, and the driving loop checks `hostFailure`
    // before it checks `done()`.
    reportProducerFailure(
      host as unknown as HostStream<unknown>,
      where,
      failure,
    );
  }
  // Always end the stream and release activity after recording any failure.
  host.writable.drop();
}

/** resource stream: destroy `lowered[taken..]` when a codec's elements hold resources. */
function releaseUntaken<T>(
  lowered: ComponentValue[] | Uint8Array,
  taken: number,
  codec: ElemCodec<T>,
): void {
  const release = codec.release;
  if (release === undefined || lowered instanceof Uint8Array) return;
  let failure: unknown;
  let failed = false;
  for (let i = taken; i < lowered.length; i++) {
    try {
      release(lowered[i]);
    } catch (e) {
      if (!failed) failure = e;
      failed = true;
    }
  }
  if (failed) throw failure;
}

/**
 * Normalize producers to batches. On reader loss, cancel a ReadableStream
 * through its reader, or invoke an async iterable's optional cancel hook.
 * Drain an iterable's pending pull so a late element reaches the release
 * path before iterator.return(). If cancellation cannot settle that pull,
 * this cleanup can remain pending indefinitely.
 */
async function* batches<T>(
  src: Exclude<StreamSource<T>, Stream<T>>,
  gone: Promise<typeof READER_GONE>,
): AsyncGenerator<T[] | Uint8Array> {
  if (isReadableStream(src)) {
    const reader = src.getReader();
    try {
      for (;;) {
        const r = await Promise.race([reader.read(), gone]);
        if (r === READER_GONE) {
          // `cancel` settles the pending read and runs the source's own
          // cancel() — releasing whatever platform resource backed it.
          await reader.cancel().catch(() => {});
          return;
        }
        if (r.done) return;
        yield asBatch<T>(r.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (Symbol.asyncIterator in (src as object)) {
    const it = (src as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const pending = it.next();
        const r = await Promise.race([pending, gone]);
        if (r === READER_GONE) {
          (src as { cancel?: () => void }).cancel?.();
          try {
            const last = await pending;
            if (!last.done) yield asBatch<T>(last.value);
          } catch {
            // A cancelled pull rejecting is its natural shape; the
            // producer's own failure reporting has nothing to add here —
            // the stream is already dead.
          }
          return;
        }
        if (r.done) return;
        yield asBatch<T>(r.value);
      }
    } finally {
      // Runs the source generator's own finally blocks. Queued behind any
      // still-pending pull, which the GONE arm above has already drained.
      await it.return?.();
    }
  }
  for (const v of src as Iterable<T>) yield asBatch<T>(v);
}

function asBatch<T>(v: unknown): T[] | Uint8Array {
  // Kept whole: `packChunk` decides whether the bytes are already lowered
  // (u8 element) or need the per-element codec (any other element type).
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v as T[];
  return [v as T];
}

function isReadableStream(v: unknown): v is ReadableStream<unknown> {
  return typeof ReadableStream !== "undefined" && v instanceof ReadableStream;
}

/** Adapt a `Promise`/`Future`/plain value to a lowered `future<T>` value. */
export function lowerFutureSource<T>(
  src: FutureSource<T>,
  codec: ElemCodec<T>,
): ComponentValue {
  if (src instanceof Future) return src.takeValue();
  // Reject foreign handles before thenable adoption can hide a by-value copy.
  if (hasBrand(src, FUTURE)) {
    throw new TypeError(describeCrossCopy(
      "this future handle",
      "To pipe it by value, pass `Promise.resolve(f)` instead.",
    ));
  }
  const host = hostFuture<T>(codec.element);
  void (async () => {
    try {
      const v = await (src as PromiseLike<T>);
      const lowered = codec.fromHost(v);
      const info = codec.release === undefined ? undefined : { progress: 0 };
      try {
        await host.write(lowered as unknown as T, info);
        if (info?.progress === 0) {
          throwIfPeerTrapped(host.value, codec.where ?? "future producer", 0);
        }
      } catch (e) {
        try {
          if (info?.progress === 0) codec.release?.(lowered);
        } catch {
          // Preserve the write failure if cleanup also fails.
        }
        throw e;
      }
      if (info?.progress === 0) codec.release?.(lowered);
    } catch (e) {
      // Report the producer cause rather than replace it with a generic
      // abandonment trap. A bound store receives the failure; only an unbound
      // future is dropped here. Reporting does not itself retire the future.
      const reported = reportProducerFailure(
        { value: host.value } as unknown as HostStream<unknown>,
        codec.where ?? "future producer",
        e,
      );
      if (!reported) host.drop();
    }
  })();
  return host.value;
}
