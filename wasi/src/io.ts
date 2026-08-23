// `wasi:io@0.2` — error, poll, streams (contracts/embedder-api.md
// §"WASI examination").
//
// THE PARKING KERNEL. `pollable.block()`, `poll()` and `blocking-*` are
// sync WIT functions that must genuinely wait — the one p2 idiom that
// fights a JS host. This package used to ship always-ready stubs (the
// retired "three-tier strategy", grounded in C0 finding #6: no consumer
// leg ever called a pollable method) with real parking documented as
// "never (c) in this package". Both halves of that ruling expired:
//
//   * the polymorph-iroh upstream-iroh consumer class (unmodified
//     iroh/tokio) parks its reactor in `poll()` with timer + socket
//     pollables — the always-ready stubs don't degrade for such a guest,
//     they LIVELOCK it (block() no-ops, reads return empty, the frame
//     never suspends, so the event loop never turns and no host pump can
//     ever make progress);
//   * the runtime's suspending-import machinery (embedder-api.md A1/A2)
//     made real parking a per-declaration capability with graceful
//     degradation, so the kernel is ALWAYS ON rather than an opt-in
//     profile: on engines without JSPI, `chooseMode` falls back to plain
//     and everything behaves like the old stubs until a guest genuinely
//     parks — which then raises a clean `NeedsJspi` at the park site
//     instead of livelocking. Embedders wanting guaranteed-plain
//     instantiation pass `jspi: false`.
//
// Costs, deliberately confined: only the park-capable declarations are
// marked (`block`, `poll`) — hot-path `read`/`check-write` stay plain —
// and marking flips wasi-consuming components into jspi mode on JSPI
// engines (see the contract note on the narrowed zero-cost pin).
//
// INTEROP SEAM: `Pollable` is publicly constructible —
// `new Pollable(ready, wait)` — because external providers mint pollables
// this kernel must `poll()` uniformly. The known consumer's sockets glue
// (deliberately outside this package, per the delivery ruling) wires
// pollables to datagram queues exactly this way; the reference for the
// wake pattern is polymorph-iroh's shim (promise-swap edge triggering).
//
// Streams: `read`/`check-write` stay plain (sync, never park), but the
// `blocking-*` declarations are MARKED park-capable (amendment A14): the
// buffer-backed base impls below always take the sync fast path, while
// the genuinely-async impls — `FedInputStream`/`SinkOutputStream` below,
// serving cli-stdio's host stdin/stdout and filesystem-web's OPFS files,
// where "blocking" cannot be served from a buffer — return a Promise and
// park the frame. Marking follows the WIT declaration on the REGISTERED
// class's prototype (A2: instance-level overrides change behavior, not
// suspendability), which is what lets the duck-typed async streams park
// through the resource types registered here.

import { defineBrand, defineRealmLocal, POLLABLE } from "@polyengine/protocol";
import { suspending, ComponentException } from "@polyengine/protocol";

/** The engine setTimeout ceiling: delays above 2^31-1 ms are clamped to
 * ~0 (node/Deno warn and fire at 1 ms). `Pollable.timer` sleeps in
 * chunks of at most this and re-checks the clock at each chunk end. */
const TIMER_CHUNK_MAX_MS = 2 ** 31 - 1;

/**
 * A p2 `stream-error` value (variant): `closed` or `last-operation-failed`.
 *
 * @internal — only used as `closedError()`'s local payload type; not part
 * of any exported class's public signature (`IoError` never surfaces it).
 */
export type StreamErrorValue =
  | { kind: "closed" }
  | { kind: "last-operation-failed"; value: IoError };

function closedError(): ComponentException<StreamErrorValue> {
  return new ComponentException({ kind: "closed" });
}

/**
 * `wasi:io/error.error` — the generic downcastable error resource
 * (io.wit:23). This shim never produces one organically (streams fail with
 * `closed` only, never `last-operation-failed`); the class exists so the
 * resource *type* is a legal import target and so a future producer of one
 * has somewhere to construct it.
 */
export class IoError {
  #message: string;
  constructor(message = "I/O error") {
    this.#message = message;
  }
  toDebugString(): string {
    return this.#message;
  }
}

/**
 * A pollable over host-supplied readiness.
 *
 * WIT-facing surface: `ready()` and `block()` (the latter parks the
 * calling wasm frame when unready — @suspending, embedder-api.md A2:
 * the class prototype is the brand authority).
 *
 * Host-facing surface: the constructor and `waitPromise()`. `ready` must
 * be cheap and side-effect-free; `wait` returns a promise that settles
 * when readiness MAY have changed — block/poll re-check and re-wait in a
 * loop, so spurious wakes are fine and `wait` is called repeatedly (return
 * the CURRENT epoch's promise each call; the promise-swap pattern — settle
 * and re-arm on every event — is the intended producer shape). The default
 * (no arguments) is an always-ready pollable, the honest shape for
 * type-only linkage and never-backpressured sinks.
 */
export class Pollable {
  #ready: () => boolean;
  #wait: () => Promise<void>;

  constructor(
    ready: () => boolean = () => true,
    wait: () => Promise<void> = () => Promise.resolve(),
  ) {
    this.#ready = ready;
    this.#wait = wait;
    // A20 realm-local pill (contracts/embedder-api.md §"Realm boundaries
    // and structured-clone-safe forms"; issue #131): stateful handles fail
    // loud at a raw structuredClone/postMessage instead of husking.
    defineRealmLocal(this);
  }

  /**
   * A pollable that becomes ready at `deadline` (nanoseconds on the
   * caller's clock). One in-flight sleep is shared by concurrent waiters
   * and RE-ARMED after every settle with the delta recomputed:
   * `ready()` consults the clock, so an early-firing sleep (timer slop,
   * or the engine's setTimeout ceiling below) hands the wait loop a
   * fresh sleep for the remainder instead of a permanently-resolved
   * promise — the cached-forever arm was a hot microtask livelock for
   * any deadline past the ceiling (block/poll re-check `ready()` and
   * re-await; awaiting an already-settled promise never yields to the
   * timer that would make it ready).
   *
   * Engines clamp setTimeout delays above 2^31-1 ms to ~0 (node/Deno
   * warn and use 1 ms), so far deadlines sleep in ceiling-sized chunks;
   * each chunk end re-checks the clock and re-arms.
   */
  static timer(deadlineNs: bigint, nowNs: () => bigint): Pollable {
    let armed: Promise<void> | undefined;
    const wait = (): Promise<void> => {
      return armed ??= new Promise<void>((resolve) => {
        const deltaMs = Number(deadlineNs - nowNs()) / 1e6;
        setTimeout(resolve, Math.min(Math.max(0, deltaMs), TIMER_CHUNK_MAX_MS));
      }).then(() => {
        armed = undefined;
      });
    };
    return new Pollable(() => nowNs() >= deadlineNs, wait);
  }

  ready(): boolean {
    return this.#ready();
  }

  /** Parks the calling wasm frame until ready (sync fast path when
   * already ready — no suspension, per-declaration marking only adds the
   * engine's continuation hop). */
  @suspending
  block(): void | Promise<void> {
    if (this.#ready()) return;
    return (async () => {
      while (!this.#ready()) await this.#wait();
    })();
  }

  /** Host-facing (not part of the WIT resource surface): the current
   * epoch's wake promise, raced by `poll`. */
  waitPromise(): Promise<void> {
    return this.#wait();
  }
}

// A9 brand (contracts/embedder-api.md §"Module identity"): pollables cross
// into host provider code, which may resolve a different @polyengine copy. The
// brand makes them recognizable there; same-copy `instanceof` is unchanged
// and stays the documented spelling (issue #83). `poll()` itself needs no
// predicate: it consumes pollables structurally (`ready`/`waitPromise`), so a
// foreign provider's pollable already works — the brand is for consumers that
// must CLASSIFY one.
defineBrand(Pollable.prototype, POLLABLE);

/**
 * `wasi:io/poll.poll` — indices of the ready pollables, parking the
 * calling frame until at least one is ready. Sync fast path: if anything
 * is ready right now, the indices return without a suspension.
 *
 * The explicit annotation is JSR's no-slow-types rule (the `suspending`
 * wrapper would otherwise leave this public symbol's type inferred).
 */
export const poll: (pollables: readonly Pollable[]) => number[] | Promise<number[]> = suspending(
  (pollables: readonly Pollable[]): number[] | Promise<number[]> => {
    // io.wit: "poll [...] traps if the list [...] is empty". An unbranded
    // host throw is the embedder contract's spelling of a trap.
    if (pollables.length === 0) {
      throw new Error("wasi:io/poll.poll: empty pollable list");
    }
    const readyNow = (): number[] => {
      const out: number[] = [];
      for (let i = 0; i < pollables.length; i++) {
        if (pollables[i].ready()) out.push(i);
      }
      return out;
    };
    const first = readyNow();
    if (first.length > 0) return first;
    return (async () => {
      for (;;) {
        await Promise.race(pollables.map((p) => p.waitPromise()));
        const ready = readyNow();
        if (ready.length > 0) return ready;
      }
    })();
  },
);

/**
 * Buffer-backed input stream: serves `read`/`blocking-read` synchronously
 * from an in-memory buffer supplied at construction (default empty,
 * matching stdin's default in this package). Blocking degenerates to the
 * sync read because the buffer is always immediately available.
 */
export class InputStream {
  #buf: Uint8Array;
  #pos = 0;
  #closed = false;

  constructor(buf: Uint8Array = new Uint8Array(0)) {
    this.#buf = buf;
  }

  read(len: bigint): Uint8Array {
    if (this.#closed) throw closedError();
    const n = Math.max(0, Math.min(Number(len), this.#buf.length - this.#pos));
    const out = this.#buf.slice(this.#pos, this.#pos + n);
    this.#pos += n;
    // Issue #178: a nonzero-len request against an already-drained buffer
    // is EOF, and p2's `read` reports that as the `closed` stream-error,
    // not an empty-forever list (the guest's read-until-closed loop would
    // otherwise livelock). Matches SyncFileInputStream
    // (fs_provider.ts:519-521: `if (n > 0 && bytes.length === 0) throw
    // closed`) and FedInputStream (io.ts:418). The `len > 0` guard keeps a
    // zero-length probe a no-op, same as both siblings. This also covers
    // the zero-length-initial-buffer case: the very first nonzero read
    // against an empty buffer yields `out.length === 0` and throws here.
    if (Number(len) > 0 && out.length === 0) {
      throw closedError();
    }
    return out;
  }

  /** Park-capable (A14): the buffer-backed base never parks. */
  @suspending
  blockingRead(len: bigint): Uint8Array | Promise<Uint8Array> {
    return this.read(len);
  }

  skip(len: bigint): bigint {
    return BigInt(this.read(len).length);
  }

  /** Park-capable (A14): the buffer-backed base never parks. */
  @suspending
  blockingSkip(len: bigint): bigint | Promise<bigint> {
    return this.skip(len);
  }

  subscribe(): Pollable {
    return new Pollable();
  }

  [Symbol.dispose](): void {
    this.#closed = true;
  }
}

/**
 * Buffer-backed output stream over a byte sink. `checkWrite` always
 * reports a large permit (the sink never truly backs up), so the
 * synchronous fast path is always taken and `blocking-*` methods
 * degenerate to their non-blocking counterparts.
 */
export class OutputStream {
  #sink: (chunk: Uint8Array) => void;
  #closed = false;

  constructor(sink: (chunk: Uint8Array) => void) {
    this.#sink = sink;
  }

  checkWrite(): bigint {
    if (this.#closed) throw closedError();
    return 65536n;
  }

  write(contents: Uint8Array): void {
    if (this.#closed) throw closedError();
    this.#sink(contents);
  }

  /** Park-capable (A14): the never-backpressured base never parks. */
  @suspending
  blockingWriteAndFlush(contents: Uint8Array): void | Promise<void> {
    this.write(contents);
  }

  flush(): void {
    if (this.#closed) throw closedError();
  }

  /** Park-capable (A14): the never-backpressured base never parks. */
  @suspending
  blockingFlush(): void | Promise<void> {
    this.flush();
  }

  subscribe(): Pollable {
    return new Pollable();
  }

  writeZeroes(len: bigint): void {
    this.write(new Uint8Array(Number(len)));
  }

  /** Park-capable (A14): the never-backpressured base never parks. */
  @suspending
  blockingWriteZeroesAndFlush(len: bigint): void | Promise<void> {
    this.writeZeroes(len);
  }

  splice(src: InputStream, len: bigint): bigint {
    const chunk = src.read(len);
    this.write(chunk);
    return BigInt(chunk.length);
  }

  /** Park-capable (A14): the never-backpressured base never parks. */
  @suspending
  blockingSplice(src: InputStream, len: bigint): bigint | Promise<bigint> {
    return this.splice(src, len);
  }

  [Symbol.dispose](): void {
    this.#closed = true;
  }
}

/** Default high-water mark for the async-backed streams below: how many
 * buffered bytes pause a `FedInputStream`'s feed, and the byte budget a
 * `SinkOutputStream`'s `check-write` reports.
 *
 * @internal — a tuning constant for this module's stream implementations;
 * not part of any consumer-facing option surface. */
export const STREAM_HIGH_WATER = 65536;

/** An async byte sink; the returned promise settling = the chunk drained. */
export type ByteSink = (chunk: Uint8Array) => void | Promise<void>;

/**
 * The p2 `input-stream` surface over an asynchronously-fed buffer: the
 * generic bridge from any `AsyncIterable<Uint8Array>` (host stdin, an
 * OPFS file read) to p2 stream semantics. `read` on an empty open stream
 * returns an empty list (p2's non-blocking contract), `blocking-read`
 * parks until bytes or EOF (A14/A2 mark relay — duck-typed against the
 * registered `InputStream`, the marks relay from that prototype), and
 * EOF-with-drained-buffer is the `closed` stream-error. The feed pauses
 * past the high-water mark (no unbounded buffering).
 *
 * @internal — an implementation detail wired internally by `cli_stdio.ts`,
 * `filesystem_node.ts`/`filesystem_web.ts`, and the sockets fragments; never
 * surfaced as a public field/return type (`CliStdio.imports` and
 * `FilesystemFragment.imports` are opaque `Record<string, unknown>`).
 */
export class FedInputStream {
  #buffer: Uint8Array[] = [];
  #buffered = 0;
  #eof = false;
  #failure: unknown;
  #closed = false;
  #highWater: number;
  /** Wakes blocking readers and pollables (promise-swap producer shape). */
  #wake = (): void => {};
  #wakePromise: Promise<void>;
  /** Resumes a paused feed once the buffer drains. */
  #resume = (): void => {};

  constructor(source: AsyncIterable<Uint8Array>, highWater = STREAM_HIGH_WATER) {
    this.#highWater = highWater;
    this.#wakePromise = new Promise((r) => (this.#wake = r));
    void this.#feed(source);
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wakePromise = new Promise((r) => (this.#wake = r));
    wake();
  }

  async #feed(source: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of source) {
        if (this.#closed) return; // reader gone; stop pulling
        if (chunk.length === 0) continue;
        this.#buffer.push(chunk);
        this.#buffered += chunk.length;
        this.#signal();
        while (this.#buffered >= this.#highWater && !this.#closed) {
          await new Promise<void>((r) => (this.#resume = r));
        }
      }
      this.#eof = true;
    } catch (e) {
      this.#failure = e;
      this.#eof = true;
    }
    this.#signal();
  }

  #take(len: number): Uint8Array {
    const out = new Uint8Array(Math.min(len, this.#buffered));
    let at = 0;
    while (at < out.length) {
      const head = this.#buffer[0];
      const take = Math.min(head.length, out.length - at);
      out.set(head.subarray(0, take), at);
      at += take;
      if (take === head.length) this.#buffer.shift();
      else this.#buffer[0] = head.subarray(take);
    }
    this.#buffered -= out.length;
    if (this.#buffered < this.#highWater) this.#resume();
    return out;
  }

  read(len: bigint): Uint8Array {
    if (this.#closed) throw closedError();
    if (this.#buffered > 0) return this.#take(Number(len)); // drain before failing
    if (this.#failure !== undefined) {
      // A SOURCE failure is an error, not a clean end: the
      // `last-operation-failed` stream-error, carrying the io `error`
      // resource (an IoError subclass from the feed — e.g. a socket
      // provider's code-carrying error — is preserved for downcasts).
      throw new ComponentException({
        kind: "last-operation-failed",
        value: this.#failure instanceof IoError ? this.#failure : new IoError(
          this.#failure instanceof Error ? this.#failure.message : String(this.#failure),
        ),
      });
    }
    if (this.#eof) throw closedError(); // drained + ended = closed
    return new Uint8Array(0); // open, nothing available: p2 non-blocking read
  }

  /** Parks (A14/A2 mark relay from the registered prototype). */
  @suspending
  blockingRead(len: bigint): Uint8Array | Promise<Uint8Array> {
    if (this.#buffered > 0 || this.#eof || this.#closed) return this.read(len);
    return (async () => {
      while (this.#buffered === 0 && !this.#eof && !this.#closed) {
        await this.#wakePromise;
      }
      return this.read(len);
    })();
  }

  skip(len: bigint): bigint {
    return BigInt(this.read(len).length);
  }

  @suspending
  blockingSkip(len: bigint): bigint | Promise<bigint> {
    const r = this.blockingRead(len);
    if (r instanceof Uint8Array) return BigInt(r.length);
    return r.then((bytes) => BigInt(bytes.length));
  }

  subscribe(): Pollable {
    return new Pollable(
      () => this.#buffered > 0 || this.#eof || this.#closed,
      () => this.#wakePromise,
    );
  }

  [Symbol.dispose](): void {
    this.#closed = true;
    this.#resume(); // let a parked feed observe the close
    this.#signal();
  }
}

/**
 * The p2 `output-stream` surface over an async sink, with a real byte
 * budget: `check-write` reports the remaining permit (writing past it is
 * the guest's contract violation and traps via unbranded throw),
 * `blocking-flush`/`blocking-write-and-flush` park until the sink
 * drained everything (A14/A2 mark relay), `subscribe` wakes when budget
 * frees. A sink failure surfaces as the `last-operation-failed`
 * stream-error carrying an `IoError`.
 *
 * @internal — an implementation detail wired internally by `cli_stdio.ts`,
 * `filesystem_node.ts`/`filesystem_web.ts`, and the sockets fragments; never
 * surfaced as a public field/return type.
 */
export class SinkOutputStream {
  #sink: ByteSink;
  #highWater: number;
  #queued = 0;
  #closed = false;
  #failure: unknown;
  /** The pump: a serialized chain of sink calls. */
  #tail: Promise<void> = Promise.resolve();
  #wake = (): void => {};
  #wakePromise: Promise<void>;

  constructor(sink: ByteSink, highWater = STREAM_HIGH_WATER) {
    this.#sink = sink;
    this.#highWater = highWater;
    this.#wakePromise = new Promise((r) => (this.#wake = r));
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wakePromise = new Promise((r) => (this.#wake = r));
    wake();
  }

  #checkOpen(): void {
    if (this.#closed) throw closedError();
    if (this.#failure !== undefined) {
      // stream-error.last-operation-failed carries the io `error` RESOURCE.
      // A sink that already threw an `IoError` (subclass) keeps it — that
      // is how filesystem sinks smuggle an error-code to
      // `filesystem-error-code`'s downcast.
      throw new ComponentException({
        kind: "last-operation-failed",
        value: this.#failure instanceof IoError ? this.#failure : new IoError(
          this.#failure instanceof Error ? this.#failure.message : String(this.#failure),
        ),
      });
    }
  }

  checkWrite(): bigint {
    this.#checkOpen();
    return BigInt(Math.max(0, this.#highWater - this.#queued));
  }

  write(contents: Uint8Array): void {
    this.#checkOpen();
    if (contents.length > this.#highWater - this.#queued) {
      // Writing past the permit is the guest's contract violation: a
      // trap (unbranded throw), not a stream-error.
      throw new Error(
        "wasi:io/streams.write: contents exceed the check-write permit",
      );
    }
    this.#queued += contents.length;
    this.#tail = this.#tail.then(async () => {
      try {
        if (this.#failure === undefined) await this.#sink(contents);
      } catch (e) {
        this.#failure = e;
      } finally {
        this.#queued -= contents.length;
        this.#signal();
      }
    });
  }

  flush(): void {
    this.#checkOpen();
  }

  /** Parks until the sink drained everything (A14/A2 mark relay). */
  @suspending
  blockingFlush(): void | Promise<void> {
    this.#checkOpen();
    if (this.#queued === 0) return;
    return (async () => {
      while (this.#queued > 0 && this.#failure === undefined) {
        await this.#wakePromise;
      }
      this.#checkOpen();
    })();
  }

  /** Parks until this write (and everything before it) drained. */
  @suspending
  blockingWriteAndFlush(contents: Uint8Array): void | Promise<void> {
    this.write(contents);
    return this.blockingFlush();
  }

  subscribe(): Pollable {
    return new Pollable(
      () => this.#closed || this.#failure !== undefined || this.#queued < this.#highWater,
      () => this.#wakePromise,
    );
  }

  writeZeroes(len: bigint): void {
    this.write(new Uint8Array(Number(len)));
  }

  @suspending
  blockingWriteZeroesAndFlush(len: bigint): void | Promise<void> {
    return this.blockingWriteAndFlush(new Uint8Array(Number(len)));
  }

  splice(src: { read(len: bigint): Uint8Array }, len: bigint): bigint {
    const chunk = src.read(len);
    this.write(chunk);
    return BigInt(chunk.length);
  }

  @suspending
  blockingSplice(
    src: { read(len: bigint): Uint8Array },
    len: bigint,
  ): bigint | Promise<bigint> {
    const n = this.splice(src, len);
    const flushed = this.blockingFlush();
    if (flushed === undefined) return n;
    return flushed.then(() => n);
  }

  [Symbol.dispose](): void {
    this.#closed = true;
    this.#signal();
  }
}

/** `wasi:io@0.2` provider fragment (track key). */
export function io(): { imports: Record<string, unknown> } {
  return {
    imports: {
      "wasi:io/error@0.2": { Error: IoError },
      "wasi:io/poll@0.2": { Pollable, poll },
      "wasi:io/streams@0.2": { InputStream, OutputStream },
    },
  };
}
