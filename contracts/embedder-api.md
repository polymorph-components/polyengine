# Embedder API conventions (host-facing)

The normative contract for host-facing value shapes and behavior. The runtime's
raw executor boundary (`instance.handle.exports`, `HostImports`) keeps the
`definitions.py` interpreter shapes as an internal surface with no stability
promise. This document specifies the runtime facade; bindgen emits types and
typed wrappers for it. Public `instance.exports` is facade-shaped.

- [Principles](#principles)
- [Naming and casing](#naming-and-casing)
- [Version canonicalization](#version-canonicalization)
- [Value mapping](#value-mapping-normative)
- [Error model](#error-model)
- [Functions and async](#functions-and-async)
- [Resources](#resources)
- [Streams and futures](#streams-and-futures)
- [Module wiring and instantiation](#module-wiring-and-instantiation)
- [Module identity and @polyengine/protocol](#module-identity-and-polyengineprotocol)
- [Realm boundaries and structured-clone-safe forms](#realm-boundaries-and-structured-clone-safe-forms)
- [The host-ABI surface and its version](#the-host-abi-surface-and-its-version)
- [Implementation strategy](#implementation-strategy)
- [The WASI parking kernel](#the-wasi-parking-kernel)

Authorities: the Component Model [Explainer] and `definitions.py` (tie-breaker),
the draft JS-API (component-model PR #686), and wasmtime as corroborating
evidence. Issue numbers (`#N`) name the polyengine tracker entry where a rule
was decided.

[Explainer]: https://github.com/WebAssembly/component-model/blob/main/design/mvp/Explainer.md

## Principles

1. **Explicit TypeScript shapes.** Data has one canonical representation;
   invalid host values are rejected before crossing the boundary.
2. **Separate results from faults.** WIT error results use `ComponentException`;
   traps and producer failures are not error values.
3. **Explicit ownership.** Handle transfers, borrows, cancellation, and disposal
   have defined lifetimes and failure behavior.
4. **Async-first exports.** Exports are Promise-shaped, with the exceptions and
   synchronous adapter described below. Imports follow their WIT type.
5. **No jco compatibility layer.** Conventions serve the Component Model and JS
   hosts; WASI providers and consumer suites exercise them.

## Naming and casing

| WIT construct                                                                             | JS/TS                                                                                  |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| function, method, static, record field, flag, parameter (docs only; calls are positional) | camelCase (`get-resolution` → `getResolution`)                                         |
| resource                                                                                  | PascalCase class (`tcp-socket` → `TcpSocket`)                                          |
| enum value, variant/result case name (the `kind` value)                                   | kebab-case **verbatim** string literal — data, not an identifier                       |
| interface key in the imports/exports record                                               | fully-qualified WIT id verbatim, version included: `wasi:clocks/monotonic-clock@0.3.0` |
| world-level (bare) import/export                                                          | camelCase at the record's top level                                                    |

## Version canonicalization

A version's **track key** follows `canonversion` (Explainer §"Canonical
interface names"; wasmtime `alternate_lookup_key`): `@1` for `1.2.3`, `@0.2` for
`0.2.6`, none for `0.0.x` and prereleases.

**Resolution** (normative for `instantiate` and the wasi package): an import
name matches (1) an exact provided key, else (2) the provider holding its track,
where a track is held by the **highest-versioned** key registered on it
(wasmtime's linker rule). This selects the provider; the component's declared
types drive leaf lookup and value conversion. It does not inspect a JS
implementation's TypeScript signature.

**Registration**: providers register full-versioned keys (the track alternate is
derived) or the **track key itself** (`…@0.2`) as an explicitly canonical
provider; registering both on one track is refused. Unversioned ids are legal
exact-match keys but never serve a versioned import, nor vice versa. _Folding_ —
an unversioned key as a cross-track wildcard — is banned; helpers may expand a
wildcard over interface _names_ within one track only.

Divergent drafts sharing a track (two `@0.3.0` snapshots with different function
sets) are served by one **union** provider; per-leaf structural resolution
selects what each component imports.

## Value mapping (normative)

| Component type                                            | TS                                                      |                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `bool`                                                    | `boolean`                                               |                                                                                                                  |
| `u8 s8 u16 s16 u32 s32 f32 f64`                           | `number`                                                | range-checked at lower                                                                                           |
| `u64 s64`                                                 | `bigint`                                                | range-checked at lower                                                                                           |
| `char`                                                    | `string` (one code point)                               | validated at lower                                                                                               |
| `string`                                                  | `string`                                                | lower applies USVString replacement (docs/architecture.md §7)                                                    |
| `list<u8>`                                                | `Uint8Array`                                            | always a copy, never a view of guest memory                                                                      |
| `list<T>`, T ≠ u8                                         | `T[]`                                                   | no typed-array widening                                                                                          |
| `tuple<A, B, …>`                                          | `[A, B, …]`                                             |                                                                                                                  |
| `record`                                                  | plain object, camelCase fields                          | option-typed fields are optional properties: lift emits **absent** for none; lower accepts absent or `undefined` |
| `enum`                                                    | union of kebab-case string literals                     |                                                                                                                  |
| `variant`                                                 | `{ kind: "case" } \| { kind: "case", value: T }`        | `value` **absent** for payloadless cases                                                                         |
| `option<T>`                                               | `T \| undefined`; nested options box                    | see below                                                                                                        |
| `result<T, E>` as a value (nested, or parameter position) | `{ kind: "ok", value: T } \| { kind: "err", value: E }` | `value` absent for empty sides                                                                                   |
| `result<T, E>` as a function result                       | return `T` / throw `ComponentException<E>`              | empty sides: `undefined` / `payload === undefined`                                                               |
| `map<K, V>`                                               | `[K, V][]` (its despecialization)                       |                                                                                                                  |
| `flags`                                                   | object of camelCase booleans                            | lift: every flag present; lower: absent = `false`                                                                |
| `own<R>`, `borrow<R>`                                     | the resource class instance                             | [Resources](#resources)                                                                                          |
| `stream<T>`, `future<T>`, `error-context`                 | `Stream<T>`, `Future<T>`, `ErrorContext`                | [Streams and futures](#streams-and-futures)                                                                      |

The discriminant is `kind` and the payload is `value`. This supports exhaustive
`switch (v.kind)` checks and keeps case names as data rather than property
names.

**Option rule.** The outermost option maps to `T | undefined`; an option
_directly inside_ another option uses the variant family, so boxing is exactly
as deep as the ambiguity. `option<option<u32>>`:

```ts
undefined                    // none
{ kind: "none" }             // some(none)
{ kind: "some", value: 7 }   // some(some(7))
```

**Example.** `result<tuple<own<counter>, own<counter>>, error>` as a function
result resolves to `[Counter, Counter]` (ownership transferred) or rejects with
a `ComponentException` whose `payload` is the `error` value
(`{ kind: "timed-out" }`); nested in a `list`, each element is
`{ kind: "ok", value: [Counter, Counter] } | { kind: "err", value: … }`.

## Error model

```ts
class ComponentException<E = unknown> extends Error {
  readonly payload: E;              // the WIT err value, per the table
  constructor(payload: E, message?: string);
}
class Trap extends Error { … }      // component-fatal; never a value
class PeerTrappedError extends Error {  // a stream/future op whose peer instance trapped
  readonly cause: unknown;          // chains to the Trap
  readonly progress?: number;       // writes: elements delivered before the fault
}
```

- A guest export with `result<T, E>` resolves `T` and rejects (throws, on sync
  paths) `ComponentException<E>`. `Trap` rejections are distinguishable by
  class.
- A host import with `result<T, E>` returns `T` and throws
  `new ComponentException(payload)` for err.
- **An unbranded throw from a host import is a host bug and traps**, with a
  message naming the import — never a guest-visible err. Only
  `ComponentException` crosses as an err value, so host modules need no
  defensive wrappers. (Deliberate divergence from the draft, which converts any
  thrown value to `E`.)
- A trap escaping a guest activation poisons its instance under the runtime's
  policy (docs/architecture.md §6). Catching its host-side rejection does not
  restore that instance.
- **`Trap.message` is diagnostic, not API.** Match the brand, never text. Raw
  core traps carry the engine's own wording behind a `guest trapped:` prefix,
  unnormalized across engines (the conformance harness reconciles wording:
  `TRAP_MESSAGE_EQUIVALENTS`, harness/src/runner.ts). Runtime-authored traps
  have stable wording; the same rule applies.
- Results nested in values never throw; they are `{ kind, value }` data.
- **Recognition is by brand, not class.** Each class carries a process-global
  brand symbol read by the runtime's checks. Same-copy `instanceof` works;
  `@polyengine/protocol` exports the predicates (`isComponentException`,
  `isTrap`, `isPeerTrappedError`, …) as the multi-copy-robust form
  ([Module identity](#module-identity-and-polyengineprotocol)).

## Functions and async

**Exports are uniformly Promise-shaped**: bindgen types every export as
returning `Promise<T>`, sync-typed or not (docs/architecture.md §1). Exactly two
exceptions: resource constructors (synchronous) and `future<T>`-typed results
(eager handles). A synchronous view exists as the per-use adapter `sync()`. WIT
getter/setter support is not implemented.

**Imports match their WIT type**: an `async func` import may be an async JS
function or return synchronously; a sync `func` import returns `T`
synchronously. Params are positional (names are excluded from the world digest,
contracts/digest.md). Interface members are invoked with their containing object
as receiver, so a class instance is a valid interface provider; world-level bare
imports are called unbound.

**Between-calls liveness:** a settlement pump services host imports even without
an in-flight export call. Work waiting on the embedder's half of a stream/future
remains pending until the embedder acts. Background faults are recorded for
pending operations and subsequent entry.

**Idle async calls remain pending.** A long-poll export may need a later export
call or host operation to make progress. Its Promise resolves when the task
returns its value, not when all producer threads exit; poisoning first rejects
it with the recorded cause. An async task that can never progress therefore
remains pending rather than trapping. Sync-typed exports retain the reference's
deadlock trap. The conformance harness separately opts into trap-on-idle
behavior for its blocking `invoke` directive.

### Import marks

Three marks, each a `Symbol.for` brand defined in and imported from
`@polyengine/protocol`, each with two spellings — the direct call
(`f: suspending(fn)`, the only form in record literals) and a stage-3 method
decorator (`@suspending` on instance or static methods, refusing non-method
positions and the legacy `experimentalDecorators` convention at class-definition
time). Constructors are never markable. On host-resource classes the
**prototype** is the per-declaration authority for instance methods (read at
wrap time; instance-level overrides change the body, never the mark); statics
carry the mark on the function. Marks are independent and may combine.

| mark              | effect                                                                   |
| ----------------- | ------------------------------------------------------------------------ |
| `suspending(fn)`  | a sync-typed import may return a Promise, parking the calling wasm frame |
| `deferCancel(fn)` | guest cancellation never discards the import's result                    |
| `abortable(fn)`   | the import receives a per-call `AbortSignal`, aborted on discard         |

**`suspending()`**: only marked imports are handed to wasm as
`WebAssembly.Suspending`, so unmarked imports keep the plain convention and
sync-only components their zero-cost pin. A marked import selects jspi mode
without `jspi: true` (`jspi: false` still forces plain, where a returned Promise
is refused). Costs are visible: every call through a marked import pays the
engine's continuation hop even when it returns synchronously
(`runtime/tests/jspi/fastpath_hop_test.ts`); a marked import reached from a
`start` function traps, even on a synchronous return; on a non-JSPI engine a
returned Promise is refused at the call site (`NeedsJspi`), never degraded. The
park is a plain sync-lower wait (`canon_lower`, `definitions.py`).

**Cancellation and discard** (#241). A guest may cancel an in-flight async-typed
import. A JS function has no cancellation channel, so the runtime answers on its
behalf, choosing the prompt-cancel host response
(`on_cancel = () => on_resolve(None)`): the subtask resolves
`CANCELLED_BEFORE_RETURNED` immediately, both cancel forms return without
blocking, and the settlement is **discarded** — never lowered, never reported,
no longer guest-wakeable for deadlock detection. The host operation is not
interrupted; discard is about delivery, not execution.

- **`deferCancel()`** opts out: cancellation is accepted and ignored, the async
  cancel form answers `BLOCKED`, the sync form parks under jspi (`NeedsJspi`
  without it), and the guest observes `RETURNED` with the real result. For
  imports with a commit point (a flush, a write). Inert on sync-typed imports,
  which mint no subtask handle.
- **`abortable()`** appends a fresh `AbortSignal` after the WIT parameters
  (`dial: abortable((addr, signal) => fetch(url, { signal }))`); the signature
  changes unconditionally, the abort fires only on discard by guest cancellation
  — on a microtask after the cancel built-in returns (host listeners never run
  inside a guest activation), so the guest sees `CANCELLED_BEFORE_RETURNED`
  first. Settlements the abort provokes are discarded like any late settlement.
  Inert wherever discard cannot happen (sync-typed, `deferCancel`, eager
  resolution). Instance teardown does not abort in-flight calls.

### `sync()`

Some host contexts cannot receive a Promise however promptly it resolves (event
handlers deciding `preventDefault()`, comparators, `Proxy` traps, accessors:
even a resolved Promise defers by a microtask). For a WIT-sync export whose
guest completes synchronously, `sync()` asks for the result synchronously. It is
an adapter applied per use, never a mode.

`sync()` and `Sync<F>` are exported from `@polyengine/runtime/embedder` —
application machinery, like `createStream`: only an instantiating application
holds export functions. A host module wanting a synchronous guest callback is
_handed_ `sync(exports.f)` by the application and MUST NOT import the runtime
([host-ABI surface](#the-host-abi-surface-and-its-version)). Recognition is by
brand (`polyengine.syncCallable/1`), so views work across runtime copies.
Dispatch by target:

- `sync(fn)` on a lifted export function (plain, interface member, resource
  static) → `(...args) => T`.
- `sync(instance)` on a guest-resource wrapper → a view whose members call the
  synchronous forms with `instance` as receiver. `sync(method)` on a bare
  prototype method throws `TypeError` naming this spelling.
- `sync(cls)` on a guest-resource class → a view of synchronous statics (`new`
  the class itself; constructors are already synchronous).
- `sync(record)` on an exports or interface record → a view mapping every member
  recursively; unbranded members pass through.
- Views are stable (repeated `sync(x)` returns the same object).
- `sync()` on an async-typed export, or on anything unbranded, throws
  `TypeError` at adapter time.

**Call semantics.** A synchronous `canon_lift` through a plain (non-`promising`)
entry. `result<T, E>` throws `ComponentException<E>` synchronously;
handle-valued results return handles.

**Failure ladder** (ordered; 1–3 are non-poisoning):

1. Poisoned-instance refusal is shared with the Promise surface and occurs
   before entering. Reentrance into a live instance is allowed.
2. _Hop-window contention_ (jspi mode only): a `promising` entry settles through
   a microtask hop, and the hop-quiescence gate defers Promise-surface calls
   that would race a pending lift. A synchronous call cannot defer, so it
   refuses: `SyncEntryBusy` (`e.name === "SyncEntryBusy"`), transient — retry or
   use the Promise surface. The constructor entry shares this refusal.
3. A blocking built-in through the plain entry: `NeedsJspi`.
4. Genuine suspension — a `Suspending`-wrapped import reached from the unwrapped
   frame — fails as a trap and poisons the entered instances. A component with
   no `suspending()` imports and no async built-ins never reaches this arm.

**Cost.** In plain mode, `sync()` skips the Promise facade. In JSPI mode,
sync-typed exports have a plain entry (`SYNC_ENTRY`) as well as the normal
entry. That plain entry cannot cross a `Suspending` import, even if the import
would return immediately; the failure ladder above applies.

## Resources

**A resource is a class instance on both sides.** Identity mapping and name
mangling are runtime obligations: no bare reps, no identity tables, no
hand-transcribed `[method]…` keys.

**Guest-implemented** (host holds handles): the runtime builds a class per
resource, with declarations supplied by bindgen. Its constructor calls the guest
constructor; camelCase methods and statics; `[Symbol.dispose]()` and `drop()`
drop the handle (TS `using` works); a `FinalizationRegistry` backstop drops
leaks (docs/architecture.md §7).

**Host-implemented** (guest holds handles): the host supplies a class
implementing the bindgen interface (camelCase methods, statics as static
members, the WIT constructor as the JS constructor). The runtime owns the
instance↔rep mapping; when the guest drops its last own handle the runtime calls
`instance[Symbol.dispose]?.()`. Method `self` is the instance.

Overlapping host-originated borrows retain the mapping until the last borrowing
call ends. A guest drop during that interval defers disposal until the final
borrow ends; the pending-drop instance cannot be passed as own again. A deferred
disposal error is reported by the last borrowing call, after all its borrow
mappings are released. An existing call failure remains primary; results that
cannot be delivered because cleanup failed are released rather than abandoned.

**Constructors are synchronous** (a JS constructor cannot await). A guest
constructor that does not complete synchronously raises a named error rather
than half-constructing; its plain entry is one instance of `SYNC_ENTRY` and
shares its failure ladder. A generated async static factory is the escape hatch,
deferred until demanded.

| WIT position              | guest-implemented R                           | host-implemented R                                                   |
| ------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| host receives `own<R>`    | new instance; host owns it (drop/`using`)     | the host's own instance; the guest's handle is gone; no dispose call |
| host receives `borrow<R>` | valid only during the call (retention throws) | the host's own instance; scoping is guest-side bookkeeping           |
| host passes `own<R>`      | wrapper invalidated (transferred)             | instance registered; guest owns the handle                           |
| host passes `borrow<R>`   | wrapper stays valid                           | an unregistered instance gets a rep for the call's duration          |

### Pattern (non-normative): binding platform classes directly

When a WIT resource's shape matches a native class, pass the class itself (the
draft JS-API's import story, PR #686; #115):

```ts
const instance = await instantiate(artifacts, {
  "test:platform/web": { params: URLSearchParams, decoder: TextDecoder },
});
```

Dispatch is a per-call `self[camelCase(member)]` lookup, constructor args flow
to `new Class(...)`, and the value conventions are the natural JS shapes
(`Uint8Array` is a `BufferSource`; a record is an options bag). Named types in
the interface need no imports entry. Limits, each with a one-line
`class X extends Native` bridge (executable reference:
runtime/tests/embedder/platform_class_test.ts):

1. **Accessor-backed properties are not methods**: `size: func() -> u32` against
   `URLSearchParams.prototype.size` traps per call ("no method 'size'"). The
   wrap-time mark probe reads data properties only, so binding is safe and a
   mark cannot ride an accessor. Bridge: a method delegating to the property.
2. **Platform absent is `null`; WIT none is `undefined`**: a `null` where
   `option<T>` is expected takes the `some` branch and fails conversion
   (`TypeError` naming the import, not a trap). Bridge: `?? undefined`.
3. **Platform exceptions are unbranded, so they trap**, even from a
   `result`-typed import. Bridge: catch and rethrow
   `new ComponentException(payload)`.

### Getters and setters (pre-ruling — not yet implementable)

Getter/setter forms from component-model#701 are not implemented in the facade
([#254](https://github.com/polymorph-components/polyengine/issues/254)). The
intended mapping below is a design decision, not a supported API. Forms include
`[get]foo`/`[set]foo`, instance members such as `[method][get]r.foo`, and static
members such as `[static][set]r.foo`.

- **Planned exports: real JS accessors, sync-required.** Bindgen would emit
  `get prop(): T` / `set prop(v)` on resource classes, as static accessors, or
  on the exports record. They ride `SYNC_ENTRY` and its failure ladder (a JS
  setter cannot express async completion; symmetric semantics are ruled). A
  fallible setter throws `ComponentException` synchronously. Divergent types map
  to asymmetric accessor types. Where both accessor and `get-prop` method
  spellings collide, the accessor wins and the method is dropped with a bindgen
  warning.
- **Planned imports: property get and assignment on the receiver.** `[get]foo`
  reads `self[camelCase(foo)]` (or the interface object); `[set]foo` assigns.
  This retires platform-class limit 1 for worlds that declare accessors.
  Accessors are never `suspending()`-markable; a host getter returning a Promise
  is refused as any unmarked sync import.
- **Current behavior:** unknown bracket forms are refused at facade
  instantiation, rather than bound as ordinary function names.

## Streams and futures

Handles, not raw shared objects:

```ts
interface Stream<T> {
  readable(): ReadableStream<Chunk<T>>;    // Chunk<u8> = Uint8Array, else T[]
  [Symbol.asyncIterator](): AsyncIterator<Chunk<T>>;
  read(max: number): Promise<Chunk<T>>;    // empty chunk = end
  readDirect(consume: (src: DirectSource) => "more" | "done"): Promise<number>;  // stream<u8> only
  cancelRead(): void;
  drop(): void;                            // [Symbol.dispose] alias
}
interface Future<T> extends PromiseLike<T> { drop(): void; cancel(): void; }
interface StreamWriter<T> {
  write(chunk: Chunk<T>): Promise<number>; writeAll(chunk: Chunk<T>): Promise<number>;
  writeDirect(produce: (dest: DirectDestination) => "more" | "done"): Promise<number>;  // stream<u8> only
  cancelWrite(): void; close(): Promise<void>;
}
interface DirectDestination { remaining(): Uint8Array; markWritten(n: number): void; }
interface DirectSource      { remaining(): Uint8Array; markRead(n: number): void; }
class ErrorContext { readonly message: string }
class DroppedError extends Error { … }    // awaiting a dropped future rejects with this
function createStream<T>(): { stream: Stream<T>, writer: StreamWriter<T> };  // @polyengine/runtime/embedder
```

The interfaces, `Chunk<T>`, `StreamSource<T>`/`FutureSource<T>`, and the
predicates `isStream`/`isStreamWriter`/`isFuture`/`isErrorContext` are exported
from `@polyengine/protocol`; the runtime's concrete classes implement them and
are not exported.

**Lifting.** `stream<T>`/`future<T>` arrive as `Stream<T>`/`Future<T>`. An
export whose result is `future<T>` returns `Future<T>` **directly**, not
`Promise<Future<T>>`: promise resolution adopts thenables, so a Promise cannot
resolve _to_ a PromiseLike handle. `await exportFn()` yields `T`; call without
awaiting to hold the handle. Awaiting a future whose write end dropped without a
value rejects `DroppedError`.

**Disposal is total and silent** (#182). `drop()`/`cancel()` never throw, never
return a promise, and never surface a failure of the producing call. A future
from an export call is _deferred_ (its host end materializes when the call
completes), so a held handle may outlive a failing producer; disposal discards
the failure, which still surfaces to anyone awaiting. The runtime attaches
rejection handling at the handle so no disposal or abandonment raises an
unhandled rejection.

**Lowering accepts natural JS producers**: for `stream<T>` a `ReadableStream`,
`AsyncIterable`, finite array, or `Stream<T>`; for `future<T>` a `Promise<T>` or
`Future<T>`. A `Future<T>` handle is lowerable once its host end has
materialized; a still-deferred handle is refused loudly (a Promise has no such
window). The runtime facade owns pumping and closes activity retention on
end/drop. Cross-store reuse is refused.

**An import whose result is `future<T>` returns the future source.** A thenable
returned by the host (`Promise<T>` or `Future<T>`) IS the future: the import
completes immediately and the future settles on the producer's schedule. It is
not adopted as the call's completion — the `wasi:sockets@0.3`
`send: func(data: stream<u8>) -> future<result<_,
error-code>>` shape settles
only after post-return guest writes, so adoption would livelock. A rejected
source promise is a producer failure (site-named, on the consuming call), never
a guest-visible err; fallible payloads ride inside the future. Executable spec:
examples/guests/future-import, runtime/tests/embedder/future_result_test.ts.

**Streams of resources** (`stream<own<R>>`, the `listen` shape): a producer
yields class instances; each element lowers by the normal `own` transfer.
Obligations:

- **Untaken elements are destroyed.** Failed chunk conversion releases its
  converted prefix; short writes, cancellation, and peer faults release the
  undelivered tail. Cleanup attempts every element and preserves an existing
  operation error; a standalone cleanup error is reported. This applies to pumps
  and explicit writers for top-level `own` elements. Composite stream elements
  containing nested owns are not covered by this cleanup policy.
- **Producers are cancellable**: when the stream dies while the producer is
  parked with no write in flight, the pump cancels it — a `ReadableStream` via
  `reader.cancel()`, an (async-)iterable via its optional `cancel(): void` (then
  drains the pending pull so a straggler reaches the un-taken path). A source
  with no hook stays parked until its next element.
- World-level host resources register under the resource's camelCase name; their
  mangled leaves dispatch on that class. Executable spec:
  examples/guests/resource-stream,
  runtime/tests/embedder/resource_stream_test.ts.

**Owned future payloads** (`future<own<R>>`) follow the same delivery rule: the
producer pump releases a successfully lowered value if the reader drops or the
write ends without consuming it. Once consumed, ownership belongs to the
receiver; a later pump failure must not dispose it again. Cleanup preserves an
existing producer/write error and reports a standalone disposal failure. This
rule covers top-level `own` payloads, not owns nested in composite values.

**Stream and future values survive round trips.** Lifting an end the host
already handled — a host-created stream passed back, or a guest stream on its
second hop — is idempotent, yielding a handle over the same end. Hence:
host→guest→host pass-through works with the guest never reading (payload moves
host↔host without touching guest memory); a readable end hops any number of
times (each lower transfers it); host↔host rendezvous is legal for every element
type; a `createStream()` writer keeps feeding the same stream across hops.

**Deadlock-verdict suppression tracks host retention** (#162). While the host
retains a way to act (a retained end, a parked host operation, an unfinished
pump), a stalled guest is the embedder-may-act hang, never a deadlock trap.
Lowering a lifted handle back (the `identity` round trip) ends retention and
verdicts go live; a re-lift restores suppression; every drop path releases it.
`read` through a handle — or awaiting a `Future` — already passed to a guest
rejects `TypeError` naming the transfer. `StreamWriter` is unaffected (it
addresses the host-retained writable end). Returning a _different_ stream while
keeping the original is genuine retention.

**u8 chunks are `Uint8Array` both ways**: a `Uint8Array` passed to
`write`/`writeAll` is already-lowered bytes, passed by reference (borrowed until
the promise settles) and copied once at the rendezvous; reads hand back that
copy. One copy host↔host, one per direction with a guest peer.

**Foreign-copy handles are refused, loudly.** A handle minted by another runtime
copy is recognized by brand at lowering and raises a named cross-copy error
listing both URLs — never pumped as a generic producer. Remediation is by value:
`.readable()`, `Promise.resolve(f)`. Error-contexts are exempt: message-valued,
a branded foreign one lowers by minting a fresh local context.

**Component faults are loud.** When the peer instance traps, its ends retire: a
parked host `read`/`write`/`writeAll`/await, and every later operation, rejects
`PeerTrappedError` (`cause` chains to the trap; `progress` on writes). A fault
is never a clean end-of-stream or bare `DroppedError`; an operation that
completed before the trap keeps its result. A trapping host import drops
abandoned top-level stream/future arguments; this cleanup does not traverse
compound arguments. Their peers can then settle rather than waiting on abandoned
arguments. Work still waiting on a live host producer remains pending until it
acts.

**One in-flight operation per end, per direction**: a second parked `write`,
`read`, or future operation throws `TypeError` synchronously (the host spelling
of the `CopyEnd` busy trap). Reading while a write is parked on the same stream
is legal.

**Dropping an unwritten future is abandonment, not DROPPED** (#90).
`Future.drop()` on a lowered, never-written future never throws and is
idempotent; the guest's readable end observes a **trap at its rendezvous** ("the
host dropped the writable end without writing a value") — the host-side spelling
of the guest's own drop-before-write trap — never a DROPPED event or a hang. An
unlowered future just releases state. Producer rejections keep the loud
site-named fault path.

**`cancelRead` is indistinguishable from end-of-stream** (#97): it settles the
in-flight `read` with an empty chunk, presented as clean EOS by `readable()` and
the iterator. The canceller is the observer, so no signal is warranted.

### Direct-access byte edges

For `stream<u8>` only (#128; wasmtime `DirectSource`/`DirectDestination`
shaped), both host ends gain a form whose last hop _is_ the canonical ABI copy,
so external buffer movers pay no second copy.

- `writeDirect(produce)` / `readDirect(consume)` (also on the low-level
  `HostWritableEnd`/`HostReadableEnd`) park a **direct session**. At each
  rendezvous with a peer operation of nonzero capacity, the callback runs
  exactly once, synchronously, inside the rendezvous. `remaining()` is the
  reader's unfilled landing zone (`produce`) or the writer's unread bytes
  (`consume`); with a guest peer it aliases guest linear memory, so the
  embedder's `set()`/`subarray` copy is the ABI copy. `"more"` keeps the session
  parked; `"done"` ends it, resolving with the total byte count.
- **Scope is the validity window.** The object dies when the callback returns
  (later calls throw `TypeError`). Views are re-derived per `remaining()` call
  (`memory.grow` never yields a stale view). Inside the callback, running guest
  code or operating this stream is forbidden; direct forms participate in the
  one-in-flight rule.
- **Marks acknowledge on clean return only.** `markWritten`/`markRead`
  accumulate per invocation (over-marking throws). Returning with ≥ 1 marked
  completes the peer's copy with that count. `"done"` with zero marked is
  _retraction_: the session ends with its running total, the peer stays parked,
  no event is delivered (the speculative-park pattern). `"more"` with zero
  marked rejects `TypeError`. A throwing callback rejects the session and
  discards its marks. In every outcome the peer's operation survives and the
  stream stays alive; a zero-progress COMPLETED copy is never emitted (a guest
  may read it as EOS).
- **Zero-length-read readiness**: a parked session is the readiness claim — a
  zero-length probe completes immediately without invoking the callback;
  retraction corrects a speculative claim.
- **Host↔host**: a direct session against a peer _chunk_ end costs one copy
  (`produce` fills a fresh scratch that becomes the chunk; `consume` gets a
  scoped view of the offered chunk). Two direct sessions cannot rendezvous
  (neither owns memory): the arriving side throws `TypeError`.
- **Inherited rules**: peer trap rejects `PeerTrappedError` with the byte count;
  reader/writer drop resolves with the total (a resolution the producer's
  `"done"` did not cause is the peer-gone signal); `cancelWrite`/`cancelRead`
  retract; the post-transfer refusal applies; a parked session is retention.
  `writeDirect` on an unbound `createStream()` writer parks until the element
  type binds, then requires u8; `readDirect` on a non-u8 stream throws.
- **Deliberately absent**: an ownership-transfer chunk variant (`write`'s
  borrowed-until-settled already meets the one-copy floor), a `list<u8>` intake
  form, and any conduit/credit/realm machinery (polyengine provides the byte
  edge, not the mover). SAB-backed `Uint8Array`s are legal on the embedder's
  side of every copy. The `HostBuffer` length bound (#97) applies to the
  buffered path only.

## Module wiring and instantiation

One nested record keyed by verbatim interface id:

```ts
const instance = await instantiate(artifacts, {
  "wasi:clocks/monotonic-clock@0.3.0": {
    now,
    getResolution,
    waitFor,
    waitUntil,
  },
  "polymorph:websocket/connections@0.1.0": { Websocket }, // resource class
  // world-level bare imports at the top level, camelCase
});
```

- Bindgen emits the world's `Imports` and `Exports` types and a typed
  `instantiate` wrapper that **verifies the world digest** (contracts/digest.md)
  before instantiating: it resolves artifacts (translating if given the
  untranslated form; translation never runs guest code), compares against the
  embedded `WORLD_DIGEST`, and throws a named mismatch error carrying the
  divergence. The untyped runtime `instantiate` does not check an expected world
  digest; it still validates the plan, component hash, and required imports.
  `verify(plan)` and `WORLD_DIGEST` stay exported; `bind()` is an explicitly
  unchecked cast.
- **Untranslated artifacts**: `instantiate({ componentBytes, translator })`
  where `translator` is the shim wasm bytes or a shared `Translator` (prefer
  sharing: the wasm compile is the cost). `requiredImports` still takes a plan.
- **Build-time translation**: the translation envelope (single-file JSON from
  `Translator.translateRaw` / tools/translate, plan + FACT adapters) is the
  deploy artifact — `component.wasm` + envelope + runtime, no translator.
  `artifactsFromEnvelope(envelopeJson, componentBytes)` reconstitutes
  `ComponentArtifacts`; the envelope's component sha-256 is verified at
  instantiation. Fetch-agnostic.
- **Per-interface module authoring** is a helper over the same record: a
  module's named export, camelCase of the interface short-name, provides that
  interface. `"ns:pkg/*@0.2": mod` wildcards expand over interface _names_ at
  one version or track key.
- `requiredImports(artifacts)` enumerates the component's linkable import leaves
  with kinds and types.

## Module identity and @polyengine/protocol

Multiple runtime copies can coexist in a module graph. Cross-copy recognition
uses protocol brands rather than `instanceof`; stateful handles still belong to
the runtime copy that created them.

**The protocol package.** `@polyengine/protocol` is dependency-free and carries
the contract's vocabulary: brand symbols, the error classes
(`ComponentException`, `Trap`, `DroppedError`, `PeerTrappedError`,
`InvalidHandleError`, `StreamProducerError`), the import marks and their
predicates, the recognition predicates, the handle interfaces, realm crossing,
the copy registry, and `PROTOCOL_GENERATION`. Host modules import it at most;
with hand-rolled brands even that is optional. Copies of it are harmless:
identity rests on registry symbols only.

**Brands** are `Symbol.for` registry symbols, so N copies agree without sharing
modules. Keys are generation-suffixed; bumping a generation is a breaking
vocabulary change (a semver major in effect).

| brand key                         | carried by                                                                    | marks                                       |
| --------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| `polyengine.componentException/1` | `ComponentException.prototype`                                                | err-result values                           |
| `polyengine.trap/1`               | `Trap.prototype`                                                              | component-fatal errors                      |
| `polyengine.dropped/1`            | `DroppedError.prototype`                                                      | dropped-future rejections                   |
| `polyengine.peerTrapped/1`        | `PeerTrappedError.prototype`                                                  | peer-fault rejections                       |
| `polyengine.invalidHandle/1`      | `InvalidHandleError.prototype`                                                | handle misuse                               |
| `polyengine.streamProducer/1`     | `StreamProducerError.prototype`                                               | producer-side failures                      |
| `polyengine.suspending/1`         | marked function / class prototype                                             | suspendable sync imports                    |
| `polyengine.deferCancel/1`        | marked function                                                               | cancel-discard exempt imports               |
| `polyengine.abortable/1`          | marked function                                                               | imports receiving an `AbortSignal`          |
| `polyengine.syncCallable/1`       | lifted exports and guest-resource members (runtime-defined; application-tier) | sync-callable exports                       |
| `polyengine.stream/1`             | `Stream.prototype`                                                            | stream handles                              |
| `polyengine.streamWriter/1`       | `StreamWriter.prototype`                                                      | writer handles                              |
| `polyengine.future/1`             | `Future.prototype`                                                            | future handles                              |
| `polyengine.errorContext/1`       | `ErrorContext.prototype`                                                      | error-contexts (message-valued at lowering) |
| `polyengine.resourceState/1`      | guest-resource wrappers (internal state key)                                  | resource wrappers                           |
| `polyengine.pollable/1`           | `Pollable.prototype` (wasi package)                                           | pollables                                   |
| `polyengine.wasiExit/1`           | `ExitError.prototype` (wasi package)                                          | wasi exit unwinds                           |
| `polyengine.runtimeCopies/1`      | `globalThis`                                                                  | the copy registry                           |

Keys are the class name minus `Error`, camelCased, or the concept (`wasiExit` is
prefixed because bare `exit` is too generic). The digest's `cewd` constant is
hashed wire content, frozen independently.

**Brands are contract markers, not a security boundary.** An Error with
`[Symbol.for("polyengine.componentException/1")]: true` and a `payload` IS a
ComponentException to every copy; a function with the suspending brand IS
marked. The classes are conveniences.

**Stateless vs stateful.** For error classes and marks, brand agreement is the
whole story: a copy-B `ComponentException` is honored at a copy-A boundary.
Stateful values (handles, resource wrappers) live in the copy that minted them,
so the brand converts "misclassified" into "recognized-but-foreign": a named
error listing both copies' URLs (the cross-store assert family distinguishes
cross-copy from cross-store). Error-contexts sit between: any branded carrier of
a string `message` lowers by minting a fresh local context.

**The copy registry.** Each embedder module instance appends
`{ url, runtimeVersion, protocolGeneration }` to
`globalThis[Symbol.for("polyengine.runtimeCopies/1")]` on evaluation. Copies are
diagnosed, never refused (isolated bundles exchanging no values are legal):
cross-copy errors name both URLs, and the unbranded-throw trap appends a copy
census when more than one copy is registered. Resolution discipline stays
necessary for cost (N compiles, N payloads): host-module packages carry no
`@polyengine/*` import-map entries (docs/consumers.md).

**Identity is realm-local** (#129). Two realms (window and worker, two workers)
are two runtimes by construction — placement, not a defect. `Symbol.for` does
not span agents, and structured clone strips prototypes and refuses functions
and symbol keys, so a handle, wrapper, branded error, or marked function
crossing `postMessage` arrives as an inert object recognized by nothing. The
next section defines the sanctioned representations. The runtime, translator,
and embedder paths carry no main-thread-only dependencies; the conformance realm
rows (Deno worker, browser dedicated/shared worker, OPFS worker) gate this in
CI, and where a platform API differs by realm the runtime uses the intersection.

## Realm boundaries and structured-clone-safe forms

Proxies carrying embedder-typed values over `postMessage` need a defined form,
or every author invents a subtly wrong one. `@polyengine/protocol` exports:

```ts
function toCloneable(v: unknown, opts?: {
  /** Called for realm-local leaves instead of throwing; the substitute is
   *  walked in turn. Returning `undefined` (or the leaf) falls back to the refusal. */
  replace?: (leaf: object, path: string) => unknown;
}): unknown;
function fromCloneable(data: unknown): unknown;
```

`toCloneable` returns plain data safe for `structuredClone`/`postMessage` (no
transfer list; hence also `BroadcastChannel`, IndexedDB — a property of plain
data, not a compatibility promise). `fromCloneable` rehydrates every envelope
into a value **branded by the local copy** — a new local value, never "the same"
one. No RPC, no proxying, no cross-realm identity.

**Round-trip law** (tested per taxonomy member):
`fromCloneable(structuredClone(toCloneable(v)))` is indistinguishable from `v`
under every matcher this contract offers — predicates, `payload`/`kind`/`value`,
`message`, `cause` chains, `progress`. Cause chains are walked to full depth
through branded and unbranded links (a `PeerTrappedError.cause` is an unbranded
poisoning record whose `cause` is the `Trap`, which must still satisfy
`isTrap`). `stack` is carried verbatim.

**The envelope**: a plain object whose tag property `"polyengine.cloneable/1"`
holds the brand key string. No WIT-mapped value collides (WIT identifiers
contain neither `.` nor `/`; `map` is a list), and an input already carrying the
tag is refused, so no escaping is needed. Detection is by brand, so hand-rolled
branded values encode identically.

| tag value                         | encodes                        | fields besides the tag                                     |
| --------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| `polyengine.componentException/1` | `ComponentException`           | `message`, `stack?`, `cause?` (walked), `payload` (walked) |
| `polyengine.trap/1`               | `Trap`                         | `message`, `stack?`, `cause?` (walked)                     |
| `polyengine.dropped/1`            | `DroppedError`                 | `message`, `stack?`, `cause?` (walked)                     |
| `polyengine.invalidHandle/1`      | `InvalidHandleError`           | `message`, `stack?`, `cause?` (walked)                     |
| `polyengine.peerTrapped/1`        | `PeerTrappedError`             | `message`, `stack?`, `progress?`, `cause` (walked)         |
| `polyengine.streamProducer/1`     | `StreamProducerError`          | `message`, `stack?`, `cause` (walked)                      |
| `polyengine.errorContext/1`       | error-context (its message)    | `message`                                                  |
| `polyengine.wasiExit/1`           | the wasi package's `ExitError` | `message`, `stack?`, `ok`, `code?`                         |
| `error`                           | an unbranded `Error`           | `name`, `message`, `stack?`, `cause?` (walked)             |

`fromCloneable` rehydrates the six error tags as protocol class instances;
`error` as a plain `Error` with `name` restored; `wasiExit` as a hand-rolled
branded `Error` with `ok`/`code` (protocol does not import wasi); `errorContext`
as a branded `{ message }`, which lowering accepts. An unknown tag throws
`TypeError`: mixed engine versions are outside the matrix.

**Walk semantics** (`fromCloneable` mirrors):

- Pass through: primitives, `null`, `undefined`; `ArrayBuffer`, typed arrays,
  `DataView` by reference.
- Walk into fresh containers: arrays; plain objects (`Object.prototype` or
  `null`), own enumerable string keys.
- Encode branded values per the table and unbranded `Error`s as `error`;
  encodable brands take precedence over the realm-local pill.
- Refuse with `InvalidHandleError`: realm-local leaves — `isRealmLocal`, the
  `STREAM`/`FUTURE`/`POLLABLE` brands, resource wrappers — unless `replace`
  substitutes. **Proxy the interface, not the handle.**
- Refuse with `TypeError`: functions, symbols, cycles, other prototypes.
  `Map`/`Set`/`Date`/`RegExp` cannot occur in WIT data and pass through unwalked
  (a hidden handle still trips its pill at clone time).
- Every refusal names the path to the leaf (`payload.attempts[2].handle`).

Aliasing is not preserved; cycles are refused. **Version-internal, not a wire
format**: both realms run the same engine version (docs/consumers.md); the
envelope may change in any release.

**The realm-local pill.** Every `Stream`, `StreamWriter`, `Future`,
`ErrorContext`, guest-resource wrapper, and wasi `Pollable` carries an own,
enumerable, string-keyed property `"polyengine.realmLocal/1"` whose value is the
named function `polyengineRealmLocalValue`. Structured serialization visits
exactly such properties and refuses functions, so a raw `postMessage` of such a
value — even buried in a record — throws `DataCloneError` in the **sender**. (It
must be a string key and own; the brand mechanism cannot serve.)
`JSON.stringify` and spread are unaffected. Vocabulary: `REALM_LOCAL`,
`defineRealmLocal(target)`, `isRealmLocal(v)`.

**Errors cannot be pilled**: the serializer's `[[ErrorData]]` branch keeps
`name`/`message`/`stack` only, so a raw-cloned branded error husks silently.
`toCloneable` fills that gap; the pill covers the stateful handles; together
they partition the vocabulary.

**Error-context is message-valued** (definitions.py): lowering accepts any
branded carrier of a string `message` — `fromCloneable` output or a hand-rolled
`{ [Symbol.for("polyengine.errorContext/1")]: true, message }` — minting a fresh
local context. A branded error-context without a string `message` keeps the
cross-copy refusal.

## The host-ABI surface and its version

A host module consumes protocol vocabulary only. Naming
`jsr:@polyengine/runtime` would let every lockstep engine release (plan format,
translator) invalidate its range, so the surfaces split:

**Protocol carries the whole host-boundary vocabulary**: brands, error classes,
marks, predicates, and the handle interfaces of
[Streams and futures](#streams-and-futures) as structural TypeScript
(`Stream<T>`, `StreamWriter<T>`, `Future<T>`, `ErrorContext`, `Chunk<T>`,
`DirectSource`, `DirectDestination`, `StreamSource<T>`, `FutureSource<T>`) with
brand predicates. The runtime's classes declare `implements` against them
(`just test-runtime`).

**The runtime's exported surface is application-only.**
`@polyengine/runtime/embedder` exports `instantiate`/ `instantiateEmbedder`,
artifact resolution, `requiredImports`, the import resolver and version
canonicalization, `NameCollisionError`, the value-bridge/casing utilities,
`sync()`, and `createStream<T>()`. It exports no error classes, predicates,
brands, marks, realm crossing, copy registry, or concrete handle classes. Host
modules produce streams and futures as natural JS producers; one wanting
writer-driven push (`writeDirect`) or a synchronous guest callback
(`sync(exports.f)`) is handed it by the application, keeping placement with the
deployer.

**Host modules MUST NOT import `@polyengine/runtime`**; a one-line no-specifier
check gates it. The wasi package is protocol-only (`isStream`, not
`instanceof Stream`).

**The conventions suite is the executable definition of the host ABI.**
`runtime/tests/conventions/` exercises this contract against a probe host module
written as consumers write theirs (protocol imports only) and commits normalized
transcripts under `runtime/tests/conventions/golden/`.

- Modifying or deleting a golden asserts a host-ABI behavior change and requires
  `breaking/protocol` (with its protocol minor bump) in the same PR; the
  reviewed behavior-neutral escape is the `conventions-fix` label.
- Adding goldens is free.
- version-guard enforces this at PR time (labels, advisory) and authoritatively
  at cut time (any M/D under the goldens dir in the release window requires
  protocol past the last cut).

**Consequence: protocol's version is the host-ABI version.** A host module pins
`jsr:@polyengine/protocol@^0.x`. Golden changes are a mechanical versioning
signal, not exhaustive coverage: review behavior changes against this contract
even when existing transcripts are unchanged.

## Implementation strategy

Bindgen emits world `Imports`/`Exports`, value and resource types, and a typed
instantiation wrapper with the digest handshake. The runtime facade builds
resource classes, assembles mangled names, adapts values and errors, and pumps
streams/futures from plan descriptors. These behaviors do not depend on
generated JS adapters.

Raw and facade values can share property names while having different
representations. Every adapting site preserves these distinctions:

|                     | internal                                 | this layer                                                   |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `result` error case | `"error"` (definitions.py)               | `"err"`                                                      |
| `enum`              | a variant value                          | bare kebab-case string                                       |
| `option`            | always `{kind: "none" \| "some", value}` | outermost `T \| undefined`; only directly-nested options box |
| payloadless case    | `value: null`                            | property omitted                                             |
| tuple               | record with numeric keys                 | array                                                        |

The raw executor's exports remain internal-shaped; the public facade applies
these conversions.

## The WASI parking kernel

WASI stays out of the runtime core (docs/architecture.md §2); the `wasi/`
package is the executable check that the conventions fit. Most of it maps
directly (p3 clocks over `setTimeout` with no JSPI; p3 sockets and http as
resource classes with async methods and stream I/O). The idiom that fights a JS
host is p2's sync-blocking surface — `pollable.block()`, `poll()`,
`blocking-read`/`blocking-write-and-flush` are **sync** WIT functions that must
park. The wasi package ships the parking kernel, always on:

- `block`/`poll` are `suspending()`-marked with sync fast paths: a ready
  pollable costs one engine hop; only a genuine wait parks. Timer pollables are
  real (monotonic-clock `subscribe-*`).
- Without JSPI, `chooseMode` degrades to plain and a genuine park raises
  `NeedsJspi` at the park site; `jspi: false` is the per-instantiation opt-out.
- Stream `read`/`check-write` are plain. The p2 `blocking-*` declarations are
  marked park-capable: buffer-backed default streams take the sync fast path;
  genuinely async impls (host stdin behind `blocking-read`) return Promises and
  park. The prototype-declares/instances-behave mark relay lets duck-typed impls
  park through the registered types.
- `Pollable` is publicly constructible (`new Pollable(ready, wait)`) as the seam
  for external providers; `wait()` follows the promise-swap shape (settle and
  re-arm per event; spurious wakes are fine).

A component importing marked providers selects JSPI on capable engines even if a
particular call never waits. The plain fast path requires a sync-only plan and
no marked imports; see [intrinsics.md](intrinsics.md).
