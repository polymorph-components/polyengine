# polyengine

A WebAssembly **Component Model host** for JavaScript engines — async-native
(Component Model 0.3 concurrency), built on wasmtime's translation frontend
compiled to wasm, running on Deno and in browsers.

Instead of ahead-of-time transpilation, polyengine is a **runtime linker**: it
takes a `.wasm` component binary, translates it in-process (wasmtime-environ +
FACT fused adapters, running as a wasm32 module), and executes the
instantiation plan on the stock `WebAssembly` JS API. Cross-component calls
stay pure wasm; the 0.3 task model (tasks, streams, futures, backpressure,
cancellation) is the runtime's core structure, mapped onto the JS event loop —
the callback ABI needs no JSPI at all, and the stackful/blocking forms light
up via JSPI where the engine provides it.

## Status

Pre-1.0, but densely gated:

- **Official Component Model test suite**: 1250 passing / 0 failing commands
  across all directories (remaining: named xfail classes — wasmparser pin
  drift, 🧵-deferred, small gaps), identical on Deno, Chromium, and Firefox
  (behind its JSPI pref); WebKit reaches the same totals on trunk builds
  (the pinned build lacks JSC multi-memory, since implemented upstream).
- **Real-workload proof points** (the [polymorph] component family):
  the iroh endpoint component — detached pump tasks, multi-export
  concurrency, cross-task wakeups; the workload that deadlocks jco's
  scheduler — runs its relay-echo and WebRTC-upgrade paths end-to-end;
  polymorph-websocket's conformance suite passes 55/55 under this host;
  an 8 MB componentize-go engine instantiates and runs.
- Guest toolchains exercised: wit-bindgen (Rust) and componentize-go,
  sync and async.

## Layout

| Path | What |
|---|---|
| `crates/translator-shim` | wasmtime-environ + FACT → versioned plan format (wasm32, runs everywhere) |
| `runtime/` | TS core: plan executor, canonical ABI, 0.3 task scheduler, JSPI bridge, embedder API (`runtime/src/embedder`) |
| `crates/bindgen` | WIT → TypeScript types for the embedder conventions |
| `examples/` | **start here to embed**: hello-world + kitchen-sink (WIT + Rust guest + TS host, self-checking), plus the guest fixture corpus |
| `translator/` | `@polyengine/translator`: the packaged translator asset + `defaultTranslator()` per-platform loader (build-time alternative: `tools/translate`) |
| `wasi/` | minimal WASI providers (p2 baseline + p3 clocks), one per semver track |
| `ct-runner/` | conformance-suite runner for the polymorph-test L1 contract |
| `harness/` + `tools/browser` | official-suite harness; Deno lane + Chromium/Firefox/WebKit lanes |
| `contracts/` | the versioned interface contracts (plan format, embedder API, intrinsics, digest) |

## Quick start

```sh
git clone --recursive https://github.com/polymorph-components/polyengine
cd polyengine
just test-runtime    # runtime suite (builds the shim + fixtures + corpus first)
just conformance     # official CM suite on Deno
just browsers-install && just browser-lane chromium   # same corpus, real browser
```

Deno workspace (TS) + cargo workspace (Rust); [`just`](https://github.com/casey/just)
is the command surface (`just --list`; recipe bodies are the exact commands).

## Translating components

Running a component takes a translation (an execution plan + FACT adapter
modules). Three ways to get one:

| method | production ships | choose when |
|---|---|---|
| **build-time** — [`tools/translate`](tools/translate/) emits a single-file *envelope*; the host reconstitutes it with `artifactsFromEnvelope(envelope, componentBytes)` | component + envelope + runtime — **no translator** | you know your components at build time (most apps; the browser default — saves ~0.5 MB gzip and a compile per visitor). The envelope embeds the component's sha-256, so a stale pair fails loudly at instantiation |
| **runtime, packaged** — `defaultTranslator()` from [`@polyengine/translator`](translator/), passed to `instantiate({ componentBytes, translator })` | your host + the translator asset (~1.85 MB raw, 520 KB gzip) | components arrive dynamically (plugin systems), or dev/server contexts where the asset size is irrelevant. Pair with the artifact cache (`@polyengine/runtime/cache`) so each component translates once per client, not once per load |
| **runtime, explicit** — `Translator.create(bytes)` / `Translator.fromExports(ns)` from `@polyengine/runtime/shim` | same, minus the packaged loader | you source the translator wasm yourself: custom delivery, one shared instance across many components, or cache keying via `buildHash` |

Translation itself is sub-millisecond warm in all three; the methods differ
only in *when* it runs and *what you deploy*. Worked code: the
[examples](examples/) use the packaged form, [`tools/translate`'s
README](tools/translate/README.md) shows the build-time deploy recipe, and
the full decision record is the design note on
[#16](https://github.com/polymorph-components/polyengine/issues/16).

## Consuming

Everything here is **unstable** (0.x, [#16](https://github.com/polymorph-components/polyengine/issues/16)):
no compatibility promise across minor lines. But releases are
**caret-honest**: within a minor line they stay backward-compatible, and
anything breaking bumps the minor — so caret constraints are the intended
way to consume:

```ts
import { instantiate } from "jsr:@polyengine/runtime@^0.4.0/embedder";
import { defaultTranslator } from "jsr:@polyengine/translator@^0.4.0";
```

The same five packages ship to **npm** under the same names, built from the
same sources at the same version by the same release:

```sh
npm install @polyengine/runtime @polyengine/translator
```

```js
import { instantiate } from "@polyengine/runtime/embedder";
import { defaultTranslator } from "@polyengine/translator";
```

The npm distribution is ESM-only (Node >= 22.14) and carries `.d.ts`; entry
points match the JSR subpaths one for one, so the import specifier is the only
line that differs between registries. Two things are JSR-only, both by
necessity rather than policy: `dirCache()` (the `Deno.*` filesystem cache
backend — use `webCache()` or your own `ArtifactCache`), and the translator's
permission-free Deno wasm-module load, which the npm build replaces with a
`node:fs` read of the same packaged asset.

`@polyengine/{runtime,translator,wasi,ct-runner}` release in lockstep — one
version, cut from one green commit, matching the `vX.Y.Z`
[GitHub release](https://github.com/polymorph-components/polyengine/releases) that carries the
same commit's artifacts. (`@polyengine/protocol` versions independently; the
others depend on it by caret.)

This project was previously named **deltic** and published under the
`@deltic` JSR scope, which stops at `0.2.1`. The rename is a clean break,
not an alias: `@polyengine/*` starts a fresh `0.1.0` line, the
`Symbol.for("polyengine.*/1")` cross-copy brands do not match the old
`deltic.*` ones, and the `POLYENGINE_*` environment variables replace their
`DELTIC_*` spellings. Nothing bridges the two — port in one step.

Between releases, every green `main` commit still publishes
`<next>-pre.g<shorthash>` prereleases to JSR — the same short hash as the
corresponding `pre-<shorthash>` GitHub release, so a version names an
exact commit. Hash versions are not ordered, and semver ranges never
resolve to prereleases: **pin prereleases exactly and bump deliberately**.
The same prereleases go to npm under the `pre` dist-tag, leaving `latest`
to track cut releases. (One wrinkle, self-correcting: npm pins `latest` to
a package's first-ever publish whatever `--tag` says, so until the first
release is cut `latest` names the bootstrap prerelease. Pin explicitly
until then.)

Deno's [minimum-dependency-age](https://docs.deno.com/runtime/packages/supply_chain/#minimum-dependency-age)
gate (24 h by default) applies to releases and prereleases alike, so a
fresh publish won't resolve on day zero. To consume same-day publishes
while keeping the gate for the rest of your graph, exempt the scope
(wildcard excludes work as of Deno 2.9):

```jsonc
// deno.json
{ "minimumDependencyAge": { "age": "P1D", "exclude": ["jsr:@polyengine/*"] } }
```

(or `--minimum-dependency-age=0` for a one-off run).

## Documentation

| Where | What |
|---|---|
| [`examples/`](examples/) | runnable embedder examples: [hello-world](examples/hello-world/) (smallest complete embedding) and [kitchen-sink](examples/kitchen-sink/) (imports incl. suspending, resources both directions, value-shape tour) |
| [`docs/architecture.md`](docs/architecture.md) | the system design and decisions, with rationale (§-numbered; cited from code comments) |
| [`docs/security.md`](docs/security.md) | what the WASI filesystem/network confinement does and does not guarantee — **read before granting a guest host access** |
| [`docs/milestones.md`](docs/milestones.md) | the verified milestone record (S0 → C3) |
| [`docs/consumers.md`](docs/consumers.md) | the polymorph adoption track: jco blocker mapping, cutover evidence, in-repo ports |
| [`docs/references.md`](docs/references.md) | canonical upstream links (spec, JSPI, wasmtime internals, toolchain pins) |
| [`contracts/`](contracts/) | versioned interface contracts — [plan format](contracts/plan-format.md), [descriptor IR](contracts/descriptor-ir.md), [intrinsics](contracts/intrinsics.md), [digest](contracts/digest.md), [embedder API](contracts/embedder-api.md) |
| [`AGENTS.md`](AGENTS.md) | development protocol and the full gate list |
| [issue tracker](https://github.com/polymorph-components/polyengine/issues) | open and deferred work |

[polymorph]: https://github.com/polymorph-components

---

<sub><i>125% more engine!</i></sub>
