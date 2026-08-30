// Resources as classes on both sides of the boundary
// (contracts/embedder-api.md §"Resources"; C2 checklist item 3).
//
// The raw boundary represents `own<R>` / `borrow<R>` as bare **reps**
// (cabi/handles.ts `liftOwn` returns `rh.rep`; the host never holds a table
// index). C0 findings 1-3 were embedders turning that into identity tables and
// hand-transcribed `[method]…` keys by hand. Both become runtime obligations
// here.
//
// Ownership, per the contract's 2x4 table:
//
// | position                | guest-implemented R          | host-implemented R        |
// | host receives own<R>    | new wrapper (host owns)      | instance back, mapping released, NO dispose |
// | host receives borrow<R> | wrapper valid for the call   | instance, mapping kept    |
// | host passes own<R>      | wrapper invalidated          | instance registered       |
// | host passes borrow<R>   | wrapper stays valid          | rep reused/allocated      |

import type { ResourceTypeInfo, ValType } from "../cabi/types.ts";
import { defineRealmLocal, RESOURCE_STATE } from "@polyengine/protocol";
import { hostDtorCall } from "../exec/boundary.ts";
import { COPY_URL, describeCrossCopy } from "./copy.ts";
import { InvalidHandleError } from "./errors.ts";
import { camelCase, pascalCase } from "./casing.ts";
import { markSyncCallable, syncPayloadOf } from "./sync.ts";

/**
 * Internal state of a guest-resource wrapper.
 *
 * The KEY is the process-global `polyengine.resourceState/1` brand since amendment
 * A9 (it used to be a module-local `Symbol(...)`, on the now-repealed
 * assumption that bundle and source runtimes are never mixed in one process —
 * issue #83 showed they routinely are). The state SHAPE stays strictly
 * runtime-internal, exactly as the A9 brand table notes: another copy may
 * RECOGNIZE a wrapper, and must never read or write this object. `copyUrl` is
 * what lets this copy tell its own wrappers from a foreign copy's.
 */
const STATE = RESOURCE_STATE;

interface WrapperState {
  /** The runtime copy that minted this wrapper (A9). */
  copyUrl: string;
  rep: number;
  /** False once the handle was transferred away or dropped. */
  valid: boolean;
  /** True for `own` wrappers, which are responsible for dropping. */
  owns: boolean;
  rt: ResourceTypeInfo;
  className: string;
  /**
   * Host-side `ResourceHandle.num_lends` (#86). The reference models a
   * host-held `own` as a table entry whose `num_lends` is bumped every time
   * it is lifted as a `borrow` (definitions.py `Subtask.add_lender`, line
   * 890, reached from `lift_borrow`, line 1516) and decremented when the
   * borrowing call's subtask delivers its resolution (`deliver_resolve`,
   * line 902). `lift_own` and `canon_resource_drop` both trap while it is
   * non-zero (lines 1508 / 2325).
   *
   * Here the host holds bare reps rather than table entries, so the counter
   * lives on the wrapper. Its lifecycle point is the *lowering scope* of the
   * call the wrapper was passed into (`instantiate.ts` `#lowerParams`), which
   * is released exactly when that call ends — the host-side analogue of the
   * subtask's resolve delivery.
   */
  lends: number;
  /**
   * A drop (explicit or via the GC backstop) that arrived while `lends > 0`.
   * The reference would trap; the host has no frame to trap into by then, so
   * the drop is deferred to the last release instead of running the dtor
   * under a live guest borrow (which is the use-after-free #86 reports).
   */
  pendingDrop: boolean;
}

/** Base of every runtime-built guest-resource class. */
export class GuestResource {
  /** @internal */
  declare [STATE]: WrapperState;

  constructor() {
    // A20 (contracts/embedder-api.md §"Realm boundaries and
    // structured-clone-safe forms"; issue #131): guest-resource wrappers are
    // realm-local by principle (their machinery lives in the minting
    // copy's tables, issue #129's identity rule) — the pill makes a raw
    // structuredClone/postMessage of one throw instead of husking. NOTE:
    // `makeWrapper` below mints via `Object.create`, which bypasses this
    // constructor entirely — it installs the pill itself.
    defineRealmLocal(this);
  }

  /** Drop the handle (alias of `[Symbol.dispose]`, so TS `using` works). */
  drop(): void {
    dropWrapper(this);
  }

  [Symbol.dispose](): void {
    dropWrapper(this);
  }
}

/**
 * Backstop for leaked handles (docs/architecture.md §7). A wrapper that becomes unreachable
 * without `drop()` still runs the guest destructor — late, but not never.
 */
const runBackstop = (s: WrapperState): void => {
  // Idempotence: `valid` is the single guard. A wrapper that was dropped,
  // transferred, or invalidated already cleared it (and unregistered), so the
  // backstop can neither double-run a dtor nor resurrect a dead rep.
  if (!s.valid || !s.owns) return;
  s.valid = false;
  if (s.lends > 0) {
    // A live guest borrow of this rep is outstanding (#86). Running the dtor
    // now is exactly the use-after-free the reference forbids
    // (definitions.py line 2325, `trap_if(h.num_lends != 0)`); the last
    // `releaseLend` runs it instead. The closure held by the lowering scope
    // keeps `s` alive, so the deferred drop is not lost with the wrapper.
    s.pendingDrop = true;
    return;
  }
  runHostDrop(s);
};

const leaked = new FinalizationRegistry<WrapperState>(runBackstop);

/**
 * Simulate the GC backstop firing for `w` (the FinalizationRegistry callback,
 * verbatim). Test seam: real GC finalization is unschedulable, and #86 is
 * precisely about what the backstop does in a window a test must control.
 *
 * @internal
 */
export function simulateFinalizationForTest(w: object): void {
  const s = wrapperState(w);
  if (s !== undefined) runBackstop(s);
}

/**
 * Run a host-initiated drop of a guest `own` handle.
 *
 * The host holds a rep, never a table index, so there is nothing to remove
 * from a handle table: the observable remainder of definitions.py
 * `canon_resource_drop` for an owning handle is the lifted dtor call
 * (`hostDtorCall`, exec/boundary.ts), with `caller = None` — a host-initiated
 * call, `Store.invoke`'s `caller = None`.
 *
 * Never throws: the two callers are `drop()`/`[Symbol.dispose]()` — where a
 * trap *is* reportable, so it propagates — and the FinalizationRegistry
 * callback, where a throw would be swallowed by the engine with no
 * diagnostic. `runHostDrop` is the latter's form: a trapping dtor poisons the
 * implementing instance (which the lift harness does) and is additionally
 * recorded on the store's host-failure channel, so the next driven call
 * surfaces it instead of silently continuing on a half-destroyed instance
 * (#86, second defect: the former `catch {}`).
 */
function runHostDrop(s: WrapperState): void {
  try {
    hostDtorCall(s.rt, s.rep);
  } catch (e) {
    recordHostFailure(s.rt, e);
  }
}

/** Park a failure that has no frame to propagate into on the store. */
function recordHostFailure(rt: ResourceTypeInfo, e: unknown): void {
  const store = (rt.impl as unknown as {
    store?: { hostFailure: unknown };
  } | null)?.store;
  if (store !== undefined && store.hostFailure === undefined) {
    store.hostFailure = e;
  }
}

export function initWrapper(
  w: GuestResource,
  state: Omit<WrapperState, "copyUrl"> & { copyUrl?: string },
): void {
  state.copyUrl ??= COPY_URL;
  (w as unknown as Record<symbol, WrapperState>)[STATE] = state as WrapperState;
  if (state.owns) leaked.register(w, state as WrapperState, w);
}

/**
 * This copy's state for a wrapper, or `undefined`.
 *
 * A wrapper minted by ANOTHER copy carries the same (process-global) brand key
 * but its state belongs to that copy — reading it here would be reading a
 * foreign copy's private shape (A9). So it is not a state: it is
 * `undefined` here, and `requireLive` turns that into the named cross-copy
 * error rather than a misleading "not a resource handle" / "not live".
 */
export function wrapperState(w: object): WrapperState | undefined {
  const s = (w as unknown as Record<symbol, WrapperState | undefined>)[STATE];
  if (s === undefined) return undefined;
  return s.copyUrl === COPY_URL ? s : undefined;
}

/**
 * True iff `w` carries the A9 resource-state key but is not one of ours.
 *
 * Note the resource brand is the odd one out in the A9 table: its value is the
 * state OBJECT, not `true`, so `hasBrand` does not apply — presence of the key
 * is the recognition. Only meaningful once `wrapperState` has returned
 * `undefined`, i.e. presence here means "another copy's wrapper".
 */
function isForeignWrapper(w: object): boolean {
  return (w as unknown as Record<symbol, unknown>)[STATE] !== undefined;
}

function requireLive(w: object, what: string): WrapperState {
  const s = wrapperState(w);
  if (s === undefined) {
    if (isForeignWrapper(w)) {
      throw new InvalidHandleError(`${what}: ${describeCrossCopy(
        "this resource handle",
        "Resource wrappers hold a rep in the minting copy's tables; there " +
          "is no by-value form — call through the copy that created it.",
      )}`);
    }
    throw new InvalidHandleError(`${what}: not a resource handle`);
  }
  if (!s.valid) {
    throw new InvalidHandleError(
      `${what}: this ${s.className} handle is no longer valid (it was ` +
        `transferred as own<…>, dropped, or was a borrow that outlived its ` +
        `call)`,
    );
  }
  return s;
}

function dropWrapper(w: GuestResource): void {
  const s = wrapperState(w);
  if (s === undefined || !s.valid) return;
  s.valid = false;
  leaked.unregister(w);
  if (!s.owns) return; // a borrow was never ours to drop
  if (s.lends > 0) {
    // Lent out to an in-flight guest call (#86): defer rather than destroy a
    // rep the guest still holds a `borrow` of. `drop(): void` stays
    // non-blocking either way — the deferred dtor runs from `releaseLend`.
    s.pendingDrop = true;
    return;
  }
  // The dtor runs as an ordinary LIFTED sync call (`hostDtorCall`, #160):
  // definitions.py `canon_resource_drop` (line 2319) lifts it with
  // `CanonicalOptions(async_ = False)` rather than calling it bare, and that
  // is what gives the activation a Task/Thread. A dtor that suspends (a
  // `promising`-entered dtor calling a `Suspending` import,
  // docs/architecture.md §7) therefore releases the implementing instance's
  // entry bracket at its first park, so the scheduler can resume it — the
  // old held-bracket form wedged exactly there (#160).
  //
  // `drop(): void` stays non-blocking: an unfinished dtor's tail is driven
  // by the store like any other parked activation, and a failure that has no
  // frame to return into is parked on `store.hostFailure`.
  hostDtorCall(s.rt, s.rep);
}

/**
 * Record that a host-held `own` wrapper was lowered as `borrow<R>` into a
 * guest call, and return the (idempotent) release for the end of that call.
 *
 * definitions.py: `lift_borrow` -> `Subtask.add_lender` (line 890) on the way
 * in, `Subtask.deliver_resolve` (line 902) on the way out.
 */
export function lendWrapper(w: object): () => void {
  const s = wrapperState(w);
  if (s === undefined) return () => {};
  s.lends += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseLend(s);
  };
}

function releaseLend(s: WrapperState): void {
  s.lends -= 1;
  if (s.lends > 0 || !s.pendingDrop) return;
  s.pendingDrop = false;
  // The drop that arrived while the handle was lent. `valid` is already
  // false (both deferral sites clear it first), so nothing can race this.
  runHostDrop(s);
}

/** Host-side `num_lends` — diagnostics and white-box tests. */
export function wrapperLends(w: object): number {
  return wrapperState(w)?.lends ?? 0;
}

/** Invalidate a wrapper without dropping (used to end a borrow's lifetime). */
export function invalidateWrapper(w: object): void {
  const s = wrapperState(w);
  if (s === undefined) return;
  s.valid = false;
  leaked.unregister(w as GuestResource);
}

/** Read a wrapper's rep for a lowering site, applying the ownership rule. */
export function takeRep(w: unknown, own: boolean, what: string): number {
  if (typeof w !== "object" || w === null) {
    throw new InvalidHandleError(
      `${what}: expected a resource class instance, got ${typeof w}`,
    );
  }
  const s = requireLive(w, what);
  if (own) {
    // definitions.py `lift_own` (line 1508): `trap_if(h.num_lends != 0)`. A
    // handle currently lent to an in-flight call cannot be transferred away.
    if (s.lends > 0) {
      throw new InvalidHandleError(
        `${what}: this ${s.className} handle is still lent out as a borrow ` +
          `to an in-flight call and cannot be transferred`,
      );
    }
    // Transfer: the wrapper is invalidated, and must NOT run the destructor.
    s.valid = false;
    leaked.unregister(w as GuestResource);
  }
  return s.rep;
}

/** Everything needed to build one guest-resource class. */
export interface GuestResourceSpec {
  /** WIT resource name (kebab). */
  name: string;
  /** The raw `[constructor]r` lifted function, if the resource has one. */
  ctor: ((...a: unknown[]) => unknown) | null;
  ctorParams: ValType[] | null;
  methods: {
    member: string;
    raw: (...a: unknown[]) => unknown;
    params: ValType[];
    results: ValType[];
    /** True for an `async func` — see A25's `{ kind: "async" }` brand. */
    async: boolean;
  }[];
  statics: {
    member: string;
    raw: (...a: unknown[]) => unknown;
    params: ValType[];
    results: ValType[];
    async: boolean;
  }[];
}

/**
 * Build (once, at class-build time — never per call) the Promise-shaped
 * wrapper for one method/static's raw lifted function, exactly as
 * `Facade#wrapExportFn` would for a plain export. `buildGuestResourceClass`
 * reads the A25 brand off the returned wrapper to install the matching
 * `"method"`/`"free"`/`"async"` brand on the class member it builds around
 * it — the wrapper itself IS what a per-call closure invokes, so a `self`
 * receiver is `wrapper(self, ...args)` for a method the same way a bare
 * export is `wrapper(...args)`.
 */
export type ExportWrapper = (
  raw: (...a: unknown[]) => unknown,
  params: ValType[],
  results: ValType[],
  async: boolean,
  where: string,
) => (...args: unknown[]) => Promise<unknown>;

/**
 * Build the class for a guest-implemented resource.
 *
 * The JS constructor is **synchronous**: a JS constructor cannot return a
 * Promise, so the contract's "exports are uniformly Promise-shaped" rule has
 * one unavoidable exception here. A guest constructor that does not complete
 * synchronously is reported as such rather than silently returning a
 * half-built object (see the report's contract-friction list).
 */
export function buildGuestResourceClass(
  spec: GuestResourceSpec,
  rt: ResourceTypeInfo,
  wrapExport: ExportWrapper,
  lowerArgs: (args: unknown[], params: ValType[], where: string) => unknown[],
  // deno-lint-ignore no-explicit-any
): any {
  const className = pascalCase(spec.name);
  const cls = class extends GuestResource {
    constructor(...args: unknown[]) {
      super();
      if (spec.ctor === null) {
        throw new TypeError(
          `${className} has no WIT constructor; use its static functions`,
        );
      }
      const where = `${className} constructor`;
      const lowered = lowerArgs(args, spec.ctorParams ?? [], where);
      const rep = spec.ctor(...lowered);
      if (rep !== null && typeof rep === "object" && "then" in rep) {
        throw new TypeError(
          `${where}: the guest constructor did not complete synchronously. ` +
            `A JS constructor cannot await; expose an async factory instead.`,
        );
      }
      if (typeof rep !== "number") {
        throw new TypeError(
          `${where}: expected an own handle rep, got ${typeof rep}`,
        );
      }
      initWrapper(this, {
        rep,
        valid: true,
        owns: true,
        rt,
        className,
        lends: 0,
        pendingDrop: false,
      });
    }
  };
  Object.defineProperty(cls, "name", { value: className });

  for (const m of spec.methods) {
    const js = camelCase(m.member);
    const where = `${className}.${js}`;
    // Built ONCE at class-build time (A25: "prototype methods and statics
    // must carry the brand at class-build time, not per call") — every
    // instance's method call goes through this same wrapper, receiver
    // (`self`) prepended.
    const wrapped = wrapExport(m.raw, m.params, m.results, m.async, where);
    const methodFn = function (this: GuestResource, ...args: unknown[]) {
      // params[0] is the `borrow<R>`/`own<R>` self.
      return wrapped(this, ...args);
    };
    const payload = syncPayloadOf(wrapped);
    if (payload !== undefined) {
      // A resource method's sync form takes `self` as its first argument —
      // exactly `wrapped`'s own synchronous form (params[0] IS self), so the
      // "method" brand's `fn` is `payload.fn` verbatim, just re-tagged so
      // `sync()` knows this one needs `sync(instance)` rather than being
      // callable bare.
      markSyncCallable(
        methodFn,
        payload.kind === "free"
          ? { kind: "method", fn: payload.fn }
          : payload, // kind "async": pass the brand through unchanged
      );
    }
    Object.defineProperty(cls.prototype, js, {
      configurable: true,
      writable: true,
      value: methodFn,
    });
  }
  for (const s of spec.statics) {
    const js = camelCase(s.member);
    const where = `${className}.${js} (static)`;
    const wrapped = wrapExport(s.raw, s.params, s.results, s.async, where);
    const staticFn = (...args: unknown[]) => wrapped(...args);
    const payload = syncPayloadOf(wrapped);
    if (payload !== undefined) markSyncCallable(staticFn, payload);
    Object.defineProperty(cls, js, {
      configurable: true,
      writable: true,
      value: staticFn,
    });
  }
  return cls;
}

/** Materialize an `own`/`borrow` wrapper for a rep coming out of a guest. */
export function makeWrapper(
  // deno-lint-ignore no-explicit-any
  cls: any,
  rep: number,
  rt: ResourceTypeInfo,
  owns: boolean,
): GuestResource {
  const w = Object.create(cls.prototype) as GuestResource;
  // A20: `Object.create` bypasses `GuestResource`'s constructor, so the
  // realm-local pill is installed explicitly here (see that constructor).
  defineRealmLocal(w);
  initWrapper(w, {
    rep,
    valid: true,
    owns,
    rt,
    className: cls.name ?? "resource",
    lends: 0,
    pendingDrop: false,
  });
  return w;
}

// ---------------------------------------------------------------------------
// Host-implemented resources
// ---------------------------------------------------------------------------

/**
 * Runtime-owned instance <-> rep mapping for a host-implemented resource.
 *
 * The rep->instance direction is a **strong** map for exactly as long as the
 * guest holds handles: the guest's handle is the only reference keeping a
 * host object alive across calls, and a weak map here would let it be
 * collected under the guest's feet.
 * @internal — runtime-owned instance<->rep mapping; hosts supply a class, not
 * a registry.
 */
export class HostResourceRegistry {
  readonly #byRep = new Map<number, object>();
  readonly #byInstance = new WeakMap<object, number>();
  #next = 1;

  constructor(readonly className: string) {}

  /** The host is passing an instance to the guest: allocate (or reuse) a rep. */
  repFor(instance: unknown): number {
    if (instance === null || typeof instance !== "object") {
      throw new TypeError(
        `${this.className}: expected a class instance, got ${typeof instance}`,
      );
    }
    const held = this.#byInstance.get(instance);
    if (held !== undefined && this.#byRep.has(held)) return held;
    const rep = this.#next++;
    this.#byRep.set(rep, instance);
    this.#byInstance.set(instance, rep);
    return rep;
  }

  /** Is this instance already registered with a live rep? */
  hasInstance(instance: unknown): boolean {
    if (instance === null || typeof instance !== "object") return false;
    const held = this.#byInstance.get(instance);
    return held !== undefined && this.#byRep.has(held);
  }

  /** Is `rep` live? Diagnostics and white-box tests. */
  hasRep(rep: number): boolean {
    return this.#byRep.has(rep);
  }

  /** Release a rep if it is still live; no dtor, no error when already gone. */
  releaseIfPresent(rep: number): void {
    this.#byRep.delete(rep);
  }

  /** A `borrow<R>` arrived from the guest: the host's own instance, mapping kept. */
  lookup(rep: number): object {
    const inst = this.#byRep.get(rep);
    if (inst === undefined) {
      throw new InvalidHandleError(
        `${this.className}: no live instance for rep ${rep}`,
      );
    }
    return inst;
  }

  /**
   * An `own<R>` arrived from the guest: the host gets its instance back, the
   * guest's handle is gone, and **no dispose runs** (the contract's 2x4 table).
   */
  release(rep: number): object {
    const inst = this.lookup(rep);
    this.#byRep.delete(rep);
    return inst;
  }

  /**
   * The guest dropped its last own handle: run the destructor. This is the
   * `HostResourceType` dtor the executor calls from `canon_resource_drop`.
   */
  dtor(rep: number): void {
    const inst = this.#byRep.get(rep);
    if (inst === undefined) return;
    this.#byRep.delete(rep);
    (inst as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  }

  /** Live handle count — diagnostics and tests. */
  get liveCount(): number {
    return this.#byRep.size;
  }
}
