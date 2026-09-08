# polyengine

A WebAssembly **Component Model host for JavaScript**. It loads component
binaries at runtime, using wasmtime's translation frontend compiled to wasm
and the stock `WebAssembly` JS API to execute them.

The runtime implements Component Model 0.3 concurrency: tasks, streams,
futures, backpressure, and cancellation. Callback-ABI async calls do not
require JSPI; stackful async calls and blocking sync imports do. FACT fused
adapters handle cross-component ABI conversion in wasm; TypeScript handles
the host boundary and scheduler.

## Status

Pre-1.0, with conformance and integration gates rather than a claim of full
spec coverage. The official Component Model corpus runs on Deno, browser,
and engine-shell lanes. Expected failures and engine-specific differences
are tracked explicitly; unexpected failures and stale expectations fail
the applicable gate.

- Supported workloads include Rust/wit-bindgen and componentize-go guests,
  sync and async, including composed components and overlapping exports.
- Runtime coverage includes canonical ABI values, resources, async host
  imports, streams/futures, and background progress between export calls.
- Known gaps include deferred thread features, upstream-unimplemented
  features, and sync scheduling gaps. See
  [architecture §11](docs/architecture.md#11-conformance-and-testing) and the
  [issue tracker](https://github.com/polymorph-components/polyengine/issues).
- Guest-initiated resource destructors cannot suspend through JSPI: their
  current dispatch path contains a JS frame. See
  [architecture §7](docs/architecture.md#7-canonical-abi-decisions).
- Engine support depends on the component's core-wasm features as well as
  its use of JSPI. See the
  [compatibility table](docs/architecture.md#3-compatibility-targets).

Host filesystem and network access is opt-in. **WASI path and request
checks are not a sandbox for hostile guests**; read [security.md](docs/security.md)
before granting host access.

## Consuming

Packages are available on JSR and npm. Releases are compatible within a
minor line; breaking changes bump the minor. Use a caret range for a
released version, not the next-release version in the checkout's manifests:

```ts
import { instantiate } from "jsr:@polyengine/runtime@^0.6.7/embedder";
import { defaultTranslator } from "jsr:@polyengine/translator@^0.6.7";
```

```sh
npm install @polyengine/runtime@^0.6.7 @polyengine/translator@^0.6.7
```

```js
import { instantiate } from "@polyengine/runtime/embedder";
import { defaultTranslator } from "@polyengine/translator";
```

Start with [hello-world](examples/hello-world/) for a complete embedding or
[kitchen-sink](examples/kitchen-sink/) for suspending imports, resources,
and host value shapes. Both examples build a Rust guest and run a
self-checking TypeScript host.

The npm distribution is ESM-only, includes `.d.ts`, and declares Node
>= 22.14. That package floor does not imply JSPI support; blocking forms
need a suitable engine. JSR and npm expose matching subpaths, but
`dirCache()` requires Deno and the packaged translator uses platform-specific
asset loading. npm replaces Deno's permission-free wasm-module import with
a `node:fs` read.

`@polyengine/{runtime,translator,wasi,ct-runner}` release in lockstep.
`@polyengine/protocol`, the shared host-ABI vocabulary, versions
independently. JSR and npm receive cut releases only. Green `main` commits
produce `pre-<shorthash>`
[GitHub releases](https://github.com/polymorph-components/polyengine/releases)
with artifacts, not registry publications; use those assets or a git
reference to track unreleased work.

Deno's [minimum-dependency-age](https://docs.deno.com/runtime/packages/supply_chain/#minimum-dependency-age)
may delay resolution of a fresh cut. If same-day releases are needed, Deno
2.9+ supports a scope-specific exception without disabling the check for
the rest of the dependency graph:

```jsonc
// deno.json
{ "minimumDependencyAge": { "age": "P1D", "exclude": ["jsr:@polyengine/*"] } }
```

## Translating components

Execution needs the original component bytes, an instantiation plan, and
FACT adapter modules. Choose when to produce the plan and adapters:

| Method | Deployment | Use when |
|---|---|---|
| **Build-time**: [`tools/translate`](tools/translate/) emits an envelope; load it with `artifactsFromEnvelope(envelope, componentBytes)` | Component + envelope + runtime, no translator | Components are known at build time; avoids shipping and compiling the translator on clients |
| **Runtime, packaged**: `defaultTranslator()` from [`@polyengine/translator`](translator/), passed to `instantiate({ componentBytes, translator })` | Component + runtime + translator asset | Components arrive dynamically or translation belongs in the host process |
| **Runtime, explicit**: `Translator.create(bytes)` / `Translator.fromExports(ns)` from `@polyengine/runtime/shim` | Same, with a caller-managed translator | Custom asset delivery or translator-instance management |

These use the same translation pipeline, not different execution engines.
The host boundary currently interprets CABI descriptors; build-time
translation does **not** emit specialized JavaScript. The envelope records
the component's SHA-256 to reject mismatched pairs, but is itself a trusted
input, not a proof of translation correctness.

For runtime translation, [`@polyengine/runtime/cache`](runtime/src/cache/)
can reuse artifacts across loads when the translator has a `buildHash`.
The packaged Deno wasm-module loader currently lacks that hash; caching
requires a translator constructed from bytes or supplied with a known
asset hash. See [caching](docs/architecture.md#10-caching), the
[build-time recipe](tools/translate/README.md) and
[cache trust boundary](docs/security.md#the-artifact-cache-is-a-trust-input).

## Quick start

Development uses Deno, Rust, and [`just`](https://github.com/casey/just).
`just --list` lists the supported commands; recipe bodies are the command
source of truth.

```sh
git clone --recursive https://github.com/polymorph-components/polyengine
cd polyengine
just test-runtime    # builds the shim, guest fixtures, and corpus first
just conformance     # official Component Model corpus on Deno
just browsers-install && just browser-lane chromium
```

## Layout

| Path | Purpose |
|---|---|
| `crates/translator-shim` | wasmtime-environ + FACT to versioned plan format; compiled to wasm32 |
| `runtime/` | Plan executor, canonical ABI, scheduler, JSPI bridge, embedder API |
| `crates/bindgen` | WIT to typed TypeScript facades |
| `protocol/` | Shared host-ABI brands, errors, and provider conventions |
| `translator/` | Packaged translator asset and loader |
| `wasi/` | WASI providers, with filesystem, sockets, HTTP, and host stdio as opt-in fragments |
| `ct-runner/` | Runner for polymorph-test L1 conformance suites |
| `examples/` | Runnable embeddings and guest fixtures |
| `harness/`, `tools/browser/`, `tools/shell/` | Conformance corpus and cross-engine lanes |

## Documentation

| Document | Purpose |
|---|---|
| [Architecture](docs/architecture.md) | Current implementation, semantic policy, and known limitations |
| [Security](docs/security.md) | Host authority, confinement limits, and artifact trust |
| [Consumers](docs/consumers.md) | Polymorph integration conventions and consumer gates |
| [References](docs/references.md) | Spec, JSPI, dependency pins, and platform references |
| [Contracts](contracts/) | Versioned [plan format](contracts/plan-format.md), [descriptor IR](contracts/descriptor-ir.md), [intrinsics](contracts/intrinsics.md), [digest](contracts/digest.md), and [embedder API](contracts/embedder-api.md) |
| [Development protocol](AGENTS.md) | Change discipline, gates, and release process |
