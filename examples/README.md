# examples/

Two things live here, for two audiences:

## Embedder examples (start here if you're using polyengine)

Complete, self-contained, self-checking WIT + Rust-guest + TS-host pairs.
Each directory can be copied out of the repo and built as-is; each `run.sh`
builds the guest component and runs the host under Deno (`just examples`
runs both, and CI does too — these cannot silently rot).

| example | what it teaches |
|---|---|
| [`hello-world/`](hello-world/) | the smallest complete embedding: translate → instantiate → call one export; no imports |
| [`kitchen-sink/`](kitchen-sink/) | a representative tour: imports (sync / fallible / **suspending**), resources both directions, **streams and futures** (natural producers in, handles out), and the non-obvious value spellings (enum, variant, flags, outermost vs nested option/result, the option-boxing rule) |

The normative reference behind both is
[`contracts/embedder-api.md`](../contracts/embedder-api.md).

## Rust guest fixture corpus (`guests/`)

Guest components built with **wit-bindgen** (the compatibility target of this
project, docs/architecture.md §1/§11). The TS host runs these as its executable
wit-bindgen-compat claim. Each guest is a pure computational reactor — **no
WASI imports** — so componentization needs no wasip1 adapter.

## Corpus

| Component | World (WIT) | Exports | Size (release) |
|---|---|---|---|
| `hello.component.wasm` | [`guests/hello/wit/world.wit`](guests/hello/wit/world.wit) | `greet: func(name: string) -> string` | ~20 KB |
| `values.component.wasm` | [`guests/values/wit/world.wit`](guests/values/wit/world.wit) | 17 `echo-*` funcs, one per type shape: bool, u64, s64, f32, f64, char, string, record, variant, enum, flags, option, option-nested, result, list\<u8\>, list\<string\>, tuple | ~24 KB |
| `resources.component.wasm` | [`guests/resources/wit/world.wit`](guests/resources/wit/world.wit) | interface `counters`: `counter` resource (constructor, `increment`, `get`, static `merge`) + free funcs over own/borrow handles (`make-counter`, `sum-both`, `bump`, `consume`) + `live-counters` (observes destructor runs) | ~24 KB |
| `async-probe.component.wasm` | [`guests/async-probe/wit/world.wit`](guests/async-probe/wit/world.wit) | CM 0.3 async: `wait-then-double: async func` (yields once), `sum-stream: async func(stream<u32>)`, `future-add: async func(future<u32>, u32)` | ~57 KB |
| `context-user.component.wasm` | [`guests/context-user/wit/world.wit`](guests/context-user/wit/world.wit) | Context-local-storage (slot 0) via interleaved concurrent activations: `interleave: async func(count: u32) -> u32` (spawns `count` locally-concurrent tasks, each yielding a different number of times) | ~48 KB |
| `stream-echo.component.wasm` | [`guests/stream-echo/wit/world.wit`](guests/stream-echo/wit/world.wit) | `echo-doubled: async func(input: stream<u32>) -> stream<u32>` — consumes AND produces a stream in one export | ~60 KB |
| `future-user.component.wasm` | [`guests/future-user/wit/world.wit`](guests/future-user/wit/world.wit) | `double-future: async func(f: future<u32>) -> u32` (awaits an imported future); `make-future: async func(x: u32) -> future<u32>` (resolves an exported one) | ~64 KB |
| `future-import.component.wasm` | [`guests/future-import/wit/world.wit`](guests/future-import/wit/world.wit) | Host imports with future-bearing results (contracts/embedder-api.md §"Streams and futures"; the `wasi:sockets@0.3` TCP shapes reduced to `u32`): `next-value: func() -> future<u32>`, `send-sink: func(stream<u8>) -> future<u32>`, `recv-pair: func() -> tuple<stream<u8>, future<u32>>`, driven by `run-next`/`run-send`/`run-recv` exports (`run-send` writes the stream only after the sync import returns — the livelock probe) | ~64 KB |
| `resource-stream.component.wasm` | [`guests/resource-stream/wit/world.wit`](guests/resource-stream/wit/world.wit) | Streams of OWNED HOST RESOURCES (contracts/embedder-api.md §"Streams and futures"; the `wasi:sockets@0.3` TCP `listen` shape): world-level `resource ticket { value: func() -> u32 }`, `tickets: func(count: u32) -> stream<ticket>`, driven by `sum-tickets` (drains; per-element dtors) and `take-then-drop` (abandons the reader mid-stream — the un-taken-element release probe) | ~50 KB |
| `tcp-echo.component.wasm` | [`guests/tcp-echo/wit/world.wit`](guests/tcp-echo/wit/world.wit) | The REAL `wasi:sockets@0.3.0` TCP surface (wit/deps vendored verbatim from upstream): `echo-client` dials/streams/FINs/drains (the wosh client shape); `start-echo-server` binds/listens and serves connections from a detached task, returning `tuple<u16, future<u32>>` — the wasi integration gate (`tests/integration_sockets_test.ts`) drives both over live loopback sockets | ~108 KB |
| `http-fetch.component.wasm` | [`guests/http-fetch/wit/world.wit`](guests/http-fetch/wit/world.wit) | The REAL `wasi:http@0.3.0-rc` outbound surface (wit/deps/wasi-http types.wit verbatim, worlds.wit reduced): `get`/`post-echo` exports construct requests (`fields`, trailers futures), drive `client.send`, and drain streamed response bodies — the wasi package's fetch-backed integration gate (`tests/integration_http_test.ts`) | ~120 KB |
| `test-suite.component.wasm` | [`guests/test-suite/wit/tests.wit`](guests/test-suite/wit/tests.wit) (vendored verbatim from polymorph-test's `polymorph:test@0.1.0`) | Implements the `suite` world: imports `test-context`, exports `tests` (`all: async func() -> list<test-case>`). Six deterministic cases exercising pass/fail/skip, multi-message diagnostics, and a measurable-time case for budget plumbing — the ct-runner's (`../../ct-runner/`) fixture. | ~61 KB |
| `fs-probe.component.wasm` | [`guests/fs-probe/wit/world.wit`](guests/fs-probe/wit/world.wit) | The REAL `wasi:filesystem@0.2` surface via std::fs — built for **wasm32-wasip2** (wasi-libc + preview1 adapter emit a finished component; `build.sh` skips `component new` for it), so `run: func() -> result<string, string>` drives create/write/read/append/seek/list/rename/delete plus the NotFound error path through the exact linkage of a ported CLI program — the wasi package's filesystem integration gate (`tests/integration_fs_test.ts`) | ~68 KB |
| `net-probe.component.wasm` | [`guests/net-probe/wit/world.wit`](guests/net-probe/wit/world.wit) | The REAL `wasi:sockets@0.2` surface via std::net — **wasm32-wasip2** like fs-probe: `run` drives a TCP listener + client self-echo over loopback and a UDP pair (connected mode included) entirely inside the guest, through wasi-libc's poll-shaped driving (two-phase start/finish ops looping on would-block, `pollable.block`, wasi:io socket streams) — the wasi package's 0.2-sockets integration gate (`tests/integration_net_test.ts`) | ~168 KB |


Every `echo-*` function returns its input unchanged: the host asserts
roundtrip equality for arbitrary vectors (lift/lower tests). The `resources`
guest counts live instances so destructor invocation is observable from
outside (`live-counters`).

## Rebuild

```sh
./build.sh
```

Requires: Rust with the `wasm32-unknown-unknown` target, `wasm-tools` on
PATH. `wasmtime` optional (smoke run). Outputs go to `guests/build/`
(gitignored). Per guest the script runs:

1. `cargo build --release --target wasm32-unknown-unknown`
2. `wasm-tools component new <core>.wasm -o <name>.component.wasm`
3. `wasm-tools validate --features component-model[,cm-async]`
4. `wasm-tools component wit` (world round-trip sanity)

Each guest crate has an **empty `[workspace]` table** in its `Cargo.toml` (the
repo root cargo workspace does not include `examples/`), pins
`wit-bindgen = "=0.60.0"`, has a committed `Cargo.lock`, and uses a small
release profile (`opt-level = "s"`, `lto = true`, `codegen-units = 1`,
`panic = "abort"`, `strip = "debuginfo"`).

### Toolchain (validated against)

| Tool | Version |
|---|---|
| wit-bindgen (crate, proc-macro) | **0.60.0** (pinned `=0.60.0`) |
| Rust | 1.96.0 stable, target `wasm32-unknown-unknown` |
| wasm-tools CLI | 1.247.0 |
| wasmtime CLI (smoke run only) | 47.0.1 |

No extra tool installs needed: bindings come from the `wit_bindgen::generate!`
proc macro, not the wit-bindgen CLI.

## Async findings

**Status: CM 0.3 async guests build on stable Rust today; built and smoke-run
here.** Details:

- wit-bindgen 0.60.0 generates Component Model
  [async ABI](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Async.md)
  bindings on **stable** Rust (1.96). The crate's `async` cargo feature is a
  **default feature**; `generate!({ async: true })` or `async func` in WIT
  turns it on per export. No nightly, no CLI tools, no unstable rustc flags.
- WIT `async func`, `stream<T>`, `future<T>` all parse in the macro and
  round-trip through `wasm-tools component new` + `component wit` (wasm-tools
  1.247).
- Validation needs `--features component-model,cm-async` (wasm-tools names it
  `cm-async`; there are further `cm-async-stackful`/`cm-async-builtins`
  refinements, not needed for these guests). Without it, validation fails on
  `context.get` — proof the binary genuinely uses 0.3 async builtins.
- **Every async export is lifted with the stackless callback ABI**:
  `canon lift ... async (callback ...)`; core exports come in pairs
  `[async-lift]NAME` + `[callback][async-lift]NAME`. wit-bindgen's Rust
  backend never emits stackful async lifts, which matches docs/architecture.md §6's build
  order (task core + callback ABI first — JSPI paths are only needed for
  blocking sync-lowers over async, not to run these guests' exports).
- Canonical builtins used by the generated runtime: `task.return`,
  `task.cancel`, `waitable-set.{new,poll,drop}`, `waitable.join`,
  `context.{get,set}` (slot 0), and the full `stream.*`/`future.*` suites
  (new/read/write/cancel-read/cancel-write/drop-readable/drop-writable).
  Notably **no `canon yield`**: `wit_bindgen::yield_async()` is implemented
  via the callback return-code protocol, not the `yield` builtin.
- wasmtime 47.0.1 executes the async component with **default flags**
  (`wasmtime run --invoke 'wait-then-double(21)'` → `42`, including a real
  yield suspension + resume). Stream/future-typed exports can't be invoked
  from the CLI (WAVE has no stream/future literals) — they await the host
  harness.
 - Guest-side helpers available for later corpus growth: `block_on`,
   `spawn_local` (feature `async-spawn`, adds `futures`), `yield_async`,
   `backpressure_inc/dec`, stream/future writer halves (`wit_stream::new()`,
   `wit_future::new()` in generated bindings).

## Async corpus expansion: demand-side inventory

Guests were added to give the task-core/scheduler and streams phases
concrete, minimal fixtures per canonical built-in. Canonical imports per
guest (`wasm-tools print *.component.wasm | grep -oE '\[[a-z0-9_-]+\]' |
sort -u`). The common base set —  `async-lift`, `callback`,
`context.{get,set}`(slot 0), `task.{cancel,return}`,
`waitable-set.{new,poll,drop}`, `waitable.join`, and **no `canon yield`**
(`wit_bindgen::yield_async()` is implemented via the callback return-code
protocol, not the `yield` builtin) — is shared by every guest below:

| Guest | Canonical built-ins imported beyond the base set |
|---|---|
| `context-user` | None — `spawn_local`'s locally-concurrent tasks are still driven by the one export's callback-ABI event loop; no additional canonical built-ins are needed to interleave them. This means context-slot isolation across interleaved activations is entirely a **guest-side** (wit-bindgen runtime) concern from the host's point of view — the host only ever sees one `context.get`/`context.set` pair per callback invocation, exactly as for a single non-interleaved task. |
| `stream-echo` | `async-lower` and the full `stream.*` suite: `stream.new`, `stream.read`, `stream.write`, `stream.cancel-read`, `stream.cancel-write`, `stream.drop-readable`, `stream.drop-writable`. `async-lower` appears here (and in `future-user`) but not in the pure-yield guests — worth the streams phase confirming why (candidate explanation: the generated stream-forwarding task itself contains an async call shape lowered via `canon lower ... async`, from `spawn_local`'s internal task machinery, but this needs the streams-phase owner to confirm against `definitions.py`, not asserted here). |
| `future-user` | `async-lower` and the full `future.*` suite: `future.new`, `future.read`, `future.write`, `future.cancel-read`, `future.cancel-write`, `future.drop-readable`, `future.drop-writable`. |

**Stream-producer viability (wit-bindgen 0.60.0, stable Rust 1.96):**
`wit_stream::new()` (the per-world generated wrapper around
`wit_bindgen::rt::async_support::stream_support::stream_new`) is usable
directly, no extra feature flags beyond `async-spawn` (needed only for this
corpus's background-forwarding pattern — a stream/future `write` is a
rendezvous that only completes once the far end reads it, so it cannot be
awaited before the reader half is returned to the caller; the fix is to
`spawn_local` the writing loop and return the reader immediately). `stream-
echo.component.wasm` builds, validates (`component-model,cm-async`), and
round-trips its world with no divergence from the future-only guests. This
answers the task brief's open question: **producing a stream from a
wit-bindgen 0.60 Rust guest needs no unstable feature, only the
already-established `async-spawn` pattern used for `future-user`.**

All guests build with `cargo build --release --target
wasm32-unknown-unknown` on stable Rust 1.96, validate with `wasm-tools
validate --features component-model,cm-async` (wasm-tools 1.247), and
round-trip their worlds via `wasm-tools component wit`. `context-user` is
also smoke-run in `build.sh` via `wasmtime run --invoke`; `stream-echo`/
`future-user` share the CLI limitation noted above (WAVE has no
stream/future literals) and await the host harness.

## Notes for the host implementation

Shape of wit-bindgen 0.60 core modules (inspect: `wasm-tools print`):

- **String encoding is utf8** on every lift/lower
  (`string-encoding=utf8`); wit-bindgen Rust never emits utf16/latin1.
- Sync exports: `canon lift (core func $f) (memory $m) (realloc $cabi_realloc)
  string-encoding=utf8 (post-return $cabi_post_NAME)`. A `cabi_post_NAME`
  post-return is emitted **per export that returns indirect data** (e.g.
  `greet`, the string/list echoes); the host must call it after copying
  results out.
- Core module exports: the lifted funcs, `memory`, `cabi_realloc`, plus a
  versioned `cabi_realloc_wit_bindgen_0_60_0` alias; `__data_end`/
  `__heap_base` globals are exported too (ignorable).
- Sync guests (hello/values/resources) have **zero core imports**. The async
  guest imports only canonical intrinsics under module names `$root` /
  `[export]$root` (e.g. `[waitable-set-new]`, `[task-return]NAME`), which
  `wasm-tools component new` wires to canon builtins — still no WASI, no
  adapter.
- Resources: dtors are plain core funcs; dropping an own handle inside the
  guest (e.g. `consume`, `merge`) runs the dtor synchronously. Use
  `live-counters` to assert dtor runs from the host side.
- The wit-bindgen version and world are embedded in a custom section
  (`component-type:wit-bindgen:0.60.0:...:encoded world`) of the core module;
  `wasm-tools component new` consumes it (metadata produced with wasm-tools
  0.254 internals decodes fine with the 1.247 CLI).

### wasmtime CLI invocation notes

`wasmtime run --invoke '<wave-expr>' <component>` works for all scalar/
aggregate types (WAVE syntax: `some("x")`, `err("bad")`, `{read, exec}`,
`(9, "nine", 9.25)`, `label("hi")`). Limitations found: functions returning
**resource handles** trap the CLI's result printer (wasm-wave "unsupported
value type"), and stream/future arguments aren't constructible — both are
host-harness territory, not corpus defects.
