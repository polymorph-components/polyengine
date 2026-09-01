// Structured-clone-safe forms (contracts/embedder-api.md §"Realm boundaries
// and structured-clone-safe forms"; issue #131).
//
// Why this exists: two realms are two runtimes by construction (issue #129),
// and `structuredClone` strips prototypes and symbol-keyed properties — so a
// branded error posted raw arrives as an unbranded husk with its `payload`
// gone, and a `Stream` as an empty object. No import-map discipline can help.
// This module defines the sanctioned crossing (`toCloneable`/`fromCloneable`) and the
// realm-local pill (brands.ts `defineRealmLocal`) makes the unsanctioned one
// fail loudly, in the SENDER realm, with a `DataCloneError`.
//
// Two rules govern every line below:
//
//   * Detection is by BRAND, never `instanceof` — a hand-rolled branded
//     value encodes identically to a canonical class instance, which is what
//     keeps zero-import host modules possible.
//   * `fromCloneable` mints values branded by the LOCAL copy: a new local
//     value with correct identity semantics, never "the same" value. There is
//     no RPC protocol here, no proxying, and no cross-realm identity.
//
// The envelope is VERSION-INTERNAL, never a wire format: the supported matrix
// is the same engine version in both realms, the shape may change in any
// release, and nothing may be persisted on it. That is why the tag string is
// module-private — exporting it would invite exactly the persistence the
// contract forbids.

import {
  COMPONENT_EXCEPTION,
  defineBrand,
  DROPPED,
  ERROR_CONTEXT,
  FUTURE,
  hasBrand,
  INVALID_HANDLE,
  isRealmLocal,
  PEER_TRAPPED,
  POLLABLE,
  RESOURCE_STATE,
  STREAM,
  STREAM_PRODUCER,
  STREAM_WRITER,
  TRAP,
  WASI_EXIT,
} from "./brands.ts";
import {
  ComponentException,
  DroppedError,
  InvalidHandleError,
  PeerTrappedError,
  StreamProducerError,
  Trap,
} from "./errors.ts";

/**
 * The envelope tag property. Deliberately NOT exported (see the header): the
 * form is version-internal.
 *
 * No WIT-mapped value can collide with it — WIT identifiers cannot contain
 * `.` or `/`, and `map<K, V>` despecializes to a list of tuples, never an
 * object keyed by data — and `toCloneable` refuses an input plain object that
 * already carries the key, so the encoding needs no escaping scheme.
 */
const TAG = "polyengine.cloneable/1";

/** The tag value used for an unbranded `Error` (the contract's `error` row). */
const TAG_ERROR = "error";

/** Options for {@link toCloneable}. */
export interface ToCloneableOptions {
  /**
   * Called for realm-local leaves instead of throwing; the substitute is
   * walked in turn. Returning `undefined` (or the leaf itself) falls back to
   * the refusal.
   */
  replace?: (leaf: object, path: string) => unknown;
}

/**
 * Convert `v` into plain data safe for `structuredClone`/`postMessage` — no
 * transfer list required (contracts/embedder-api.md §"Realm boundaries…").
 *
 * Branded errors, error-contexts and wasi exit unwinds become envelopes;
 * containers are rebuilt fresh; realm-local values (streams, stream writers,
 * futures, pollables, resource wrappers) are REFUSED with an
 * `InvalidHandleError` naming the path to the offending leaf — proxy the
 * interface, not the handle.
 *
 * @throws InvalidHandleError for realm-local leaves (unless `replace`
 *   substitutes).
 * @throws TypeError for functions, symbols, cyclic values, foreign
 *   prototypes, and input plain objects already carrying the envelope tag.
 */
export function toCloneable(v: unknown, opts?: ToCloneableOptions): unknown {
  return encode(v, "value", new Set<object>(), opts ?? {});
}

/**
 * Rehydrate `toCloneable` output (typically after a structured clone) into
 * values branded by THIS copy.
 *
 * The round-trip law: `fromCloneable(structuredClone(toCloneable(v)))` is
 * behaviorally indistinguishable from `v` for every matcher the embedder
 * contract offers — the recognition predicates, `payload`/`kind`/`value`
 * access, `message`, `cause` chains, `progress`, error-context `message`.
 * `stack` is carried verbatim when present: the sender's stack is the
 * diagnostically useful one, the rehydration site's is noise.
 *
 * @throws TypeError for an unknown tag (the envelope is version-internal, so
 *   an unknown tag means mixed engine versions — outside the supported
 *   matrix, and failing loud beats a half-rehydrated tree), and for cyclic
 *   input.
 */
export function fromCloneable(data: unknown): unknown {
  return decode(data, "value", new Set<object>());
}

// ---------------------------------------------------------------------------
// Paths (every refusal MUST name the path to the offending leaf — that is the
// proxy author's debugging surface). Root spelling: "value".
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function childPath(path: string, key: string): string {
  return IDENT.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function indexPath(path: string, i: number): string {
  return `${path}[${i}]`;
}

// ---------------------------------------------------------------------------
// Shape predicates
// ---------------------------------------------------------------------------

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isBinary(v: object): boolean {
  // Passed through BY REFERENCE: the serializer copies them for us.
  return ArrayBuffer.isView(v) || v instanceof ArrayBuffer ||
    typeof SharedArrayBuffer === "function" && v instanceof SharedArrayBuffer;
}

// CONTRACT: the walk section says both "refuse … objects with any other
// prototype" and "`Map`/`Set`/`Date`/`RegExp` and other platform clonables …
// are passed through unwalked". "Other platform clonables" is an open set,
// and no structural test distinguishes a clonable host object from an
// arbitrary class instance. Conservative reading: an explicit allowlist of
// the named cases plus the few universally-clonable platform types, and
// TypeError for every other prototype — refusing loudly at the sender beats
// handing the serializer something it will reject anyway with a worse
// message. See contracts/embedder-api.md §"Realm boundaries…".
const CLONABLE_EXOTICS = [
  "Date",
  "RegExp",
  "Map",
  "Set",
  "Blob",
  "File",
  "DOMException",
] as const;

function isPassThroughExotic(v: object): boolean {
  for (const name of CLONABLE_EXOTICS) {
    const ctor = (globalThis as Record<string, unknown>)[name];
    if (typeof ctor === "function" && v instanceof (ctor as ErrorConstructor)) {
      return true;
    }
  }
  return false;
}

/**
 * Realm-local check: `isRealmLocal` (the pill), the stateful handle
 * brands, and resource wrappers.
 *
 * `STREAM_WRITER` is listed for consistency with the other
 * stateful handle brands, not because it changes behavior here: every
 * `StreamWriter` already carries the realm-local pill (`defineRealmLocal` in its
 * constructor, runtime/src/embedder/streams.ts), so `isRealmLocal(v)` above
 * already refuses one — this is belt-and-suspenders against a hand-rolled
 * writer that carries the brand but skipped the pill.
 *
 * `RESOURCE_STATE` is checked with `!== undefined` rather than `hasBrand`
 * because it holds the wrapper's internal STATE object, not `true` — only the
 * key is contract, the shape stays runtime-internal (brands.ts).
 */
function isRealmLocalValue(v: object): boolean {
  return isRealmLocal(v) ||
    hasBrand(v, STREAM) || hasBrand(v, FUTURE) || hasBrand(v, POLLABLE) ||
    hasBrand(v, STREAM_WRITER) ||
    (v as Record<symbol, unknown>)[RESOURCE_STATE] !== undefined;
}

function refuseRealmLocal(path: string): never {
  throw new InvalidHandleError(
    `${path} is realm-local and cannot be made cloneable: its machinery ` +
      `lives in the realm that minted it, so a copy in another realm could ` +
      `only ever be a husk. Proxy the interface, not the handle ` +
      `(contracts/embedder-api.md §"Realm boundaries and ` +
      `structured-clone-safe forms"; issue #131).`,
  );
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** The envelope-encodable brands, in detection order (contract table). */
const ERROR_BRANDS: ReadonlyArray<symbol> = [
  COMPONENT_EXCEPTION,
  TRAP,
  DROPPED,
  INVALID_HANDLE,
  PEER_TRAPPED,
  STREAM_PRODUCER,
];

function messageOf(v: object): string {
  const m = (v as { message?: unknown }).message;
  return typeof m === "string" ? m : m === undefined ? "" : String(m);
}

function encode(
  v: unknown,
  path: string,
  seen: Set<object>,
  opts: ToCloneableOptions,
): unknown {
  switch (typeof v) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "undefined":
      return v;
    case "function":
      throw new TypeError(
        `${path} is a function, which structured clone cannot carry ` +
          `(contracts/embedder-api.md §"Realm boundaries…").`,
      );
    case "symbol":
      throw new TypeError(
        `${path} is a symbol, which structured clone cannot carry ` +
          `(contracts/embedder-api.md §"Realm boundaries…").`,
      );
  }
  if (v === null) return null;

  const o = v as object;
  if (seen.has(o)) {
    throw new TypeError(
      `${path} is a cyclic reference. WIT values have no aliasing ` +
        `semantics, so a genuine cycle is refused rather than looped over ` +
        `(contracts/embedder-api.md §"Realm boundaries…").`,
    );
  }

  // Envelope-encodable brands take precedence over the realm-local pill: an
  // `ErrorContext` instance carries BOTH (it is a lifted handle and a message
  // carrier), and it encodes — error-context is message-valued at lowering.
  for (const brand of ERROR_BRANDS) {
    if (hasBrand(o, brand)) {
      return encodeBrandedError(o, brand, path, seen, opts);
    }
  }
  if (hasBrand(o, ERROR_CONTEXT)) {
    // An error-context's whole state is its debug message (definitions.py),
    // so the message IS the encoding.
    return { [TAG]: "polyengine.errorContext/1", message: messageOf(o) };
  }
  if (hasBrand(o, WASI_EXIT)) {
    const e: Record<string, unknown> = {
      [TAG]: "polyengine.wasiExit/1",
      message: messageOf(o),
      ok: (o as { ok?: unknown }).ok,
    };
    withStack(e, o);
    const code = (o as { code?: unknown }).code;
    if (code !== undefined) e.code = code;
    return e;
  }

  if (isRealmLocalValue(o)) {
    const sub = opts.replace?.(o, path);
    if (sub === undefined || sub === o) refuseRealmLocal(path);
    return encode(sub, path, seen, opts);
  }

  if (o instanceof Error) {
    // Unbranded `Error` — the contract's `error` row: name, message, stack?,
    // cause? (walked).
    //
    // The `cause` field is why the row exists. Cause chains are walked to
    // their full depth through branded and unbranded links alike, and the
    // canonical case runs THROUGH an unbranded link: a `PeerTrappedError`'s
    // cause is the runtime's recorded poisoning failure — a plain
    // `new Error(msg, { cause })` (runtime/src/task/streams.ts:876-883) —
    // whose own cause is the underlying branded `Trap`. Flattening here
    // would drop the trap at the bottom of every peer-fault chain, and a
    // proxy could no longer tell a peer fault from a clean drop's cousin.
    const e: Record<string, unknown> = {
      [TAG]: TAG_ERROR,
      name: String(o.name),
      message: messageOf(o),
    };
    withStack(e, o);
    seen.add(o);
    try {
      // Own-property-present only, exactly as for the branded rows: absent
      // and `undefined`-valued are different states.
      if (Object.prototype.hasOwnProperty.call(o, "cause")) {
        e.cause = encode(
          (o as { cause?: unknown }).cause,
          childPath(path, "cause"),
          seen,
          opts,
        );
      }
    } finally {
      seen.delete(o);
    }
    return e;
  }

  if (isBinary(o)) return o;
  if (Array.isArray(o)) {
    seen.add(o);
    try {
      return o.map((el, i) => encode(el, indexPath(path, i), seen, opts));
    } finally {
      seen.delete(o);
    }
  }
  if (isPlainObject(o)) {
    if (Object.prototype.hasOwnProperty.call(o, TAG)) {
      throw new TypeError(
        `${path} already carries the envelope tag ${JSON.stringify(TAG)}. ` +
          `The encoding has no escaping scheme by design ` +
          `(contracts/embedder-api.md §"Realm boundaries…").`,
      );
    }
    seen.add(o);
    try {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) {
        out[k] = encode(val, childPath(path, k), seen, opts);
      }
      return out;
    } finally {
      seen.delete(o);
    }
  }
  if (isPassThroughExotic(o)) return o;

  throw new TypeError(
    `${path} has a prototype the cloneable form does not cover ` +
      `(${describeProto(o)}). Only plain objects, arrays, binary data and ` +
      `the branded taxonomy cross a realm boundary ` +
      `(contracts/embedder-api.md §"Realm boundaries…").`,
  );
}

function describeProto(o: object): string {
  const ctor = (o as { constructor?: { name?: unknown } }).constructor;
  const name = ctor?.name;
  return typeof name === "string" && name !== "" ? name : "unknown";
}

function withStack(e: Record<string, unknown>, o: object): void {
  const stack = (o as { stack?: unknown }).stack;
  if (typeof stack === "string") e.stack = stack;
}

function encodeBrandedError(
  o: object,
  brand: symbol,
  path: string,
  seen: Set<object>,
  opts: ToCloneableOptions,
): Record<string, unknown> {
  const e: Record<string, unknown> = {
    [TAG]: Symbol.keyFor(brand),
    message: messageOf(o),
  };
  withStack(e, o);
  seen.add(o);
  try {
    // `cause` rides only when the own property is actually present: absent and
    // `undefined`-valued are different states, and `new Error(m)` leaves it
    // absent.
    if (Object.prototype.hasOwnProperty.call(o, "cause")) {
      e.cause = encode(
        (o as { cause?: unknown }).cause,
        childPath(path, "cause"),
        seen,
        opts,
      );
    }
    if (brand === PEER_TRAPPED) {
      const progress = (o as { progress?: unknown }).progress;
      if (progress !== undefined) e.progress = progress;
    }
    if (brand === COMPONENT_EXCEPTION) {
      // Always present, even when `undefined`: an empty err side is a real
      // payload (`ComponentException.payload === undefined`).
      e.payload = encode(
        (o as { payload?: unknown }).payload,
        childPath(path, "payload"),
        seen,
        opts,
      );
    }
  } finally {
    seen.delete(o);
  }
  return e;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function decode(v: unknown, path: string, seen: Set<object>): unknown {
  if (v === null || typeof v !== "object") return v;
  const o = v as object;
  if (seen.has(o)) {
    throw new TypeError(`${path} is a cyclic reference.`);
  }
  if (isBinary(o)) return o;
  if (Array.isArray(o)) {
    seen.add(o);
    try {
      return o.map((el, i) => decode(el, indexPath(path, i), seen));
    } finally {
      seen.delete(o);
    }
  }
  if (!isPlainObject(o)) return o;

  if (Object.prototype.hasOwnProperty.call(o, TAG)) {
    return rehydrate(o as Record<string, unknown>, path, seen);
  }
  seen.add(o);
  try {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      out[k] = decode(val, childPath(path, k), seen);
    }
    return out;
  } finally {
    seen.delete(o);
  }
}

function restoreStack(e: Error, env: Record<string, unknown>): void {
  // Verbatim when carried; otherwise the locally-generated stack stands.
  if (typeof env.stack === "string") e.stack = env.stack;
}

function restoreCause(
  e: Error,
  env: Record<string, unknown>,
  path: string,
  seen: Set<object>,
): void {
  if (!Object.prototype.hasOwnProperty.call(env, "cause")) return;
  Object.defineProperty(e, "cause", {
    value: decode(env.cause, childPath(path, "cause"), seen),
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function rehydrate(
  env: Record<string, unknown>,
  path: string,
  seen: Set<object>,
): unknown {
  const tag = env[TAG];
  const message = typeof env.message === "string" ? env.message : "";
  seen.add(env);
  try {
    switch (tag) {
      case "polyengine.componentException/1": {
        // Exact by construction: the explicit `message` argument bypasses the
        // derived-message path entirely.
        const e = new ComponentException(
          decode(env.payload, childPath(path, "payload"), seen),
          message,
        );
        restoreStack(e, env);
        restoreCause(e, env, path, seen);
        return e;
      }
      case "polyengine.trap/1": {
        const e = new Trap(message);
        restoreStack(e, env);
        restoreCause(e, env, path, seen);
        return e;
      }
      case "polyengine.dropped/1": {
        const e = new DroppedError(message);
        restoreStack(e, env);
        restoreCause(e, env, path, seen);
        return e;
      }
      case "polyengine.invalidHandle/1": {
        const e = new InvalidHandleError(message);
        restoreStack(e, env);
        restoreCause(e, env, path, seen);
        return e;
      }
      case "polyengine.peerTrapped/1": {
        // These two classes DERIVE their message from constructor arguments,
        // so they are built with a placeholder site and the message is then
        // restored verbatim — the sender's wording is the contract, not this
        // realm's reconstruction of it.
        const cause = decode(env.cause, childPath(path, "cause"), seen);
        const progress = typeof env.progress === "number"
          ? env.progress
          : undefined;
        const e = new PeerTrappedError("", cause, progress);
        e.message = message;
        restoreStack(e, env);
        return e;
      }
      case "polyengine.streamProducer/1": {
        const cause = decode(env.cause, childPath(path, "cause"), seen);
        const e = new StreamProducerError("", cause);
        e.message = message;
        restoreStack(e, env);
        return e;
      }
      case "polyengine.errorContext/1": {
        // A branded plain object, which the runtime accepts at lowering by
        // minting a fresh LOCAL context (error-context is
        // message-valued).
        const ctx = { message };
        defineBrand(ctx, ERROR_CONTEXT);
        return ctx;
      }
      case "polyengine.wasiExit/1": {
        // The protocol package does not import the wasi package — the BRAND
        // is the contract, so the exit unwind is hand-rolled here.
        const e = Object.assign(new Error(message), {
          ok: env.ok,
        }) as unknown as
          & Error
          & Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(env, "code")) {
          e.code = env.code;
        }
        e.name = "ExitError";
        defineBrand(e, WASI_EXIT);
        restoreStack(e, env);
        return e;
      }
      case TAG_ERROR: {
        const e = new Error(message);
        if (typeof env.name === "string") e.name = env.name;
        restoreStack(e, env);
        // Same descriptor convention as the branded rows: `cause` restored
        // only when carried, and non-enumerable/writable/configurable, which
        // is what `new Error(m, { cause })` produces natively.
        restoreCause(e, env, path, seen);
        return e;
      }
    }
  } finally {
    seen.delete(env);
  }
  throw new TypeError(
    `${path} carries an unknown cloneable tag ${
      JSON.stringify(String(tag))
    }. ` +
      `The envelope is version-internal, so an unknown tag means the two ` +
      `realms run different engine versions — outside the supported matrix ` +
      `(contracts/embedder-api.md §"Realm boundaries and ` +
      `structured-clone-safe forms").`,
  );
}
