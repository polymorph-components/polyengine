# polyengine — consumer adoption: the polymorph track

The first production consumers are the [polymorph-components] family —
`polymorph-{webcrypto,websocket,webrtc-datachannels,tls,test,iroh}` — and
experiment-mosh (a mosh client/proxy tunneled over the iroh endpoint
component). All run the same triangle {wasmtime host, JS host, in-guest
provider}; the JS host was jco (a pinned fork), and the jco legs are where
their plans were blocked. Replacing jco there is this project's adoption
target ([architecture.md §1](architecture.md)); jco-convention compatibility
is explicitly not part of it ([§2](architecture.md)) — the consumers have no
external dependents and port to conventions designed fresh
([contracts/embedder-api.md](../contracts/embedder-api.md)).

Their jco blockers map one-for-one onto this project's proven strengths
(every "our status" cell below is an executable gate — see
[milestones.md](milestones.md) rows C0–C3):

| Their blocker | Class | Our status |
|---|---|---|
| lann/jco#11 (= polymorph-iroh#10): execution-slot queue serializes task lifetimes — a detached pump task deadlocks every later export call; fix blocked behind further scheduler rearchitecting (jco #30, #31); costs iroh a ~5× handshake-latency polling workaround meanwhile | scheduler | task admission is the reference's `enter_implicit_thread` gate; parked callback-ABI tasks release exclusivity. Executable: smoke-c0 leg 2 and the iroh endpoint exam (40 export calls against live detached pumps) |
| lann/jco#13: guest-internal stream wakeups never delivered | scheduler | same-component streams/futures fully green; the exam's `accept` parks before a dial and is woken by the pump |
| lann/jco#14: composed async cross-component calls fail (`_asyncStartCall` param count) | fused adapters | FACT start-calls green across all four ABI pairings incl. spilled params; full composed-client E2E is [#2](https://github.com/polymorph-components/polyengine/issues/2) |
| lann/jco#6/#7: subtask/future cancellation traps | cancellation | cross-component cancellation per reference (and upstream finding CM-3) |
| lann/jco#51: TDZ at import time — emitted trampoline references a resource class above its declaration (trigger: async cross-component call returning `own<resource>` + that resource re-exported in an exported interface) | codegen emission | the defect *class* cannot exist in a runtime linker — nothing is emitted; the minimized `compose-async-tdz` shape is a corpus fixture (smoke-c0 leg 1, green) |
| componentize-go `[async-lower]` imports: "Missing subtask" / hangs (wasmtime runs the same guests correctly — spec-valid guest, host at fault) | subtask bookkeeping | async-lower per the reference; the 8 MB componentize-go mosh engine instantiates and runs |

## Standing consequences

- **Co-evolution, not compatibility.** Conventions are designed against
  the consumers' host modules as reference implementations; they port; both
  sides upgrade deliberately. Registry releases exist as of 0.1.0
  ([#16](https://github.com/polymorph-components/polyengine/issues/16), 2026-08-16) and are
  caret-honest — still 0.x/unstable, compatible within a minor line,
  breaking changes bump the minor — so consumers couple via caret
  constraints (`jsr:@polyengine/*@^0.4.0`), with `pre-<shorthash>` prerelease
  artifacts (exact pins) and git references for tracking `main` between
  releases. That first caret line ran under the project's former name, in
  the `@deltic` scope, through `0.2.1`; the `@polyengine` line begins at
  `0.3.0` — the deltic-era `v*` tags survived the transfer, so lower
  numbers would collide (#206; see "The scope rename" below).
- **WASI interfaces are design inputs even though implementations stay
  out of core.** The conventions must make wasi p2 idioms (pollables, io
  streams, error-code enums, resource-heavy surfaces) and p3 idioms
  (stream/future-bearing signatures, async resource methods,
  error-context) natural to implement in JS — whoever adopts this host
  writes shims against these conventions, and the broader ecosystem's
  most important interfaces are exactly these. The embedder-api contract
  carries paper signatures for a representative WASI slice; the
  `wasi/` package is the executable check.
- **The application owns the import map** (issue #83, decision 2026-08-11;
  the WICG import-maps stance as a family convention). Host-module
  packages import `@polyengine/*` by bare specifier and carry **no** mapping
  for it in any config a consumer resolves through — standalone dev/test
  mappings live outside the package directory (sibling repo root), because
  Deno applies package-local config to package files and a package-carried
  pin silently overrides the consumer's root import map (wosh finding 26:
  four extra runtime copies, one per sibling pin). Consumers assert the
  invariant mechanically: after `deno install`, the resolved graph
  contains **exactly one** polyengine source (for a vendoring consumer like
  wosh: zero remote polyengine URLs in the lockfile — a one-line CI guard).
  Since amendment A9 (contracts/embedder-api.md §"Module identity"),
  cross-boundary brands are process-global symbols via `@polyengine/protocol`,
  so a violation degrades to a diagnosed inefficiency instead of a latent
  `instanceof` failure — host modules SHOULD import `@polyengine/protocol` at
  most, keeping runtime selection entirely with the deploying application.
- **Their suites are engine sanity checks, not gates** (operator ruling,
  2026-08-10; supersedes the earlier "their suites become our gates"
  posture and the release-gate framing of the now-closed
  [#6](https://github.com/polymorph-components/polyengine/issues/6)). This family surfaced at
  least five distinct jco defect classes that no WAST corpus expresses
  (long-lived composed workloads, background pumps, cross-task wakeups,
  codegen-shape triggers) — and five polyengine runtime defects the same way
  (smoke-c0's R-1/R-2; the tls smoke's three,
  [#18](https://github.com/polymorph-components/polyengine/issues/18)) — so running them is
  high-yield. But everything on both sides is unstable and co-evolves in
  tandem: a consumer-suite delta is a finding to triage, never a blocker
  for upstreaming or release.
- **What replacing jco does not replace**: componentize-js/-go (guest
  production — out of scope per [architecture.md §2](architecture.md); their
  output components are ordinary inputs to us) and the wasmtime host legs
  (the native story).
- **Unlocks on their side, recorded for the cutover argument**: no
  transpile step, generated trees, flag-verification scripts, or fork
  pins; the Node 24 + JSPI-flag lane replaced by a flagless Deno lane
  (WebRTC included — verified below) and browser legs beyond Chromium;
  fresh-instance-per-case without re-transpile (their runners
  re-instantiate after poisoning); waker-based cross-task wakeups
  restoring the polling-workaround latency.

## Cutover state — the jco disposition

Operator ruling (2026-08-10, recorded on
[#14](https://github.com/polymorph-components/polyengine/issues/14)): **jco support/coverage is
retained in polymorph-webcrypto only.** The cutover is **delivered** — every
other repo's jco legs are gone, each removal landing only after its polyengine
coverage twin existed and the [#17](https://github.com/polymorph-components/polyengine/issues/17)
first-order measurements were recorded (the ordering rule, honored: tls's
early removal was reverted, then re-landed post-measurement; the
leg-wall-time table lives on
[#14](https://github.com/polymorph-components/polyengine/issues/14), 2026-08-10).

| Repo | polyengine legs | jco end state |
|---|---|---|
| webcrypto | deno ([#352](https://github.com/polymorph-components/polymorph-webcrypto/pull/352)) + browser ([#355](https://github.com/polymorph-components/polymorph-webcrypto/pull/355)) | **retained indefinitely by design** — the Chromium side of the Deno platform-gap ledger and the venue where [#17](https://github.com/polymorph-components/polyengine/issues/17)'s head-to-head ran (closed); docs present polyengine as the primary JS path ([#358](https://github.com/polymorph-components/polymorph-webcrypto/pull/358)) |
| tls | deno + browser (their [#36](https://github.com/polymorph-components/polymorph-tls/pull/36), [#39](https://github.com/polymorph-components/polymorph-tls/pull/39)) | removed (their [#42](https://github.com/polymorph-components/polymorph-tls/pull/42); the earlier [#40](https://github.com/polymorph-components/polymorph-tls/pull/40)→[#41](https://github.com/polymorph-components/polymorph-tls/pull/41) revert honored the measurement ordering); head-to-head stays reproducible at the pre-removal SHA |
| iroh | `host-deltic` (their [#36](https://github.com/polymorph-components/polymorph-iroh/pull/36)) | removed (their [#40](https://github.com/polymorph-components/polymorph-iroh/pull/40); the parked draft #39 closed superseded); their #10 closed as superseded; the polling-workaround retirement landed too (their #37/#42 — the ~5× handshake-latency win); still open there: #38 bench call counts |
| websocket | deno (their [#40](https://github.com/polymorph-components/polymorph-websocket/pull/40)) + browser (their [#41](https://github.com/polymorph-components/polymorph-websocket/pull/41)) | removed (their [#42](https://github.com/polymorph-components/polymorph-websocket/pull/42)); WPT parity carrier ported to polyengine with empty loss sets; demo runs runtime-linked |
| webrtc-datachannels | deno (their [#149](https://github.com/polymorph-components/polymorph-webrtc-datachannels/pull/149)) + browser page-runner (their [#150](https://github.com/polymorph-components/polymorph-webrtc-datachannels/pull/150) — `RTCPeerConnection` is Window-only) | removed (their [#151](https://github.com/polymorph-components/polymorph-webrtc-datachannels/pull/151)); interop directions preserved on polyengine children — vs libwebrtc reference and wasmtime, both orders, 13 directions × 12 pair cases |
| test | n/a — already jco-free as a gate ([#77](https://github.com/polymorph-components/polymorph-test/pull/77)) | keeps publishing the jco-era compat surface webcrypto's retained lanes pin |

Every standing matrix runs polyengine as its JS host (webcrypto additionally
retains jco rows). Pin state (2026-08-20, the v0.2.0 family upgrade): the
whole family consumes this host from **JSR** — exact `@deltic/*@0.2.0` pins
in repo tooling, `^0.2.0` ranges in the published host modules
(`@polymorph/{websocket,webcrypto,webrtc-datachannels,iroh}`, each
published at 0.2.0 with its engine line; `@polymorph/test` at 0.1.1 is
engine-version-agnostic by design — its worker takes the engine by
injection). Those pins name the **old** `@deltic` scope and stay valid —
its published versions are immutable — until each repo migrates. Every repo
gates module identity on ONE resolved engine
version (pin gates + iroh's identity gate: "one runtime, no raw URLs"),
which is [#108](https://github.com/polymorph-components/polyengine/issues/108)'s
"alternative" resolution realized for the family; wosh (the issue's
exemplar consumer) has since moved to JSR pins as well, so whether #108
retains live scope is the operator's call on that issue. Upgrades ride
the lockstep line:
0.2.0 is breaking (plan formatVersion 4), and runtime + translator move
together by construction.

## The scope rename (deltic → polyengine)

This repository moved from `lann/deltic` to
[`polymorph-components/polyengine`](https://github.com/polymorph-components/polyengine)
and its JSR scope from `@deltic` to `@polyengine`. It is a hard break with
no compatibility shim, and it is deliberately **not** synchronized with the
consumers: they keep resolving `@deltic/*@0.2.x` (immutable on JSR) and
migrate one repo at a time.

What a consumer changes when its turn comes:

| Surface | Before | After |
|---|---|---|
| package specifiers | `jsr:@deltic/{runtime,protocol,translator,wasi,ct-runner}` | `jsr:@polyengine/…` |
| version line | `0.2.x` | continues at `0.3.0` (first number clear of the surviving deltic-era tags, #206) |
| cross-copy brands | `Symbol.for("deltic.witError/1")` and siblings | `Symbol.for("polyengine.componentException/1")` — see [embedder-api.md](../contracts/embedder-api.md) amendments A18/A19 (A18 shipped this key as `polyengine.witError/1`; A19 renamed the leaf) |
| environment | `DELTIC_TRANSLATOR`, `DELTIC_SCHED_SEED`, `DELTIC_DRIVE_TRACE` | `POLYENGINE_*` |
| release assets | `deltic-embedder.mjs`, `deltic-translator-shim.wasm` | `polyengine-*` |
| ct-runner envelope target | `deltic/host` (the CLI default) | `polyengine/host` |

The brand keys are the one that fails quietly: a graph mixing a `@deltic`
copy and a `@polyengine` copy produces two disjoint brand namespaces, so
cross-copy `instanceof`-style checks simply return false rather than
reporting a copy conflict. Migrate a repo's engine dependency in one step,
never partially.

**What survives the rename, and what does not.** The JSR packages do: JSR
versions are immutable, so `@deltic/*` through `0.2.1` stays resolvable
forever and an un-migrated consumer keeps building. The deltic-era **GitHub
releases** do not: `v0.1.0`, `v0.2.0` and `v0.2.1` were deleted during the
rename. Their *tags* survived, which is why the `@polyengine` line starts
at `0.3.0` — `gh release create` on a `0.1.x`/`0.2.x` version would attach
to the old tag's commit (#206). A
release can only be cut from a commit that already has a green
`pre-<shorthash>` prerelease (release.yml's guard), so each deleted `v*`
release has a surviving prerelease twin at the same commit carrying
byte-identical assets under the same names — `v0.1.0`/`pre-6750269`,
`v0.2.0`/`pre-59b4d34`, `v0.2.1`/`pre-a68a64a`. All 97 `pre-*` tags are
retained, and they are what the family actually pins: every consumer that
fetches a release asset by tag names a prerelease (iroh `pre-eb3f8d0`,
webrtc-datachannels `pre-10cc776`, tls `pre-83fff30`), never a `v*` tag.

Identifiers the consumers own — lane names (`deltic-deno`, `deltic-browser`),
directories (`js/deltic`, `host-deltic`, `runner-deltic`), expectation keys
(`targets.deltic-deno.*`) and CI check names — are theirs to rename or keep,
on their own schedule. Where this document names one, it is quoting their
spelling, not a stale substitution.

## Deno substitutes for Node (C0 evidence)

Node is **not a consumer requirement.** Deno functionally substitutes across
the whole consumer capability surface — verified empirically (2026-08-08,
Deno 2.9.5/linux-arm64, via the C0 capability probe; served and retired
2026-08-14, history: `git log -- tools/probes/webrtc-deno` — the living
WebRTC-under-Deno coverage is the consumers' own polyengine legs, e.g. the
webrtc driver-ct matrix under their upstreamed host module):

| Capability | Deno path | Status |
|---|---|---|
| WebRTC | `node-datachannel/polyfill` (the polymorph Node legs' exact dependency) as a Node-API addon | verified: full data-channel loopback green |
| WebRTC fallback | `werift` (pure TS, no native code) | verified: same loopback green |
| WebSocket | built-in `WebSocket` | native |
| WebCrypto | `globalThis.crypto.subtle` | native |
| UDP/TCP | `Deno.listenDatagram` / node-compat `dgram`, `net` | native/compat |
| fs/process/spawn | node compat + native APIs | native/compat |

Node stays a nearly-free *distribution* target via npm (the callback-ABI path
needs no JSPI flag), not a test lane, until someone needs it.

## In-repo consumer artifacts

Reference implementations developed here. The host modules and the iroh exam
concluded their dispositions — upstreamed as consumer-owned copies, in-repo
trees retired (rows below). `ct-runner`'s disposition is
[#14](https://github.com/polymorph-components/polyengine/issues/14)'s remaining open item: the
original plan said "move to polymorph-test", but it has since become one of
the four lockstep-published packages (`@polyengine/ct-runner`), an in-repo gate
dependency (`tools/smoke-tls` imports it as source), and the thing
polymorph-test's own glue *pins* — closing that bullet as
resolved-differently is an operator ruling.

| Path | What | Gate |
|---|---|---|
| `ports/{websocket,webcrypto,webrtc}` (retired) | the `polymorph:{websocket/connections,webcrypto,webrtc-datachannels/connections}` host modules | served and retired (2026-08-14): developed here as the reference implementations of the embedder conventions, upstreamed as the consumers' own host modules — websocket ([#40](https://github.com/polymorph-components/polymorph-websocket/pull/40)/[#41](https://github.com/polymorph-components/polymorph-websocket/pull/41)), webcrypto ([#352](https://github.com/polymorph-components/polymorph-webcrypto/pull/352)), webrtc ([#149](https://github.com/polymorph-components/polymorph-webrtc-datachannels/pull/149) — their driver-ct loopback matrix 37/37) — whose repos run their suites (incl. websocket's 55/55 conformance) under those copies as the living gates; the in-repo `test-ports`/`test-webrtc`/`websocket-conformance` recipes retired with the trees. History: `git log -- ports` |
| `exams/iroh-endpoint` (retired) | the endpoint exit exam | served and retired (2026-08-11, in-repo through 5/5 + IROH-1): upstreamed as their `host-deltic/` + `just exam-deltic` ([polymorph-iroh#36](https://github.com/polymorph-components/polymorph-iroh/pull/36), merged), after which the in-repo copy was re-testing polyengine against a staling guest snapshot — the consumer's own polyengine leg is the living exam; the runtime defects it caught are pinned in polyengine's suites (R-1/R-2, entry-deferral). History: `git log -- exams/iroh-endpoint` |
| `ct-runner` | L3 runner for the polymorph-test L1 contract; published in the lockstep set as `@polyengine/ct-runner` | golden/schema/shard/tags battery + CLI tests (`just test-ct-runner`); translate-only import analysis against the websocket consumer checkout; `tools/smoke-tls` drives it as source (the in-repo websocket suite left with `ports/`) |
| `tools/smoke-c0` | C0 smoke legs + report | legs 1–4 (`REPORT.md`) |
| `tools/smoke-tls` | polymorph-tls conformance under polyengine ([#18](https://github.com/polymorph-components/polyengine/issues/18)) | translate 8/8; suites: zero failures, zero xfails on every composition — tag gating ([#25](https://github.com/polymorph-components/polyengine/issues/25), `ct-runner/src/tags.ts`) schedules the per-target inapplicable cases to `not-applicable` exactly like their harness legs; the callback-null-context defect it found ([#24](https://github.com/polymorph-components/polyengine/issues/24)) is fixed — attribution sentinels, `runtime/src/jspi/bridge.ts` |

Deferred consumer surfaces: iroh UDP direct path
([#4](https://github.com/polymorph-components/polyengine/issues/4)). Closed since this list was
first drawn: webcrypto family completion
([#3](https://github.com/polymorph-components/polyengine/issues/3), done), experiment-mosh deep
E2E ([#2](https://github.com/polymorph-components/polyengine/issues/2), operator-managed
separately).

Defects found in consumer code while running their artifacts are tracked in
[`../upstream-consumer-findings.md`](../upstream-consumer-findings.md)
(filing: [#15](https://github.com/polymorph-components/polyengine/issues/15)).

[polymorph-components]: https://github.com/polymorph-components
