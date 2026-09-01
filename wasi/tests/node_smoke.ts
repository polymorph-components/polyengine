// The pinned-Node smoke for the à la carte sockets fragment (`just
// test-sockets-node`): the fake-node suite (tests/sockets_node_test.ts)
// covers the adapter logic under Deno's node-compat; THIS runs the same
// load-bearing semantics on the real platform — genuine `node:dgram` /
// `node:net`, and the real detection path (no `Deno` global at all).
//
// Plain script, not Deno.test: it executes under Node. `deno bundle`
// resolves the workspace imports into one self-contained ESM file (the
// recipe body in the justfile).

import { type IpSocketAddress, type SocketResult, sockets } from "../src/sockets.ts";
import { http, type TrailersResult } from "../src/http.ts";
import { filesystemNode } from "../src/filesystem_node.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(`FAIL: ${what}`);
}

function assertEq(got: unknown, want: unknown, what: string): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL: ${what}: got ${g}, want ${w}`);
}

function errKindOf(e: unknown): string {
  const payload = (e as { payload?: { kind?: string } })?.payload;
  if (typeof payload?.kind !== "string") {
    throw new Error(`FAIL: expected a branded socket error, got ${e}`);
  }
  return payload.kind;
}

function resultErrKind(r: SocketResult, what: string): string {
  assert(r.kind === "err", `${what}: expected err result, got ${JSON.stringify(r)}`);
  return r.kind === "err" ? r.value.kind : "";
}

const v4 = (address: [number, number, number, number], port: number): IpSocketAddress => ({
  kind: "ipv4",
  value: { port, address },
});

async function* chunksOf(...chunks: number[][]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield Uint8Array.from(c);
}

async function collect(stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) out.push(...chunk);
  return out;
}

// Node test servers, via the same builtin channel the backend uses.
interface NodeTestSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  write(chunk: Uint8Array): boolean;
  end(): unknown;
  destroy(): unknown;
}
interface NodeTestServer {
  listen(port: number, host: string, cb: () => void): unknown;
  close(cb?: () => void): unknown;
  address(): { port: number };
}
const nodeNet = (globalThis as unknown as {
  process: { getBuiltinModule: (name: string) => unknown };
}).process.getBuiltinModule("node:net") as {
  createServer(
    options: { allowHalfOpen: boolean },
    handler: (conn: NodeTestSocket) => void,
  ): NodeTestServer;
};

function echoServer(): Promise<{ addr: IpSocketAddress; close: () => Promise<void> }> {
  const server = nodeNet.createServer({ allowHalfOpen: true }, (conn) => {
    conn.on("data", (...args) => conn.write(args[0] as Uint8Array));
    conn.on("end", () => conn.end());
    conn.on("error", () => conn.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        addr: v4([127, 0, 0, 1], server.address().port),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function main(): Promise<void> {
  assert(
    (globalThis as { Deno?: unknown }).Deno === undefined,
    "this smoke must run on real Node (no Deno global) — the detection path under test",
  );
  const { UdpSocket, TcpSocket } = sockets();

  // --- udp: the iroh driving sequence, synchronously -------------------------
  {
    const socket = UdpSocket.create("ipv4");
    socket.bind(v4([127, 0, 0, 1], 0));
    const addr = socket.getLocalAddress(); // same tick as bind — the sync-lookup trick
    assert(addr.kind === "ipv4" && addr.value.port !== 0, "udp sync bind + get-local-address");
    socket[Symbol.dispose]();
  }

  // --- udp: roundtrip, source address, zero-length self-wake ------------------
  {
    const a = UdpSocket.create("ipv4");
    const b = UdpSocket.create("ipv4");
    a.bind(v4([127, 0, 0, 1], 0));
    b.bind(v4([127, 0, 0, 1], 0));
    await a.send(Uint8Array.from([1, 2, 3]), b.getLocalAddress());
    const [payload, from] = await b.receive();
    assertEq([...payload], [1, 2, 3], "udp roundtrip payload");
    assertEq(from, a.getLocalAddress(), "udp source address");
    const pending = a.receive();
    await a.send(new Uint8Array(0), a.getLocalAddress());
    const [empty] = await pending;
    assertEq(empty.length, 0, "udp zero-length self-wake");
    a[Symbol.dispose]();
    b[Symbol.dispose]();
  }

  // --- udp: error contract -----------------------------------------------------
  {
    const socket = UdpSocket.create("ipv4");
    socket.bind(v4([127, 0, 0, 1], 0));
    const addr = socket.getLocalAddress();
    for (const size of [65536, 65508]) {
      try {
        await socket.send(new Uint8Array(size), addr);
        assert(false, `udp oversize send (${size}) must fail`);
      } catch (e) {
        assertEq(errKindOf(e), "datagram-too-large", `udp oversize send (${size})`);
      }
    }
    const other = UdpSocket.create("ipv4");
    try {
      other.bind(addr);
      assert(false, "udp conflicting bind must fail");
    } catch (e) {
      assertEq(errKindOf(e), "address-in-use", "udp conflicting bind");
    }
    other[Symbol.dispose]();
    const parked = socket.receive();
    socket[Symbol.dispose]();
    try {
      await parked;
      assert(false, "udp parked receive must settle as err on dispose");
    } catch (e) {
      assertEq(errKindOf(e), "invalid-state", "udp dispose retires a parked receive");
    }
  }

  // --- tcp: echo, FIN semantics, futures ---------------------------------------
  {
    const server = await echoServer();
    const socket = TcpSocket.create("ipv4");
    await socket.connect(server.addr);
    assertEq(socket.getRemoteAddress(), server.addr, "tcp remote address");
    const [rx, rxDone] = socket.receive();
    const txDone = socket.send(chunksOf([1, 2, 3], [4, 5]));
    assertEq(await collect(rx), [1, 2, 3, 4, 5], "tcp echo payload");
    assertEq((await txDone).kind, "ok", "tcp send future");
    assertEq((await rxDone).kind, "ok", "tcp receive future");
    socket[Symbol.dispose]();
    await server.close();
  }

  // --- tcp: shared ownership (streams outlive the dropped handle) --------------
  {
    const server = await echoServer();
    const socket = TcpSocket.create("ipv4");
    await socket.connect(server.addr);
    const [rx, rxDone] = socket.receive();
    const txDone = socket.send(chunksOf([7]));
    socket[Symbol.dispose]();
    assertEq(await collect(rx), [7], "tcp echo after handle drop");
    assertEq((await rxDone).kind, "ok", "tcp receive future after handle drop");
    assertEq((await txDone).kind, "ok", "tcp send future after handle drop");
    await server.close();
  }

  // --- tcp: refused dial --------------------------------------------------------
  {
    const probe = await echoServer();
    await probe.close();
    const socket = TcpSocket.create("ipv4");
    try {
      await socket.connect(probe.addr);
      assert(false, "tcp refused dial must fail");
    } catch (e) {
      assertEq(errKindOf(e), "connection-refused", "tcp refused dial");
    }
    assertEq(
      resultErrKind(await socket.send(chunksOf([1])), "tcp send after failed dial"),
      "invalid-state",
      "tcp send after failed dial",
    );
    socket[Symbol.dispose]();
  }

  // --- tcp: peer-closed write settles the send future as err -------------------
  {
    const closer = nodeNet.createServer({ allowHalfOpen: false }, (conn) => conn.destroy());
    const addr = await new Promise<IpSocketAddress>((resolve) => {
      closer.listen(0, "127.0.0.1", () => resolve(v4([127, 0, 0, 1], closer.address().port)));
    });
    const socket = TcpSocket.create("ipv4");
    await socket.connect(addr);
    const result = await socket.send((async function* () {
      for (let i = 0; i < 50; i++) {
        yield new Uint8Array(1024);
        await new Promise((r) => setTimeout(r, 5));
      }
    })());
    const kind = resultErrKind(result, "tcp peer-closed write");
    assert(
      kind === "connection-reset" || kind === "connection-broken" || kind === "invalid-state",
      `tcp peer-closed write: a connection-failure kind, got ${kind}`,
    );
    socket[Symbol.dispose]();
    await new Promise<void>((r) => closer.close(() => r()));
  }

  // --- http over fetch (undici): GET + POST against a node:http server ---------
  {
    interface NodeHttpModule {
      createServer(
        handler: (req: {
          method?: string;
          url?: string;
          on(ev: string, fn: (...a: unknown[]) => void): unknown;
        }, res: {
          writeHead(status: number, headers?: Record<string, string>): unknown;
          end(body?: Uint8Array | string): unknown;
        }) => void,
      ): {
        listen(port: number, host: string, cb: () => void): unknown;
        close(cb?: () => void): unknown;
        address(): { port: number };
      };
    }
    const nodeHttp = (globalThis as unknown as {
      process: { getBuiltinModule: (n: string) => unknown };
    }).process.getBuiltinModule("node:http") as NodeHttpModule;
    const server = nodeHttp.createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(203, { "x-answer": "97" });
        res.end("hello from node");
        return;
      }
      const chunks: number[] = [];
      req.on("data", (...a) => chunks.push(...(a[0] as Uint8Array)));
      req.on("end", () => {
        res.writeHead(200);
        res.end(Uint8Array.from(chunks));
      });
    });
    const port = await new Promise<number>((r) =>
      server.listen(0, "127.0.0.1", () => r(server.address().port))
    );

    const { Fields, Request, Response, send } = http();
    const okTrailers = Promise.resolve<TrailersResult>({ kind: "ok", value: undefined });
    const okRes = Promise.resolve<{ kind: "ok" }>({ kind: "ok" });

    // GET
    {
      const [request] = Request["new"](new Fields(), undefined, okTrailers, undefined);
      request.setScheme({ kind: "HTTP" });
      request.setAuthority(`127.0.0.1:${port}`);
      request.setPathWithQuery("/hello");
      const response = await send(request);
      assertEq(response.getStatusCode(), 203, "http GET status");
      const [body] = Response.consumeBody(response, okRes);
      assertEq(
        new TextDecoder().decode(await (async () => {
          const out: number[] = [];
          for await (const c of body as AsyncIterable<Uint8Array>) out.push(...c);
          return Uint8Array.from(out);
        })()),
        "hello from node",
        "http GET body",
      );
      response[Symbol.dispose]();
    }
    // POST echo
    {
      const [request] = Request["new"](
        new Fields(),
        (async function* () {
          yield Uint8Array.from([1, 2, 3, 4]);
        })(),
        okTrailers,
        undefined,
      );
      request.setMethod({ kind: "post" });
      request.setScheme({ kind: "HTTP" });
      request.setAuthority(`127.0.0.1:${port}`);
      request.setPathWithQuery("/echo");
      const response = await send(request);
      const [body] = Response.consumeBody(response, okRes);
      const out: number[] = [];
      for await (const c of body as AsyncIterable<Uint8Array>) out.push(...c);
      assertEq(out, [1, 2, 3, 4], "http POST echo");
      response[Symbol.dispose]();
    }
    await new Promise<void>((r) => server.close(() => r()));
  }

  // --- filesystem-node: the sync 0.2 track on real node:fs ---------------------
  {
    const nodeFs = (globalThis as unknown as {
      process: { getBuiltinModule: (n: string) => unknown };
    }).process.getBuiltinModule("node:fs") as {
      mkdtempSync(prefix: string): string;
      rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
    };
    const nodeOs = (globalThis as unknown as {
      process: { getBuiltinModule: (n: string) => unknown };
    }).process.getBuiltinModule("node:os") as { tmpdir(): string };
    const dir = nodeFs.mkdtempSync(`${nodeOs.tmpdir()}/polyengine-fs-smoke-`);
    try {
      const { imports } = filesystemNode({ preopens: { "/": dir }, writable: true });
      const [[root]] = (imports["wasi:filesystem/preopens@0.2"] as {
        // deno-lint-ignore no-explicit-any
        getDirectories(): [any, string][];
      }).getDirectories();

      // Sync-ness is the load-bearing claim on real Node: plain values.
      const f = root.openAt({ symlinkFollow: true }, "smoke.txt", { create: true }, {
        read: true,
        write: true,
      });
      assert(!(f instanceof Promise), "fs open-at returns a plain value on node");
      assertEq(f.getType(), "regular-file", "fs get-type");
      assertEq(Number(f.write(Uint8Array.from([104, 105]), 0n)), 2, "fs positional write");
      const [bytes, eof] = f.read(8n, 0n);
      assertEq([...bytes], [104, 105], "fs positional read");
      assertEq(eof, false, "fs read eof flag");

      const out = f.writeViaStream(2n);
      out.write(Uint8Array.from([33]));
      out.blockingFlush();
      const src = f.readViaStream(0n);
      assertEq([...src.blockingRead(16n)], [104, 105, 33], "fs via-stream round-trip");

      const listing = root.readDirectory();
      assertEq(listing.readDirectoryEntry()?.name, "smoke.txt", "fs listing");
      root.renameAt("smoke.txt", root, "renamed.txt");
      root.unlinkFileAt("renamed.txt");
      try {
        root.statAt({ symlinkFollow: true }, "renamed.txt");
        assert(false, "fs stat-at on removed file must fail");
      } catch (e) {
        // 0.2 error-code is an ENUM: the payload is the bare string.
        assertEq(
          (e as { payload?: unknown })?.payload,
          "no-entry",
          "fs 0.2 bare-string error payload",
        );
      }
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const version = (globalThis as unknown as { process: { version: string } }).process.version;
  // --- tcp listen: deferred bind, accept, echo, cancellation -------------------
  {
    const socket = TcpSocket.create("ipv4");
    socket.bind(v4([127, 0, 0, 1], 0));
    // listen awaits the deferred-bind settle (the suspending park under
    // real dispatch), so the local address is real immediately after.
    const stream = await socket.listen();
    const addr = socket.getLocalAddress();
    assert(addr.kind === "ipv4" && addr.value.port !== 0, "tcp listen: ephemeral port");
    assert(socket.getIsListening(), "tcp listen: get-is-listening");

    const client = (nodeNet as unknown as {
      connect(o: { host: string; port: number; allowHalfOpen: boolean }): NodeTestSocket & {
        once(event: string, listener: (...args: unknown[]) => void): unknown;
      };
    }).connect({
      host: "127.0.0.1",
      port: addr.kind === "ipv4" ? addr.value.port : 0,
      allowHalfOpen: true,
    });
    const clientGot = new Promise<number[]>((resolve) => {
      const got: number[] = [];
      client.on("data", (...args) => got.push(...(args[0] as Uint8Array)));
      client.on("end", () => resolve(got));
    });
    client.once("connect", () => {
      client.write(Uint8Array.from([1, 2, 3]));
      client.end();
    });

    const it = stream[Symbol.asyncIterator]();
    const first = await it.next();
    assert(first.done === false, "tcp listen: an accept arrived");
    const accepted = first.value!;
    const [rx, rxDone] = accepted.receive();
    assertEq(await collect(rx), [1, 2, 3], "tcp listen: accepted receive");
    assertEq((await rxDone).kind, "ok", "tcp listen: accepted receive future");
    assertEq(
      (await accepted.send(chunksOf([4, 5]))).kind,
      "ok",
      "tcp listen: accepted send future",
    );
    assertEq(await clientGot, [4, 5], "tcp listen: echo reached the client");
    accepted[Symbol.dispose]();

    // Producer cancellation (embedder-api.md §"Streams and futures"): retire the parked accept loop.
    stream.cancel();
    for await (const s of stream) s[Symbol.dispose]();
    socket[Symbol.dispose]();
  }

  console.log(`wasi node smoke: OK (udp + tcp + listen + http + fs on ${version})`);
}

main().catch((e) => {
  console.error(String((e as Error)?.stack ?? e));
  (globalThis as unknown as { process: { exit: (code: number) => void } }).process.exit(1);
});
