# Consumer workloads

The [polymorph-components](https://github.com/polymorph-components) family and
[`wosh`](https://github.com/lann/wosh) supply real composed workloads alongside
the WAST corpus. They exercise long-lived background tasks, cross-task wakeups,
resource-heavy host interfaces, mixed sync/async calls, and components produced
by Rust, componentize-js, and componentize-go. A small WAST or Rust fixture is
useful for isolating a defect, but does not replace this workload scope.

Polyengine replaces the JavaScript component host, not guest-production tools
or native wasmtime hosts. Consumer suites are integration sanity checks and
sources of findings, not a claim that every consumer configuration works or an
independent release requirement. The local `just gates` recipe includes the
available smoke tools; CI cannot assume those external checkouts exist.

## Dependency conventions

- The application selects the runtime through its import map or package
  manager. Host-provider packages import `@polyengine/protocol` at most, and
  must not carry a package-local runtime mapping that overrides the application.
  Keep standalone development mappings outside the provider package.
- Keep runtime and translator on the same lockstep release line. Protocol is
  independently versioned. Published dependencies use compatible version
  constraints and lockfiles; tracking `main` requires explicit git revisions or
  `pre-<shorthash>` release-asset pins. See [Consuming](../README.md#consuming)
  and the [host-ABI contract](../contracts/embedder-api.md) rather than copying a
  version number from this document.
- Check the resolved graph after dependency updates. The intended application
  graph has one engine source; a vendored application should not also resolve
  remote copies. Cross-copy brands help diagnose mistakes but do not make
  duplicate runtimes desirable.
- For an old `@deltic` consumer, migrate the entire engine dependency graph to
  `@polyengine` together. The scopes use different brand namespaces, so a partial
  rename can silently break cross-copy checks. Consumer-owned lane and directory
  names need not match the package scope.

WASI p2 pollables, I/O streams, and resources, and p3 streams, futures, and async
methods are part of the workload requirements. Implementations live outside
core, including this repository's [`wasi/`](../wasi/) package. Platform-specific
host choices and engine requirements belong to each consumer and
[architecture](architecture.md), not to a blanket Deno/Node equivalence claim.

## Read-only smoke inputs

External consumer checkouts are **read-only** during engine work. Check their
git status before and after any verification that uses them. Do not install,
regenerate, or build into those trees; any separately authorized build must use
scratch output or a redirected `CARGO_TARGET_DIR`. Do not update consumer pins
as a side effect of an engine test.

The smoke tools consume prebuilt artifacts. Their paths are defined in
[`tools/smoke-c0/common.ts`](../tools/smoke-c0/common.ts), with `POLYMORPH_ROOT`
and `WOSH_ROOT` overrides. Record the consumer revision, artifact identity, and
engine revision when interpreting a result. An artifact on disk is not proof
that it was built from the checkout's current source.

| In-repo tool | Scope |
| --- | --- |
| [`ct-runner`](../ct-runner/) | Runs the polymorph-test suite contract and emits structured per-case results; its own fixtures and tests live here |
| [`tools/smoke-c0`](../tools/smoke-c0/) | Composed async repro, iroh execution-model probe including later calls against a live detached pump, componentize-go translation timing, and websocket suite translation/import inspection |
| [`tools/smoke-tls`](../tools/smoke-tls/) | Translates TLS compositions and executes self-contained suites through ct-runner and WASI; per-target tags distinguish inapplicable cases |

Missing consumer artifacts can be logged as skips without failing the smoke
process. A successful exit alone therefore does not establish that the intended
workloads ran. Report which artifacts executed, which were translation-only,
and all skips or not-applicable cases; do not retain an old all-green count as
a current guarantee.

Consumer-code findings belong in
[`upstream-consumer-findings.md`](../upstream-consumer-findings.md). Filing them
in a foreign repository requires the operator's authorization.
