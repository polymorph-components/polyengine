// Resources as classes on both sides of the boundary
// (contracts/embedder-api.md §"Resources").
//
// The raw boundary uses bare reps, not table indices. This layer maps them
// to guest wrappers or the host's original instances.
//
// Ownership, per the contract's 2x4 table:
//
// | position                | guest-implemented R          | host-implemented R        |
// | host receives own<R>    | new wrapper (host owns)      | instance back, ownership released, no dispose |
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
 * Shared recognition key, runtime-private state. Only `copyUrl` may be read
 * to distinguish this copy's wrappers; another copy cannot operate the rep.
 */
const STATE = RESOURCE_STATE;

interface WrapperState {
  /** The runtime copy that minted this wrapper. */
  copyUrl: string;
  rep: number;
  /** False once the handle was transferred away or dropped. */
  valid: boolean;
  /** True for `own` wrappers, which are responsible for dropping. */
  owns: boolean;
  rt: ResourceTypeInfo;
  className: string;
  /**
   * Host-side lend count, analogous to ResourceHandle.num_lends. Each
   * lowering scope retains the rep until its call ends. Transfer as own is
   * forbidden while lent; drop invalidates immediately but defers the dtor.
   */
  lends: number;
  /**
   * Explicit or GC-backstop drop deferred until the last lend releases.
   * Unlike canon_resource_drop's busy trap, this host API queues destruction.
   */
  pendingDrop: boolean;
}

/** Base of every runtime-built guest-resource class. */
export class GuestResource {
  /** @internal */
  declare [STATE]: WrapperState;

  constructor() {
    // Raw structured cloning must fail: wrappers depend on this realm's
    // runtime state. makeWrapper bypasses this constructor and marks separately.
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
 * Best-effort backstop for leaked handles (docs/architecture.md §7).
 * Finalization is not guaranteed; callers should drop explicitly.
 */
const runBackstop = (s: WrapperState): void => {
  // Idempotence: `valid` is the single guard. A wrapper that was dropped,
  // transferred, or invalidated already cleared it (and unregistered), so the
  // backstop can neither double-run a dtor nor resurrect a dead rep.
  if (!s.valid || !s.owns) return;
  s.valid = false;
  if (s.lends > 0) {
    // The lowering scope retains state until releaseLend can safely destroy
    // the rep, even though the wrapper itself is unreachable.
    s.pendingDrop = true;
    return;
  }
  runHostDrop(s);
};

const leaked = new FinalizationRegistry<WrapperState>(runBackstop);

/**
 * Run the GC callback deterministically for a test of a live borrow window.
 *
 * @internal
 */
export function simulateFinalizationForTest(w: object): void {
  const s = wrapperState(w);
  if (s !== undefined) runBackstop(s);
}

/**
 * Run a deferred/backstop destructor without throwing into cleanup. Record
 * a synchronous failure on the implementing store; hostDtorCall records
 * asynchronous failures there too. Immediate explicit drops call it directly
 * so their synchronous failures can propagate to the caller.
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
 * Return this copy's wrapper state only. requireLive distinguishes a foreign
 * brand from an unbranded object without interpreting foreign resource state.
 */
export function wrapperState(w: object): WrapperState | undefined {
  const s = (w as unknown as Record<symbol, WrapperState | undefined>)[STATE];
  if (s === undefined) return undefined;
  return s.copyUrl === COPY_URL ? s : undefined;
}

/**
 * True iff `w` carries the module identity resource-state key but is not one of ours.
 *
 * Note the resource brand is the odd one out in the module identity table: its value is the
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
      throw new InvalidHandleError(`${what}: ${
        describeCrossCopy(
          "this resource handle",
          "Resource wrappers hold a rep in the minting copy's tables; there " +
            "is no by-value form — call through the copy that created it.",
        )
      }`);
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
    // Invalidate now; destruction waits for the last in-flight borrow.
    s.pendingDrop = true;
    return;
  }
  // A canonical lifted destructor gets a Task/Thread, not a bare JS call.
  // Drop does not await its tail; the store drives it and records late failure.
  hostDtorCall(s.rt, s.rep);
}

/**
 * Record that a host-held `own` wrapper was lowered as `borrow<R>` into a
 * guest call, and return the (idempotent) release for the end of that call.
 *
 * Analogue of lift_borrow -> Subtask.add_lender / deliver_resolve.
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
export function takeRep(
  w: unknown,
  rt: ResourceTypeInfo,
  own: boolean,
  what: string,
): number {
  if (typeof w !== "object" || w === null) {
    throw new InvalidHandleError(
      `${what}: expected a resource class instance, got ${typeof w}`,
    );
  }
  const s = requireLive(w, what);
  if (s.rt !== rt) {
    throw new InvalidHandleError(`${what}: resource type mismatch`);
  }
  if (own) {
    if (!s.owns) {
      throw new InvalidHandleError(
        `${what}: a borrowed ${s.className} handle cannot be transferred as own`,
      );
    }
    // definitions.py `lift_own`: `trap_if(h.num_lends != 0)`. A
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
    /** True for an `async func` — see sync()'s `{ kind: "async" }` brand. */
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
 * Wrap a method/static once at class construction, using Facade's export
 * conventions. Methods prepend self; the wrapper's sync brand is relayed to
 * the class member with a method-specific receiver requirement.
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
 * Construction must finish synchronously to return a usable resource wrapper.
 * A guest constructor returning a thenable is refused; use an async factory
 * for asynchronous construction.
 */
export function buildGuestResourceClass(
  spec: GuestResourceSpec,
  rt: ResourceTypeInfo,
  wrapExport: ExportWrapper,
  lowerArgs: (
    args: unknown[],
    params: ValType[],
    where: string,
  ) => { lowered: unknown[]; release: () => void },
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
      const { lowered, release } = lowerArgs(
        args,
        spec.ctorParams ?? [],
        where,
      );
      let rep: unknown;
      try {
        rep = spec.ctor(...lowered);
      } catch (e) {
        try {
          release();
        } catch {
          // The original error wins; a secondary failure of the unwind is
          // not the story.
        }
        throw e;
      }
      try {
        release();
      } catch (e) {
        try {
          if (typeof rep === "number") hostDtorCall(rt, rep);
        } catch {
          // The original error wins; a secondary failure of the unwind is
          // not the story.
        }
        throw e;
      }
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
    // Share one branded wrapper across instances, prepending self per call.
    const wrapped = wrapExport(m.raw, m.params, m.results, m.async, where);
    const methodFn = function (this: GuestResource, ...args: unknown[]) {
      // params[0] is the `borrow<R>`/`own<R>` self.
      return wrapped(this, ...args);
    };
    const payload = syncPayloadOf(wrapped);
    if (payload !== undefined) {
      // The sync form already takes self; retag it to require sync(instance).
      markSyncCallable(
        methodFn,
        payload.kind === "free" ? { kind: "method", fn: payload.fn } : payload, // kind "async": pass the brand through unchanged
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
  // realm boundary: `Object.create` bypasses `GuestResource`'s constructor, so the
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
 * Strongly retain the instance while guest-owned or borrowed by any host-
 * originated call. Returning own releases ownership, not outstanding borrows.
 * A guest drop defers disposal until all borrows release.
 * @internal — runtime-owned instance<->rep mapping; hosts supply a class, not
 * a registry.
 */
export class HostResourceRegistry {
  readonly #byRep = new Map<
    number,
    { instance: object; owns: boolean; borrows: number; pendingDrop: boolean }
  >();
  readonly #byInstance = new WeakMap<object, number>();
  #next = 1;

  constructor(readonly className: string) {}

  #repFor(instance: unknown): number {
    if (instance === null || typeof instance !== "object") {
      throw new TypeError(
        `${this.className}: expected a class instance, got ${typeof instance}`,
      );
    }
    const held = this.#byInstance.get(instance);
    if (held !== undefined && this.#byRep.has(held)) return held;
    const rep = this.#next++;
    this.#byRep.set(rep, {
      instance,
      owns: false,
      borrows: 0,
      pendingDrop: false,
    });
    this.#byInstance.set(instance, rep);
    return rep;
  }

  /** The host is passing an own to the guest: retain until release or drop. */
  repFor(instance: unknown): number {
    const rep = this.#repFor(instance);
    const entry = this.#byRep.get(rep)!;
    if (entry.pendingDrop) {
      throw new InvalidHandleError(
        `${this.className}: cannot transfer an instance pending drop as own`,
      );
    }
    entry.owns = true;
    return rep;
  }

  /** Retain a mapping for every overlapping call, independently of ownership. */
  borrowFor(instance: unknown): { rep: number; release: () => void } {
    const rep = this.#repFor(instance);
    const entry = this.#byRep.get(rep)!;
    entry.borrows += 1;
    let released = false;
    return {
      rep,
      release: () => {
        if (released) return;
        released = true;
        entry.borrows -= 1;
        if (entry.borrows === 0 && !entry.owns) {
          this.#byRep.delete(rep);
          if (entry.pendingDrop) {
            entry.pendingDrop = false;
            (entry.instance as { [Symbol.dispose]?: () => void })
              [Symbol.dispose]?.();
          }
        }
      },
    };
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

  /** A `borrow<R>` arrived from the guest: the host's own instance, mapping kept. */
  lookup(rep: number): object {
    const inst = this.#byRep.get(rep);
    if (inst === undefined) {
      throw new InvalidHandleError(
        `${this.className}: no live instance for rep ${rep}`,
      );
    }
    return inst.instance;
  }

  /**
   * Return the host's instance without disposal. Keep its mapping while any
   * host-originated borrow remains, even though guest ownership has ended.
   */
  release(rep: number): object {
    const inst = this.lookup(rep);
    const entry = this.#byRep.get(rep)!;
    entry.owns = false;
    if (entry.borrows === 0) this.#byRep.delete(rep);
    return inst;
  }

  /**
   * Guest drop: dispose now or after the last host-originated borrow.
   * Pending disposal prevents re-transfer as own; the final release reports
   * any disposal failure after removing the mapping.
   */
  dtor(rep: number): void {
    const entry = this.#byRep.get(rep);
    if (entry === undefined || !entry.owns) return;
    if (entry.borrows > 0) {
      entry.owns = false;
      entry.pendingDrop = true;
      return;
    }
    const inst = this.release(rep);
    (inst as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  }

  /** Retained mapping count, not handle count; diagnostics and tests. */
  get liveCount(): number {
    return this.#byRep.size;
  }
}
