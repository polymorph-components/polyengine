// Host-side stream and future ends: the minimal embedder surface for the
// async value types.
//
// ===========================================================================
// WHY THIS IS SMALL
// ===========================================================================
//
// The rendezvous in `task/streams.ts` never touches linear memory. It only
// ever calls four methods on whatever buffer it is handed — `read`, `write`,
// `remain`, `isZeroLength` — and it passes the *shared* stream object around
// by identity. So a host end needs exactly two new things:
//
//   * `HostBuffer`, a sibling of `GuestBuffer` implementing that same
//     four-method surface over a plain JS array instead of guest memory; and
//   * a way to park a host read/write until the guest shows up.
//
// Everything else is existing machinery. In particular the *value* that
// crosses the component boundary is the `SharedStreamImpl` itself, so passing
// a host stream to a guest goes through the ordinary `lowerStream` path
// (definitions.py `lower_stream`, line 1828 — wrap the shared object in a
// fresh `ReadableStreamEnd` in the callee's table) and a guest-returned stream
// arrives as the same kind of object from `liftStream`. No lift/lower code was
// added for this file.
//
// ===========================================================================
// SCHEDULING
// ===========================================================================
//
// A host read/write that cannot rendezvous immediately parks, exactly as a
// guest one does, and hands back a Promise. Two cases:
//
//   * The guest is still running (it is what will complete the rendezvous).
//     The host's `onCopyDone` fires synchronously inside the guest's
//     `stream.read`/`stream.write` trampoline and the Promise resolves.
//   * The *guest* is the parked side and only the embedder can make progress.
//     Then `drive()` would otherwise see no ready thread and no outstanding
//     host call and declare deadlock — correctly, for a component that really
//     is stuck, but wrongly here. `HostActivity` below registers a
//     re-arming promise in `store.pendingHostCalls` for as long as the host
//     RETAINS a way to act, which is precisely the signal `driveAsync`
//     already understands: "progress is possible, but only after a turn of
//     the event loop".
//
// Retention, stated as the rule the arm implements (#162, embedder-api
// amendment A15): the arm is live iff the host holds a retained end, a parked
// host operation, or an unfinished producer pump. Which ends the host holds
// follows from where the wrapper came from — a host-CREATED stream keeps its
// writable end across every lower (only readable ends transfer,
// definitions.py `lower_stream` line 1828), while a LIFTED one holds just the
// readable end the guest passed out, so lowering that same object back into a
// guest (the `identity: async func(s: stream<u8>) -> stream<u8>` round trip)
// hands the host's last end away and the arm disarms. A later re-lift
// re-arms. See `bindOnLower` and `HostActivity` for the mechanism.
//
// The consequence, stated plainly: an embedder that lowers a host stream into
// a guest and then never writes to it or drops it will *hang* rather than
// trap. That is the honest outcome — the component is not deadlocked, the
// embedder simply has not done its half — and it matches how any other
// unresolved Promise behaves in JS. That policy is unchanged by A15; what
// changed is that the claim now EXPIRES with retention, so a store that once
// round-tripped a stream through the host no longer misreports every later
// genuine deadlock as this hang.
//
// The inverse case is NOT a hang (#66, embedder-api amendment A7): when the
// GUEST side dies — a trap poisons the instance holding the peer end — the
// poisoned table's ends are retired (task/streams.ts
// `retireInstanceAsyncEnds`), so a parked host operation settles DROPPED-
// shaped here and the conventions layer rejects it with `PeerTrappedError`.
// Only embedder negligence hangs; a component fault is always loud.

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
 * The `inst` a host end presents to the rendezvous. definitions.py compares it
 * against `pending_inst` for the "same instance" restriction — a guard against
 * interleaving two *lifts in one component instance's linear memory*, which is
 * why it exempts number types (definitions.py `none_or_number_type`). A host
 * end has no linear memory, so that restriction can never apply to it: each
 * end gets its OWN sentinel (never equal to a real `ComponentInstanceState`,
 * and never equal to the peer end's), so a host writer and a host reader may
 * rendezvous directly for every element type. One shared sentinel used to
 * stand for "the host" here, which made a post-pass-through host↔host copy of
 * a non-number element type trap as "intra-component" (found by the #54
 * pass-through investigation).
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
    // definitions.py `Buffer.MAX_LENGTH` (:919) is asserted on every buffer
    // the spec builds (`BufferGuestImpl.__init__`, :938); `GuestBuffer` traps
    // on it. A host buffer is not guest-visible, so a violation is embedder
    // misuse rather than a component fault — hence a loud typed JS error and
    // not a `Trap`. Caught at construction: an over-long host offer would
    // otherwise silently exceed the spec bound (#97).
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
      // Multiple chunks, or a raw-layer plain-array writer: pack. Element
      // coercion matches Uint8Array.from, which is what the conventions
      // layer applied to these values before chunks stayed whole.
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

  // --- A21 `ByteWindow` (embedder-api amendment A21, polyengine#128) ---
  //
  // A host buffer can be the PEER of a direct session on the other end of a
  // host↔host rendezvous. Which of the two shapes it takes follows from the
  // direction it was built for, exactly as `read`/`write` above do:
  //
  //   * SOURCE (`values !== null`, a parked `write`): the window is a view of
  //     the offered chunk itself — the A5 borrow, scoped to the callback. No
  //     extra copy at all.
  //   * DESTINATION (`values === null`, a parked/arriving `read(max)`): there
  //     is no landing zone to view, so the window is a fresh scratch; the
  //     marked prefix becomes the delivered chunk (ownership passes with it,
  //     and `taken()` hands a sole chunk through unsliced).

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
      // A callback may mark bytes it never actually looked at the window to
      // write (nonsense, but the runtime must stay total rather than trip an
      // internal assertion). The acknowledged prefix is then whatever the
      // synthesized landing zone held — zeroes — which is the faithful
      // analogue of the guest-peer case, where it would be whatever the
      // reader's memory already contained.
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
 * Every live `HostActivity` arm, by identity. These are the promises this
 * module parks in `store.pendingHostCalls` purely to say "the embedder may
 * still act"; they are NOT outstanding work, so the host pump must not treat
 * their presence as a reason to keep looping (that is the "activity keeps
 * pendingHostCalls non-empty forever" hazard: a pump whose exit condition is
 * `pendingHostCalls.size === 0` would never exit).
 *
 * The registry and the two predicates over it (`hasRealHostCall`,
 * `storeQuiescent`, imported above as `quiescent`) moved to
 * task/scheduler.ts so that boundary.ts's settlement pump — the OTHER
 * between-calls driver — shares the same classification without an import
 * cycle. Arms are minted here and marked via `markHostActivityArm`.
 */

/**
 * Keeps `store.pendingHostCalls` non-empty while a host end is live, so the
 * driving loop treats "waiting for the embedder" as progress-is-possible
 * rather than deadlock. Re-arms after every notification.
 *
 * RETENTION IS THE LIVENESS RULE (#162, embedder-api amendment A15). The arm
 * is live iff the host retains a way to act on this shared object: a retained
 * end, a parked host operation, or an unfinished producer pump. The claim it
 * makes to the deadlock verdicts — "the embedder may still act" — therefore
 * *expires*. Three state transitions implement it:
 *
 *   * `close()` — terminal: DROPPED, an explicit drop, or the shared object's
 *     drop observers (either end, the A7 teardown walk). Nothing can revive
 *     the wrapper.
 *   * `disarm()` — NON-terminal: the host handed its last end back to a guest
 *     (a lifted stream/future lowered back in — the identity round trip). The
 *     object is still alive; the host merely holds nothing.
 *   * `rearm()` — the inverse: a re-lift handed the readable end back.
 *
 * The embedder-negligence policy of the module header is unchanged — an
 * embedder that lowers a host-CREATED stream and never writes still hangs
 * rather than traps, because it genuinely retains the writable end.
 */
class HostActivity {
  #store: Store | null = null;
  #promise: Promise<void> | null = null;
  #resolve: (() => void) | null = null;
  #closed = false;
  /** Retention is momentarily zero; revivable via `rearm()` (#162). */
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
   * Drive the guest until it can make no more progress.
   *
   * A host operation that lands *between* export calls has no driving loop
   * running — `drive()` returned when the last export call resolved. So after
   * initiating a host read/write (or a drop) we pump the store ourselves.
   * Synchronously first (the common case: the guest is merely waiting on a
   * scheduler condition our rendezvous just satisfied, and the host op's
   * promise resolves before we return), then — if anything is still
   * outstanding — by handing the store to the *same* loop an export call
   * would have used, `driveStoreAsync`. Without the asynchronous half a guest
   * parked in a background forwarding task would never be resumed to consume
   * what we just offered, and the host read would await forever (C0 finding
   * R-1: the previous local drain only serviced `store.awaiting` and never
   * awaited `store.pendingHostCalls`, so a writer parked on a
   * Promise-returning host import stalled the reader).
   *
   * Traps from the synchronous half propagate to the caller of the host
   * operation, which is the only place that can report them.
   */
  pump(): void {
    const store = this.#store;
    if (store === null) return;
    // Settled activation tails gate `tick` (Store.settled); a driver that
    // never services them wedges the store — this loop runs BETWEEN export
    // calls, when no driveAsync exists to do it.
    for (;;) {
      const serviced = store.serviceSettled();
      const ticked = store.tick();
      if (!serviced && !ticked) break;
    }
    if (this.#pumping) return;
    // Nothing is outstanding that only an event-loop turn could advance ⇒ no
    // asynchronous pump needed. In particular an embedder that lowered a host
    // end into a guest and then never did its half lands here: we return, no
    // spin and no deadlock trap, and the operation's promise simply stays
    // pending — the documented "hangs rather than traps" behaviour (see the
    // module header).
    if (quiescent(store)) return;
    this.#pumping = true;
    void this.#pumpAsync(store);
  }

  async #pumpAsync(store: Store): Promise<void> {
    try {
      // This pump is the FALLBACK driver — the one for host operations that
      // land BETWEEN export calls — so it stands down whenever an export
      // call's loop is live: that loop already races `pendingHostCalls` and
      // `store.awaiting` and so pumps host activity on our behalf. When it
      // exits, we take over. `whenStoreDriverIdle` is edge-triggered, not
      // polled, so waiting costs no turns.
      //
      // The stand-down is COOPERATIVE, not exclusion: an export call can
      // start while we are parked mid-`await`, and we only notice at the next
      // `done()` evaluation, so a bounded overlap window remains by
      // construction (concurrent export calls have always overlapped too).
      // That is safe for the resume-once invariant — `resumeWith` deletes
      // from `store.awaiting` synchronously and every resumption site
      // re-checks membership *and* promise identity first; see the invariant
      // write-up on `storeDriverDepth` in boundary.ts. Standing down is about
      // not interleaving two loops' `serviceSettled`/`tick` phases, which is
      // what tripped `Trap: table entry empty` out of `runCallbackLoop` when
      // this pump first drove unconditionally alongside an export call.
      while (!quiescent(store)) {
        if (storeDriverDepth(store) > 0) {
          await whenStoreDriverIdle(store);
          continue;
        }
        await driveStoreAsync(
          store,
          // Quiescence, not completion: this pump exists to keep the guest
          // moving; the host operation's own promise is what the caller
          // awaits. Three exit clauses:
          //
          //   * nothing left that a turn of the event loop could advance
          //     (`quiescent`);
          //   * `pendingHostCalls` empty, which is the precondition of BOTH
          //     of `driveAsync`'s deadlock traps. Returning true there keeps
          //     this between-calls pump from converting the documented
          //     embedder-never-acts hang (module header) into a trap that
          //     would surface, misattributed, on some later export call.
          //     Deadlock detection for genuine component deadlock stays where
          //     it belongs: in the driving loop of the export call the guest
          //     is blocked in;
          //   * another driver appeared (an export call started while we were
          //     parked) — hand the store back to it, per the single-driver
          //     rule. Our depth is 1 while we are inside, hence `> 1`.
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
    // The pump advanced the guest OUTSIDE any export call's driving loop. A
    // `driveAsync` parked on `Promise.race([...pendingHostCalls])` re-evaluates
    // its `done` predicate only when something it raced settles — and
    // everything the pump just did (resume the callback task, deliver the
    // event, watch the guest `task.return`) may have settled nothing that race
    // can see. Re-arm through `notify()` so a parked driver wakes and
    // re-checks; without this the lifted call's Promise never resolves even
    // though the task resolved (observed: future-user's `double-future` under
    // jspi auto-detection — the guest finished, the embedder's await hung
    // forever).
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
   * The host retains no way to act: its lifted end was lowered back into a
   * guest, which now owns it (#162, amendment A15). NON-terminal — a re-lift
   * of the same shared object restores retention via `rearm()`.
   *
   * Resolving the stale arm is required, not tidiness: a `driveAsync` parked
   * on `Promise.race([...pendingHostCalls])` re-evaluates its `done` predicate
   * and its deadlock preconditions only when something it raced settles. An
   * arm merely deleted from the set would leave that driver asleep on a
   * promise nobody will ever settle.
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
   * A lift handed the host the readable end again — the A5 cache-hit wrapper
   * for a shared object that round-tripped back out of the guest (#162).
   * A no-op for a closed activity (the object is gone for good) and for one
   * that was never disarmed.
   */
  rearm(): void {
    if (this.#closed) return;
    this.#disarmed = false;
    this.#arm();
  }
}

// ---------------------------------------------------------------------------
// Direct-access byte edges (embedder-api amendment A21, 2026-08-22, #128)
// ---------------------------------------------------------------------------
//
// wasmtime `DirectSource`/`DirectDestination`-shaped (`component::concurrent`,
// 47.0.3). For `stream<u8>` only, a host end may park a *direct session*
// instead of a chunk: at every rendezvous with a peer operation of nonzero
// capacity the session's callback runs exactly once, synchronously, inside the
// rendezvous, against a scoped view of the peer's bytes — so an external
// buffer mover's own `set()` IS the single canonical-ABI copy.
//
// The rendezvous half lives in task/streams.ts (`rendezvousCopy` and the two
// call sites it collapses to `dst.write(src.read(n))` for every non-direct
// path). This half owns the session: the callback scope, mark accounting,
// the verdict cadence, and the promise.

/** The scoped landing zone handed to a `writeDirect` producer (A21, #128). */
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

/** The scoped view handed to a `readDirect` consumer (A21, #128). */
export interface DirectSource {
  /**
   * The writer's unread bytes; read-only by contract. Same scoping and
   * re-derivation rules as `DirectDestination.remaining`.
   */
  remaining(): Uint8Array;
  /** Acknowledge bytes consumed from the view. See `markWritten`. */
  markRead(n: number): void;
}

/** The callback's poll cadence, spelled event-style (A21). */
export type DirectVerdict = "more" | "done";

/**
 * Out-parameter of the low-level direct forms: `true` iff the session ended
 * because the callback itself returned `"done"`, rather than because the peer
 * dropped / the operation was cancelled / the peer's instance trapped.
 *
 * The conventions layer needs the distinction for A7 precision — a session
 * the producer already completed keeps its resolution even if the peer then
 * trapped — and `Promise<number>` is the contract's return shape, so it rides
 * here rather than in the resolved value.
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
          `held on entry (embedder-api amendment A21)`,
      );
    }
    this.marked += n;
  }

  #check(): void {
    if (!this.#live) {
      throw new TypeError(
        "this direct-access view is dead: a DirectDestination/DirectSource " +
          "is scoped to the synchronous callback invocation it was passed " +
          "to, and retaining one past its return is misuse (embedder-api " +
          "amendment A21, polyengine#128)",
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
  /** `ended` because the callback said so (A7 precision; see `DirectSessionInfo`). */
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
    throw new Error("internal: a direct session must go through the A21 seam");
  }

  write(_vs: PayloadChunk): void {
    throw new Error("internal: a direct session must go through the A21 seam");
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
      // "A callback that throws rejects the session with that error, and the
      // invocation's marks are discarded" — so nothing touches `peer`.
      scope.die();
      this.#fail(e);
      return "failed";
    }
    scope.die();
    if (verdict !== "more" && verdict !== "done") {
      this.#fail(
        new TypeError(
          `a direct-access callback must return "more" or "done", got ` +
            `${JSON.stringify(verdict)} (embedder-api amendment A21)`,
        ),
      );
      return "failed";
    }
    const k = scope.marked;
    if (k === 0) {
      if (verdict === "done") {
        // Retraction: the speculative-park correction. The session ends with
        // its running total and the peer's operation stays parked.
        this.ended = true;
        this.endedByVerdict = true;
        return "retracted";
      }
      this.#fail(
        new TypeError(
          'a direct-access callback returned "more" without marking any ' +
            "bytes; a session that has nothing to offer retracts by " +
            'returning "done" (embedder-api amendment A21, polyengine#128)',
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

/** A21 is `stream<u8>` only; `null` (zero-width) is not u8 either. */
function requireU8Element(t: ValType | null, who: string): void {
  if (t === null || despecialize(t).kind !== "u8") {
    throw new TypeError(
      `${who} is available on stream<u8> only; this stream's element type ` +
        `is ${t === null ? "the zero-width payload" : despecialize(t).kind} ` +
        `(embedder-api amendment A21, polyengine#128)`,
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
  write(values: T[]): Promise<number>;
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
   * Resolves with the total accepted, which is less than `values.length` only
   * if the reader dropped.
   */
  writeAll(values: T[]): Promise<number>;
  /**
   * Park a **direct session** on this end (`stream<u8>` only — embedder-api
   * amendment A21, polyengine#128).
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
   * Cancel an in-flight `write`/`writeAll` (definitions.py
   * `SharedStreamImpl.cancel` -> `CopyResult.CANCELLED`). No-op when nothing
   * of ours is parked. Surfaced per the R-fix review's stream advisory 1: the
   * cancel channel existed on the shared object but had no embedder-facing
   * spelling, so a host writer could only be abandoned, never retracted.
   */
  cancelWrite(): void;
  /** definitions.py `SharedStreamImpl.drop`: notifies a parked reader. */
  drop(): void;
  /**
   * Fire `fn` once the stream becomes dropped — by either end, including
   * the A7 teardown walk (immediately, if it already is). The embedder's
   * producer pump uses it to cancel a producer parked on an external
   * event (amendment A13's cancellation companion).
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
   * amendment A21, polyengine#128). The mirror of
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
 * `kind` is the retention model (#162, amendment A15) — WHICH ends the host
 * holds, which is decided entirely by where the wrapper came from:
 *
 *   * `"created"` — `hostStream()`/`hostFuture()`. Only READABLE ends
 *     transfer across the boundary (definitions.py `lower_stream`, line 1828,
 *     wraps the shared object in a fresh `ReadableStreamEnd` in the callee's
 *     table), so lowering hands the guest the readable end and the host keeps
 *     the WRITABLE one. Retention survives every lower; the arm ends only at
 *     drop/end-of-pump.
 *   * `"lifted"` — `hostStreamFor()`/`hostFutureFor()`. The host holds exactly
 *     the readable end the guest passed out (`lift_async_value`, line 1530).
 *     Lowering that same object back into a guest transfers it away, so
 *     retention hits zero and the activity disarms; a later re-lift restores
 *     it through the `onLifted` hook.
 *
 * The hooks live here rather than in the conventions layer's `takeValue` so
 * that BOTH the conventions layer and the raw boundary are covered, with no
 * window between "the embedder said transfer" and "the transfer happened".
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
  // INTERNAL INVARIANT (not the embedder-facing policy): two live wrappers
  // on one shared object would mean two HostActivities pumping it, and the
  // second `onLowered` hook would silently orphan the first wrapper's
  // activity binding for future lowers (review advisory, host-streams
  // round). The public entry points cannot get here with a wrapped object —
  // `hostStreamFor`/`hostFutureFor` return the cached wrapper instead
  // (amendment A5) — so a trip here is a bug in this module. The class field
  // initializes to null; == null covers both sentinels.
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
  // `lowerStream`/`lowerFuture` (cabi/async_values.ts :177/:204) fire this on
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
  // Fired by `liftAsyncValue` (cabi/async_values.ts :126) whenever this
  // object is lifted out of a guest table. For a "created"-kind wrapper
  // `rearm()` is a harmless no-op (it is never disarmed), so the hook is
  // installed uniformly.
  holder.onLifted = () => activity.rearm();
  // Release the arm when the shared object dies, whatever kills it. This is
  // the single point that covers three otherwise-separate leaks of one class:
  // the `dropForTeardown` asymmetry (embedder/streams.ts — a teardown with
  // nothing parked never reached `close()`), a guest dropping its end with no
  // host operation parked (the `settle(DROPPED)` -> `close()` path only runs
  // for a parked op), and `HostFuture.readResult`'s already-dropped fast path
  // (which answers synchronously without touching the activity).
  //
  // Note on the guest-to-guest composed hop: a value lifted from the caller
  // and immediately lowered into the callee, both synchronously inside one
  // call's lower phase, fires rearm-then-disarm on any host wrapper that
  // happens to exist for it. The pair nets out to the correct final state.
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
): { readable: HostReadableEnd<T>; writable: HostWritableEnd<T> } {
  // Distinct rendezvous identities per end — see `hostEndInstance`.
  const writeInst = hostEndInstance("write");
  const readInst = hostEndInstance("read");
  // Which of OUR operations is currently the shared object's pending side.
  // `SharedBase.cancel` retires whatever is parked, so cancelling is only
  // legal (and only meaningful) while the parked side is ours.
  const parked = { read: false, write: false };
  /**
   * Settle bookkeeping for a completed copy. `DROPPED` means the peer end is
   * gone: no further host activity on this end is possible, so the activity
   * arm is *closed* rather than re-armed (R-fix review advisory 2 — a live arm
   * after end-of-stream keeps `pendingHostCalls` non-empty forever and masks
   * a genuine deadlock as "the embedder might still act").
   */
  const settle = (result: CopyResult): void => {
    if (result === CopyResult.DROPPED) activity.close();
    else activity.notify();
  };
  /** The live direct session on each end, if any (A21, polyengine#128). */
  const direct: { read: DirectSession | null; write: DirectSession | null } = {
    read: null,
    write: null,
  };
  /**
   * Drive one direct session from park to end (A21).
   *
   * Two shapes reach us, and the difference is *which side arrived second*:
   *
   *  * the session is the PENDING side — every rendezvous fires `onCopy`, and
   *    the `"more"` verdict simply declines to `reclaim()`, so the session
   *    stays in the pending slot for the next peer operation. This is
   *    `write()`'s "stay parked until the offer is exhausted" mechanism, with
   *    the callback's verdict in place of `buf.remain() > 0`.
   *  * the session ARRIVED second — the rendezvous completes it with
   *    `onCopyDone(COMPLETED)`, so a `"more"` verdict has to re-issue. The
   *    re-issue rides the loop below (one `await` apart), which is exactly
   *    `writeAll`'s re-offer shape and therefore inherits its ordering: the
   *    peer's pending event is delivered and its buffer reclaimed before we
   *    can rendezvous against it a second time.
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
          activity.pump();
        });
        if (step === "done") break;
      }
    } finally {
      parked[side] = false;
      direct[side] = null;
    }
    return session.total;
  };
  /** Shared tail of `cancelWrite`/`cancelRead` for a parked direct session. */
  const cancelDirect = (session: DirectSession): void => {
    // A21: cancelling RETRACTS the session — it resolves with its running
    // total (A8's indistinguishability caveats unchanged). `shared.cancel()`
    // only when the session actually holds the pending slot: a session caught
    // between two issuances holds nothing, and `SharedBase.cancel` asserts
    // that something is pending.
    session.cancelled = true;
    if (session.pending) shared.cancel();
    else session.finish();
    activity.notify();
    activity.pump();
  };
  return {
    writable: {
      write(values: T[]): Promise<number> {
        // One in-flight operation per end — the host-side spelling of the
        // `CopyEnd` busy trap guests get from the table. Without it a second
        // write would find the FIRST write's buffer in the shared object's
        // pending slot and "rendezvous" write-against-write, silently
        // copying into the parked buffer's accumulation (observed as a
        // write resolving `1` against a peer that no longer exists — the
        // #66 repro). Reading while a write is parked stays legal: that is
        // the pass-through data plane (two different ends).
        if (parked.write) {
          throw new TypeError(
            "a write is already in flight on this stream's writable end; " +
              "await it or cancelWrite() first",
          );
        }
        const buf = new HostBuffer(
          shared.t,
          values as unknown as ComponentValue[],
          values.length,
        );
        return new Promise<number>((resolve) => {
          parked.write = true;
          shared.write(
            writeInst,
            buf as never,
            // `on_copy`: a partial rendezvous happened. A guest end would be
            // handed a COMPLETED event here and decide for itself whether to
            // re-offer; a host end has no event loop, so we make the useful
            // choice and **stay parked** until the offer is exhausted. That is
            // exactly the shape wit-bindgen's `wit_stream::new()` produces —
            // a background write that the reader drains a few elements at a
            // time — and it is why `reclaim` is deliberately not called while
            // values remain: reclaiming retires the pending buffer and the
            // next guest read would find nothing.
            (reclaim) => {
              if (buf.remain() > 0) return; // still parked; more to give
              reclaim();
              parked.write = false;
              activity.notify();
              resolve(buf.progress);
            },
            (result: CopyResult) => {
              parked.write = false;
              settle(result);
              resolve(buf.progress);
            },
          );
          activity.notify();
          activity.pump();
        });
      },
      async writeAll(values: T[]): Promise<number> {
        let sent = 0;
        while (sent < values.length && !shared.dropped) {
          // Re-offers keep `write`'s borrow semantics: the first round is the
          // chunk itself and later rounds a `subarray` VIEW for typed chunks
          // (review F1: a `slice` here cost a second full copy on the very
          // path the one-copy contract names), a `slice` for plain arrays.
          const rest = sent === 0
            ? values
            : values instanceof Uint8Array
            ? values.subarray(sent) as unknown as T[]
            : values.slice(sent);
          const n = await this.write(rest);
          if (n === 0) break; // reader gone; nothing more will be taken
          sent += n;
        }
        return sent;
      },
      writeDirect(
        produce: (dest: DirectDestination) => DirectVerdict,
        info?: DirectSessionInfo,
      ): Promise<number> {
        // Same one-in-flight-per-end rule, same wording shape as `write`:
        // `writeDirect` participates in it exactly as `write` does (A21).
        if (parked.write) {
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
          activity.pump();
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
        // #97, DELIBERATE AND PINNED: cancelling resolves the in-flight
        // `read` promise with whatever the buffer took so far — for a read
        // that had not yet rendezvoused, the empty chunk. An empty chunk is
        // also this layer's end-of-stream signal (see `HostReadableEnd.read`
        // and embedder/streams.ts `Stream.read`), so **a host-cancelled read
        // is indistinguishable from EOS at the conventions layer**. That is
        // accepted rather than papered over: the code that calls
        // `cancelRead()` is the same code that observes the result, so it
        // already knows which of the two happened. Nothing else can reach
        // this state — a guest cannot cancel the host's read.
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
 * One host wrapper per shared object, by identity (embedder-api amendment
 * A5). A stream/future value that round-trips host → guest → host lifts back
 * as the SAME wrapper the host already holds, so wrapping is idempotent —
 * there is never a second `HostActivity` competing to pump one shared object
 * (the hazard the old double-wrap assert guarded against), and the readable
 * end stays transferable across as many boundary hops as the spec allows.
 */
const streamWrappers = new WeakMap<object, HostStream<unknown>>();
const futureWrappers = new WeakMap<object, HostFuture<unknown>>();

/** Create a host-owned stream of `element` (`null` = zero-width payload). */
export function hostStream<T>(element: ValType | null): HostStream<T> {
  const shared = new SharedStreamImpl(element);
  const activity = new HostActivity();
  bindOnLower(shared, activity, "created");
  const ends = mkStreamEnds<T>(shared, activity);
  const wrapper = { ...ends, value: shared as unknown as ComponentValue };
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
  const ends = mkStreamEnds<T>(shared, activity);
  const wrapper = { ...ends, value };
  streamWrappers.set(shared, wrapper as HostStream<unknown>);
  return wrapper;
}

export interface HostFuture<T> {
  /** Deliver the future's single value. */
  write(value: T): Promise<void>;
  /** Await the future's single value. */
  read(): Promise<T | undefined>;
  /**
   * `read`, but reporting *why* it settled. A future carries at most one
   * value, so `read`'s `undefined` is ambiguous between "the value was
   * `undefined`" (a `future<void>`) and "the write end dropped without ever
   * writing" — the case the conventions layer must turn into a
   * `DroppedError` (R-fix review advisory 4). `result` disambiguates:
   * `COMPLETED` iff `value` is real.
   */
  readResult(): Promise<{ value: T | undefined; result: CopyResult }>;
  /** Cancel an in-flight `read`/`write`; see `HostWritableEnd.cancelWrite`. */
  cancel(): void;
  /**
   * Release this future. Total and idempotent (#90): it never throws, and a
   * second call is a no-op.
   *
   * Three cases, per the #90 ruling:
   *
   *  * the value was already delivered (the normal write-then-drop path) —
   *    plain state cleanup, the spec's `WritableFutureEnd.drop` precondition
   *    (definitions.py:1183-1184) is satisfied;
   *  * never written, and the future was **lowered** into a guest (the guest
   *    holds the readable end, so this wrapper plays the spec's writable
   *    role) — *abandon*: the reader can never be satisfied, so it is armed
   *    with the rendezvous-point trap (task/streams.ts `abandonSharedFuture`)
   *    rather than being handed a DROPPED it may not observe;
   *  * never written and never lowered — no guest ever saw it; plain
   *    cleanup.
   */
  drop(): void;
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
  const parked = { any: false };
  /** Set once the future's one value has actually crossed (#90). */
  let delivered = false;
  const settle = (result: CopyResult): void => {
    parked.any = false;
    if (result === CopyResult.COMPLETED) delivered = true;
    if (result === CopyResult.DROPPED) activity.close();
    else activity.notify();
  };
  const self: HostFuture<T> = {
    write(v: T): Promise<void> {
      // One in-flight operation per wrapper — see mkStreamEnds' guards: a
      // second op would rendezvous against our own parked buffer.
      if (parked.any) {
        throw new TypeError(
          "an operation is already in flight on this future; " +
            "await it or cancel() first",
        );
      }
      // definitions.py `SharedFutureImpl.write` asserts `remain() == 1`: a
      // future carries exactly one element.
      const buf = new HostBuffer(shared.t, [v as unknown as ComponentValue], 1);
      return new Promise<void>((resolve) => {
        parked.any = true;
        shared.write(writeInst, buf as never, (result: CopyResult) => {
          settle(result);
          resolve();
        });
        activity.notify();
        activity.pump();
      });
    },
    readResult(): Promise<{ value: T | undefined; result: CopyResult }> {
      // One in-flight operation per wrapper — see write().
      if (parked.any) {
        throw new TypeError(
          "an operation is already in flight on this future; " +
            "await it or cancel() first",
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
      return new Promise((resolve) => {
        parked.any = true;
        shared.read(readInst, buf as never, (result: CopyResult) => {
          settle(result);
          resolve({
            value: buf.taken()[0] as unknown as T | undefined,
            result,
          });
        });
        activity.notify();
        activity.pump();
      });
    },
    async read(): Promise<T | undefined> {
      return (await self.readResult()).value;
    },
    cancel(): void {
      if (!parked.any) return;
      parked.any = false;
      shared.cancel();
      activity.notify();
      activity.pump();
    },
    drop() {
      // #90. Never throws, idempotent: `SharedFutureImpl.drop` and
      // `abandonSharedFuture` both no-op on an already-dropped future, and
      // neither can raise. See the `HostFuture.drop` doc for the three cases.
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
    value,
  };
  return self;
}

/** Re-exported so embedders can build element types without importing cabi. */
export { sameElemType };
