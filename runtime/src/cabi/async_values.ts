// Lift and lower for the async value types: `stream`, `future` and
// `error-context` (definitions.py `lift_async_value`, `lower_stream`,
// `lower_future`, `lift_error_context`, `lower_error_context`).
//
// Raw values are shared object identities, not copies or handle indices:
// SharedStreamImpl, SharedFutureImpl, and ErrorContext. Lowering a stream or
// future wraps that identity in a fresh readable end in the destination table.
// The public embedder layer supplies facades over these internal tokens.

import { copyCensus, ERROR_CONTEXT, hasBrand } from "@polyengine/protocol";
import { assert_, trapIf } from "./trap.ts";
import type { LiftLowerContext } from "./context.ts";
import type { ValType } from "./types.ts";
import { contains, fmtValType, valTypeEqual } from "./types.ts";
import {
  CopyState,
  ErrorContext,
  ReadableFutureEnd,
  ReadableStreamEnd,
  sameElemType,
  type SharedBase,
  SharedFutureImpl,
  SharedStreamImpl,
} from "../task/streams.ts";
import { removeHandleWithUnwind } from "../task/scheduler.ts";

/**
 * Diagnostic for a handle-table entry that carries the error-context brand
 * without being one of THIS copy's `ErrorContext`s (contracts/embedder-api.md
 * §"Module identity").
 *
 * The embedder lowering site also checks identity; this backstop gives raw
 * paths the same specific diagnostic rather than a generic handle error.
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
 * Host support policy for shared async values. The reference permits identity
 * transfer (definitions.py:1802-1810); polyengine refuses stores it cannot yet
 * coordinate, before any ownership or destination-table mutation.
 */
export function assertAsyncValueDestinationStore(
  shared: { boundStore?: unknown },
  destinationStore: unknown,
  what: "stream" | "future",
): void {
  const sourceStore = shared.boundStore;
  if (
    sourceStore == null || destinationStore == null ||
    sourceStore === destinationStore
  ) return;
  const adapter = what === "stream" ? ".readable()" : "Promise.resolve(f)";
  throw new TypeError(
    `cannot pass this ${what} directly between independent polyengine stores; ` +
      `cross-store ${what} transfer is not supported. Adapt it by value with ` +
      `${adapter} instead.`,
  );
}

/**
 * definitions.py `lift_async_value`.
 *
 * Lifting **removes** the handle: the readable end is transferred out of this
 * instance's table. That handle cannot be used again; the shared value can
 * later return through another lowering/lifting transfer.
 */
function liftAsyncValue(
  cx: LiftLowerContext,
  i: number,
  t: ValType,
  // deno-lint-ignore no-explicit-any
  EndT: any,
  elem: ValType | null,
  what: "stream" | "future",
): SharedBase {
  assert_(!containsBorrow(t), `${what} may not contain a borrow`);
  const inst = cx.inst;
  assert_(inst !== null, `${what} lift requires a component instance`);
  return removeHandleWithUnwind(inst!, i, (e) => {
    trapIf(!(e instanceof EndT), `${what} lift: handle is not a ${what} end`);
    const end = e as {
      shared: SharedBase;
      elem: ValType | null;
      state: CopyState;
      inWaitableSet(): boolean;
    };
    trapIf(
      !valTypeEqual(end.elem, elem),
      `${what} lift: element type mismatch`,
    );
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
    // A shared object cannot be driven by two stores. The nullish check also
    // admits structural test doubles whose store field is absent.
    const holder = end.shared as { boundStore?: unknown };
    const store = (inst as unknown as { store?: unknown }).store;
    assertAsyncValueDestinationStore(holder, store, what);
    holder.boundStore ??= store;
    // Host-wrapper re-arm hook (contracts/embedder-api.md §"Streams and futures"): the readable
    // end just left a guest table, so whoever receives it can act on it again.
    // See `bindOnLower` in exec/host_streams.ts for the retention rule.
    (end.shared as { onLifted?: ((i: unknown) => void) | null }).onLifted?.(
      inst,
    );
    return end.shared;
  });
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

/** definitions.py `lower_stream`. */
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
  // Host-precondition check: element types determine buffer size and lifting.
  // Diagnostics must use fmtValType, not serialize resource identity cycles.
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
  // CONTRACT: cross-store identity is an unsupported host policy, not a CABI
  // rule (definitions.py:1802-1805). Check before onLowered or table insertion.
  assertAsyncValueDestinationStore(
    v,
    (inst as { store?: unknown }).store,
    "stream",
  );
  (v as { boundStore?: unknown }).boundStore ??=
    (inst as unknown as { store?: unknown }).store;
  (v as { onLowered?: ((i: unknown) => void) | null }).onLowered?.(inst);
  return inst!.handles.add(new ReadableStreamEnd(v, declared));
}

/** definitions.py `lower_future`. */
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
  // CONTRACT: see lowerStream and definitions.py:1807-1810.
  assertAsyncValueDestinationStore(
    v,
    (inst as { store?: unknown }).store,
    "future",
  );
  (v as { boundStore?: unknown }).boundStore ??=
    (inst as unknown as { store?: unknown }).store;
  (v as { onLowered?: ((i: unknown) => void) | null }).onLowered?.(inst);
  return inst!.handles.add(new ReadableFutureEnd(v, declared));
}

/** definitions.py `lift_error_context`. Does not remove the handle. */
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

/** definitions.py `lower_error_context`. */
export function lowerErrorContext(
  cx: LiftLowerContext,
  v: ErrorContext,
): number {
  const inst = cx.inst;
  assert_(inst !== null, "error-context lower requires a component instance");
  return inst!.handles.add(v);
}
