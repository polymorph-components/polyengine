// Unit tests for the fetch-backed `wasi:http` provider (src/http.ts):
// fields semantics, the request/response state machines, and `client.send`
// against a live loopback `Deno.serve` — plus the recorded divergences
// (manual redirects, untransmissible request trailers, the real
// first-byte/between-bytes timeouts).
//
// Fallible methods must throw BRANDED ComponentExceptions; `error-code`
// case names are the WIT spellings VERBATIM (`DNS-timeout`,
// `internal-error` — capitals included).

import { ComponentException } from "@polyengine/protocol";
import {
  HTTP_TRACK,
  type ErrorCode,
  type Fields,
  http,
  type HttpResult,
  type Request,
  type Response,
  type TrailersResult,
} from "../src/http.ts";
import { assertEq, assertRejects, assertThrows, assertTrue } from "./asserts.ts";

const { Fields, Request, RequestOptions, Response, send, imports } = http();

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

function errKind(fn: () => unknown): string {
  const e = assertThrows(fn);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return (e as ComponentException<{ kind: string }>).payload.kind;
}

async function errKindAsync(p: Promise<unknown>): Promise<string> {
  const e = await assertRejects(() => p);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return (e as ComponentException<ErrorCode>).payload.kind;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: number[] = [];
  for await (const c of stream) chunks.push(...c);
  return Uint8Array.from(chunks);
}

const okTrailers: Promise<TrailersResult> = Promise.resolve({ kind: "ok", value: undefined });
const okRes: Promise<HttpResult> = Promise.resolve({ kind: "ok" });

/** A request aimed at 127.0.0.1:port over plain http. */
function loopbackRequest(
  port: number,
  path: string,
  extras: {
    method?: Parameters<Request["setMethod"]>[0];
    headers?: [string, Uint8Array][];
    contents?: AsyncIterable<Uint8Array>;
    trailers?: Promise<TrailersResult>;
  } = {},
): [Request, Promise<HttpResult>] {
  const headers = Fields.fromList(extras.headers ?? []);
  const [request, transmitted] = Request["new"](
    headers,
    extras.contents,
    extras.trailers ?? okTrailers,
    undefined,
  );
  if (extras.method !== undefined) request.setMethod(extras.method);
  request.setScheme({ kind: "HTTP" });
  request.setAuthority(`127.0.0.1:${port}`);
  request.setPathWithQuery(path);
  return [request, transmitted];
}

/** A loopback HTTP server for one test. */
function serve(
  handler: (req: globalThis.Request) => globalThis.Response | Promise<globalThis.Response>,
): Promise<{ port: number; shutdown: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen({ port }) {
        resolve({ port, shutdown: () => server.shutdown() });
      },
    }, handler);
  });
}

// --- fields ---------------------------------------------------------------------

Deno.test("http fields: case-insensitive lookup, original casing preserved", () => {
  const f = Fields.fromList([["X-Test", text("a")], ["x-test", text("b")]]);
  assertEq(f.has("X-TEST"), true);
  assertEq(f.get("x-Test").map(utf8).join(","), "a,b");
  assertEq(
    JSON.stringify(f.copyAll().map(([k, v]) => [k, utf8(v)])),
    JSON.stringify([["X-Test", "a"], ["x-test", "b"]]),
    "original casing and order survive",
  );
});

Deno.test("http fields: set/append/delete/get-and-delete; from-list validation", () => {
  const f = new Fields();
  f.set("a", [text("1")]);
  f.append("a", text("2"));
  assertEq(f.get("a").map(utf8).join(","), "1,2");
  assertEq(f.getAndDelete("a").map(utf8).join(","), "1,2");
  assertEq(f.has("a"), false);
  f.set("b", [text("x")]);
  f.delete("b");
  assertEq(f.has("b"), false);
  assertEq(errKind(() => Fields.fromList([["bad header", text("v")]])), "invalid-syntax");
  assertEq(errKind(() => f.set("ok", [text("bad\r\nvalue")])), "invalid-syntax");
});

Deno.test("http fields: immutability — request views refuse mutation, clone is mutable", () => {
  const headers = Fields.fromList([["x-a", text("1")]]);
  const [request] = Request["new"](headers, undefined, okTrailers, undefined);
  const view = request.getHeaders();
  assertEq(errKind(() => view.set("x-a", [text("2")])), "immutable");
  assertEq(errKind(() => view.delete("x-a")), "immutable");
  assertEq(errKind(() => view.append("x-a", text("2"))), "immutable");
  const cloned = view.clone();
  cloned.set("x-a", [text("2")]); // no throw: clones are mutable
  assertEq(utf8(cloned.get("x-a")[0]), "2");
  // The ORIGINAL fields handle also became immutable at `new` (ownership
  // transferred to the request).
  assertEq(errKind(() => headers.set("x-a", [text("3")])), "immutable");
  request[Symbol.dispose]();
});

// --- request accessors ------------------------------------------------------------

Deno.test("http request: accessor defaults, round trips, and validation", () => {
  const [request] = Request["new"](new Fields(), undefined, okTrailers, undefined);
  assertEq(request.getMethod().kind, "get");
  assertEq(request.getPathWithQuery(), undefined);
  assertEq(request.getScheme(), undefined);
  assertEq(request.getAuthority(), undefined);
  request.setMethod({ kind: "post" });
  assertEq(request.getMethod().kind, "post");
  request.setPathWithQuery("/x?y=1");
  assertEq(request.getPathWithQuery(), "/x?y=1");
  request.setScheme({ kind: "HTTPS" });
  assertEq(request.getScheme()?.kind, "HTTPS");
  request.setAuthority("example.com:8443");
  assertEq(request.getAuthority(), "example.com:8443");
  assertThrows(() => request.setMethod({ kind: "other", value: "not a token" }));
  assertThrows(() => request.setPathWithQuery("/sp ace"));
  assertThrows(() => request.setScheme({ kind: "other", value: "9bad" }));
  request[Symbol.dispose]();
});

Deno.test("http request-options: byte timeouts stored; connect-timeout honestly refused", () => {
  const o = new RequestOptions();
  assertEq(o.getConnectTimeout(), undefined);
  o.setFirstByteTimeout(5_000_000_000n);
  assertEq(o.getFirstByteTimeout(), 5_000_000_000n);
  o.setBetweenBytesTimeout(1_000_000n);
  assertEq(o.getBetweenBytesTimeout(), 1_000_000n);
  assertEq(errKind(() => o.setConnectTimeout(1n)), "not-supported");
  const c = o.clone();
  assertEq(c.getFirstByteTimeout(), 5_000_000_000n);
});

// --- client.send over a live server -------------------------------------------------

Deno.test("http send: GET round trip — status, headers, streamed body; transmission ok", async () => {
  const server = await serve((req) => {
    assertEq(new URL(req.url).pathname, "/hello");
    assertEq(req.headers.get("x-probe"), "42");
    return new globalThis.Response("hi there", { headers: { "x-answer": "97" } });
  });
  try {
    const [request, transmitted] = loopbackRequest(server.port, "/hello", {
      headers: [["x-probe", text("42")]],
    });
    const response = await send(request);
    assertEq(response.getStatusCode(), 200);
    assertEq(utf8(response.getHeaders().get("x-answer")[0]), "97");
    const [body, trailers] = Response.consumeBody(response, okRes);
    assertEq(utf8(await collect(body)), "hi there");
    assertEq((await trailers).kind, "ok");
    assertEq((await transmitted).kind, "ok");
    response[Symbol.dispose]();
  } finally {
    await server.shutdown();
  }
});

Deno.test("http send: POST body is transmitted (buffered divergence), echo returns", async () => {
  const server = await serve(async (req) => new globalThis.Response(await req.bytes()));
  try {
    const [request] = loopbackRequest(server.port, "/echo", {
      method: { kind: "post" },
      contents: (async function* () {
        yield text("hello ");
        yield text("fetch");
      })(),
    });
    const response = await send(request);
    const [body] = Response.consumeBody(response, okRes);
    assertEq(utf8(await collect(body)), "hello fetch");
    response[Symbol.dispose]();
  } finally {
    await server.shutdown();
  }
});

Deno.test("http send: redirects are NOT followed (manual, the wasmtime-parity stance)", async () => {
  const server = await serve((req) =>
    new URL(req.url).pathname === "/from"
      ? new globalThis.Response(null, { status: 302, headers: { location: "/to" } })
      : new globalThis.Response("followed?!")
  );
  try {
    const [request] = loopbackRequest(server.port, "/from");
    const response = await send(request);
    assertEq(response.getStatusCode(), 302);
    assertEq(utf8(response.getHeaders().get("location")[0]), "/to");
    response[Symbol.dispose]();
  } finally {
    await server.shutdown();
  }
});

Deno.test("http send: a refused connection maps to connection-refused (branded)", async () => {
  const probe = await serve(() => new globalThis.Response("x"));
  await probe.shutdown(); // the port is now free: dials get refused
  const [request, transmitted] = loopbackRequest(probe.port, "/");
  assertEq(await errKindAsync(send(request)), "connection-refused");
  assertEq((await transmitted).kind, "err");
});

Deno.test("http send: no authority is HTTP-request-URI-invalid; non-fetch scheme refused", async () => {
  const [r1] = Request["new"](new Fields(), undefined, okTrailers, undefined);
  r1.setScheme({ kind: "HTTP" });
  assertEq(await errKindAsync(send(r1)), "HTTP-request-URI-invalid");
  const [r2] = Request["new"](new Fields(), undefined, okTrailers, undefined);
  r2.setScheme({ kind: "other", value: "gopher" });
  r2.setAuthority("example.com");
  assertEq(await errKindAsync(send(r2)), "internal-error");
});

Deno.test("http send: request trailers cannot ride fetch — some(trailers) fails loudly", async () => {
  const server = await serve(() => new globalThis.Response("x"));
  try {
    const [request, transmitted] = loopbackRequest(server.port, "/", {
      trailers: Promise.resolve<TrailersResult>({ kind: "ok", value: new Fields() }),
    });
    assertEq(await errKindAsync(send(request)), "internal-error");
    assertEq((await transmitted).kind, "err");
  } finally {
    await server.shutdown();
  }
});

Deno.test("http send: an erring trailers future aborts the request, per the WIT", async () => {
  const server = await serve(() => new globalThis.Response("x"));
  try {
    const [request, transmitted] = loopbackRequest(server.port, "/", {
      trailers: Promise.resolve<TrailersResult>({
        kind: "err",
        value: { kind: "internal-error", value: "guest gave up" },
      }),
    });
    assertEq(await errKindAsync(send(request)), "internal-error");
    const t = await transmitted;
    assertEq(t.kind, "err");
  } finally {
    await server.shutdown();
  }
});

// --- response body timeouts ---------------------------------------------------------

Deno.test("http timeouts: first-byte timeout errs the body future, not the send", async () => {
  // Headers arrive; the body never does.
  const server = await serve(() =>
    new globalThis.Response(
      new ReadableStream<Uint8Array>({ start() {/* never enqueues */} }),
    )
  );
  try {
    const headers = Fields.fromList([]);
    const options = new RequestOptions();
    options.setFirstByteTimeout(50_000_000n); // 50ms
    const [request] = Request["new"](headers, undefined, okTrailers, options);
    request.setScheme({ kind: "HTTP" });
    request.setAuthority(`127.0.0.1:${server.port}`);
    request.setPathWithQuery("/");
    const response = await send(request); // headers made it: send succeeds
    const [body, done] = Response.consumeBody(response, okRes);
    assertEq((await collect(body)).length, 0, "the stream ends without fake data");
    const t = await done;
    assertEq(t.kind, "err");
    assertEq(
      (t as { kind: "err"; value: ErrorCode }).value.kind,
      "HTTP-response-timeout",
    );
  } finally {
    await server.shutdown();
  }
});

// --- guest-constructed bodies (the middleware shapes) --------------------------------

Deno.test("http consume-body: a constructed request's body and trailers pass through; res settles transmission", async () => {
  const trailerFields = new Fields();
  trailerFields.set("x-check", [text("sum")]);
  const [request, transmitted] = Request["new"](
    Fields.fromList([]),
    (async function* () {
      yield text("payload");
    })(),
    Promise.resolve<TrailersResult>({ kind: "ok", value: trailerFields }),
    undefined,
  );
  let settleRes!: (r: HttpResult) => void;
  const res = new Promise<HttpResult>((r) => (settleRes = r));
  const [body, trailers] = Request.consumeBody(request, res);
  assertEq(utf8(await collect(body)), "payload");
  const t = await trailers;
  assertEq(t.kind, "ok");
  assertTrue(t.kind === "ok" && t.value !== undefined, "trailers arrive");
  settleRes({ kind: "ok" });
  assertEq((await transmitted).kind, "ok", "res settles the transmission future");
});

Deno.test("http dispose: an unsent request settles its transmission future as err", async () => {
  const [request, transmitted] = Request["new"](new Fields(), undefined, okTrailers, undefined);
  request[Symbol.dispose]();
  const t = await transmitted;
  assertEq(t.kind, "err");
});

// --- fragment shape -------------------------------------------------------------------

Deno.test("http fragment: the @0.3 track by default; rc snapshots re-key exactly", () => {
  assertTrue(
    `wasi:http/types@${HTTP_TRACK}` in imports &&
      `wasi:http/client@${HTTP_TRACK}` in imports,
    "track keys registered",
  );
  const calls: string[] = [];
  const custom = http({ version: "0.3.0-rc-2099-01-01", onCall: (c) => calls.push(c) });
  assertTrue("wasi:http/types@0.3.0-rc-2099-01-01" in custom.imports, "rc override re-keys exactly");
  new custom.Fields();
  assertEq(JSON.stringify(calls), JSON.stringify(["fields.constructor"]));
});

Deno.test("fragment: imports table has no handler key (header recipe: embedder registers `send` under its own handler key)", () => {
  const { imports } = http();
  const keys = Object.keys(imports);
  assertTrue(
    keys.every((k) => !k.startsWith("wasi:http/handler@")),
    "no wasi:http/handler@* key present in the fragment's imports table",
  );
  assertTrue(
    keys.some((k) => k.startsWith("wasi:http/types@")) &&
      keys.some((k) => k.startsWith("wasi:http/client@")),
    "types + client keys still present",
  );
});

Deno.test("fragment: an embedder that means handler-over-fetch registers `send` under its own handler key", () => {
  const { imports, send } = http();
  // CONTRACT: wasi/src/http.ts:16-20 — handler is deliberately not
  // registered by this fragment; the supported recipe is the embedder
  // merging `send` into its own handler-keyed provider (issue #179).
  const embedderMerged = { ...imports, [`wasi:http/handler@0.3`]: { handle: send } };
  const handler = embedderMerged["wasi:http/handler@0.3"] as { handle: unknown };
  assertTrue(handler.handle === send, "handle IS client.send when the embedder opts in");
});

// --- allowRequest: name-level egress policy ---------------------------------------
//
// These tests stub `globalThis.fetch` (rather than a live Deno.serve loopback,
// like the tests above) so denial can be asserted directly as "fetch was
// never reached" — no network round trip needed either way.

function stubFetch(impl: typeof fetch): { calls: number; restore: () => void } {
  const original = globalThis.fetch;
  const state = { calls: 0 };
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    state.calls++;
    return impl(...args);
  }) as typeof fetch;
  return {
    get calls() {
      return state.calls;
    },
    restore: () => {
      globalThis.fetch = original;
    },
  } as { calls: number; restore: () => void };
}

/**
 * An injectable transport double for the `fetch` option (the seam this
 * file otherwise exercises via `stubFetch`/`globalThis.fetch`). Records
 * call count and the last `Request` seen.
 */
function fakeTransport(
  impl: (request: globalThis.Request) => globalThis.Response | Promise<globalThis.Response>,
): {
  calls: number;
  lastRequest: globalThis.Request | undefined;
  fn: (request: globalThis.Request) => Promise<globalThis.Response>;
} {
  const state: { calls: number; lastRequest: globalThis.Request | undefined } = {
    calls: 0,
    lastRequest: undefined,
  };
  return {
    get calls() {
      return state.calls;
    },
    get lastRequest() {
      return state.lastRequest;
    },
    fn: async (request: globalThis.Request) => {
      state.calls++;
      state.lastRequest = request;
      return await impl(request);
    },
  } as {
    calls: number;
    lastRequest: globalThis.Request | undefined;
    fn: (request: globalThis.Request) => Promise<globalThis.Response>;
  };
}

/** A request with a body stream that records whether it was ever iterated. */
function requestWithObservedBody(
  port: number,
  headers: [string, Uint8Array][] = [],
): { request: Request; transmitted: Promise<HttpResult>; consumed: () => boolean } {
  let consumed = false;
  const contents = (async function* () {
    consumed = true;
    yield text("body bytes");
  })();
  const [request, transmitted] = Request["new"](
    Fields.fromList(headers),
    contents,
    okTrailers,
    undefined,
  );
  request.setMethod({ kind: "post" });
  request.setScheme({ kind: "HTTP" });
  request.setAuthority(`127.0.0.1:${port}`);
  request.setPathWithQuery("/");
  return { request, transmitted, consumed: () => consumed };
}

Deno.test("http allowRequest: default (no options) still dispatches — fetch reached (late-bound default)", async () => {
  // CONTRACT: options.fetch defaults to globalThis.fetch RESOLVED AT CALL
  // TIME (see wasi/src/http.ts HttpOptions.fetch doc) — stubbing
  // globalThis.fetch after http() has already constructed the fragment
  // must still take effect. This is the one test in this file that keeps
  // exercising that late-binding property directly; every other test
  // below uses the injectable `fetch` option instead.
  const stub = stubFetch(() => Promise.resolve(new globalThis.Response("ok")));
  try {
    const { Request: R, Fields: F, send: s } = http();
    const [request] = R["new"](F.fromList([]), undefined, okTrailers, undefined);
    request.setScheme({ kind: "HTTP" });
    request.setAuthority("127.0.0.1:9");
    await s(request);
    assertEq(stub.calls, 1, "fetch reached under default allowRequest");
  } finally {
    stub.restore();
  }
});

Deno.test("http allowRequest: explicit true dispatches — transport reached", async () => {
  const transport = fakeTransport(() => new globalThis.Response("ok"));
  const { Request: R, Fields: F, send: s } = http({ allowRequest: true, fetch: transport.fn });
  const [request] = R["new"](F.fromList([]), undefined, okTrailers, undefined);
  request.setScheme({ kind: "HTTP" });
  request.setAuthority("127.0.0.1:9");
  await s(request);
  assertEq(transport.calls, 1, "transport reached under allowRequest: true");
});

Deno.test("http allowRequest: false denies with HTTP-request-denied; transport never called", async () => {
  const transport = fakeTransport(() => new globalThis.Response("ok"));
  const { send: s } = http({ allowRequest: false, fetch: transport.fn });
  const { request, transmitted } = requestWithObservedBody(9);
  assertEq(await errKindAsync(s(request)), "HTTP-request-denied");
  assertEq((await transmitted).kind, "err");
  assertEq(transport.calls, 0, "transport never dispatched when allowRequest is false");
});

Deno.test("http allowRequest: false does not consume the body stream", async () => {
  const transport = fakeTransport(() => new globalThis.Response("ok"));
  const { send: s } = http({ allowRequest: false, fetch: transport.fn });
  const { request, consumed } = requestWithObservedBody(9);
  await errKindAsync(s(request));
  // ASSERTED: the body generator's own body never ran (its `consumed`
  // flag flips only on first iteration) — this is the available
  // approximation of "the stream was not drained": collectBody would
  // have to `for await` it, which would flip the flag before the transport.
  assertTrue(!consumed(), "the request body was never iterated on denial");
});

Deno.test("http allowRequest: types/client keys still registered when false", () => {
  const { imports } = http({ allowRequest: false });
  assertTrue(
    `wasi:http/types@${HTTP_TRACK}` in imports && `wasi:http/client@${HTTP_TRACK}` in imports,
    "types + client keys present even with egress denied",
  );
});

Deno.test("http allowRequest: callback observes url/method/headers", async () => {
  const transport = fakeTransport(() => new globalThis.Response("ok"));
  let seen: { url: URL; method: string; headers: Headers } | undefined;
  const { Request: R, Fields: F, send: s } = http({
    allowRequest: (req) => {
      seen = req;
      return true;
    },
    fetch: transport.fn,
  });
  const [request] = R["new"](F.fromList([["x-probe", text("42")]]), undefined, okTrailers, undefined);
  request.setMethod({ kind: "post" });
  request.setScheme({ kind: "HTTPS" });
  request.setAuthority("example.com");
  request.setPathWithQuery("/a/b?x=1");
  await s(request);
  assertTrue(seen !== undefined, "callback was invoked");
  assertEq(seen!.url.hostname, "example.com");
  assertEq(seen!.url.protocol, "https:");
  assertEq(seen!.url.pathname, "/a/b");
  assertEq(seen!.method, "POST");
  assertEq(seen!.headers.get("x-probe"), "42");
});

Deno.test("http allowRequest: callback returning true dispatches, false denies", async () => {
  const allowedTransport = fakeTransport(() => new globalThis.Response("ok"));
  const allowed = http({ allowRequest: () => true, fetch: allowedTransport.fn });
  const [ra] = allowed.Request["new"](allowed.Fields.fromList([]), undefined, okTrailers, undefined);
  ra.setScheme({ kind: "HTTP" });
  ra.setAuthority("127.0.0.1:9");
  await allowed.send(ra);
  assertEq(allowedTransport.calls, 1, "true dispatches");

  const deniedTransport = fakeTransport(() => new globalThis.Response("ok"));
  const denied = http({ allowRequest: () => false, fetch: deniedTransport.fn });
  const [rd] = denied.Request["new"](denied.Fields.fromList([]), undefined, okTrailers, undefined);
  rd.setScheme({ kind: "HTTP" });
  rd.setAuthority("127.0.0.1:9");
  assertEq(await errKindAsync(denied.send(rd)), "HTTP-request-denied");
  assertEq(deniedTransport.calls, 0, "false denies without dispatching the transport");
});

Deno.test("http allowRequest: async callback (resolves true/false) both directions work", async () => {
  const allowedTransport = fakeTransport(() => new globalThis.Response("ok"));
  const allowed = http({ allowRequest: () => Promise.resolve(true), fetch: allowedTransport.fn });
  const [ra] = allowed.Request["new"](allowed.Fields.fromList([]), undefined, okTrailers, undefined);
  ra.setScheme({ kind: "HTTP" });
  ra.setAuthority("127.0.0.1:9");
  await allowed.send(ra);
  assertEq(allowedTransport.calls, 1, "async true dispatches");

  const deniedTransport = fakeTransport(() => new globalThis.Response("ok"));
  const denied = http({ allowRequest: () => Promise.resolve(false), fetch: deniedTransport.fn });
  const [rd] = denied.Request["new"](denied.Fields.fromList([]), undefined, okTrailers, undefined);
  rd.setScheme({ kind: "HTTP" });
  rd.setAuthority("127.0.0.1:9");
  assertEq(await errKindAsync(denied.send(rd)), "HTTP-request-denied");
  assertEq(deniedTransport.calls, 0, "async false denies without dispatching the transport");
});

Deno.test("http allowRequest: a throwing callback denies (fail closed); detail names the thrown message", async () => {
  const transport = fakeTransport(() => new globalThis.Response("ok"));
  const { send: s } = http({
    allowRequest: () => {
      throw new Error("policy blew up");
    },
    fetch: transport.fn,
  });
  const { request } = requestWithObservedBody(9);
  const e = await assertRejects(() => s(request));
  assertTrue(e instanceof ComponentException, "throws a branded ComponentException");
  assertEq((e as ComponentException<ErrorCode>).payload.kind, "HTTP-request-denied");
  assertTrue(
    String((e as ComponentException<ErrorCode>).message).includes("policy blew up"),
    "the ComponentException detail mentions the thrown message",
  );
  assertEq(transport.calls, 0, "transport never dispatched when the callback throws");
});

Deno.test("http allowRequest: a rejecting async callback denies (fail closed); detail names the rejection", async () => {
  const transport = fakeTransport(() => new globalThis.Response("ok"));
  const { send: s } = http({
    allowRequest: () => Promise.reject(new Error("async policy blew up")),
    fetch: transport.fn,
  });
  const { request } = requestWithObservedBody(9);
  const e = await assertRejects(() => s(request));
  assertTrue(e instanceof ComponentException, "throws a branded ComponentException");
  assertEq((e as ComponentException<ErrorCode>).payload.kind, "HTTP-request-denied");
  assertTrue(
    String((e as ComponentException<ErrorCode>).message).includes("async policy blew up"),
    "the ComponentException detail mentions the rejection message",
  );
  assertEq(transport.calls, 0, "transport never dispatched when the async callback rejects");
});

// --- fetch: injectable transport ---------------------------------------------------

Deno.test("http fetch option: transport receives url, method, header, and body bytes", async () => {
  const transport = fakeTransport(() => new globalThis.Response("ok"));
  const { Request: R, Fields: F, send: s } = http({ fetch: transport.fn });
  const [request] = R["new"](
    F.fromList([["x-probe", text("42")]]),
    (async function* () {
      yield text("payload");
    })(),
    okTrailers,
    undefined,
  );
  request.setMethod({ kind: "post" });
  request.setScheme({ kind: "HTTP" });
  request.setAuthority("example.com:8080");
  request.setPathWithQuery("/a/b?x=1");
  await s(request);
  const seen = transport.lastRequest!;
  assertEq(seen.url, "http://example.com:8080/a/b?x=1");
  assertEq(seen.method, "POST");
  assertEq(seen.headers.get("x-probe"), "42");
  assertEq(utf8(new Uint8Array(await seen.clone().arrayBuffer())), "payload");
});

Deno.test("http fetch option: request.clone() peeks the body without stealing it from the forwarded request", async () => {
  let peeked = "";
  const transport = fakeTransport(async (req) => {
    peeked = utf8(new Uint8Array(await req.clone().arrayBuffer()));
    // Forward the ORIGINAL (not the clone) — proves clone() didn't consume it.
    return new globalThis.Response(await req.arrayBuffer());
  });
  const { Request: R, Fields: F, Response: Resp, send: s } = http({ fetch: transport.fn });
  const [request] = R["new"](
    F.fromList([]),
    (async function* () {
      yield text("peek me");
    })(),
    okTrailers,
    undefined,
  );
  request.setMethod({ kind: "post" });
  request.setScheme({ kind: "HTTP" });
  request.setAuthority("example.com");
  const response = await s(request);
  assertEq(peeked, "peek me");
  const [body] = Resp.consumeBody(response, okRes);
  assertEq(utf8(await collect(body)), "peek me", "the forwarded request still delivers the body");
});

Deno.test("http fetch option: a synthesized Response (no network) reaches the guest", async () => {
  const transport = fakeTransport(() =>
    new globalThis.Response("synthetic body", { status: 201, headers: { "x-synth": "yes" } })
  );
  const { Request: R, Fields: F, Response: Resp, send: s } = http({ fetch: transport.fn });
  const [request] = R["new"](F.fromList([]), undefined, okTrailers, undefined);
  request.setScheme({ kind: "HTTP" });
  request.setAuthority("example.com");
  const response = await s(request);
  assertEq(response.getStatusCode(), 201);
  assertEq(utf8(response.getHeaders().get("x-synth")[0]), "yes");
  const [body] = Resp.consumeBody(response, okRes);
  assertEq(utf8(await collect(body)), "synthetic body");
});

Deno.test("http fetch option: a transport throwing a branded ComponentException surfaces that exact payload kind", async () => {
  const transport = fakeTransport(() => {
    throw new ComponentException<ErrorCode>({ kind: "TLS-alert-received" }, "wasi:http: transport TLS alert");
  });
  const { send: s } = http({ fetch: transport.fn });
  const { request, transmitted } = requestWithObservedBody(9);
  assertEq(await errKindAsync(s(request)), "TLS-alert-received");
  const t = await transmitted;
  assertEq(t.kind, "err");
  assertTrue(t.kind === "err" && t.value.kind === "TLS-alert-received");
});

Deno.test("http fetch option: a transport throwing a plain Error still maps through mapFetchError", async () => {
  // "refused" -> connection-refused, per mapFetchError's sniff table
  // (wasi/src/http.ts mapFetchError).
  const transport = fakeTransport(() => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:9");
  });
  const { send: s } = http({ fetch: transport.fn });
  const { request } = requestWithObservedBody(9);
  assertEq(await errKindAsync(s(request)), "connection-refused");
});

Deno.test("http fetch option: allowRequest still runs first — denied request never reaches the transport", async () => {
  const transport = fakeTransport(() => new globalThis.Response("ok"));
  const { send: s } = http({ allowRequest: false, fetch: transport.fn });
  const { request } = requestWithObservedBody(9);
  assertEq(await errKindAsync(s(request)), "HTTP-request-denied");
  assertEq(transport.calls, 0, "the transport was never called");
});
