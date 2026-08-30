// `sync()` — the explicit synchronous view of a WIT-sync export (contracts/
// embedder-api.md §"Functions and async", amendment A25, 2026-08-30).
//
// Placement (A22): application machinery exported from
// `@polyengine/runtime/embedder`, like `createStream` — only an instantiating
// application holds export functions, so this is deliberately NOT host-module
// vocabulary and does not touch `@polyengine/protocol`.
//
// Recognition is by brand (`polyengine.syncCallable/1`, a registry symbol per
// A9) so views work across mixed runtime copies. Unlike the boolean brands in
// `@polyengine/protocol`'s `brands.ts` (whose payload is always `true`), this
// brand carries a PAYLOAD describing the callable's synchronous form — the
// dispatch shapes below are what `instantiate.ts` / `resources.ts` attach at
// wrap time and what this module reads back.

/** The registry symbol. `Symbol.for` per A9: N runtime copies agree on it
 * without sharing modules. */
export const SYNC_CALLABLE: unique symbol = Symbol.for(
  "polyengine.syncCallable/1",
);

/**
 * The brand payload, keyed by what the branded value is.
 *
 * - `"free"` — a lifted export function (plain export, interface member, or
 *   resource static): `fn` is the fully-wrapped synchronous form.
 * - `"method"` — a guest-resource prototype method: `fn` takes the resource
 *   instance as its first argument (the `borrow<R>`/`own<R>` self param the
 *   lifted function already declares).
 * - `"async"` — an async-typed export: carries no synchronous form, named so
 *   `sync()` can report the real reason.
 */
export type SyncPayload =
  | { kind: "free"; fn: (...args: unknown[]) => unknown }
  | { kind: "method"; fn: (self: unknown, ...args: unknown[]) => unknown }
  | { kind: "async" };

/**
 * Stamp `payload` on `target` under the brand: non-enumerable, non-writable,
 * matching `@polyengine/protocol`'s `defineBrand` (protocol/src/brands.ts) —
 * implemented locally since the runtime does not add application-tier
 * vocabulary to the protocol package (A22).
 *
 * @internal — written by `instantiate.ts` and `resources.ts` at wrap/
 * class-build time; not part of the public `sync()` surface.
 */
export function markSyncCallable(target: object, payload: SyncPayload): void {
  Object.defineProperty(target, SYNC_CALLABLE, {
    value: payload,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/**
 * Read the brand payload off `target`, or `undefined` if unbranded.
 * Structural, like `hasBrand`: accepts a payload minted by any copy.
 * @internal
 */
export function syncPayloadOf(target: unknown): SyncPayload | undefined {
  if (target === null) return undefined;
  const t = typeof target;
  if (t !== "object" && t !== "function") return undefined;
  return (target as Record<symbol, SyncPayload | undefined>)[SYNC_CALLABLE];
}

/** Own, function-valued, branded members of `proto`'s prototype chain
 * (stopping at `Object.prototype`), nearest wins. Used to recognize a
 * guest-resource INSTANCE: its class's prototype carries `"method"`-branded
 * data properties (`resources.ts` `buildGuestResourceClass`). */
function protoBrandedMembers(proto: object): Map<string, SyncPayload> {
  const out = new Map<string, SyncPayload>();
  for (
    let o: object | null = proto;
    o !== null && o !== Object.prototype;
    o = Object.getPrototypeOf(o)
  ) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (out.has(key) || key === "constructor") continue;
      const d = Object.getOwnPropertyDescriptor(o, key);
      if (d === undefined || typeof d.value !== "function") continue;
      const p = syncPayloadOf(d.value);
      if (p !== undefined) out.set(key, p);
    }
  }
  return out;
}

/** Own, function-valued, branded static members of a guest-resource class. */
function ownBrandedStatics(cls: object): Map<string, SyncPayload> {
  const out = new Map<string, SyncPayload>();
  for (const key of Object.getOwnPropertyNames(cls)) {
    if (key === "prototype" || key === "name" || key === "length") continue;
    const d = Object.getOwnPropertyDescriptor(cls, key);
    if (d === undefined || typeof d.value !== "function") continue;
    const p = syncPayloadOf(d.value);
    if (p !== undefined) out.set(key, p);
  }
  return out;
}

function isResourceInstance(v: object): boolean {
  if (typeof v === "function") return false; // a class, not an instance
  const proto = Object.getPrototypeOf(v);
  if (proto === null || proto === Object.prototype) return false;
  return protoBrandedMembers(proto).size > 0;
}

// deno-lint-ignore ban-types
function isResourceClass(v: Function): boolean {
  return ownBrandedStatics(v).size > 0;
}

function asyncMessage(name: string): string {
  return `sync(): '${name}' is an async-typed WIT export; async exports ` +
    `have no synchronous form`;
}

function methodMessage(name: string): string {
  return `sync(): '${name}' is a resource method; call sync(instance) ` +
    `instead of sync(fn) — a bare method function has no receiver to bind`;
}

/** Views are stable: `sync(x) === sync(x)` for the same target. */
const views = new WeakMap<object, unknown>();

function memoView(key: object, build: () => unknown): unknown {
  const cached = views.get(key);
  if (cached !== undefined) return cached;
  const view = build();
  views.set(key, view);
  return view;
}

/** A view member that reports its real reason (async) only when accessed —
 * so an unrelated sync member of the same record/class/instance stays usable
 * (see the CONTRACT note on record recursion below). */
function throwingMember(view: object, key: string, message: string): void {
  Object.defineProperty(view, key, {
    enumerable: true,
    configurable: true,
    get(): never {
      throw new TypeError(message);
    },
  });
}

function instanceView(instance: object): unknown {
  return memoView(instance, () => {
    const proto = Object.getPrototypeOf(instance) as object;
    const members = protoBrandedMembers(proto);
    const view: Record<string, unknown> = {};
    for (const [key, p] of members) {
      if (p.kind === "method") {
        const fn = p.fn;
        view[key] = (...a: unknown[]) => fn(instance, ...a);
      } else if (p.kind === "async") {
        throwingMember(view, key, asyncMessage(key));
      }
      // A "free"-kind branded proto member should not occur (methods are
      // always branded "method" by `buildGuestResourceClass`); nothing to do
      // if it somehow did — the instance view only ever exposes methods
      // (statics are not reachable from an instance; §"Functions and async").
    }
    return view;
  });
}

function classView(cls: object): unknown {
  return memoView(cls, () => {
    const statics = ownBrandedStatics(cls);
    const view: Record<string, unknown> = {};
    for (const [key, p] of statics) {
      if (p.kind === "free") {
        view[key] = p.fn;
      } else if (p.kind === "async") {
        throwingMember(view, key, asyncMessage(key));
      }
    }
    return view;
  });
}

/**
 * Map one record MEMBER by the `sync(record)` recursion rule: a branded
 * function or a nested resource class/instance/record maps recursively;
 * anything else (including an unbranded function) passes through unchanged.
 *
 * CONTRACT (contracts/embedder-api.md §"Functions and async" A25, the
 * `sync(record)` bullet): the bullet says a record's members are "mapped by
 * these same rules, recursively" — read most literally, an async-typed
 * member nested in a record should behave exactly as `sync(asyncFn)` does at
 * top level, i.e. throw. But applying that EAGERLY while building the
 * parent's view would make one unrelated async export in a real component's
 * exports record (a normal mix — see contracts/embedder-api.md's own async +
 * sync export examples) poison `sync(exports)` entirely, defeating the
 * per-use adapter's whole purpose. The conservative reading kept here defers
 * that failure to the point the caller actually reaches for the async
 * member (`throwingMember`), never for members the caller never touches —
 * every failure the contract mandates still happens, just lazily.
 */
function mapMember(v: unknown): unknown {
  if (typeof v === "function") {
    const p = syncPayloadOf(v);
    if (p !== undefined) {
      if (p.kind === "free") return p.fn;
      if (p.kind === "method") throw new TypeError(methodMessage(v.name));
      throw new TypeError(asyncMessage(v.name));
    }
    if (isResourceClass(v)) return classView(v);
    return v; // unbranded function: pass through unchanged
  }
  if (v !== null && typeof v === "object") {
    if (isResourceInstance(v)) return instanceView(v);
    return recordView(v); // a nested (interface) record
  }
  return v; // primitives, null: pass through unchanged
}

function recordView(rec: object): unknown {
  return memoView(rec, () => {
    const view: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      const d = Object.getOwnPropertyDescriptor(rec, key);
      if (d === undefined) continue;
      if (!("value" in d)) {
        // An accessor-backed own member (not expected on a runtime-built
        // exports record today, but nothing here assumes data properties
        // only): forward reads/writes to the underlying record unmapped.
        Object.defineProperty(view, key, {
          enumerable: true,
          configurable: true,
          get: () => (rec as Record<string, unknown>)[key],
        });
        continue;
      }
      const value = d.value;
      // Lazy: `mapMember` runs (and can throw, for an async member) only
      // when the caller actually reads this key — see the CONTRACT note on
      // `mapMember` above.
      Object.defineProperty(view, key, {
        enumerable: true,
        configurable: true,
        get: () => mapMember(value),
      });
    }
    return view;
  });
}

/** `Promise<R>`-returning functions synchronize to `R`; records map
 * recursively; everything else passes through. Type-level refusal of an
 * async export is not attempted (the contract only requires the runtime
 * error) — `Sync<F>` stays structural.
 *
 * CONTRACT: the naive `F extends Record<string, unknown>` branch (checked
 * before this fix) only matches object-LITERAL type aliases — named
 * interfaces (generated `*Exports`) and class instance types (generated
 * resource classes, e.g. `Counter`) have no implicit index signature and
 * are not assignable to it, so they fell through to the `: F` passthrough
 * and stayed Promise-shaped. Ordering matters: a non-Promise function type
 * (e.g. a resource's `drop(): void`, or `[Symbol.dispose]`) must be checked
 * and passed through BEFORE the generic `object` branch, or `{ [K in keyof
 * F]: ... }` would try to map over a function's call signature (losing it)
 * instead of leaving the function itself alone. */
export type Sync<F> = F extends (...a: infer A) => Promise<infer R>
  ? (...a: A) => R
  : F extends (...a: never[]) => unknown
    ? F // non-Promise functions (e.g. `drop(): void`) pass through unchanged
  : F extends object
    ? { [K in keyof F]: Sync<F[K]> } // interfaces, class instances, records
  : F;

/**
 * The synchronous form of a WIT-sync export (contracts/embedder-api.md
 * §"Functions and async", amendment A25).
 *
 * - `sync(fn)` — a lifted export function (plain export, interface member,
 *   or resource static): returns the synchronous form `(...args) => T`.
 * - `sync(instance)` — a guest-resource wrapper: a view whose members call
 *   the synchronous forms with `instance` as receiver.
 * - `sync(cls)` — a guest-resource class: a view of synchronous statics
 *   (constructors are already synchronous; `new` the class itself).
 * - `sync(record)` — an exports record or nested interface record: a view
 *   with every member mapped by these same rules, recursively; non-branded
 *   members pass through unchanged.
 * - Views are stable: `sync(x) === sync(x)`.
 * - An async-typed export, a bare resource-method function, or anything
 *   unbranded throws `TypeError`.
 */
export function sync<F extends (...a: never[]) => Promise<unknown>>(
  target: F,
): Sync<F>;
export function sync<T extends object>(target: T): Sync<T>;
/** Fallback for a non-branded/primitive target — always throws at runtime
 * (see the dispatch above); typed loosely so a caller passing an arbitrary
 * value (as opposed to a known export/record/instance/class shape) still
 * type-checks, matching the runtime's willingness to name the mistake. */
export function sync(target: unknown): unknown;
export function sync(target: unknown): unknown {
  if (typeof target === "function") {
    const p = syncPayloadOf(target);
    if (p !== undefined) {
      if (p.kind === "free") return p.fn;
      if (p.kind === "method") {
        throw new TypeError(methodMessage(target.name || "<anonymous>"));
      }
      throw new TypeError(asyncMessage(target.name || "<anonymous>"));
    }
    if (isResourceClass(target)) return classView(target);
    throw new TypeError(
      `sync(): '${
        target.name || "<anonymous>"
      }' is not a sync-callable export (unbranded function)`,
    );
  }
  if (target === null || typeof target !== "object") {
    throw new TypeError(
      `sync(): expected a lifted export function, guest-resource instance/` +
        `class, or exports record; got ${
          target === null ? "null" : typeof target
        }`,
    );
  }
  if (isResourceInstance(target)) return instanceView(target);
  return recordView(target);
}
