// `wasi:http@0.3` — the OUTBOUND half (`types` + `client`), served over
// `fetch`. À la carte (`@polyengine/wasi/http`): fetch is universal across
// the JS runtimes, but this fragment grants NETWORK EGRESS — unscoped,
// with no allowlist or address check (docs/security.md) — and the
// default `wasi()` merge carries only ambient, side-effect-benign
// capabilities (mod.ts "COMPOSITION") — portability is not the
// criterion, capability is.
//
// Interfaces served (WIT: wasi:http 0.3.1, released with the WASI 0.3
// consolidation — WebAssembly/WASI v0.3.1, proposals/http/wit; vendored
// copy for the fixture guest under examples/guests/http-fetch/wit):
//
//   wasi:http/types@0.3  — resources fields, request, request-options,
//                          response (constructors and all accessors)
//   wasi:http/client@0.3 — send: async func(request) -> result<response, error-code>
//
// `handler` (the middleware-chain interface, same shape as `client`) is
// deliberately NOT registered: serving a middleware's upstream from fetch
// would silently flatten a chain into the network. An embedder that means
// exactly that can register this fragment's `send` under its own handler
// key.
//
// VERSION KEYS: 0.3.x releases fold onto the `@0.3` compatibility track
// (contracts/embedder-api.md §"Version canonicalization"), so the
// default registration serves every released 0.3.x with one provider —
// the same flagship track-key pattern as the rest of this package. The
// pre-consolidation rc SNAPSHOTS (`0.3.0-rc-*`) are prereleases, which
// resolve exact-only: a guest pinned to one names it via
// `http({ version: "0.3.0-rc-..." })`, which re-keys the fragment at
// that exact id instead.
//
// Body/trailers plumbing is the same stream+future choreography the TCP
// provider proved: constructors return `[resource, transmission-future]`
// (the future is a Promise — embedder-api.md §"Streams and futures"
// lowers it as the future source), `consume-body` returns
// `[stream<u8>, trailers-future]`, and guest-abandoned streams are
// retired by the runtime's producer-cancellation machinery
// (`ReadableStream` sources are cancel()ed, which aborts the underlying
// fetch body).
//
// Recorded divergences (fetch exposes no lower transport):
//
//   * Redirects are NOT followed (`redirect: "manual"`, matching
//     wasmtime's plain-transport behavior); in BROWSERS a manual redirect
//     is an opaque response (the platform hides the 3xx), a
//     browser-only divergence.
//   * Request trailers cannot be transmitted (fetch has no trailer
//     channel): a trailers future resolving `some(trailers)` fails the
//     transmission with `internal-error` rather than silently dropping
//     data; resolving to an ERROR aborts the request, per the WIT.
//     Response trailers always resolve `none` (fetch cannot read them).
//   * Request bodies are BUFFERED before transmission (streaming request
//     bodies via `duplex: "half"` are not universal); the transmission
//     future settles only after the fetch, so the guest still observes
//     truthful completion. Response bodies stream through unbuffered.
//   * `set-connect-timeout` answers `not-supported` (fetch exposes no
//     connect phase); first-byte and between-bytes timeouts are REAL,
//     enforced with timers around the response-body reads.
//   * Platform-managed headers (host, content-length, and the rest of
//     fetch's forbidden list) are silently owned by the platform, not by
//     the `fields` the guest set.
//
// Error model: `client.send` and the fallible fields/options methods
// throw branded `ComponentException`s whose payloads use the WIT case
// names VERBATIM (`DNS-timeout`, `TLS-protocol-error`, `internal-error` —
// embedder-api.md §"Naming and casing": case names are data, kebab-case
// as written, including capitals).
// Fetch failures are TypeErrors with prose; a small sniff table maps the
// recognizable ones and everything else is `internal-error(message)`.

import { ComponentException, isComponentException, type Stream } from "@polyengine/protocol";

/**
 * The compatibility track the fragment registers on by default.
 *
 * @internal — test-only export; wasi/tests/http_test.ts pins the default
 * track literally, but the public entry point is `http()`.
 */
export const HTTP_TRACK = "0.3";

// --- WIT value shapes -----------------------------------------------------------

/** `method` — case names verbatim (embedder-api.md §"Naming and casing"). */
export type Method =
  | { kind: "get" }
  | { kind: "head" }
  | { kind: "post" }
  | { kind: "put" }
  | { kind: "delete" }
  | { kind: "connect" }
  | { kind: "options" }
  | { kind: "trace" }
  | { kind: "patch" }
  | { kind: "other"; value: string };

/** `scheme` — case names verbatim (the WIT capitalizes HTTP/HTTPS). */
export type Scheme =
  | { kind: "HTTP" }
  | { kind: "HTTPS" }
  | { kind: "other"; value: string };

/**
 * `error-code` — the case-name vocabulary, verbatim. Only the cases this
 * provider can actually emit are listed with payload shapes; the guest
 * switches against strings either way.
 */
export type ErrorCode = { kind: string; value?: unknown };

/** `header-error` (0.3.1 added `size-exceeded` and `other`). */
export type HeaderError =
  | { kind: "invalid-syntax" | "forbidden" | "immutable" | "size-exceeded" }
  | { kind: "other"; value?: string };

/** `request-options-error` (0.3.1 added `other`). */
export type RequestOptionsError =
  | { kind: "not-supported" | "immutable" }
  | { kind: "other"; value?: string };

/**
 * `result<option<trailers>, error-code>` AS A VALUE (trailers futures).
 * The ok side CARRIES a payload (`option<trailers>`), so `ok(none)` is
 * `{ kind: "ok", value: undefined }` — the `value` key must be present
 * (outermost-option-as-undefined; the adapter requires the key on
 * payload-carrying cases).
 */
export type TrailersResult =
  | { kind: "ok"; value: Fields | undefined }
  | { kind: "err"; value: ErrorCode };

/** `result<_, error-code>` AS A VALUE (transmission futures). */
export type HttpResult = { kind: "ok" } | { kind: "err"; value: ErrorCode };

const OK: HttpResult = { kind: "ok" };

function httpError(payload: ErrorCode, detail: string): ComponentException<ErrorCode> {
  return new ComponentException<ErrorCode>(payload, `wasi:http: ${detail}`);
}

function headerError(
  kind: "invalid-syntax" | "forbidden" | "immutable" | "size-exceeded",
  detail: string,
): ComponentException<HeaderError> {
  return new ComponentException<HeaderError>({ kind }, `wasi:http/types: ${detail}`);
}

/**
 * Map a fetch failure onto `error-code` (sniff table + honest catch-all).
 *
 * @internal — used only inside this module's `send` implementation; no
 * importer outside wasi/src/http.ts. The public entry point is `http()`.
 */
export function mapFetchError(e: unknown): ErrorCode {
  // Deno/undici wrap the transport detail in the `cause` chain; sniff the
  // whole chain, report the top-level message.
  let message = e instanceof Error ? e.message : String(e);
  const parts: string[] = [];
  for (let at: unknown = e; at instanceof Error; at = at.cause) parts.push(at.message);
  const m = parts.join(" | ").toLowerCase();
  message = parts[0] ?? message;
  if (m.includes("refused")) return { kind: "connection-refused" };
  if (m.includes("dns error") || m.includes("name not resolved") || m.includes("getaddrinfo")) {
    return { kind: "DNS-error", value: { rcode: undefined, infoCode: undefined } };
  }
  if (m.includes("timed out") || m.includes("timeout")) return { kind: "connection-timeout" };
  if (m.includes("tls") || m.includes("certificate") || m.includes("ssl")) {
    return { kind: "TLS-protocol-error" };
  }
  if (m.includes("reset")) return { kind: "connection-terminated" };
  return { kind: "internal-error", value: message };
}

// --- the sources host methods accept --------------------------------------------

/** What body params accept: the lifted handle, or any natural byte producer. */
export type BodySource =
  | Stream<number>
  | AsyncIterable<Uint8Array | number[]>
  | Iterable<Uint8Array | number[]>;

/** What future params accept: the lifted handle or a promise of the value. */
export type FutureLike<T> = PromiseLike<T>;

/** Collect a body source to bytes (the buffered-request divergence). */
async function collectBody(source: BodySource): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source as AsyncIterable<Uint8Array | number[]>) {
    const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
    chunks.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// --- field syntax ---------------------------------------------------------------

/** RFC 9110 token (field-name). */
const FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function validFieldValue(v: Uint8Array): boolean {
  // No NUL / CR / LF — the transport-splitting bytes.
  return !v.some((b) => b === 0x00 || b === 0x0a || b === 0x0d);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface HttpOptions {
  /**
   * Override the registration keys for a guest pinned to a PRERELEASE
   * snapshot (`0.3.0-rc-*`), which the resolver matches exactly — no
   * track exists for prereleases. Default: the `@0.3` track, serving
   * every released 0.3.x.
   */
  version?: string;
  /** Observe every entry point the guest reaches (see sockets' onCall). */
  onCall?: (call: string) => void;
  /**
   * Name-level egress policy, evaluated in `client.send` after the outgoing
   * request is assembled (method, headers) but before its body is
   * collected — so a refused request never drains the guest's body
   * stream. `true`/default preserves today's behavior exactly (unscoped
   * egress); `false` denies every request without dispatching `fetch`; a
   * callback decides per request from the parsed `url`, `method`, and
   * `headers`.
   *
   * This is the name-level half only: it sees the URL a guest asked for,
   * matching what a `fetch`-based host can express (no resolved address
   * is ever observed here, unlike a native socket layer). The
   * address-level half (`socket_addr_check`-shaped, e.g. blocking a
   * name that resolves to a loopback/link-local address) is issue #200
   * and is out of scope for this fragment; `sockets()` is unaffected.
   *
   * A callback that throws, or whose returned promise rejects, DENIES
   * (fail closed) — a security predicate must never fail open. Denials
   * refuse with the WIT `HTTP-request-denied` error-code case
   * (examples/guests/http-fetch/wit/deps/wasi-http/types.wit); this is
   * distinct from `destination-IP-prohibited`, which names an address
   * judgement this fragment cannot make.
   */
  allowRequest?: boolean | ((request: {
    url: URL;
    method: string;
    headers: Headers;
  }) => boolean | Promise<boolean>);
  /**
   * Injectable transport: replaces the `fetch(request)` call `client.send`
   * otherwise makes directly. Default (when omitted): `globalThis.fetch`,
   * resolved AT CALL TIME — not captured when `http()` constructs the
   * fragment — so stubbing `globalThis.fetch` after the fragment exists
   * still takes effect.
   *
   * The `Request` handed to the transport already carries this
   * fragment's hardening (`redirect: "manual"`, `cache: "no-store"`,
   * `credentials: "omit"`). A transport that forwards to the real
   * `fetch` with its own `init` can override these — re-enabling
   * redirect-following in particular would break the property that every
   * redirect hop re-enters `send` and is re-checked by `allowRequest`.
   * The transport is trusted embedder code; this is a caution, not a
   * hole.
   *
   * `request.clone()` is how to inspect the body without consuming it,
   * so a transport can peek (e.g. for logging) and still forward the
   * original request.
   *
   * A transport that throws a branded `ComponentException` names the
   * guest-visible WIT error-code exactly (the fragment rethrows it
   * unchanged); anything else it throws is mapped by this fragment's
   * `mapFetchError` sniffing, which usually lands on `internal-error`.
   */
  fetch?: (request: globalThis.Request) => Promise<globalThis.Response>;
}

/** What `http()` returns: the imports fragment plus the fragment's classes. */
export interface HttpFragment {
  imports: Record<string, unknown>;
  Fields: FieldsClass;
  Request: RequestClass;
  RequestOptions: RequestOptionsClass;
  Response: ResponseClass;
  /** The `client.send` impl, exposed so an embedder may re-key it (e.g. as a handler). */
  send: HttpSend;
}

/** The `client.send` shape (module-scope names: the public interfaces). */
export type HttpSend = (request: Request) => Promise<Response>;

// Public instance/class shapes (the classes themselves are built per
// fragment, for the onCall scoping — same pattern as sockets).

export interface Fields {
  get(name: string): Uint8Array[];
  has(name: string): boolean;
  set(name: string, value: Uint8Array[]): void;
  delete(name: string): void;
  getAndDelete(name: string): Uint8Array[];
  append(name: string, value: Uint8Array): void;
  copyAll(): [string, Uint8Array][];
  clone(): Fields;
  [Symbol.dispose](): void;
}
export interface FieldsClass {
  new (): Fields;
  fromList(entries: [string, Uint8Array][]): Fields;
}

export interface Request {
  getMethod(): Method;
  setMethod(method: Method): void;
  getPathWithQuery(): string | undefined;
  setPathWithQuery(pathWithQuery: string | undefined): void;
  getScheme(): Scheme | undefined;
  setScheme(scheme: Scheme | undefined): void;
  getAuthority(): string | undefined;
  setAuthority(authority: string | undefined): void;
  getOptions(): RequestOptions | undefined;
  getHeaders(): Fields;
  [Symbol.dispose](): void;
}
export interface RequestClass {
  "new"(
    headers: Fields,
    contents: BodySource | undefined,
    trailers: FutureLike<TrailersResult>,
    options: RequestOptions | undefined,
  ): [Request, Promise<HttpResult>];
  consumeBody(
    request: Request,
    res: FutureLike<HttpResult>,
  ): [AsyncIterable<Uint8Array>, Promise<TrailersResult>];
}

export interface RequestOptions {
  getConnectTimeout(): bigint | undefined;
  setConnectTimeout(duration: bigint | undefined): void;
  getFirstByteTimeout(): bigint | undefined;
  setFirstByteTimeout(duration: bigint | undefined): void;
  getBetweenBytesTimeout(): bigint | undefined;
  setBetweenBytesTimeout(duration: bigint | undefined): void;
  clone(): RequestOptions;
  [Symbol.dispose](): void;
}
export interface RequestOptionsClass {
  new (): RequestOptions;
}

export interface Response {
  getStatusCode(): number;
  setStatusCode(statusCode: number): void;
  getHeaders(): Fields;
  [Symbol.dispose](): void;
}
export interface ResponseClass {
  "new"(
    headers: Fields,
    contents: BodySource | undefined,
    trailers: FutureLike<TrailersResult>,
  ): [Response, Promise<HttpResult>];
  consumeBody(
    response: Response,
    res: FutureLike<HttpResult>,
  ): [AsyncIterable<Uint8Array>, Promise<TrailersResult>];
}

/**
 * `wasi:http` provider fragment (exact version keys — see the module
 * header). The resource classes are built per fragment so the `onCall`
 * observer is scoped to it.
 */
export function http(options: HttpOptions = {}): HttpFragment {
  const onCall = options.onCall ?? ((): void => {});
  const v = options.version ?? HTTP_TRACK;
  const allowRequest = options.allowRequest;

  // --- fields -----------------------------------------------------------------

  class Fields {
    /** Entries in original casing and insertion order. */
    entries: [string, Uint8Array][] = [];
    mutable = true;

    constructor() {
      onCall("fields.constructor");
    }

    static fromList(entries: [string, Uint8Array][]): Fields {
      onCall("fields.from-list");
      const f = internalFields([], true);
      for (const [name, value] of entries) {
        if (!FIELD_NAME.test(name)) {
          throw headerError("invalid-syntax", `from-list: invalid field name ${JSON.stringify(name)}`);
        }
        if (!validFieldValue(value)) {
          throw headerError("invalid-syntax", `from-list: invalid value for ${JSON.stringify(name)}`);
        }
        f.entries.push([name, value.slice()]);
      }
      return f;
    }

    get(name: string): Uint8Array[] {
      onCall("fields.get");
      const n = name.toLowerCase();
      return this.entries.filter(([k]) => k.toLowerCase() === n).map(([, v]) => v.slice());
    }

    has(name: string): boolean {
      onCall("fields.has");
      const n = name.toLowerCase();
      return this.entries.some(([k]) => k.toLowerCase() === n);
    }

    set(name: string, value: Uint8Array[]): void {
      onCall("fields.set");
      requireMutableFields(this, "fields.set");
      if (!FIELD_NAME.test(name)) {
        throw headerError("invalid-syntax", `set: invalid field name ${JSON.stringify(name)}`);
      }
      for (const one of value) {
        if (!validFieldValue(one)) {
          throw headerError("invalid-syntax", `set: invalid value for ${JSON.stringify(name)}`);
        }
      }
      const n = name.toLowerCase();
      this.entries = this.entries.filter(([k]) => k.toLowerCase() !== n);
      for (const one of value) this.entries.push([name, one.slice()]);
    }

    delete(name: string): void {
      onCall("fields.delete");
      requireMutableFields(this, "fields.delete");
      const n = name.toLowerCase();
      this.entries = this.entries.filter(([k]) => k.toLowerCase() !== n);
    }

    getAndDelete(name: string): Uint8Array[] {
      onCall("fields.get-and-delete");
      requireMutableFields(this, "fields.get-and-delete");
      const n = name.toLowerCase();
      const out = this.entries.filter(([k]) => k.toLowerCase() === n).map(([, v]) => v);
      this.entries = this.entries.filter(([k]) => k.toLowerCase() !== n);
      return out;
    }

    append(name: string, value: Uint8Array): void {
      onCall("fields.append");
      requireMutableFields(this, "fields.append");
      if (!FIELD_NAME.test(name)) {
        throw headerError("invalid-syntax", `append: invalid field name ${JSON.stringify(name)}`);
      }
      if (!validFieldValue(value)) {
        throw headerError("invalid-syntax", `append: invalid value for ${JSON.stringify(name)}`);
      }
      this.entries.push([name, value.slice()]);
    }

    copyAll(): [string, Uint8Array][] {
      onCall("fields.copy-all");
      return this.entries.map(([k, v]) => [k, v.slice()]);
    }

    clone(): Fields {
      onCall("fields.clone");
      return internalFields(this.entries.map(([k, v]) => [k, v.slice()]), true);
    }

    [Symbol.dispose](): void {
      // Plain data; nothing to release.
    }
  }

  /** Mutability guard usable on Object.create-minted views (no #-brand). */
  function requireMutableFields(f: Fields, what: string): void {
    if (!f.mutable) {
      throw headerError("immutable", `${what}: these fields are immutable`);
    }
  }

  /** Mint a Fields without the WIT constructor's onCall. */
  function internalFields(entries: [string, Uint8Array][], mutable: boolean): Fields {
    const f = Object.create(Fields.prototype) as Fields;
    f.entries = entries;
    f.mutable = mutable;
    return f;
  }

  function fieldsFromFetchHeaders(h: Headers): Fields {
    const entries: [string, Uint8Array][] = [];
    h.forEach((value, name) => entries.push([name, encoder.encode(value)]));
    return internalFields(entries, false);
  }

  // --- request-options ----------------------------------------------------------

  class RequestOptions {
    connectTimeout: bigint | undefined;
    firstByteTimeout: bigint | undefined;
    betweenBytesTimeout: bigint | undefined;
    mutable = true;

    constructor() {
      onCall("request-options.constructor");
    }

    getConnectTimeout(): bigint | undefined {
      onCall("request-options.get-connect-timeout");
      return this.connectTimeout;
    }
    setConnectTimeout(_duration: bigint | undefined): void {
      onCall("request-options.set-connect-timeout");
      requireMutableOptions(this, "set-connect-timeout");
      // fetch exposes no connect phase: storing the value would imply
      // enforcement that cannot happen — the honest answer is refusal.
      throw new ComponentException<RequestOptionsError>(
        { kind: "not-supported" },
        "wasi:http/types: set-connect-timeout: fetch exposes no connect phase",
      );
    }
    getFirstByteTimeout(): bigint | undefined {
      onCall("request-options.get-first-byte-timeout");
      return this.firstByteTimeout;
    }
    setFirstByteTimeout(duration: bigint | undefined): void {
      onCall("request-options.set-first-byte-timeout");
      requireMutableOptions(this, "set-first-byte-timeout");
      this.firstByteTimeout = duration;
    }
    getBetweenBytesTimeout(): bigint | undefined {
      onCall("request-options.get-between-bytes-timeout");
      return this.betweenBytesTimeout;
    }
    setBetweenBytesTimeout(duration: bigint | undefined): void {
      onCall("request-options.set-between-bytes-timeout");
      requireMutableOptions(this, "set-between-bytes-timeout");
      this.betweenBytesTimeout = duration;
    }
    clone(): RequestOptions {
      onCall("request-options.clone");
      const c = Object.create(RequestOptions.prototype) as RequestOptions;
      c.connectTimeout = this.connectTimeout;
      c.firstByteTimeout = this.firstByteTimeout;
      c.betweenBytesTimeout = this.betweenBytesTimeout;
      c.mutable = true;
      return c;
    }
    [Symbol.dispose](): void {
      // Plain data.
    }
  }

  /** Mutability guard usable on clone-minted options (no #-brand). */
  function requireMutableOptions(o: RequestOptions, what: string): void {
    if (!o.mutable) {
      throw new ComponentException<RequestOptionsError>(
        { kind: "immutable" },
        `wasi:http/types: ${what}: this request-options is immutable`,
      );
    }
  }

  // --- request --------------------------------------------------------------------

  class Request {
    method: Method = { kind: "get" };
    pathWithQuery: string | undefined;
    scheme: Scheme | undefined;
    authority: string | undefined;
    headers!: Fields;
    contents: BodySource | undefined;
    trailers!: FutureLike<TrailersResult>;
    options: RequestOptions | undefined;
    /** Settles the transmission future returned by `new`. */
    settleTransmission!: (r: HttpResult) => void;
    consumed = false;
    sent = false;

    private constructor() {}

    // The WIT static is literally named `new` — legal as a JS static.
    static "new"(
      headers: Fields,
      contents: BodySource | undefined,
      trailers: FutureLike<TrailersResult>,
      options: RequestOptions | undefined,
    ): [Request, Promise<HttpResult>] {
      onCall("request.new");
      const r = new Request();
      r.headers = headers;
      headers.mutable = false; // ownership transferred; views are immutable
      r.contents = contents;
      r.trailers = trailers;
      r.options = options;
      if (options !== undefined) options.mutable = false;
      const transmission = new Promise<HttpResult>((resolve) => {
        r.settleTransmission = resolve;
      });
      return [r, transmission];
    }

    getMethod(): Method {
      onCall("request.get-method");
      return this.method;
    }
    setMethod(method: Method): void {
      onCall("request.set-method");
      if (method.kind === "other" && !FIELD_NAME.test(method.value)) {
        throw new ComponentException<null>(null, "wasi:http/types: set-method: invalid method token");
      }
      this.method = method;
    }
    getPathWithQuery(): string | undefined {
      onCall("request.get-path-with-query");
      return this.pathWithQuery;
    }
    setPathWithQuery(pathWithQuery: string | undefined): void {
      onCall("request.set-path-with-query");
      if (pathWithQuery !== undefined && /[ \t\r\n#]/.test(pathWithQuery)) {
        throw new ComponentException<null>(null, "wasi:http/types: set-path-with-query: invalid path");
      }
      this.pathWithQuery = pathWithQuery;
    }
    getScheme(): Scheme | undefined {
      onCall("request.get-scheme");
      return this.scheme;
    }
    setScheme(scheme: Scheme | undefined): void {
      onCall("request.set-scheme");
      if (scheme?.kind === "other" && !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme.value)) {
        throw new ComponentException<null>(null, "wasi:http/types: set-scheme: invalid scheme");
      }
      this.scheme = scheme;
    }
    getAuthority(): string | undefined {
      onCall("request.get-authority");
      return this.authority;
    }
    setAuthority(authority: string | undefined): void {
      onCall("request.set-authority");
      if (authority !== undefined && /[ \t\r\n/#?@]/.test(authority.replace(/@/, ""))) {
        throw new ComponentException<null>(null, "wasi:http/types: set-authority: invalid authority");
      }
      this.authority = authority;
    }
    getOptions(): RequestOptions | undefined {
      onCall("request.get-options");
      return this.options;
    }
    getHeaders(): Fields {
      onCall("request.get-headers");
      return internalFields(this.headers.entries.map(([k, v]) => [k, v.slice()]), false);
    }

    static consumeBody(
      request: Request,
      res: FutureLike<HttpResult>,
    ): [AsyncIterable<Uint8Array>, Promise<TrailersResult>] {
      onCall("request.consume-body");
      return consumeStoredBody(request, res);
    }

    [Symbol.dispose](): void {
      // A request dropped without transmission: the transmission future
      // must still settle (a pending future the guest awaits would
      // otherwise hang forever).
      if (!this.sent && !this.consumed) {
        this.settleTransmission({
          kind: "err",
          value: { kind: "internal-error", value: "request dropped without being sent" },
        });
      }
    }
  }

  // --- response -------------------------------------------------------------------

  class Response {
    statusCode = 200;
    headers!: Fields;
    /** Guest-constructed responses carry sources; fetch responses carry the body. */
    contents: BodySource | undefined;
    trailers: FutureLike<TrailersResult> | undefined;
    fetchBody: ReadableStream<Uint8Array> | null = null;
    settleTransmission: ((r: HttpResult) => void) | undefined;
    /** Timeouts inherited from the request's options (fetch responses). */
    firstByteTimeout: bigint | undefined;
    betweenBytesTimeout: bigint | undefined;
    consumed = false;

    private constructor() {}

    // The WIT static is literally named `new` — legal as a JS static.
    static "new"(
      headers: Fields,
      contents: BodySource | undefined,
      trailers: FutureLike<TrailersResult>,
    ): [Response, Promise<HttpResult>] {
      onCall("response.new");
      const r = new Response();
      r.headers = headers;
      headers.mutable = false;
      r.contents = contents;
      r.trailers = trailers;
      const transmission = new Promise<HttpResult>((resolve) => {
        r.settleTransmission = resolve;
      });
      return [r, transmission];
    }

    /** A response wrapping a live fetch result (internal). */
    static fromFetch(resp: globalThis.Response, options: RequestOptions | undefined): Response {
      const r = new Response();
      r.statusCode = resp.status;
      r.headers = fieldsFromFetchHeaders(resp.headers);
      r.fetchBody = resp.body;
      r.firstByteTimeout = options?.firstByteTimeout;
      r.betweenBytesTimeout = options?.betweenBytesTimeout;
      return r;
    }

    getStatusCode(): number {
      onCall("response.get-status-code");
      return this.statusCode;
    }
    setStatusCode(statusCode: number): void {
      onCall("response.set-status-code");
      if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) {
        throw new ComponentException<null>(null, "wasi:http/types: set-status-code: invalid status code");
      }
      this.statusCode = statusCode;
    }
    getHeaders(): Fields {
      onCall("response.get-headers");
      return internalFields(this.headers.entries.map(([k, v]) => [k, v.slice()]), false);
    }

    static consumeBody(
      response: Response,
      res: FutureLike<HttpResult>,
    ): [AsyncIterable<Uint8Array>, Promise<TrailersResult>] {
      onCall("response.consume-body");
      if (response.fetchBody !== null || (response.contents === undefined && response.trailers === undefined)) {
        return consumeFetchBody(response, res);
      }
      return consumeStoredBody(response, res);
    }

    [Symbol.dispose](): void {
      if (this.fetchBody !== null && !this.consumed) {
        this.fetchBody.cancel().catch(() => {
          // The connection is being discarded; failures have no audience.
        });
      }
      if (this.settleTransmission !== undefined && !this.consumed) {
        this.settleTransmission({
          kind: "err",
          value: { kind: "internal-error", value: "response dropped without being sent" },
        });
      }
    }
  }

  // --- body consumption (shared) ---------------------------------------------------

  /** Consume a guest-constructed body: pass the stored sources through. */
  function consumeStoredBody(
    holder: {
      contents: BodySource | undefined;
      trailers: FutureLike<TrailersResult> | undefined;
      consumed: boolean;
      settleTransmission?: ((r: HttpResult) => void) | undefined;
      sent?: boolean;
    },
    res: FutureLike<HttpResult>,
  ): [AsyncIterable<Uint8Array>, Promise<TrailersResult>] {
    if (holder.consumed) {
      return [
        [],
        Promise.resolve<TrailersResult>({
          kind: "err",
          value: { kind: "internal-error", value: "body already consumed" },
        }),
      ] as unknown as [AsyncIterable<Uint8Array>, Promise<TrailersResult>];
    }
    holder.consumed = true;
    const contents = holder.contents;
    const trailers = holder.trailers ??
      Promise.resolve<TrailersResult>({ kind: "ok", value: undefined });
    // The consumer reports its outcome through `res`; that is what settles
    // the producer-side transmission future.
    const settle = holder.settleTransmission;
    if (settle !== undefined) {
      Promise.resolve(res).then(
        (r) => settle(r),
        () => settle({ kind: "err", value: { kind: "internal-error", value: "consumer failed" } }),
      );
    }
    const source = (async function* (): AsyncGenerator<Uint8Array> {
      if (contents === undefined) return;
      for await (const chunk of contents as AsyncIterable<Uint8Array | number[]>) {
        yield chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
      }
    })();
    return [source, Promise.resolve(trailers).then((t) => t)];
  }

  /** Consume a fetch response body, with the real byte timeouts. */
  function consumeFetchBody(
    response: Response,
    _res: FutureLike<HttpResult>,
  ): [AsyncIterable<Uint8Array>, Promise<TrailersResult>] {
    if (response.consumed) {
      return [
        [],
        Promise.resolve<TrailersResult>({
          kind: "err",
          value: { kind: "internal-error", value: "body already consumed" },
        }),
      ] as unknown as [AsyncIterable<Uint8Array>, Promise<TrailersResult>];
    }
    response.consumed = true;
    const body = response.fetchBody;
    let settle!: (t: TrailersResult) => void;
    const done = new Promise<TrailersResult>((resolve) => (settle = resolve));
    const firstByteMs = toMs(response.firstByteTimeout);
    const betweenBytesMs = toMs(response.betweenBytesTimeout);
    const source = (async function* (): AsyncGenerator<Uint8Array> {
      if (body === null) {
        settle({ kind: "ok", value: undefined }); // no trailers over fetch
        return;
      }
      const reader = body.getReader();
      let first = true;
      try {
        for (;;) {
          const timeoutMs = first ? firstByteMs : betweenBytesMs;
          let r: ReadableStreamReadResult<Uint8Array>;
          try {
            r = await readWithTimeout(reader, timeoutMs);
          } catch (e) {
            settle({
              kind: "err",
              value: e === TIMED_OUT
                ? { kind: first ? "HTTP-response-timeout" : "connection-read-timeout" }
                : mapFetchError(e),
            });
            return;
          }
          first = false;
          if (r.done) {
            settle({ kind: "ok", value: undefined }); // clean end; no trailers over fetch
            return;
          }
          if (r.value.length > 0) yield r.value;
        }
      } finally {
        settle({ kind: "ok", value: undefined }); // reader dropped: canceller observes
        reader.cancel().catch(() => {
          // Discarding the rest of the body; failures have no audience.
        });
        reader.releaseLock();
      }
    })();
    return [source, done];
  }

  const TIMED_OUT = Symbol("timed out");

  function toMs(ns: bigint | undefined): number | undefined {
    return ns === undefined ? undefined : Number(ns / 1_000_000n);
  }

  function readWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number | undefined,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    const read = reader.read();
    if (timeoutMs === undefined) return read;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(TIMED_OUT), timeoutMs);
      read.then(
        (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  // --- client.send over fetch --------------------------------------------------------

  async function send(request: Request): Promise<Response> {
    onCall("client.send");
    if (request.sent || request.consumed) {
      throw httpError(
        { kind: "internal-error", value: "request already sent or consumed" },
        "client.send: request already sent or consumed",
      );
    }
    request.sent = true;

    // URL assembly. Scheme defaults to HTTPS ("the implementation may
    // choose an appropriate default"); HTTP(S) requires an authority.
    const scheme = request.scheme === undefined
      ? "https"
      : request.scheme.kind === "other"
      ? request.scheme.value.toLowerCase()
      : request.scheme.kind.toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      throw httpError(
        { kind: "internal-error", value: `fetch cannot carry scheme '${scheme}'` },
        `client.send: unsupported scheme '${scheme}'`,
      );
    }
    if (request.authority === undefined) {
      throw httpError({ kind: "HTTP-request-URI-invalid" }, "client.send: no authority");
    }
    const path = request.pathWithQuery ?? "";
    const url = `${scheme}://${request.authority}${path.startsWith("/") || path === "" ? path : "/" + path}`;

    const method = request.method.kind === "other"
      ? request.method.value.toUpperCase()
      : request.method.kind.toUpperCase();

    const headers = new Headers();
    for (const [name, value] of request.headers.entries) {
      try {
        headers.append(name, decoder.decode(value));
      } catch (e) {
        throw httpError(
          { kind: "internal-error", value: `header '${name}' refused by the platform` },
          `client.send: ${e}`,
        );
      }
    }

    // Name-level egress policy (allowRequest). Only parse `url` when a
    // policy is actually configured — with no policy or `allowRequest:
    // true`, this path is byte-for-byte today's behavior (same string
    // handed to fetch below, `URL.href` never substituted in). Placed
    // after headers, before collectBody: refusing must not drain the
    // guest's body stream.
    if (allowRequest !== undefined && allowRequest !== true) {
      if (allowRequest === false) {
        request.settleTransmission({ kind: "err", value: { kind: "HTTP-request-denied" } });
        throw httpError({ kind: "HTTP-request-denied" }, "client.send: request denied (allowRequest: false)");
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        // A malformed authority is not a policy decision — the existing
        // HTTP-request-URI-invalid case at line ~858 covers this.
        throw httpError({ kind: "HTTP-request-URI-invalid" }, "client.send: url could not be parsed for policy check");
      }
      let allowed: boolean;
      try {
        allowed = await allowRequest({ url: parsed, method, headers });
      } catch (e) {
        // Fail closed: a throwing/rejecting predicate denies. The thrown
        // message goes into the ComponentException's DETAIL string only,
        // never the WIT payload.
        request.settleTransmission({ kind: "err", value: { kind: "HTTP-request-denied" } });
        throw httpError(
          { kind: "HTTP-request-denied" },
          `client.send: allowRequest threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!allowed) {
        request.settleTransmission({ kind: "err", value: { kind: "HTTP-request-denied" } });
        throw httpError({ kind: "HTTP-request-denied" }, "client.send: request denied by allowRequest");
      }
    }

    // Buffered request body (module header divergence), then the trailers
    // future decides whether the request may be transmitted at all.
    let body: Uint8Array | undefined;
    if (request.contents !== undefined) {
      body = await collectBody(request.contents);
    }
    const trailersResult = await request.trailers;
    if (trailersResult.kind === "err") {
      // Per the WIT: a trailers error closes the underlying connection —
      // here, the request is never transmitted.
      const err: HttpResult = { kind: "err", value: trailersResult.value };
      request.settleTransmission(err);
      throw httpError(trailersResult.value, "client.send: request trailers resolved to an error");
    }
    if (trailersResult.value !== undefined) {
      const err: ErrorCode = {
        kind: "internal-error",
        value: "fetch cannot transmit request trailers",
      };
      request.settleTransmission({ kind: "err", value: err });
      throw httpError(err, "client.send: request trailers are not transmissible over fetch");
    }

    let resp: globalThis.Response;
    try {
      // Constructing the `Request` happens inside this try: a throw here
      // (e.g. a GET with a body) maps through mapFetchError exactly as a
      // fetch throw does, per the same catch below.
      const req = new globalThis.Request(url, {
        method,
        headers,
        body: body === undefined || body.length === 0 ? undefined : body,
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
      } as RequestInit);
      // Resolved at call time (not captured at http() construction), so
      // a test stubbing globalThis.fetch after the fragment exists still
      // takes effect.
      const transport = options.fetch ?? ((r: globalThis.Request) => globalThis.fetch(r));
      resp = await transport(req);
    } catch (e) {
      if (isComponentException(e)) {
        // Branded exception passthrough: the transport named the
        // guest-visible WIT error-code itself; do not run it through
        // mapFetchError's prose sniffing, and rethrow unchanged.
        request.settleTransmission({ kind: "err", value: e.payload as ErrorCode });
        throw e;
      }
      const code = mapFetchError(e);
      request.settleTransmission({ kind: "err", value: code });
      throw httpError(code, `client.send: ${e instanceof Error ? e.message : String(e)}`);
    }
    request.settleTransmission(OK);
    return Response.fromFetch(resp, request.options);
  }

  return {
    imports: {
      [`wasi:http/types@${v}`]: { Fields, Request, RequestOptions, Response },
      [`wasi:http/client@${v}`]: { send },
    },
    Fields: Fields as unknown as FieldsClass,
    Request: Request as unknown as RequestClass,
    RequestOptions: RequestOptions as unknown as RequestOptionsClass,
    Response: Response as unknown as ResponseClass,
    send: send as unknown as HttpSend,
  };
}
