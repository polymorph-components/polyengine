// INTERNAL: the `@0.3` track of `wasi:sockets` — `types@0.3` (UDP + TCP,
// client + listener) and `ip-name-lookup@0.3`. Registered by the public
// `sockets()` (sockets.ts, where the module-level documentation lives)
// alongside the poll-shaped `@0.2` track (sockets_02.ts). Vocabulary
// (codec, validation, error mapping, WIT types): sockets_shared.ts.

import { ComponentException, isStream, suspending } from "@polyengine/protocol";
import {
  type DatagramConn,
  dnsLookup,
  listenDatagram,
  type TcpConn,
  tcpConnect,
  tcpListen,
  type TcpListener,
} from "./sockets_platform.ts";
import {
  componentError,
  type IpAddress,
  type IpAddressFamily,
  ipHostname,
  type IpSocketAddress,
  isDenoError,
  isUnspecified,
  isValidAddressFamily,
  mapPlatformError,
  MAX_UDP_DATAGRAM_SIZE,
  type NameLookupErrorCode,
  parseNetAddr,
  RESULT_INVALID_STATE,
  RESULT_OK,
  resultErrOf,
  sameSocketAddress,
  type SocketErrorCode,
  type SocketResult,
  type TcpAcceptStream,
  type TcpByteStream,
  type TcpSendSource,
  type TcpSocketClass,
  type UdpSocketClass,
  wildcardAddress,
} from "./sockets_shared.ts";

/**
 * Build the `@0.3` track: `wasi:sockets/types@0.3` (UDP + TCP resource
 * classes, per-fragment so the `onCall` observer is scoped) and
 * `wasi:sockets/ip-name-lookup@0.3`.
 */
export function sockets03(onCall: (call: string) => void): {
  imports: Record<string, unknown>;
  UdpSocket: UdpSocketClass;
  TcpSocket: TcpSocketClass;
  resolveAddresses: (name: string) => Promise<IpAddress[]>;
}{

  class UdpSocket {
    #family: IpAddressFamily;
    #conn: DatagramConn | undefined;
    /** Connected-mode remote (`connect`/`disconnect`); OS-level (kernel
     * filters and default destination), not adapter emulation. */
    #remote: IpSocketAddress | undefined;
    /** Cached option values, applied at (implicit) bind. */
    #hopLimit: number | undefined;
    #recvBuffer: bigint | undefined;
    #sendBuffer: bigint | undefined;

    private constructor(family: IpAddressFamily) {
      this.#family = family;
    }

    static create(addressFamily: IpAddressFamily): UdpSocket {
      onCall("udp-socket.create");
      if (listenDatagram() === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket.create: this host provides no datagram sockets (no node:dgram)",
        );
      }
      return new UdpSocket(addressFamily);
    }

    bind(localAddress: IpSocketAddress): void {
      onCall("udp-socket.bind");
      if (this.#conn !== undefined) {
        throw componentError({ kind: "invalid-state" }, "udp-socket.bind: already bound");
      }
      if (!isValidAddressFamily(this.#family, localAddress)) {
        throw componentError(
          { kind: "invalid-argument" },
          `udp-socket.bind: address family mismatch (an ${this.#family} socket)`,
        );
      }
      if (localAddress.kind === "ipv6" && localAddress.value.scopeId !== 0) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket.bind: non-zero scope-id (not expressible through Deno.listenDatagram)",
        );
      }
      try {
        this.#conn = this.#listen({
          transport: "udp",
          hostname: ipHostname(localAddress),
          port: localAddress.value.port,
        });
      } catch (e) {
        throw mapPlatformError(e, "udp-socket.bind");
      }
      this.#applyCachedOptions();
    }

    /**
     * WIT (0.3.1): `connect: func(remote-address) -> result<_, error-code>`
     * — OS-level connected mode: the kernel filters inbound datagrams to
     * the remote and `send` needs no explicit address. An unbound socket
     * implicitly binds to the family wildcard first (wasmtime parity).
     *
     * SUSPENDING (embedder-api.md §"The WASI parking kernel"): node's `dgram.connect` settles via callback one
     * tick later, so this sync WIT func parks the calling frame for that
     * tick — the same shape as tcp `listen`.
     */
    @suspending
    async connect(remoteAddress: IpSocketAddress): Promise<void> {
      onCall("udp-socket.connect");
      if (this.#remote !== undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "udp-socket.connect: already connected (disconnect first)",
        );
      }
      if (
        !isValidAddressFamily(this.#family, remoteAddress) ||
        isUnspecified(remoteAddress) ||
        remoteAddress.value.port === 0
      ) {
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.connect: the remote address must be a specific address " +
            `and non-zero port in the socket's family (${this.#family})`,
        );
      }
      if (remoteAddress.kind === "ipv6" && remoteAddress.value.scopeId !== 0) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket.connect: non-zero scope-id (not expressible through node addresses)",
        );
      }
      if (this.#conn === undefined) {
        try {
          this.#conn = this.#listen({
            transport: "udp",
            hostname: this.#family === "ipv4" ? "0.0.0.0" : "::",
            port: 0,
          });
        } catch (e) {
          throw mapPlatformError(e, "udp-socket.connect (implicit bind)");
        }
        this.#applyCachedOptions();
      }
      try {
        await this.#conn.connect({
          transport: "udp",
          hostname: ipHostname(remoteAddress),
          port: remoteAddress.value.port,
        });
      } catch (e) {
        throw mapPlatformError(e, "udp-socket.connect");
      }
      this.#remote = remoteAddress;
    }

    disconnect(): void {
      onCall("udp-socket.disconnect");
      if (this.#remote === undefined || this.#conn === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "udp-socket.disconnect: the socket is not connected",
        );
      }
      try {
        this.#conn.disconnect();
      } catch (e) {
        throw mapPlatformError(e, "udp-socket.disconnect");
      }
      this.#remote = undefined;
    }

    async send(data: Uint8Array, remoteAddress: IpSocketAddress | undefined): Promise<void> {
      onCall("udp-socket.send");
      if (data.length > MAX_UDP_DATAGRAM_SIZE) {
        throw componentError(
          { kind: "datagram-too-large" },
          `udp-socket.send: ${data.length} bytes exceeds the ${MAX_UDP_DATAGRAM_SIZE}-byte ceiling`,
        );
      }
      // Connected mode (0.3.1): an omitted remote sends to the connected
      // address (the kernel's default destination); a PRESENT remote on a
      // connected socket is invalid-argument (wasmtime parity — node's
      // dgram would raise ERR_SOCKET_DGRAM_IS_CONNECTED anyway). On an
      // unconnected socket an omitted remote has no destination (POSIX
      // EDESTADDRREQ).
      if (remoteAddress === undefined) {
        if (this.#remote === undefined) {
          throw componentError(
            { kind: "invalid-argument" },
            "udp-socket.send: no remote-address, and the socket is not connected",
          );
        }
        if (this.#conn === undefined) {
          throw componentError(
            { kind: "invalid-state" },
            "udp-socket.send: connected but unbound (unreachable)",
          );
        }
        try {
          const sent = await this.#conn.send(data);
          if (sent !== data.length) {
            throw componentError(
              { kind: "other", value: `partial send: ${sent} of ${data.length} bytes` },
              `udp-socket.send: partial send: ${sent} of ${data.length} bytes`,
            );
          }
        } catch (e) {
          throw mapPlatformError(e, "udp-socket.send");
        }
        return;
      }
      if (this.#remote !== undefined) {
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.send: an explicit remote-address on a connected socket",
        );
      }
      if (this.#conn === undefined) {
        // "If the socket has not been explicitly bound, it will be implicitly
        // bound to a random free port" — the wildcard bind wasmtime performs.
        try {
          this.#conn = this.#listen({
            transport: "udp",
            hostname: this.#family === "ipv4" ? "0.0.0.0" : "::",
            port: 0,
          });
        } catch (e) {
          throw mapPlatformError(e, "udp-socket.send (implicit bind)");
        }
        this.#applyCachedOptions();
      }
      if (
        !isValidAddressFamily(this.#family, remoteAddress) ||
        isUnspecified(remoteAddress) ||
        remoteAddress.value.port === 0
      ) {
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.send: the remote address must be a specific address and " +
            `non-zero port in the socket's family (${this.#family})`,
        );
      }
      if (remoteAddress.kind === "ipv6" && remoteAddress.value.scopeId !== 0) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket.send: non-zero scope-id (not expressible through Deno addresses)",
        );
      }
      let sent: number;
      try {
        sent = await this.#conn.send(data, {
          transport: "udp",
          hostname: ipHostname(remoteAddress),
          port: remoteAddress.value.port,
        });
      } catch (e) {
        throw mapPlatformError(e, "udp-socket.send");
      }
      if (sent !== data.length) {
        throw componentError(
          { kind: "other", value: `partial send: ${sent} of ${data.length} bytes` },
          `udp-socket.send: partial send: ${sent} of ${data.length} bytes`,
        );
      }
    }

    async receive(): Promise<[Uint8Array, IpSocketAddress]> {
      onCall("udp-socket.receive");
      if (this.#conn === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "udp-socket.receive: the socket is not bound",
        );
      }
      try {
        for (;;) {
          // Each datagram arrives as its own exactly-sized buffer; nothing
          // the OS delivers is ever truncated (whole-datagram semantics).
          const [payload, from] = await this.#conn.receive();
          const source = parseNetAddr(from);
          // The connected-mode filter, as a BACKSTOP over the OS's: the
          // WIT pins "only receive datagrams from that address", the
          // kernel filters on real node, but Deno's dgram compat treats
          // connect() as a default destination only — so non-matching
          // sources are dropped here either way (matching what a kernel
          // filter would have done silently).
          if (this.#remote === undefined || sameSocketAddress(source, this.#remote)) {
            return [payload, source];
          }
        }
      } catch (e) {
        throw mapPlatformError(e, "udp-socket.receive");
      }
    }

    getLocalAddress(): IpSocketAddress {
      onCall("udp-socket.get-local-address");
      if (this.#conn === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "udp-socket.get-local-address: the socket is not bound",
        );
      }
      return parseNetAddr(this.#conn.addr);
    }

    getRemoteAddress(): IpSocketAddress {
      onCall("udp-socket.get-remote-address");
      if (this.#remote === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "udp-socket.get-remote-address: the socket is not connected",
        );
      }
      return this.#remote;
    }

    getAddressFamily(): IpAddressFamily {
      onCall("udp-socket.get-address-family");
      return this.#family;
    }

    /** Stored-value getter (documented default 64, the common OS default):
     * node exposes a setter (`setTTL`) but no getter. */
    getUnicastHopLimit(): number {
      onCall("udp-socket.get-unicast-hop-limit");
      return this.#hopLimit ?? 64;
    }

    setUnicastHopLimit(value: number): void {
      onCall("udp-socket.set-unicast-hop-limit");
      if (value < 1) {
        // The WIT pins this: "set-unicast-hop-limit(0)" must fail.
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.set-unicast-hop-limit: the hop limit must be at least 1",
        );
      }
      this.#hopLimit = value;
      if (this.#conn !== undefined) this.#applyCachedOptions();
    }

    getReceiveBufferSize(): bigint {
      onCall("udp-socket.get-receive-buffer-size");
      return this.#bufferSize("receive", this.#recvBuffer, this.#conn?.getRecvBufferSize);
    }

    setReceiveBufferSize(value: bigint): void {
      onCall("udp-socket.set-receive-buffer-size");
      if (value === 0n) {
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.set-receive-buffer-size: zero is not a buffer size",
        );
      }
      this.#recvBuffer = value;
      if (this.#conn !== undefined) this.#applyCachedOptions();
    }

    getSendBufferSize(): bigint {
      onCall("udp-socket.get-send-buffer-size");
      return this.#bufferSize("send", this.#sendBuffer, this.#conn?.getSendBufferSize);
    }

    setSendBufferSize(value: bigint): void {
      onCall("udp-socket.set-send-buffer-size");
      if (value === 0n) {
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.set-send-buffer-size: zero is not a buffer size",
        );
      }
      this.#sendBuffer = value;
      if (this.#conn !== undefined) this.#applyCachedOptions();
    }

    /** Live kernel value when bound (SO_RCVBUF doubling and clamping
     * included), the cached request before that, `not-supported` when
     * neither exists (the OS default is unknowable pre-bind here). */
    #bufferSize(
      which: "receive" | "send",
      cached: bigint | undefined,
      live: (() => number) | undefined,
    ): bigint {
      if (this.#conn !== undefined && live !== undefined) {
        try {
          return BigInt(live.call(this.#conn));
        } catch (e) {
          throw mapPlatformError(e, `udp-socket.get-${which}-buffer-size`);
        }
      }
      if (cached !== undefined) return cached;
      throw componentError(
        { kind: "not-supported" },
        `udp-socket.get-${which}-buffer-size: unknowable before bind on this host`,
      );
    }

    /** Cached options -> the live socket (at bind, and on later sets). */
    #applyCachedOptions(): void {
      const conn = this.#conn;
      if (conn === undefined) return;
      try {
        if (this.#hopLimit !== undefined) conn.setTtl(this.#hopLimit);
        if (this.#recvBuffer !== undefined) {
          conn.setRecvBufferSize(Number(this.#recvBuffer));
        }
        if (this.#sendBuffer !== undefined) {
          conn.setSendBufferSize(Number(this.#sendBuffer));
        }
      } catch (e) {
        throw mapPlatformError(e, "udp-socket (applying cached options)");
      }
    }

    [Symbol.dispose](): void {
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

    /** Re-detect per call: `create`'s answer must not outlive a test's stub. */
    #listen(opts: { transport: "udp"; hostname: string; port: number }): DatagramConn {
      const listen = listenDatagram();
      if (listen === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket: the datagram backend disappeared after create",
        );
      }
      return listen(opts);
    }
  }

  class TcpSocket {
    #family: IpAddressFamily;
    #state: "unbound" | "bound" | "connecting" | "connected" | "listening" | "closed" = "unbound";
    #conn: TcpConn | undefined;
    #listener: TcpListener | undefined;
    /** The address `bind` recorded; the OS bind happens at `listen` (header). */
    #localRequest: IpSocketAddress | undefined;
    #sendCalled = false;
    #receiveCalled = false;
    /** listen()'s accept-queue hint (`set-listen-backlog-size`). */
    #backlog: number | undefined;
    /** SO_KEEPALIVE + TCP_KEEPIDLE cache (node's exact option surface);
     * applied at connect and on set-while-connected. The idle default is
     * Linux's tcp_keepalive_time (7200 s) — DOCUMENTED, not read from
     * the OS (node exposes no getter). */
    #keepAliveEnabled = false;
    #keepAliveIdleNs = 7_200_000_000_000n;
    /**
     * Shared-ownership references (WIT: "The OS socket is closed only
     * after the last handle is dropped"): the resource handle plus each
     * live pump and the accept stream. The conn/listener close at zero —
     * so a live send, receive, or accept stream keeps the socket open
     * past the guest dropping the handle.
     */
    #refs = 1;
    #handleDropped = false;

    private constructor(family: IpAddressFamily) {
      this.#family = family;
    }

    /** An accepted connection, already in the `connected` state. */
    static #accepted(family: IpAddressFamily, conn: TcpConn): TcpSocket {
      const socket = new TcpSocket(family);
      socket.#conn = conn;
      socket.#state = "connected";
      return socket;
    }

    static create(addressFamily: IpAddressFamily): TcpSocket {
      onCall("tcp-socket.create");
      if (tcpConnect() === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket.create: this host provides no TCP sockets (no node:net)",
        );
      }
      return new TcpSocket(addressFamily);
    }

    /**
     * Records the local address; the OS bind is DEFERRED to `listen` or
     * `connect` (recorded divergence: node cannot bind a socket it has
     * not yet connected or listened — so `address-in-use` and friends
     * surface at those calls, with their real codes).
     */
    bind(localAddress: IpSocketAddress): void {
      onCall("tcp-socket.bind");
      if (this.#state !== "unbound") {
        throw componentError(
          { kind: "invalid-state" },
          `tcp-socket.bind: not bindable from the '${this.#state}' state`,
        );
      }
      if (!isValidAddressFamily(this.#family, localAddress)) {
        throw componentError(
          { kind: "invalid-argument" },
          `tcp-socket.bind: address family mismatch (an ${this.#family} socket)`,
        );
      }
      if (localAddress.kind === "ipv6" && localAddress.value.scopeId !== 0) {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket.bind: non-zero scope-id (not expressible through node addresses)",
        );
      }
      this.#localRequest = localAddress;
      this.#state = "bound";
    }

    async connect(remoteAddress: IpSocketAddress): Promise<void> {
      onCall("tcp-socket.connect");
      if (this.#state !== "unbound" && this.#state !== "bound") {
        // Includes `closed` after a failed attempt: "A single socket can
        // not be used to connect more than once."
        throw componentError(
          { kind: "invalid-state" },
          `tcp-socket.connect: not connectable from the '${this.#state}' state`,
        );
      }
      if (
        !isValidAddressFamily(this.#family, remoteAddress) ||
        isUnspecified(remoteAddress) ||
        remoteAddress.value.port === 0
      ) {
        throw componentError(
          { kind: "invalid-argument" },
          "tcp-socket.connect: the remote address must be a specific unicast " +
            `address and non-zero port in the socket's family (${this.#family})`,
        );
      }
      if (remoteAddress.kind === "ipv6" && remoteAddress.value.scopeId !== 0) {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket.connect: non-zero scope-id (not expressible through node addresses)",
        );
      }
      const connect = tcpConnect();
      if (connect === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket: the TCP backend disappeared after create",
        );
      }
      // Connect-from-bound: `bind` recorded the local address; the OS
      // bind happens here, as part of the dial (`net.connect`'s
      // localAddress/localPort) — so bind errors (address-in-use,
      // address-not-bindable) surface at connect, the deferred-bind
      // divergence the module header records.
      const local = this.#localRequest;
      this.#state = "connecting";
      let conn: TcpConn;
      try {
        conn = await connect({
          transport: "tcp",
          hostname: ipHostname(remoteAddress),
          port: remoteAddress.value.port,
          ...(local === undefined ? {} : {
            localHostname: ipHostname(local),
            localPort: local.value.port,
          }),
        });
      } catch (e) {
        // "After a failed connection attempt, the socket will be in the
        // `closed` state and the only valid action left is to `drop`".
        this.#state = "closed";
        throw mapPlatformError(e, "tcp-socket.connect");
      }
      if (this.#state !== "connecting") {
        // Disposed while the dial was in flight: nothing owns the fresh
        // conn — close it rather than leak it.
        try {
          conn.close();
        } catch {
          // Already closed.
        }
        throw componentError(
          { kind: "invalid-state" },
          "tcp-socket.connect: the socket was dropped during connect",
        );
      }
      this.#conn = conn;
      this.#state = "connected";
      this.#applyKeepAlive(); // options set before connect reach the OS here
    }

    /**
     * WIT: `listen: func() -> result<stream<tcp-socket>, error-code>` —
     * transitions to `listening` and returns the perpetual accept stream,
     * whose elements are connected `TcpSocket` resources (lowered as
     * `own<tcp-socket>` — embedder-api.md §"Streams and futures" destroys
     * any element the guest never takes, closing that accepted connection).
     * An unbound socket
     * implicitly binds to the family wildcard with an ephemeral port.
     *
     * SUSPENDING (embedder-api.md §"The WASI parking kernel", the wasi:io `block` kernel): the OS
     * bind is deferred one event-loop turn by `net.Server.listen` (module
     * header), so this async method awaits the settle and the runtime
     * parks the calling guest frame for that one tick. Full listener
     * fidelity follows: `get-local-address` is real immediately after,
     * and a failed bind is a branded err with its real code
     * (address-in-use, …). Guests that link `listen` auto-select jspi
     * mode on JSPI engines; engines without JSPI would raise `NeedsJspi`
     * here — currently moot everywhere polyengine guests run (JSC lacks
     * multi-memory, and browsers have no sockets).
     *
     * The stream only ends on fatal errors — the listener dying — while
     * per-connection accept failures are skipped, per the WIT's
     * implementors note.
     */
    @suspending
    async listen(): Promise<TcpAcceptStream> {
      onCall("tcp-socket.listen");
      if (this.#state !== "unbound" && this.#state !== "bound") {
        throw componentError(
          { kind: "invalid-state" },
          `tcp-socket.listen: not listenable from the '${this.#state}' state`,
        );
      }
      const listen = tcpListen();
      if (listen === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket.listen: this host provides no TCP listeners (no node:net)",
        );
      }
      const local = this.#localRequest ?? wildcardAddress(this.#family);
      const listener = listen({
        transport: "tcp",
        hostname: ipHostname(local),
        port: local.value.port,
        ...(this.#backlog === undefined ? {} : { backlog: this.#backlog }),
      });
      try {
        await listener.settled(); // the one-tick park (doc comment above)
      } catch (e) {
        listener.close();
        this.#state = "closed";
        throw mapPlatformError(e, "tcp-socket.listen");
      }
      this.#listener = listener;
      this.#state = "listening";
      this.#refs++; // the accept stream keeps the listener alive
      const family = this.#family;
      const release = (): void => this.#release();
      const source = (async function* (): AsyncGenerator<TcpSocket> {
        try {
          for (;;) {
            let conn: TcpConn;
            try {
              conn = await listener.accept();
            } catch (e) {
              const kind = mapPlatformError(e, "tcp-socket.listen (accept)")
                .payload.kind;
              // Per-connection failures are skipped (the WIT implementors
              // note: "log it and then skip over non-fatal errors");
              // anything else means the LISTENER is dead — closed under
              // us, or never came up — and ends the perpetual stream.
              if (TRANSIENT_ACCEPT_FAILURES.has(kind)) continue;
              return;
            }
            yield TcpSocket.#accepted(family, conn);
          }
        } finally {
          release();
        }
      })();
      // The producer-cancellation hook (embedder-api.md §"Streams and
      // futures"): when the guest drops the
      // stream while the loop above is PARKED in accept(), the runtime's
      // pump invokes this — closing the listener is what unparks the
      // accept (it rejects; classified fatal; the generator retires).
      return Object.assign(source, {
        cancel: (): void => {
          try {
            listener.close();
          } catch {
            // Already closed.
          }
        },
      });
    }

    /**
     * WIT: `send: func(data: stream<u8>) -> future<result<_, error-code>>`
     * — a sync func; the returned promise is the future source
     * (embedder-api.md §"Streams and futures").
     * NEVER throws: the function has no error channel of its own, so every
     * failure — including the state-machine ones — resolves the future as
     * an err value. The argument stream is dropped on failure so its
     * guest-side writer settles instead of parking forever.
     */
    send(data: TcpSendSource): Promise<SocketResult> {
      onCall("tcp-socket.send");
      if (this.#state !== "connected" || this.#sendCalled || this.#conn === undefined) {
        dropSendSource(data);
        return Promise.resolve(RESULT_INVALID_STATE);
      }
      this.#sendCalled = true;
      return this.#sendPump(this.#conn, data);
    }

    async #sendPump(conn: TcpConn, data: TcpSendSource): Promise<SocketResult> {
      this.#refs++;
      try {
        // Guest-side iteration failures (a peer trap while reading the
        // lifted stream) are deliberately NOT caught: they are not socket
        // errors, and the rejection rides the producer-failure channel.
        for await (const chunk of data as AsyncIterable<Uint8Array | number[]>) {
          const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
          let at = 0;
          while (at < bytes.length) {
            let n: number;
            try {
              n = await conn.write(bytes.subarray(at));
            } catch (e) {
              dropSendSource(data);
              return resultErrOf(e, "tcp-socket.send");
            }
            at += n;
          }
        }
        // End of the guest's stream ("the caller should close the stream
        // when it has no more data"): shutdown(SHUT_WR) — the FIN. The
        // future resolves ok only once the full contents are transmitted.
        try {
          await conn.closeWrite();
        } catch (e) {
          return resultErrOf(e, "tcp-socket.send");
        }
        return RESULT_OK;
      } finally {
        this.#release();
      }
    }

    /**
     * WIT: `receive: func() -> tuple<stream<u8>, future<result<_,
     * error-code>>>`. NEVER throws; a not-connected or repeat call returns
     * a closed stream and an already-err future, per the WIT. The stream
     * ends cleanly (never fake data) on BOTH graceful FIN and abnormal
     * close — the future distinguishes them (`ok` vs `err`). Dropping the
     * stream's reader (guest SHUT_RD) stops the pump, discards queued
     * data, and settles the future ok — the canceller is the observer
     * (the same logic as embedder-api.md §"Streams and futures"'s cancelRead ruling).
     */
    receive(): [TcpByteStream, Promise<SocketResult>] {
      onCall("tcp-socket.receive");
      if (this.#state !== "connected" || this.#receiveCalled || this.#conn === undefined) {
        return [[], Promise.resolve(RESULT_INVALID_STATE)];
      }
      this.#receiveCalled = true;
      const conn = this.#conn;
      this.#refs++;
      let settle!: (v: SocketResult) => void;
      const done = new Promise<SocketResult>((r) => (settle = r));
      const release = (): void => this.#release();
      const source = (async function* (): AsyncGenerator<Uint8Array> {
        try {
          for (;;) {
            // The chunk is node's own buffer (no copy); it is borrowed by
            // the rendezvous until the peer takes it (embedder-api.md
            // §"Streams and futures": round-trip idempotence), which is safe —
            // each read hands back a distinct buffer.
            let chunk: Uint8Array | null;
            try {
              chunk = await conn.read(TCP_RECEIVE_CHUNK);
            } catch (e) {
              settle(resultErrOf(e, "tcp-socket.receive"));
              return;
            }
            if (chunk === null) {
              settle(RESULT_OK); // graceful FIN from the peer
              return;
            }
            if (chunk.length > 0) yield chunk;
          }
        } finally {
          settle(RESULT_OK); // no-op if already settled (resolve is once)
          release();
        }
      })();
      return [source, done];
    }

    getLocalAddress(): IpSocketAddress {
      onCall("tcp-socket.get-local-address");
      if (this.#state === "listening" && this.#listener !== undefined) {
        const addr = this.#listener.addr;
        if (addr !== null) return parseNetAddr(addr);
        // Unreachable in practice: `listen` awaited the settle, after
        // which the listener reports its address. Kept as an honest err
        // rather than a non-null assertion.
        throw componentError(
          { kind: "invalid-state" },
          "tcp-socket.get-local-address: the listener reported no address",
        );
      }
      if (this.#conn === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "tcp-socket.get-local-address: the socket is not bound",
        );
      }
      return parseNetAddr(this.#conn.localAddr);
    }

    getRemoteAddress(): IpSocketAddress {
      onCall("tcp-socket.get-remote-address");
      if (this.#state !== "connected" || this.#conn === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "tcp-socket.get-remote-address: the socket is not connected",
        );
      }
      return parseNetAddr(this.#conn.remoteAddr);
    }

    getAddressFamily(): IpAddressFamily {
      onCall("tcp-socket.get-address-family");
      return this.#family;
    }

    getIsListening(): boolean {
      onCall("tcp-socket.get-is-listening");
      return this.#state === "listening";
    }

    /** Stored pre-listen and applied as node's `listen` backlog hint;
     * node cannot re-listen, so changing it on a LISTENING socket is
     * `not-supported` (wasmtime re-listens; recorded divergence). */
    setListenBacklogSize(value: bigint): void {
      onCall("tcp-socket.set-listen-backlog-size");
      if (value === 0n) {
        throw componentError(
          { kind: "invalid-argument" },
          "tcp-socket.set-listen-backlog-size: zero is not a backlog",
        );
      }
      if (this.#state === "listening") {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket.set-listen-backlog-size: node cannot re-listen an active listener",
        );
      }
      if (this.#state !== "unbound" && this.#state !== "bound") {
        throw componentError(
          { kind: "invalid-state" },
          `tcp-socket.set-listen-backlog-size: not settable in the '${this.#state}' state`,
        );
      }
      // Clamp to a safe int; the OS clamps to SOMAXCONN anyway.
      this.#backlog = Number(value > 0x7fffffffn ? 0x7fffffffn : value);
    }

    getKeepAliveEnabled(): boolean {
      onCall("tcp-socket.get-keep-alive-enabled");
      return this.#keepAliveEnabled;
    }

    setKeepAliveEnabled(value: boolean): void {
      onCall("tcp-socket.set-keep-alive-enabled");
      this.#keepAliveEnabled = value;
      this.#applyKeepAlive();
    }

    /** Stored-value getter (field doc: the default is documented, not
     * read — node has no getter). */
    getKeepAliveIdleTime(): bigint {
      onCall("tcp-socket.get-keep-alive-idle-time");
      return this.#keepAliveIdleNs;
    }

    setKeepAliveIdleTime(value: bigint): void {
      onCall("tcp-socket.set-keep-alive-idle-time");
      if (value < 1n) {
        throw componentError(
          { kind: "invalid-argument" },
          "tcp-socket.set-keep-alive-idle-time: the idle time must be at least 1 ns",
        );
      }
      this.#keepAliveIdleNs = value;
      this.#applyKeepAlive();
    }

    // TCP_KEEPINTVL / TCP_KEEPCNT / IP_TTL / SO_RCVBUF / SO_SNDBUF have no
    // node:net surface at all — answered honestly, not emulated.
    getKeepAliveInterval(): never {
      onCall("tcp-socket.get-keep-alive-interval");
      throw this.#noOption("keep-alive-interval (TCP_KEEPINTVL)");
    }
    setKeepAliveInterval(_value: bigint): never {
      onCall("tcp-socket.set-keep-alive-interval");
      throw this.#noOption("keep-alive-interval (TCP_KEEPINTVL)");
    }
    getKeepAliveCount(): never {
      onCall("tcp-socket.get-keep-alive-count");
      throw this.#noOption("keep-alive-count (TCP_KEEPCNT)");
    }
    setKeepAliveCount(_value: number): never {
      onCall("tcp-socket.set-keep-alive-count");
      throw this.#noOption("keep-alive-count (TCP_KEEPCNT)");
    }
    getHopLimit(): never {
      onCall("tcp-socket.get-hop-limit");
      throw this.#noOption("hop-limit (IP_TTL)");
    }
    setHopLimit(_value: number): never {
      onCall("tcp-socket.set-hop-limit");
      throw this.#noOption("hop-limit (IP_TTL)");
    }
    getReceiveBufferSize(): never {
      onCall("tcp-socket.get-receive-buffer-size");
      throw this.#noOption("receive-buffer-size (SO_RCVBUF)");
    }
    setReceiveBufferSize(_value: bigint): never {
      onCall("tcp-socket.set-receive-buffer-size");
      throw this.#noOption("receive-buffer-size (SO_RCVBUF)");
    }
    getSendBufferSize(): never {
      onCall("tcp-socket.get-send-buffer-size");
      throw this.#noOption("send-buffer-size (SO_SNDBUF)");
    }
    setSendBufferSize(_value: bigint): never {
      onCall("tcp-socket.set-send-buffer-size");
      throw this.#noOption("send-buffer-size (SO_SNDBUF)");
    }

    #noOption(what: string): ComponentException<SocketErrorCode> {
      return componentError(
        { kind: "not-supported" },
        `tcp-socket: node:net exposes no ${what}`,
      );
    }

    /** The keep-alive cache -> the live socket, when there is one. */
    #applyKeepAlive(): void {
      const conn = this.#conn;
      if (this.#state !== "connected" || conn === undefined) return;
      try {
        conn.setKeepAlive(this.#keepAliveEnabled, Number(this.#keepAliveIdleNs / 1_000_000n));
      } catch (e) {
        throw mapPlatformError(e, "tcp-socket (applying keep-alive)");
      }
    }

    [Symbol.dispose](): void {
      if (this.#handleDropped) return;
      this.#handleDropped = true;
      if (
        this.#state === "unbound" || this.#state === "bound" ||
        this.#state === "connecting"
      ) {
        // An in-flight dial observes this and closes its fresh conn.
        this.#state = "closed";
      }
      this.#release();
    }

    #release(): void {
      this.#refs--;
      if (this.#refs === 0) {
        const conn = this.#conn;
        this.#conn = undefined;
        if (conn !== undefined) {
          try {
            conn.close();
          } catch {
            // Already closed.
          }
        }
        const listener = this.#listener;
        this.#listener = undefined;
        if (listener !== undefined) {
          try {
            listener.close();
          } catch {
            // Already closed (e.g. by the accept stream's cancel hook).
          }
        }
      }
    }
  }

  /**
   * `wasi:sockets/ip-name-lookup@0.3`: `resolve-addresses: async
   * func(name) -> result<list<ip-address>, error-code>` — getaddrinfo
   * over the platform seam (node:dns `lookup`, i.e. the system resolver,
   * not raw DNS). IP literals resolve locally without touching the
   * resolver (wasmtime parity); answers keep the resolver's order.
   */
  const resolveAddresses = async (name: string): Promise<IpAddress[]> => {
    onCall("ip-name-lookup.resolve-addresses");
    const nameErr = (
      payload: NameLookupErrorCode,
      detail: string,
    ): ComponentException<NameLookupErrorCode> =>
      new ComponentException(payload, `wasi:sockets/ip-name-lookup@0.3: ${detail}`);
    const toIpAddress = (hostname: string): IpAddress => {
      const parsed = parseNetAddr({ hostname, port: 0 });
      return parsed.kind === "ipv4"
        ? { kind: "ipv4", value: parsed.value.address }
        : { kind: "ipv6", value: parsed.value.address };
    };
    if (name.length === 0) {
      throw nameErr({ kind: "invalid-argument" }, "resolve-addresses: empty name");
    }
    // An IP literal is already an answer (and `lookup` would hand it back
    // unchanged anyway — skip the resolver round-trip).
    try {
      return [toIpAddress(name.startsWith("[") ? name.slice(1, -1) : name)];
    } catch {
      // Not a literal: a real name for the resolver.
    }
    const lookup = dnsLookup();
    if (lookup === undefined) {
      throw nameErr(
        { kind: "permanent-resolver-failure" },
        "resolve-addresses: this host provides no resolver (no node:dns)",
      );
    }
    let answers;
    try {
      answers = await lookup(name);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      const message = e instanceof Error ? e.message : String(e);
      if (code === "ENOTFOUND" || code === "EAI_NONAME" || code === "ENODATA") {
        throw nameErr({ kind: "name-unresolvable" }, `resolve-addresses: ${message}`);
      }
      if (code === "EAI_AGAIN" || code === "ETIMEOUT" || code === "ETIMEDOUT") {
        throw nameErr(
          { kind: "temporary-resolver-failure" },
          `resolve-addresses: ${message}`,
        );
      }
      if (
        isDenoError(e, "NotCapable") || isDenoError(e, "PermissionDenied") ||
        code === "EACCES" || code === "EPERM"
      ) {
        throw nameErr({ kind: "access-denied" }, `resolve-addresses: ${message}`);
      }
      if (e instanceof TypeError) {
        throw nameErr({ kind: "invalid-argument" }, `resolve-addresses: ${message}`);
      }
      throw nameErr({ kind: "other", value: message }, `resolve-addresses: ${message}`);
    }
    try {
      return answers.map((a) => toIpAddress(a.address));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw nameErr({ kind: "other", value: message }, `resolve-addresses: ${message}`);
    }
  };

  return {
    imports: {
      "wasi:sockets/types@0.3": { UdpSocket, TcpSocket },
      "wasi:sockets/ip-name-lookup@0.3": { resolveAddresses },
    },
    UdpSocket,
    TcpSocket,
    resolveAddresses,
  };
}


/** How many bytes one tcp receive read asks the OS for. */
const TCP_RECEIVE_CHUNK = 16384;

/**
 * Accept failures that are per-connection, not per-listener: the WIT
 * implementors note says to skip them ("Guest code never gets to see
 * these failures"); everything else ends the perpetual stream.
 */
const TRANSIENT_ACCEPT_FAILURES: ReadonlySet<SocketErrorCode["kind"]> = new Set([
  "connection-aborted",
  "connection-reset",
  "connection-refused",
  "connection-broken",
  "remote-unreachable",
  "timeout",
]);

/**
 * Abandon tcp send's input when the operation fails: a lifted `Stream`
 * handle is dropped so the guest's writer settles ("reader went away")
 * instead of parking forever; other producer shapes are cleaned up by the
 * iteration protocol itself (`for await`'s abrupt-exit `return()`).
 */
function dropSendSource(data: TcpSendSource): void {
  if (isStream(data)) data.drop();
}
