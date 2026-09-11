// Host-side stream/future ends over task/streams.ts's shared rendezvous.
// HostBuffer supplies JS chunks; direct sessions instead use a scoped view
// of the peer's bytes. The shared object retains identity across lift/lower.
//
// Host operations return Promises and pump the store when needed. HostActivity
// registers a wakeup promise while the host retains an end, so waiting for
// the embedder is not mistaken for component deadlock. Created wrappers keep
// their writable end across lowers; lifted wrappers give up their readable
// end on lower and regain it on re-lift (bindOnLower).
//
// A retained producer that never acts can leave the guest waiting indefinitely.
// Poisoning instead retires ends still in the failed instance's handle table;
// the conventions layer distinguishes that retirement from clean stream end.
// See contracts/embedder-api.md, "Streams and futures".

import { assert_ } from "../cabi/trap.ts";
import { despecialize } from "../cabi/types.ts";
import type { ComponentValue, ValType } from "../cabi/types.ts";
import {
  driveStoreAsync,
  storeDriverDepth,
  whenStoreDriverIdle,
} from "./boundary.ts";
import {
  abandonSharedFuture,
  BUFFER_MAX_LENGTH,
  type ByteWindow,
  type ComponentInstanceState,
  CopyResult,
  type DirectBuffer,
  type DirectOutcome,
  markHostActivityArm,
  type PayloadChunk,
  sameElemType,
  SharedFutureImpl,
  SharedStreamImpl,
  type Store,
  storeQuiescent as quiescent,
} from "../task/mod.ts";

/**
 * Distinct identity per host end. The reference's same-instance restriction
 * concerns copies within one guest's memory, not host-to-host copies of
 * nonnumeric values. Neither sentinel equals a guest or the opposite end.
 */
function hostEndInstance(role: "read" | "write"): unknown {
  return Object.freeze({ hostEnd: role });
}

/**
 * A buffer over JS values. Sibling of `GuestBuffer`, same four methods, no
 * memory access. Used in one of two directions:
 *
 *   * as a *readable* buffer (host supplies `values`, the guest reads them);
 *   * as a *writable* buffer (host supplies capacity, the guest fills it and
 *     `taken()` is what arrived).
 *
 * u8 payloads stay `Uint8Array` through both directions (issue #54): `read`
 * slices the typed array (bulk, and the ONE semantically required copy — the
 * chunk is only borrowed by the stream until the write settles, so the reader
 * must receive owned bytes), and `write` keeps arriving chunks whole instead
 * of exploding them element-by-element into a plain array.
 */
export class HostBuffer {
  progress = 0;
  #chunks: PayloadChunk[] = [];

  constructor(
    readonly t: ValType | null,
    private readonly values: PayloadChunk | null,
    readonly length: number,
  ) {
    // Apply Buffer.MAX_LENGTH at the host boundary too. Invalid host capacity
    // is embedder misuse (RangeError), not a guest Trap.
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError(
        `host buffer length must be a non-negative integer, got ${length}`,
      );
    }
    if (length > BUFFER_MAX_LENGTH) {
      throw new RangeError(
        `host buffer length ${length} exceeds the Component Model's ` +
          `Buffer.MAX_LENGTH (${BUFFER_MAX_LENGTH})`,
      );
    }
  }

  remain(): number {
    return this.length - this.progress;
  }

  isZeroLength(): boolean {
    return this.length === 0;
  }

  /** Guest side is reading from us. */
  read(n: number): PayloadChunk {
    assert_(n <= this.remain(), "host buffer read beyond remaining");
    const out = this.values === null
      ? new Array(n).fill(null)
      : this.values.slice(this.progress, this.progress + n);
    this.progress += n;
    return out as PayloadChunk;
  }

  /** Guest side is writing into us. */
  write(vs: PayloadChunk): void {
    assert_(vs.length <= this.remain(), "host buffer write beyond remaining");
    this.#chunks.push(vs);
    this.progress += vs.length;
  }

  /**
   * Everything written into this buffer, in arrival order.
   *
   * For a u8 element type the result is a `Uint8Array`; in the common case —
   * one rendezvous before the read resolves — the writer's chunk is returned
   * as-is, so the whole host-side read costs exactly the one rendezvous copy.
   * Every other element type yields a plain array regardless of the shape the
   * writer used.
   */
  taken(): PayloadChunk {
    const u8 = this.t !== null && despecialize(this.t).kind === "u8";
    if (u8) {
      if (this.#chunks.length === 1 && this.#chunks[0] instanceof Uint8Array) {
        return this.#chunks[0];
      }
      // Pack multiple chunks or a raw-layer plain-array offer into bytes.
      const out = new Uint8Array(this.progress);
      let o = 0;
      for (const c of this.#chunks) {
        if (c instanceof Uint8Array) out.set(c, o);
        else for (let i = 0; i < c.length; i++) out[o + i] = c[i] as number;
        o += c.length;
      }
      return out;
    }
    if (this.#chunks.length === 1 && Array.isArray(this.#chunks[0])) {
      return this.#chunks[0];
    }
    const out: ComponentValue[] = [];
    for (const c of this.#chunks) {
      for (let i = 0; i < c.length; i++) out.push(c[i]);
    }
    return out;
  }

  // ByteWindow for a host peer: sources expose the borrowed offered chunk;
  // destinations allocate scratch whose marked prefix becomes the owned
  // result. Keep that scratch stable until this callback invocation ends.

  /** The synthesized destination window, live for one direct invocation. */
  #scratch: Uint8Array | null = null;

  byteView(n: number): Uint8Array {
    assert_(n <= this.remain(), "host direct window beyond remaining");
    if (this.values === null) {
      // Stable for the whole invocation: `remaining()` re-derives on every
      // call and the producer's earlier `set()`s must survive that.
      if (this.#scratch === null || this.#scratch.length !== n) {
        this.#scratch = new Uint8Array(n);
      }
      return this.#scratch;
    }
    assert_(
      this.values instanceof Uint8Array,
      "host direct window on a non-u8 chunk",
    );
    return (this.values as Uint8Array).subarray(
      this.progress,
      this.progress + n,
    );
  }

  advanceBytes(k: number): void {
    assert_(
      k >= 0 && k <= this.remain(),
      "host direct advance beyond remaining",
    );
    if (this.values === null) {
      // Marks without a preceding byteView acknowledge zero-filled scratch,
      // just as a guest destination acknowledges its existing memory contents.
      const scratch = this.#scratch ?? new Uint8Array(k);
      // Delivered as an owned chunk; `write` is the same call the reference
      // copy would have made, so `remain()`/`taken()` stay consistent.
      this.write(scratch.subarray(0, k));
    } else {
      this.progress += k;
    }
  }

  endWindow(): void {
    this.#scratch = null;
  }
}

/**
 * A rearming wakeup in pendingHostCalls while a host end is retained.
 * Arms signal possible external progress, not outstanding work; scheduler
 * quiescence excludes them so a pump can stop without declaring deadlock.
 * `disarm` relinquishes a lifted end, `rearm` restores it, and `close` is
 * terminal on drop. Removing an arm also resolves it to wake existing races.
 */
class HostActivity {
  #store: Store | null = null;
  #promise: Promise<void> | null = null;
  #resolve: (() => void) | null = null;
  #closed = false;
  /** No retained end; revivable via `rearm()`. */
  #disarmed = false;
  #pumping = false;

  bind(store: Store): void {
    if (this.#store !== null || this.#closed) return;
    this.#store = store;
    this.#arm();
  }

  #arm(): void {
    if (this.#store === null || this.#promise !== null) return;
    if (this.#closed || this.#disarmed) return;
    this.#promise = new Promise<void>((r) => (this.#resolve = r));
    markHostActivityArm(this.#promise);
    this.#store.pendingHostCalls.add(this.#promise);
  }

  /** The embedder did something; let the driving loop re-pump. */
  notify(): void {
    const p = this.#promise, r = this.#resolve;
    this.#promise = null;
    this.#resolve = null;
    if (p !== null && this.#store !== null) {
      this.#store.pendingHostCalls.delete(p);
    }
    r?.();
    this.#arm();
  }

  /**
   * Drain settled activations and ready threads synchronously, then drive
   * asynchronous work if the store is not quiescent. This gives host
   * operations progress between export calls, including guest dependencies
   * on Promise-returning host imports.
   *
   * Record synchronous failures as well as throwing them: retirement may
   * already have settled the host operation's Promise, whose executor would
   * then discard the throw. The next driver can still report hostFailure.
   */
  pump(): void {
    const store = this.#store;
    if (store === null) return;
    try {
      // Settled activation tails gate `tick` (Store.settled); a driver that
      // never services them wedges the store — this loop runs BETWEEN export
      // calls, when no driveAsync exists to do it.
      for (;;) {
        const serviced = store.serviceSettled();
        const ticked = store.tick();
        if (!serviced && !ticked) break;
      }
    } catch (e) {
      store.hostFailure ??= e;
      throw e;
    }
    if (this.#pumping) return;
    // Retention alone is not work to drive; leave the host Promise pending.
    if (quiescent(store)) return;
    this.#pumping = true;
    void this.#pumpAsync(store);
  }

  async #pumpAsync(store: Store): Promise<void> {
    try {
      // Yield to an existing driver. This is cooperative: another may enter
      // while we await, so done() checks depth again. Resume sites recheck
      // awaiting membership and Promise identity before consuming a result
      // (boundary.ts storeDriverDepth), preventing double resumption.
      while (!quiescent(store)) {
        if (storeDriverDepth(store) > 0) {
          await whenStoreDriverIdle(store);
          continue;
        }
        await driveStoreAsync(
          store,
          // Stop on quiescence, before an idle deadlock verdict, or when
          // another driver enters. Our own depth is 1 inside this loop.
          // The caller awaits its operation, not this fallback pump.
          () =>
            store.pendingHostCalls.size === 0 ||
            quiescent(store) ||
            storeDriverDepth(store) > 1,
          "host stream/future activity",
        );
      }
    } catch (e) {
      // Nothing is awaiting this pump, so park the failure where the next
      // driving loop will surface it (same channel as a host-import
      // rejection).
      store.hostFailure ??= e;
    } finally {
      this.#pumping = false;
    }
    // Guest progress may have settled a task without settling anything in
    // another driver's pendingHostCalls race. Wake it to recheck done().
    this.notify();
  }

  /** No further host activity is possible on this stream. */
  close(): void {
    const p = this.#promise, r = this.#resolve;
    this.#closed = true;
    this.#promise = null;
    this.#resolve = null;
    if (p !== null && this.#store !== null) {
      this.#store.pendingHostCalls.delete(p);
    }
    r?.();
  }

  /**
   * Relinquish the host's lifted end and wake drivers racing its old arm.
   * Nonterminal: a re-lift of the same shared object restores retention.
   */
  disarm(): void {
    const p = this.#promise, r = this.#resolve;
    this.#disarmed = true;
    this.#promise = null;
    this.#resolve = null;
    if (p !== null && this.#store !== null) {
      this.#store.pendingHostCalls.delete(p);
    }
    r?.();
  }

  /**
   * Restore retention on re-lift; a closed activity cannot be revived.
   */
  rearm(): void {
    if (this.#closed) return;
    this.#disarmed = false;
    this.#arm();
  }
}

// ---------------------------------------------------------------------------
// Direct-access byte edges (embedder-api.md §"Streams and futures" ("Direct-access byte edges") (polyengine#128))
// ---------------------------------------------------------------------------
//
// For `stream<u8>` only, a host end may park a direct session
// instead of a chunk: at every rendezvous with a peer operation of nonzero
// capacity the session's callback runs exactly once, synchronously, inside the
// rendezvous, against a scoped view of the peer's bytes — so an external
// buffer mover's own `set()` IS the single canonical-ABI copy.
//
// The rendezvous half lives in task/streams.ts (`rendezvousCopy` and the two
// call sites it collapses to `dst.write(src.read(n))` for every non-direct
// path). This half owns the session: the callback scope, mark accounting,
// the verdict cadence, and the promise.

/** The scoped landing zone handed to a `writeDirect` producer (direct-access byte edge, #128). */
export interface DirectDestination {
  /**
   * The reader's still-unfilled bytes. Re-derived on every call (a
   * `memory.grow` between two rendezvous of one session never yields a stale
   * view) and shrinking by whatever has been marked so far in THIS
   * invocation. DEAD once the callback returns.
   */
  remaining(): Uint8Array;
  /**
   * Acknowledge bytes written into the view. Cumulative within the
   * invocation; acknowledged only if the callback then returns cleanly.
   */
  markWritten(n: number): void;
}

/** The scoped view handed to a `readDirect` consumer (direct-access byte edge, #128). */
export interface DirectSource {
  /**
   * The writer's unread bytes; read-only by contract. Same scoping and
   * re-derivation rules as `DirectDestination.remaining`.
   */
  remaining(): Uint8Array;
  /** Acknowledge bytes consumed from the view. See `markWritten`. */
  markRead(n: number): void;
}

/** The callback's poll cadence, spelled event-style. */
export type DirectVerdict = "more" | "done";

/**
 * Out-parameter of the low-level direct forms: `true` iff the session ended
 * because the callback itself returned `"done"`, rather than because the peer
 * dropped / the operation was cancelled / the peer's instance trapped.
 *
 * The conventions layer preserves a callback-completed result across a later
 * peer trap. Otherwise recorded peer poisoning rejects with the progress
 * count; ordinary drop/cancel resolve the count.
 */
export interface DirectSessionInfo {
  endedByVerdict: boolean;
}

/**
 * The `DirectDestination`/`DirectSource` object itself. One per INVOCATION,
 * not per session: "the object dies when the callback returns" is the
 * contract's validity window, and every later method call throws a
 * `TypeError` naming the rule.
 */
class DirectScope implements DirectDestination, DirectSource {
  marked = 0;
  #live = true;

  constructor(
    private readonly peer: ByteWindow,
    /** The peer's actual remaining capacity — never the parked sentinel. */
    private readonly capacity: number,
  ) {}

  remaining(): Uint8Array {
    this.#check();
    // Re-derived per call: `byteView` is grow-safe for a guest peer, and the
    // `subarray` accounts for the marks made so far in this invocation.
    return this.peer.byteView(this.capacity).subarray(this.marked);
  }

  markWritten(n: number): void {
    this.#mark(n, "markWritten");
  }

  markRead(n: number): void {
    this.#mark(n, "markRead");
  }

  #mark(n: number, who: string): void {
    this.#check();
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(
        `${who}(${n}): a direct-access mark must be a non-negative integer`,
      );
    }
    if (this.marked + n > this.capacity) {
      throw new TypeError(
        `${who}(${n}) would take the invocation's cumulative mark to ` +
          `${this.marked + n}, past the ${this.capacity} byte(s) the view ` +
          `held on entry (embedder-api.md §"Streams and futures" ("Direct-access byte edges"))`,
      );
    }
    this.marked += n;
  }

  #check(): void {
    if (!this.#live) {
      throw new TypeError(
        "this direct-access view is dead: a DirectDestination/DirectSource " +
          "is scoped to the synchronous callback invocation it was passed " +
          "to, and retaining one past its return is misuse (embedder-api.md " +
          `§"Streams and futures" ("Direct-access byte edges"), polyengine#128)`,
      );
    }
  }

  /**
   * End of the invocation: the object is dead, and every later method call
   * throws. Releasing the peer's synthesized window is the caller's job
   * (`DirectSession.runDirect`), because it must happen strictly after the
   * acknowledged marks are applied.
   */
  die(): void {
    this.#live = false;
  }
}

/**
 * A parked direct session, as both halves see it: a `DirectBuffer` to the
 * rendezvous (task/streams.ts) and a promise to the embedder.
 *
 * It presents the ordinary buffer surface so the reference control flow keeps
 * working unchanged — `remain()` answers a positive SENTINEL while the session
 * is live, which only ever feeds the rendezvous' `min()` and so resolves to
 * the peer's real capacity — but `read`/`write` are unreachable: the seam
 * routes a direct buffer through `runDirect` instead.
 */
class DirectSession implements DirectBuffer {
  readonly direct = true as const;
  /** Bytes acknowledged across the whole session. */
  total = 0;
  /** The callback said `"done"`, or the session failed / was settled. */
  ended = false;
  /** `ended` because the callback said so; see `DirectSessionInfo`. */
  endedByVerdict = false;
  /** Installed in the shared object's pending slot right now. */
  pending = false;
  /** `cancelWrite`/`cancelRead` arrived; stop at the next loop top. */
  cancelled = false;

  #settle: ((step: "done" | "reissue") => void) | null = null;
  #reject: ((e: unknown) => void) | null = null;

  constructor(
    readonly t: ValType | null,
    private readonly invoke: (scope: DirectScope) => DirectVerdict,
  ) {}

  // --- buffer surface (definitions.py `Buffer`) ---

  remain(): number {
    // The sentinel is `Buffer.MAX_LENGTH`, the largest value the rendezvous
    // can legally see; it never surfaces to the embedder because the scope is
    // built from `min(peer.remain(), sentinel)`.
    return this.ended ? 0 : BUFFER_MAX_LENGTH;
  }

  isZeroLength(): boolean {
    return false;
  }

  read(_n: number): PayloadChunk {
    throw new Error(
      "internal: a direct session must go through the direct-access byte edge seam",
    );
  }

  write(_vs: PayloadChunk): void {
    throw new Error(
      "internal: a direct session must go through the direct-access byte edge seam",
    );
  }

  // --- the direct protocol ---

  runDirect(peer: ByteWindow, n: number): DirectOutcome {
    const scope = new DirectScope(peer, n);
    try {
      return this.#runDirect(scope, peer);
    } finally {
      // Release any window the peer SYNTHESIZED (a `HostBuffer` destination's
      // scratch). Strictly after `advanceBytes`, which is what turns the
      // marked prefix of that scratch into the delivered chunk.
      peer.endWindow?.();
    }
  }

  #runDirect(scope: DirectScope, peer: ByteWindow): DirectOutcome {
    let verdict: DirectVerdict;
    try {
      verdict = this.invoke(scope);
    } catch (e) {
      // Discard marks on throw. Progress is unchanged; writes the callback
      // already made through the byte view are not rolled back.
      scope.die();
      this.#fail(e);
      return "failed";
    }
    scope.die();
    if (verdict !== "more" && verdict !== "done") {
      this.#fail(
        new TypeError(
          `a direct-access callback must return "more" or "done", got ` +
            `${
              JSON.stringify(verdict)
            } (embedder-api.md §"Streams and futures" ("Direct-access byte edges"))`,
        ),
      );
      return "failed";
    }
    const k = scope.marked;
    if (k === 0) {
      if (verdict === "done") {
        // Retract without completing the peer's parked operation.
        this.ended = true;
        this.endedByVerdict = true;
        return "retracted";
      }
      this.#fail(
        new TypeError(
          'a direct-access callback returned "more" without marking any ' +
            "bytes; a session that has nothing to offer retracts by " +
            'returning "done" (embedder-api.md §"Streams and futures" ("Direct-access byte edges") (polyengine#128))',
        ),
      );
      return "failed";
    }
    // Marks acknowledge ON CLEAN RETURN ONLY: this is the first and only
    // place the peer's progress moves, and it completes the copy with `k`.
    peer.advanceBytes(k);
    this.total += k;
    if (verdict === "done") {
      this.ended = true;
      this.endedByVerdict = true;
    }
    return "copied";
  }

  failDirect(error: Error): void {
    this.#fail(error);
  }

  // --- promise plumbing ---

  /** Arm the settle hooks for one issuance of this session. */
  arm(
    settle: (step: "done" | "reissue") => void,
    reject: (e: unknown) => void,
  ): void {
    this.#settle = settle;
    this.#reject = reject;
  }

  #take(): [
    ((s: "done" | "reissue") => void) | null,
    ((e: unknown) => void) | null,
  ] {
    const s = this.#settle, r = this.#reject;
    this.#settle = null;
    this.#reject = null;
    return [s, r];
  }

  #fail(e: unknown): void {
    this.ended = true;
    this.pending = false;
    const [, r] = this.#take();
    r?.(e);
  }

  /** The session is over; the driving loop resolves with `total`. */
  finish(): void {
    this.ended = true;
    this.pending = false;
    const [s] = this.#take();
    s?.("done");
  }

  /** This issuance rendezvoused but the session lives; re-issue it. */
  reissue(): void {
    this.pending = false;
    const [s] = this.#take();
    s?.("reissue");
  }
}

/** direct-access byte edge is `stream<u8>` only; `null` (zero-width) is not u8 either. */
function requireU8Element(t: ValType | null, who: string): void {
  if (t === null || despecialize(t).kind !== "u8") {
    throw new TypeError(
      `${who} is available on stream<u8> only; this stream's element type ` +
        `is ${t === null ? "the zero-width payload" : despecialize(t).kind} ` +
        `(embedder-api.md §"Streams and futures" ("Direct-access byte edges") (polyengine#128))`,
    );
  }
}

/** Host end the embedder WRITES; the guest reads. */
export interface HostWritableEnd<T> {
  /**
   * Offer `values`. Resolves with how many the guest actually took — a
   * partial copy is normal, not an error (definitions.py copies
   * `min(remain, remain)`). Re-offer the remainder to finish.
   *
   * `values` is BORROWED until the returned promise settles (the buffer may
   * stay parked across several partial reads); mutating it in that window is
   * misuse. Readers always receive their own copy.
   */
  // Internal out-parameter: transferred prefix, including on rejection.
  write(values: T[], info?: { progress: number }): Promise<number>;
  /**
   * Offer `values` repeatedly until all of them have been taken or the reader
   * goes away. Convenience over `write`, and the shape most embedders want.
   *
   * The loop is unavoidable in the single-shot form because of *which side
   * arrives second*: when the host arrives second the reference completes the
   * arriving call with just the count copied in that rendezvous
   * (`SharedStreamImpl.write` -> `on_copy_done(COMPLETED)`), leaving the rest
   * of the offer unsent. When the host arrives *first* it stays parked and is
   * drained across several guest reads. `writeAll` papers over the difference.
   *
   * Resolves with the total accepted; cancellation or reader drop can leave
   * a short count. The writable end stays reserved between offers.
   */
  writeAll(values: T[], info?: { progress: number }): Promise<number>;
  /**
   * Park a **direct session** on this end (`stream<u8>` only — embedder-api
   * §"Streams and futures" ("Direct-access byte edges") (polyengine#128)).
   *
   * At every rendezvous with a reader of nonzero capacity, `produce` runs
   * exactly once, synchronously, inside the rendezvous, with a
   * `DirectDestination` over the reader's unfilled landing zone — guest linear
   * memory when the peer is a guest, so the producer's own `set()` is the
   * canonical-ABI copy. `"more"` keeps the session parked for the next
   * rendezvous; `"done"` ends it. Resolves with the session's total.
   *
   * Marks acknowledge on clean return only. `"done"` with zero marked is
   * *retraction* (the session ends, the reader's operation stays parked, no
   * event); `"more"` with zero marked, and a throwing callback, reject.
   *
   * Participates in the one-in-flight-per-end rule exactly as `write` does.
   */
  writeDirect(
    produce: (dest: DirectDestination) => DirectVerdict,
    info?: DirectSessionInfo,
  ): Promise<number>;
  /**
   * Cancel a write or direct session, resolving with progress so far.
   * Cancels the whole `writeAll` helper, including gaps between offers.
   * Does not cancel a peer's operation or drop the stream.
   */
  cancelWrite(): void;
  /** definitions.py `SharedStreamImpl.drop`: notifies a parked reader. */
  drop(): void;
  /**
   * Fire `fn` once the stream becomes dropped — by either end, including
   * the loud component fault teardown walk (immediately, if it already is). The embedder's
   * producer pump uses it to cancel a producer parked on an external
   * event (§"Streams and futures"'s cancellation companion).
   */
  onDropped(fn: () => void): void;
}

/** Host end the embedder READS; the guest writes. */
export interface HostReadableEnd<T> {
  /**
   * Resolves with up to `max` values once the guest writes (or an empty
   * chunk on drop). A u8 stream resolves with a `Uint8Array` (see
   * `HostBuffer.taken`); every other element type resolves with a plain
   * array.
   */
  read(max: number): Promise<T[]>;
  /**
   * Park a **direct session** on this end (`stream<u8>` only — embedder-api
   * §"Streams and futures" ("Direct-access byte edges") (polyengine#128)). The mirror of
   * `HostWritableEnd.writeDirect`: `consume` receives a `DirectSource` over
   * the writer's unread bytes (a view of guest memory, or of the offered
   * host chunk itself) and may take a prefix — a partial take is normal, and
   * the writer re-offers on its own schedule.
   */
  readDirect(
    consume: (src: DirectSource) => DirectVerdict,
    info?: DirectSessionInfo,
  ): Promise<number>;
  /** Cancel an in-flight `read`; see `HostWritableEnd.cancelWrite`. */
  cancelRead(): void;
  drop(): void;
}

export interface HostStream<T> {
  readable: HostReadableEnd<T>;
  writable: HostWritableEnd<T>;
  /**
   * The value to pass across the boundary. Lowering it into a guest gives the
   * guest the **readable** end (`lower_stream`), so an embedder feeding a
   * guest uses `writable`; an embedder consuming a guest-produced stream gets
   * its shared object from the lift and wraps it with `hostStreamFor`.
   */
  value: ComponentValue;
}

/**
 * Attach host-activity bookkeeping to a shared object at the CABI seam.
 *
 * Created wrappers retain their writable end when the readable end lowers.
 * Lifted wrappers hold only the readable end, so lower disarms and re-lift
 * rearms them. Hooks at the CABI seam cover raw and conventions callers at
 * the actual transfer, not merely when a facade value is prepared.
 */
function bindOnLower(
  shared: SharedStreamImpl | SharedFutureImpl,
  activity: HostActivity,
  kind: "created" | "lifted",
  alsoOnLowered?: () => void,
): void {
  const holder = shared as unknown as {
    onLowered?: ((i: ComponentInstanceState) => void) | null;
    onLifted?: ((i: ComponentInstanceState) => void) | null;
  };
  // One low-level wrapper per shared object: replacing hooks would orphan
  // the original activity. hostStreamFor/hostFutureFor enforce this by cache.
  assert_(
    holder.onLowered == null,
    "internal: a second host wrapper was built for an already-wrapped " +
      "stream/future (the wrapper cache should have returned the first)",
  );
  assert_(
    holder.onLifted == null,
    "internal: a second host wrapper installed a lift hook on an " +
      "already-wrapped stream/future (the wrapper cache should have " +
      "returned the first)",
  );
  // `lowerStream`/`lowerFuture` fire this on
  // EVERY lower, not just the first — the hook persists, and the asserts
  // above only forbid installing a SECOND one.
  holder.onLowered = (inst) => {
    alsoOnLowered?.();
    if (kind === "lifted") {
      // The wrapper was bound at construction off `boundStore` (the branch
      // below); lowering this object back into a guest hands away the only
      // end the host held.
      activity.disarm();
    } else {
      activity.bind(inst.store);
    }
  };
  // Fired by `liftAsyncValue` whenever this
  // object is lifted out of a guest table. For a "created"-kind wrapper
  // `rearm()` is a harmless no-op (it is never disarmed), so the hook is
  // installed uniformly.
  holder.onLifted = () => activity.rearm();
  // Release even with no operation parked, including poisoned-end teardown.
  // A composed guest-to-guest hop rearms then disarms synchronously.
  shared.whenDropped(() => activity.close());
  // A stream that came *out* of a guest was lifted, never lowered, so the
  // `onLowered` hook above will not fire first; `boundStore` was recorded at
  // lift time instead.
  const bound = (shared as { boundStore?: unknown }).boundStore;
  if (bound) activity.bind(bound as Store);
}

function mkStreamEnds<T>(
  shared: SharedStreamImpl,
  activity: HostActivity,
): {
  readable: HostReadableEnd<T>;
  writable: HostWritableEnd<T>;
  readableBusy: () => boolean;
} {
  // Distinct rendezvous identities per end — see `hostEndInstance`.
  const writeInst = hostEndInstance("write");
  const readInst = hostEndInstance("read");
  // Which of OUR operations is currently the shared object's pending side.
  // `SharedBase.cancel` retires whatever is parked, so cancelling is only
  // legal (and only meaningful) while the parked side is ours.
  const parked = { read: false, write: false };
  let writeAll: "active" | "cancelled" | null = null;
  /**
   * Drop ends retention; other outcomes wake the driver and rearm activity.
   */
  const settle = (result: CopyResult): void => {
    if (result === CopyResult.DROPPED) activity.close();
    else activity.notify();
  };
  /**
   * Withdraw after a pump failure. Cancel only if the pending buffer is still
   * ours: poisoning may already have retired it or notified a peer.
   */
  const withdraw = (side: "read" | "write", buf: unknown): void => {
    if (!parked[side]) return;
    parked[side] = false;
    if (shared.pendingBuffer === buf as never) shared.cancel();
    activity.notify();
  };
  /** The live direct session on each end, if any (direct-access byte edge, polyengine#128). */
  const direct: { read: DirectSession | null; write: DirectSession | null } = {
    read: null,
    write: null,
  };
  /**
   * A pending session stays parked on "more" by declining to reclaim.
   * An arriving session completes that issuance and must reissue after an
   * await. The pump services the peer's event/reclamation before the next
   * issuance. Reserve the end for the entire session, including these gaps.
   */
  const runDirectSession = async (
    side: "read" | "write",
    session: DirectSession,
  ): Promise<number> => {
    parked[side] = true;
    direct[side] = session;
    try {
      for (;;) {
        if (session.cancelled) break;
        const step = await new Promise<"done" | "reissue">((res, rej) => {
          session.arm(res, rej);
          session.pending = true;
          const onCopy = (reclaim: () => void): void => {
            if (!session.ended) return; // "more": stay parked
            reclaim();
            activity.notify();
            session.finish();
          };
          const onCopyDone = (result: CopyResult): void => {
            session.pending = false;
            settle(result);
            // COMPLETED with the session still live == the arriving-side
            // rendezvous above; anything else (DROPPED, CANCELLED, or the
            // retraction path through `reset_and_notify_pending`) ends it.
            if (result === CopyResult.COMPLETED && !session.ended) {
              session.reissue();
            } else {
              session.finish();
            }
          };
          if (side === "write") {
            shared.write(writeInst, session as never, onCopy, onCopyDone);
          } else {
            shared.read(readInst, session as never, onCopy, onCopyDone);
          }
          activity.notify();
          try {
            activity.pump();
          } catch (e) {
            // The `finally` below clears `parked`/`direct`, but the session
            // itself would stay in the pending slot with `pending` true and
            // its promise rejected — the next guest op would re-run the
            // embedder's callback on a dead session. Retract it first.
            retractDirect(session);
            throw e;
          }
        });
        if (step === "done") break;
      }
    } finally {
      parked[side] = false;
      direct[side] = null;
    }
    return session.total;
  };
  /**
   * Retract a direct session from the rendezvous: the pending-slot half of
   * `cancelDirect`, shared with the pump-trap unwind above.
   */
  const retractDirect = (session: DirectSession): void => {
    session.cancelled = true;
    if (session.pending && shared.pendingBuffer === session as never) {
      shared.cancel();
    } else {
      session.finish();
    }
  };
  /** Shared tail of `cancelWrite`/`cancelRead` for a parked direct session. */
  const cancelDirect = (session: DirectSession): void => {
    // Retraction resolves with the running total. Between issuances there is
    // no pending buffer to cancel; retractDirect handles both states.
    retractDirect(session);
    activity.notify();
    activity.pump();
  };
  const write = (values: T[], info?: { progress: number }): Promise<number> => {
    const start = info?.progress ?? 0;
    const buf = new HostBuffer(
      shared.t,
      values as unknown as ComponentValue[],
      values.length,
    );
    return new Promise<number>((resolve, reject) => {
      parked.write = true;
      const done = (result: CopyResult): void => {
        parked.write = false;
        if (info !== undefined) info.progress = start + buf.progress;
        settle(result);
        resolve(buf.progress);
      };
      try {
        shared.write(
          writeInst,
          buf as never,
          (reclaim) => {
            // A host offer stays parked across partial peer reads.
            if (buf.remain() > 0) return;
            reclaim();
            done(CopyResult.COMPLETED);
          },
          done,
        );
        activity.notify();
        activity.pump();
      } catch (e) {
        if (info !== undefined) info.progress = start + buf.progress;
        reject(e);
        withdraw("write", buf);
      }
    });
  };
  return {
    readableBusy: () => parked.read,
    writable: {
      write(values: T[], info?: { progress: number }): Promise<number> {
        // One operation per direction prevents write-against-write rendezvous.
        // A simultaneous read is legal and serves host-to-host round trips.
        if (parked.write || writeAll !== null) {
          throw new TypeError(
            "a write is already in flight on this stream's writable end; " +
              "await it or cancelWrite() first",
          );
        }
        return write(values, info);
      },
      async writeAll(
        values: T[],
        info?: { progress: number },
      ): Promise<number> {
        if (parked.write || writeAll !== null) {
          throw new TypeError(
            "a write is already in flight on this stream's writable end; " +
              "await it or cancelWrite() first",
          );
        }
        writeAll = "active";
        let sent = 0;
        try {
          while (
            sent < values.length && !shared.dropped && writeAll === "active"
          ) {
            // Re-offer typed chunks by view, preserving the original borrow
            // until the whole helper settles without an extra byte copy.
            const rest = sent === 0
              ? values
              : values instanceof Uint8Array
              ? values.subarray(sent) as unknown as T[]
              : values.slice(sent);
            const n = await write(rest, info);
            if (n === 0) break; // reader gone; nothing more will be taken
            sent += n;
          }
          return sent;
        } finally {
          writeAll = null;
        }
      },
      writeDirect(
        produce: (dest: DirectDestination) => DirectVerdict,
        info?: DirectSessionInfo,
      ): Promise<number> {
        // Same one-in-flight-per-end rule, same wording shape as `write`:
        // `writeDirect` participates in it exactly as `write` does.
        if (parked.write || writeAll !== null) {
          throw new TypeError(
            "a write is already in flight on this stream's writable end; " +
              "await it or cancelWrite() first",
          );
        }
        requireU8Element(shared.t, "writeDirect");
        const session = new DirectSession(shared.t, (scope) => produce(scope));
        const p = runDirectSession("write", session);
        if (info === undefined) return p;
        return p.then((n) => {
          info.endedByVerdict = session.endedByVerdict;
          return n;
        });
      },
      cancelWrite() {
        // Cancellation owns the whole helper, including gaps between offers.
        if (writeAll !== null) writeAll = "cancelled";
        if (!parked.write) return;
        const session = direct.write;
        if (session !== null) return cancelDirect(session);
        parked.write = false;
        shared.cancel();
        activity.notify();
        activity.pump();
      },
      drop() {
        shared.drop();
        activity.close();
        activity.pump();
      },
      onDropped(fn: () => void) {
        shared.whenDropped(fn);
      },
    },
    readable: {
      read(max: number): Promise<T[]> {
        // One in-flight operation per end — see the write() guard: a second
        // read would rendezvous read-against-read with our own parked
        // buffer.
        if (parked.read) {
          throw new TypeError(
            "a read is already in flight on this stream's readable end; " +
              "await it or cancelRead() first",
          );
        }
        const buf = new HostBuffer(shared.t, null, max);
        return new Promise<T[]>((resolve) => {
          parked.read = true;
          shared.read(
            readInst,
            buf as never,
            (reclaim) => {
              reclaim();
              parked.read = false;
              activity.notify();
              resolve(buf.taken() as unknown as T[]);
            },
            (result: CopyResult) => {
              parked.read = false;
              settle(result);
              resolve(buf.taken() as unknown as T[]);
            },
          );
          activity.notify();
          try {
            activity.pump();
          } catch (e) {
            withdraw("read", buf);
            throw e;
          }
        });
      },
      readDirect(
        consume: (src: DirectSource) => DirectVerdict,
        info?: DirectSessionInfo,
      ): Promise<number> {
        if (parked.read) {
          throw new TypeError(
            "a read is already in flight on this stream's readable end; " +
              "await it or cancelRead() first",
          );
        }
        requireU8Element(shared.t, "readDirect");
        const session = new DirectSession(shared.t, (scope) => consume(scope));
        const p = runDirectSession("read", session);
        if (info === undefined) return p;
        return p.then((n) => {
          info.endedByVerdict = session.endedByVerdict;
          return n;
        });
      },
      cancelRead() {
        // Resolve with progress so far. An empty cancelled chunk is
        // indistinguishable from EOS; the caller knows it requested cancel.
        if (!parked.read) return;
        const session = direct.read;
        if (session !== null) return cancelDirect(session);
        parked.read = false;
        shared.cancel();
        activity.notify();
        activity.pump();
      },
      drop() {
        shared.drop();
        activity.close();
        activity.pump();
      },
    },
  };
}

/**
 * One low-level wrapper/activity per shared object across round trips.
 * Facade Stream/Future handles may be fresh; shared rendezvous identity and
 * these per-direction operation guards remain the same.
 */
const streamWrappers = new WeakMap<object, HostStream<unknown>>();
const futureWrappers = new WeakMap<object, HostFuture<unknown>>();
const streamReadableStates = new WeakMap<HostStream<unknown>, () => boolean>();
const futureReadableStates = new WeakMap<
  HostFuture<unknown>,
  () => "idle" | "busy" | "done"
>();

/** @internal — facade transfer exclusion without widening the end interfaces. */
export function hostStreamReadableBusy(host: HostStream<unknown>): boolean {
  return streamReadableStates.get(host)?.() ?? false;
}

/** @internal — facade transfer/single-consumption state. */
export function hostFutureReadableState(
  host: HostFuture<unknown>,
): "idle" | "busy" | "done" {
  return futureReadableStates.get(host)?.() ?? "idle";
}

/** Create a host-owned stream of `element` (`null` = zero-width payload). */
export function hostStream<T>(element: ValType | null): HostStream<T> {
  const shared = new SharedStreamImpl(element);
  const activity = new HostActivity();
  bindOnLower(shared, activity, "created");
  const { readable, writable, readableBusy } = mkStreamEnds<T>(
    shared,
    activity,
  );
  const wrapper = {
    readable,
    writable,
    value: shared as unknown as ComponentValue,
  };
  streamReadableStates.set(
    wrapper as HostStream<unknown>,
    readableBusy,
  );
  streamWrappers.set(shared, wrapper as HostStream<unknown>);
  return wrapper;
}

/**
 * Wrap a stream that came *out* of a guest (from `liftStream`). Idempotent:
 * a shared object that already has a host wrapper (it was created by
 * `hostStream`, or lifted before) yields that same wrapper.
 */
export function hostStreamFor<T>(value: ComponentValue): HostStream<T> {
  const shared = value as unknown as SharedStreamImpl;
  assert_(
    shared instanceof SharedStreamImpl,
    "hostStreamFor expects a lifted stream value",
  );
  const cached = streamWrappers.get(shared);
  if (cached !== undefined) return cached as HostStream<T>;
  const activity = new HostActivity();
  bindOnLower(shared, activity, "lifted");
  const { readable, writable, readableBusy } = mkStreamEnds<T>(
    shared,
    activity,
  );
  const wrapper = { readable, writable, value };
  streamReadableStates.set(
    wrapper as HostStream<unknown>,
    readableBusy,
  );
  streamWrappers.set(shared, wrapper as HostStream<unknown>);
  return wrapper;
}

export interface HostFuture<T> {
  /** Deliver one value; optional internal output tracks source consumption, even on failure. */
  write(value: T, info?: { progress: number }): Promise<void>;
  /** Await the future's single value. */
  read(): Promise<T | undefined>;
  /**
   * `read`, but reporting *why* it settled. A future carries at most one
   * value, so `read`'s `undefined` is ambiguous between "the value was
   * `undefined`" (a `future<void>`) and "the write end dropped without ever
   * writing" — the case the conventions layer must turn into a
   * `DroppedError`. `result` disambiguates:
   * `COMPLETED` iff `value` is real.
   */
  readResult(): Promise<{ value: T | undefined; result: CopyResult }>;
  /** Cancel an in-flight `read`/`write`; see `HostWritableEnd.cancelWrite`. */
  cancel(): void;
  /**
   * Release this future. Shared-state drop is idempotent; pumping the store
   * can still surface a guest failure.
   *
   *  * the value was already delivered (the normal write-then-drop path) —
   *    plain state cleanup, the spec's `WritableFutureEnd.drop` precondition
   *    is satisfied;
   *  * never written, and the future was **lowered** into a guest (the guest
   *    holds the readable end, so this wrapper plays the spec's writable
   *    role) — *abandon*: the reader can never be satisfied, so it is armed
   *    with the rendezvous-point trap (task/streams.ts `abandonSharedFuture`)
   *    rather than being handed a DROPPED it may not observe;
   *  * never written and never lowered — no guest ever saw it; plain
   *    cleanup.
   */
  drop(): void;
  /** Retire an unwritten producer future while preserving its failure cause. */
  fail(reason: Error): void;
  value: ComponentValue;
}

/** Create a host-owned future of `element`. */
export function hostFuture<T>(element: ValType | null): HostFuture<T> {
  const shared = new SharedFutureImpl(element);
  const activity = new HostActivity();
  const lowering = { lowered: false };
  bindOnLower(shared, activity, "created", () => lowering.lowered = true);
  const wrapper = mkFuture<T>(
    shared,
    activity,
    shared as unknown as ComponentValue,
    lowering,
  );
  futureWrappers.set(shared, wrapper as HostFuture<unknown>);
  return wrapper;
}

/**
 * Wrap a future that came *out* of a guest (from `liftFuture`). Idempotent —
 * see `hostStreamFor`.
 */
export function hostFutureFor<T>(value: ComponentValue): HostFuture<T> {
  const shared = value as unknown as SharedFutureImpl;
  assert_(
    shared instanceof SharedFutureImpl,
    "hostFutureFor expects a lifted future value",
  );
  const cached = futureWrappers.get(shared);
  if (cached !== undefined) return cached as HostFuture<T>;
  const activity = new HostActivity();
  const lowering = { lowered: false };
  bindOnLower(shared, activity, "lifted", () => lowering.lowered = true);
  const wrapper = mkFuture<T>(shared, activity, value, lowering);
  futureWrappers.set(shared, wrapper as HostFuture<unknown>);
  return wrapper;
}

function mkFuture<T>(
  shared: SharedFutureImpl,
  activity: HostActivity,
  value: ComponentValue,
  /**
   * Flipped by `bindOnLower` the first time this future is lowered into a
   * guest — i.e. the first time a guest receives its READABLE end and this
   * wrapper takes on the spec's writable role. `drop()` needs it (#90).
   */
  lowering: { lowered: boolean },
): HostFuture<T> {
  // Distinct rendezvous identities per end — see `hostEndInstance`.
  const writeInst = hostEndInstance("write");
  const readInst = hostEndInstance("read");
  const parked = { read: false, write: false };
  /** Set once the future's one value has actually crossed. */
  let delivered = false;
  const settle = (side: "read" | "write", result: CopyResult): void => {
    parked[side] = false;
    if (result === CopyResult.COMPLETED) delivered = true;
    if (result === CopyResult.DROPPED) activity.close();
    else activity.notify();
  };
  /** See `mkStreamEnds`' `withdraw`: the pump-trap unwind path. */
  const withdraw = (side: "read" | "write", buf: unknown): void => {
    if (!parked[side]) return;
    parked[side] = false;
    if (shared.pendingBuffer === buf as never) shared.cancel();
    activity.notify();
  };
  const self: HostFuture<T> = {
    write(v: T, info?: { progress: number }): Promise<void> {
      if (info !== undefined) info.progress = 0;
      // One operation per direction; opposite ends may rendezvous after a
      // guest round trip. This is a busy guard, not a delivered-value guard.
      if (parked.write) {
        throw new TypeError(
          "an operation is already in flight on this future; " +
            "await it or cancel() first",
        );
      }
      // definitions.py `SharedFutureImpl.write` asserts `remain() == 1`: a
      // future carries exactly one element.
      const buf = new HostBuffer(shared.t, [v as unknown as ComponentValue], 1);
      return new Promise<void>((resolve, reject) => {
        parked.write = true;
        try {
          shared.write(writeInst, buf as never, (result: CopyResult) => {
            if (info !== undefined) info.progress = buf.progress;
            settle("write", result);
            resolve();
          });
          activity.notify();
          activity.pump();
        } catch (e) {
          if (info !== undefined) info.progress = buf.progress;
          reject(e);
          withdraw("write", buf);
        }
      });
    },
    readResult(): Promise<{ value: T | undefined; result: CopyResult }> {
      // One in-flight operation per readable end — see write().
      if (parked.read) {
        throw new TypeError(
          "an operation is already in flight on this future; " +
            "await it or cancel() first",
        );
      }
      if (delivered) {
        throw new TypeError(
          "this future's single value has already been consumed",
        );
      }
      // definitions.py `SharedFutureImpl.read` asserts `not self.dropped`, so
      // a read after the write end went away must be answered here rather
      // than by tripping an internal assertion.
      if (shared.dropped) {
        return Promise.resolve({
          value: undefined,
          result: CopyResult.DROPPED,
        });
      }
      const buf = new HostBuffer(shared.t, null, 1);
      return new Promise((resolve, reject) => {
        parked.read = true;
        try {
          shared.read(readInst, buf as never, (result: CopyResult) => {
            settle("read", result);
            resolve({
              value: buf.taken()[0] as unknown as T | undefined,
              result,
            });
          });
          activity.notify();
          activity.pump();
        } catch (e) {
          reject(e);
          withdraw("read", buf);
        }
      });
    },
    async read(): Promise<T | undefined> {
      return (await self.readResult()).value;
    },
    cancel(): void {
      if (!parked.read && !parked.write) return;
      shared.cancel();
      activity.notify();
      activity.pump();
    },
    drop() {
      // A lowered future still owing a value is abandoned; other drops are
      // plain cleanup. Pump failures propagate even if shared state is gone.
      if (!delivered && lowering.lowered && !shared.dropped) {
        abandonSharedFuture(
          shared,
          new Error(
            "the host dropped the writable end of this future without " +
              "writing a value",
          ),
        );
      } else {
        shared.drop();
      }
      activity.close();
      activity.pump();
    },
    fail(reason: Error) {
      // Unlike public drop(), producer failure must preserve its site-named
      // cause. Record it before this call: abandonment notifies parked readers.
      try {
        if (!delivered && !shared.dropped) {
          abandonSharedFuture(shared, reason);
        } else {
          shared.drop();
        }
      } finally {
        // `dropSharedForTeardown` also runs observers in a finally block, but
        // notification itself may throw; retention still ends in that case.
        activity.close();
      }
      activity.pump();
    },
    value,
  };
  futureReadableStates.set(
    self as HostFuture<unknown>,
    () => parked.read ? "busy" : delivered ? "done" : "idle",
  );
  return self;
}

/** Re-exported so embedders can build element types without importing cabi. */
export { sameElemType };
