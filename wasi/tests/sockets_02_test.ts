// Unit tests for the `wasi:sockets@0.2` track (src/internal/sockets_02.ts): the
// two-phase state machines, the poll-shaped would-block contracts, and
// the BARE-STRING enum error payloads (0.2's error-code is an enum, not
// 0.3's variant — embedder-api.md §"Naming and casing" — the rule the composed gate can't isolate). The
// happy composed path is integration_net_test.ts's std::net battery.

import { ComponentException } from "@polyengine/protocol";
import type { Pollable } from "../src/io.ts";
import { type IpSocketAddress, SocketIoError, sockets } from "../src/sockets.ts";
import { assertEq, assertThrows, assertTrue } from "./asserts.ts";

const { imports } = sockets();

type Net = object;
interface InStream {
  read(len: bigint): Uint8Array;
  subscribe(): Pollable;
}
interface OutStream {
  checkWrite(): bigint;
  write(b: Uint8Array): void;
  blockingFlush(): void | Promise<void>;
}
interface Tcp02 {
  startBind(net: Net, addr: IpSocketAddress): void;
  finishBind(): void;
  startConnect(net: Net, addr: IpSocketAddress): void;
  finishConnect(): [InStream, OutStream];
  startListen(): void;
  finishListen(): void;
  accept(): [Tcp02, InStream, OutStream];
  subscribe(): Pollable;
  shutdown(t: string): void;
  localAddress(): IpSocketAddress;
  remoteAddress(): IpSocketAddress;
  isListening(): boolean;
  addressFamily(): string;
  keepAliveEnabled(): boolean;
  receiveBufferSize(): bigint;
  [Symbol.dispose](): void;
}
interface Udp02 {
  startBind(net: Net, addr: IpSocketAddress): void;
  finishBind(): void;
  stream(remote?: IpSocketAddress): [
    { receive(max: bigint): { data: Uint8Array; remoteAddress: IpSocketAddress }[]; subscribe(): Pollable },
    { checkSend(): bigint; send(d: { data: Uint8Array; remoteAddress?: IpSocketAddress }[]): bigint; subscribe(): Pollable },
  ];
  localAddress(): IpSocketAddress;
  [Symbol.dispose](): void;
}

const net = (imports["wasi:sockets/instance-network@0.2"] as { instanceNetwork(): Net })
  .instanceNetwork();
const { createTcpSocket } = imports["wasi:sockets/tcp-create-socket@0.2"] as {
  createTcpSocket(f: string): Tcp02;
};
const { createUdpSocket } = imports["wasi:sockets/udp-create-socket@0.2"] as {
  createUdpSocket(f: string): Udp02;
};
const { networkErrorCode } = imports["wasi:sockets/network@0.2"] as {
  networkErrorCode(e: unknown): string | undefined;
};
const nameLookup = imports["wasi:sockets/ip-name-lookup@0.2"] as {
  resolveAddresses(n: Net, name: string): {
    resolveNextAddress(): { kind: string; value: number[] } | undefined;
    subscribe(): Pollable;
  };
};

const v4 = (address: [number, number, number, number], port: number): IpSocketAddress => ({
  kind: "ipv4",
  value: { port, address },
});
const LOOPBACK = v4([127, 0, 0, 1], 0);

/** 0.2 err payloads are BARE enum strings. */
function errCode(fn: () => unknown): string {
  const e = assertThrows(fn);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  const payload = (e as ComponentException).payload;
  assertTrue(typeof payload === "string", `expected a bare enum string, got ${JSON.stringify(payload)}`);
  return payload as string;
}

async function settled(p: Pollable): Promise<void> {
  while (!p.ready()) await p.waitPromise();
}

Deno.test("tcp02: the two-phase state machine speaks bare-string errors", () => {
  const socket = createTcpSocket("ipv4");
  assertEq(errCode(() => socket.finishBind()), "not-in-progress");
  assertEq(errCode(() => socket.finishConnect()), "not-in-progress");
  assertEq(errCode(() => socket.finishListen()), "not-in-progress");
  assertEq(errCode(() => socket.accept()), "invalid-state");
  assertEq(errCode(() => socket.localAddress()), "invalid-state");
  socket.startBind(net, LOOPBACK);
  assertEq(errCode(() => socket.startBind(net, LOOPBACK)), "invalid-state");
  socket.finishBind();
  assertEq(socket.addressFamily(), "ipv4");
  assertEq(socket.isListening(), false);
  socket[Symbol.dispose]();
});

Deno.test("tcp02: listen -> deferred bind would-block -> pollable -> accept would-block", async () => {
  const socket = createTcpSocket("ipv4");
  socket.startBind(net, LOOPBACK);
  socket.finishBind();
  socket.startListen();
  // The OS bind settles one tick later (the deferred-bind divergence):
  // the poll-shaped caller sees would-block, then parks on the pollable.
  assertEq(errCode(() => socket.finishListen()), "would-block");
  await settled(socket.subscribe());
  socket.finishListen();
  assertTrue(socket.isListening(), "listening");
  assertTrue(socket.localAddress().value.port !== 0, "a real ephemeral port");
  // No pending connections: accept is would-block, not a hang.
  assertEq(errCode(() => socket.accept()), "would-block");
  socket[Symbol.dispose]();
});

Deno.test("tcp02: dial + accept + byte streams + FIN, poll-shaped end to end", async () => {
  const listener = createTcpSocket("ipv4");
  listener.startBind(net, LOOPBACK);
  listener.finishBind();
  listener.startListen();
  await settled(listener.subscribe());
  listener.finishListen();
  const addr = listener.localAddress();

  const client = createTcpSocket("ipv4");
  client.startConnect(net, addr);
  assertEq(errCode(() => client.finishConnect()), "would-block");
  await settled(client.subscribe());
  const [clientIn, clientOut] = client.finishConnect();

  await settled(listener.subscribe()); // the accept queue gains the dial
  const [served, servedIn, servedOut] = listener.accept();
  assertEq(served.remoteAddress().value.port, client.localAddress().value.port);

  // client -> served
  assertTrue(clientOut.checkWrite() > 0n, "a real write permit");
  clientOut.write(new TextEncoder().encode("ping"));
  await clientOut.blockingFlush();
  client.shutdown("send");
  const inbound: number[] = [];
  const inStream = servedIn;
  for (;;) {
    const chunk = inStream.read(64n);
    if (chunk.length > 0) {
      inbound.push(...chunk);
      continue;
    }
    // Empty read on an open stream: poll, then retry; `closed` ends it.
    try {
      await settled(inStream.subscribe());
      const next = inStream.read(64n);
      if (next.length > 0) inbound.push(...next);
    } catch (e) {
      assertEq(((e as ComponentException).payload as { kind: string }).kind, "closed");
      break;
    }
  }
  assertEq(new TextDecoder().decode(Uint8Array.from(inbound)), "ping");

  // served -> client
  servedOut.write(new TextEncoder().encode("pong"));
  await servedOut.blockingFlush();
  served.shutdown("send");
  await settled(clientIn.subscribe());
  assertEq(new TextDecoder().decode(clientIn.read(64n)), "pong");

  served[Symbol.dispose]();
  client[Symbol.dispose]();
  listener[Symbol.dispose]();
});

Deno.test("tcp02: a refused dial fails finish-connect and closes the socket", async () => {
  // Bind-then-dispose frees a port that then refuses.
  const probe = createTcpSocket("ipv4");
  probe.startBind(net, LOOPBACK);
  probe.finishBind();
  probe.startListen();
  await settled(probe.subscribe());
  probe.finishListen();
  const addr = probe.localAddress();
  probe[Symbol.dispose]();

  const socket = createTcpSocket("ipv4");
  socket.startConnect(net, addr);
  await settled(socket.subscribe());
  assertEq(errCode(() => socket.finishConnect()), "connection-refused");
  // "the only valid action left is to drop":
  assertEq(errCode(() => socket.startConnect(net, addr)), "invalid-state");
  socket[Symbol.dispose]();
});

Deno.test("udp02: sync bind, stream generations, connected-mode filter", async () => {
  const a = createUdpSocket("ipv4");
  a.startBind(net, LOOPBACK);
  a.finishBind(); // never would-block: udp bind is synchronous here
  const b = createUdpSocket("ipv4");
  b.startBind(net, LOOPBACK);
  b.finishBind();
  const aAddr = a.localAddress();
  const bAddr = b.localAddress();

  const [aIn, aOut] = a.stream(undefined);
  const [bIn, bOut] = b.stream(aAddr); // b is connected to a

  assertTrue(aOut.checkSend() > 0n, "a send permit");
  assertEq(aOut.send([{ data: Uint8Array.from([1]), remoteAddress: bAddr }]), 1n);
  await settled(bIn.subscribe());
  const got = bIn.receive(8n);
  assertEq(got.length, 1);
  assertEq(got[0].remoteAddress.value.port, aAddr.value.port);

  // Connected sends omit the remote; a mismatched explicit one is invalid.
  assertEq(bOut.send([{ data: Uint8Array.from([2]) }]), 1n);
  assertEq(
    errCode(() => bOut.send([{ data: new Uint8Array(1), remoteAddress: bAddr }])),
    "invalid-argument",
  );
  await settled(aIn.subscribe());
  assertEq(aIn.receive(8n).length, 1);

  // A new stream() call invalidates the previous pair.
  const [aIn2] = a.stream(undefined);
  assertEq(errCode(() => aIn.receive(1n)), "invalid-state");
  assertEq(errCode(() => aOut.checkSend()), "invalid-state");
  assertEq(aIn2.receive(1n).length, 0); // empty, never would-block

  a[Symbol.dispose]();
  b[Symbol.dispose]();
});

Deno.test("udp02: unconnected send requires a remote (bare-string invalid-argument)", () => {
  const socket = createUdpSocket("ipv4");
  socket.startBind(net, LOOPBACK);
  socket.finishBind();
  const [, out] = socket.stream(undefined);
  assertEq(errCode(() => out.send([{ data: new Uint8Array(1) }])), "invalid-argument");
  socket[Symbol.dispose]();
});

Deno.test("ip-name-lookup02: literals answer synchronously; misses fail after the pollable", async () => {
  const literal = nameLookup.resolveAddresses(net, "127.0.0.1");
  const first = literal.resolveNextAddress();
  assertEq(JSON.stringify(first), JSON.stringify({ kind: "ipv4", value: [127, 0, 0, 1] }));
  assertEq(literal.resolveNextAddress(), undefined); // end of stream

  const miss = nameLookup.resolveAddresses(net, "definitely-not-a-real-host.invalid");
  await settled(miss.subscribe());
  assertEq(errCode(() => miss.resolveNextAddress()), "name-unresolvable");
});

Deno.test("network02: error-code downcast recognizes exactly our stream errors", () => {
  assertEq(networkErrorCode(new SocketIoError("connection-reset", "peer reset")), "connection-reset");
  assertEq(networkErrorCode(new Error("random")), undefined);
});
