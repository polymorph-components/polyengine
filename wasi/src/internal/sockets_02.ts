// `wasi:sockets@0.2` — network, instance-network, tcp, tcp-create-socket,
// udp, udp-create-socket, ip-name-lookup: the poll-shaped 0.2 surface,
// served over the same node-builtins backend as the 0.3 track
// (sockets_platform.ts) and registered by `sockets()` alongside it.
//
// THE DRIVING PATTERN (pinned empirically from the net-probe fixture's
// leaf imports — what wasi-libc actually calls): every potentially-slow
// operation is split into non-blocking halves plus a pollable —
// `start-connect`/`finish-connect` looping on `would-block`,
// `accept` returning `would-block` until `subscribe`'s pollable is ready,
// datagram streams with `receive(max)`/`check-send`+`send` batches — and
// wasi-libc emulates POSIX blocking by `pollable.block()` (the io.ts
// parking kernel, A14). Socket byte I/O rides `wasi:io/streams@0.2`:
// wasi-libc links the NON-blocking `input-stream.read` + `subscribe`
// (never `blocking-read`) and `check-write`/`write`/`blocking-flush` —
// exactly the surfaces of io.ts's async-backed `FedInputStream` /
// `SinkOutputStream`, which this module mints over connections. The
// PARKING therefore happens in `Pollable.block`/`poll` and
// `blocking-flush`, all already A14-marked: 0.2 socket guests need JSPI
// on V8 engines, like the 0.3 track's `listen`.
//
// 0.2's `error-code` is an ENUM (bare strings — the A10 rule), with a
// different vocabulary than 0.3's variant: it grew `unknown`,
// `would-block`, `not-in-progress`, `concurrency-conflict`,
// `new-socket-limit` and the name-lookup codes, and it lacks
// `connection-broken` (mapped to `connection-reset` here) and `other`
// (mapped to `unknown`). `network-error-code(borrow<error>)` downcasts
// exactly the io errors these socket streams minted (`SocketIoError`,
// the filesystem-error-code pattern).
//
// Recorded divergences (the sockets.ts stances carried over, plus 0.2's
// own):
//
//   * tcp `bind` records the address; the OS bind is DEFERRED to listen/
//     connect (node cannot bind an unconnected socket) — so finish-bind
//     always succeeds and bind errors surface at the deferred call, with
//     their real codes.
//   * udp bind IS synchronous (the dgram sync-lookup trick), so
//     start-bind performs it and finish-bind never returns would-block.
//   * outgoing-datagram-stream.send hands datagrams to node and counts
//     them sent — the WIT's "sent (or queued for sending)" latitude; an
//     async send failure surfaces on the NEXT check-send/send call.
//   * udp connected mode uses the OS connect when the backend has it,
//     with the provider-side source filter as a BACKSTOP (Deno's dgram
//     compat treats connect() as default-destination only).
//   * socket options: identical honesty to the 0.3 track (module header
//     of sockets.ts) — tcp keep-alive enabled/idle-time and udp
//     hop-limit/buffer-sizes are real where node has API, cached-getter
//     where it has only a setter, `not-supported` where it has neither.

import { ComponentException } from "@polyengine/protocol";
import { FedInputStream, IoError, Pollable, SinkOutputStream } from "../io.ts";
import {
  type DatagramConn,
  dnsLookup,
  listenDatagram,
  type NetAddr,
  type TcpConn,
  tcpConnect,
  tcpListen,
  type TcpListener,
} from "./sockets_platform.ts";
import {
  type IpAddress,
  type IpAddressFamily,
  ipHostname,
  type IpSocketAddress,
  isUnspecified,
  isValidAddressFamily,
  mapPlatformError,
  MAX_UDP_DATAGRAM_SIZE,
  parseNetAddr,
  sameSocketAddress,
} from "./sockets_shared.ts";

/** `wasi:sockets/network@0.2`'s `error-code` ENUM: bare strings. */
export type SocketErrorCode02 =
  | "unknown"
  | "access-denied"
  | "not-supported"
  | "invalid-argument"
  | "out-of-memory"
  | "timeout"
  | "concurrency-conflict"
  | "not-in-progress"
  | "would-block"
  | "invalid-state"
  | "new-socket-limit"
  | "address-not-bindable"
  | "address-in-use"
  | "remote-unreachable"
  | "connection-refused"
  | "connection-reset"
  | "connection-aborted"
  | "datagram-too-large"
  | "name-unresolvable"
  | "temporary-resolver-failure"
  | "permanent-resolver-failure";

function err02(
  code: SocketErrorCode02,
  detail: string,
): ComponentException<SocketErrorCode02> {
  return new ComponentException(code, `wasi:sockets@0.2: ${detail}`);
}

/** The 0.3 variant kinds this backend produces, onto the 0.2 enum. */
const KIND_TO_02: Record<string, SocketErrorCode02> = {
  "access-denied": "access-denied",
  "not-supported": "not-supported",
  "invalid-argument": "invalid-argument",
  "out-of-memory": "out-of-memory",
  "timeout": "timeout",
  "invalid-state": "invalid-state",
  "address-not-bindable": "address-not-bindable",
  "address-in-use": "address-in-use",
  "remote-unreachable": "remote-unreachable",
  "connection-refused": "connection-refused",
  "connection-reset": "connection-reset",
  "connection-aborted": "connection-aborted",
  "datagram-too-large": "datagram-too-large",
  // 0.2 has no connection-broken (EPIPE): reset is the nearest truth.
  "connection-broken": "connection-reset",
};

/** Map a platform failure to the 0.2 enum (via the shared 0.3 mapper). */
function toCode02(e: unknown, what: string): SocketErrorCode02 {
  if (e instanceof ComponentException) {
    const payload = (e as ComponentException<unknown>).payload;
    if (typeof payload === "string") return payload as SocketErrorCode02; // already 0.2
    const kind = (payload as { kind?: string })?.kind;
    if (typeof kind === "string") return KIND_TO_02[kind] ?? "unknown";
    return "unknown";
  }
  return KIND_TO_02[mapPlatformError(e, what).payload.kind] ?? "unknown";
}

function raise02(e: unknown, what: string): never {
  const message = e instanceof Error ? e.message : String(e);
  throw err02(toCode02(e, what), `${what}: ${message}`);
}

/**
 * The io `error` resource minted by 0.2 socket STREAM failures, carrying
 * the error-code so `network-error-code(borrow<error>)` can downcast it
 * (the filesystem-error-code pattern; SinkOutputStream and
 * FedInputStream preserve IoError subclasses).
 */
export class SocketIoError extends IoError {
  constructor(readonly code: SocketErrorCode02, message: string) {
    super(message);
  }
}

/** `wasi:sockets/network@0.2`'s opaque capability resource. */
export class Network {}

/** `shutdown-type` enum values. */
export type ShutdownType = "receive" | "send" | "both";

/** `incoming-datagram` / `outgoing-datagram` records. */
export interface IncomingDatagram {
  data: Uint8Array;
  remoteAddress: IpSocketAddress;
}
export interface OutgoingDatagram {
  data: Uint8Array;
  remoteAddress?: IpSocketAddress;
}

const TCP_RECEIVE_CHUNK = 16384;

/** check-send's fixed permit (the WIT wants a positive count; sends are
 * handed to node immediately, so the permit never genuinely shrinks). */
const CHECK_SEND_PERMIT = 64n;

/** What `sockets02()` hands back for registration by `sockets()`. */
export interface Sockets02Fragment {
  imports: Record<string, unknown>;
}

/**
 * Build the `wasi:sockets@0.2` interfaces (module header). `onCall` is
 * the same fragment-scoped observer the 0.3 track takes.
 */
export function sockets02(onCall: (call: string) => void): Sockets02Fragment {
  // One ambient network per fragment: `instance-network` returns it and
  // the `network` parameters below are accepted without inspection (this
  // host models exactly one network namespace).
  const theNetwork = new Network();

  const validateRemote = (
    family: IpAddressFamily,
    remote: IpSocketAddress,
    what: string,
  ): void => {
    if (
      !isValidAddressFamily(family, remote) || isUnspecified(remote) ||
      remote.value.port === 0
    ) {
      throw err02(
        "invalid-argument",
        `${what}: the remote address must be a specific address and non-zero ` +
          `port in the socket's family (${family})`,
      );
    }
    if (remote.kind === "ipv6" && remote.value.scopeId !== 0) {
      throw err02("not-supported", `${what}: non-zero scope-id`);
    }
  };

  const validateLocal = (
    family: IpAddressFamily,
    local: IpSocketAddress,
    what: string,
  ): void => {
    if (!isValidAddressFamily(family, local)) {
      throw err02(
        "invalid-argument",
        `${what}: address family mismatch (an ${family} socket)`,
      );
    }
    if (local.kind === "ipv6" && local.value.scopeId !== 0) {
      throw err02("not-supported", `${what}: non-zero scope-id`);
    }
  };

  /** Mint the wasi:io stream pair over a connection (module header). */
  const connStreams = (conn: TcpConn): [FedInputStream, SinkOutputStream] => {
    const input = new FedInputStream((async function* (): AsyncGenerator<Uint8Array> {
      for (;;) {
        let chunk: Uint8Array | null;
        try {
          chunk = await conn.read(TCP_RECEIVE_CHUNK);
        } catch (e) {
          throw new SocketIoError(
            toCode02(e, "input-stream (socket read)"),
            e instanceof Error ? e.message : String(e),
          );
        }
        if (chunk === null) return; // peer FIN: clean stream close
        if (chunk.length > 0) yield chunk;
      }
    })());
    const output = new SinkOutputStream(async (chunk) => {
      try {
        let at = 0;
        while (at < chunk.length) at += await conn.write(chunk.subarray(at));
      } catch (e) {
        throw new SocketIoError(
          toCode02(e, "output-stream (socket write)"),
          e instanceof Error ? e.message : String(e),
        );
      }
    });
    return [input, output];
  };

  // --- tcp ---------------------------------------------------------------------

  type DialState = {
    done: boolean;
    conn?: TcpConn;
    error?: unknown;
    wait: Promise<void>;
  };

  type ListenState = {
    listener: TcpListener;
    settled: boolean;
    error?: unknown;
    wait: Promise<void>;
  };

  class TcpSocket02 {
    #family: IpAddressFamily;
    #state:
      | "unbound"
      | "bind-in-progress"
      | "bound"
      | "connect-in-progress"
      | "connected"
      | "listen-in-progress"
      | "listening"
      | "closed" = "unbound";
    #localRequest: IpSocketAddress | undefined;
    #dial: DialState | undefined;
    #listen: ListenState | undefined;
    #conn: TcpConn | undefined;
    #input: FedInputStream | undefined;
    #output: SinkOutputStream | undefined;
    /** All accepted writes so far; shutdown(send) FINs after them. */
    #lastWrite: Promise<void> = Promise.resolve();
    // The options cache — the sockets.ts honesty stances.
    #backlog: number | undefined;
    #keepAliveEnabled = false;
    #keepAliveIdleNs = 7_200_000_000_000n;

    constructor(family: IpAddressFamily) {
      this.#family = family;
    }

    /** An accepted connection, already `connected`. */
    static accepted(family: IpAddressFamily, conn: TcpConn): TcpSocket02 {
      const socket = new TcpSocket02(family);
      socket.#conn = conn;
      socket.#state = "connected";
      return socket;
    }

    /** `bind` records; the OS bind is deferred (module header). */
    startBind(_network: Network, localAddress: IpSocketAddress): void {
      onCall("tcp-socket.start-bind");
      if (this.#state !== "unbound") {
        throw err02(
          "invalid-state",
          `tcp-socket.start-bind: not bindable from '${this.#state}'`,
        );
      }
      validateLocal(this.#family, localAddress, "tcp-socket.start-bind");
      this.#localRequest = localAddress;
      this.#state = "bind-in-progress";
    }

    finishBind(): void {
      onCall("tcp-socket.finish-bind");
      if (this.#state !== "bind-in-progress") {
        throw err02("not-in-progress", "tcp-socket.finish-bind: no bind in progress");
      }
      this.#state = "bound"; // recorded; deferred to listen/connect (header)
    }

    startConnect(_network: Network, remoteAddress: IpSocketAddress): void {
      onCall("tcp-socket.start-connect");
      if (this.#state !== "unbound" && this.#state !== "bound") {
        throw err02(
          "invalid-state",
          `tcp-socket.start-connect: not connectable from '${this.#state}'`,
        );
      }
      validateRemote(this.#family, remoteAddress, "tcp-socket.start-connect");
      const connect = tcpConnect();
      if (connect === undefined) {
        throw err02("not-supported", "tcp-socket.start-connect: no TCP backend (no node:net)");
      }
      const local = this.#localRequest;
      const dial: DialState = { done: false, wait: Promise.resolve() };
      dial.wait = connect({
        transport: "tcp",
        hostname: ipHostname(remoteAddress),
        port: remoteAddress.value.port,
        ...(local === undefined ? {} : {
          localHostname: ipHostname(local),
          localPort: local.value.port,
        }),
      }).then(
        (conn) => {
          dial.conn = conn;
          dial.done = true;
          // Dropped mid-dial: nothing will ever take this conn.
          if (this.#state !== "connect-in-progress") conn.close();
        },
        (e) => {
          dial.error = e;
          dial.done = true;
        },
      );
      this.#dial = dial;
      this.#state = "connect-in-progress";
    }

    finishConnect(): [FedInputStream, SinkOutputStream] {
      onCall("tcp-socket.finish-connect");
      const dial = this.#dial;
      if (this.#state !== "connect-in-progress" || dial === undefined) {
        throw err02("not-in-progress", "tcp-socket.finish-connect: no connect in progress");
      }
      if (!dial.done) {
        throw err02("would-block", "tcp-socket.finish-connect: the dial has not settled");
      }
      if (dial.error !== undefined || dial.conn === undefined) {
        // "After a failed connection attempt ... the only valid action
        // left is to drop".
        this.#state = "closed";
        this.#dial = undefined;
        raise02(dial.error, "tcp-socket.finish-connect");
      }
      this.#conn = dial.conn;
      this.#dial = undefined;
      this.#state = "connected";
      this.#applyKeepAlive();
      const [input, output] = this.#mintStreams(this.#conn);
      return [input, output];
    }

    startListen(): void {
      onCall("tcp-socket.start-listen");
      if (this.#state !== "unbound" && this.#state !== "bound") {
        throw err02(
          "invalid-state",
          `tcp-socket.start-listen: not listenable from '${this.#state}'`,
        );
      }
      const listen = tcpListen();
      if (listen === undefined) {
        throw err02("not-supported", "tcp-socket.start-listen: no TCP backend (no node:net)");
      }
      const local = this.#localRequest ?? wildcard(this.#family);
      const listener = listen({
        transport: "tcp",
        hostname: ipHostname(local),
        port: local.value.port,
        ...(this.#backlog === undefined ? {} : { backlog: this.#backlog }),
      });
      const state: ListenState = { listener, settled: false, wait: Promise.resolve() };
      state.wait = listener.settled().then(
        () => {
          state.settled = true;
        },
        (e) => {
          state.error = e;
          state.settled = true;
        },
      );
      this.#listen = state;
      this.#state = "listen-in-progress";
    }

    finishListen(): void {
      onCall("tcp-socket.finish-listen");
      const state = this.#listen;
      if (this.#state !== "listen-in-progress" || state === undefined) {
        throw err02("not-in-progress", "tcp-socket.finish-listen: no listen in progress");
      }
      if (!state.settled) {
        throw err02("would-block", "tcp-socket.finish-listen: the OS bind has not settled");
      }
      if (state.error !== undefined) {
        state.listener.close();
        this.#listen = undefined;
        this.#state = "closed";
        raise02(state.error, "tcp-socket.finish-listen");
      }
      this.#state = "listening";
    }

    accept(): [TcpSocket02, FedInputStream, SinkOutputStream] {
      onCall("tcp-socket.accept");
      const state = this.#listen;
      if (this.#state !== "listening" || state === undefined) {
        throw err02("invalid-state", "tcp-socket.accept: the socket is not listening");
      }
      let conn: TcpConn | undefined;
      try {
        conn = state.listener.tryAccept === undefined
          ? undefined
          : state.listener.tryAccept();
      } catch (e) {
        raise02(e, "tcp-socket.accept");
      }
      if (conn === undefined) {
        throw err02("would-block", "tcp-socket.accept: no pending connections");
      }
      const socket = TcpSocket02.accepted(this.#family, conn);
      const [input, output] = socket.#mintStreams(conn);
      return [socket, input, output];
    }

    localAddress(): IpSocketAddress {
      onCall("tcp-socket.local-address");
      if (this.#state === "listening" && this.#listen !== undefined) {
        const addr = this.#listen.listener.addr;
        if (addr !== null) return parseNetAddr(addr);
      }
      if (this.#conn !== undefined) return parseNetAddr(this.#conn.localAddr);
      // 0.2 pins bound-but-not-yet-realized: the deferred bind means the
      // recorded address (port possibly still 0) is the honest answer.
      if (this.#state === "bound" && this.#localRequest !== undefined) {
        return this.#localRequest;
      }
      throw err02("invalid-state", "tcp-socket.local-address: the socket is not bound");
    }

    remoteAddress(): IpSocketAddress {
      onCall("tcp-socket.remote-address");
      if (this.#state !== "connected" || this.#conn === undefined) {
        throw err02("invalid-state", "tcp-socket.remote-address: not connected");
      }
      return parseNetAddr(this.#conn.remoteAddr);
    }

    isListening(): boolean {
      onCall("tcp-socket.is-listening");
      return this.#state === "listening";
    }

    addressFamily(): IpAddressFamily {
      onCall("tcp-socket.address-family");
      return this.#family;
    }

    setListenBacklogSize(value: bigint): void {
      onCall("tcp-socket.set-listen-backlog-size");
      if (value === 0n) {
        throw err02("invalid-argument", "tcp-socket.set-listen-backlog-size: zero");
      }
      if (this.#state === "listening" || this.#state === "listen-in-progress") {
        throw err02(
          "not-supported",
          "tcp-socket.set-listen-backlog-size: node cannot re-listen",
        );
      }
      if (this.#state !== "unbound" && this.#state !== "bound") {
        throw err02(
          "invalid-state",
          `tcp-socket.set-listen-backlog-size: not settable in '${this.#state}'`,
        );
      }
      this.#backlog = Number(value > 0x7fffffffn ? 0x7fffffffn : value);
    }

    keepAliveEnabled(): boolean {
      onCall("tcp-socket.keep-alive-enabled");
      return this.#keepAliveEnabled;
    }

    setKeepAliveEnabled(value: boolean): void {
      onCall("tcp-socket.set-keep-alive-enabled");
      this.#keepAliveEnabled = value;
      this.#applyKeepAlive();
    }

    keepAliveIdleTime(): bigint {
      onCall("tcp-socket.keep-alive-idle-time");
      return this.#keepAliveIdleNs;
    }

    setKeepAliveIdleTime(value: bigint): void {
      onCall("tcp-socket.set-keep-alive-idle-time");
      if (value < 1n) {
        throw err02("invalid-argument", "tcp-socket.set-keep-alive-idle-time: zero");
      }
      this.#keepAliveIdleNs = value;
      this.#applyKeepAlive();
    }

    // No node:net API (the sockets.ts honesty stance):
    keepAliveInterval(): never {
      onCall("tcp-socket.keep-alive-interval");
      throw this.#noOption("keep-alive-interval (TCP_KEEPINTVL)");
    }
    setKeepAliveInterval(_v: bigint): never {
      onCall("tcp-socket.set-keep-alive-interval");
      throw this.#noOption("keep-alive-interval (TCP_KEEPINTVL)");
    }
    keepAliveCount(): never {
      onCall("tcp-socket.keep-alive-count");
      throw this.#noOption("keep-alive-count (TCP_KEEPCNT)");
    }
    setKeepAliveCount(_v: number): never {
      onCall("tcp-socket.set-keep-alive-count");
      throw this.#noOption("keep-alive-count (TCP_KEEPCNT)");
    }
    hopLimit(): never {
      onCall("tcp-socket.hop-limit");
      throw this.#noOption("hop-limit (IP_TTL)");
    }
    setHopLimit(_v: number): never {
      onCall("tcp-socket.set-hop-limit");
      throw this.#noOption("hop-limit (IP_TTL)");
    }
    receiveBufferSize(): never {
      onCall("tcp-socket.receive-buffer-size");
      throw this.#noOption("receive-buffer-size (SO_RCVBUF)");
    }
    setReceiveBufferSize(_v: bigint): never {
      onCall("tcp-socket.set-receive-buffer-size");
      throw this.#noOption("receive-buffer-size (SO_RCVBUF)");
    }
    sendBufferSize(): never {
      onCall("tcp-socket.send-buffer-size");
      throw this.#noOption("send-buffer-size (SO_SNDBUF)");
    }
    setSendBufferSize(_v: bigint): never {
      onCall("tcp-socket.set-send-buffer-size");
      throw this.#noOption("send-buffer-size (SO_SNDBUF)");
    }

    /** Readiness for the CURRENT pending operation (module header). */
    subscribe(): Pollable {
      onCall("tcp-socket.subscribe");
      const dial = this.#dial;
      if (this.#state === "connect-in-progress" && dial !== undefined) {
        return new Pollable(() => dial.done, () => dial.wait);
      }
      const listen = this.#listen;
      if (this.#state === "listen-in-progress" && listen !== undefined) {
        return new Pollable(() => listen.settled, () => listen.wait);
      }
      if (this.#state === "listening" && listen !== undefined) {
        const l = listen.listener;
        return new Pollable(
          () => l.acceptReady === undefined ? true : l.acceptReady(),
          () => l.waitAccept === undefined ? Promise.resolve() : l.waitAccept(),
        );
      }
      return new Pollable(); // no pending operation: ready
    }

    shutdown(shutdownType: ShutdownType): void {
      onCall("tcp-socket.shutdown");
      if (this.#state !== "connected" || this.#conn === undefined) {
        throw err02("invalid-state", "tcp-socket.shutdown: the socket is not connected");
      }
      const conn = this.#conn;
      if (shutdownType === "receive" || shutdownType === "both") {
        this.#input?.[Symbol.dispose]();
      }
      if (shutdownType === "send" || shutdownType === "both") {
        // FIN after everything the output stream already accepted (the
        // kernel analogue: shutdown(SHUT_WR) follows queued data out).
        void this.#lastWrite.then(() => conn.closeWrite()).catch(() => {
          // The FIN lost a race with a reset; the streams report it.
        });
      }
    }

    #mintStreams(conn: TcpConn): [FedInputStream, SinkOutputStream] {
      const [input, rawOutput] = connStreams(conn);
      // Interpose on the sink serialization so shutdown(send) can chain
      // the FIN after the last accepted write.
      const output = new SinkOutputStream((chunk) => {
        const p = (async (): Promise<void> => {
          try {
            let at = 0;
            while (at < chunk.length) at += await conn.write(chunk.subarray(at));
          } catch (e) {
            throw new SocketIoError(
              toCode02(e, "output-stream (socket write)"),
              e instanceof Error ? e.message : String(e),
            );
          }
        })();
        this.#lastWrite = p.catch(() => {});
        return p;
      });
      rawOutput[Symbol.dispose]();
      this.#input = input;
      this.#output = output;
      return [input, output];
    }

    #noOption(what: string): ComponentException<SocketErrorCode02> {
      return err02("not-supported", `tcp-socket: node:net exposes no ${what}`);
    }

    #applyKeepAlive(): void {
      const conn = this.#conn;
      if (this.#state !== "connected" || conn === undefined) return;
      if (conn.setKeepAlive === undefined) {
        throw err02("not-supported", "tcp-socket: no keep-alive control on this backend");
      }
      try {
        conn.setKeepAlive(this.#keepAliveEnabled, Number(this.#keepAliveIdleNs / 1_000_000n));
      } catch (e) {
        raise02(e, "tcp-socket (applying keep-alive)");
      }
    }

    [Symbol.dispose](): void {
      // The wasi:io streams hold their own references to the conn's byte
      // channels in wasi-libc's hands; 0.2 sockets close with the handle
      // (the streams then observe reset/closed) — matching wasmtime,
      // where dropping the socket closes the fd.
      this.#state = "closed";
      this.#input?.[Symbol.dispose]();
      this.#output?.[Symbol.dispose]();
      try {
        this.#conn?.close();
      } catch {
        // Already closed.
      }
      this.#conn = undefined;
      const listener = this.#listen?.listener;
      this.#listen = undefined;
      if (listener !== undefined) {
        try {
          listener.close();
        } catch {
          // Already closed.
        }
      }
    }
  }

  const createTcpSocket = (addressFamily: IpAddressFamily): TcpSocket02 => {
    onCall("tcp-create-socket.create-tcp-socket");
    if (tcpConnect() === undefined) {
      throw err02("not-supported", "create-tcp-socket: no TCP backend (no node:net)");
    }
    return new TcpSocket02(addressFamily);
  };

  // --- udp ---------------------------------------------------------------------

  /** Shared state between a udp socket and its current stream pair. */
  type UdpStreams = {
    generation: number;
    remote: IpSocketAddress | undefined;
  };

  class UdpSocket02 {
    #family: IpAddressFamily;
    #state: "unbound" | "bind-in-progress" | "bound" | "closed" = "unbound";
    #conn: DatagramConn | undefined;
    #streams: UdpStreams | undefined;
    #generation = 0;
    #hopLimit: number | undefined;
    #recvBuffer: bigint | undefined;
    #sendBuffer: bigint | undefined;

    constructor(family: IpAddressFamily) {
      this.#family = family;
    }

    /** udp bind is synchronous here (module header): start performs it. */
    startBind(_network: Network, localAddress: IpSocketAddress): void {
      onCall("udp-socket.start-bind");
      if (this.#state !== "unbound") {
        throw err02(
          "invalid-state",
          `udp-socket.start-bind: not bindable from '${this.#state}'`,
        );
      }
      validateLocal(this.#family, localAddress, "udp-socket.start-bind");
      const listen = listenDatagram();
      if (listen === undefined) {
        throw err02("not-supported", "udp-socket.start-bind: no datagram backend (no node:dgram)");
      }
      try {
        this.#conn = listen({
          transport: "udp",
          hostname: ipHostname(localAddress),
          port: localAddress.value.port,
        });
      } catch (e) {
        raise02(e, "udp-socket.start-bind");
      }
      this.#applyCachedOptions();
      this.#state = "bind-in-progress";
    }

    finishBind(): void {
      onCall("udp-socket.finish-bind");
      if (this.#state !== "bind-in-progress") {
        throw err02("not-in-progress", "udp-socket.finish-bind: no bind in progress");
      }
      this.#state = "bound";
    }

    /**
     * `stream(remote?)` — replaces any previous stream pair (they turn
     * `invalid-state`); `some` = connected mode (OS connect when the
     * backend has it, filter backstop either way — module header).
     * SUSPENDING via the registered mark relay is NOT needed: node's
     * dgram connect settles via callback, so this parks one tick through
     * the runtime's thenable acceptance on... no — 0.2 `stream` is a
     * sync WIT func, so the connect is fired and the streams are handed
     * out immediately; a connect failure surfaces on the first
     * send/receive (recorded divergence — POSIX UDP connect failures are
     * mostly lazy anyway).
     */
    stream(
      remoteAddress: IpSocketAddress | undefined,
    ): [IncomingDatagramStream02, OutgoingDatagramStream02] {
      onCall("udp-socket.stream");
      if (this.#state !== "bound" || this.#conn === undefined) {
        throw err02("invalid-state", "udp-socket.stream: the socket is not bound");
      }
      const conn = this.#conn;
      if (remoteAddress !== undefined) {
        validateRemote(this.#family, remoteAddress, "udp-socket.stream");
      }
      const wasConnected = this.#streams?.remote !== undefined;
      this.#generation++;
      const streams: UdpStreams = { generation: this.#generation, remote: remoteAddress };
      this.#streams = streams;
      // OS-level (dis)connect, fire-and-forget: failures surface on the
      // first datagram op (doc comment above).
      if (remoteAddress !== undefined && conn.connect !== undefined) {
        void conn.connect({
          transport: "udp",
          hostname: ipHostname(remoteAddress),
          port: remoteAddress.value.port,
        }).catch(() => {
          // The filter backstop still enforces connected-mode semantics.
        });
      } else if (remoteAddress === undefined && wasConnected) {
        try {
          conn.disconnect?.();
        } catch {
          // Not connected at the OS level (compat backends).
        }
      }
      const live = (gen: number): boolean =>
        this.#streams?.generation === gen && this.#state === "bound";
      return [
        new IncomingDatagramStream02(conn, streams, live),
        new OutgoingDatagramStream02(conn, streams, live, this.#family),
      ];
    }

    localAddress(): IpSocketAddress {
      onCall("udp-socket.local-address");
      if (this.#conn === undefined) {
        throw err02("invalid-state", "udp-socket.local-address: the socket is not bound");
      }
      return parseNetAddr(this.#conn.addr);
    }

    remoteAddress(): IpSocketAddress {
      onCall("udp-socket.remote-address");
      const remote = this.#streams?.remote;
      if (remote === undefined) {
        throw err02("invalid-state", "udp-socket.remote-address: the socket is not connected");
      }
      return remote;
    }

    addressFamily(): IpAddressFamily {
      onCall("udp-socket.address-family");
      return this.#family;
    }

    unicastHopLimit(): number {
      onCall("udp-socket.unicast-hop-limit");
      return this.#hopLimit ?? 64; // the documented default (sockets.ts stance)
    }

    setUnicastHopLimit(value: number): void {
      onCall("udp-socket.set-unicast-hop-limit");
      if (value < 1) {
        throw err02("invalid-argument", "udp-socket.set-unicast-hop-limit: below 1");
      }
      this.#hopLimit = value;
      this.#applyCachedOptions();
    }

    receiveBufferSize(): bigint {
      onCall("udp-socket.receive-buffer-size");
      return this.#bufferSize("receive", this.#recvBuffer, this.#conn?.getRecvBufferSize);
    }

    setReceiveBufferSize(value: bigint): void {
      onCall("udp-socket.set-receive-buffer-size");
      if (value === 0n) {
        throw err02("invalid-argument", "udp-socket.set-receive-buffer-size: zero");
      }
      this.#recvBuffer = value;
      this.#applyCachedOptions();
    }

    sendBufferSize(): bigint {
      onCall("udp-socket.send-buffer-size");
      return this.#bufferSize("send", this.#sendBuffer, this.#conn?.getSendBufferSize);
    }

    setSendBufferSize(value: bigint): void {
      onCall("udp-socket.set-send-buffer-size");
      if (value === 0n) {
        throw err02("invalid-argument", "udp-socket.set-send-buffer-size: zero");
      }
      this.#sendBuffer = value;
      this.#applyCachedOptions();
    }

    subscribe(): Pollable {
      onCall("udp-socket.subscribe");
      return new Pollable(); // binds are synchronous: never mid-operation
    }

    #bufferSize(
      which: "receive" | "send",
      cached: bigint | undefined,
      live: (() => number) | undefined,
    ): bigint {
      if (this.#conn !== undefined && live !== undefined) {
        try {
          return BigInt(live.call(this.#conn));
        } catch (e) {
          raise02(e, `udp-socket.${which}-buffer-size`);
        }
      }
      if (cached !== undefined) return cached;
      throw err02(
        "not-supported",
        `udp-socket.${which}-buffer-size: unknowable before bind on this host`,
      );
    }

    #applyCachedOptions(): void {
      const conn = this.#conn;
      if (conn === undefined) return;
      try {
        if (this.#hopLimit !== undefined) conn.setTtl?.(this.#hopLimit);
        if (this.#recvBuffer !== undefined) conn.setRecvBufferSize?.(Number(this.#recvBuffer));
        if (this.#sendBuffer !== undefined) conn.setSendBufferSize?.(Number(this.#sendBuffer));
      } catch (e) {
        raise02(e, "udp-socket (applying cached options)");
      }
    }

    [Symbol.dispose](): void {
      this.#state = "closed";
      this.#streams = undefined;
      const conn = this.#conn;
      this.#conn = undefined;
      if (conn !== undefined) {
        try {
          conn.close();
        } catch {
          // Already closed.
        }
      }
    }
  }

  class IncomingDatagramStream02 {
    #conn: DatagramConn;
    #streams: UdpStreams;
    #live: (gen: number) => boolean;

    constructor(conn: DatagramConn, streams: UdpStreams, live: (gen: number) => boolean) {
      this.#conn = conn;
      this.#streams = streams;
      this.#live = live;
    }

    /** Non-blocking batch; empty list = nothing pending (never would-block). */
    receive(maxResults: bigint): IncomingDatagram[] {
      onCall("incoming-datagram-stream.receive");
      if (!this.#live(this.#streams.generation)) {
        throw err02("invalid-state", "incoming-datagram-stream.receive: stale stream");
      }
      const out: IncomingDatagram[] = [];
      const max = Number(maxResults);
      while (out.length < max) {
        let item: [Uint8Array, NetAddr] | undefined;
        try {
          item = this.#conn.tryReceive === undefined ? undefined : this.#conn.tryReceive();
        } catch (e) {
          raise02(e, "incoming-datagram-stream.receive");
        }
        if (item === undefined) break;
        const source = parseNetAddr(item[1]);
        // The connected-mode filter backstop (module header).
        const remote = this.#streams.remote;
        if (remote !== undefined && !sameSocketAddress(source, remote)) continue;
        out.push({ data: item[0], remoteAddress: source });
      }
      return out;
    }

    subscribe(): Pollable {
      onCall("incoming-datagram-stream.subscribe");
      const conn = this.#conn;
      return new Pollable(
        () => conn.receiveReady === undefined ? true : conn.receiveReady(),
        () => conn.waitReceive === undefined ? Promise.resolve() : conn.waitReceive(),
      );
    }

    [Symbol.dispose](): void {
      // The socket owns the OS resources; streams are views.
    }
  }

  class OutgoingDatagramStream02 {
    #conn: DatagramConn;
    #streams: UdpStreams;
    #live: (gen: number) => boolean;
    #family: IpAddressFamily;
    /** An async send failure, surfaced on the NEXT call (module header). */
    #failure: SocketErrorCode02 | undefined;

    constructor(
      conn: DatagramConn,
      streams: UdpStreams,
      live: (gen: number) => boolean,
      family: IpAddressFamily,
    ) {
      this.#conn = conn;
      this.#streams = streams;
      this.#live = live;
      this.#family = family;
    }

    checkSend(): bigint {
      onCall("outgoing-datagram-stream.check-send");
      this.#checkLive("check-send");
      return CHECK_SEND_PERMIT;
    }

    /** Hands each datagram to node and counts it sent — the WIT's "sent
     * (or queued for sending)" latitude (module header). */
    send(datagrams: OutgoingDatagram[]): bigint {
      onCall("outgoing-datagram-stream.send");
      this.#checkLive("send");
      if (BigInt(datagrams.length) > CHECK_SEND_PERMIT) {
        // "Implementations must trap if ... more items than check-send
        // permitted": the unbranded throw IS the trap.
        throw new Error(
          `outgoing-datagram-stream.send: ${datagrams.length} datagrams exceed the check-send permit`,
        );
      }
      const connected = this.#streams.remote;
      for (const datagram of datagrams) {
        if (datagram.data.length > MAX_UDP_DATAGRAM_SIZE) {
          throw err02(
            "datagram-too-large",
            `outgoing-datagram-stream.send: ${datagram.data.length} bytes`,
          );
        }
        const remote = datagram.remoteAddress;
        if (connected !== undefined) {
          if (remote !== undefined && !sameSocketAddress(remote, connected)) {
            throw err02(
              "invalid-argument",
              "outgoing-datagram-stream.send: a remote-address that does not match the connected remote",
            );
          }
        } else {
          if (remote === undefined) {
            throw err02(
              "invalid-argument",
              "outgoing-datagram-stream.send: no remote-address on an unconnected stream",
            );
          }
          validateRemote(this.#family, remote, "outgoing-datagram-stream.send");
        }
      }
      for (const datagram of datagrams) {
        const dest = connected !== undefined ? undefined : {
          transport: "udp",
          hostname: ipHostname(datagram.remoteAddress!),
          port: datagram.remoteAddress!.value.port,
        };
        void this.#conn.send(datagram.data, dest).catch((e) => {
          this.#failure ??= toCode02(e, "outgoing-datagram-stream.send");
        });
      }
      return BigInt(datagrams.length);
    }

    subscribe(): Pollable {
      onCall("outgoing-datagram-stream.subscribe");
      return new Pollable(); // the permit is always available
    }

    #checkLive(what: string): void {
      if (!this.#live(this.#streams.generation)) {
        throw err02("invalid-state", `outgoing-datagram-stream.${what}: stale stream`);
      }
      if (this.#failure !== undefined) {
        const code = this.#failure;
        this.#failure = undefined;
        throw err02(code, `outgoing-datagram-stream.${what}: an earlier send failed`);
      }
    }

    [Symbol.dispose](): void {
      // The socket owns the OS resources; streams are views.
    }
  }

  const createUdpSocket = (addressFamily: IpAddressFamily): UdpSocket02 => {
    onCall("udp-create-socket.create-udp-socket");
    if (listenDatagram() === undefined) {
      throw err02("not-supported", "create-udp-socket: no datagram backend (no node:dgram)");
    }
    return new UdpSocket02(addressFamily);
  };

  // --- ip-name-lookup ------------------------------------------------------------

  class ResolveAddressStream02 {
    #settled = false;
    #answers: IpAddress[] = [];
    #error: SocketErrorCode02 | undefined;
    #wait: Promise<void>;

    constructor(query: string | { literal: IpAddress[] }) {
      if (typeof query !== "string") {
        // IP literals: already answered, no resolver involved.
        this.#settled = true;
        this.#answers = query.literal;
        this.#wait = Promise.resolve();
        return;
      }
      const name = query;
      const lookup = dnsLookup();
      if (lookup === undefined) {
        this.#settled = true;
        this.#error = "permanent-resolver-failure";
        this.#wait = Promise.resolve();
        return;
      }
      this.#wait = lookup(name).then(
        (answers) => {
          try {
            this.#answers = answers.map((a) => {
              const parsed = parseNetAddr({ hostname: a.address, port: 0 });
              return parsed.kind === "ipv4"
                ? { kind: "ipv4", value: parsed.value.address } as IpAddress
                : { kind: "ipv6", value: parsed.value.address } as IpAddress;
            });
          } catch {
            this.#error = "unknown";
          }
          this.#settled = true;
        },
        (e) => {
          const code = (e as { code?: unknown } | null)?.code;
          this.#error = code === "ENOTFOUND" || code === "EAI_NONAME" || code === "ENODATA"
            ? "name-unresolvable"
            : code === "EAI_AGAIN" || code === "ETIMEOUT" || code === "ETIMEDOUT"
            ? "temporary-resolver-failure"
            : code === "EACCES" || code === "EPERM"
            ? "access-denied"
            : toCode02(e, "resolve-addresses") === "access-denied"
            ? "access-denied"
            : "unknown";
          this.#settled = true;
        },
      );
    }

    /** An already-answered stream (IP literals). */
    static literal(answers: IpAddress[]): ResolveAddressStream02 {
      return new ResolveAddressStream02({ literal: answers });
    }

    resolveNextAddress(): IpAddress | undefined {
      onCall("resolve-address-stream.resolve-next-address");
      if (!this.#settled) {
        throw err02("would-block", "resolve-next-address: the resolver has not answered");
      }
      if (this.#error !== undefined) {
        throw err02(this.#error, "resolve-next-address: resolution failed");
      }
      return this.#answers.shift(); // undefined = none = end of stream
    }

    subscribe(): Pollable {
      onCall("resolve-address-stream.subscribe");
      return new Pollable(() => this.#settled, () => this.#wait);
    }

    [Symbol.dispose](): void {}
  }

  const resolveAddresses = (_network: Network, name: string): ResolveAddressStream02 => {
    onCall("ip-name-lookup.resolve-addresses");
    if (name.length === 0) {
      throw err02("invalid-argument", "resolve-addresses: empty name");
    }
    // IP literals answer locally (wasmtime parity; no resolver involved).
    try {
      const bare = name.startsWith("[") ? name.slice(1, -1) : name;
      const parsed = parseNetAddr({ hostname: bare, port: 0 });
      return ResolveAddressStream02.literal([
        parsed.kind === "ipv4"
          ? { kind: "ipv4", value: parsed.value.address }
          : { kind: "ipv6", value: parsed.value.address },
      ]);
    } catch {
      // Not a literal: a real name for the resolver.
    }
    return new ResolveAddressStream02(name);
  };

  return {
    imports: {
      "wasi:sockets/network@0.2": {
        Network,
        // `network-error-code(err: borrow<error>) -> option<error-code>`:
        // downcast succeeds exactly for the io errors OUR streams minted.
        networkErrorCode: (err: unknown): SocketErrorCode02 | undefined =>
          err instanceof SocketIoError ? err.code : undefined,
      },
      "wasi:sockets/instance-network@0.2": {
        instanceNetwork: (): Network => theNetwork,
      },
      "wasi:sockets/tcp@0.2": { TcpSocket: TcpSocket02 },
      "wasi:sockets/tcp-create-socket@0.2": { createTcpSocket },
      "wasi:sockets/udp@0.2": {
        UdpSocket: UdpSocket02,
        IncomingDatagramStream: IncomingDatagramStream02,
        OutgoingDatagramStream: OutgoingDatagramStream02,
      },
      "wasi:sockets/udp-create-socket@0.2": { createUdpSocket },
      "wasi:sockets/ip-name-lookup@0.2": {
        resolveAddresses,
        ResolveAddressStream: ResolveAddressStream02,
      },
    },
  };
}

/** The family's wildcard address, port 0 (tcp listen's implicit bind). */
function wildcard(family: IpAddressFamily): IpSocketAddress {
  return family === "ipv4"
    ? { kind: "ipv4", value: { port: 0, address: [0, 0, 0, 0] } }
    : {
      kind: "ipv6",
      value: { port: 0, flowInfo: 0, address: [0, 0, 0, 0, 0, 0, 0, 0], scopeId: 0 },
    };
}
