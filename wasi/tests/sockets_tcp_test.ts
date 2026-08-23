// Unit tests for the `wasi:sockets/types@0.3` TCP provider
// (src/sockets.ts — the client half, issue #4's wosh consumer shape):
// the connect state machine, the stream-shaped send/receive data path
// against a real loopback `Deno.listen` server, the futures-not-throws
// error contract, and the WIT's shared-ownership teardown.
//
// `send`/`receive` never throw: their WIT signatures carry no result —
// every failure rides the returned future as a `{ kind: "err", value }`
// result value. Only create/connect/get-*-address may throw, and those
// throws must be BRANDED ComponentExceptions (a bare throw would be a
// guest trap).

import { ComponentException } from "@polyengine/protocol";
import {
  type IpSocketAddress,
  type SocketErrorCode,
  type SocketResult,
  sockets,
  type TcpAcceptStream,
  type TcpSocket,
} from "../src/sockets.ts";
import { assertEq, assertThrows, assertTrue } from "./asserts.ts";

const { TcpSocket } = sockets();

const v4 = (address: [number, number, number, number], port: number): IpSocketAddress => ({
  kind: "ipv4",
  value: { port, address },
});

const v6 = (
  address: [number, number, number, number, number, number, number, number],
  port: number,
  scopeId = 0,
): IpSocketAddress => ({
  kind: "ipv6",
  value: { port, flowInfo: 0, address, scopeId },
});

/** The payload kind of a thrown, branded socket error. */
function errKind(fn: () => unknown): string {
  const e = assertThrows(fn);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return ((e as ComponentException<SocketErrorCode>).payload).kind;
}

async function errKindAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
    return ((e as ComponentException<SocketErrorCode>).payload).kind;
  }
  throw new Error("expected a rejection");
}

/** The err-value kind of a settled tcp future. */
function resultErrKind(r: SocketResult): string {
  assertEq(r.kind, "err");
  return r.kind === "err" ? r.value.kind : "";
}

function dispose(socket: TcpSocket): void {
  socket[Symbol.dispose]();
}

async function* chunksOf(...chunks: number[][]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield Uint8Array.from(c);
}

async function collect(stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) out.push(...chunk);
  return out;
}

interface TestServer {
  addr: IpSocketAddress;
  done: Promise<void>;
  close(): void;
}

/** A one-connection loopback server driving `handler` on the accepted conn. */
function tcpServer(handler: (conn: Deno.TcpConn) => Promise<void>): TestServer {
  const listener = Deno.listen({ transport: "tcp", hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  const done = (async () => {
    const conn = await listener.accept();
    try {
      await handler(conn as Deno.TcpConn);
    } finally {
      try {
        conn.close();
      } catch {
        // Already closed by the handler.
      }
      listener.close();
    }
  })();
  return { addr: v4([127, 0, 0, 1], port), done, close: () => listener.close() };
}

/** Echo until EOF, then close (FIN back). */
async function echoHandler(conn: Deno.TcpConn): Promise<void> {
  const buf = new Uint8Array(4096);
  for (;;) {
    const n = await conn.read(buf);
    if (n === null) return;
    let at = 0;
    while (at < n) at += await conn.write(buf.subarray(at, n));
  }
}

/** A connected client against a fresh server running `handler`. */
async function connected(
  handler: (conn: Deno.TcpConn) => Promise<void>,
): Promise<{ socket: TcpSocket; server: TestServer }> {
  const server = tcpServer(handler);
  const socket = TcpSocket.create("ipv4");
  await socket.connect(server.addr);
  return { socket, server };
}

// --- the data path -----------------------------------------------------------

Deno.test("tcp: connect / send / receive — loopback echo, both futures ok", async () => {
  const { socket, server } = await connected(echoHandler);
  try {
    const [rx, rxDone] = socket.receive();
    // send is called once with the whole outgoing stream; its future is
    // the transmission report. Never awaited before the reads — the test
    // mirrors the guest's concurrent pumps.
    const txDone = socket.send(chunksOf([1, 2, 3], [4, 5]));
    assertEq(JSON.stringify(await collect(rx)), JSON.stringify([1, 2, 3, 4, 5]));
    assertEq((await txDone).kind, "ok");
    assertEq((await rxDone).kind, "ok");
    await server.done;
  } finally {
    dispose(socket);
  }
});

Deno.test("tcp: addresses report the real endpoints once connected", async () => {
  const { socket, server } = await connected(echoHandler);
  try {
    const local = socket.getLocalAddress();
    assertTrue(local.kind === "ipv4" && local.value.port !== 0, "local port assigned");
    assertEq(JSON.stringify(socket.getRemoteAddress()), JSON.stringify(server.addr));
    assertEq(socket.getAddressFamily(), "ipv4");
    assertEq(socket.getIsListening(), false);
    // End the exchange so the server task retires.
    const [rx, rxDone] = socket.receive();
    const txDone = socket.send(chunksOf());
    await collect(rx);
    await txDone;
    await rxDone;
    await server.done;
  } finally {
    dispose(socket);
  }
});

Deno.test("tcp: an empty send stream is a bare FIN the peer sees as EOF", async () => {
  let sawEof = false;
  const { socket, server } = await connected(async (conn) => {
    const n = await conn.read(new Uint8Array(16));
    sawEof = n === null;
  });
  try {
    const txDone = socket.send(chunksOf());
    assertEq((await txDone).kind, "ok");
    await server.done;
    assertEq(sawEof, true, "the FIN arrived with no data before it");
  } finally {
    dispose(socket);
  }
});

// --- error contract: futures, not throws --------------------------------------

Deno.test("tcp: send before connect settles err(invalid-state), never throws", async () => {
  const socket = TcpSocket.create("ipv4");
  assertEq(resultErrKind(await socket.send(chunksOf([1]))), "invalid-state");
  dispose(socket);
});

Deno.test("tcp: send is once-only; the second future is err(invalid-state)", async () => {
  const { socket, server } = await connected(echoHandler);
  try {
    const [rx, rxDone] = socket.receive();
    const first = socket.send(chunksOf([9]));
    assertEq(resultErrKind(await socket.send(chunksOf([8]))), "invalid-state");
    assertEq(JSON.stringify(await collect(rx)), JSON.stringify([9]));
    assertEq((await first).kind, "ok");
    await rxDone;
    await server.done;
  } finally {
    dispose(socket);
  }
});

Deno.test("tcp: receive before connect / repeated receive — closed stream + err future", async () => {
  const unconnected = TcpSocket.create("ipv4");
  const [rx0, done0] = unconnected.receive();
  assertEq(JSON.stringify(await collect(rx0)), "[]");
  assertEq(resultErrKind(await done0), "invalid-state");
  dispose(unconnected);

  const { socket, server } = await connected(echoHandler);
  try {
    const [rx1, rxDone] = socket.receive();
    const [rx2, done2] = socket.receive(); // WIT: closed stream + err(invalid-state)
    assertEq(JSON.stringify(await collect(rx2)), "[]");
    assertEq(resultErrKind(await done2), "invalid-state");
    const txDone = socket.send(chunksOf());
    await collect(rx1);
    await txDone;
    await rxDone;
    await server.done;
  } finally {
    dispose(socket);
  }
});

Deno.test("tcp: a write on a peer-closed connection settles the send future as err", async () => {
  // The server closes without reading; the client's first write lands in
  // flight (and triggers an RST once the peer socket is gone), so a later
  // write fails. Retried writes with a pause make the RST observation
  // deterministic on loopback.
  const { socket, server } = await connected((conn) => {
    conn.close();
    return Promise.resolve();
  });
  try {
    await server.done;
    const result = await socket.send((async function* () {
      for (let i = 0; i < 50; i++) {
        yield new Uint8Array(1024);
        await new Promise((r) => setTimeout(r, 5));
      }
    })());
    assertEq(result.kind, "err");
    const kind = resultErrKind(result);
    assertTrue(
      kind === "connection-reset" || kind === "connection-broken" || kind === "invalid-state",
      `a connection-failure kind, got ${kind}`,
    );
  } finally {
    dispose(socket);
  }
});

// --- connect state machine -----------------------------------------------------

Deno.test("tcp: connect argument validation (branded)", async () => {
  const socket = TcpSocket.create("ipv4");
  const v6Socket = TcpSocket.create("ipv6");
  try {
    assertEq(await errKindAsync(socket.connect(v6([0, 0, 0, 0, 0, 0, 0, 1], 9))), "invalid-argument");
    assertEq(await errKindAsync(socket.connect(v4([0, 0, 0, 0], 9))), "invalid-argument");
    assertEq(await errKindAsync(socket.connect(v4([127, 0, 0, 1], 0))), "invalid-argument");
    assertEq(
      await errKindAsync(v6Socket.connect(v6([0xfe80, 0, 0, 0, 0, 0, 0, 1], 9, 3))),
      "not-supported",
    );
    // An IPv4-mapped IPv6 address never crosses the family boundary.
    assertEq(
      await errKindAsync(v6Socket.connect(v6([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1], 9))),
      "invalid-argument",
    );
  } finally {
    dispose(socket);
    dispose(v6Socket);
  }
});

Deno.test("tcp: a refused dial closes the socket; only drop remains valid", async () => {
  // A port with no listener: bind one, note the port, close it.
  const probe = Deno.listen({ transport: "tcp", hostname: "127.0.0.1", port: 0 });
  const { port } = probe.addr as Deno.NetAddr;
  probe.close();

  const socket = TcpSocket.create("ipv4");
  assertEq(await errKindAsync(socket.connect(v4([127, 0, 0, 1], port))), "connection-refused");
  // Failed connect -> closed: connect again is invalid-state, and so is the
  // rest of the surface.
  assertEq(await errKindAsync(socket.connect(v4([127, 0, 0, 1], port))), "invalid-state");
  assertEq(resultErrKind(await socket.send(chunksOf([1]))), "invalid-state");
  assertEq(errKind(() => socket.getLocalAddress()), "invalid-state");
  dispose(socket);
});

Deno.test("tcp: connect is once-only from connected too", async () => {
  const { socket, server } = await connected(echoHandler);
  try {
    assertEq(await errKindAsync(socket.connect(server.addr)), "invalid-state");
    const [rx, rxDone] = socket.receive();
    const txDone = socket.send(chunksOf());
    await collect(rx);
    await txDone;
    await rxDone;
    await server.done;
  } finally {
    dispose(socket);
  }
});

Deno.test("tcp: getters demand the right state (branded)", () => {
  const socket = TcpSocket.create("ipv4");
  assertEq(errKind(() => socket.getLocalAddress()), "invalid-state");
  assertEq(errKind(() => socket.getRemoteAddress()), "invalid-state");
  assertEq(socket.getAddressFamily(), "ipv4");
  dispose(socket);
});

/** Hide the node builtins from detection (the only backend), restore after. */
function withoutBuiltins<T>(fn: () => T): T {
  const proc = (globalThis as { process?: { getBuiltinModule?: unknown } }).process!;
  const saved = proc.getBuiltinModule;
  proc.getBuiltinModule = undefined;
  try {
    return fn();
  } finally {
    proc.getBuiltinModule = saved;
  }
}

Deno.test("tcp: create without node:net is not-supported", () => {
  withoutBuiltins(() => {
    assertEq(errKind(() => TcpSocket.create("ipv4")), "not-supported");
  });
});

// --- teardown: shared ownership ------------------------------------------------

Deno.test("tcp: streams outlive the dropped handle (WIT shared ownership)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { socket, server } = await connected(async (conn) => {
    await gate; // hold the connection open until the client has dropped its handle
    await conn.write(Uint8Array.from([7]));
    // close() in the server wrapper sends the FIN.
  });
  const [rx, rxDone] = socket.receive();
  const txDone = socket.send(chunksOf());
  // Drop the guest handle FIRST: per the WIT, the send/receive streams
  // remain functional — the OS socket must survive until the pumps retire.
  dispose(socket);
  release();
  assertEq(JSON.stringify(await collect(rx)), JSON.stringify([7]));
  assertEq((await rxDone).kind, "ok");
  assertEq((await txDone).kind, "ok");
  await server.done;
});

Deno.test("tcp: dropping the receive reader settles its future ok and releases the socket", async () => {
  let stop = false;
  const { socket, server } = await connected(async (conn) => {
    // Keep offering data until the client is gone.
    while (!stop) {
      try {
        await conn.write(Uint8Array.from([1, 2, 3]));
      } catch {
        break; // client closed: expected
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  });
  try {
    const [rx, rxDone] = socket.receive();
    const it = (rx as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    const first = await it.next();
    assertEq(first.done, false);
    // Guest drops the reader (SHUT_RD): queued data is discarded; the
    // future settles ok — the canceller is the observer.
    await it.return!(undefined);
    assertEq((await rxDone).kind, "ok");
  } finally {
    stop = true;
    dispose(socket);
    await server.done;
  }
});

Deno.test("tcp: dispose during connect closes the fresh conn (branded invalid-state)", async () => {
  const { addr, done } = tcpServer(() => Promise.resolve());
  const socket = TcpSocket.create("ipv4");
  const dial = socket.connect(addr);
  dispose(socket); // the dial is in flight
  assertEq(await errKindAsync(dial), "invalid-state");
  await done;
});

// --- observability -------------------------------------------------------------

Deno.test("tcp: onCall records the driving sequence", async () => {
  const calls: string[] = [];
  const fragment = sockets({ onCall: (c) => calls.push(c) });
  const { addr, done } = tcpServer(echoHandler);
  const socket = fragment.TcpSocket.create("ipv4");
  try {
    await socket.connect(addr);
    socket.getLocalAddress();
    const [rx, rxDone] = socket.receive();
    const txDone = socket.send(chunksOf([1]));
    await collect(rx);
    await txDone;
    await rxDone;
    await done;
    assertEq(
      JSON.stringify(calls),
      JSON.stringify([
        "tcp-socket.create",
        "tcp-socket.connect",
        "tcp-socket.get-local-address",
        "tcp-socket.receive",
        "tcp-socket.send",
      ]),
    );
  } finally {
    dispose(socket);
  }
});

// --- listen: the accept stream --------------------------------------------------

/**
 * Retire a listener: cancel (closes the listener, unparking any accept),
 * drain the generator to completion (its finally releases the stream's
 * ref), and drop the handle. Uniform across generator states — never
 * started, parked in accept, or suspended at a yield.
 */
async function retire(socket: TcpSocket, stream: TcpAcceptStream): Promise<void> {
  stream.cancel();
  for await (const straggler of stream) dispose(straggler);
  dispose(socket);
}

/** Collect `n` accepted sockets from an accept stream's iterator. */
async function acceptN(
  stream: AsyncIterable<TcpSocket>,
  n: number,
): Promise<{ taken: TcpSocket[]; it: AsyncIterator<TcpSocket> }> {
  const it = stream[Symbol.asyncIterator]();
  const taken: TcpSocket[] = [];
  for (let i = 0; i < n; i++) {
    const r = await it.next();
    if (r.done) break;
    taken.push(r.value);
  }
  return { taken, it };
}

Deno.test("tcp listen: implicit ephemeral bind; an accepted socket serves a full echo", async () => {
  const socket = TcpSocket.create("ipv4");
  const stream = await socket.listen();
  assertEq(socket.getIsListening(), true);
  const addr = socket.getLocalAddress();
  assertTrue(addr.kind === "ipv4" && addr.value.port !== 0, "ephemeral port assigned");

  // Dial in from a raw client and speak both directions.
  const client = await Deno.connect({
    transport: "tcp",
    hostname: "127.0.0.1",
    port: addr.kind === "ipv4" ? addr.value.port : 0,
  });
  const { taken, it } = await acceptN(stream, 1);
  assertEq(taken.length, 1);
  const accepted = taken[0];
  try {
    assertEq(accepted.getIsListening(), false);
    assertEq(accepted.getAddressFamily(), "ipv4");
    const remote = accepted.getRemoteAddress();
    const clientLocal = client.localAddr as Deno.NetAddr;
    assertTrue(
      remote.kind === "ipv4" && remote.value.port === clientLocal.port,
      "the accepted socket reports the dialer's address",
    );

    // Client -> accepted socket.
    const [rx, rxDone] = accepted.receive();
    await client.write(Uint8Array.from([1, 2, 3]));
    await client.closeWrite(); // FIN
    assertEq(JSON.stringify(await collect(rx)), JSON.stringify([1, 2, 3]));
    assertEq((await rxDone).kind, "ok");

    // Accepted socket -> client.
    const txDone = accepted.send(chunksOf([4, 5]));
    const buf = new Uint8Array(16);
    const got: number[] = [];
    for (;;) {
      const n = await client.read(buf);
      if (n === null) break;
      got.push(...buf.subarray(0, n));
    }
    assertEq(JSON.stringify(got), JSON.stringify([4, 5]));
    assertEq((await txDone).kind, "ok");
  } finally {
    client.close();
    dispose(accepted);
    void it; // the generator is retired below, through the stream itself
    await retire(socket, stream);
  }
});

Deno.test("tcp listen: bind picks the address; address-in-use surfaces at listen", async () => {
  const first = TcpSocket.create("ipv4");
  first.bind(v4([127, 0, 0, 1], 0));
  const stream = await first.listen();
  const addr = first.getLocalAddress();
  assertTrue(addr.kind === "ipv4" && addr.value.address[0] === 127, "bound to loopback");

  const second = TcpSocket.create("ipv4");
  second.bind(addr);
  assertEq(await errKindAsync(second.listen()), "address-in-use");
  // A failed listen closes the socket.
  assertEq(await errKindAsync(second.listen()), "invalid-state");
  dispose(second);

  await retire(first, stream);
});

Deno.test("tcp listen: state machine (branded)", async () => {
  const socket = TcpSocket.create("ipv4");
  socket.bind(v4([127, 0, 0, 1], 0));
  assertEq(errKind(() => socket.bind(v4([127, 0, 0, 1], 0))), "invalid-state");
  const stream = await socket.listen();
  assertEq(await errKindAsync(socket.listen()), "invalid-state");
  assertEq(await errKindAsync(socket.connect(v4([127, 0, 0, 1], 9))), "invalid-state");
  assertEq(errKind(() => socket.bind(v4([127, 0, 0, 1], 0))), "invalid-state");
  // send/receive on a listener: err futures, never throws.
  assertEq(resultErrKind(await socket.send(chunksOf([1]))), "invalid-state");
  const [rx, rxDone] = socket.receive();
  assertEq(JSON.stringify(await collect(rx)), "[]");
  assertEq(resultErrKind(await rxDone), "invalid-state");
  await retire(socket, stream);
});

Deno.test("tcp listen: bind validation (branded)", () => {
  const socket = TcpSocket.create("ipv4");
  assertEq(errKind(() => socket.bind(v6([0, 0, 0, 0, 0, 0, 0, 1], 0))), "invalid-argument");
  const v6Socket = TcpSocket.create("ipv6");
  assertEq(
    errKind(() => v6Socket.bind(v6([0xfe80, 0, 0, 0, 0, 0, 0, 1], 0, 3))),
    "not-supported",
  );
  dispose(socket);
  dispose(v6Socket);
});

Deno.test("tcp listen: the accept stream survives the dropped handle (shared ownership)", async () => {
  const socket = TcpSocket.create("ipv4");
  const stream = await socket.listen();
  const addr = socket.getLocalAddress();
  const port = addr.kind === "ipv4" ? addr.value.port : 0;
  // Drop the guest handle FIRST: the listener must stay open for the
  // stream (WIT: "The stream returned by listen behaves similarly").
  dispose(socket);
  const client = await Deno.connect({ transport: "tcp", hostname: "127.0.0.1", port });
  const { taken, it } = await acceptN(stream, 1);
  assertEq(taken.length, 1, "still accepting after the handle drop");
  client.close();
  dispose(taken[0]);
  void it;
  await retire(socket, stream); // now the last reference: the listener closes
});

Deno.test("tcp listen: accepted sockets are independent of the listener", async () => {
  const socket = TcpSocket.create("ipv4");
  const stream = await socket.listen();
  const addr = socket.getLocalAddress();
  const port = addr.kind === "ipv4" ? addr.value.port : 0;
  const client = await Deno.connect({ transport: "tcp", hostname: "127.0.0.1", port });
  const { taken, it } = await acceptN(stream, 1);
  const accepted = taken[0];
  void it;
  // Retire the listener entirely: stream cancelled + drained + handle dropped.
  await retire(socket, stream);
  // The accepted connection still works end to end.
  const [rx, rxDone] = accepted.receive();
  await client.write(Uint8Array.from([9]));
  await client.closeWrite();
  assertEq(JSON.stringify(await collect(rx)), JSON.stringify([9]));
  assertEq((await rxDone).kind, "ok");
  const txDone = accepted.send(chunksOf());
  assertEq((await txDone).kind, "ok");
  client.close();
  dispose(accepted);
});

Deno.test("tcp listen: cancel() retires a parked accept and closes the listener", async () => {
  // cancel is the A13 producer-cancellation hook: the runtime's pump
  // invokes it when the guest drops the accept stream while the loop is
  // parked in accept(); this test plays the pump's role.
  const socket = TcpSocket.create("ipv4");
  const stream = await socket.listen();
  const addr = socket.getLocalAddress();
  const it = stream[Symbol.asyncIterator]();
  const pending = it.next(); // parked accept, nobody dialing
  await new Promise((r) => setTimeout(r, 20));
  dispose(socket); // handle gone; the accept stream still holds a ref
  stream.cancel(); // ...until the reader-drop cancellation closes the listener
  const r = await pending;
  assertEq(r.done, true, "the parked accept ends the stream cleanly");
  // The listener really closed: the port refuses a new dial (a RAW Deno
  // error — this dial never goes through the provider).
  let refused = false;
  try {
    const conn = await Deno.connect({
      transport: "tcp",
      hostname: "127.0.0.1",
      port: addr.kind === "ipv4" ? addr.value.port : 0,
    });
    conn.close();
  } catch (e) {
    refused = e instanceof Deno.errors.ConnectionRefused;
  }
  assertTrue(refused, "the listener's port refuses new dials");
});

Deno.test("tcp: connect from a bound socket dials with the chosen source port", async () => {
  // The bind is deferred to the dial (module header): net.connect's
  // localAddress/localPort carry it, and the peer must OBSERVE the chosen
  // port — the assertion that distinguishes a real source binding from a
  // silently ignored one.
  const server = tcpServer(async (conn) => {
    const remote = (conn.remoteAddr as Deno.NetAddr).port;
    await conn.write(Uint8Array.from([remote >> 8, remote & 0xff]));
    // FIN via the wrapper's close.
  });
  // Random high ports; retry the rare collision.
  for (let attempt = 0; ; attempt++) {
    const want = 20000 + Math.floor(Math.random() * 30000);
    const socket = TcpSocket.create("ipv4");
    socket.bind(v4([127, 0, 0, 1], want));
    try {
      await socket.connect(server.addr);
    } catch (e) {
      dispose(socket);
      const kind = (e as ComponentException<SocketErrorCode>).payload?.kind;
      if ((kind === "address-in-use" || kind === "address-not-bindable") && attempt < 4) continue;
      throw e;
    }
    const local = socket.getLocalAddress();
    assertTrue(local.kind === "ipv4" && local.value.port === want, "our own view shows the port");
    const [rx, rxDone] = socket.receive();
    const seen = await collect(rx);
    assertEq(JSON.stringify(seen), JSON.stringify([want >> 8, want & 0xff]),
      "the PEER observed the chosen source port");
    await rxDone;
    const txDone = socket.send(chunksOf());
    await txDone;
    await server.done;
    dispose(socket);
    break;
  }
});
