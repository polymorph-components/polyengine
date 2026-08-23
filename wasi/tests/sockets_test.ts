// Unit tests for the à la carte `wasi:sockets/types@0.3` UDP provider
// (src/sockets.ts, adopted from polymorph-components/polymorph-iroh#69):
// the address codec, the wasmtime-parity state machine, and the error
// mapping — including the failure shapes a happy-path consumer exam never
// reaches.
//
// Every guest-visible failure must arrive as a BRANDED ComponentException
// (contracts/embedder-api.md, "Error model"): an assertion here failing
// with a bare Error means the guest would have seen a trap, not an err.
//
// These tests bind real UDP sockets on loopback, so the test task carries
// `--allow-net --unstable-net`; without `--unstable-net` the provider
// (correctly) answers `not-supported` and everything past `create` fails.

import { ComponentException } from "@polyengine/protocol";
import {
  ipHostname,
  type IpSocketAddress,
  MAX_UDP_DATAGRAM_SIZE,
  parseNetAddr,
  type SocketErrorCode,
  sockets,
  SOCKETS_TYPES_INTERFACE,
  type UdpSocket,
} from "../src/sockets.ts";
import { assertEq, assertRejects, assertThrows, assertTrue } from "./asserts.ts";

const { UdpSocket } = sockets();

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

/** Structural equality, the package test convention (io_test.ts). */
function assertAddrEq(actual: IpSocketAddress, expected: IpSocketAddress, msg?: string): void {
  assertEq(JSON.stringify(actual), JSON.stringify(expected), msg);
}

/** The payload kind of a thrown, branded socket error. */
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

function dispose(socket: UdpSocket): void {
  socket[Symbol.dispose]();
}

/** A socket bound to an ephemeral IPv4 loopback port. */
function boundV4(): { socket: UdpSocket; addr: IpSocketAddress } {
  const socket = UdpSocket.create("ipv4");
  socket.bind(v4([127, 0, 0, 1], 0));
  return { socket, addr: socket.getLocalAddress() };
}

// --- address codec -----------------------------------------------------------

Deno.test("codec: IPv4 round trip", () => {
  const addr = v4([127, 0, 0, 1], 4242);
  assertEq(ipHostname(addr), "127.0.0.1");
  assertAddrEq(parseNetAddr({ transport: "udp", hostname: "127.0.0.1", port: 4242 }), addr);
});

Deno.test("codec: IPv6 hostname spellings", () => {
  const port = 7;
  assertAddrEq(
    parseNetAddr({ transport: "udp", hostname: "::1", port }),
    v6([0, 0, 0, 0, 0, 0, 0, 1], port),
  );
  assertAddrEq(
    parseNetAddr({ transport: "udp", hostname: "::", port }),
    v6([0, 0, 0, 0, 0, 0, 0, 0], port),
  );
  assertAddrEq(
    parseNetAddr({ transport: "udp", hostname: "2001:db8::8a2e:370:7334", port }),
    v6([0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334], port),
  );
  assertAddrEq(
    parseNetAddr({ transport: "udp", hostname: "0:0:0:0:0:0:0:1", port }),
    v6([0, 0, 0, 0, 0, 0, 0, 1], port),
  );
  // The dual-stack rendering of an IPv4 sender (see the module header).
  assertAddrEq(
    parseNetAddr({ transport: "udp", hostname: "::ffff:127.0.0.1", port }),
    v6([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001], port),
  );
  // Zones: numeric parses as the scope-id; a name is not representable.
  assertAddrEq(
    parseNetAddr({ transport: "udp", hostname: "fe80::1%3", port }),
    v6([0xfe80, 0, 0, 0, 0, 0, 0, 1], port, 3),
  );
  assertAddrEq(
    parseNetAddr({ transport: "udp", hostname: "fe80::1%eth0", port }),
    v6([0xfe80, 0, 0, 0, 0, 0, 0, 1], port, 0),
  );
});

Deno.test("codec: IPv6 hostname formatting is the uncompressed form", () => {
  assertEq(ipHostname(v6([0, 0, 0, 0, 0, 0, 0, 1], 0)), "0:0:0:0:0:0:0:1");
  assertEq(
    ipHostname(v6([0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334], 0)),
    "2001:db8:0:0:0:8a2e:370:7334",
  );
});

// --- bind + local address ----------------------------------------------------

Deno.test("bind: ephemeral IPv4 loopback, get-local-address reports the port", () => {
  const { socket, addr } = boundV4();
  try {
    assertEq(addr.kind, "ipv4");
    if (addr.kind !== "ipv4") return;
    assertEq(JSON.stringify(addr.value.address), JSON.stringify([127, 0, 0, 1]));
    assertTrue(addr.value.port !== 0, "an ephemeral port was assigned");
  } finally {
    dispose(socket);
  }
});

Deno.test("bind: ephemeral IPv6 loopback", () => {
  const socket = UdpSocket.create("ipv6");
  try {
    socket.bind(v6([0, 0, 0, 0, 0, 0, 0, 1], 0));
    const addr = socket.getLocalAddress();
    assertEq(addr.kind, "ipv6");
    if (addr.kind !== "ipv6") return;
    assertEq(JSON.stringify(addr.value.address), JSON.stringify([0, 0, 0, 0, 0, 0, 0, 1]));
    assertTrue(addr.value.port !== 0);
  } finally {
    dispose(socket);
  }
});

// --- the data path -----------------------------------------------------------

Deno.test("send/receive: a datagram crosses loopback with its source address", async () => {
  const a = boundV4();
  const b = boundV4();
  try {
    await a.socket.send(new Uint8Array([1, 2, 3]), b.addr);
    const [payload, from] = await b.socket.receive();
    assertEq(JSON.stringify([...payload]), JSON.stringify([1, 2, 3]));
    assertAddrEq(from, a.addr);
  } finally {
    dispose(a.socket);
    dispose(b.socket);
  }
});

Deno.test("send/receive: a zero-length datagram to self (a pump's self-wake)", async () => {
  const { socket, addr } = boundV4();
  try {
    const pending = socket.receive();
    await socket.send(new Uint8Array(0), addr);
    const [payload, from] = await pending;
    assertEq(payload.length, 0);
    assertAddrEq(from, addr);
  } finally {
    dispose(socket);
  }
});

Deno.test("send/receive: a 4096-byte datagram (a QUIC guest's packet ceiling)", async () => {
  const a = boundV4();
  const b = boundV4();
  try {
    const big = new Uint8Array(4096);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    await a.socket.send(big, b.addr);
    const [payload] = await b.socket.receive();
    assertEq(payload.length, big.length);
    assertEq(JSON.stringify([...payload]), JSON.stringify([...big]));
  } finally {
    dispose(a.socket);
    dispose(b.socket);
  }
});

Deno.test("send: implicit bind on an unbound socket", async () => {
  const listener = boundV4();
  const sender = UdpSocket.create("ipv4");
  try {
    await sender.send(new Uint8Array([9]), listener.addr);
    const local = sender.getLocalAddress();
    assertTrue(local.kind === "ipv4" && local.value.port !== 0, "send bound the socket");
    const [payload] = await listener.socket.receive();
    assertEq(JSON.stringify([...payload]), JSON.stringify([9]));
  } finally {
    dispose(sender);
    dispose(listener.socket);
  }
});

// --- error contract ----------------------------------------------------------

Deno.test("errors: the datagram-too-large ceiling, both detection paths", async () => {
  const { socket, addr } = boundV4();
  try {
    // Above the WIT ceiling: refused before the OS.
    assertEq(
      await errKindAsync(socket.send(new Uint8Array(MAX_UDP_DATAGRAM_SIZE + 1), addr)),
      "datagram-too-large",
    );
    // Under the ceiling but above the UDP payload maximum: the OS's
    // EMSGSIZE, mapped.
    assertEq(
      await errKindAsync(socket.send(new Uint8Array(65508), addr)),
      "datagram-too-large",
    );
  } finally {
    dispose(socket);
  }
});

Deno.test("errors: the unbound state machine", async () => {
  const socket = UdpSocket.create("ipv4");
  assertEq(await errKindAsync(socket.receive()), "invalid-state");
  assertEq(errKind(() => socket.getLocalAddress()), "invalid-state");
});

Deno.test("errors: bind is once-only and surfaces address-in-use", () => {
  const { socket, addr } = boundV4();
  const other = UdpSocket.create("ipv4");
  try {
    assertEq(errKind(() => socket.bind(v4([127, 0, 0, 1], 0))), "invalid-state");
    assertEq(errKind(() => other.bind(addr)), "address-in-use");
  } finally {
    dispose(socket);
    dispose(other);
  }
});

Deno.test("errors: send argument validation", async () => {
  const { socket } = boundV4();
  const v6Socket = UdpSocket.create("ipv6");
  try {
    assertEq(
      await errKindAsync(socket.send(new Uint8Array([1]), undefined)),
      "invalid-argument",
    );
    // Family mismatch, unspecified address, port zero.
    assertEq(
      await errKindAsync(socket.send(new Uint8Array([1]), v6([0, 0, 0, 0, 0, 0, 0, 1], 9))),
      "invalid-argument",
    );
    assertEq(
      await errKindAsync(socket.send(new Uint8Array([1]), v4([0, 0, 0, 0], 9))),
      "invalid-argument",
    );
    assertEq(
      await errKindAsync(socket.send(new Uint8Array([1]), v4([127, 0, 0, 1], 0))),
      "invalid-argument",
    );
    // An IPv4-mapped IPv6 address never crosses the family boundary
    // (wasmtime-wasi parity).
    assertEq(
      await errKindAsync(
        v6Socket.send(new Uint8Array([1]), v6([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1], 9)),
      ),
      "invalid-argument",
    );
  } finally {
    dispose(socket);
    dispose(v6Socket);
  }
});

Deno.test("errors: a non-zero scope-id is not-supported (recorded divergence)", () => {
  const socket = UdpSocket.create("ipv6");
  try {
    assertEq(
      errKind(() => socket.bind(v6([0xfe80, 0, 0, 0, 0, 0, 0, 1], 0, 3))),
      "not-supported",
    );
  } finally {
    dispose(socket);
  }
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

Deno.test("errors: create without node:dgram is not-supported", () => {
  // The capability answer a socketless deployment (a browser) gives.
  withoutBuiltins(() => {
    assertEq(errKind(() => UdpSocket.create("ipv4")), "not-supported");
  });
});

Deno.test("errors: capability re-detection at bind survives the error mapper", () => {
  // The branded not-supported from the disappeared-after-create path must
  // pass through mapPlatformError unchanged, not demote to `other`.
  const socket = UdpSocket.create("ipv4");
  try {
    withoutBuiltins(() => {
      assertEq(errKind(() => socket.bind(v4([127, 0, 0, 1], 0))), "not-supported");
    });
  } finally {
    dispose(socket);
  }
});

// --- teardown ----------------------------------------------------------------

Deno.test("dispose: idempotent; a disposed socket is unbound again", async () => {
  const { socket } = boundV4();
  dispose(socket);
  dispose(socket);
  assertEq(await errKindAsync(socket.receive()), "invalid-state");
});

Deno.test("dispose: a pending receive settles as a branded err, never a trap", async () => {
  const { socket } = boundV4();
  const pending = socket.receive();
  // Let the receive park before the close pulls the socket out from under
  // it.
  await new Promise((r) => setTimeout(r, 20));
  dispose(socket);
  assertEq(await errKindAsync(pending), "invalid-state");
});

// --- the fragment shape ------------------------------------------------------

Deno.test("fragment: registered under the track key; onCall observes the driving sequence", () => {
  const calls: string[] = [];
  const fragment = sockets({ onCall: (c) => calls.push(c) });
  assertEq(SOCKETS_TYPES_INTERFACE, "wasi:sockets/types@0.3");
  const iface = fragment.imports[SOCKETS_TYPES_INTERFACE] as {
    UdpSocket: typeof UdpSocket;
    TcpSocket: unknown;
  };
  assertEq(iface.UdpSocket, fragment.UdpSocket);
  assertEq(iface.TcpSocket, fragment.TcpSocket);
  const socket = fragment.UdpSocket.create("ipv4");
  try {
    socket.bind(v4([127, 0, 0, 1], 0));
    socket.getLocalAddress();
    assertEq(
      JSON.stringify(calls),
      JSON.stringify(["udp-socket.create", "udp-socket.bind", "udp-socket.get-local-address"]),
    );
  } finally {
    dispose(socket);
  }
});

Deno.test("fragment: onCall is per fragment, not shared module state", () => {
  const aCalls: string[] = [];
  const a = sockets({ onCall: (c) => aCalls.push(c) });
  const b = sockets();
  const theirs = b.UdpSocket.create("ipv4");
  dispose(theirs);
  assertEq(aCalls.length, 0, "a foreign fragment's calls never leak in");
  const mine = a.UdpSocket.create("ipv4");
  dispose(mine);
  assertEq(JSON.stringify(aCalls), JSON.stringify(["udp-socket.create"]));
});
