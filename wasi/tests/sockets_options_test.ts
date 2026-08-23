// Unit tests for the 0.3.1 additions to the sockets fragment
// (src/sockets.ts): UDP connected mode (OS-level `connect`/`disconnect`),
// the socket-option surface with its recorded not-supported set (module
// header, "OPTIONS HONESTY"), and `ip-name-lookup.resolve-addresses`.
// Same conventions as sockets_test.ts: real loopback sockets; every
// guest-visible failure must be a BRANDED ComponentException.

import { ComponentException } from "@polyengine/protocol";
import {
  type IpAddress,
  type IpSocketAddress,
  type NameLookupErrorCode,
  type SocketErrorCode,
  sockets,
  type TcpSocket,
  type UdpSocket,
} from "../src/sockets.ts";
import { assertEq, assertRejects, assertThrows, assertTrue } from "./asserts.ts";

const { UdpSocket, TcpSocket, resolveAddresses } = sockets();

const v4 = (address: [number, number, number, number], port: number): IpSocketAddress => ({
  kind: "ipv4",
  value: { port, address },
});

function errKind(fn: () => unknown): string {
  const e = assertThrows(fn);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return ((e as ComponentException<SocketErrorCode>).payload).kind;
}

async function errKindAsync(p: Promise<unknown>): Promise<string> {
  const e = await assertRejects(() => p);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return ((e as ComponentException<SocketErrorCode>).payload).kind;
}

function boundV4(): { socket: UdpSocket; addr: IpSocketAddress } {
  const socket = UdpSocket.create("ipv4");
  socket.bind(v4([127, 0, 0, 1], 0));
  return { socket, addr: socket.getLocalAddress() };
}

// --- udp connected mode -------------------------------------------------------

Deno.test("udp connect: send with no remote reaches the connected peer", async () => {
  const peer = boundV4();
  const socket = UdpSocket.create("ipv4");
  await socket.connect(peer.addr); // implicit wildcard bind + OS connect
  assertEq(JSON.stringify(socket.getRemoteAddress()), JSON.stringify(peer.addr));
  await socket.send(Uint8Array.from([1, 2, 3]), undefined);
  const [payload, from] = await peer.socket.receive();
  assertEq([...payload].join(","), "1,2,3");
  // The implicit bind is to the wildcard, so getLocalAddress reports
  // 0.0.0.0; the wire source is the route's address with the same port.
  const local = socket.getLocalAddress();
  assertEq(from.value.port, local.value.port);
  socket[Symbol.dispose]();
  peer.socket[Symbol.dispose]();
});

Deno.test("udp connect: an explicit remote on a connected socket is invalid-argument", async () => {
  const peer = boundV4();
  const socket = UdpSocket.create("ipv4");
  await socket.connect(peer.addr);
  assertEq(await errKindAsync(socket.send(new Uint8Array(1), peer.addr)), "invalid-argument");
  socket[Symbol.dispose]();
  peer.socket[Symbol.dispose]();
});

Deno.test("udp connect: the kernel filters inbound datagrams to the remote", async () => {
  const peer = boundV4();
  const stranger = boundV4();
  const socket = UdpSocket.create("ipv4");
  await socket.connect(peer.addr);
  // The implicit bind is to the wildcard; datagrams reach it via loopback.
  const local = v4([127, 0, 0, 1], socket.getLocalAddress().value.port);
  // The stranger's datagram must NOT arrive; the peer's must.
  await stranger.socket.send(Uint8Array.from([9]), local);
  await peer.socket.send(Uint8Array.from([7]), local);
  const [payload, from] = await socket.receive();
  assertEq([...payload].join(","), "7");
  assertEq(JSON.stringify(from), JSON.stringify(peer.addr));
  socket[Symbol.dispose]();
  peer.socket[Symbol.dispose]();
  stranger.socket[Symbol.dispose]();
});

Deno.test("udp disconnect: back to unconnected — sends need a remote again", async () => {
  const peer = boundV4();
  const socket = UdpSocket.create("ipv4");
  await socket.connect(peer.addr);
  socket.disconnect();
  assertEq(errKind(() => socket.getRemoteAddress()), "invalid-state");
  assertEq(await errKindAsync(socket.send(new Uint8Array(1), undefined)), "invalid-argument");
  await socket.send(Uint8Array.from([4]), peer.addr); // explicit works again
  const [payload] = await peer.socket.receive();
  assertEq(payload.length, 1);
  socket[Symbol.dispose]();
  peer.socket[Symbol.dispose]();
});

Deno.test("udp connect: state machine — connect twice, disconnect unconnected", async () => {
  const peer = boundV4();
  const socket = UdpSocket.create("ipv4");
  await socket.connect(peer.addr);
  assertEq(await errKindAsync(socket.connect(peer.addr)), "invalid-state");
  socket[Symbol.dispose]();
  const fresh = UdpSocket.create("ipv4");
  assertEq(errKind(() => fresh.disconnect()), "invalid-state");
  fresh[Symbol.dispose]();
  peer.socket[Symbol.dispose]();
});

// --- udp options ----------------------------------------------------------------

Deno.test("udp options: hop limit — cached getter, real setter, floor of 1", () => {
  const { socket } = boundV4();
  assertEq(socket.getUnicastHopLimit(), 64); // the documented default
  socket.setUnicastHopLimit(9);
  assertEq(socket.getUnicastHopLimit(), 9);
  assertEq(errKind(() => socket.setUnicastHopLimit(0)), "invalid-argument");
  socket[Symbol.dispose]();
});

Deno.test("udp options: buffer sizes are live once bound; zero is invalid", () => {
  const { socket } = boundV4();
  const initial = socket.getReceiveBufferSize();
  assertTrue(initial > 0n, "a bound socket reports a real SO_RCVBUF");
  socket.setReceiveBufferSize(65536n);
  assertTrue(socket.getReceiveBufferSize() >= 65536n, "kernel may double, never shrink below");
  socket.setSendBufferSize(65536n);
  assertTrue(socket.getSendBufferSize() >= 65536n, "SO_SNDBUF applied");
  assertEq(errKind(() => socket.setSendBufferSize(0n)), "invalid-argument");
  socket[Symbol.dispose]();
});

Deno.test("udp options: pre-bind sets are cached and applied at bind", () => {
  const socket = UdpSocket.create("ipv4");
  socket.setReceiveBufferSize(131072n);
  assertEq(socket.getReceiveBufferSize(), 131072n); // the cached request
  socket.bind(v4([127, 0, 0, 1], 0));
  assertTrue(socket.getReceiveBufferSize() >= 131072n, "applied at bind");
  socket[Symbol.dispose]();
});

// --- tcp options ----------------------------------------------------------------

Deno.test("tcp options: keep-alive enabled + idle-time cache and apply", async () => {
  const listener = TcpSocket.create("ipv4");
  listener.bind(v4([127, 0, 0, 1], 0));
  const accepts = await listener.listen();
  const socket = TcpSocket.create("ipv4");
  assertEq(socket.getKeepAliveEnabled(), false);
  assertEq(socket.getKeepAliveIdleTime(), 7_200_000_000_000n); // documented default
  socket.setKeepAliveIdleTime(30_000_000_000n); // pre-connect: cached
  socket.setKeepAliveEnabled(true);
  await socket.connect(listener.getLocalAddress()); // applied here
  assertEq(socket.getKeepAliveEnabled(), true);
  assertEq(socket.getKeepAliveIdleTime(), 30_000_000_000n);
  socket.setKeepAliveEnabled(false); // set-while-connected path
  assertEq(errKind(() => socket.setKeepAliveIdleTime(0n)), "invalid-argument");
  socket[Symbol.dispose]();
  accepts.cancel();
  for await (const s of accepts) s[Symbol.dispose]();
  listener[Symbol.dispose]();
});

Deno.test("tcp options: backlog pre-listen ok; while listening not-supported; zero invalid", async () => {
  const socket = TcpSocket.create("ipv4");
  socket.setListenBacklogSize(4n);
  assertEq(errKind(() => socket.setListenBacklogSize(0n)), "invalid-argument");
  socket.bind(v4([127, 0, 0, 1], 0));
  const accepts = await socket.listen(); // the stored backlog rides listen()
  assertEq(errKind(() => socket.setListenBacklogSize(8n)), "not-supported");
  accepts.cancel();
  for await (const s of accepts) s[Symbol.dispose]();
  socket[Symbol.dispose]();
});

Deno.test("tcp options: the no-node-API set fails not-supported, never emulates", () => {
  const socket = TcpSocket.create("ipv4");
  const calls: (() => unknown)[] = [
    () => socket.getKeepAliveInterval(),
    () => socket.setKeepAliveInterval(1n),
    () => socket.getKeepAliveCount(),
    () => socket.setKeepAliveCount(1),
    () => socket.getHopLimit(),
    () => socket.setHopLimit(1),
    () => socket.getReceiveBufferSize(),
    () => socket.setReceiveBufferSize(1n),
    () => socket.getSendBufferSize(),
    () => socket.setSendBufferSize(1n),
  ];
  for (const call of calls) assertEq(errKind(call), "not-supported");
  socket[Symbol.dispose]();
});

// --- ip-name-lookup --------------------------------------------------------------

function lookupErrKind(e: unknown): NameLookupErrorCode["kind"] {
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return ((e as ComponentException<NameLookupErrorCode>).payload).kind;
}

Deno.test("resolve-addresses: IP literals answer locally, both families", async () => {
  const [a] = await resolveAddresses("127.0.0.1");
  assertEq(JSON.stringify(a), JSON.stringify({ kind: "ipv4", value: [127, 0, 0, 1] }));
  const [b] = await resolveAddresses("::1");
  assertEq(
    JSON.stringify(b),
    JSON.stringify({ kind: "ipv6", value: [0, 0, 0, 0, 0, 0, 0, 1] }),
  );
});

Deno.test("resolve-addresses: localhost resolves to loopback(s)", async () => {
  const answers: IpAddress[] = await resolveAddresses("localhost");
  assertTrue(answers.length > 0, "at least one answer");
  assertTrue(
    answers.every((a) =>
      (a.kind === "ipv4" && a.value.join(".") === "127.0.0.1") ||
      (a.kind === "ipv6" && a.value.join(":") === "0:0:0:0:0:0:0:1")
    ),
    `loopback answers, got ${JSON.stringify(answers)}`,
  );
});

Deno.test("resolve-addresses: failures are branded with the lookup vocabulary", async () => {
  assertEq(lookupErrKind(await assertRejects(() => resolveAddresses(""))), "invalid-argument");
  assertEq(
    lookupErrKind(
      await assertRejects(() => resolveAddresses("definitely-not-a-real-host.invalid")),
    ),
    "name-unresolvable",
  );
});

Deno.test("fragment: ip-name-lookup rides the sockets fragment under its own track key", () => {
  const { imports } = sockets();
  const lookup = imports["wasi:sockets/ip-name-lookup@0.3"] as {
    resolveAddresses: (name: string) => Promise<IpAddress[]>;
  };
  assertTrue(typeof lookup.resolveAddresses === "function", "registered");
});
