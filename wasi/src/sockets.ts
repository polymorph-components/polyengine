// `wasi:sockets` — grants this process's NETWORK REACH to the guest,
// unscoped: there is no allowlist, address check, or TCP/UDP toggle, so
// a guest can reach anything this process can, loopback and instance
// metadata endpoints included (docs/security.md). Never rides the
// default `wasi()` merge.
//
// BOTH tracks: `types@0.3` + `ip-name-lookup@0.3` (UDP
// and TCP, client + listener; internal/sockets_03.ts) and the poll-shaped
// `@0.2` surface (internal/sockets_02.ts). THIS module is the public
// face: the `sockets()` fragment factory and the vocabulary re-exports.
// One backend serves both tracks: the
// node builtins (`node:dgram` / `node:net`), which
// real Node provides natively, Deno serves as STABLE node-compat (no
// `--unstable-net` needed — that flag gates only the native API's shape,
// not the capability), and Bun reaches through its compat (findings-only;
// JSC lacks multi-memory, so polyengine guests cannot run there regardless).
// Backend rationale, adapters, and measured costs: internal/sockets_platform.ts.
//
// À la carte (issue #4): this module is a separate export
// (`@polyengine/wasi/sockets`), never merged into `wasi()` — the
// baseline package stays host-agnostic web-platform code, while this
// fragment is server-JS-native by nature (browsers have no sockets;
// wasmtime owns the native story). Consumers that want it spread it in:
//
//   instantiate(artifacts, { ...wasi(), ...sockets().imports })
//
// The UDP provider is adopted from polymorph-components/polymorph-iroh#69
// (that host's exam drives it over loopback QUIC); divergences from the
// adopted code are the track key (`@0.3`, per this package's conventions —
// one provider serves every 0.3.x), the fragment-scoped `onCall` hook
// replacing a module-global call log (a published provider must not grow a
// string per datagram by default), and `globalThis`-based feature detection
// (the module evaluates and answers honestly on any host). The TCP client
// surface is what the wosh listener bridges through (its
// `listener-core/src/tcp.rs` — issue #4's prospective consumer) and the
// smoke-c0 leg-4 composed-websocket shopping list names.
//
// The implemented resource shapes (0.3.x WIT — the full 0.3.1 release
// surface, minus the recorded not-supported options below):
//
//   resource udp-socket {
//     create/bind/connect/disconnect/send/receive,
//     get-local-address/get-remote-address/get-address-family,
//     get+set unicast-hop-limit, get+set receive/send-buffer-size
//   }
//   resource tcp-socket {
//     create/bind/connect/listen/send/receive,
//     get-local-address/get-remote-address/get-address-family/get-is-listening,
//     set-listen-backlog-size, get+set keep-alive-enabled,
//     get+set keep-alive-idle-time
//   }
//   ip-name-lookup { resolve-addresses }  (system resolver via node:dns)
//
// OPTIONS HONESTY (the node option surface is narrow; nothing is
// emulated silently):
//
//   * udp connect/disconnect are OS-level (node dgram connect: kernel
//     filtering and default destination), not adapter filtering.
//   * udp unicast-hop-limit: setter is real (dgram setTTL); the getter
//     reports the cached value (default 64, documented) — node has no
//     getter. Buffer sizes are real both ways once bound (SO_RCVBUF/
//     SO_SNDBUF); before bind, gets report the cached request or fail
//     `not-supported`.
//   * tcp keep-alive: enabled + idle-time are real (node setKeepAlive);
//     gets report cached values (idle default 7200 s, documented).
//     keep-alive-interval/count, tcp hop-limit, and tcp buffer sizes
//     have NO node:net API and fail `not-supported`.
//   * set-listen-backlog-size: applied as listen()'s backlog hint;
//     changing it while listening is `not-supported` (node cannot
//     re-listen; wasmtime re-listens).
//   * accepted sockets do NOT inherit the listener's options (wasmtime
//     inherits; recorded divergence).
//
// Anything else a future guest links fails loudly with a trap naming the
// missing method rather than riding an untested emulation.
//
// The behavioral yardstick is wasmtime-wasi's p3 provider (the consumers'
// wasmtime hosts serve the same guests through it).
//
// UDP: the same 64 KiB datagram ceiling, the same state machine (`bind`
// once from unbound; `receive` and `get-local-address` demand a bound
// socket; `send` to a remote implicitly binds an unbound socket to a
// wildcard address; an omitted `send` remote requires connected mode, and
// an explicit remote on a connected socket is `invalid-argument`), and the same address-family validation (an
// IPv4-mapped or deprecated IPv4-compatible IPv6 address never crosses a
// family boundary). Recorded divergences, rooted in the platform exposing
// no socket options:
//
//   * scope-id: a non-zero IPv6 `scope-id` fails `not-supported` (node
//     hostnames cannot carry a zone; wasmtime binds it).
//   * v6-only: wasmtime sets IPV6_V6ONLY on IPv6 sockets; node leaves the
//     OS default, so an `::` wildcard bind on Linux is dual-stack and may
//     receive IPv4 traffic, surfaced as IPv4-mapped sender addresses —
//     which is also why the address codec parses the `::ffff:a.b.c.d`
//     spelling.
//   * unread datagrams queue in the adapter (node's receive path is
//     push-shaped) and tail-drop past a bound — the kernel-buffer
//     analogue; see sockets_platform.ts `MAX_QUEUED_DATAGRAMS`.
//
// TCP (the TcpSocketOperationalSemantics-0.3.0 state machine): `connect`
// once from `unbound` (a failed attempt closes the socket); `listen` once
// from `unbound` (implicit wildcard-ephemeral bind) or `bound`;
// `send`/`receive` once each, only when `connected`, and their failures
// NEVER throw — `send`'s error channel is its returned future (embedder-api.md
// §"Streams and futures": the async method's promise IS the future source)
// and `receive`'s is the future half of its tuple, resolved as result values.
// `listen` returns the perpetual accept stream, whose elements are connected
// `tcp-socket` resources (§"Streams and futures": un-taken elements are destroyed
// at teardown, closing their connections); per-connection accept failures
// are skipped, listener-fatal ones end the stream. Stream teardown
// follows the WIT's shared-ownership note: the OS socket closes only when
// the resource handle AND every derived stream (pumps, accept stream) are
// done, so they all remain functional after the guest drops the
// `tcp-socket` handle. The receive stream ends (cleanly, no fake data) on
// BOTH graceful FIN and abnormal close; the two are distinguished by the
// future (`ok` vs `err`), exactly as the WIT documents. Guest-side
// failures while consuming `send`'s stream (a peer trap) are NOT socket
// errors: they propagate as producer failures on the host-failure channel.
//
// `listen` is SUSPENDING (embedder-api.md §"The WASI parking kernel" —
// the wasi:io `block` kernel): node defers the OS bind one event-loop turn, so `listen` parks
// the calling guest frame for that tick and returns fully settled — real
// ephemeral addresses from `get-local-address`, real error codes
// (`address-in-use`) from a failed bind. Guests that link `listen`
// auto-select jspi mode on JSPI engines (V8: Deno, Node, Chromium);
// client-shaped guests are untouched.
//
// Recorded TCP divergences:
//
//   * `bind` records the address; the OS bind is DEFERRED to `listen` or
//     `connect` (node cannot bind an unconnected socket), so bind errors
//     (`address-in-use`, `address-not-bindable`) surface at those calls —
//     with their real codes — not at `bind`.
//
// When the node builtins are absent (`process.getBuiltinModule` missing —
// a browser), `create` fails `error-code.not-supported` — the honest
// capability answer. On Deno the providers need `--allow-net`; a denied
// permission arrives as `Deno.errors.NotCapable` through the compat layer
// and maps to `access-denied`.

import { sockets02 } from "./internal/sockets_02.ts";
import { sockets03 } from "./internal/sockets_03.ts";
import type {
  IpAddress,
  SocketsOptions,
  TcpSocketClass,
  UdpSocketClass,
} from "./internal/sockets_shared.ts";

// The public vocabulary (types, address codec, validators, the platform
// error mapper) lives in internal/sockets_shared.ts; THIS module is its
// public home. The tracks live in internal/sockets_03.ts and
// internal/sockets_02.ts and share one node-builtins backend
// (internal/sockets_platform.ts).
export {
  type IpAddress,
  type IpAddressFamily,
  ipHostname,
  type IpSocketAddress,
  type Ipv4Address,
  type Ipv4SocketAddress,
  type Ipv6Address,
  type Ipv6SocketAddress,
  isUnspecified,
  isValidAddressFamily,
  mapPlatformError,
  MAX_UDP_DATAGRAM_SIZE,
  type NameLookupErrorCode,
  type NetAddr,
  parseNetAddr,
  sameSocketAddress,
  type SocketErrorCode,
  type SocketResult,
  type SocketsOptions,
  type TcpAcceptStream,
  type TcpByteStream,
  type TcpSendSource,
  type TcpSocket,
  type TcpSocketClass,
  type UdpSocket,
  type UdpSocketClass,
  wildcardAddress,
} from "./internal/sockets_shared.ts";
// The 0.2 track's public pieces: the enum error vocabulary, the io-error
// resource `network-error-code` downcasts, and the opaque network.
export {
  Network,
  type SocketErrorCode02,
  SocketIoError,
} from "./internal/sockets_02.ts";

/**
 * @internal — test-only export; wasi/tests/sockets_test.ts pins the
 * literal track key. The public entry point is `sockets()`.
 */
export const SOCKETS_TYPES_INTERFACE = "wasi:sockets/types@0.3";

/** What `sockets()` returns: the imports fragment plus the fragment's classes. */
export interface SocketsShim {
  imports: Record<string, unknown>;
  /** The 0.3 track's resource classes (exposed for direct/test use). */
  UdpSocket: UdpSocketClass;
  TcpSocket: TcpSocketClass;
  /** 0.3 `ip-name-lookup.resolve-addresses` (exposed for direct/test use). */
  resolveAddresses: (name: string) => Promise<IpAddress[]>;
}

/**
 * The `wasi:sockets` provider fragment, BOTH tracks (module header):
 * `types@0.3` + `ip-name-lookup@0.3` (internal/sockets_03.ts) and the
 * seven poll-shaped `@0.2` interfaces (internal/sockets_02.ts). Track
 * keys — one provider serves every 0.2.x / 0.3.x the resolver folds onto
 * its track. Resource classes are built per fragment so the `onCall`
 * observer is scoped to it.
 */
export function sockets(options: SocketsOptions = {}): SocketsShim {
  const onCall = options.onCall ?? ((): void => {});
  const track03 = sockets03(onCall);
  return {
    imports: {
      ...track03.imports,
      ...sockets02(onCall).imports,
    },
    UdpSocket: track03.UdpSocket,
    TcpSocket: track03.TcpSocket,
    resolveAddresses: track03.resolveAddresses,
  };
}
