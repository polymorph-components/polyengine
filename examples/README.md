# Examples and guest fixtures

## Embedder examples

Each example pairs WIT, a Rust guest, and a self-checking TypeScript host:

| Example | Focus |
| --- | --- |
| [`hello-world/`](hello-world/) | Translate, instantiate, and call one export with no imports |
| [`kitchen-sink/`](kitchen-sink/) | Values, fallible and suspending imports, resources, streams/futures, and explicit synchronous calls |

From the repository root, `just examples` builds the translator and runs both.
The scripts require Deno, Rust with `wasm32-unknown-unknown`, and `wasm-tools`.
Kitchen-sink also requires JSPI. Engine support is documented in
[architecture](../docs/architecture.md); the
[embedder contract](../contracts/embedder-api.md) defines the API.

These examples use this repository's Deno workspace to resolve packages. When
copying one elsewhere, configure `@polyengine/runtime`, `@polyengine/translator`,
and, for kitchen-sink, `@polyengine/protocol` through your own import map or
package manager. The guest source is self-contained, but the directory alone
does not supply standalone package resolution.

## Rust guest fixture corpus

[`build.sh`](build.sh) builds the fixture guests used by runtime, WASI, and
ct-runner tests. The guest WIT and Rust source are the inventory of their exact
interfaces; the following groups describe their test purpose rather than an
exhaustive exported-function list.

| Guests under `guests/` | Coverage |
| --- | --- |
| `hello`, `values`, `resources` | Value roundtrips, own/borrow handles, observable resource destruction |
| `async-probe`, `context-user`, `cancel-import` | Callback-ABI async calls, interleaving, context slots, host-import cancellation |
| `stream-echo`, `stream-pass`, `future-user`, `future-import`, `resource-stream` | Stream/future input and output, identity transfer, sync imports returning futures, resource elements, early reader drop |
| `tcp-echo`, `http-fetch` | WASI p3 socket/HTTP workloads, including detached serving tasks and streamed bodies |
| `fs-probe`, `net-probe` | WASI p2 filesystem and sockets through Rust `std::fs` / `std::net` |
| `test-suite` | ct-runner pass/fail/skip, diagnostics, and budget handling |

Not every guest is a WASI-free reactor. Most build a core module for
`wasm32-unknown-unknown`, then use `wasm-tools component new`; some explicitly
import WASI interfaces. `fs-probe` and `net-probe` instead build for
`wasm32-wasip2`, which emits a finished component without that conversion step.

From the repository root:

```sh
just fixtures
```

This requires both Rust targets and `wasm-tools`. It writes components to
`examples/guests/build/` and shared Cargo output to `examples/guests/target/`
(both gitignored). Each component is validated with its required feature set
and its WIT is printed. If `wasmtime` is on PATH, the script also smoke-tests
selected scalar/aggregate exports. That CLI smoke does not exercise the full
resource, stream, or future host API; the integration tests do.

Guest crates are separate Cargo workspaces with committed manifests and
lockfiles. Consult those for dependency pins rather than a copied tool-version
table. Bindings come from the `wit_bindgen::generate!` macro; no separate
wit-bindgen CLI is needed.

## Async producer pattern

The async Rust fixtures use wit-bindgen's callback ABI. A stream/future write
waits for the far end to read, so a guest returning a reader must not first
await its writer. The producer runs in a `spawn_local` task and the export
returns the reader immediately; see [`future-user`](guests/future-user/) and
[`stream-echo`](guests/stream-echo/). This fixture pattern is not a substitute
for the runtime's cancellation and ownership rules in the embedder contract.
