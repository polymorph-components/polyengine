# kitchen-sink — a representative tour of the embedder API

One world exercising the surfaces an embedder actually touches:

| surface | WIT | guest | host |
|---|---|---|---|
| enum / record / variant / flags | `types` interface | `describe`, `classify`, `scale`, `allowed` | §4 |
| outermost `option` → `undefined \| T` | `find` | | §5 |
| return-place `result` → resolve / throw `ComponentException` | `lookup` | | §5 |
| nested option/result as plain data + the boxing rule | `survey`, `maybe-maybe` | | §5 |
| host-implemented imports: sync, fallible, **suspending** | `notify` interface | `run-batch` | §2 |
| host-implemented resource (ctor / method / static / dispose) | `notify.channel` | `run-batch` | §3 |
| guest-implemented resource (`using`) | `api.counter` | `Counter` | §6 |
| streams: producers in, `Stream<T>` handle out | `tally`, `countdown` | §8 | §8 |
| futures: Promise in, EAGER `Future<T>` handle out | `promised-double`, `deferred-answer` | §9 | §9 |
| `sync()`: the synchronous view of a WIT-sync export | `allowed` | | §10 |

Run it:

```sh
just shim          # once, from the repo root: builds the translator
./run.sh           # builds the guest component, runs the host
```

What to notice:

- **The guest cannot tell which imports suspend.** `read-sensor` and
  `channel.send` are sync WIT functions; the host implements them with
  Promises and marks them — `suspending(fn)` (call form) and
  `@suspending` (decorator on the class method). The guest's Rust is
  oblivious; its wasm frame parks on JSPI and resumes. Marking has costs
  (a continuation hop per call, illegal from `start` functions) — see
  the §2c comment in [`host.ts`](host.ts).
- **Match errors on the brand, never the message.** `lookup`'s err side
  arrives as a thrown `ComponentException` with `.payload`; any *unbranded* throw
  from a host import is a host bug and traps the component.
- **The option rule is per-chain.** An option inside a `list` is still
  the outermost of its own chain (`undefined | T`); boxing to
  `{ kind: "some" | "none" }` happens only for option directly inside
  another option — `maybe-maybe` pins all three depths.
- **Resources are classes on both sides.** The host's `Channel` class is
  handed over as-is (the runtime calls `[Symbol.dispose]` when the guest
  drops its handle); the guest's `counter` comes back as a constructible
  class the host can `using`-scope.
- **Streams lower from natural producers and lift as handles.** Pass an
  array / ReadableStream / AsyncIterable where the guest expects a
  `stream<T>`; a guest-produced stream arrives as a `Stream<T>` handle
  whose `for await` yields *chunks* (`number[]` batches; `Uint8Array` for
  `u8`). Guest-side, every stream/future write is a rendezvous — the
  producer halves run in `spawn_local` tasks (see the guest doc comments).
- **A future-typed result is the one exception to Promise-shaped
  exports**: `deferredAnswer()` returns an eager `Future<u32>` handle
  synchronously (a Promise wrapper would adopt the thenable handle and
  make `drop`/`cancel` unreachable). Awaiting the handle yields the value.
- **`sync()` reclaims the synchronous form of a WIT-sync export**, for a
  handler that must decide before it returns (cancelable-event dispatch,
  DOM's `preventDefault()` — even an already-resolved Promise only lets its
  continuation run on a later microtask, too late once the handler has
  returned). `sync(api.allowed)` works here for real: this instantiation
  runs in JSPI mode (`read-sensor` is `suspending()`), so the call exercises
  the SYNC_ENTRY re-entry path — it succeeds because `allowed` never
  reaches the suspending import and so completes without parking. A guest
  call that DOES try to park fails loudly instead (`NeedsJspi` /
  `SyncEntryBusy` / trap) — `sync()` is for exports known to complete
  synchronously, not a way to force one that doesn't.

Deliberately absent (to stay approachable): async-typed *imports* and
`error-context` — see `contracts/embedder-api.md` until an example covers
them.

The authoritative reference is
[`contracts/embedder-api.md`](../../contracts/embedder-api.md); if this
example and the contract disagree, the contract wins (and the example's
self-checks should have caught it — run them).
