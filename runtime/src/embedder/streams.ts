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
  hostFutureReadableState,
  type HostStream,
  hostStream,
  hostStreamFor,
  hostStreamReadableBusy,
} from "../exec/host_streams.ts";
import {
  abandonReasonOf,
  CopyResult,
  dropSharedForTeardown,
  type ErrorContext as InternalErrorContext,
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
 * the site-named error. Report before dropping the writer: driveAsync
 * checks hostFailure before completion, so truncation cannot hide the cause.
 * The slot is store-wide, not an attribution to a particular consuming call.
 */
function reportProducerFailure(
  host: HostStream<unknown>,
  where: string,
  cause: unknown,
): StreamProducerError {
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
  }
  return err;
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
  #boundListeners: (() => void)[] = [];

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
    if (this.#dropped) this.#host.readable.drop();
    const waiters = this.#binders;
    this.#binders = [];
    for (const w of waiters) w();
    for (const listener of this.#boundListeners) listener();
  }

  /** @internal — resolve once this handle has a shared object. */
  whenBound(): Promise<void> {
    if (this.#host !== null || this.#dropped) return Promise.resolve();
    return new Promise<void>((r) => this.#binders.push(r));
  }

  /** @internal — StreamWriter installs one stable lazy-binding hook. */
  onBound(listener: () => void): void {
    this.#boundListeners.push(listener);
  }

  /** @internal */
  get bound(): boolean {
    return this.#host !== null;
  }

  /** @internal */
  get dropped(): boolean {
    return this.#dropped;
  }

  /** @internal — the shared value to hand to a lowering site. */
  takeValue(codec: ElemCodec<T>): ComponentValue {
    if (this.#dropped) {
      throw new TypeError(
        "this Stream has been dropped and cannot be passed to a guest",
      );
    }
    // CONTRACT: transfer is the host spelling of lift_async_value's IDLE
    // precondition (definitions.py:1504-1511). Check the cached low-level
    // wrapper so aliases/round trips cannot bypass it.
    if (
      this.#host !== null &&
      hostStreamReadableBusy(this.#host as HostStream<unknown>)
    ) {
      throw new TypeError(
        "this Stream's readable end has a read in flight; await it or " +
          "cancelRead() before passing the stream to a guest",
      );
    }
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
  read(max: number): Promise<Chunk<T>> {
    let host: HostStream<T>;
    try {
      host = this.#require();
    } catch (e) {
      return Promise.reject(e);
    }
    if (hostStreamReadableBusy(host as HostStream<unknown>)) {
      throw new TypeError(
        "a read is already in flight on this stream's readable end; " +
          "await it or cancelRead() first",
      );
    }
    const where = this.#codec?.where ?? "stream read";
    try {
      throwIfFailed(host.value, where);
    } catch (e) {
      return Promise.reject(e);
    }
    let pending: Promise<T[]>;
    try {
      pending = host.readable.read(max);
    } catch (e) {
      // Only the busy exclusion above is synchronously observable. Capacity
      // and other issuance failures retain the Promise-shaped API.
      return Promise.reject(e);
    }
    return this.#finishRead(pending, host, where);
  }

  async #finishRead(
    pending: Promise<T[]>,
    host: HostStream<T>,
    where: string,
  ): Promise<Chunk<T>> {
    const raw = await pending as unknown as ComponentValue[] | Uint8Array;
    // An empty chunk normally means clean end-of-stream; when the peer's
    // instance trapped it means the retirement walk settled us — reject
    // instead of faking EOS (§"Streams and futures"). A non-empty chunk was really
    // copied before the trap and is delivered; the next read rejects.
    if (raw.length === 0) throwIfFailed(host.value, where);
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
  readDirect(
    consume: (src: DirectSource) => DirectVerdict,
  ): Promise<number> {
    let host: HostStream<T>;
    try {
      host = this.#require();
      requireU8Direct(this.#codec, "readDirect");
    } catch (e) {
      return Promise.reject(e);
    }
    if (hostStreamReadableBusy(host as HostStream<unknown>)) {
      throw new TypeError(
        "a read is already in flight on this stream's readable end; " +
          "await it or cancelRead() first",
      );
    }
    const where = this.#codec?.where ?? "stream read";
    try {
      throwIfFailed(host.value, where);
    } catch (e) {
      return Promise.reject(e);
    }
    const info: DirectSessionInfo = { endedByVerdict: false };
    let pending: Promise<number>;
    try {
      pending = host.readable.readDirect(consume, info);
    } catch (e) {
      return Promise.reject(e);
    }
    return this.#finishReadDirect(pending, info, host, where);
  }

  async #finishReadDirect(
    pending: Promise<number>,
    info: DirectSessionInfo,
    host: HostStream<T>,
    where: string,
  ): Promise<number> {
    const n = await pending;
    // Preserve a callback-completed result. Otherwise report peer poisoning
    // with the acknowledged byte count, not a clean session end.
    if (!info.endedByVerdict) {
      const failure = producerFailures.get(host.value as object);
      if (failure !== undefined) throw failure;
      throwIfPeerTrapped(host.value, where, n);
    }
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
    const waiters = this.#binders;
    this.#binders = [];
    for (const w of waiters) w();
    for (const listener of this.#boundListeners) listener();
    // Both ends of a host wrapper name the same shared object; dropping once
    // is enough (`SharedStreamImpl.drop` is idempotent).
    try {
      this.#host?.readable.drop();
    } catch {
      // Pump failures remain recorded; public disposal is total and silent.
    }
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
    return new ReadableStream<Chunk<T>>({
      pull: async (controller) => {
        const chunk = await this.read(READ_CHUNK);
        if ((chunk as { length: number }).length === 0) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel: () => {
        this.drop();
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

interface WriterOperation {
  cancelled: boolean;
  lowStarted: boolean;
  started?: boolean;
  run(op: WriterOperation): Promise<number>;
  resolve(n: number): void;
  reject(error: unknown): void;
}

/** Writer half of `Stream.create()`. */
export class StreamWriter<T> implements ProtocolStreamWriter<T> {
  #stream: Stream<T>;
  #active: WriterOperation | null = null;

  constructor(stream: Stream<T>) {
    this.#stream = stream;
    stream.onBound(() => this.#launch());
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
    return this.#start(() => this.#write(values, false));
  }

  #start(run: (op: WriterOperation) => Promise<number>): Promise<number> {
    if (this.#active !== null) {
      throw new TypeError(
        "a write is already in flight on this stream's writable end; " +
          "await it or cancelWrite() first",
      );
    }
    let resolve!: (n: number) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<number>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const op: WriterOperation = {
      cancelled: false,
      lowStarted: false,
      run,
      resolve,
      reject,
    };
    this.#active = op;
    this.#launch();
    return promise;
  }

  #launch(): void {
    const op = this.#active;
    if (op === null || op.started) return;
    if (this.#stream.dropped) return this.#resolve(op, 0);
    if (!this.#stream.bound) return;
    op.started = true;
    void op.run(op).then(
      (n) => this.#resolve(op, n),
      (e) => this.#reject(op, e),
    );
  }

  async #write(
    values: Chunk<T>,
    all: boolean,
  ): Promise<number> {
    const op = this.#active!;
    const codec = this.#stream.codec!;
    const host = hostOf(this.#stream);
    const where = codec.where ?? "stream write";
    throwIfFailed(host.value, where);
    const lowered = packChunk(values, codec);
    if (op.cancelled) {
      releaseUntaken(lowered, 0, codec);
      return 0;
    }
    const info = codec.release === undefined ? undefined : { progress: 0 };
    op.lowStarted = true;
    let n: number;
    try {
      n = await host.writable[all ? "writeAll" : "write"](
        lowered as unknown as T[],
        info,
      );
      if (n < values.length) throwIfPeerTrapped(host.value, where, n);
    } catch (e) {
      try {
        releaseUntaken(lowered, info?.progress ?? 0, codec);
      } catch {
        // Preserve the operation failure after attempting every release.
      }
      throw e;
    }
    // Keep successful cleanup outside the operation catch: if it throws,
    // each untaken resource has still been attempted exactly once.
    releaseUntaken(lowered, n, codec);
    return n;
  }

  #resolve(op: WriterOperation, n: number): void {
    if (this.#active === op) this.#active = null;
    op.resolve(n);
  }

  #reject(op: WriterOperation, error: unknown): void {
    if (this.#active === op) this.#active = null;
    op.reject(error);
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
  writeDirect(
    produce: (dest: DirectDestination) => DirectVerdict,
  ): Promise<number> {
    return this.#start(async (op) => {
      const host = hostOf(this.#stream);
      const where = this.#stream.codec?.where ?? "stream write";
      throwIfFailed(host.value, where);
      requireU8Direct(this.#stream.codec, "writeDirect");
      if (op.cancelled) return 0;
      const info: DirectSessionInfo = { endedByVerdict: false };
      op.lowStarted = true;
      const n = await host.writable.writeDirect(produce, info);
      if (!info.endedByVerdict) throwIfPeerTrapped(host.value, where, n);
      return n;
    });
  }

  /** Offer values until all are taken or the reader goes away. */
  writeAll(values: Chunk<T>): Promise<number> {
    return this.#start(() => this.#write(values, true));
  }

  cancelWrite(): void {
    const op = this.#active;
    if (op === null) return;
    op.cancelled = true;
    if (op.lowStarted) hostOf(this.#stream).writable.cancelWrite();
    else if (!op.started) this.#resolve(op, 0);
  }

  /** End-of-stream. */
  async close(): Promise<void> {
    await this.#stream.whenBound();
    if (this.#stream.bound) hostOf(this.#stream).writable.drop();
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
  /** Low-level read installed synchronously during deferred adoption. */
  #adoptedRead:
    | Promise<Awaited<ReturnType<HostFuture<T>["readResult"]>>>
    | null = null;
  /** Await has started but its low-level read may still be behind #hostP. */
  #reading = false;

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
    if (this.#reading && this.#adoptedRead === null) {
      try {
        this.#adoptedRead = h.readResult();
      } catch (e) {
        this.#adoptedRead = Promise.reject(e);
      }
    }
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
    const state = hostFutureReadableState(
      this.#host as HostFuture<unknown>,
    );
    if (this.#reading) {
      throw new TypeError(
        "this Future's readable end has an operation in flight; await or " +
          "cancel it before passing the future to a guest",
      );
    }
    if (state !== "idle") {
      throw new TypeError(
        state === "busy"
          ? "this Future's readable end has an operation in flight; await or cancel it before passing the future to a guest"
          : "this Future's value has already been consumed and cannot be passed to a guest again",
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
    if (this.#settled !== null) return this.#settled;
    // Reserve before awaiting deferred materialization. takeValue() observes
    // this initiation window even when #hostP has just adopted a host end.
    this.#reading = true;
    if (this.#host !== null) {
      // Do not cross a microtask for an already materialized future: aliases
      // consult the shared wrapper's busy state synchronously.
      const host = this.#host;
      try {
        this.#settled = this.#finishRead(host, host.readResult());
      } catch (e) {
        this.#reading = false;
        throw e;
      }
    } else {
      this.#settled = this.#hostP.then((host) =>
        this.#finishRead(host, this.#adoptedRead ?? host.readResult())
      );
    }
    this.#settled = this.#settled.finally(() => this.#reading = false);
    return this.#settled;
  }

  async #finishRead(
    host: HostFuture<T>,
    pending: Promise<Awaited<ReturnType<HostFuture<T>["readResult"]>>>,
  ): Promise<T> {
    try {
      const { value, result } = await pending;
      if (result !== CopyResult.COMPLETED) {
        // Producer failure and peer poisoning both outrank the ordinary
        // cancelled/dropped outcome; throwIfFailed checks them in that order.
        throwIfFailed(host.value, this.#codec.where ?? "future read");
        throw new DroppedError(
          result === CopyResult.CANCELLED
            ? "the future read was cancelled"
            : "the future's write end was dropped without a value",
        );
      }
      return this.#codec.toHost(value as ComponentValue);
    } catch (e) {
      // Only replace the trap manufactured by producer-failure abandonment.
      const failure = producerFailures.get(host.value as object);
      if (
        failure !== undefined && abandonReasonOf(host.value) === failure &&
        typeof e === "object" && e !== null &&
        (e as { cause?: unknown }).cause === failure
      ) throw failure;
      throw e;
    }
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
    let completed = false;
    let cancellation: Promise<void> | undefined;
    const cancel = () => cancellation ??= reader.cancel().catch(() => {});
    try {
      for (;;) {
        // Keep the read after racing it. If reader loss wins, cancellation
        // settles a truly pending read; if the source already handed ownership
        // to that read, drain its value through the ordinary untaken-tail path.
        // CONTRACT: embedder-api.md:455-475; the CABI only accounts for values
        // at its rendezvous (CanonicalABI.md:1769-1795).
        const pending = reader.read();
        let r = await Promise.race([pending, gone]);
        if (r === READER_GONE) {
          // Initiate before awaiting the read: cancellation is the producer's
          // channel for unblocking a pull. Do not await cancellation yet, since
          // a buggy/hung cancel hook must not hide disposal of an obtained value.
          cancel();
          try {
            r = await pending;
          } catch {
            // A cancelled pull may reject; the stream is already dead and its
            // cleanup failure must not become a producer failure.
            return;
          }
          if (!r.done) yield asBatch<T>(r.value);
          return;
        }
        if (r.done) {
          completed = true;
          return;
        }
        yield asBatch<T>(r.value);
      }
    } finally {
      try {
        // JS embedding policy, not canon cancel-copy: abandoning an unfinished
        // web stream tears down its producer (embedder-api.md, producer cleanup
        // clause under "Streams of resources").
        if (!completed) await cancel();
      } catch {
        // Producer cleanup never replaces the operation's outcome.
      } finally {
        reader.releaseLock();
      }
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
      // abandonment trap. Reporting itself does not retire the future.
      const failure = reportProducerFailure(
        { value: host.value } as unknown as HostStream<unknown>,
        codec.where ?? "future producer",
        e,
      );
      try {
        // CONTRACT: an unwritten bound future is abandoned, not completed
        // DROPPED-shaped (embedder-api.md §"Streams and futures";
        // definitions.py `WritableFutureEnd.drop`).
        // Retire it with the producer error itself so pending guest and host
        // readers wake with the same cause, and drop observers release activity.
        host.fail(failure);
      } catch {
        // Reporting happened first; cleanup must not replace the producer fault.
      }
    }
  })();
  return host.value;
}
