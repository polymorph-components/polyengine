# Kitchen Sink

A WIT world, Rust guest, and self-checking host covering the main embedder
conventions. [`host.ts`](host.ts) numbers the demonstrations:

| Surface | WIT or guest entry | Host section |
| --- | --- | --- |
| Enum, record, variant, flags | `describe`, `classify`, `scale`, `allowed` | 4 |
| Options, fallible returns, nested results, option boxing | `find`, `lookup`, `survey`, `maybe-maybe` | 5 |
| Sync, fallible, and suspending imports | `notify`; driven by `run-batch` | 2, 7 |
| Host resource class and disposal | `notify.channel` | 3 |
| Guest resource class with `using` | `api.counter` | 6 |
| Stream producers and chunked reads | `tally`, `countdown` | 8 |
| Promise input and eager future handle output | `promised-double`, `deferred-answer` | 9 |
| Explicit synchronous export view | `allowed` via `sync()` | 10 |

From the repository root:

```sh
just shim
./examples/kitchen-sink/run.sh
```

Requires Deno with JSPI, Rust with `wasm32-unknown-unknown`, and `wasm-tools`.
The script builds and validates the guest, type-checks the host, and runs its
assertions. Package resolution comes from the repository workspace; see
[examples](../README.md) for use outside this checkout.

## Details worth following

- `read-sensor` and `channel.send` are WIT-sync functions implemented with
  Promises. `suspending(fn)` and the `@suspending` decorator come from
  `@polyengine/protocol`; their marks select JSPI for this instantiation.
  Suspending imports cannot be reached during core start-function execution.
- A return-position WIT `result` maps to a returned success value or a branded
  `ComponentException` carrying `.payload`. Unbranded host exceptions trap; do
  not classify errors by message text.
- An option nested directly inside another option needs boxing. An option
  inside a list starts its own chain and still uses `undefined | T`.
  `maybe-maybe` demonstrates the distinction.
- Host resources are supplied as classes, with `[Symbol.dispose]` called when
  the guest drops the owned handle. Guest resources arrive as classes whose
  instances can be scoped with `using`.
- Stream inputs accept natural producers. Lifted `Stream<T>` iteration yields
  chunks, not individual elements (`Uint8Array` for `u8`). Guest producers run
  in background tasks so they can return a reader before waiting on writes.
- A direct `future<T>` result returns its handle eagerly, not wrapped in a
  Promise: Promise resolution would adopt the thenable and hide its lifecycle
  methods. Await the handle to obtain the value.
- `sync(api.allowed)` gives a synchronous view of a WIT-sync export that does
  not park. The example uses it for a cancelable-event-style handler that
  cannot await. It does not force a suspending call to complete synchronously;
  see the contract for admission and failure conditions.

Async-typed imports and error-contexts are not demonstrated here. Consult the
[embedder contract](../../contracts/embedder-api.md) for those surfaces and the
complete ownership, cancellation, and error rules.
