// INTERNAL shared vocabulary of the `wasi:sockets` tracks
// (sockets_03.ts, sockets_02.ts) — not a package export; the public home
// of these names is `@polyengine/wasi/sockets`. Address codec, wasmtime-parity
// validation, platform error mapping, and the WIT-facing type shapes.

import { ComponentException, type Stream } from "@polyengine/protocol";
import type { NetAddr } from "./sockets_platform.ts";

export type { NetAddr };

/** `wasi:sockets/types@0.3`'s `ip-address-family` enum. */
export type IpAddressFamily = "ipv4" | "ipv6";

/** `ipv4-address` = `tuple<u8, u8, u8, u8>`. */
export type Ipv4Address = [number, number, number, number];

/** `ipv6-address` = `tuple<u16 × 8>`. */
export type Ipv6Address = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface Ipv4SocketAddress {
  port: number;
  address: Ipv4Address;
}

export interface Ipv6SocketAddress {
  port: number;
  flowInfo: number;
  address: Ipv6Address;
  scopeId: number;
}

/** The `ip-socket-address` variant, in `{ kind, value }` form (A10). */
export type IpSocketAddress =
  | { kind: "ipv4"; value: Ipv4SocketAddress }
  | { kind: "ipv6"; value: Ipv6SocketAddress };

/** The address-only `ip-address` variant (ip-name-lookup's vocabulary). */
export type IpAddress =
  | { kind: "ipv4"; value: Ipv4Address }
  | { kind: "ipv6"; value: Ipv6Address };

/** `wasi:sockets/ip-name-lookup@0.3`'s own `error-code` variant. */
export type NameLookupErrorCode =
  | { kind: "access-denied" }
  | { kind: "invalid-argument" }
  | { kind: "name-unresolvable" }
  | { kind: "temporary-resolver-failure" }
  | { kind: "permanent-resolver-failure" }
  | { kind: "other"; value?: string };

/**
 * The `error-code` variant. Every case is listed so callers can switch
 * exhaustively against the real WIT vocabulary.
 */
export type SocketErrorCode =
  | { kind: "access-denied" }
  | { kind: "not-supported" }
  | { kind: "invalid-argument" }
  | { kind: "out-of-memory" }
  | { kind: "timeout" }
  | { kind: "invalid-state" }
  | { kind: "address-not-bindable" }
  | { kind: "address-in-use" }
  | { kind: "remote-unreachable" }
  | { kind: "connection-refused" }
  | { kind: "connection-broken" }
  | { kind: "connection-reset" }
  | { kind: "connection-aborted" }
  | { kind: "datagram-too-large" }
  | { kind: "other"; value?: string };

/**
 * The datagram payload ceiling, matching wasmtime-wasi's
 * `MAX_UDP_DATAGRAM_SIZE` (`u16::MAX`). Larger sends fail
 * `datagram-too-large` before reaching the OS; receives use a buffer of
 * this size so no datagram the OS delivers is ever truncated.
 */
export const MAX_UDP_DATAGRAM_SIZE = 65535;

/**
 * A WIT `err` the branded way (contracts/embedder-api.md, "Error model"):
 * an unbranded throw would become a trap naming the import instead of a
 * guest-visible err.
 */
export function componentError(
  payload: SocketErrorCode,
  detail: string,
): ComponentException<SocketErrorCode> {
  return new ComponentException<SocketErrorCode>(
    payload,
    `wasi:sockets/types@0.3: ${detail}`,
  );
}

// --- address codec ------------------------------------------------------------

/**
 * Render the address part of `addr` as a Deno hostname string.
 *
 * @internal — shared by the node/Deno socket backends; the public entry
 * point is `sockets()`.
 */
export function ipHostname(addr: IpSocketAddress): string {
  if (addr.kind === "ipv4") return addr.value.address.join(".");
  // The uncompressed spelling; Deno's address parser accepts it.
  return addr.value.address.map((g) => g.toString(16)).join(":");
}

/**
 * Parse a Deno `NetAddr` back into a WIT `ip-socket-address`.
 *
 * Handles the compressed (`::1`), full, IPv4-embedded (`::ffff:127.0.0.1` —
 * what a dual-stack socket reports for IPv4 senders), and zoned
 * (`fe80::1%3`) hostname spellings. A zone parses as the numeric scope-id
 * when it is numeric and drops to 0 otherwise (interface names are not
 * representable in the WIT shape); flow-info is not observable and is
 * always 0.
 *
 * @internal — shared by the node/Deno socket backends; the public entry
 * point is `sockets()`.
 */
export function parseNetAddr(addr: NetAddr): IpSocketAddress {
  const host = addr.hostname;
  if (!host.includes(":")) {
    const octets = host.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      throw componentError(
        { kind: "other", value: `unparseable IPv4 hostname ${JSON.stringify(host)}` },
        `unparseable IPv4 hostname ${JSON.stringify(host)}`,
      );
    }
    return {
      kind: "ipv4",
      value: { port: addr.port, address: octets as Ipv4Address },
    };
  }
  const { groups, scopeId } = parseIpv6Hostname(host);
  return {
    kind: "ipv6",
    value: { port: addr.port, flowInfo: 0, address: groups, scopeId },
  };
}

function parseIpv6Hostname(hostname: string): { groups: Ipv6Address; scopeId: number } {
  let host = hostname;
  let scopeId = 0;
  const pct = host.indexOf("%");
  if (pct >= 0) {
    const zone = Number(host.slice(pct + 1));
    scopeId = Number.isInteger(zone) && zone >= 0 ? zone : 0;
    host = host.slice(0, pct);
  }

  const fail = (): never => {
    throw componentError(
      { kind: "other", value: `unparseable IPv6 hostname ${JSON.stringify(hostname)}` },
      `unparseable IPv6 hostname ${JSON.stringify(hostname)}`,
    );
  };
  const dc = host.indexOf("::");
  let head: string[];
  let tail: string[];
  if (dc >= 0) {
    if (host.indexOf("::", dc + 1) >= 0) fail();
    head = dc === 0 ? [] : host.slice(0, dc).split(":");
    tail = dc + 2 === host.length ? [] : host.slice(dc + 2).split(":");
  } else {
    head = host.split(":");
    tail = [];
  }

  // An embedded dotted quad ("::ffff:127.0.0.1") occupies the last two
  // groups.
  const last = tail.length > 0 ? tail : head;
  const pieces = [...head];
  let tailPieces = [...tail];
  let v4Tail: [number, number] | undefined;
  if (last.length > 0 && last[last.length - 1].includes(".")) {
    const quad = last[last.length - 1].split(".").map(Number);
    if (quad.length !== 4 || quad.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) fail();
    v4Tail = [(quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]];
    if (tail.length > 0) tailPieces = tail.slice(0, -1);
    else pieces.pop();
  }

  const parseGroup = (piece: string): number => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) fail();
    return parseInt(piece, 16);
  };
  const headGroups = pieces.map(parseGroup);
  const tailGroups = [...tailPieces.map(parseGroup), ...(v4Tail ?? [])];
  const total = headGroups.length + tailGroups.length;
  if (dc >= 0) {
    if (total > 7) fail();
    while (headGroups.length + tailGroups.length < 8) headGroups.push(0);
  } else if (total !== 8) {
    fail();
  }
  return { groups: [...headGroups, ...tailGroups] as Ipv6Address, scopeId };
}

// --- validation (wasmtime-wasi `sockets/util.rs` parity) ----------------------

function isV4MappedV6(groups: Ipv6Address): boolean {
  return groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff;
}

/** The deprecated IPv4-compatible range, excluding `::` and `::1`. */
function isDeprecatedV4CompatibleV6(groups: Ipv6Address): boolean {
  const headZero = groups.slice(0, 6).every((g) => g === 0);
  if (!headZero) return false;
  const unspecified = groups[6] === 0 && groups[7] === 0;
  const localhost = groups[6] === 0 && groups[7] === 1;
  return !unspecified && !localhost;
}

/**
 * Whether `addr` may cross this socket's family boundary: same family, and
 * never an IPv4-mapped or deprecated IPv4-compatible IPv6 address.
 *
 * @internal — shared by the node/Deno socket backends; the public entry
 * point is `sockets()`.
 */
export function isValidAddressFamily(family: IpAddressFamily, addr: IpSocketAddress): boolean {
  if (family === "ipv4") return addr.kind === "ipv4";
  return addr.kind === "ipv6" &&
    !isV4MappedV6(addr.value.address) &&
    !isDeprecatedV4CompatibleV6(addr.value.address);
}

/**
 * @internal — shared by the node/Deno socket backends; the public entry
 * point is `sockets()`.
 */
export function isUnspecified(addr: IpSocketAddress): boolean {
  if (addr.kind === "ipv4") return addr.value.address.every((o) => o === 0);
  return addr.value.address.every((g) => g === 0);
}

/**
 * Same endpoint: family, address, and port (udp connected-mode filter).
 *
 * @internal — shared by the node/Deno socket backends; the public entry
 * point is `sockets()`.
 */
export function sameSocketAddress(a: IpSocketAddress, b: IpSocketAddress): boolean {
  if (a.kind !== b.kind || a.value.port !== b.value.port) return false;
  return a.value.address.length === b.value.address.length &&
    a.value.address.every((part, i) => part === b.value.address[i]);
}

// --- error mapping ------------------------------------------------------------

/** `e instanceof Deno.errors[name]`, tolerating hosts/versions lacking the class. */
export function isDenoError(e: unknown, name: string): boolean {
  const deno = (globalThis as { Deno?: unknown }).Deno;
  if (typeof deno !== "object" || deno === null) return false;
  const errors = (deno as Record<string, unknown>).errors;
  if (typeof errors !== "object" || errors === null) return false;
  const cls = (errors as Record<string, unknown>)[name];
  return typeof cls === "function" &&
    e instanceof (cls as new () => Error);
}

/**
 * Node-style `err.code` -> WIT `error-code` (the node backend's whole
 * error vocabulary, and a sharper channel than Deno's classes where both
 * exist). The `ERR_*` rows are the adapters' closed-under-a-pending-op
 * signals, mirroring what Deno's BadResource maps to.
 */
const CODE_ERRORS: Record<string, SocketErrorCode> = {
  EADDRINUSE: { kind: "address-in-use" },
  EADDRNOTAVAIL: { kind: "address-not-bindable" },
  ECONNREFUSED: { kind: "connection-refused" },
  ECONNRESET: { kind: "connection-reset" },
  ECONNABORTED: { kind: "connection-aborted" },
  EHOSTUNREACH: { kind: "remote-unreachable" },
  EHOSTDOWN: { kind: "remote-unreachable" },
  ENETUNREACH: { kind: "remote-unreachable" },
  ENETDOWN: { kind: "remote-unreachable" },
  ENONET: { kind: "remote-unreachable" },
  EACCES: { kind: "access-denied" },
  EPERM: { kind: "access-denied" },
  ETIMEDOUT: { kind: "timeout" },
  EMSGSIZE: { kind: "datagram-too-large" },
  EPIPE: { kind: "connection-broken" },
  EINVAL: { kind: "invalid-argument" },
  ENOTSUP: { kind: "not-supported" },
  EOPNOTSUPP: { kind: "not-supported" },
  ERR_SOCKET_DGRAM_NOT_RUNNING: { kind: "invalid-state" },
  ERR_SERVER_NOT_RUNNING: { kind: "invalid-state" },
  ERR_STREAM_DESTROYED: { kind: "invalid-state" },
  ERR_STREAM_WRITE_AFTER_END: { kind: "invalid-state" },
};

/**
 * Map a platform failure onto the WIT `error-code` vocabulary, mirroring
 * wasmtime-wasi's io-error table where the platform exposes the
 * distinction — Deno's error classes first, then Node-style `code`
 * strings, then the plain-`Error` spellings Deno leaves unclassified. An
 * already-branded error passes through unchanged — the codec and the
 * capability re-detection throw branded errors from inside the same try
 * blocks that guard the platform calls, and re-wrapping one would demote
 * its payload to `other`.
 *
 * @internal — shared by the node/Deno socket backends; the public entry
 * point is `sockets()`.
 */
export function mapPlatformError(e: unknown, what: string): ComponentException<SocketErrorCode> {
  if (e instanceof ComponentException) return e as ComponentException<SocketErrorCode>;
  const message = e instanceof Error ? e.message : String(e);
  const err = (payload: SocketErrorCode): ComponentException<SocketErrorCode> =>
    componentError(payload, `${what}: ${message}`);
  if (isDenoError(e, "AddrInUse")) return err({ kind: "address-in-use" });
  if (isDenoError(e, "AddrNotAvailable")) return err({ kind: "address-not-bindable" });
  if (isDenoError(e, "ConnectionRefused")) return err({ kind: "connection-refused" });
  if (isDenoError(e, "ConnectionReset")) return err({ kind: "connection-reset" });
  if (isDenoError(e, "ConnectionAborted")) return err({ kind: "connection-aborted" });
  if (isDenoError(e, "NetworkUnreachable") || isDenoError(e, "HostUnreachable")) {
    return err({ kind: "remote-unreachable" });
  }
  if (isDenoError(e, "PermissionDenied") || isDenoError(e, "NotCapable")) {
    return err({ kind: "access-denied" });
  }
  if (isDenoError(e, "TimedOut")) return err({ kind: "timeout" });
  // A socket closed under a pending operation: the operation was not valid
  // in the socket's (now closed) state.
  if (isDenoError(e, "Interrupted") || isDenoError(e, "BadResource")) {
    return err({ kind: "invalid-state" });
  }
  if (isDenoError(e, "NotSupported")) return err({ kind: "not-supported" });
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code in CODE_ERRORS) return err(CODE_ERRORS[code]);
  // EMSGSIZE surfaces as a plain Error, not a Deno.errors class.
  if (/message too long/i.test(message)) return err({ kind: "datagram-too-large" });
  // EPIPE (a write on a peer-closed connection) also surfaces as a plain
  // Error in Deno.
  if (/broken pipe/i.test(message)) return err({ kind: "connection-broken" });
  if (e instanceof TypeError) return err({ kind: "invalid-argument" });
  return err({ kind: "other", value: message });
}

// --- result values -------------------------------------------------------------
//
// TCP `send`/`receive` report failures through `future<result<_,
// error-code>>` — a result AS A VALUE (contracts/embedder-api.md §"Type
// mapping"), not a throw: the functions themselves are infallible in WIT,
// so a branded throw would be a trap, and an UNRESOLVED future would be a
// hang. These helpers build the `{ kind, value }` result family.

/** `result<_, error-code>` as a value (the payload of tcp send/receive futures). */
export type SocketResult =
  | { kind: "ok" }
  | { kind: "err"; value: SocketErrorCode };

export const RESULT_OK: SocketResult = { kind: "ok" };

export const RESULT_INVALID_STATE: SocketResult = {
  kind: "err",
  value: { kind: "invalid-state" },
};

/** The err side of a `SocketResult`, mapped from a platform failure. */
export function resultErrOf(e: unknown, what: string): SocketResult {
  return { kind: "err", value: mapPlatformError(e, what).payload };
}


export interface SocketsOptions {
  /**
   * Observe every `wasi:sockets` entry point the guest reaches, in call
   * order (`"udp-socket.create"`, `"tcp-socket.connect"`, …). For host-side
   * test assertions — a relay-only scenario can assert zero calls, an exam
   * can read back the guest's exact driving sequence. No default cost: when
   * absent, nothing is recorded.
   */
  onCall?: (call: string) => void;
}

/**
 * The host-implemented `udp-socket` resource surface: a plain class with
 * camelCase methods and the WIT `static` as a JS static
 * (contracts/embedder-api.md, "Resources"). The runtime calls
 * `[Symbol.dispose]` when the guest drops its last handle; that closes the
 * OS socket, settling any still-pending `receive` as a branded err.
 */
export interface UdpSocket {
  bind(localAddress: IpSocketAddress): void;
  connect(remoteAddress: IpSocketAddress): Promise<void>;
  disconnect(): void;
  send(data: Uint8Array, remoteAddress: IpSocketAddress | undefined): Promise<void>;
  receive(): Promise<[Uint8Array, IpSocketAddress]>;
  getLocalAddress(): IpSocketAddress;
  getRemoteAddress(): IpSocketAddress;
  getAddressFamily(): IpAddressFamily;
  getUnicastHopLimit(): number;
  setUnicastHopLimit(value: number): void;
  getReceiveBufferSize(): bigint;
  setReceiveBufferSize(value: bigint): void;
  getSendBufferSize(): bigint;
  setSendBufferSize(value: bigint): void;
  [Symbol.dispose](): void;
}

/** The `udp-socket` resource class a fragment carries. */
export interface UdpSocketClass {
  create(addressFamily: IpAddressFamily): UdpSocket;
}

/**
 * What tcp `send` accepts: the lifted `Stream<u8>` handle the runtime
 * dispatches (its async iterator yields `Uint8Array` chunks), or any
 * natural byte-chunk producer for direct/test use.
 */
export type TcpSendSource =
  | Stream<number>
  | AsyncIterable<Uint8Array | number[]>
  | Iterable<Uint8Array | number[]>;

/** What tcp `receive` returns in stream position: chunks of bytes. */
export type TcpByteStream = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/**
 * What tcp `listen` returns: the perpetual accept stream. `cancel` is the
 * A13 producer-cancellation hook the runtime's pump invokes when the
 * guest drops the stream while the loop is parked in accept(); direct
 * (non-runtime) consumers may call it themselves to stop accepting.
 */
export type TcpAcceptStream = AsyncIterable<TcpSocket> & { cancel(): void };

/**
 * The host-implemented `tcp-socket` resource surface (client + listener
 * halves — module header). `send` is a WIT sync func returning
 * `future<result>`: the async method's promise is lowered as the future
 * source (amendment A12), so the guest's call returns immediately and the
 * future settles when transmission completes. `receive`'s tuple carries
 * the byte stream and the future that reports FIN (`ok`) vs abnormal
 * close (`err`). `listen` returns the perpetual accept stream — an
 * async iterable of connected `TcpSocket` resources, lowered as
 * `stream<own<tcp-socket>>` (amendment A13: elements the guest never
 * takes are destroyed, closing their connections). Dropping the guest
 * handle does NOT close a socket with live pumps or a live accept stream
 * (the WIT's shared-ownership note); the OS socket closes when the
 * handle and every derived stream are all retired.
 */
export interface TcpSocket {
  bind(localAddress: IpSocketAddress): void;
  connect(remoteAddress: IpSocketAddress): Promise<void>;
  listen(): Promise<TcpAcceptStream>;
  send(data: TcpSendSource): Promise<SocketResult>;
  receive(): [TcpByteStream, Promise<SocketResult>];
  getLocalAddress(): IpSocketAddress;
  getRemoteAddress(): IpSocketAddress;
  getAddressFamily(): IpAddressFamily;
  getIsListening(): boolean;
  setListenBacklogSize(value: bigint): void;
  getKeepAliveEnabled(): boolean;
  setKeepAliveEnabled(value: boolean): void;
  getKeepAliveIdleTime(): bigint;
  setKeepAliveIdleTime(value: bigint): void;
  getKeepAliveInterval(): bigint;
  setKeepAliveInterval(value: bigint): void;
  getKeepAliveCount(): number;
  setKeepAliveCount(value: number): void;
  getHopLimit(): number;
  setHopLimit(value: number): void;
  getReceiveBufferSize(): bigint;
  setReceiveBufferSize(value: bigint): void;
  getSendBufferSize(): bigint;
  setSendBufferSize(value: bigint): void;
  [Symbol.dispose](): void;
}

/** The `tcp-socket` resource class a fragment carries. */
export interface TcpSocketClass {
  create(addressFamily: IpAddressFamily): TcpSocket;
}


/**
 * The family's wildcard address, port 0 (tcp listen's implicit bind).
 *
 * @internal — shared by the node/Deno socket backends; the public entry
 * point is `sockets()`.
 */
export function wildcardAddress(family: IpAddressFamily): IpSocketAddress {
  return family === "ipv4"
    ? { kind: "ipv4", value: { port: 0, address: [0, 0, 0, 0] } }
    : {
      kind: "ipv6",
      value: { port: 0, flowInfo: 0, address: [0, 0, 0, 0, 0, 0, 0, 0], scopeId: 0 },
    };
}

