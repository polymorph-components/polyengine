// Lift and lower for the async value types: `stream`, `future` and
// `error-context` (definitions.py `lift_async_value` line 1530,
// `lower_stream`/`lower_future` line 1828, `lift_error_context` line 1451,
// `lower_error_context` line 1757).
//
// ===========================================================================
// HOST SHAPE (interpreter decision — flagged, per contracts/descriptor-ir.md)
// ===========================================================================
//
// Every other `ComponentValue` in this interpreter is plain data: numbers,
// strings, arrays, records. The async value types cannot be, and the reference
// is explicit about why: `lift_async_value` returns `e.shared` — the *shared*
// stream/future object, not a copy and not an index — and `lower_stream` wraps
// that same object in a fresh `ReadableStreamEnd` in the destination
// instance's handle table. The identity of the shared object is the value; two
// components holding ends of one stream must observe each other's copies.
//
// So a lifted `stream`/`future` is a `SharedStreamImpl`/`SharedFutureImpl`
// instance, and a lifted `error-context` is an `ErrorContext` instance. Host
// code that receives one should treat it as an opaque token. This is the same
// concession the reference makes; it is recorded here because it widens what
// `ComponentValue` can hold beyond plain data, which the descriptor-IR
// contract's "host-shaped component values" wording did not anticipate.

import { copyCensus, ERROR_CONTEXT, hasBrand } from "@polyengine/protocol";
import { assert_, trapIf } from "./trap.ts";
import type { LiftLowerContext } from "./context.ts";
import type { BorrowType, OwnType, ValType } from "./types.ts";
import { contains, fmtValType } from "./types.ts";
import {
  CopyState,
  ErrorContext,
  ReadableFutureEnd,
  ReadableStreamEnd,
  type SharedBase,
  SharedFutureImpl,
  sameElemType,
  SharedStreamImpl,
} from "../task/streams.ts";

/**
 * Diagnostic for a handle-table entry that carries the error-context brand
 * without being one of THIS copy's `ErrorContext`s (contracts/embedder-api.md
 * §"Module identity").
 *
 * A backstop, deliberately: the embedder's lowering site (embedder/values.ts)
 * refuses a foreign error-context before it can ever reach a handle table, so
 * this branch should be unreachable. It exists because "handle is not an
 * error-context" is precisely the misleading generic that made #83 expensive
 * to diagnose — if a path ever does get here, it says what happened.
 *
 * This layer is below `embedder/`, so it composes the census from
 * `@polyengine/protocol` directly rather than importing `embedder/copy.ts`.
 */
export function errorContextTrapMessage(where: string, e: unknown): string {
  if (!hasBrand(e, ERROR_CONTEXT)) {
    return `${where}: handle is not an error-context`;
  }
  const census = copyCensus();
  return `${where}: this error-context was minted by a DIFFERENT polyengine ` +
    `runtime copy and cannot be used through this one` +
    `${census === "" ? "" : ` (${census})`} ` +
    `(contracts/embedder-api.md §"Module identity")`;
}

/** definitions.py `contains_borrow` — async values may never carry borrows. */
function containsBorrow(t: ValType): boolean {
  return contains(t, (x) => x.kind === "borrow");
}

/**
 * definitions.py `lift_async_value` (line 1530).
 *
 * Lifting **removes** the handle: the readable end is transferred out of this
 * instance's table, which is why a stream can only be passed on once.
 */
function liftAsyncValue(
  cx: LiftLowerContext,
  i: number,
  t: ValType,
  // deno-lint-ignore no-explicit-any
  EndT: any,
  elem: ValType | null,
  what: string,
): SharedBase {
  assert_(!containsBorrow(t), `${what} may not contain a borrow`);
  const inst = cx.inst;
  assert_(inst !== null, `${what} lift requires a component instance`);
  const e = inst!.handles.remove(i);
  trapIf(!(e instanceof EndT), `${what} lift: handle is not a ${what} end`);
  const end = e as { shared: SharedBase; state: CopyState; inWaitableSet(): boolean };
  trapIf(!sameElemType(end.shared.t, elem), `${what} lift: element type mismatch`);
  trapIf(
    end.state === CopyState.DONE,
    what === "future"
      ? "cannot lift future after previous read succeeded"
      : "cannot lift stream after being notified that the writable end dropped",
  );
  trapIf(end.state !== CopyState.IDLE, `cannot remove busy ${what}`);
  trapIf(
    end.inWaitableSet(),
    `cannot lift ${what} while it's in a waitable set`,
  );
  // Remember the driving store so a host wrapper can pump the guest later.
  // Single-store only: a shared object crossing into a SECOND store is
  // unsupported misuse — fail loudly rather than silently pumping the first
  // (review advisory, host-streams round). Class field initializes to null;
  // != null covers both sentinels.
  const holder = end.shared as { boundStore?: unknown };
  const store = (inst as unknown as { store?: unknown }).store;
  if (holder.boundStore != null && store != null) {
    // module identity: when several runtime copies are loaded, "a second store" is very
    // often "a second COPY" — the shared object was minted by one runtime and
    // is being driven by another. The two stores are indistinguishable from
    // here (stores carry no copy identity), so the census is appended as the
    // hypothesis it is, rather than asserted (issue #83).
    const census = copyCensus();
    assert_(
      holder.boundStore === store,
      `${what} crossed into a second store; multi-store is unsupported` +
        (census === ""
          ? ""
          : ` (${census} — a value from one copy cannot be lowered through ` +
            `another)`),
    );
  }
  holder.boundStore ??= store;
  // Host-wrapper re-arm hook (#162, contracts/embedder-api.md §"Streams and futures"): the readable
  // end just left a guest table, so whoever receives it can act on it again.
  // See `bindOnLower` in exec/host_streams.ts for the retention rule.
  (end.shared as { onLifted?: ((i: unknown) => void) | null }).onLifted?.(inst);
  return end.shared;
}

export function liftStream(
  cx: LiftLowerContext,
  i: number,
  t: ValType & { kind: "stream"; element: ValType | null },
): SharedBase {
  return liftAsyncValue(cx, i, t, ReadableStreamEnd, t.element, "stream");
}

export function liftFuture(
  cx: LiftLowerContext,
  i: number,
  t: ValType & { kind: "future"; element: ValType | null },
): SharedBase {
  return liftAsyncValue(cx, i, t, ReadableFutureEnd, t.element, "future");
}

/** definitions.py `lower_stream` (line 1828). */
export function lowerStream(
  cx: LiftLowerContext,
  v: SharedBase,
  t: ValType,
): number {
  assert_(
    v instanceof SharedStreamImpl,
    "lower_stream expects a shared stream value",
  );
  assert_(!containsBorrow(t), "stream may not contain a borrow");
  // Loud element-type check. A host-created stream carries a hand-passed
  // `ValType` (typed derivation is bindgen's job), so this is the first point
  // at which a mismatch against the guest's declared `stream<T>` can be
  // caught — and a silent mismatch would corrupt every copy, since the
  // element type is what sizes and lifts the buffer. `fmtValType`, not
  // `JSON.stringify`: the latter throws on resource-bearing element types
  // (cabi/types.ts `valTypeEqual` contract note) — and as a template-literal
  // argument it was evaluated even when the assertion PASSED.
  const declared = (t as { element?: ValType | null }).element ?? null;
  if (!sameElemType(v.t, declared)) {
    assert_(
      false,
      `stream element type mismatch: host end carries ` +
        `${fmtValType(v.t)}, callee expects ${fmtValType(declared)}`,
    );
  }
  const inst = cx.inst;
  assert_(inst !== null, "stream lower requires a component instance");
  (v as { boundStore?: unknown }).boundStore ??=
    (inst as unknown as { store?: unknown }).store;
  (v as { onLowered?: ((i: unknown) => void) | null }).onLowered?.(inst);
  return inst!.handles.add(new ReadableStreamEnd(v));
}

/** definitions.py `lower_future` (line 1833). */
export function lowerFuture(
  cx: LiftLowerContext,
  v: SharedBase,
  t: ValType,
): number {
  assert_(
    v instanceof SharedFutureImpl,
    "lower_future expects a shared future value",
  );
  assert_(!containsBorrow(t), "future may not contain a borrow");
  const declared = (t as { element?: ValType | null }).element ?? null;
  if (!sameElemType(v.t, declared)) {
    assert_(
      false,
      `future element type mismatch: host end carries ` +
        `${fmtValType(v.t)}, callee expects ${fmtValType(declared)}`,
    );
  }
  const inst = cx.inst;
  assert_(inst !== null, "future lower requires a component instance");
  (v as { boundStore?: unknown }).boundStore ??=
    (inst as unknown as { store?: unknown }).store;
  (v as { onLowered?: ((i: unknown) => void) | null }).onLowered?.(inst);
  return inst!.handles.add(new ReadableFutureEnd(v));
}

/** definitions.py `lift_error_context` (line 1451). Does NOT remove the handle. */
export function liftErrorContext(
  cx: LiftLowerContext,
  i: number,
): ErrorContext {
  const inst = cx.inst;
  assert_(inst !== null, "error-context lift requires a component instance");
  const e = inst!.handles.get(i);
  trapIf(
    !(e instanceof ErrorContext),
    errorContextTrapMessage("error-context lift", e),
  );
  return e as ErrorContext;
}

/** definitions.py `lower_error_context` (line 1757). */
export function lowerErrorContext(
  cx: LiftLowerContext,
  v: ErrorContext,
): number {
  const inst = cx.inst;
  assert_(inst !== null, "error-context lower requires a component instance");
  return inst!.handles.add(v);
}

/** Unused-import guards for the type-only imports above. */
export type _AsyncValueTypes = OwnType | BorrowType;
