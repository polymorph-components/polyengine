# Hello World

One exported function, no imports:

| File | Role |
| --- | --- |
| [`wit/world.wit`](wit/world.wit) | `greet: func(name: string) -> string` |
| [`guest/src/lib.rs`](guest/src/lib.rs) | Rust implementation using wit-bindgen |
| [`host.ts`](host.ts) | Load the packaged translator, instantiate, call, and check the greeting |

From the repository root:

```sh
just shim
./examples/hello-world/run.sh
```

Requires Deno, Rust with `wasm32-unknown-unknown`, and `wasm-tools`. The script
builds the guest, componentizes and validates it, type-checks the host, and runs
it with read access to the example's `build/` directory. Package resolution
comes from the repository workspace; see [examples](../README.md) before
copying the directory out.

`instantiate({ componentBytes, translator }, {})` supplies the empty import
record. `await component.exports.greet(...)` uses the default asynchronous host
calling convention even though the guest function is synchronous. The runtime
copies the returned string out of guest memory and handles canonical post-return
cleanup.

Continue with [kitchen-sink](../kitchen-sink/) for imports and other value shapes.
The [embedder contract](../../contracts/embedder-api.md) is the API reference.
