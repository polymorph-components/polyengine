// Streams, futures and error-context: the async *value* types
// (definitions.py `### Stream State`, `### Future State`, `class ErrorContext`).
//
// A shared stream holds at most one pending side, not a queue of values.
// The opposite side copies min(source.remain(), destination.remain())
// synchronously on arrival. Partial progress is normal; the pending side's
// onCopy decides when to reclaim its buffer. CopyEnd waitables carry guest
// notifications, whose progress/result payloads are evaluated at delivery.
// Host buffers and direct byte sessions use the same rendezvous.

import { defineBrand, ERROR_CONTEXT } from "@polyengine/protocol";
import { assert_, Trap, trapIf } from "../cabi/trap.ts";
import type { LiftLowerContext } from "../cabi/context.ts";
import { bytesOf } from "../cabi/memory.ts";
import { loadListFromValidRange } from "../cabi/load.ts";
import { storeListIntoValidRange } from "../cabi/store.ts";
import { alignment, alignTo, elemSize } from "../cabi/layout.ts";
import { despecialize, valTypeEqual } from "../cabi/types.ts";
import type { ComponentValue, ValType } from "../cabi/types.ts";
import { Waitable } from "./waitable.ts";
import { isInstancePoisoned, setOnInstancePoisoned } from "./scheduler.ts";

/** Cross-boundary structural equality, comparing resource origins, not local tables.
 * `null` denotes the zero-width payload. */
export function sameElemType(a: ValType | null, b: ValType | null): boolean {
  return valTypeEqual(a, b, "underlying");
}

/** definitions.py `Buffer.MAX_LENGTH`. */
export const BUFFER_MAX_LENGTH = 2 ** 28 - 1;

/**
 * One rendezvous chunk. u8 payloads stay `Uint8Array` through the bulk-copy
 * path; other element types travel as plain arrays.
 */
export type PayloadChunk = ComponentValue[] | Uint8Array;

/** definitions.py `CopyResult`. */
export enum CopyResult {
  COMPLETED = 0,
  DROPPED = 1,
  CANCELLED = 2,
}

/** definitions.py `CopyState`. */
export enum CopyState {
  IDLE = 1,
  COPYING = 2,
  CANCELLING_COPY = 3,
  DONE = 4,
}

export type ReclaimBuffer = () => void;
export type OnCopy = (reclaim: ReclaimBuffer) => void;
export type OnCopyDone = (result: CopyResult) => void;

// ---------------------------------------------------------------------------
// Buffers (definitions.py `BufferGuestImpl`)
// ---------------------------------------------------------------------------

/**
 * A cursor over `length` elements of type `t` at `ptr` in one guest's memory.
 * `t === null` is the zero-width element type (`stream` with no payload),
 * where only the *count* is meaningful.
 */
export class GuestBuffer {
  progress = 0;

  constructor(
    readonly t: ValType | null,
    readonly cx: LiftLowerContext,
    public ptr: number,
    readonly length: number,
  ) {
    trapIf(length > BUFFER_MAX_LENGTH, "buffer length exceeds MAX_LENGTH");
    if (t !== null && length > 0) {
      const mem = cx.opts.memory;
      assert_(mem !== null, "buffer requires a memory");
      const ptrType = mem.ptrType();
      trapIf(
        ptr !== alignTo(ptr, alignment(t, ptrType)),
        "unaligned buffer pointer",
      );
      trapIf(
        ptr + length * elemSize(t, ptrType) > mem.length,
        "buffer out of bounds",
      );
    }
  }

  remain(): number {
    return this.length - this.progress;
  }

  isZeroLength(): boolean {
    return this.length === 0;
  }

  /** definitions.py `ReadableBufferGuestImpl.read`. */
  read(n: number): PayloadChunk {
    assert_(n <= this.remain(), "buffer read beyond remaining");
    let vs: PayloadChunk;
    if (this.t !== null) {
      vs = loadListFromValidRange(this.cx, this.ptr, n, this.t) as PayloadChunk;
      this.ptr += n * elemSize(this.t, this.cx.opts.memory!.ptrType());
    } else {
      vs = new Array(n).fill(null);
    }
    this.progress += n;
    return vs;
  }

  /** definitions.py `WritableBufferGuestImpl.write`. */
  write(vs: PayloadChunk): void {
    assert_(vs.length <= this.remain(), "buffer write beyond remaining");
    if (this.t !== null) {
      storeListIntoValidRange(this.cx, vs, this.ptr, this.t);
      this.ptr += vs.length * elemSize(this.t, this.cx.opts.memory!.ptrType());
    } else {
      // definitions.py `WritableBufferGuestImpl.write`:
      // `assert(all(v == () for v in vs))` — a zero-width stream carries no
      // payload, so anything but the placeholder means a element-type mix-up
      // upstream (a typed chunk here would be the same mix-up).
      assert_(
        !(vs instanceof Uint8Array) && vs.every((v) => v === null),
        "zero-width buffer written with a non-empty element",
      );
    }
    this.progress += vs.length;
  }

  // ByteWindow for stream<u8>: the peer callback moves bytes through a view,
  // then advanceBytes records the acknowledged progress in either direction.

  /**
   * A fresh view over the next `n` bytes of this buffer's remaining range.
   *
   * Fresh on every call, via `bytesOf` over the
   * `LiveMemory` getters — so a `memory.grow` between two rendezvous of one
   * parked direct session never yields a view onto the detached buffer.
   */
  byteView(n: number): Uint8Array {
    assert_(
      this.t !== null && despecialize(this.t).kind === "u8",
      "direct byte window on a non-u8 buffer",
    );
    assert_(n <= this.remain(), "direct byte window beyond remaining");
    const mem = this.cx.opts.memory;
    assert_(mem !== null, "direct byte window requires a memory");
    return bytesOf(mem!, this.ptr, n);
  }

  /**
   * Advance by `k` WITHOUT copying: the bytes already moved through the view
   * `byteView` handed out. Called by the seam only after the direct callback
   * returned cleanly, which is what makes marks acknowledge-on-clean-return.
   */
  advanceBytes(k: number): void {
    assert_(k >= 0 && k <= this.remain(), "direct advance beyond remaining");
    this.ptr += k; // elemSize(u8) === 1
    this.progress += k;
  }
}

// ---------------------------------------------------------------------------
// The direct-access seam (embedder-api.md §"Streams and futures" ("Direct-access byte edges") (polyengine#128))
// ---------------------------------------------------------------------------
//
// One side may supply a synchronous callback instead of a buffer. It moves
// bytes through the peer's scoped ByteWindow; ordinary copies still use
// dst.write(src.read(n)). Structural interfaces avoid an import from exec/.

/**
 * The buffer surface used by the rendezvous (definitions.py `Buffer`).
 * Both `GuestBuffer` and the host layer's `HostBuffer` satisfy it.
 */
export interface RendezvousBuffer {
  remain(): number;
  isZeroLength(): boolean;
  read(n: number): PayloadChunk;
  write(vs: PayloadChunk): void;
}

/**
 * direct-access byte edge: the peer half of a direct rendezvous — a buffer that can expose its
 * remaining range as bytes and be advanced without a copy.
 *
 * Implemented by `GuestBuffer` (a view into guest linear memory: the
 * embedder's own `set()` becomes the one ABI copy) and by `HostBuffer` (a
 * view of the offered chunk when it is the source; a synthesized scratch that
 * becomes the delivered chunk when it is the destination).
 */
export interface ByteWindow {
  /**
   * A view over the next `n` bytes. May be called several times within one
   * direct invocation (`remaining()` re-derives on every call); an
   * implementation that *synthesizes* the window must return the same
   * storage for the whole invocation and release it in `endWindow`.
   */
  byteView(n: number): Uint8Array;
  /** Record `k` bytes as moved. Called only after a clean callback return. */
  advanceBytes(k: number): void;
  /** End of one direct invocation; drop any synthesized window. */
  endWindow?(): void;
}

/**
 * direct-access byte edge: the parked direct session, as the rendezvous sees it. It presents the
 * ordinary buffer surface (so `remain()`/`isZeroLength()` keep the reference
 * control flow working) but its `read`/`write` are never called — the seam
 * routes it through `runDirect` instead.
 */
export interface DirectBuffer extends RendezvousBuffer {
  readonly direct: true;
  /**
   * Run this session's callback exactly once against the peer's window,
   * with `n` bytes of capacity. Applies the acknowledged marks to `peer`
   * itself, and settles the session on failure — the seam only routes the
   * rendezvous state that follows.
   */
  runDirect(peer: ByteWindow, n: number): DirectOutcome;
  /**
   * Reject this session out-of-band (the two-direct-sessions rendezvous,
   * where neither side owns memory).
   */
  failDirect(error: Error): void;
}

/**
 * What the seam did, and hence how the rendezvous must continue.
 *
 *  * `"chunk"` — no direct session was involved: the reference copy ran.
 *  * `"copied"` — the callback acknowledged ≥ 1 byte; continue exactly as
 *    after a reference copy (fire the pending side's `on_copy`).
 *  * `"retracted"` — `"done"` with zero marked. Continue as if the direct
 *    side's buffer had had `remain() == 0` all along, which is a state
 *    definitions.py already routes.
 *  * `"failed"` — misuse or a throwing callback; the session has already
 *    rejected. No copy, no event, the peer's parked operation survives.
 *  * `"both-direct"` — neither side owns memory; the ARRIVING side is
 *    rejected by the caller and the parked side is left undisturbed.
 */
export type DirectOutcome = "copied" | "retracted" | "failed";
export type RendezvousOutcome = DirectOutcome | "chunk" | "both-direct";

function isDirectBuffer(b: RendezvousBuffer): b is DirectBuffer {
  return (b as { direct?: unknown }).direct === true;
}

/**
 * The one copy site, shared by `SharedStreamImpl.read` and `.write`.
 *
 * Uses the reference's `dst_buffer.write(src_buffer.read(n))` unless one
 * side supplies a direct callback. Two direct sessions have no backing buffer.
 */
function rendezvousCopy(
  src: RendezvousBuffer,
  dst: RendezvousBuffer,
  n: number,
): RendezvousOutcome {
  const srcDirect = isDirectBuffer(src);
  const dstDirect = isDirectBuffer(dst);
  if (!srcDirect && !dstDirect) {
    dst.write(src.read(n));
    return "chunk";
  }
  if (srcDirect && dstDirect) return "both-direct";
  return srcDirect
    ? src.runDirect(dst as unknown as ByteWindow, n)
    : (dst as DirectBuffer).runDirect(src as unknown as ByteWindow, n);
}

/** The rejection for a rendezvous of two direct-access sessions. */
function bothDirectError(): TypeError {
  return new TypeError(
    "at least one side of a host-to-host rendezvous must use the chunk " +
      "forms: two direct-access sessions cannot rendezvous with each other " +
      "because neither side owns the memory the other would write into " +
      `(embedder-api.md §"Streams and futures" ("Direct-access byte edges"), polyengine#128)`,
  );
}

/**
 * definitions.py `none_or_number_type`. Guards the "temporary"
 * same-instance restriction below.
 */
function noneOrNumberType(t: ValType | null): boolean {
  if (t === null) return true;
  switch (despecialize(t).kind) {
    case "u8":
    case "u16":
    case "u32":
    case "u64":
    case "s8":
    case "s16":
    case "s32":
    case "s64":
    case "f32":
    case "f64":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The shared stream (definitions.py `SharedStreamImpl`)
// ---------------------------------------------------------------------------

/** Common shape of the object a `stream`/`future` *value* refers to. */
export interface SharedBase {
  readonly t: ValType | null;
  dropped: boolean;
  cancel(): void;
  drop(): void;
}

export class SharedStreamImpl implements SharedBase {
  /**
   * Optional hook fired when this shared object is lowered into a component
   * instance (`lower_stream`/`lower_future`). Host-owned ends use it to learn
   * which `Store` is driving the guest they were just handed to; guest-owned
   * streams leave it unset. Keeps `cabi` free of any host-stream knowledge.
   */
  onLowered: ((inst: { store: unknown }) => void) | null = null;
  /**
   * Optional hook fired by `liftAsyncValue` whenever this object is lifted
   * OUT of a guest table. The receiver — the host, or the destination of a
   * guest-to-guest hop, in which case the immediately following lower fires
   * `onLowered` — may now act on the transferred end. Host wrappers use it to
   * re-arm their activity (#162, contracts/embedder-api.md §"Streams and futures"). Guest-owned
   * objects leave it unset.
   */
  onLifted: ((inst: { store: unknown }) => void) | null = null;
  /**
   * The `Store` driving the component this object has been handed to, set the
   * first time it is lifted or lowered. Host ends need it to pump the guest
   * between export calls (see exec/host_streams.ts `HostActivity.pump`); a
   * purely guest-to-guest stream never reads it.
   */
  boundStore: unknown = null;

  dropped = false;
  pendingInst: unknown = null;
  pendingBuffer: GuestBuffer | null = null;
  pendingOnCopy: OnCopy | null = null;
  pendingOnCopyDone: OnCopyDone | null = null;

  /**
   * Fired once on either end's drop, including teardown. Releases host
   * activity and notifies producers parked on external events, where no
   * short write can signal reader loss. `null` means already fired.
   */
  #onDropped: (() => void)[] | null = [];

  /** Register `fn` for the drop notification (fires now if already dropped). */
  whenDropped(fn: () => void): void {
    if (this.#onDropped === null) {
      fn();
      return;
    }
    this.#onDropped.push(fn);
  }

  /** @internal — fire the drop observers (idempotent; never throws). */
  notifyDropped(): void {
    const fns = this.#onDropped;
    if (fns === null) return;
    this.#onDropped = null;
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // An observer bug must not derail the drop path; the observer's
        // own machinery is responsible for surfacing its failures.
      }
    }
  }

  constructor(readonly t: ValType | null) {}

  resetPending(): void {
    this.setPending(null, null, null, null);
  }

  setPending(
    inst: unknown,
    buffer: GuestBuffer | null,
    onCopy: OnCopy | null,
    onCopyDone: OnCopyDone | null,
  ): void {
    this.pendingInst = inst;
    this.pendingBuffer = buffer;
    this.pendingOnCopy = onCopy;
    this.pendingOnCopyDone = onCopyDone;
  }

  resetAndNotifyPending(result: CopyResult): void {
    const done = this.pendingOnCopyDone;
    assert_(done !== null, "reset_and_notify_pending with nothing pending");
    this.resetPending();
    done!(result);
  }

  cancel(): void {
    this.resetAndNotifyPending(CopyResult.CANCELLED);
  }

  drop(): void {
    if (!this.dropped) {
      this.dropped = true;
      if (this.pendingBuffer) this.resetAndNotifyPending(CopyResult.DROPPED);
      this.notifyDropped();
    }
  }

  /** definitions.py `SharedStreamImpl.read`. */
  read(
    inst: unknown,
    dstBuffer: GuestBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      this.setPending(inst, dstBuffer, onCopy, onCopyDone);
    } else {
      this.#assertSameElemType(dstBuffer);
      this.#trapOnSameInstance(inst);
      if (this.pendingBuffer.remain() > 0) {
        if (dstBuffer.remain() > 0) {
          const n = Math.min(dstBuffer.remain(), this.pendingBuffer.remain());
          const pendingIsDirect = isDirectBuffer(this.pendingBuffer);
          const out = rendezvousCopy(this.pendingBuffer, dstBuffer, n);
          if (out === "both-direct") {
            // The ARRIVING side (here the reader) is the one refused; the
            // parked session keeps the pending slot, undisturbed.
            (dstBuffer as unknown as DirectBuffer).failDirect(
              bothDirectError(),
            );
            return;
          }
          if (out === "retracted" || out === "failed") {
            this.#routeDirectNoCopy(
              out,
              pendingIsDirect,
              inst,
              dstBuffer,
              onCopy,
              onCopyDone,
            );
            return;
          }
          this.pendingOnCopy!(() => this.resetPending());
        }
        onCopyDone(CopyResult.COMPLETED);
      } else {
        // The parked writer had nothing left: retire it and park the reader.
        this.resetAndNotifyPending(CopyResult.COMPLETED);
        this.setPending(inst, dstBuffer, onCopy, onCopyDone);
      }
    }
  }

  /** definitions.py `SharedStreamImpl.write`. */
  write(
    inst: unknown,
    srcBuffer: GuestBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      this.setPending(inst, srcBuffer, onCopy, onCopyDone);
    } else {
      this.#assertSameElemType(srcBuffer);
      this.#trapOnSameInstance(inst);
      if (this.pendingBuffer.remain() > 0) {
        if (srcBuffer.remain() > 0) {
          const n = Math.min(srcBuffer.remain(), this.pendingBuffer.remain());
          const pendingIsDirect = isDirectBuffer(this.pendingBuffer);
          const out = rendezvousCopy(srcBuffer, this.pendingBuffer, n);
          if (out === "both-direct") {
            // The ARRIVING side (here the writer) is refused; the parked
            // session keeps the pending slot.
            (srcBuffer as unknown as DirectBuffer).failDirect(
              bothDirectError(),
            );
            return;
          }
          if (out === "retracted" || out === "failed") {
            this.#routeDirectNoCopy(
              out,
              pendingIsDirect,
              inst,
              srcBuffer,
              onCopy,
              onCopyDone,
            );
            return;
          }
          this.pendingOnCopy!(() => this.resetPending());
        }
        onCopyDone(CopyResult.COMPLETED);
      } else if (
        srcBuffer.isZeroLength() && this.pendingBuffer.isZeroLength()
      ) {
        // Two empty buffers complete the arriving write's handshake.
        // See the reference's test/async/zero-length.wast.
        onCopyDone(CopyResult.COMPLETED);
      } else {
        this.resetAndNotifyPending(CopyResult.COMPLETED);
        this.setPending(inst, srcBuffer, onCopy, onCopyDone);
      }
    }
  }

  /**
   * Retire a direct session without reporting a copy to its peer. Retraction
   * resolves the session with its total; failure has already rejected it.
   * If the session was pending, replace it with the arriving peer. Otherwise
   * leave the pending peer untouched. Neither path drops the stream or emits
   * a zero-progress completion to the peer's nonzero-capacity operation.
   */
  #routeDirectNoCopy(
    out: "retracted" | "failed",
    pendingIsDirect: boolean,
    inst: unknown,
    arriving: GuestBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    if (pendingIsDirect) {
      if (out === "retracted") this.resetAndNotifyPending(CopyResult.COMPLETED);
      else this.resetPending();
      this.setPending(inst, arriving, onCopy, onCopyDone);
      return;
    }
    if (out === "retracted") onCopyDone(CopyResult.COMPLETED);
  }

  #assertSameElemType(b: GuestBuffer): void {
    // Structural, not identity: definitions.py compares dataclass types with
    // `==`, and our `ValType`s are fresh objects per table (the plan's type
    // table is converted per instantiation), so identity would reject every
    // legitimate cross-instance stream.
    assert_(
      sameElemType(this.t, b.t) && sameElemType(b.t, this.pendingBuffer!.t),
      "stream element type mismatch between ends",
    );
  }

  /**
   * definitions.py marks this `# temporary`: a same-instance copy of a
   * non-number element type would need the source and destination lifts to
   * interleave, which the reference has not specified yet.
   */
  #trapOnSameInstance(inst: unknown): void {
    trapIf(
      inst === this.pendingInst && !noneOrNumberType(this.t),
      "cannot read from and write to intra-component stream",
    );
  }
}

/** definitions.py `SharedFutureImpl`. Exactly one element. */
export class SharedFutureImpl implements SharedBase {
  /**
   * Optional hook fired when this shared object is lowered into a component
   * instance (`lower_stream`/`lower_future`). Host-owned ends use it to learn
   * which `Store` is driving the guest they were just handed to; guest-owned
   * streams leave it unset. Keeps `cabi` free of any host-stream knowledge.
   */
  onLowered: ((inst: { store: unknown }) => void) | null = null;
  /**
   * Optional hook fired by `liftAsyncValue` whenever this object is lifted
   * OUT of a guest table. The receiver — the host, or the destination of a
   * guest-to-guest hop, in which case the immediately following lower fires
   * `onLowered` — may now act on the transferred end. Host wrappers use it to
   * re-arm their activity (#162, contracts/embedder-api.md §"Streams and futures"). Guest-owned
   * objects leave it unset.
   */
  onLifted: ((inst: { store: unknown }) => void) | null = null;
  /**
   * The `Store` driving the component this object has been handed to, set the
   * first time it is lifted or lowered. Host ends need it to pump the guest
   * between export calls (see exec/host_streams.ts `HostActivity.pump`); a
   * purely guest-to-guest stream never reads it.
   */
  boundStore: unknown = null;

  dropped = false;
  /**
   * The writer disappeared without delivering its value. Unlike the
   * reference's WritableFutureEnd.drop, host drop and poisoned-instance
   * teardown permit this state. Guest readers trap at read or event delivery
   * (`futureCopy`), never receive a value-less completion. Low-level host
   * readers receive DROPPED; the conventions layer turns it into an error.
   */
  abandonReason: Error | null = null;
  pendingInst: unknown = null;
  pendingBuffer: GuestBuffer | null = null;
  pendingOnCopyDone: OnCopyDone | null = null;

  /**
   * Fired once on either end's drop, including teardown. Releases host
   * activity even with no host operation parked. `null` means already fired.
   */
  #onDropped: (() => void)[] | null = [];

  /** Register `fn` for the drop notification (fires now if already dropped). */
  whenDropped(fn: () => void): void {
    if (this.#onDropped === null) {
      fn();
      return;
    }
    this.#onDropped.push(fn);
  }

  /** @internal — fire the drop observers (idempotent; never throws). */
  notifyDropped(): void {
    const fns = this.#onDropped;
    if (fns === null) return;
    this.#onDropped = null;
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // An observer bug must not derail the drop path; the observer's
        // own machinery is responsible for surfacing its failures.
      }
    }
  }

  constructor(readonly t: ValType | null) {}

  resetPending(): void {
    this.setPending(null, null, null);
  }

  setPending(
    inst: unknown,
    buffer: GuestBuffer | null,
    onCopyDone: OnCopyDone | null,
  ): void {
    this.pendingInst = inst;
    this.pendingBuffer = buffer;
    this.pendingOnCopyDone = onCopyDone;
  }

  resetAndNotifyPending(result: CopyResult): void {
    const done = this.pendingOnCopyDone;
    assert_(done !== null, "reset_and_notify_pending with nothing pending");
    this.resetPending();
    done!(result);
  }

  cancel(): void {
    this.resetAndNotifyPending(CopyResult.CANCELLED);
  }

  drop(): void {
    if (!this.dropped) {
      this.dropped = true;
      if (this.pendingBuffer) this.resetAndNotifyPending(CopyResult.DROPPED);
      this.notifyDropped();
    }
  }

  read(inst: unknown, dstBuffer: GuestBuffer, onCopyDone: OnCopyDone): void {
    // A reader arriving after abandonment gets the same trap as a parked one.
    if (this.dropped && this.abandonReason !== null) {
      throw futureAbandonTrap(this.abandonReason);
    }
    assert_(!this.dropped && dstBuffer.remain() === 1, "future read shape");
    if (!this.pendingBuffer) {
      this.setPending(inst, dstBuffer, onCopyDone);
    } else {
      trapIf(
        inst === this.pendingInst && !noneOrNumberType(this.t),
        "cannot read from and write to intra-component future",
      );
      dstBuffer.write(this.pendingBuffer.read(1));
      this.resetAndNotifyPending(CopyResult.COMPLETED);
      onCopyDone(CopyResult.COMPLETED);
    }
  }

  write(inst: unknown, srcBuffer: GuestBuffer, onCopyDone: OnCopyDone): void {
    assert_(srcBuffer.remain() === 1, "future write shape");
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      this.setPending(inst, srcBuffer, onCopyDone);
    } else {
      trapIf(
        inst === this.pendingInst && !noneOrNumberType(this.t),
        "cannot read from and write to intra-component future",
      );
      this.pendingBuffer.write(srcBuffer.read(1));
      this.resetAndNotifyPending(CopyResult.COMPLETED);
      onCopyDone(CopyResult.COMPLETED);
    }
  }
}

// ---------------------------------------------------------------------------
// Copy ends (definitions.py `CopyEnd`)
// ---------------------------------------------------------------------------

/**
 * One guest-visible end of a stream or future. It **is** a `Waitable`, so it
 * joins waitable sets and delivers events through the machinery the subtask
 * path already uses.
 */
export abstract class CopyEnd extends Waitable {
  state: CopyState = CopyState.IDLE;

  constructor(
    readonly shared: SharedBase,
    // Standalone ends inherit their shared descriptor; guest sites stamp locals.
    readonly elem: ValType | null = shared.t,
  ) {
    super();
  }

  /** "stream" | "future" — trap-wording parity with wasmtime. */
  abstract readonly kind: "stream" | "future";
  /**
   * Busy readable-end removal and writable-end drop use distinct trap text,
   * as required by the conformance corpus.
   */
  abstract readonly side: "readable" | "writable";

  copying(): boolean {
    return this.state === CopyState.COPYING ||
      this.state === CopyState.CANCELLING_COPY;
  }

  override drop(): void {
    trapIf(
      this.copying(),
      this.side === "readable"
        ? `cannot remove busy ${this.kind}`
        : `cannot drop busy ${this.kind}`,
    );
    this.shared.drop();
    super.drop();
  }
}

export class ReadableStreamEnd extends CopyEnd {
  override readonly kind = "stream";
  override readonly side = "readable";
  declare readonly shared: SharedStreamImpl;
  copy(
    inst: unknown,
    dst: GuestBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    this.shared.read(inst, dst, onCopy, onCopyDone);
  }
}

export class WritableStreamEnd extends CopyEnd {
  override readonly kind = "stream";
  override readonly side = "writable";
  declare readonly shared: SharedStreamImpl;
  copy(
    inst: unknown,
    src: GuestBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    this.shared.write(inst, src, onCopy, onCopyDone);
  }
}

export class ReadableFutureEnd extends CopyEnd {
  override readonly kind = "future";
  override readonly side = "readable";
  declare readonly shared: SharedFutureImpl;
  copy(inst: unknown, dst: GuestBuffer, onCopyDone: OnCopyDone): void {
    this.shared.read(inst, dst, onCopyDone);
  }
}

export class WritableFutureEnd extends CopyEnd {
  override readonly kind = "future";
  override readonly side = "writable";
  declare readonly shared: SharedFutureImpl;
  copy(inst: unknown, src: GuestBuffer, onCopyDone: OnCopyDone): void {
    this.shared.write(inst, src, onCopyDone);
  }

  /**
   * definitions.py `WritableFutureEnd.drop`: a future's writable
   * end may only be dropped once it has actually delivered its one value —
   * `test/async/futures-must-write.wast` is the case this exists for.
   */
  override drop(): void {
    trapIf(
      this.state !== CopyState.DONE,
      "cannot drop future write end without first writing a value",
    );
    super.drop();
  }
}

// ---------------------------------------------------------------------------
// Poisoned-instance retirement (#66)
// ---------------------------------------------------------------------------

/**
 * Failures recorded against shared stream/future objects whose peer end died
 * inside a trap-poisoned instance's handle table. The embedder layer consults
 * this to reject host operations loudly (contracts/embedder-api.md
 * §"Streams and futures") instead of letting them hang forever or fake a clean end-of-stream.
 */
const poisonFailures = new WeakMap<object, Error>();

/** The recorded poisoning failure for a shared stream/future value, if any. */
export function poisonFailureOf(shared: unknown): Error | undefined {
  return typeof shared === "object" && shared !== null
    ? poisonFailures.get(shared)
    : undefined;
}

/** Instances whose async ends have already been retired (idempotence). */
const retiredInstances = new WeakSet<object>();

// ---------------------------------------------------------------------------
// Abandoned futures (#84, #90)
// ---------------------------------------------------------------------------

/**
 * The trap a reader of an abandoned future observes at its rendezvous point.
 *
 * `Trap` is the guest-visible fault vocabulary (cabi/trap.ts); the recorded
 * reason rides as `cause` so the embedder/host layers can still attribute the
 * original fault. (`Trap`'s constructor takes only a message, so `cause` is
 * attached after construction rather than through `ErrorOptions`.)
 */
export function futureAbandonTrap(reason: Error): Trap {
  const t = new Trap(
    `future.read can never complete: ${reason.message}`,
  );
  (t as { cause?: unknown }).cause = reason;
  return t;
}

/** The abandonment reason of a shared future, if it has one (#84/#90). */
export function abandonReasonOf(shared: unknown): Error | null {
  return shared instanceof SharedFutureImpl ? shared.abandonReason : null;
}

/**
 * Mark a future's writable side as gone-without-a-value and settle the
 * rendezvous (#90's host `drop()` door; the poisoning walk below routes
 * through `dropSharedForTeardown` instead, which adds the dead-guest
 * discipline).
 *
 * Idempotent on an already-dropped future. Peer notification can throw;
 * drop observers still run through `dropSharedForTeardown`'s finally block.
 */
export function abandonSharedFuture(
  shared: SharedFutureImpl,
  reason: Error,
): void {
  if (shared.dropped) return;
  shared.abandonReason ??= reason;
  dropSharedForTeardown(shared);
}

/** The structural slice of `ComponentInstanceState` the walk needs. */
interface PoisonedInstanceLike {
  readonly index?: number;
  handles: Iterable<unknown>;
}

/**
 * Drop a shared stream/future as *teardown*, without waking a doomed guest.
 *
 * Notify host ends and healthy guest peers with DROPPED. Silently retract
 * only a parked end whose instance is already poisoned or retired; being
 * mid-call is not evidence of poisoning. The poison marker is set before
 * the retirement walk, and direct walks set `retiredInstances` on entry.
 * Drop observers run even if peer notification throws.
 *
 * This does not poison an instance itself. It is also used for abandoned
 * import arguments and failed handle removals. Idempotent.
 */
export function dropSharedForTeardown(
  shared: SharedStreamImpl | SharedFutureImpl,
): void {
  if (shared.dropped) return;
  shared.dropped = true;
  try {
    if (shared.pendingBuffer) {
      const pi = shared.pendingInst;
      const parkedInDeadGuest = typeof pi === "object" && pi !== null &&
        (isInstancePoisoned(pi) || retiredInstances.has(pi));
      if (parkedInDeadGuest) shared.resetPending();
      else shared.resetAndNotifyPending(CopyResult.DROPPED);
    }
  } finally {
    // Release producer/host retention even if the peer's notification throws.
    shared.notifyDropped();
  }
}

/**
 * Retire stream/future ends still in a poisoned instance's handle table.
 * Peers cannot rendezvous with that instance again. Record their failure
 * before notification, marking unwritten writable futures abandoned so
 * guest readers trap rather than observe an invalid value-less completion.
 *
 * Snapshot before invoking peer code; attempt every retirement and rethrow
 * the first notification failure afterwards. Idempotent per instance. This
 * is async-end retirement, not general resource or host-operation cleanup;
 * ends already transferred out are no longer in this table.
 */
export function retireInstanceAsyncEnds(
  inst: PoisonedInstanceLike,
  cause: unknown,
): void {
  if (retiredInstances.has(inst)) return;
  retiredInstances.add(inst);
  // Snapshot: the notifications below can run peer code that mutates tables.
  const ends: CopyEnd[] = [];
  for (const e of inst.handles) if (e instanceof CopyEnd) ends.push(e);
  retireAsyncEnds(inst, ends, cause);
}

function retireAsyncEnds(
  inst: PoisonedInstanceLike,
  ends: CopyEnd[],
  cause: unknown,
): void {
  const where = inst.index !== undefined
    ? `component instance ${inst.index}`
    : "a component instance";

  // Pass 1: record the failure, and mark abandoned every future this table
  // owes a value on. Done before ANY notification, so the reader-side trap
  // decision cannot depend on the order the handle table happens to yield
  // the two ends of one future in.
  for (const e of ends) {
    const shared = e.shared as SharedStreamImpl | SharedFutureImpl;
    if (poisonFailures.get(shared) === undefined) {
      poisonFailures.set(
        shared,
        new Error(
          `${where} trapped while it held an end of this stream/future; ` +
            `the peer can never rendezvous again`,
          { cause },
        ),
      );
    }
    if (
      e instanceof WritableFutureEnd && shared instanceof SharedFutureImpl &&
      e.state !== CopyState.DONE && !shared.dropped
    ) {
      shared.abandonReason ??= poisonFailures.get(shared)!;
    }
  }

  // Pass 2: retire. Collect failures rather than abandoning the walk.
  let first: unknown;
  let failed = false;
  for (const e of ends) {
    try {
      dropSharedForTeardown(e.shared as SharedStreamImpl | SharedFutureImpl);
    } catch (err) {
      if (!failed) {
        failed = true;
        first = err;
      }
    }
  }
  if (failed) throw first;
}

// `Store.tick`'s poisoning site reaches the walk through this seam (its
// module cannot import ours — see `setOnInstancePoisoned`); the sync-lift
// site (exec/boundary.ts `poison`) imports it directly.
setOnInstancePoisoned(retireInstanceAsyncEnds, (inst, entry, cause) => {
  if (!(entry instanceof CopyEnd)) return;
  const shared = entry.shared as SharedStreamImpl | SharedFutureImpl;
  // The removed end is unreachable even before boundary poisoning. Retract
  // its buffer silently without marking the whole instance dead or retired.
  if (shared.pendingInst === inst) shared.resetPending();
  retireAsyncEnds(inst, [entry], cause);
});

// ---------------------------------------------------------------------------
// error-context (definitions.py `ErrorContext`)
// ---------------------------------------------------------------------------

/**
 * The decoded debug message. Encoding is chosen when the message is lowered.
 */
export class ErrorContext {
  constructor(readonly debugMessage: string) {}
}
// Both internal and facade forms are recognizable. Cross-copy reconstruction
// requires the facade's public string `message`; this internal shape has only
// `debugMessage` and is not a portable carrier (embedder/values.ts).
defineBrand(ErrorContext.prototype, ERROR_CONTEXT);
