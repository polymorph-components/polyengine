// Streams, futures and error-context: the async *value* types
// (definitions.py `### Stream State`, `### Future State`, `class ErrorContext`).
//
// ===========================================================================
// THE RENDEZVOUS, AND HOW IT MAPS ONTO OUR TASK CORE
// ===========================================================================
//
// A stream is not a buffer. `SharedStreamImpl` (definitions.py line 997) holds
// at most **one pending side** — a reader waiting for data, or a writer
// waiting for a reader — and a copy happens only when the second side arrives.
// That is the whole model:
//
//   * first side to call `read`/`write` finds `pending_buffer == None` and
//     parks itself via `set_pending(...)`;
//   * second side finds a pending buffer, copies `min(remain, remain)`
//     elements directly between the two guests' linear memories, and notifies
//     *both* sides;
//   * either side may be partially satisfied — that is not an error, it is the
//     normal case, and the progress count is what the guest is told.
//
// Nothing here needs a scheduler: the copy is synchronous inside whichever
// call arrives second. What the scheduler provides is the *waiting*: a parked
// side has `CopyState.COPYING` and its `CopyEnd` (a `Waitable`) carries the
// pending event that wakes the guest.
//
// So the mapping to our task core is small and mechanical:
//
//   reference                    here
//   ------------------------------------------------------------------
//   CopyEnd(Waitable)            CopyEnd extends our Waitable — the same
//                                base the SUBTASK path already uses, so
//                                waitable sets, `waitable.join` and the
//                                callback loop's WAIT code all work unchanged
//   set_pending_event(thunk)     the same thunk indirection: the event payload
//                                (progress, result) is computed at *delivery*
//                                time, exactly as `Subtask.setSubtaskPendingEvent`
//                                already does. This is why the phase-1 decision
//                                to keep events as thunks rather than values
//                                pays off here with no generalization at all.
//   STREAM_READ / STREAM_WRITE   EventCode values, already defined
//   FUTURE_READ / FUTURE_WRITE
//
// The one genuinely new thing is `Buffer`: a cursor over a guest's linear
// memory that can be *partially* consumed, which is what makes partial copies
// expressible.

import { defineBrand, ERROR_CONTEXT } from "@polyengine/protocol";
import { assert_, Trap, trapIf } from "../cabi/trap.ts";
import { LiftLowerContext } from "../cabi/context.ts";
import { bytesOf } from "../cabi/memory.ts";
import { loadListFromValidRange } from "../cabi/load.ts";
import { storeListIntoValidRange } from "../cabi/store.ts";
import { alignment, alignTo, elemSize } from "../cabi/layout.ts";
import { despecialize, valTypeEqual } from "../cabi/types.ts";
import type { ComponentValue, ValType } from "../cabi/types.ts";
import { Waitable } from "./waitable.ts";
import { isInstancePoisoned, setOnInstancePoisoned } from "./scheduler.ts";

/** Structural element-type equality (`null` = the zero-width payload).
 * Delegates to `valTypeEqual`: naive `JSON.stringify` comparison throws on
 * resource-bearing element types (cabi/types.ts `valTypeEqual` contract
 * note; found by the #18 polymorph-tls smoke). */
export function sameElemType(a: ValType | null, b: ValType | null): boolean {
  if (a === null || b === null) return a === b;
  return valTypeEqual(a, b);
}

/** definitions.py `Buffer.MAX_LENGTH`. */
export const BUFFER_MAX_LENGTH = 2 ** 28 - 1;

/**
 * One rendezvous chunk. u8 payloads travel as `Uint8Array` — the lift out of
 * guest memory and the conventions layer's lowering both produce typed
 * chunks, and every buffer in the copy path keeps them whole (issue #54: the
 * typed shape is what makes both the guest-memory store and a host→host
 * hand-off bulk). Every other element type travels as a plain array.
 */
export type PayloadChunk = ComponentValue[] | Uint8Array;

/** definitions.py `CopyResult` (line 977). */
export enum CopyResult {
  COMPLETED = 0,
  DROPPED = 1,
  CANCELLED = 2,
}

/** definitions.py `CopyState` (line 1075). */
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
// Buffers (definitions.py `class BufferGuestImpl`, line 930)
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

  // --- A21 direct-access byte edges (embedder-api amendment A21, #128) ---
  //
  // `ByteWindow`, implemented for the `stream<u8>` case only. The two methods
  // together are the copy `read`/`write` would have done, split so that the
  // *peer's* callback performs it: `byteView` hands out the range, and
  // `advanceBytes` records the bytes that actually moved. They are role-blind
  // (destination or source) because `this.ptr` already advances on BOTH
  // `read` and `write` above, and `elemSize(u8) === 1`.

  /**
   * A fresh view over the next `n` bytes of this buffer's remaining range.
   *
   * Fresh on every call, via `bytesOf` (cabi/memory.ts:195) over the
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
// The direct-access seam (embedder-api amendment A21, 2026-08-22, #128)
// ---------------------------------------------------------------------------
//
// A21 lets ONE side of a rendezvous be a *direct session*: instead of handing
// the rendezvous a buffer to copy out of / into, the host parks a callback
// that runs synchronously inside the rendezvous and performs the canonical
// copy itself, against a scoped view of the peer's memory.
//
// The seam below is the whole of it inside this file. It exists so that the
// rendezvous keeps mirroring definitions.py `SharedStreamImpl.read`/`.write`
// (lines 1032/1050) line for line for every non-direct path: when neither
// side is direct, `rendezvousCopy` IS `dst.write(src.read(n))`, unchanged.
//
// Nothing here imports from `exec/`: a direct session is recognised
// structurally (`direct === true`) and driven through two small optional
// protocols — `DirectBuffer` (the session) and `ByteWindow` (the peer).

/**
 * The buffer surface the rendezvous actually uses (definitions.py `Buffer`,
 * line 918). `GuestBuffer` and the host layer's `HostBuffer` both satisfy it.
 */
export interface RendezvousBuffer {
  remain(): number;
  isZeroLength(): boolean;
  read(n: number): PayloadChunk;
  write(vs: PayloadChunk): void;
}

/**
 * A21: the peer half of a direct rendezvous — a buffer that can expose its
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
 * A21: the parked direct session, as the rendezvous sees it. It presents the
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
 * Collapses to definitions.py's `dst_buffer.write(src_buffer.read(n))`
 * whenever neither side is a direct session — which is every guest↔guest,
 * guest↔host-chunk and host-chunk↔host-chunk rendezvous, i.e. everything
 * that existed before A21.
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

/** The A21 rejection for a rendezvous of two direct sessions. */
function bothDirectError(): TypeError {
  return new TypeError(
    "at least one side of a host-to-host rendezvous must use the chunk " +
      "forms: two direct-access sessions cannot rendezvous with each other " +
      "because neither side owns the memory the other would write into " +
      "(embedder-api amendment A21, polyengine#128)",
  );
}

/**
 * definitions.py `none_or_number_type` (line 1070). Guards the "temporary"
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
// The shared stream (definitions.py `class SharedStreamImpl`, line 997)
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
   * re-arm their activity (#162, embedder-api amendment A15). Guest-owned
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
   * Observers fired once, when this stream becomes dropped — by EITHER
   * side, including the A7 teardown walk (`dropSharedForTeardown`). The
   * embedder's producer pump uses this to cancel a producer parked on an
   * external event (amendment A13's cancellation companion: an
   * accept-shaped producer holds a live platform resource while parked,
   * and the reader dropping is its only stop signal). `null` = already
   * fired.
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

  /** definitions.py `SharedStreamImpl.read` (line 1032). */
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
          // A21 seam (#128). `"chunk"` is the reference line verbatim.
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

  /** definitions.py `SharedStreamImpl.write` (line 1050). */
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
          // A21 seam (#128). `"chunk"` is the reference line verbatim.
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
        // Zero-length rendezvous: both sides are empty, which is a *completed*
        // handshake rather than a parked write (definitions.py line 1064 —
        // the case `test/async/zero-length.wast` exists to pin).
        onCopyDone(CopyResult.COMPLETED);
      } else {
        this.resetAndNotifyPending(CopyResult.COMPLETED);
        this.setPending(inst, srcBuffer, onCopy, onCopyDone);
      }
    }
  }

  /**
   * A21 (#128): route a rendezvous whose direct session did NOT copy.
   *
   * Two outcomes land here, and both share one invariant: the peer's parked
   * operation survives, no event is delivered, and the stream is not dropped
   * — a runtime never emits a zero-progress COMPLETED copy, which is
   * unreachable in definitions.py for a nonzero-capacity operation.
   *
   *  * `"retracted"` — `"done"` with zero marked. The session ends and
   *    resolves with its running total, through the ordinary
   *    `on_copy_done(COMPLETED)` channel.
   *  * `"failed"` — misuse or a throwing callback. The session has ALREADY
   *    rejected (`DirectSession.#fail`), so it must be retired silently:
   *    its rejection is its notification.
   *
   * Which side was the session decides where each goes, and both shapes are
   * states definitions.py already produces:
   *
   *  * PARKED session ⇒ the "the parked side had nothing left" branch
   *    (definitions.py:1043/1063): retire it and park the arriving
   *    operation, which gets no event either way.
   *  * ARRIVING session ⇒ the "arriving buffer of zero capacity" state
   *    (definitions.py:1041/1057): the pending side is left untouched with
   *    its `on_copy` unfired, and the arriving side completes.
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

/** definitions.py `class SharedFutureImpl` (line 1119). Exactly one element. */
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
   * re-arm their activity (#162, embedder-api amendment A15). Guest-owned
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
   * Set when the future's **writable** side went away without ever delivering
   * its one value (#84 teardown of a trap-poisoned instance, #90 host
   * `drop()` on a lowered-but-unwritten future).
   *
   * definitions.py keeps this state unreachable: `WritableFutureEnd.drop`
   * traps unless the end is DONE (definitions.py:1183-1184), so a readable
   * future end can never observe DROPPED (`future_copy`'s `on_copy_done`
   * assertion, definitions.py:2607). Our two teardown paths deliberately
   * bypass that trap — a poisoned instance cannot be asked to trap again, and
   * the host `drop()` is a public API door — so the state exists here and has
   * to be *total*: an unwritten future whose writer died can never satisfy
   * its reader, so the reader is told at its rendezvous point, with a
   * **trap**, never a DROPPED/COMPLETED answer and never a silent hang.
   *
   * Consumers of the flag:
   *   * `read` below, for a reader that has not parked yet (trap on the spot);
   *   * intrinsics/stream_builtins.ts `futureCopy`, for a parked guest reader
   *     (the pending event's thunk throws instead of producing a tuple);
   *   * exec/host_streams.ts leaves host readers on their existing DROPPED
   *     path — the conventions layer already brands that outcome.
   */
  abandonReason: Error | null = null;
  pendingInst: unknown = null;
  pendingBuffer: GuestBuffer | null = null;
  pendingOnCopyDone: OnCopyDone | null = null;

  /**
   * Observers fired once, when this future becomes dropped — by EITHER side,
   * including the A7 teardown walk (`dropSharedForTeardown`). Streams grew
   * this for A13 producer cancellation; futures need it as the release hook
   * for a host wrapper's activity arm (#162, amendment A15): a guest dropping
   * its end with no host operation parked, and the `readResult()`
   * already-dropped fast path, both bypass every other close site. `null` =
   * already fired.
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
    // #84 leg (c): the reader arrives AFTER the writable side was abandoned.
    // definitions.py:1154 (SharedFutureImpl.read) asserts `not self.dropped`
    // here because the drop
    // trap keeps that unreachable; for our abandoned state the honest answer
    // is the same trap the parked reader gets, delivered synchronously.
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
// Copy ends (definitions.py `class CopyEnd`, line 1081)
// ---------------------------------------------------------------------------

/**
 * One guest-visible end of a stream or future. It **is** a `Waitable`, so it
 * joins waitable sets and delivers events through the machinery the subtask
 * path already uses.
 */
export abstract class CopyEnd extends Waitable {
  state: CopyState = CopyState.IDLE;

  constructor(readonly shared: SharedBase) {
    super();
  }

  /** "stream" | "future" — trap-wording parity with wasmtime. */
  abstract readonly kind: "stream" | "future";
  /**
   * Which end this is. Wasmtime words a busy READABLE-end drop as a table
   * removal ("cannot remove busy stream") and a busy WRITABLE-end drop as a
   * drop ("cannot drop busy stream") — the suite pins both spellings side by
   * side (drop-stream.wast:158 read end vs :160 / builtin-trap-poisons-
   * instance.wast:38 write end).
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
   * definitions.py `WritableFutureEnd.drop` (line 1183): a future's writable
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
 * this to reject host operations loudly (contracts/embedder-api.md amendment
 * A7) instead of letting them hang forever or fake a clean end-of-stream.
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
 * Never throws, and idempotent: a second call on an already-dropped future is
 * a no-op, so `drop()`/`Symbol.dispose` at the layers above are total.
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
 * Same outcome as `drop()` for host ends and healthy guest peers (a DROPPED
 * notification), with one difference: a parked side belonging to a
 * **poisoned** guest instance is retired silently via `resetPending`.
 * Notifying it would queue a phantom event into the corpse's waitables, and
 * a later driving loop servicing it would resume machinery whose instance
 * can no longer be entered (`tick` asserts enterability). Host sentinels are
 * not instances at all, so they are always notified.
 *
 * #100: THE HEALTH TEST IS "POISONED", NOT "`mayEnter === false`". The
 * original test used non-enterability as a proxy for deadness. The proxy is
 * unsound in one direction, and the unsoundness stranded healthy tasks:
 *
 *  * (sound half, #84 audit) a healthy guest peer always parks with
 *    `mayEnter === true`. Every park — the callback ABI's waitable-set wait,
 *    and equally a sync-lowered/JSPI peer blocked inside `finishCopy`'s
 *    SITE 4 via `blockCurrentActivation` — yields the thread out of the
 *    scheduler's enter/leave bracket, and the bracket's `leaveTo` runs on the
 *    way out (task/scheduler.ts `Store.tick` :905-917, task/thread.ts
 *    `Thread.resumeWith` :157-179, whose resume-side
 *    `assert_(mayEnterFrom(null))` would fire otherwise). Blocking inside a
 *    wasm frame does NOT hold the enter bracket.
 *  * (unsound converse) `mayEnter === false` does not imply "poisoned". An
 *    instance that is merely mid-call is also non-enterable, and a CALLER
 *    instance stays non-enterable for the whole duration of a
 *    cross-component (FACT) call into an instance that traps
 *    (`ComponentInstanceState.enterFrom` clears `mayEnter` on the callee's
 *    entering set only, task/mod.ts). A *different*, healthy task of that
 *    caller, parked on an end of a stream/future the trapping callee also
 *    held, was classified dead here and retired silently — stranded, the
 *    exact outcome #66 exists to prevent.
 *
 * So the test consults the poison marker itself. It is per-instance and
 * recorded at the single seam every bracket-break site routes through
 * (`notifyInstancePoisoned`, task/scheduler.ts: exec/boundary.ts `poison`,
 * `Store.tick`, `Thread.resumeWith`, the FACT cross-component catches in
 * intrinsics/fact_calls.ts, and cabi/handles.ts's gated destructor call),
 * and it is recorded *before* the retirement walk runs, so an instance's own
 * parked ends still see it during its own walk. `retiredInstances` is
 * consulted alongside it because the walk is also reachable directly (it is
 * set at walk entry, so the two agree); neither ever contains the synthetic
 * per-instantiation root, which every poison site skips or releases (plan v3
 * amendment 4, `releaseSyntheticRootOnPoison`).
 *
 * Why this does not re-open review B2 (phantom events into a corpse): the
 * concern is that a DROPPED event queued onto a waitable of an instance that
 * can never be entered again would be serviced by a later driving loop and
 * resume machinery whose `tick` asserts enterability. "Can never be entered
 * again" is precisely poisoning — a mid-call instance's `mayEnter` is
 * restored by its own `leaveTo` when the call returns, and its parked task
 * then resumes normally and consumes the event. The narrowed predicate
 * therefore excludes exactly the population B2 is about, and admits only
 * peers that will run again.
 *
 * Used by the poisoning walk below and by the trapping-import abandonment
 * path (embedder/instantiate.ts `releaseAsyncArgs`). Idempotent.
 */
export function dropSharedForTeardown(
  shared: SharedStreamImpl | SharedFutureImpl,
): void {
  if (shared.dropped) return;
  shared.dropped = true;
  if (shared.pendingBuffer) {
    const pi = shared.pendingInst;
    const parkedInDeadGuest = typeof pi === "object" && pi !== null &&
      (isInstancePoisoned(pi) || retiredInstances.has(pi));
    if (parkedInDeadGuest) shared.resetPending();
    else shared.resetAndNotifyPending(CopyResult.DROPPED);
  }
  // The drop observers also fire on the teardown path: a stream producer
  // parked behind a trap-poisoned reader must be cancelled the same as behind
  // a cleanly-dropped one (A13), and a host wrapper's activity arm must be
  // released the same way (#162, amendment A15). Both classes carry the
  // observer machinery, so this is unconditional.
  shared.notifyDropped();
}

/**
 * Retire every live stream/future end in a trap-poisoned instance's handle
 * table (#66).
 *
 * Rationale: after a trap breaks the enter/leave bracket, `mayEnter` stays
 * false forever, so no task of this instance can ever rendezvous again. Its
 * table's `CopyEnd`s are therefore unreachable-forever — leaving their shared
 * objects live strands the peers: a parked HOST operation never settles (its
 * promise hangs), and a LATER host operation would "succeed" against the
 * corpse (a copy into memory nothing will ever read — silent data loss).
 * Dropping the shared object now converts both into the spec-shaped DROPPED
 * outcome, and the recorded failure lets the embedder layer brand it.
 *
 * Called from every bracket-break site — exec/boundary.ts `poison()` (the
 * sync-lift path), scheduler.ts `Store.tick` and thread.ts
 * `Thread.resumeWith` (traps during a resumed thread), and the FACT
 * cross-component catches (intrinsics/fact_calls.ts, callee side) — with the
 * trap as `cause`. Idempotent per instance. The parked-side notification
 * discipline lives in `dropSharedForTeardown` above.
 *
 * Two refinements over the original #66 walk, both from #84:
 *
 *  1. FUTURES ARE NOT STREAMS. A `stream`'s reader may legitimately observe
 *     DROPPED (that is end-of-stream), but a `future`'s reader may not
 *     (definitions.py:2607) — the reference keeps the state unreachable by
 *     trapping an early writable-end drop (definitions.py:1183-1184), which
 *     a poisoned instance can no longer be made to do. So an unwritten
 *     writable future end in this table marks its shared object *abandoned*
 *     (first pass below) and its reader traps instead. A writable end that
 *     already reached `CopyState.DONE` delivered its value; nothing is owed.
 *
 *  2. ONE END'S FAILURE MUST NOT STRAND THE REST. The notification of a
 *     retired end runs arbitrary peer callbacks (host settlers, event
 *     thunks); a throw used to abort the loop mid-table, leaving the
 *     remaining ends live and their peers hanging — exactly the outcome this
 *     walk exists to prevent. The walk now always completes and rethrows the
 *     first failure afterwards.
 */
export function retireInstanceAsyncEnds(
  inst: PoisonedInstanceLike,
  cause: unknown,
): void {
  if (retiredInstances.has(inst)) return;
  retiredInstances.add(inst);
  const where = inst.index !== undefined
    ? `component instance ${inst.index}`
    : "a component instance";
  // Snapshot: the notifications below can run peer code that mutates tables.
  const ends: CopyEnd[] = [];
  for (const e of inst.handles) if (e instanceof CopyEnd) ends.push(e);

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

// `Store.tick`'s bracket-break site reaches the walk through this seam (its
// module cannot import ours — see `setOnInstancePoisoned`); the sync-lift
// site (exec/boundary.ts `poison`) imports it directly.
setOnInstancePoisoned(retireInstanceAsyncEnds);

// ---------------------------------------------------------------------------
// error-context (definitions.py `class ErrorContext`, line 2775)
// ---------------------------------------------------------------------------

/**
 * definitions.py models the debug message as a `String` triple; we keep the
 * decoded JS string plus its encoding, which is all `store_string` needs.
 */
export class ErrorContext {
  constructor(readonly debugMessage: string) {}
}
// A9 brand (contracts/embedder-api.md §"Module identity"): error-contexts are
// STATEFUL — they live in a component instance's handle table — so the brand
// exists to make a foreign one diagnosable at the lowering sites, never
// usable. Both this internal class and the embedder-facing wrapper
// (embedder/streams.ts) carry it, because either shape can be handed back to
// a lowering site by embedder code.
defineBrand(ErrorContext.prototype, ERROR_CONTEXT);
