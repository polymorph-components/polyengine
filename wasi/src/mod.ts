// `@polyengine/wasi` — the WASI providers for polyengine hosts, and the
// executable check that the embedder conventions
// (`@polyengine/protocol` — this package is protocol-only, per
// embedder-api.md §"The host-ABI surface and its version")
// serve WASI (docs/architecture.md §2 keeps implementations out of
// the RUNTIME — this package is where they live). Scope: p2
// baseline + p3 clocks + à la carte sockets on BOTH tracks (the
// poll-shaped `@0.2` surface std::net links, and `@0.3` UDP + TCP
// client/listener; one node-builtins backend serving Deno and Node;
// `@polyengine/wasi/sockets`, issue #4, server-JS hosts only). Sockets is
// deliberately not merged here: this root module stays host-agnostic
// web-platform code, and `wasi()` merges only AMBIENT, side-effect-
// benign capabilities (time, entropy, stdio capture, an empty
// filesystem). Anything granting network egress or host storage is
// opt-in regardless of how portable it is — sockets, the fetch-backed
// http fragment, the host-stdio cli impl (`./cli-stdio` — real
// stdin/stdout/terminal access; the unqualified `./cli` stays the
// capture impl), and the real filesystem impls (`./filesystem-node` =
// node:fs, `./filesystem-web` = OPFS; the unqualified `./filesystem`
// stays the empty-preopens stub).
//
// COMPOSITION — three forms, coarsest to finest (virtualization scenarios
// pinned by tests/version_resolution_test.ts):
//
// 1. Batteries: `instantiate(a, { ...wasi() })`.
// 2. À la carte fragments: every IMPL is its own subpath export
//    (`@polyengine/wasi/{cli,cli-stdio,clocks,filesystem,filesystem-node,`
//    `filesystem-web,http,io,random,sockets}`) and
//    a plain `{ imports }` record — hand-merge exactly the set you mean:
//    `{ ...io().imports, ...clocks().imports }`. Fragment dependencies:
//    io.ts is the package's shared vocabulary (the parking kernel and
//    the stream classes) — cli, clocks, and the real filesystem and
//    sockets impls all ride it; random and http stand alone. Impl
//    machinery that is not itself a fragment lives under src/internal/
//    (never exported). Naming convention as impls multiply: one
//    subpath per impl; the unqualified name is the batteries impl
//    (`./filesystem` = empty preopens), alternatives carry their backend
//    (`./filesystem-node` = node:fs with explicit preopens,
//    `./filesystem-web` = OPFS).
// 3. Per-interface override: the merged record is a plain object keyed by
//    TRACK keys (`wasi:random/random@0.2`), so later spreads replace
//    single interfaces wholesale:
//    `{ ...wasi(), "wasi:random/random@0.2": myStub }`.
//    Replace the track key, don't add an exact-versioned sibling — the
//    resolver refuses track+exact coexistence on one track as ambiguous
//    (contracts/embedder-api.md §"Version canonicalization"). Per-guest
//    virtualization needs no version tricks anyway: compose a different
//    record per `instantiate` call. Some fragments also take the finer
//    knob directly — `random({ source })` swaps the CSPRNG while keeping
//    the WIT shapes and the no-short-reads rule.
//
// `wasi(options)` returns one flat imports-record fragment, keyed by
// compatibility-**track** keys per contracts/embedder-api.md §"Version
// canonicalization" (`@0.2`, `@0.3`) — this package is the flagship
// track-key-registration consumer: one `@0.2` provider serves every p2
// leaf regardless of whether the guest's binary says `0.2.6`, `0.2.9` or
// `0.2.12`, and one `@0.3` union provider serves both
// divergent `monotonic-clock@0.3.0` drafts the corpus actually links
// (§"Version canonicalization").

import { cli, type CliCaptured, type CliOptions } from "./cli.ts";
import { clocks, type ClocksOptions } from "./clocks.ts";
import { filesystem } from "./filesystem.ts";
import { io } from "./io.ts";
import { random, type RandomOptions } from "./random.ts";

// THIS module exports the batteries surface only: `wasi()` plus exactly
// what consuming it requires — the option types, the captured handle's
// type, and `ExitError` (thrown through `cli`'s `throwOnExit`, so
// batteries embedders classify it). Everything else lives at its
// subpath (composition doc above).
export { type CliCaptured, type CliOptions } from "./cli.ts";
export { ExitError } from "./internal/cli_shared.ts";
export { type ClocksOptions } from "./clocks.ts";
export { type RandomOptions } from "./random.ts";

export interface WasiOptions {
  cli?: CliOptions;
  clocks?: ClocksOptions;
  random?: RandomOptions;
}

/**
 * The merged imports record plus the one piece of host-observable state a
 * caller needs back out (contract wording: "expose captured output on the
 * returned handle"). `captured` is a plain extra property, not a WIT
 * interface-id key, so it never participates in `ImportResolver`'s
 * track/exact matching (`parseInterfaceId("captured")` has no `@`, and it is
 * excluded from the unversioned-track bookkeeping because it contains
 * neither `:` nor `/` — see `runtime/src/embedder/version.ts`
 * `#register`).
 */
export interface WasiImports extends Record<string, unknown> {
  readonly captured: CliCaptured;
}

/**
 * Build the merged `wasi:*` imports fragment for `instantiate`.
 *
 * Usage: `instantiate(artifacts, { ...wasi(), ...moreImports })`.
 */
export function wasi(options: WasiOptions = {}): WasiImports {
  const c = cli(options.cli);
  const merged: Record<string, unknown> = {
    ...c.imports,
    ...io().imports,
    ...clocks(options.clocks).imports,
    ...random(options.random).imports,
    ...filesystem().imports,
  };
  return Object.assign(merged, { captured: c.captured }) as WasiImports;
}
