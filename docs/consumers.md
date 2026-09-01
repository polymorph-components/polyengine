# polyengine — consumer adoption: the polymorph track

The first production consumers are the [polymorph-components] family —
`polymorph-{webcrypto,websocket,webrtc-datachannels,tls,test,iroh}` — and
experiment-mosh (a mosh client/proxy tunneled over the iroh endpoint
component). All run the same triangle {wasmtime host, JS host, in-guest
provider}. Their JS host was jco (a pinned fork), whose structural defects
in exactly this project's core territory — scheduler task admission,
cross-task wakeups, composed async cross-component calls, cancellation,
codegen emission — blocked their plans; replacing jco there is this
project's adoption target ([architecture.md §1](architecture.md)), and
jco-convention compatibility is explicitly not part of it
([§2](architecture.md)) — the consumers have no external dependents and
port to conventions designed fresh
([contracts/embedder-api.md](../contracts/embedder-api.md)).

The cutover is delivered: every standing consumer matrix runs polyengine as
its JS host. polymorph-webcrypto additionally retains jco rows by design —
the Chromium side of its platform-gap ledger. What replacing jco does not
replace: componentize-js/-go (guest production — out of scope per
[architecture.md §2](architecture.md); their output components are ordinary
inputs to us) and the wasmtime host legs (the native story).

## Standing conventions

- **Co-evolution, not compatibility.** Conventions are designed against
  the consumers' host modules as reference implementations; they port; both
  sides upgrade deliberately. Registry releases are caret-honest — still
  0.x/unstable, compatible within a minor line, breaking changes bump the
  minor — so consumers couple via caret constraints
  (`jsr:@polyengine/*@^0.4.0`), with `pre-<shorthash>` GitHub release
  artifacts and git references for tracking `main` between releases.
- **WASI interfaces are design inputs even though implementations stay
  out of core.** The conventions must make wasi p2 idioms (pollables, io
  streams, error-code enums, resource-heavy surfaces) and p3 idioms
  (stream/future-bearing signatures, async resource methods,
  error-context) natural to implement in JS — whoever adopts this host
  writes shims against these conventions, and the broader ecosystem's
  most important interfaces are exactly these. The `wasi/` package is the
  executable check.
- **The application owns the import map** (the WICG import-maps stance as
  a family convention). Host-module packages import `@polyengine/*` by
  bare specifier and carry **no** mapping for it in any config a consumer
  resolves through — standalone dev/test mappings live outside the package
  directory (sibling repo root), because Deno applies package-local config
  to package files and a package-carried pin silently overrides the
  consumer's root import map (observed in the wild: four extra runtime
  copies, one per sibling pin). Consumers assert the invariant
  mechanically: after `deno install`, the resolved graph contains
  **exactly one** polyengine source (for a vendoring consumer: zero remote
  polyengine URLs in the lockfile — a one-line CI guard). Cross-boundary
  brands are process-global symbols via `@polyengine/protocol`
  (contracts/embedder-api.md §"Module identity"), so a violation degrades
  to a diagnosed inefficiency instead of a latent `instanceof` failure —
  and host modules MUST import `@polyengine/protocol` at most (§"The
  host-ABI surface and its version": the runtime's exported surface is
  application-only), keeping runtime selection entirely with the deploying
  application.
- **Their suites are engine sanity checks, not gates** (operator ruling).
  This family surfaced multiple distinct jco defect classes that no WAST
  corpus expresses (long-lived composed workloads, background pumps,
  cross-task wakeups, codegen-shape triggers) — and several polyengine
  runtime defects the same way — so running them is high-yield. But
  everything on both sides is unstable and co-evolves in tandem: a
  consumer-suite delta is a finding to triage, never a blocker for
  upstreaming or release.

## Pins and the scope rename

This repository moved from `lann/deltic` to
[`polymorph-components/polyengine`](https://github.com/polymorph-components/polyengine)
and its JSR scope from `@deltic` to `@polyengine` — a hard break with no
compatibility shim, deliberately **not** synchronized with the consumers:
JSR versions are immutable, so `@deltic/*` through `0.2.1` stays resolvable
forever and an un-migrated consumer keeps building; each repo migrates in
one step, on its own schedule. What a consumer changes when its turn comes:

| Surface | Before | After |
|---|---|---|
| package specifiers | `jsr:@deltic/{runtime,protocol,translator,wasi,ct-runner}` | `jsr:@polyengine/…` |
| version line | `0.2.x` | continues at `0.3.0`+ (lower numbers would collide with surviving deltic-era tags, #206) |
| cross-copy brands | `Symbol.for("deltic.witError/1")` and siblings | `Symbol.for("polyengine.componentException/1")` and siblings — see [embedder-api.md](../contracts/embedder-api.md) §"Module identity" |
| environment | `DELTIC_TRANSLATOR`, `DELTIC_SCHED_SEED`, `DELTIC_DRIVE_TRACE` | `POLYENGINE_*` |
| release assets | `deltic-embedder.mjs`, `deltic-translator-shim.wasm` | `polyengine-*` |
| ct-runner envelope target | `deltic/host` (the CLI default) | `polyengine/host` |

The brand keys are the one that fails quietly: a graph mixing a `@deltic`
copy and a `@polyengine` copy produces two disjoint brand namespaces, so
cross-copy checks simply return false rather than reporting a copy
conflict. Migrate a repo's engine dependency in one step, never partially.

Deltic-era `v*` GitHub releases were deleted during the rename; their tags
survived (which is why the `@polyengine` line starts at `0.3.0`), and every
deleted release has a surviving `pre-<shorthash>` prerelease twin at the
same commit carrying byte-identical assets — the prerelease tags are what
consumers actually pin when fetching release assets. Identifiers the
consumers own — lane names (`deltic-deno`), directories (`host-deltic`),
expectation keys, CI check names — are theirs to rename or keep; where this
document names one, it is quoting their spelling.

Every repo gates module identity on ONE resolved engine version (pin gates;
iroh's "one runtime, no raw URLs" identity gate). Upgrades ride the
lockstep line: runtime and translator move together by construction.

## Deno substitutes for Node

Node is **not a consumer requirement.** Deno functionally substitutes
across the whole consumer capability surface — WebRTC via
`node-datachannel/polyfill` (the polymorph Node legs' exact dependency) or
`werift` (pure TS), built-in `WebSocket` and WebCrypto, UDP/TCP via native
and node-compat APIs — all verified by the consumers' own polyengine legs.
Node stays a nearly-free *distribution* target via npm (the callback-ABI
path needs no JSPI flag) plus the pinned `node-pinned` conformance lane
(architecture.md §3).

## In-repo consumer artifacts

The reference host modules (`ports/{websocket,webcrypto,webrtc}`) and the
iroh endpoint exam were developed here and upstreamed as the consumers' own
copies; their repos run the living gates (history: `git log -- ports`,
`git log -- exams/iroh-endpoint`). What remains in-repo:

| Path | What | Gate |
|---|---|---|
| `ct-runner` | L3 runner for the polymorph-test L1 contract; published in the lockstep set as `@polyengine/ct-runner`; polymorph-test's own glue pins it | golden/schema/shard/tags battery + CLI tests (`just test-ct-runner`); translate-only import analysis against the websocket consumer checkout; `tools/smoke-tls` drives it as source |
| `tools/smoke-c0` | consumer smoke legs (experiment-mosh `compose-async-tdz` repro, iroh exec-model probe incl. later export calls against a live detached pump, websocket suite translation, componentize-go translator throughput) | `just smoke-c0` |
| `tools/smoke-tls` | polymorph-tls conformance under polyengine ([#18](https://github.com/polymorph-components/polyengine/issues/18)) | `just smoke-tls`: translate 8/8; suites: zero failures, zero xfails on every composition — tag gating ([#25](https://github.com/polymorph-components/polyengine/issues/25), `ct-runner/src/tags.ts`) schedules per-target inapplicable cases to `not-applicable` exactly like their harness legs |

Deferred consumer surfaces: iroh UDP direct path
([#4](https://github.com/polymorph-components/polyengine/issues/4)).

Defects found in consumer code while running their artifacts are tracked in
[`../upstream-consumer-findings.md`](../upstream-consumer-findings.md)
(filing: [#15](https://github.com/polymorph-components/polyengine/issues/15)).

[polymorph-components]: https://github.com/polymorph-components
